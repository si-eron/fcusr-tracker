/* Syncing, driven as two phones against one server.

       node tests/run-sync.js

   Two independent copies of the app — separate windows, separate localStorage,
   exactly as two officers' phones are — talking to a fake server that behaves
   the way PostgREST does: rows keyed by id, filtered by `updated_at` greater
   than a mark, upserts that merge.

   The questions worth answering here are not "does a request get sent". They
   are: does an edit made in a corridor reach the other phone; does a deletion
   stay deleted; when two people edit the same task, is the outcome one anybody
   would defend; and does a device that has been offline for a week come back
   without losing its own work. Those cannot be answered by looking at source.
*/
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
const check = (name, cond, extra = '') => {
  if (cond) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name + (extra ? '   — ' + extra : '')); }
};

const FILES = [
  'assets/js/util.js', 'assets/js/store.js', 'assets/js/sync.js'
];

/* ---------------- the server ----------------
   Rows in tables, and the three behaviours the sync layer actually leans on:
   `updated_at=gt.X` ordered ascending, upsert-by-id, delete-by-id. Its clock is
   its own and deliberately ahead of both devices, because a phone with a wrong
   watch is the failure this design is meant to survive. */
// What each table actually has, taken from backend/supabase/sync.sql.
const COLUMNS = {
  people:    ['id', 'unit_id', 'name', 'active', 'body', 'updated_at'],
  events:    ['id', 'unit_id', 'title', 'status', 'body', 'updated_at'],
  tasks:     ['id', 'event_id', 'unit_id', 'title', 'status', 'body', 'updated_at'],
  reports:   ['id', 'event_id', 'drive_link', 'drive_owned', 'status', 'body', 'updated_at'],
  letters:   ['id', 'unit_id', 'subject', 'status', 'stops', 'internal', 'body', 'updated_at'],
  offices:   ['id', 'code', 'name', 'active', 'body', 'updated_at'],
  deletions: ['entity', 'entity_id', 'unit_id', 'deleted_at', 'deleted_by'],
  term:      ['id', 'end_date', 'body', 'updated_at'],
  units:     ['id', 'name', 'code', 'kind', 'tracker_name', 'active', 'body', 'updated_at'],
  council:   ['id', 'body', 'updated_at']
};

/* The colleges, as schema.sql actually seeds them: every one, under ids the
   server chose. The client seeds the same list under ids of its own ('unit-nat',
   'unit-cas'), and sync matches the two by code and adopts the server's — after
   which a unit is one thing everywhere.

   The stand-in used to hold no units at all and hand back a single invented
   national one whenever the table was empty. That fallback vanished the moment
   anything was pushed, so whether a device had adopted the server's ids
   depended on the order the tests happened to run in, and "a renamed unit
   travels" passed about one run in three. Worse than the flake: the adoption
   path — the one thing that lets a college rename itself — was never being
   tested at all. */
const SERVER_UNITS = [
  ['national',  'NAT'],     ['comelec',   'COMELEC'], ['judiciary', 'SC'],
  ['branch',    'DUAG'],    ['province',  'CAS'],     ['province',  'CBA'],
  ['province',  'CCJE'],    ['province',  'CTE'],     ['province',  'COE'],
  ['province',  'CN'],      ['province',  'CHTM'],    ['province',  'CCS'],
  ['province',  'ELEM'],    ['province',  'JHS'],     ['province',  'SHS'],
  ['province',  'GS']
];

function seedServerUnits(tables, now) {
  SERVER_UNITS.forEach(([kind, code], i) => {
    const n = String(i + 1).padStart(2, '0');
    const id = '9' + n + 'aaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa' + n;
    tables.units[id] = {
      id, code, kind, name: code, tracker_name: code, active: true,
      body: { id, code, kind, name: code, trackerName: code, active: true,
              updatedAt: '2026-01-01T00:00:00.000Z' },
      updated_at: now()
    };
  });
}

function makeServer() {
  const tables = { people: {}, events: {}, tasks: {}, reports: {}, letters: {},
                   offices: {}, deletions: {}, term: {}, units: {}, council: {} };
  /* A real server tells roughly the real time, and the devices talking to it
     have roughly that time too. This used to answer with a fixed date in the
     past, which made every device look like its clock was a day fast — so the
     records they wrote were stamped ahead of the server's own clock, and that
     is a state no healthy council is ever in. Tests written against it were
     testing the stand-in's fiction.

     Still strictly increasing, because the pull asks for "newer than" and two
     rows sharing a stamp is a page that never ends. */
  let tick = 0;
  const now = () => {
    tick += 1;
    return new Date(Date.now() + tick).toISOString();
  };
  seedServerUnits(tables, now);
  return {
    tables,
    now,
    requests: [],
    /* Refuses what PostgREST refuses. It used to be helpful — it knew that a
       deletion is timed by `deleted_at` and quietly used the right column
       whatever it was asked for. The client was asking for `updated_at`, which
       the real table does not have, so every pull of deletions failed with a
       400 while these tests passed: a deleted task came back on every other
       phone, for ever, and nothing anywhere said so. A stand-in that is kinder
       than the real thing is worse than no stand-in at all. */
    changed(table, since, limit, column) {
      const key = column || 'updated_at';
      this.requests.push({ op: 'changed', table, since, key });
      const cols = COLUMNS[table] || [];
      if (cols.indexOf(key) < 0) {
        const e = new Error('column ' + table + '.' + key + ' does not exist');
        e.status = 400;
        return Promise.reject(e);
      }
      /* PostgREST answers `order=<col>.asc&limit=N` and stops at N. This used to
         hand back every row whatever it was asked for, so the cap the real
         server applies — and every consequence of a page ending early — was
         never once exercised here. A stand-in more generous than the real thing
         hides exactly the faults it exists to catch. */
      return Promise.resolve(Object.keys(tables[table] || {})
        .map((k) => tables[table][k])
        .filter((r) => !since || String(r[key]) > String(since))
        .sort((a, b) => String(a[key]).localeCompare(String(b[key])))
        .slice(0, limit || 500));
    },
    upsert(table, rows) {
      this.requests.push({ op: 'upsert', table, n: rows.length });

      /* The foreign key on tasks.unit_id. A directive written before this device
         adopted the server's unit ids carries an id the server has no row for,
         and offering it back takes the whole round down. */
      if (this.refuseWrite !== null) {
        for (const r of rows) {
          if (table !== 'tasks' || !r.unit_id) continue;
          if (!tables.units[r.unit_id]) {
            const e = new Error('insert or update on table "tasks" violates foreign key ' +
              'constraint "tasks_unit_id_fkey"');
            e.status = 409;
            return Promise.reject(e);
          }
        }
      }

      /* NOT NULL, which the real schema has on tasks.event_id and this stand-in
         did not. A directive is a task belonging to no activity, so every one of
         them was refused by the database and accepted here — and directives
         quietly never synced at all while every test said they did. */
      for (const r of rows) {
        for (const [t, col] of [['tasks', 'event_id'], ['reports', 'event_id'],
                                ['events', 'unit_id']]) {
          if (table !== t) continue;
          // directives.sql drops NOT NULL on tasks.event_id; a task must still
          // say which unit it belongs to, by its activity or by itself.
          if (t === 'tasks' && col === 'event_id' && r.unit_id) continue;
          if (r[col] === null || r[col] === undefined) {
            const e = new Error('null value in column "' + col + '" of relation "' +
              t + '" violates not-null constraint');
            e.status = 400;
            return Promise.reject(e);
          }
        }
      }

      /* Row-level security refuses writes, and refuses them for the whole
         request — PostgREST does not write the rows it likes and skip the rest.
         This stand-in used to accept everything from anybody, so a device
         holding a record it may read but not write looked perfectly healthy
         here and could not sync at all in the field. */
      if (this.refuseWrite) {
        for (const r of rows) {
          if (this.refuseWrite(table, r)) {
            const e = new Error('new row violates row-level security policy for table "' +
              table + '"');
            e.status = 401;
            return Promise.reject(e);
          }
        }
      }

      /* The unique indexes the real schema carries. Without them this stand-in
         accepts two offices sharing a code, or two reports for one activity,
         and the suite happily proves a collision cannot happen while Postgres
         refuses it every time. */
      for (const r of rows) {
        for (const [t, col] of [['offices', 'code'], ['reports', 'event_id']]) {
          if (table !== t || r[col] === undefined || r[col] === null) continue;
          const clash = Object.keys(tables[t])
            .map((k) => tables[t][k])
            .find((x) => x[col] === r[col] && x.id !== r.id);
          if (clash) {
            const e = new Error('duplicate key value violates unique constraint "' +
              t + '_' + col + '_key"');
            e.status = 409;
            return Promise.reject(e);
          }
        }
      }

      rows.forEach((r) => {
        // The server stamps its own clock on arrival, exactly as a database does.
        const key = table === 'deletions' ? r.entity + ':' + r.entity_id : r.id;
        /* A deep copy, because a real server does not share memory with the
           client. Storing the row by reference let a later edit on the device
           appear to have been uploaded when nothing had been sent — the test
           agreeing with the code because they were the same object. */
        const stamped = JSON.parse(JSON.stringify(r));
        if (table === 'deletions') stamped.deleted_at = now();
        else stamped.updated_at = now();
        tables[table][key] = stamped;
      });
      return Promise.resolve([]);
    },
    remove(table, ids) {
      this.requests.push({ op: 'remove', table, n: ids.length });
      ids.forEach((id) => { delete tables[table][id]; });
      return Promise.resolve(null);
    },
    serverNow() { return Promise.resolve(now()); },
    /* The unit list as PostgREST would answer it: whatever has been written to
       the table, plus the National unit every council starts with. */
    // What /rest/v1/units answers: every unit, always. No fallback.
    units() {
      return Promise.resolve(Object.keys(tables.units).map((k) => tables.units[k]));
    }
  };
}

/* ---------------- a phone ---------------- */
function makeDevice(server, name) {
  const vc = new VirtualConsole();
  const dom = new JSDOM('<!doctype html><html><body><div id="view"></div></body></html>', {
    url: 'http://localhost/index.html', runScripts: 'dangerously',
    virtualConsole: vc, pretendToBeVisual: true
  });
  const w = dom.window;
  const errors = [];
  vc.on('jsdomError', (e) => errors.push(e.message));

  FILES.forEach((f) => {
    const s = w.document.createElement('script');
    s.textContent = fs.readFileSync(path.join(ROOT, f), 'utf8');
    w.document.head.appendChild(s);
  });

  // app.js normally does this at boot; these devices load the store alone.
  w.Store.load();

  // Signed in as a national officer, with the server standing in for Supabase.
  w.Auth = {
    isOffline: () => false,
    signedIn: () => true,
    current: () => ({ name: name, email: name + '@filamer.edu.ph' }),
    myUnitId: () => w.Store.nationalUnitId()
  };
  w.Backend = {
    changed: (t, s2, l, c) => server.changed(t, s2, l, c),
    upsert: (t, r) => server.upsert(t, r),
    remove: (t, i) => server.remove(t, i),
    serverNow: () => server.serverNow(),
    units: () => server.units()
  };

  return { w, S: w.Store, Sync: w.Sync, name, errors };
}

(async function main() {
  const server = makeServer();
  const A = makeDevice(server, 'Althea');
  const B = makeDevice(server, 'Bea');

  const natA = A.S.nationalUnitId();

  console.log('--- identity ---');
  const ev = A.S.addEvent({ title: 'Leadership Summit', unitId: natA, dateStart: '2026-10-01' });
  check('a new record gets a uuid', A.w.U.isUuid(ev.id), ev.id);
  check('so does a task', A.w.U.isUuid(A.S.addTask({ eventId: ev.id, title: 'Book the hall' }).id));

  /* Ids from before this existed have to be carried over, references and all —
     a task pointing at an event id that no longer exists is a task nobody can
     find, and it would happen to every record the council already had. */
  console.log('\n--- data saved before uuids ---');
  {
    const old = JSON.parse(A.S.toJSON());
    const d = old.data;
    d.events = [{ id: 'evt_old1', unitId: natA, title: 'Old Assembly', status: 'Upcoming',
                  createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' }];
    d.tasks = [{ id: 'tsk_old1', eventId: 'evt_old1', title: 'Old task', status: 'Not Started',
                 createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' }];
    d.reports = [{ id: 'rep_old1', eventId: 'evt_old1',
                   createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' }];
    A.S.fromJSON(JSON.stringify(old));

    const e2 = A.S.events()[0];
    const t2 = A.S.tasks()[0];
    check('an old id becomes a uuid', A.w.U.isUuid(e2.id), e2.id);
    check('and its task followed it', t2.eventId === e2.id, t2.eventId + ' vs ' + e2.id);
    check('so did its report', A.S.report(e2.id) !== null);
    check('nothing was orphaned', A.S.tasks().every((t) => !!A.S.event(t.eventId)));
  }

  /* ---------------- one way ---------------- */
  console.log('\n--- what one phone does reaches the other ---');
  A.S.fromJSON(JSON.stringify({ data: { units: A.S.units(), offices: A.S.offices(),
    people: [], events: [], tasks: [], reports: [], letters: [] } }));
  B.S.fromJSON(JSON.stringify({ data: { units: B.S.units(), offices: B.S.offices(),
    people: [], events: [], tasks: [], reports: [], letters: [] } }));

  const summit = A.S.addEvent({ title: 'General Assembly', unitId: A.S.nationalUnitId() });
  const task = A.S.addTask({ eventId: summit.id, title: 'Reserve the gym', priority: 'High' });

  await A.Sync.now();
  check('the event was sent', !!server.tables.events[summit.id]);
  check('and the task with it', !!server.tables.tasks[task.id]);
  check('the whole record travels, not just its columns',
    server.tables.events[summit.id].body.title === 'General Assembly');

  await B.Sync.now();
  check('the other phone has the event', !!B.S.event(summit.id), B.S.events().length + ' events');
  check('and the task', !!B.S.task(task.id));
  check('with its priority intact', B.S.task(task.id).priority === 'High');

  /* ---------------- both ways ---------------- */
  console.log('\n--- and back again ---');
  B.S.updateTask(task.id, { status: 'Done' });
  await B.Sync.now();
  await A.Sync.now();
  check('a change made on the second phone comes back', A.S.task(task.id).status === 'Done');

  /* ---------------- the same task, twice ---------------- */
  console.log('\n--- two people, one task ---');
  A.S.updateTask(task.id, { remarks: 'Althea got the gym' });
  await new Promise((r) => setTimeout(r, 5));
  B.S.updateTask(task.id, { remarks: 'Bea booked the AVR' });

  await A.Sync.now();
  await B.Sync.now();
  await A.Sync.now();
  check('both phones end up saying the same thing',
    A.S.task(task.id).remarks === B.S.task(task.id).remarks,
    A.S.task(task.id).remarks + ' / ' + B.S.task(task.id).remarks);
  check('and it is the later edit that stands',
    A.S.task(task.id).remarks === 'Bea booked the AVR', A.S.task(task.id).remarks);

  /* ---------------- deleting ----------------
     The one that goes wrong quietly. A phone that still holds a deleted record
     sees it missing from the server, decides the server is behind, and puts it
     back — so the record returns days later with no explanation. */
  console.log('\n--- a deletion stays deleted ---');
  const doomed = A.S.addTask({ eventId: summit.id, title: 'Print the tarpaulin' });
  await A.Sync.now();
  await B.Sync.now();
  check('both phones have it', !!A.S.task(doomed.id) && !!B.S.task(doomed.id));

  A.S.deleteTask(doomed.id);
  await A.Sync.now();
  check('it is gone from the server', !server.tables.tasks[doomed.id]);
  check('and the deletion was recorded', !!server.tables.deletions['task:' + doomed.id]);

  await B.Sync.now();
  check('the other phone drops it too', !B.S.task(doomed.id));

  await B.Sync.now();
  await A.Sync.now();
  await B.Sync.now();
  check('and it does not come back', !A.S.task(doomed.id) && !B.S.task(doomed.id));

  /* Deleting an event takes its tasks with it, on every device. */
  console.log('\n--- deleting an event takes its work with it ---');
  const scrapped = A.S.addEvent({ title: 'Cancelled Fun Run', unitId: A.S.nationalUnitId() });
  const under = A.S.addTask({ eventId: scrapped.id, title: 'Order the medals' });
  await A.Sync.now(); await B.Sync.now();
  check('the second phone has both', !!B.S.event(scrapped.id) && !!B.S.task(under.id));

  A.S.deleteEvent(scrapped.id);
  await A.Sync.now(); await B.Sync.now();
  check('the event is gone from both', !A.S.event(scrapped.id) && !B.S.event(scrapped.id));
  check('and so is the task under it', !B.S.task(under.id));

  /* ---------------- a week in a drawer ---------------- */
  console.log('\n--- a phone that was offline all week ---');
  const offlineEvent = B.S.addEvent({ title: 'Recollection', unitId: B.S.nationalUnitId() });
  const offlineTask = B.S.addTask({ eventId: offlineEvent.id, title: 'Book the retreat house' });
  // Meanwhile the other phone carried on.
  const meanwhile = A.S.addEvent({ title: 'Sportsfest', unitId: A.S.nationalUnitId() });
  await A.Sync.now();

  await B.Sync.now();
  check('nothing it made while away was lost',
    !!B.S.event(offlineEvent.id) && !!B.S.task(offlineTask.id));
  check('and it caught up on what it missed', !!B.S.event(meanwhile.id));
  await A.Sync.now();
  check('its work reached the others', !!A.S.event(offlineEvent.id));

  /* ---------------- letters ---------------- */
  console.log('\n--- letters carry their whole trail ---');
  const letter = A.S.addLetter({
    subject: 'Request for the gymnasium', unitId: A.S.nationalUnitId(),
    route: [{ officeId: A.S.officeByCode('PRES').id }, { label: 'Sen. Kyla Villanueva' }]
  });
  A.S.receiveStop(letter.id, letter.stops[0].id, { receivedBy: 'Mrs. Ferrer' });
  await A.Sync.now(); await B.Sync.now();
  const there = B.S.letter(letter.id);
  check('the letter arrived', !!there);
  check('with both signatories', there && there.stops.length === 2);
  check('the office one by office', there && there.stops[0].officeId === A.S.officeByCode('PRES').id);
  check('the person one by name', there && there.stops[1].label === 'Sen. Kyla Villanueva');
  check('and who received it', there && there.stops[0].receivedBy === 'Mrs. Ferrer');

  /* ---------------- offline is not an error ---------------- */
  console.log('\n--- no server, no complaints ---');
  {
    const C = makeDevice(server, 'Carlo');
    C.w.Auth.isOffline = () => true;
    const before = server.requests.length;
    const st = await C.Sync.now();
    check('an offline device does not call out', server.requests.length === before);
    check('and reports no error', !st.error, st.error);
    check('it just says it cannot sync', st.able === false);
  }

  /* ---------------- a server that is down ---------------- */
  console.log('\n--- a server that will not answer ---');
  {
    const wasChanged = A.w.Backend.changed;
    A.w.Backend.changed = () => Promise.reject(new Error('Failed to fetch'));
    const before = A.S.events().length;
    const st = await A.Sync.now();
    check('the failure is caught, not thrown', !!st.error, st.error);
    check('and nothing on the device was lost', A.S.events().length === before);
    A.w.Backend.changed = wasChanged;
    const ok = await A.Sync.now();
    check('the next round recovers', !ok.error, ok.error);
  }

  /* ---------------- it must not chase its own tail ----------------
     The sync layer listens for changes so it can send them, and a sync that
     ends by announcing a change schedules the next one. That loop is invisible
     in every screenshot and would run every few seconds on every phone for as
     long as the app is open. */
  console.log('\n--- syncing does not trigger syncing ---');
  {
    let woke = 0;
    A.S.subscribe(() => { woke += 1; });

    await A.Sync.now();
    check('a round that changed nothing wakes no view', woke === 0, woke + ' wake-ups');

    const fresh = B.S.addEvent({ title: 'Officers\u2019 Retreat', unitId: B.S.nationalUnitId() });
    await B.Sync.now();
    woke = 0;
    await A.Sync.now();
    check('but one that brought something in does', woke > 0);
    check('and it arrived', !!A.S.event(fresh.id));

    woke = 0;
    await A.Sync.now();
    check('and the round after that is quiet again', woke === 0, woke + ' wake-ups');
  }

  /* ---------------- the server owns the clock ----------------
     `updated_at` is what a pull filters on, so every row must be stamped by one
     clock. The fake server above stamps its own — as Postgres does with the
     trigger the migration installs — and this holds the client to never sending
     one, because for a while it did, and two phones with watches a few minutes
     apart would then have quietly stopped seeing each other's work. */
  console.log('\n--- the clock belongs to the server ---');
  {
    const row = A.Sync.toRow('event', {
      id: '22222222-2222-4222-8222-222222222222', title: 'X',
      unitId: natA, updatedAt: '2099-01-01T00:00:00.000Z'
    });
    check('a pushed row carries no timestamp of its own',
      !('updated_at' in row), JSON.stringify(Object.keys(row)));
    check('but the edit time travels inside the record',
      row.body.updatedAt === '2099-01-01T00:00:00.000Z');

    // And a device whose watch is wrong still receives everything.
    const fast = makeDevice(server, 'Fast');
    const realNow = Date.now;
    fast.w.Date.now = () => realNow() + 9 * 60 * 1000;   // nine minutes fast
    const seen = A.S.addEvent({ title: 'Clock Test', unitId: natA });
    await A.Sync.now();
    await fast.Sync.now();
    check('a phone with a wrong clock still gets what it missed', !!fast.S.event(seen.id));
    fast.w.Date.now = realNow;
  }

  /* ---------------- the tombstone table is timed differently ---------------- */
  console.log('\n--- deletions are asked for by their own clock ---');
  {
    const asked = server.requests.filter((r) => r.op === 'changed' && r.table === 'deletions');
    check('the deletions pull happened', asked.length > 0);
    check('and asked on deleted_at, which is the column it has',
      asked.every((r) => r.key === 'deleted_at'),
      JSON.stringify(asked.slice(-1)));
    check('while everything else is asked on updated_at',
      server.requests.filter((r) => r.op === 'changed' && r.table !== 'deletions')
        .every((r) => r.key === 'updated_at'));
  }

  /* A pull that fails must be reported, not swallowed. It was swallowed, which
     is how a deletion that never propagated looked exactly like one that did. */
  console.log('\n--- a refused pull is not silence ---');
  {
    const real = A.w.Backend.changed;
    A.w.Backend.changed = (t, s2, l, c) => {
      if (t === 'deletions') {
        const e = new Error('column deletions.updated_at does not exist');
        e.status = 400;
        return Promise.reject(e);
      }
      return real(t, s2, l, c);
    };
    const st = await A.Sync.now();
    check('a broken deletions pull is reported', !!st.error, st.error);
    A.w.Backend.changed = real;

    // A server that has never had the table is the one honest exception.
    A.w.Backend.changed = (t, s2, l, c) => {
      if (t === 'deletions') {
        const e = new Error('Not Found');
        e.status = 404;
        return Promise.reject(e);
      }
      return real(t, s2, l, c);
    };
    const st2 = await A.Sync.now();
    check('but a server without the table is not an error', !st2.error, st2.error);
    A.w.Backend.changed = real;
  }

  /* ---------------- nothing is invented any more ----------------
     The app used to open on a seeded council so the end of term could be
     rehearsed. Every device seeded its own, with its own ids, so two phones
     syncing merged two rehearsals and the council saw every invented officer
     twice. Nothing seeds now, and anything left over from then is swept up. */
  console.log('\n--- the app opens empty ---');
  {
    const D1 = makeDevice(server, 'Fresh');
    check('a new device invents nobody', D1.S.people().length === 0,
      D1.S.people().length + ' people');
    check('and no activities', D1.S.events().length === 0, D1.S.events().length);
    check('and no closing date', !D1.S.term().declaredAt, D1.S.term().declaredAt);
    check('but it does have the units', D1.S.units().length > 0, D1.S.units().length);

    const before = Object.keys(server.tables.people).length;
    await D1.Sync.now();
    check('and it sends nothing invented', Object.keys(server.tables.people).length === before,
      before + ' \u2192 ' + Object.keys(server.tables.people).length);

    /* A rehearsal that reached the server from the old version. It must not be
       taken in, and it must not be left there either: whoever sees it first
       records the deletion so it goes for everybody. */
    server.tables.people['33333333-3333-4333-8333-333333333333'] = {
      id: '33333333-3333-4333-8333-333333333333',
      body: { id: '33333333-3333-4333-8333-333333333333', name: 'Invented Officer',
              sample: true, active: true, unitId: natA, updatedAt: '2030-01-01T00:00:00.000Z' },
      updated_at: '2030-01-01T00:00:00.000Z'
    };
    await A.Sync.now();
    check('one already up there is not taken in',
      !A.S.people().some((p) => p.name === 'Invented Officer'));
    await A.Sync.now();
    check('and it is swept off the server',
      !server.tables.people['33333333-3333-4333-8333-333333333333'],
      JSON.stringify(Object.keys(server.tables.people)
        .filter((k) => k.indexOf('3333') === 0)));
  }

  /* ---------------- the closing date ----------------
     The one thing that must read the same on every phone. A term that ends on
     the 6th here and nowhere else is worse than no term at all. */
  console.log('\n--- the term reaches everyone ---');
  {
    /* Two phones of their own, so declaring a term here disturbs nothing the
       earlier sections built. */
    const server2 = makeServer();
    const P = makeDevice(server2, 'President');
    const G = makeDevice(server2, 'Governor');
    await P.Sync.now();
    await G.Sync.now();

    P.S.declareTerm('2026-10-06', { note: 'End of the 2026 term.', by: 'Arron D. Aperocho' });
    const stP = await P.Sync.now();
    check('the round itself did not fault', !stP.error, stP.error);
    check('the declaration was sent', !!server2.tables.term[1],
      JSON.stringify(Object.keys(server2.tables.term)));

    await G.Sync.now();
    check('the other phone has the date', G.S.termStatus().endDate === '2026-10-06',
      G.S.termStatus().endDate);
    check('and who declared it', G.S.term().declaredBy === 'Arron D. Aperocho');
    check('and the note with it', G.S.term().note === 'End of the 2026 term.');

    G.S.declareTerm('2026-10-20', { note: 'Moved by the executive board.', by: 'Bea' });
    await G.Sync.now();
    await P.Sync.now();
    check('a change of date travels back', P.S.termStatus().endDate === '2026-10-20',
      P.S.termStatus().endDate);

    await P.Sync.now();
    check('a quiet round leaves it alone', P.S.termStatus().endDate === '2026-10-20');

    /* A phone joining late has no date of its own and must not overwrite the
       one the council actually declared \u2014 it takes it. */
    const R = makeDevice(server2, 'Latecomer');
    check('a new phone starts with no date', !R.S.term().declaredAt);
    const before = server2.tables.term[1] && server2.tables.term[1].body.endDate;
    await R.Sync.now();
    check('it does not blank the real one',
      server2.tables.term[1].body.endDate === before, server2.tables.term[1].body.endDate);
    check('and it now has the date', R.S.termStatus().endDate === before,
      R.S.termStatus().endDate);
  }

  /* ---------------- a rehearsal that already spread ----------------
     Before the seed was removed, every device pushed its own copy \u2014 so a
     council ends up holding the same invented activity three or four times.
     Updating to this version has to clear it everywhere, by itself, with
     nobody pressing anything. */
  console.log('\n--- updating sweeps the old rehearsal away ---');
  {
    const s3 = makeServer();
    const X = makeDevice(s3, 'Nationals');
    const Y = makeDevice(s3, 'Senator');

    /* What a device on the old version left behind: the rehearsal, on the
       server, under ids nobody else agrees with. */
    const stray = [];
    for (let i = 0; i < 3; i++) {
      const id = '4444444' + i + '-4444-4444-8444-44444444444' + i;
      s3.tables.events[id] = {
        id: id, unit_id: natA,
        body: { id: id, unitId: natA, title: 'Invented activity ' + i, sample: true,
                dateStart: '2026-03-0' + (i + 1), status: 'Planned',
                updatedAt: '2026-01-01T00:00:00.000Z' },
        updated_at: '2026-01-01T00:00:00.000Z'
      };
      stray.push(id);
    }
    check('the rehearsal is on the server, as it would be',
      Object.keys(s3.tables.events).length === 3, Object.keys(s3.tables.events).length);

    await X.Sync.now();
    check('a device today does not take it in',
      stray.every((id) => !X.S.event(id)),
      stray.filter((id) => !!X.S.event(id)).length + ' taken in');

    await X.Sync.now();
    check('and it is removed from the server',
      Object.keys(s3.tables.events).length === 0,
      Object.keys(s3.tables.events).length + ' left');
    check('with the deletions recorded so they travel',
      Object.keys(s3.tables.deletions).length > 0);

    await Y.Sync.now();
    check('the other phone is left with none of the copies',
      stray.every((id) => !Y.S.event(id)),
      stray.filter((id) => !!Y.S.event(id)).length + ' copies left');
    check('and holds no rehearsal of its own', Y.S.events().length === 0,
      Y.S.events().length);
  }


  /* ---------------- setup travels too ----------------
     The letterhead every report is printed on, the unit list, and the posts a
     form offers. Left out of the first sync because they change rarely — and
     "the template the President uploaded is on the President's laptop and
     nowhere else" is exactly the disagreement this layer exists to prevent. */
  console.log('\n--- the setup reaches everyone ---');
  {
    const s4 = makeServer();
    const P2 = makeDevice(s4, 'President');
    const G2 = makeDevice(s4, 'Governor');
    await P2.Sync.now();
    await G2.Sync.now();

    // A unit renamed, and one added.
    const nat = P2.S.unit(P2.S.nationalUnitId());
    P2.S.updateUnit(nat.id, { trackerName: 'FCUSR Nationals 2026' });
    const fresh = P2.S.addUnit({ kind: 'province', name: 'College of Maritime Studies', code: 'CMS' });

    // The Republic's own details.
    P2.S.updateOrg({ address: 'Roxas Avenue, Roxas City, Capiz 5800', email: 'sr@filamer.edu.ph' });
    P2.S.addListValue('positions', 'Sergeant-at-Arms');

    await P2.Sync.now();
    await G2.Sync.now();

    check('a new unit reaches the other phone', !!G2.S.unit(fresh.id), G2.S.units().length + ' units');
    check('and it is named the same', G2.S.unit(fresh.id).name === 'College of Maritime Studies');
    check('a renamed unit travels', G2.S.unit(nat.id).trackerName === 'FCUSR Nationals 2026',
      G2.S.unit(nat.id).trackerName);
    check('the council\u2019s details travel', G2.S.org().email === 'sr@filamer.edu.ph',
      G2.S.org().email);
    check('and so do the posts a form offers',
      G2.S.positions().indexOf('Sergeant-at-Arms') >= 0);

    /* A college renamed on a phone that has never synced. Its units are still
       under the ids this device invented, and outbound() will not send a record
       whose id is not a uuid — so the edit can only travel if adopting the
       server's ids carries it. It has to: an officer setting up their college
       on the bus, before they have signal, is the ordinary case, not the odd
       one. */
    const Fresh = makeDevice(s4, 'Never synced');
    const cn = Fresh.S.units().filter((u) => u.code === 'CN')[0];
    check('a new device holds its own id for a college', !Fresh.w.U.isUuid(cn.id), cn.id);
    Fresh.S.updateUnit(cn.id, { trackerName: 'CN Governor\u2019s Office' });
    await Fresh.Sync.now();
    await Fresh.Sync.now();
    await G2.Sync.now();
    const cnG = G2.S.units().filter((u) => u.code === 'CN')[0];
    check('and the rename still reaches the other phone',
      cnG && cnG.trackerName === 'CN Governor\u2019s Office',
      cnG && cnG.trackerName);

    // A letter template is the one everybody most needs to agree on.
    P2.S.updateOrg({ letterhead: 'data:image/png;base64,iVBORw0KGgo=', letterheadBy: 'Arron' });
    await P2.Sync.now();
    await G2.Sync.now();
    check('the Republic\u2019s letter template travels',
      G2.S.org().letterhead === 'data:image/png;base64,iVBORw0KGgo=',
      String(G2.S.org().letterhead).slice(0, 32));
    check('with who uploaded it', G2.S.org().letterheadBy === 'Arron');
  }

  /* ---------------- catching up after a long time away ----------------
     A pull used to take one page a round. The mark advanced, so the next round
     collected the rest — but a device coming back after a term would need a
     dozen rounds to catch up while showing "Synced" the whole way. */
  console.log('\n--- a big catch-up finishes in one round ---');
  {
    const s5 = makeServer();
    const M = makeDevice(s5, 'Maker');
    const L = makeDevice(s5, 'Latecomer');
    await M.Sync.now();
    await L.Sync.now();

    const unit = M.S.nationalUnitId();
    for (let i = 0; i < 1200; i++) {
      s5.tables.events['e' + i] = {
        id: '00000000-0000-4000-8000-' + String(i).padStart(12, '0'),
        unit_id: unit, title: 'Activity ' + i, status: 'Upcoming',
        body: { id: '00000000-0000-4000-8000-' + String(i).padStart(12, '0'),
                unitId: unit, title: 'Activity ' + i, status: 'Upcoming',
                updatedAt: '2026-05-01T00:00:00.000Z', createdAt: '2026-05-01T00:00:00.000Z' },
        // After this device's mark, or they would rightly be filtered out.
        updated_at: new Date(Date.UTC(2027, 0, 1, 0, 0, i)).toISOString()
      };
    }

    const before = L.S.events().length;
    const st = await L.Sync.now();
    const gained = L.S.events().length - before;
    check('a thousand activities arrive in one round', gained === 1200, gained + ' arrived');
    check('and the round says how many it took in',
      st.last && st.last.added === 1200, st.last && st.last.added);

    // Nothing is fetched twice on the next round.
    const reqs = s5.requests.filter((r) => r.op === 'changed' && r.table === 'events').length;
    await L.Sync.now();
    const after = s5.requests.filter((r) => r.op === 'changed' && r.table === 'events').length;
    check('a quiet round afterwards asks once, not again for everything',
      after - reqs === 1, (after - reqs) + ' asks');
    check('and takes nothing in', L.S.events().length - before === 1200);
  }

  /* ---------------- saying where things are ----------------
     "The sync is broken" is not something anybody can act on. */
  console.log('\n--- what is where ---');
  {
    const s6 = makeServer();
    const D = makeDevice(s6, 'Device');
    D.S.addEvent({ title: 'Held here only', unitId: D.S.nationalUnitId() });

    const before = await D.Sync.diagnose();
    const ev = before.rows.filter((r) => r.kind === 'event')[0];
    check('it counts what this device holds', ev.here > 0, JSON.stringify(ev));
    check('and that the server has none of it', ev.there === 0, JSON.stringify(ev));

    await D.Sync.now();
    const after = await D.Sync.diagnose();
    const ev2 = after.rows.filter((r) => r.kind === 'event')[0];
    check('after a sync the server has it', ev2.there === ev2.here,
      JSON.stringify(ev2));

    // It must never change what it is looking at.
    const counts = D.S.events().length;
    await D.Sync.diagnose();
    check('asking does not alter anything', D.S.events().length === counts);

    // A refused table is reported, not hidden.
    const real = D.w.Backend.changed;
    D.w.Backend.changed = (t, s7, l, c) => (t === 'letters'
      ? Promise.reject(Object.assign(new Error('permission denied for table letters'), { status: 403 }))
      : real(t, s7, l, c));
    const bad = await D.Sync.diagnose();
    const lt = bad.rows.filter((r) => r.kind === 'letter')[0];
    check('a refused table shows as refused', lt.there === null, JSON.stringify(lt));
    check('and says what the server said', /permission denied/.test(bad.error || ''), bad.error);
    D.w.Backend.changed = real;
  }

  /* ---------------- an empty device asks for everything ----------------
     The mark can be true and useless together: a device that was emptied keeps
     a mark from before there was anything to take in, and then sits reporting
     "Synced, 0 taken in" beside another phone full of the council's work. */
  console.log('\n--- an empty device does not stay empty ---');
  {
    const s7 = makeServer();
    const Full = makeDevice(s7, 'Full');
    const Empty = makeDevice(s7, 'Empty');

    // Both have synced once, so both carry a mark.
    await Full.Sync.now();
    await Empty.Sync.now();

    /* One is emptied but keeps its mark — which is what ending a rehearsal
       does, and what a browser restored from a backup does. resetAll clears
       the mark as well, so the mark is put back to model the real case. */
    const markBefore = Empty.S.syncState().pulled;
    Empty.S.resetAll();
    Empty.S.markSynced({ pulled: markBefore, pushed: markBefore });
    check('it really is empty', Empty.S.events().length === 0 && Empty.S.people().length === 0);
    check('and it still carries a mark from before', Empty.S.syncState().pulled === markBefore,
      Empty.S.syncState().pulled);

    // Meanwhile the other does some real work.
    const ev = Full.S.addEvent({ title: 'Foundation Week', unitId: Full.S.nationalUnitId() });
    Full.S.addTask({ eventId: ev.id, title: 'Book the gym' });
    await Full.Sync.now();

    const st = await Empty.Sync.now();
    check('the empty one takes it in rather than reporting nothing',
      !!Empty.S.event(ev.id), JSON.stringify(st.last));
    check('and says how much came back', st.last && st.last.added > 0, st.last && st.last.added);
  }

  /* ---------------- it corrects itself, without anybody pressing anything ----
     Most officers cannot open Settings at all, so a repair that lives behind a
     button in Settings is not a repair. A device with a wrong mark has to come
     right on its own. */
  console.log('\n--- a wrong mark corrects itself ---');
  {
    const s8 = makeServer();
    const One = makeDevice(s8, 'One');
    const Two = makeDevice(s8, 'Two');
    await One.Sync.now();
    await Two.Sync.now();

    // One holds work and is convinced it has already sent it — the exact state
    // a half-finished round leaves behind.
    const ev = One.S.addEvent({ title: 'General Assembly', unitId: One.S.nationalUnitId() });
    One.S.addTask({ eventId: ev.id, title: 'Reserve the gym' });
    One.S.markSynced({ pushed: new Date(Date.now() + 60000).toISOString() });

    const stuck = await One.Sync.now();
    check('an ordinary round sends nothing, as it believes', stuck.last.sent === 0,
      JSON.stringify(stuck.last));
    check('and the other phone has none of it', !Two.S.event(ev.id));

    /* The next time the app is opened. No button, no Settings, nobody told to
       do anything. */
    const Reopened = makeDevice(s8, 'One again');
    Reopened.S.fromJSON(One.S.toJSON());
    await Reopened.Sync.now();
    check('opening the app sends it anyway', !!s8.tables.events[ev.id],
      Object.keys(s8.tables.events).length + ' on the server');

    await Two.Sync.now();
    check('and the other phone finally has it', !!Two.S.event(ev.id));
    check('with its task', !!Two.S.task(One.S.tasks({ eventId: ev.id })[0].id));
  }

  /* A full round must never put an old copy over a newer one: it pulls before
     it pushes, so everything here has already won or lost on its own merits. */
  console.log('\n--- a full round does not trample newer work ---');
  {
    const s9 = makeServer();
    const A2 = makeDevice(s9, 'A2');
    const B2 = makeDevice(s9, 'B2');
    const ev = A2.S.addEvent({ title: 'Sportsfest', unitId: A2.S.nationalUnitId() });
    await A2.Sync.now();
    await B2.Sync.now();

    // B2 makes the later edit; A2 still holds the older copy.
    await new Promise((r) => setTimeout(r, 5));
    B2.S.updateEvent(ev.id, { venue: 'FCU Gymnasium' });
    await B2.Sync.now();

    // A2 now does a full round, offering its stale copy.
    await A2.Sync.now({ full: true });
    check('the later edit survives a full send', A2.S.event(ev.id).venue === 'FCU Gymnasium',
      A2.S.event(ev.id).venue);
    check('and is still the one on the server',
      s9.tables.events[ev.id].body.venue === 'FCU Gymnasium',
      s9.tables.events[ev.id].body.venue);
  }

  /* ---------------- two devices inventing the same thing ----------------
     The client mints an id, but the server holds other columns unique — an
     office's code, an activity's report. Two officers doing the ordinary thing
     at the same time could each produce a value the other had already used, and
     the second to sync was refused every round afterwards with nothing on screen
     naming the cause. */
  console.log('\n--- two officers add the same office ---');
  {
    const sA = makeServer();
    const D1 = makeDevice(sA, 'D1');
    const D2 = makeDevice(sA, 'D2');
    await D1.Sync.now(); await D2.Sync.now();

    const o1 = D1.S.addOffice({ name: 'Office of the Chaplain' });
    const o2 = D2.S.addOffice({ name: 'Office of the Chaplain' });
    check('each device gave it a code', !!o1.code && !!o2.code, o1.code + ' / ' + o2.code);
    check('and the two codes differ, so neither is refused', o1.code !== o2.code,
      o1.code + ' vs ' + o2.code);

    await D1.Sync.now();
    const st = await D2.Sync.now();
    check('both reached the server without a refusal', !st.error, st.error);
    check('and both are on it',
      !!sA.tables.offices[o1.id] && !!sA.tables.offices[o2.id]);
  }

  console.log('\n--- two officers start the same report ---');
  {
    const sB = makeServer();
    const E1 = makeDevice(sB, 'E1');
    const E2 = makeDevice(sB, 'E2');
    const ev = E1.S.addEvent({ title: 'Nurses Week', unitId: E1.S.nationalUnitId() });
    await E1.Sync.now(); await E2.Sync.now();
    check('both phones have the activity', !!E2.S.event(ev.id));

    // Each opens the wizard before either has synced.
    E1.S.saveReport(ev.id, { description: 'Written on the first phone.' });
    E2.S.saveReport(ev.id, { description: 'Written on the second phone.' });
    check('both reports carry the same id, because the activity decides it',
      E1.S.report(ev.id).id === E2.S.report(ev.id).id,
      E1.S.report(ev.id).id + ' / ' + E2.S.report(ev.id).id);

    await E1.Sync.now();
    const st2 = await E2.Sync.now();
    check('the second one is merged, not refused', !st2.error, st2.error);
    check('and the server holds exactly one report for the activity',
      Object.keys(sB.tables.reports).length === 1,
      Object.keys(sB.tables.reports).length + ' reports');
  }

  console.log('\n--- deleting an activity takes its report with it ---');
  {
    const sC = makeServer();
    const F1 = makeDevice(sC, 'F1');
    const ev = F1.S.addEvent({ title: 'Sportsfest', unitId: F1.S.nationalUnitId() });
    F1.S.saveReport(ev.id, { description: 'Filed.' });
    const rid = F1.S.report(ev.id).id;
    await F1.Sync.now();
    check('the report reached the server', !!sC.tables.reports[rid]);

    F1.S.deleteEvent(ev.id);
    check('the report went with the activity, not on the next reload',
      F1.S.reports().filter((r) => r.eventId === ev.id).length === 0);
    await F1.Sync.now();
    check('and it was removed from the server', !sC.tables.reports[rid]);
  }

  /* ---------------- three phones, one council ----------------
     Every section above proves one mechanism. This one asks the only question a
     council actually has: after everybody has worked, does every phone show the
     same thing, and does it then stay still? A system that converges but keeps
     rewriting itself is not synced — it is arguing. */
  console.log('\n--- three phones end up holding the same council ---');
  {
    const s7 = makeServer();
    const P = makeDevice(s7, 'President');
    const G = makeDevice(s7, 'Governor');
    const S = makeDevice(s7, 'Senator');
    const all = [P, G, S];
    const unit = P.S.nationalUnitId();

    // Each phone does its own work, none of them having seen the others.
    const e1 = P.S.addEvent({ title: 'General Assembly', unitId: unit, dateStart: '2026-10-01' });
    const e2 = G.S.addEvent({ title: 'Leadership Training', unitId: unit, dateStart: '2026-10-08' });
    S.S.addPerson({ name: 'Dueño, Kyla', unitId: unit, position: 'Senator' });
    P.S.addTask({ kind: 'event', eventId: e1.id, title: 'Book the gymnasium', dueDate: '2026-09-20' });
    G.S.addTask({ kind: 'event', eventId: e2.id, title: 'Print the certificates', dueDate: '2026-09-25' });

    // Two rounds each: one to send, one to take in what the others sent.
    for (let i = 0; i < 2; i++) for (const d of all) await d.Sync.now();

    const shape = (d) => JSON.stringify({
      events: d.S.events().map((e) => e.title).sort(),
      tasks: d.S.tasks().map((t) => t.title).sort(),
      people: d.S.people().map((x) => x.name).sort()
    });
    check('the President and the Governor hold the same council',
      shape(P) === shape(G), shape(P) + '\n        vs ' + shape(G));
    check('and so does the Senator', shape(P) === shape(S),
      shape(P) + '\n        vs ' + shape(S));
    check('all three activities and tasks are there',
      P.S.events().length === 2 && P.S.tasks().length === 2 && P.S.people().length === 1,
      P.S.events().length + ' events, ' + P.S.tasks().length + ' tasks, ' +
      P.S.people().length + ' people');

    /* Settled. Another round must move nothing — not one record sent, not one
       taken in. Anything else is two devices handing the same row back and
       forth, which is how a council's battery dies and its data churns. */
    const quiet = [];
    for (const d of all) {
      const st = await d.Sync.now();
      quiet.push(d.name + ': ' + (st.last ? st.last.sent + ' sent, ' +
        (st.last.added + st.last.updated) + ' taken' : 'no round'));
    }
    check('and a further round moves nothing at all',
      quiet.every((q) => q.indexOf('0 sent, 0 taken') > 0), quiet.join(' | '));

    // A deletion on one phone reaches the other two and does not come back.
    P.S.deleteEvent(e2.id);
    for (let i = 0; i < 2; i++) for (const d of all) await d.Sync.now();
    check('a deletion reaches every phone',
      all.every((d) => !d.S.event(e2.id)),
      all.filter((d) => !!d.S.event(e2.id)).map((d) => d.name).join(', '));
    check('and its task went with it',
      all.every((d) => d.S.tasks().length === 1),
      all.map((d) => d.name + '=' + d.S.tasks().length).join(', '));

    for (let i = 0; i < 2; i++) for (const d of all) await d.Sync.now();
    check('and it does not come back on later rounds',
      all.every((d) => !d.S.event(e2.id)));
    check('none of the three logged an error',
      all.every((d) => d.errors.length === 0),
      all.map((d) => d.name + ': ' + d.errors.slice(0, 1).join('')).join(' | '));
  }

  /* ---------------- a person removed on the server ----------------
     Removing a member is the server's act now: it deletes the directory entry
     and records the deletion. So no device performs the local deletePerson, and
     every one of them arrives at the receiving path instead — which used to
     remove the row and nothing else. Two phones then showed the same letter
     differently, for ever, and neither was going to correct the other. */
  console.log('\n--- somebody removed elsewhere is tidied up here ---');
  {
    const s8 = makeServer();
    const A2 = makeDevice(s8, 'President');
    const B2 = makeDevice(s8, 'Senator');
    const unit = A2.S.nationalUnitId();

    const per = A2.S.addPerson({ name: 'Rutor, Angel', unitId: unit, position: 'Senator' });
    const ev2 = A2.S.addEvent({ title: 'General Assembly', unitId: unit, headId: per.id });
    const tk = A2.S.addTask({ kind: 'event', eventId: ev2.id, title: 'Book the hall',
      assigneeId: per.id, dueDate: '2026-10-01' });
    const lt = A2.S.addLetter({ unitId: unit, subject: 'Request for the budget',
      inChargeId: per.id,
      route: [{ officeId: A2.S.officeByCode('PRES').id }] });

    for (let i = 0; i < 2; i++) for (const d of [A2, B2]) await d.Sync.now();
    check('the other phone has them', !!B2.S.person(per.id));
    check('and the letter names who is carrying it',
      B2.S.letterInCharge(B2.S.letter(lt.id)) === 'Rutor, Angel',
      B2.S.letterInCharge(B2.S.letter(lt.id)));

    /* What remove_member does: the row goes and a tombstone is written. Neither
       device deletes anything itself — that is the whole point. */
    delete s8.tables.people[per.id];
    s8.tables.deletions['person:' + per.id] = {
      entity: 'person', entity_id: per.id, unit_id: unit,
      deleted_at: s8.now(), deleted_by: 'President'
    };

    for (const d of [A2, B2]) await d.Sync.now();

    [['President', A2], ['Senator', B2]].forEach(([name, d]) => {
      check(name + ': the person is gone', !d.S.person(per.id));
      check(name + ': the task is held by nobody', d.S.task(tk.id).assigneeId === '',
        d.S.task(tk.id).assigneeId);
      check(name + ': the event has no head', d.S.event(ev2.id).headId === '');
      check(name + ': the letter still says who was carrying it',
        d.S.letterInCharge(d.S.letter(lt.id)) === 'Rutor, Angel',
        d.S.letterInCharge(d.S.letter(lt.id)));
    });

    check('and both phones agree, which is the whole point',
      A2.S.letterInCharge(A2.S.letter(lt.id)) === B2.S.letterInCharge(B2.S.letter(lt.id)));
  }

  /* ---------------- two devices agree about the given things ----------------
     The colleges and the desks are written into the app, identical everywhere,
     and nobody authors them. They used to be stamped with the moment each phone
     was first opened, which claimed an edit that never happened and gave every
     device a different date for the same row.

     Merging is last-write-wins on that stamp and it is strictly-greater, so a
     college renamed on one phone at the same millisecond as another phone's
     first visit is judged "not newer" and dropped. That is a rename lost with
     nothing said, and it is the signature of a sync failure that turned up
     about one run in ten and could not be made to happen on demand.

     A fixed date behind any real use closes it: an edit always wins, and two
     untouched devices agree exactly. */
  console.log('\n--- the given things are dated the same everywhere ---');
  {
    const s9 = makeServer();
    const one = makeDevice(s9, 'One');
    const two = makeDevice(s9, 'Two');

    const stamps = (d) => d.S.units().map((u) => u.updatedAt);
    check('every seeded unit carries one fixed date',
      new Set(stamps(one)).size === 1, [...new Set(stamps(one))].join(', '));
    check('and it is behind anything anybody could have done',
      stamps(one)[0] < new Date().toISOString(), stamps(one)[0]);
    check('two devices date them identically',
      JSON.stringify(stamps(one)) === JSON.stringify(stamps(two)));
    check('and the offices too',
      JSON.stringify(one.S.offices().map((o) => o.updatedAt)) ===
      JSON.stringify(two.S.offices().map((o) => o.updatedAt)));

    /* The thing that was actually going wrong: an edit made now must beat a
       seeded row on the other phone, whatever millisecond it lands in. */
    const u1 = one.S.units().filter((u) => u.code === 'CN')[0];
    one.S.updateUnit(u1.id, { trackerName: 'CN Governor' });
    check('an edit is newer than the given date, always',
      one.S.unit(u1.id).updatedAt > stamps(two)[0],
      one.S.unit(u1.id).updatedAt + ' vs ' + stamps(two)[0]);

    for (let i = 0; i < 2; i++) for (const d of [one, two]) await d.Sync.now();
    const u2 = two.S.units().filter((u) => u.code === 'CN')[0];
    check('so it reaches the other phone', u2 && u2.trackerName === 'CN Governor',
      u2 && u2.trackerName);
  }

  /* ---------------- a great many deletions at once ----------------
     Records are fetched a page at a time, over and over, until the table is
     exhausted. Deletions were fetched once, with a cap, and no second ask.

     On its own that would only be slow: the mark would stop at the last
     tombstone seen and the rest would come next round. But records and
     deletions share ONE mark, and the records pass runs first — so if anything
     was edited after the last tombstone that fitted in the page, the mark jumps
     past the tombstones that did not fit and they are never asked for again.
     Those rows stay on that phone for good, and a full reconcile does not save
     it: it starts from the beginning and truncates in exactly the same place.

     A council reaches this by clearing out a term, or by a mass removal, and
     what it looks like is deleted work quietly reappearing on one person's
     phone and nowhere else. */
  console.log('\n--- a thousand deletions do not lose the rest ---');
  {
    const sD = makeServer();
    const D = makeDevice(sD, 'Catcher');
    const unit = D.S.nationalUnitId();

    const ev3 = D.S.addEvent({ title: 'Clearing out', unitId: unit });
    await D.Sync.now();

    // 1200 tasks the council made and then deleted somewhere else.
    const ids = [];
    for (let i = 0; i < 1200; i++) {
      const t = D.S.addTask({ kind: 'event', eventId: ev3.id, title: 'Task ' + i });
      ids.push(t.id);
    }
    await D.Sync.now();
    check('the phone is holding all of them', D.S.tasks().length >= 1200,
      D.S.tasks().length);

    ids.forEach((id) => {
      delete sD.tables.tasks[id];
      sD.tables.deletions['task:' + id] = {
        entity: 'task', entity_id: id, unit_id: unit,
        deleted_at: sD.now(), deleted_by: 'President'
      };
    });

    /* Something edited AFTER the last of those tombstones. This is what carries
       the shared mark past them. */
    sD.tables.events[ev3.id].updated_at = sD.now();
    sD.tables.events[ev3.id].body.updatedAt = '2030-01-01T00:00:00.000Z';
    sD.tables.events[ev3.id].body.title = 'Clearing out (revised)';

    await D.Sync.now();
    await D.Sync.now();
    check('every deletion arrives, not just the first page',
      ids.every((id) => !D.S.task(id)),
      ids.filter((id) => !!D.S.task(id)).length + ' left behind');

    // And it survives the full reconcile, which starts from nothing.
    await D.Sync.now({ full: true });
    check('and they stay gone after a full round',
      ids.every((id) => !D.S.task(id)),
      ids.filter((id) => !!D.S.task(id)).length + ' came back');
  }

  /* ---------------- a phone whose clock is wrong ----------------
     Merging is last-write-wins on the stamp the AUTHORING device wrote. So a
     phone two days fast stamps everything two days in the future, and from then
     on it wins every disagreement for ever: nobody else's genuine later edit can
     ever be newer, and the corrections simply vanish with nothing said.

     Students' phones have wrong clocks. A dead battery, a manual time zone, a
     cheap handset that drifts. The server's own time is asked for on every round
     already — it was just being thrown away. */
  console.log('\n--- a phone with a wrong clock cannot win for ever ---');
  {
    const sC2 = makeServer();
    const Right = makeDevice(sC2, 'Correct clock');
    const Fast = makeDevice(sC2, 'Two days fast');

    /* Two days ahead, the way a handset with a manual time zone is. Only this
       device's clock moves; the server's is untouched. */
    const SKEW = 2 * 24 * 3600 * 1000;
    const realDate = Fast.w.Date;
    function FakeDate(...a) {
      return a.length ? new realDate(...a) : new realDate(realDate.now() + SKEW);
    }
    FakeDate.now = () => realDate.now() + SKEW;
    FakeDate.parse = realDate.parse;
    FakeDate.UTC = realDate.UTC;
    FakeDate.prototype = realDate.prototype;
    Fast.w.Date = FakeDate;

    const ev4 = Right.S.addEvent({ title: 'Original title', unitId: Right.S.nationalUnitId() });
    for (let i = 0; i < 2; i++) for (const d of [Right, Fast]) await d.Sync.now();
    check('both phones have it', !!Fast.S.event(ev4.id) && !!Right.S.event(ev4.id));

    // The fast phone edits it once.
    Fast.S.updateEvent(ev4.id, { title: 'Edited on the fast phone' });
    for (let i = 0; i < 2; i++) for (const d of [Fast, Right]) await d.Sync.now();
    check('its edit travels', Right.S.event(ev4.id).title === 'Edited on the fast phone',
      Right.S.event(ev4.id).title);

    /* And now the correction, made afterwards by somebody whose clock is right.
       This is the one that used to disappear. */
    Right.S.updateEvent(ev4.id, { title: 'Corrected by the President' });
    for (let i = 0; i < 2; i++) for (const d of [Right, Fast]) await d.Sync.now();

    check('a later edit from a correct clock is not overruled',
      Right.S.event(ev4.id).title === 'Corrected by the President',
      Right.S.event(ev4.id).title);
    check('and it reaches the fast phone too',
      Fast.S.event(ev4.id).title === 'Corrected by the President',
      Fast.S.event(ev4.id).title);

    Fast.w.Date = realDate;
  }

  /* A fast phone that made records BEFORE it ever synced. Those carry its own
     wrong clock, and once it learns the server's the correction moves its clock
     backwards — so those records sit ahead of every mark it will ever write.
     If the mark is a wall clock and the records are in its future, they are
     "still to send" on every round, for ever: a phone pushing the same rows
     every twenty seconds until its battery dies. */
  console.log('\n--- a fast phone settles down instead of pushing for ever ---');
  {
    const sF = makeServer();
    const F = makeDevice(sF, 'Fast');
    const SKEW = 2 * 24 * 3600 * 1000;
    const realDate = F.w.Date;
    function FakeDate(...a) {
      return a.length ? new realDate(...a) : new realDate(realDate.now() + SKEW);
    }
    FakeDate.now = () => realDate.now() + SKEW;
    FakeDate.parse = realDate.parse;
    FakeDate.UTC = realDate.UTC;
    FakeDate.prototype = realDate.prototype;
    F.w.Date = FakeDate;

    // Work done before it has ever spoken to the server.
    const e5 = F.S.addEvent({ title: 'Made before syncing', unitId: F.S.nationalUnitId() });
    for (let i = 0; i < 4; i++) F.S.addTask({ kind: 'event', eventId: e5.id, title: 'Task ' + i });

    /* Records written in the same millisecond as a round's mark are offered
       once more, which is by design and costs a round — sometimes two, since a
       change also schedules a round of its own. How many is not the point and
       asserting it made this fail about twice in twenty-five runs on timing
       alone. The property is that it STOPS, and then stays stopped. */
    const sent = [];
    let settledAfter = -1;
    for (let i = 0; i < 10; i++) {
      /* A breath between rounds, because the app leaves twenty seconds. Run
         back to back, every round starts in the same millisecond the records
         were written in, and the mark — one tick behind the round's start —
         cannot get past them. That is the harness racing itself, not the app
         misbehaving, and it made this fail about twice in twenty-five runs. */
      await new Promise((r) => setTimeout(r, 6));
      const st = await F.Sync.now();
      sent.push(st.last ? st.last.sent : -1);
      if (sent.length >= 3 && sent.slice(-3).every((n) => n === 0)) { settledAfter = i + 1; break; }
    }
    check('it settles, rather than pushing the same rows for ever',
      settledAfter > 0, sent.join(', ') + ' sent — never went quiet');
    check('and it settles at once, not eventually',
      settledAfter > 0 && settledAfter <= 4, 'took ' + settledAfter + ' rounds: ' + sent.join(', '));

    F.w.Date = realDate;
  }

  /* ---------------- a record you may read but not write ----------------
     An officer of a college is attached to a National activity so it shows on
     their dashboard. They may read it — that is the point — and they may not
     write it, because a college does not edit the Republic's activities.

     Their phone holds it all the same. And a full round sends everything the
     phone holds, so it offers that activity back; the server refuses the whole
     request, because row-level security refuses a request, not a row. So one
     record they were deliberately given breaks every sync they will ever run,
     and nothing else gets through either — their own college's work included. */
  console.log('\n--- one record you may not write does not stop the rest ---');
  {
    const sR = makeServer();
    const Gov = makeDevice(sR, 'Governor');
    const natUnit = Gov.S.nationalUnitId();
    const cn = Gov.S.units().filter((u) => u.kind === 'province')[0];

    // A National activity this phone was given sight of, and its own college's.
    const natEv = Gov.S.addEvent({ title: 'National General Assembly', unitId: natUnit });
    const ownEv = Gov.S.addEvent({ title: 'CN Nurses Week', unitId: cn.id });

    /* The server now behaves as the policy does: this device may write its own
       college and nothing else. */
    sR.refuseWrite = function (table, row) {
      if (table !== 'events') return false;
      return row.unit_id && row.unit_id !== cn.id;
    };

    const st = await Gov.Sync.now();
    check('the round does not fault', !st.error, st.error);
    check('their own college\u2019s activity still reaches the server',
      !!sR.tables.events[ownEv.id],
      Object.keys(sR.tables.events).length + ' events on the server');
    check('the one they may not write is simply left alone',
      !sR.tables.events[natEv.id]);
    check('and it is still on their phone, where they can read it',
      !!Gov.S.event(natEv.id));

    check('and the refusal is counted, not swallowed',
      st.last && st.last.refused === 1, st.last && st.last.refused);

    // And the next round is not stuck on it either.
    const again = await Gov.Sync.now();
    check('the round after that is fine too', !again.error, again.error);

    /* Nor is it offering the same record back one at a time for ever. Finding
       out which row a refusal was about costs one request per row; doing that
       every hour, for the life of a term, on a phone that already knows the
       answer, is not a cost anybody should pay twice. */
    const before = sR.requests.length;
    await Gov.Sync.now({ full: true });
    const singles = sR.requests.slice(before)
      .filter((r) => r.op === 'upsert' && r.table === 'events' && r.n === 1).length;
    check('and it does not go back to asking one row at a time', singles <= 1,
      JSON.stringify(sR.requests.slice(before).filter((r) => r.op === 'upsert')));
  }

  /* ---------------- pictures a deletion leaves behind ----------------
     Photographs and scans live in IndexedDB under the report's id, and they are
     the only large thing this app keeps. Deleting an activity HERE has always
     freed them. A deletion arriving from another device freed nothing — so an
     activity cleared out by the President left its scans and its eight
     photographs on every other phone in the Republic, for ever, with nothing
     left anywhere that names them. A term of that is tens of megabytes. */
  console.log('\n--- a deletion from elsewhere takes the pictures with it ---');
  {
    const sP = makeServer();
    const A3 = makeDevice(sP, 'President');
    const B3 = makeDevice(sP, 'Senator');
    const unit = A3.S.nationalUnitId();

    // Both phones remember which prefixes were asked to be freed.
    [A3, B3].forEach((d) => {
      d.freed = [];
      d.w.AssetDB = {
        delPrefix: (pfx) => { d.freed.push(pfx); return Promise.resolve(); },
        del: () => Promise.resolve(), getMany: () => Promise.resolve([]),
        put: () => Promise.resolve(), get: () => Promise.resolve(null)
      };
    });

    const ev6 = A3.S.addEvent({ title: 'Leadership Camp', unitId: unit });
    const rep = A3.S.saveReport(ev6.id, {
      description: 'Written up, with the scans and photographs attached.'
    });
    for (let i = 0; i < 2; i++) for (const d of [A3, B3]) await d.Sync.now();
    check('the other phone has the report', !!B3.S.report(ev6.id));

    A3.S.deleteEvent(ev6.id);
    check('deleting it here frees its pictures',
      A3.freed.some((p) => p === rep.id + ':'), JSON.stringify(A3.freed));

    for (let i = 0; i < 2; i++) for (const d of [A3, B3]) await d.Sync.now();
    check('and the other phone lets go of them too',
      B3.freed.some((p) => p === rep.id + ':'),
      B3.freed.length ? JSON.stringify(B3.freed) : 'nothing freed — they are stranded');
    check('with the report itself gone', !B3.S.report(ev6.id));
  }

  /* ---------------- a tombstone the server will not take ----------------
     What a college actually saw: a red bar reading

       new row violates row-level security policy (USING expression)
       for table "deletions"

     Records were taught to survive a refusal. Deletions were not — they went
     straight to the server outside that path, so one tombstone the server would
     not take broke the whole round and every round after it.

     Two ordinary ways to earn it. A volunteer is not an officer, so the policy
     refuses every tombstone they hold. And an officer offering back a tombstone
     the National government wrote is refused on the UPDATE's USING clause,
     because the row already there belongs to another unit — which is the exact
     wording above, and a full round offers back everything the phone holds. */
  console.log('\n--- a refused tombstone does not stop the round ---');
  {
    const sT = makeServer();
    const G3 = makeDevice(sT, 'CN officer');
    const unit = G3.S.nationalUnitId();

    const keep = G3.S.addEvent({ title: 'CN Nurses Week', unitId: unit });
    const doomed = G3.S.addEvent({ title: 'Something deleted', unitId: unit });
    await G3.Sync.now();
    G3.S.deleteEvent(doomed.id);

    // The server refuses tombstones from this device, the way it refuses a
    // volunteer's and a college's over a national row.
    sT.refuseWrite = function (table) { return table === 'deletions'; };

    const st = await G3.Sync.now();
    check('the round does not fault', !st.error, st.error);
    check('and it is not the red bar a college was looking at',
      !/row-level security/i.test(st.error || ''), st.error);
    check('the refusal is counted', st.last && st.last.refused > 0,
      st.last && st.last.refused);

    // Their own work still gets through, which is the whole point.
    const later = G3.S.addEvent({ title: 'Filed after the refusal', unitId: unit });
    const st2 = await G3.Sync.now();
    check('the round after it is clean too', !st2.error, st2.error);
    check('and work made afterwards still reaches the server',
      !!sT.tables.events[later.id],
      Object.keys(sT.tables.events).length + ' events on the server');
    check('the activity they kept is there as well', !!sT.tables.events[keep.id]);

    /* And it is not asking about the same tombstone one row at a time for ever.
       Finding out which row a refusal was about costs a request per row. */
    const before = sT.requests.length;
    await G3.Sync.now({ full: true });
    const singles = sT.requests.slice(before)
      .filter((r) => r.op === 'upsert' && r.table === 'deletions').length;
    check('and it stops offering the refused tombstone', singles === 0,
      singles + ' further offers of a tombstone already refused');
  }

  /* ---------------- directives ----------------
     A directive is council business that belongs to no activity — a standing
     instruction, its own tab in the app. It is stored as a task with no event,
     and tasks.event_id is NOT NULL on the server. So every directive ever
     written was refused by the database.

     Before refusals were survivable that broke the whole round; after, it was
     skipped in silence. Either way no directive has ever reached a second
     phone, and the tab has quietly been a private notebook on each device. */
  console.log('\n--- a directive reaches the other phones ---');
  {
    const sDir = makeServer();
    const One = makeDevice(sDir, 'President');
    const Two = makeDevice(sDir, 'Governor');

    const dir = One.S.addTask({
      kind: 'directive', title: 'File every report before the sixth',
      dueDate: '2026-10-01', priority: 'High'
    });
    check('it is a task with no activity behind it',
      dir.kind === 'directive' && !dir.eventId, dir.kind + '/' + dir.eventId);

    const st = await One.Sync.now();
    check('the round does not fault', !st.error, st.error);
    check('and the directive was actually sent',
      !!sDir.tables.tasks[dir.id], 'the server never got it');

    for (let i = 0; i < 2; i++) for (const d of [One, Two]) await d.Sync.now();
    const there = Two.S.task(dir.id);
    check('the other phone has it', !!there, 'directives do not travel');
    check('and it is still a directive there',
      there && there.kind === 'directive' && !there.eventId,
      there && there.kind);
    check('with what it said', there && there.title === 'File every report before the sixth');

    // Editing one travels too.
    One.S.updateTask(dir.id, { status: 'In Progress' });
    for (let i = 0; i < 2; i++) for (const d of [One, Two]) await d.Sync.now();
    check('and a change to it travels', Two.S.task(dir.id).status === 'In Progress',
      Two.S.task(dir.id) && Two.S.task(dir.id).status);
  }

  /* ---------------- every tab, not just the ones we remembered ----------------
     Directives never synced. Nobody noticed for a term, because every test wrote
     an activity, a task inside it, a letter and a report — and directives are
     none of those, so the one kind of record that could not be stored was the
     one kind nothing tried to store.

     This walks the whole app instead: one of everything a tab can create, made
     on one phone, checked on another. A record type added later that nobody
     wires into sync fails here rather than in somebody's term. */
  console.log('\n--- one of everything reaches the other phone ---');
  {
    const sAll = makeServer();
    const A3 = makeDevice(sAll, 'President');
    const B3 = makeDevice(sAll, 'Governor');
    const unit = A3.S.nationalUnitId();

    // Overview / Events tab
    const ev = A3.S.addEvent({ title: 'General Assembly', unitId: unit,
      dateStart: '2026-10-01', venue: 'Gymnasium' });
    // My tasks tab
    const person = A3.S.addPerson({ name: 'Solis, Rhea', unitId: unit, position: 'Senator' });
    const task = A3.S.addTask({ kind: 'event', eventId: ev.id, title: 'Book the hall',
      assigneeId: person.id, dueDate: '2026-09-20' });
    // Directives tab
    const dir = A3.S.addTask({ kind: 'directive', title: 'File before the sixth' });
    // Letters tab
    const letter = A3.S.addLetter({ unitId: unit, subject: 'Request for the budget',
      route: [{ officeId: A3.S.officeByCode('PRES').id }] });
    // Settings: an office somebody added for a letter
    const office = A3.S.addOffice({ name: 'Office of the Chaplain', turnaroundDays: 3 });
    // Settings: the Republic's own details and the closing date
    A3.S.updateOrg({ address: 'Roxas Avenue, Roxas City, Capiz' });
    A3.S.declareTerm('2026-10-06', { note: 'End of term.', by: 'Arron D. Aperocho' });
    // Reports tab
    const rep = A3.S.saveReport(ev.id, { driveLink: 'https://drive.google.com/x' });

    for (let i = 0; i < 3; i++) for (const d of [A3, B3]) await d.Sync.now();

    const rounds = await B3.Sync.now();
    check('no round faulted along the way', !rounds.error, rounds.error);

    check('Events: the activity is there', !!B3.S.event(ev.id));
    check('Events: with its venue', B3.S.event(ev.id).venue === 'Gymnasium');
    check('People: the officer is there', !!B3.S.person(person.id));
    check('My tasks: the task is there', !!B3.S.task(task.id));
    check('My tasks: still held by the same person',
      B3.S.task(task.id).assigneeId === person.id);
    check('Directives: the directive is there', !!B3.S.task(dir.id),
      'the Directives tab does not sync');
    check('Letters: the letter is there', !!B3.S.letter(letter.id));
    check('Letters: with its trail', (B3.S.letter(letter.id).stops || []).length > 0);
    check('Settings: the added office is there',
      B3.S.offices().some((o) => o.id === office.id), 'offices do not sync');
    check('Settings: the Republic\u2019s details travel',
      B3.S.org().address === 'Roxas Avenue, Roxas City, Capiz', B3.S.org().address);
    check('Settings: the closing date travels',
      B3.S.termStatus().endDate === '2026-10-06', B3.S.termStatus().endDate);
    if (rep) {
      check('Reports: the filed report is there', !!B3.S.report(ev.id),
        'reports do not sync');
      check('Reports: with the Drive link',
        (B3.S.report(ev.id) || {}).driveLink === 'https://drive.google.com/x');
    }

    /* And the whole thing settles: a further round on a device that already
       agrees must send nothing and take nothing. */
    const quiet = await B3.Sync.now();
    check('and it settles rather than churning',
      quiet.last && quiet.last.sent === 0 &&
      (quiet.last.added + quiet.last.updated) === 0,
      quiet.last && JSON.stringify(quiet.last));
  }

  /* ---------------- a directive written before the ids settled ----------------
     A directive carries a unit of its own, because it has no activity to read
     one through. A device seeds its colleges under ids it invented and adopts
     the server's on the first sync — and that new field was added without being
     added to the remapping, so a directive kept the invented id while everything
     around it moved on.

     Offering that back is a foreign key violation, and it takes the whole round
     with it: "Not synced", nothing sent, on a phone that had done nothing wrong. */
  console.log('\n--- a directive written before the ids settled ---');
  {
    const sFk = makeServer();
    const P4 = makeDevice(sFk, 'President');

    // Written while this device still called its National unit by its own name.
    const dir = P4.S.addTask({ kind: 'directive', title: 'BOT Meeting' });
    P4.S.updateTask(dir.id, { remarks: '' });
    const local = P4.S.task(dir.id).unitId;
    check('it carries a unit id', !!local, local);

    const st = await P4.Sync.now();
    check('the round does not fault', !st.error, st.error);
    check('and the directive reached the server', !!sFk.tables.tasks[dir.id],
      'the foreign key refused it');
    check('under an id the server actually has',
      !!sFk.tables.units[sFk.tables.tasks[dir.id].unit_id],
      sFk.tables.tasks[dir.id] && sFk.tables.tasks[dir.id].unit_id);

    // And the local record is moved onto the server's id, not left behind.
    check('the phone now calls it by the server\u2019s id too',
      P4.w.U.isUuid(P4.S.task(dir.id).unitId), P4.S.task(dir.id).unitId);
  }

  console.log('\n--- no console errors ---');
  check('device A stayed quiet', A.errors.length === 0, A.errors.slice(0, 2).join(' | '));
  check('device B stayed quiet', B.errors.length === 0, B.errors.slice(0, 2).join(' | '));

  console.log('\n========================================');
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
