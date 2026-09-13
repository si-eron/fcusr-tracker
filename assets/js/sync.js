/* Syncing — making one council's work the same on every phone.

   The app stays local-first. Every screen reads and writes localStorage and
   never waits for a network, because a council works in corridors and jeepneys
   and the moment a button needs a signal is the moment people stop using it.
   Syncing is reconciliation that happens afterwards, in the background, and
   failing to sync is never allowed to fail a save.

   The rule is last-write-wins per record, on updatedAt. Two officers almost
   never hold the same task in the same minute, and when they do, the later edit
   was made knowing more. The cost is real and worth saying plainly: simultaneous
   edits to one record do not merge — the later one replaces the earlier.

   Order matters. Pull before push, so a record edited on both sides is compared
   before it is sent; and units and offices first, because everything else names
   them and a task whose event points at a unit this device has never heard of
   cannot be filed anywhere sensible. */
(function (global) {
  'use strict';

  // Local list ↔ server table. Reference data first, then what depends on it.
  var TABLES = [
    // Units first: everything else names one, and a unit this device has never
    // heard of leaves an activity with nowhere to be filed.
    { kind: 'unit',   table: 'units' },
    { kind: 'person', table: 'people' },
    { kind: 'event',  table: 'events' },
    { kind: 'task',   table: 'tasks' },
    { kind: 'report', table: 'reports' },
    { kind: 'letter', table: 'letters' },
    { kind: 'office', table: 'offices' }
  ];

  var state = { running: false, at: '', error: '', last: null };
  var listeners = [];
  var timer = null;
  var pendingPush = null;

  function notify() { listeners.forEach(function (fn) { try { fn(status()); } catch (e) { /* a watcher must not break a sync */ } }); }
  function subscribe(fn) { listeners.push(fn); }

  function status() {
    return {
      running: state.running,
      at: state.at || Store.syncState().at,
      error: state.error,
      last: state.last,
      able: able()
    };
  }

  /* Syncing needs somewhere to sync to and somebody to be. Offline the whole
     thing is a no-op rather than an error: that is the normal state of a council
     that has not connected Supabase, not a fault to report. */
  function able() {
    return !!(global.Backend && global.Auth && !Auth.isOffline() && Auth.signedIn());
  }

  /* ---------- shapes ----------
     The server keeps what it must reason about — who owns this, when it changed
     — and carries the app's own record in `body`. That way a field added to a
     report next term is not a migration somebody has to remember to run before
     the phones stop agreeing. */

  function unitOf(kind, rec) {
    if (kind === 'event' || kind === 'letter' || kind === 'person') return rec.unitId || null;
    return null;
  }

  /* No `updated_at` here on purpose. The server stamps it with its own clock
     and a trigger overrides anything sent, because that column is what a pull
     filters on and a filter is meaningless across two phones' watches. When the
     edit was made travels inside `body`, which is a different question answered
     by a different clock. */
  function toRow(kind, rec) {
    var row = { id: rec.id, body: rec };
    var u = unitOf(kind, rec);

    if (kind === 'unit')   { row.name = rec.name || ''; row.code = rec.code || null; row.kind = rec.kind || 'province'; row.tracker_name = rec.trackerName || ''; row.active = rec.active !== false; }
    if (kind === 'person') { row.unit_id = u; row.name = rec.name || ''; row.active = rec.active !== false; }
    if (kind === 'event')  { row.unit_id = u; row.title = rec.title || ''; row.status = rec.status || 'Upcoming'; }
    /* A directive has no activity, so it carries its own unit — otherwise the
       server has nothing to decide who may read it by, and until event_id was
       allowed to be empty it could not be stored at all. A task inside an
       activity sends no unit and is scoped through the activity, as ever. */
    if (kind === 'task')   {
      row.event_id = rec.eventId || null;
      row.unit_id = rec.eventId ? null
        : (rec.unitId || (global.Auth && Auth.myUnitId && Auth.myUnitId()) || null);
      row.title = rec.title || '';
      row.status = rec.status || 'Not Started';
    }
    if (kind === 'report') { row.event_id = rec.eventId || null; row.drive_link = rec.driveLink || ''; row.drive_owned = !!rec.driveOwned; row.status = rec.status || 'draft'; }
    if (kind === 'letter') { row.unit_id = u; row.subject = rec.subject || ''; row.status = rec.status || 'Routing'; row.stops = rec.stops || []; row.internal = !!rec.internal; }
    if (kind === 'office') { row.name = rec.name || ''; row.code = rec.code || null; row.active = rec.active !== false; }
    return row;
  }

  /* Coming the other way, `body` is the record — the columns beside it are the
     server's copy, kept for its own policies and for anyone reading the table.
     A row written by something other than this app still yields a usable record
     rather than nothing.

     The record keeps the timestamp of the edit that made it, NOT the server's.
     Two clocks are in play and they answer different questions: `updated_at` is
     when the row reached the server, which is how a pull knows what is new;
     `body.updatedAt` is when a person changed it, which is the only fair basis
     for deciding whose edit stands. Using arrival time would mean the last phone
     to find a signal wins, and the officer who edited first but syncs from a
     building with thicker walls would silently overwrite everyone. */
  function fromRow(kind, row) {
    var rec = (row.body && typeof row.body === 'object' && row.body.id) ? row.body : {};
    rec.id = row.id;
    if (!rec.updatedAt) rec.updatedAt = row.updated_at || '';
    if (!rec.createdAt) rec.createdAt = row.created_at || row.updated_at || '';

    if (kind === 'unit' && !rec.name) {
      rec.name = row.name || ''; rec.code = row.code || '';
      rec.kind = row.kind || 'province'; rec.trackerName = row.tracker_name || '';
    }
    if (kind === 'person' && !rec.name) { rec.name = row.name || ''; rec.unitId = row.unit_id || ''; }
    if (kind === 'event' && !rec.title) { rec.title = row.title || ''; rec.unitId = row.unit_id || ''; }
    if (kind === 'task' && !rec.title) { rec.title = row.title || ''; rec.eventId = row.event_id || ''; }
    if (kind === 'report' && !rec.eventId) rec.eventId = row.event_id || '';
    if (kind === 'letter' && !rec.subject) { rec.subject = row.subject || ''; rec.unitId = row.unit_id || ''; }
    if (kind === 'office' && !rec.name) rec.name = row.name || '';
    return rec;
  }

  /* ---------- reference data ----------
     Units and offices are seeded on both sides from the same fixed code list, so
     the two sides hold the same desks under different ids. They are matched by
     code once, and every local id rewritten to the server's, after which a unit
     is one thing everywhere. */
  function reconcileUnits() {
    return Backend.units().then(function (rows) {
      var map = {};
      (rows || []).forEach(function (r) {
        if (!r.code) return;
        Store.units().forEach(function (u) {
          if (u.code === r.code && u.id !== r.id) map[u.id] = r.id;
        });
      });
      if (Object.keys(map).length) Store.remapIds(map);
      return map;
    });
  }

  function reconcileOffices() {
    return Backend.changed('offices', null, 500).then(function (rows) {
      var map = {};
      (rows || []).forEach(function (r) {
        if (!r.code) return;
        Store.offices().forEach(function (o) {
          if (o.code === r.code && o.id !== r.id) map[o.id] = r.id;
        });
      });
      if (Object.keys(map).length) Store.remapIds(map);
      return map;
    });
  }

  /* ---------- the pull ---------- */

  function pull(since) {
    var counts = { added: 0, updated: 0, removed: 0 };
    var high = since || '';

    var PAGE = 500;

    /* One table, however many pages it takes.

       A single page per round looked fine because the mark advances and the
       next round picks up the rest — but a council coming back after a term,
       or a device restored from a backup, would take a dozen rounds to catch
       up while showing "Synced" throughout. And a page that ends exactly on a
       shared timestamp would leave the rows sharing it behind for good, because
       the next ask is strictly newer than the last one seen.

       Bounded, because a loop that trusts a server to stop is not a loop. */
    function page(t, from, guard) {
      return Backend.changed(t.table, from, PAGE).then(function (rows) {
        rows = rows || [];
        var last = from;
        rows.forEach(function (row) {
          var what = Store.applyRemote(t.kind, fromRow(t.kind, row));
          if (what === 'added') counts.added++;
          else if (what === 'updated') counts.updated++;
          if (row.updated_at && row.updated_at > high) high = row.updated_at;
          if (row.updated_at) last = row.updated_at;
        });
        // A short page is the end of the table; an unmoved mark means the rest
        // share one timestamp and asking again would fetch the same rows for ever.
        if (rows.length < PAGE || last === from || guard <= 0) return null;
        return page(t, last, guard - 1);
      });
    }

    var chain = Promise.resolve();
    TABLES.forEach(function (t) {
      chain = chain.then(function () { return page(t, since, 40); });
    });

    // Deletions last: applying them after the records means a row deleted and
    // re-created within one window ends up in the state it was left in.
    /* Paged, exactly like the records above, and for a reason that took a
       thousand tombstones to show.

       This used to be one ask with a cap and no second one. On its own that
       would only have been slow — the mark would stop at the last tombstone
       seen and the rest would come next round. But records and deletions share
       ONE mark and the records run first, so anything edited after the last
       tombstone that fitted in the page carried the mark past the ones that did
       not, and they were never asked for again. A full reconcile did not save
       it either: it starts from the beginning and truncates in the same place.

       What a council saw was deleted work quietly back on one person's phone,
       for good, and nowhere else. */
    function deletionPage(from, guard) {
      // `deleted_at`, not `updated_at`: a tombstone has no other clock, and
      // asking for a column a table does not have is a refusal, not an empty list.
      return Backend.changed('deletions', from, PAGE, 'deleted_at').then(function (rows) {
        rows = rows || [];
        var last = from;
        rows.forEach(function (row) {
          if (Store.applyRemoteDeletion(row.entity, row.entity_id, row.deleted_at)) counts.removed++;
          if (row.deleted_at && row.deleted_at > high) high = row.deleted_at;
          if (row.deleted_at) last = row.deleted_at;
        });
        if (rows.length < PAGE || last === from || guard <= 0) return null;
        return deletionPage(last, guard - 1);
      });
    }

    chain = chain.then(function () {
      return deletionPage(since, 40).catch(function (err) {
        /* Only a server that has never had the table gets a free pass — a
           council that has not run the sync migration yet. Anything else is a
           real fault, and swallowing it is how a deletion that never propagates
           looks exactly like one that did. */
        if (err && err.status === 404) return;
        throw err;
      });
    });

    return chain.then(function () { return { counts: counts, high: high }; });
  }

  /* ---------- the push ---------- */

  /* Records this device holds and the server will not take from it.

     An officer of a college is attached to a National activity so that it shows
     on their dashboard: they may read it, and they may not write it. Their phone
     holds it all the same, and a full round offers back everything the phone
     holds — so the server refuses, and row-level security refuses the REQUEST,
     not the row. One record they were deliberately given therefore broke every
     sync they would ever run, and their own college's work never left the phone
     either.

     Remembered for the session so a settled device is not re-offering them one
     at a time every hour. Not written down anywhere: what a person may write can
     change the moment somebody enrols them differently, and a refusal recorded
     for ever would outlive the reason for it. */
  var unwritable = {};

  /* `keyOf` because not every table is keyed by `id`. Deletions are keyed by the
     pair (entity, entity_id) and have no id column at all, so sending one would
     be refused by the server for a completely different reason. */
  function offer(table, rows, keyOf) {
    var name = keyOf || function (r) { return table + ':' + r.id; };
    if (!rows.length) return Promise.resolve(0);
    return Backend.upsert(table, rows).then(function () { return rows.length; })
      .catch(function (err) {
        if (!err || (err.status !== 401 && err.status !== 403)) throw err;
        /* Something in here is not this device's to write, and the answer does
           not say which. Offer them singly to find out, take what is taken, and
           remember the rest so this only happens once. */
        var taken = 0;
        var c = Promise.resolve();
        rows.forEach(function (row) {
          c = c.then(function () {
            return Backend.upsert(table, [row]).then(function () { taken += 1; })
              .catch(function (e) {
                if (e && (e.status === 401 || e.status === 403)) {
                  unwritable[name(row)] = 1;
                  refused += 1;
                  return;
                }
                throw e;
              });
          });
        });
        return c.then(function () { return taken; });
      });
  }

  var refused = 0;

  function push(since) {
    var out = Store.outbound(since);
    var sent = 0;
    refused = 0;
    var chain = Promise.resolve();

    TABLES.forEach(function (t) {
      var rows = (out.records[t.kind] || [])
        .filter(function (r) { return !unwritable[t.table + ':' + r.id]; })
        .map(function (r) { return toRow(t.kind, r); });
      if (!rows.length) return;
      // In batches, because one letter with forty photos' worth of body is not
      // the same size as forty tasks, and a request that is too big fails whole.
      for (var i = 0; i < rows.length; i += 50) {
        (function (slice) {
          chain = chain.then(function () {
            return offer(t.table, slice).then(function (n) { sent += n; });
          });
        })(rows.slice(i, i + 50));
      }
    });

    /* Deletions go the same way, and this is where the red bar was coming from.

       The records above were taught to survive a refusal; this was not, so one
       tombstone the server would not take broke the whole round and every round
       after it — the pill red, nothing sent, and the reason a row working
       exactly as designed.

       Two ordinary ways to earn that refusal. A volunteer is not an officer, so
       deletions_write refuses every tombstone they hold. And an officer offering
       back a tombstone the National government wrote is refused on the UPDATE's
       USING clause, because the row already there belongs to another unit —
       which is what "(USING expression) for table deletions" means, and a full
       round offers everything the phone holds. */
    if (out.deletions.length) {
      chain = chain.then(function () {
        var rows = out.deletions
          .filter(function (d) { return !unwritable['deletions:' + d.kind + ':' + d.id]; })
          .map(function (d) {
            return {
              entity: d.kind, entity_id: d.id, deleted_at: d.at,
              deleted_by: (global.Auth && Auth.current() && Auth.current().name) || '',
              unit_id: (global.Auth && Auth.myUnitId()) || null
            };
          });
        if (!rows.length) return null;
        return offer('deletions', rows, function (r) {
          return 'deletions:' + r.entity + ':' + r.entity_id;
        });
      }).then(function () {
        var byTable = {};
        out.deletions.forEach(function (d) {
          if (unwritable['deletions:' + d.kind + ':' + d.id]) return;
          var t = TABLES.filter(function (x) { return x.kind === d.kind; })[0];
          if (!t) return;
          (byTable[t.table] = byTable[t.table] || []).push(d.id);
        });
        var c = Promise.resolve();
        Object.keys(byTable).forEach(function (table) {
          c = c.then(function () {
            /* Removing the row itself can be refused for the same reasons, and
               a deletion that cannot be carried out is not a reason to stop
               carrying out the others. */
            return Backend.remove(table, byTable[table]).catch(function (err) {
              if (err && (err.status === 401 || err.status === 403)) { refused += 1; return; }
              throw err;
            });
          });
        });
        return c;
      });
    }

    return chain.then(function () { return sent; });
  }

  /* ISO strings compare as text, which is the whole reason the app stamps them
     that way. The store has its own copy of this; the two must not disagree. */
  function newer(a, b) { return String(a || '') > String(b || ''); }

  /* ---------- the council's own details ----------
     What is printed at the top of every report, the Republic's letter template,
     and the lists a form offers. One row, like the term. */
  function pullCouncil() {
    return Backend.changed('council', null, 1).then(function (rows) {
      var row = (rows || [])[0];
      if (!row || !row.body) return false;
      return Store.applyRemoteCouncil(row.body);
    }).catch(function (err) {
      // A council that has not run the second migration yet.
      if (err && (err.status === 404 || err.status === 400)) return false;
      throw err;
    });
  }

  function pushCouncil(since) {
    var c = Store.council();
    if (!c.updatedAt) return Promise.resolve(0);
    if (since && !newer(c.updatedAt, since)) return Promise.resolve(0);
    return Backend.upsert('council', [{ id: 1, body: c }])
      .then(function () { return 1; })
      .catch(function (err) {
        if (err && (err.status === 404 || err.status === 400)) return 0;
        throw err;
      });
  }

  /* ---------- the closing date ----------
     One row, and the one thing that must read the same on every phone: a term
     that ends on the 6th here and nowhere else is worse than no term at all.
     It is not a collection, so it does not go through the record machinery —
     last write wins on its own stamp, like everything else. */
  function pullTerm() {
    return Backend.changed('term', null, 1).then(function (rows) {
      var row = (rows || [])[0];
      if (!row || !row.body || !row.body.declaredAt) return false;
      // Somebody's rehearsal, from a version that used to push it.
      if (row.body.declaredBy === 'Dry run') return false;
      var mine = Store.term();
      if (!newer(row.body.updatedAt || row.updated_at, mine.updatedAt || '')) return false;
      Store.applyRemoteTerm(row.body);
      return true;
    }).catch(function (err) {
      if (err && (err.status === 404 || err.status === 400)) return false;
      throw err;
    });
  }

  function pushTerm(since) {
    var t = Store.term();
    if (!t.declaredAt) return Promise.resolve(0);
    if (since && !newer(t.updatedAt || '', since)) return Promise.resolve(0);
    return Backend.upsert('term', [{ id: 1, body: t }]).then(function () { return 1; });
  }

  /* ---------- one round ---------- */

  function now(opts) {
    opts = opts || {};
    if (state.running) return Promise.resolve(status());
    if (!able()) return Promise.resolve(status());

    state.running = true;
    state.error = '';
    notify();

    var mark = Store.syncState();
    /* Two marks, because there are two clocks and they must never be compared.

       `pulled` is on the server's clock: the newest arrival this device has
       taken in. `pushed` is on this device's: the moment of the last successful
       send. Asking the server for "rows changed since <a phone's watch>" is how
       a device with a fast clock quietly stops receiving; filtering local edits
       by "newer than <a server stamp>" is how a device stops sending. Both were
       one field once, and both faults were in it. */
    var since = mark.pulled || '';
    var pushedSince = mark.pushed || '';

    /* Every so often, forget both marks and reconcile properly.

       A mark says "I have already dealt with everything up to here", and it can
       be true and useless at the same time: a round that failed halfway, a
       version with a bug in it, a device emptied or restored — any of them
       leave a device certain it has nothing to do while another phone is full
       of work nobody else can see. Both devices then report "Synced", both
       truthfully, and the council is still looking at two different trackers.

       So it does not only trust the marks. Once when the app opens, and once an
       hour after that, it asks for everything and offers everything. That is
       safe in either direction because the pull happens first: whatever comes
       back has already won or lost against what is here before anything is
       sent, so a full send can never put an old copy over a newer one.

       It costs a few hundred kilobytes for a council this size, which is the
       right price for never again needing somebody to find a button. */
    var full = opts.full || rounds === 0 || (rounds % FULL_EVERY) === 0;
    rounds++;

    if (full) { since = ''; pushedSince = ''; }
    var startedAt = '';
    var deviceStart = Store.now();

    return Backend.serverNow().then(function (t) {
      // Read before anything else: a row written while this sync runs must be
      // caught by the next one, not skipped because the mark was taken at the end.
      startedAt = t || Store.now();

      /* The server's time is read for the pull mark and for nothing else.

         Correcting this device's own clock by it was tried and taken out again.
         It sounded right — a phone two days fast writes stamps two days ahead —
         but the records it had already made stayed in its future, so they were
         "still to send" against every mark it wrote afterwards, and it pushed
         the same five rows every twenty seconds for ever.

         The skew is answered where it actually bites instead: an edit is always
         stamped later than the version it replaces, so a fast phone can be
         corrected by anybody and does not win by having the wrong clock. */
      /* Whenever anything is still on a local id, not only on the very first
         round. A device that synced under an older version never reconciled,
         and pushing `unit-nat` where a uuid belongs is refused by the server. */
      var needsCodes = Store.units().some(function (u) { return !U.isUuid(u.id); }) ||
        Store.offices().some(function (o) { return !U.isUuid(o.id); });
      return needsCodes ? reconcileUnits().then(reconcileOffices) : Promise.resolve({});
    }).then(function () {
      return pull(since);
    }).then(function (res) {
      return pullTerm().then(function (tookTerm) {
        if (tookTerm) res.counts.updated++;
        return pullCouncil();
      }).then(function (tookCouncil) {
        if (tookCouncil) res.counts.updated++;
        return res;
      });
    }).then(function (res) {
      return push(pushedSince).then(function (sent) {
        return pushTerm(pushedSince).then(function (n) {
          return pushCouncil(pushedSince).then(function (m) { return sent + n + m; });
        });
      }).then(function (sent) {
        /* deviceStart, not "now": anything edited while this round was in flight
           has a stamp after it and is caught by the next one. Marking the end
           would step over those edits and they would never be sent at all.

           And a millisecond before it, because a phone's clock has only that
           much resolution. Create a task and sync in the same millisecond — an
           ordinary thing, since a save triggers a sync — and its stamp equals
           the mark exactly; filtered with a strict "newer than", it would never
           be sent at all, and nobody would ever see an error. Stepping back one
           tick can only re-send a record that was already sent, which an upsert
           does not mind in the least. */
        Store.markSynced({
          pulled: res.high || startedAt,
          pushed: new Date(Date.parse(deviceStart) - 1).toISOString(),
          at: startedAt
        });
        /* A full round is also when to ask whether this person is still what
           they were. Somebody promoted from volunteer to officer kept the
           volunteer screens until they closed the tab, with nothing on screen
           to suggest they should. */
        if (full && global.Auth && Auth.refresh) {
          Auth.refresh().then(function (changed) {
            if (changed && global.App && App.render) App.render();
          });
        }

        state.last = {
          added: res.counts.added, updated: res.counts.updated,
          removed: res.counts.removed, sent: sent, at: startedAt, full: full,
          /* Records this phone holds that the server will not take from it.
             Not an error — it is usually correct, an officer holding sight of a
             National activity they may not edit — but it is not nothing either,
             and a number nobody can see is a number nobody can act on. */
          refused: refused
        };
        /* Something arrived, so whatever is on screen is out of date. This is
           the only place a sync is allowed to announce itself — and only when
           it actually brought something back, or it would wake the next sync
           and never stop. Not conditional on App existing: whether anything is
           listening is the listeners' business, not this layer's. */
        if (res.counts.added || res.counts.updated || res.counts.removed) Store.commit();
      });
    }).catch(function (err) {
      /* A sync that cannot run is not a fault the person needs to act on — they
         are on a jeepney, or the canteen wifi is a portal. It is remembered and
         shown quietly, and the next round tries again. */
      state.error = err && err.message ? err.message : 'Could not reach the server.';
      if (opts.loud && global.UI) UI.toast(state.error, 'error');
    }).then(function () {
      state.running = false;
      state.at = Store.syncState().at;
      notify();
      return status();
    });
  }

  /* ---------- when it happens ----------
     On sign-in, when a change is made, when the tab is looked at again, when the
     network comes back, and every few minutes regardless. The debounce is what
     stops a person typing a task title from sending nine versions of it. */

  /* Every twenty seconds while somebody is looking at it.

     A change already sends itself within a few seconds, so this is for the
     other direction: work somebody else did, appearing without anybody
     refreshing. Twenty seconds is short enough that two officers in the same
     meeting see the same screen.

     A round asks each table what has changed since a moment and usually gets
     an empty answer back, so the cost is small — but not nothing, so a tab
     nobody is looking at stops entirely and catches up the moment it is
     looked at again. That is most tabs, most of the time. */
  var EVERY = 20 * 1000;
  var AFTER_CHANGE = 4000;
  /* Rounds between full reconciliations. At twenty seconds this is about an
     hour, which is how often a device stops trusting its own bookkeeping and
     simply asks for everything. */
  var FULL_EVERY = 180;
  var rounds = 0;

  function schedule() {
    if (timer) clearInterval(timer);
    // Only while the tab is in front. A phone in a pocket is not waiting for
    // an answer, and polling it every twenty seconds costs battery and data
    // for nobody's benefit.
    if (global.document && document.hidden) return;
    timer = setInterval(function () { now(); }, EVERY);
  }

  function stopSchedule() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function onChange() {
    if (!able()) return;
    if (pendingPush) clearTimeout(pendingPush);
    pendingPush = setTimeout(function () { pendingPush = null; now(); }, AFTER_CHANGE);
  }

  function start() {
    if (!global.Store) return;
    Store.subscribe(onChange);
    schedule();

    if (global.document) {
      document.addEventListener('visibilitychange', function () {
        if (document.hidden) return stopSchedule();
        // Back in front: catch up at once, then resume the twenty seconds.
        schedule();
        now();
      });
    }
    global.addEventListener('online', function () { now(); });

    // Not on the first paint: the first screen should draw before the network
    // is asked for anything.
    setTimeout(function () { now(); }, 1200);
  }

  /* ---------- what is actually where ----------

     "The sync is broken" is not something anybody can act on, and neither is a
     green dot. This asks the server what it holds, counts what this device
     holds, and puts the two side by side — so the answer is "the server has
     nine activities and this phone has none" rather than a guess.

     Read-only: it applies nothing. Diagnosing a problem must not change the
     thing being diagnosed. */
  function diagnose() {
    if (!able()) {
      return Promise.resolve({ able: false, rows: [], error: 'Not signed in, or no server connected.' });
    }

    var local = {
      unit: Store.units().length,
      person: Store.people().length,
      event: Store.events().length,
      task: Store.tasks().length,
      report: Store.reports().length,
      letter: Store.letters().length,
      office: Store.offices().length
    };
    var rows = [];
    var chain = Promise.resolve();
    var trouble = '';

    TABLES.forEach(function (t) {
      chain = chain.then(function () {
        return Backend.changed(t.table, null, 1000).then(function (server) {
          rows.push({
            kind: t.kind,
            table: t.table,
            here: local[t.kind] || 0,
            there: (server || []).length
          });
        }).catch(function (err) {
          trouble = trouble || (t.table + ': ' + (err && err.message ? err.message : 'refused'));
          rows.push({ kind: t.kind, table: t.table, here: local[t.kind] || 0,
                      real: null, there: null });
        });
      });
    });

    return chain.then(function () {
      return {
        able: true,
        rows: rows,
        error: trouble || state.error,
        marks: Store.syncState(),
        last: state.last
      };
    });
  }

  global.Sync = {
    now: now, start: start, status: status, subscribe: subscribe, diagnose: diagnose,
    able: able, toRow: toRow, fromRow: fromRow
  };
})(window);
