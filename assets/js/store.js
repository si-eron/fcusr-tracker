/* FCUSR Task Tracker — data layer.
   Everything lives in one localStorage record. No backend, no accounts.
   Views never mutate state directly; they call the functions here, which stamp
   timestamps, persist, and notify subscribers so the screen redraws. */
(function (global) {
  'use strict';

  var KEY = 'fcusr.tracker.v1';
  var PERSON_KEY = 'fcusr.tracker.lastPerson';

  var STATUSES = ['Not Started', 'In Progress', 'For Review', 'Done', 'On hold'];
  var PRIORITIES = ['High', 'Medium', 'Low'];
  var EVENT_STATUSES = ['Upcoming', 'Ongoing', 'Completed', 'Archived'];

  /* ---------- units ----------
     The Republic is one National government plus its provinces (the colleges and
     school levels), the Commission on Elections, and the Supreme Court. This list
     mirrors backend/supabase/schema.sql so the same names appear whether the app
     is running offline or against Supabase.

     Nothing outside this list is hard-wired: every screen works from unit ids, so
     the names, codes and the roster itself can be edited in Settings without
     touching code. */
  var UNIT_KINDS = ['national', 'province', 'comelec', 'judiciary', 'branch'];
  var UNIT_KIND_RANK = { national: 0, province: 1, comelec: 2, judiciary: 3, branch: 4 };
  var UNIT_KIND_LABEL = {
    national: 'National', province: 'Province', comelec: 'COMELEC',
    judiciary: 'Judiciary', branch: 'Independent body'
  };

  /* Independent bodies run their own tracker and answer to nobody day to day.
     The National government cannot see their tasks, their events or how far along
     they are — only the accomplishment report they file at the end of the term.
     That is a rule of the Republic, so it lives here rather than in a screen. */
  var INDEPENDENT_KINDS = ['comelec', 'judiciary', 'branch'];

  function isIndependent(unitOrId) {
    var u = typeof unitOrId === 'string' ? unit(unitOrId) : unitOrId;
    return !!u && INDEPENDENT_KINDS.indexOf(u.kind) >= 0;
  }

  /* What the header calls this tracker for whoever is signed in. Everyone works
     inside one unit, so the name of that unit is the name of the tracker. */
  function trackerName(unitOrId) {
    var u = typeof unitOrId === 'string' ? unit(unitOrId) : unitOrId;
    if (!u) return 'FCUSR';
    if (u.trackerName) return u.trackerName;
    if (u.kind === 'national') return 'FCUSR Nationals';
    return 'FCUSR ' + (u.code || u.name);
  }

  function trackerTitle(unitId) {
    var u = unit(unitId) || nationalUnit();
    return trackerName(u) + ' Task Tracker';
  }

  /* kind, code, full name, and the name that goes in the header.

     The header name is held per unit rather than worked out from the kind,
     because the council does not follow one rule: the Commission is "FCU
     COMELEC" while the Judiciary is "FCUSR Judiciary". Every one of these is
     editable in Settings → Units, so a change of wording never needs a
     developer. */
  var DEFAULT_UNITS = [
    ['national',  'NAT',     'FCUSR Nationals',                              'FCUSR Nationals'],
    ['province',  'CAS',     'College of Arts and Sciences',                 'FCUSR CAS'],
    ['province',  'CBA',     'College of Business and Accountancy',          'FCUSR CBA'],
    ['province',  'CCJE',    'College of Criminal Justice Education',        'FCUSR CCJE'],
    ['province',  'CTE',     'College of Teacher Education',                 'FCUSR CTE'],
    ['province',  'COE',     'College of Engineering',                       'FCUSR COE'],
    ['province',  'CN',      'College of Nursing',                           'FCUSR CN'],
    ['province',  'CHTM',    'College of Hospitality and Tourism Management', 'FCUSR CHTM'],
    ['province',  'CCS',     'College of Computer Studies',                  'FCUSR CCS'],
    ['province',  'GS',      'Graduate School',                              'FCUSR GS'],
    ['province',  'SHS',     'Senior High School',                           'FCUSR SHS'],
    ['province',  'JHS',     'Junior High School',                           'FCUSR JHS'],
    ['province',  'ELEM',    'Elementary',                                   'FCUSR Elementary'],
    ['comelec',   'COMELEC', 'Commission on Elections',                      'FCU COMELEC'],
    ['judiciary', 'SC',      'Supreme Court',                                'FCUSR Judiciary'],
    ['branch',    'DUAG',    'DUAG Film Festival',                           'FCUSR DUAG Film Festival']
  ];

  /* The posts the 2022 Revised FCUSR Constitution and By-Laws actually creates,
     in the order the document sets them out: the Executive and its cabinet
     (Art. VI), the two houses of Congress (Art. V), the Supreme Court (Art.
     VII), and the local governments (Art. VIII).

     A position is a label printed on reports and nothing more — no line here
     grants anybody anything, which is decided by unit and access. It is a list
     of suggestions, not a closed set: the field takes a typed answer too,
     because a council invents working titles the constitution never named and
     an officer should not have to pick the nearest wrong one. */
  var DEFAULT_POSITIONS = [
    // Executive
    'President', 'Vice President', 'Executive Secretary',
    'Secretary, Budget', 'Secretary, Peace and Order',
    'Secretary, Press and Public Relations', 'Secretary, General Services',
    'Secretary, Sports', 'Secretary, Health', 'Secretary, Students\u2019 Rights',
    'Secretary, Religious Affairs', 'Secretary, Socio-Cultural',
    // Congress — Senate
    'Senate President', 'Senator', 'Senate Secretary',
    'Majority Floor Leader', 'Minority Floor Leader',
    // Congress — House of Representatives
    'Speaker of the House', 'Deputy Speaker', 'House Representative',
    'Secretary General',
    // Judiciary
    'Chief Justice', 'Associate Justice', 'State Prosecutor', 'State Defender',
    'Clerk of Court',
    // Local government — province
    'Governor', 'Vice Governor', 'Provincial Board Member', 'Provincial Administrator',
    // Local government — municipality
    'Mayor', 'Vice Mayor', 'Councilor', 'Municipal Administrator'
  ];

  /* The legislative committees named in Art. V Sec. 9, plus the departments a
     Provincial Board may create under Art. VIII Sec. 7(f). */
  var DEFAULT_COMMITTEES = [
    'Discipline', 'Socio-Cultural', 'Budget and Finance', 'Religious',
    'Sports and Recreational Activities', 'Health',
    'Media Technology and Documentation', 'Justice', 'Local Government Unit',
    'Education', 'Secretariat', 'Finance', 'Creatives', 'Internal Affairs'
  ];

  // Letterhead details, printed at the top of every report. `emblem` is a data URL
  // uploaded in Settings — the slot for the FCU seal / FCUSR triangle.
  var DEFAULT_ORG = {
    name: 'FILAMER CHRISTIAN UNIVERSITY STUDENT REPUBLIC',
    address: 'Roxas Avenue, Roxas City, Capiz 5800',
    email: 'fcusrnational2026@gmail.com',
    emblem: '',
    /* Blank means the letterhead that ships with the app. A replacement is held
       here as a data URL, with who changed it and when — a new letterhead
       changes every report the council files, so it is not an anonymous edit. */
    letterhead: '', letterheadBy: '', letterheadAt: ''
  };

  var state = null;
  var listeners = [];

  /* ---------- persistence ---------- */

  /* The starting roster of units. Called for a fresh install and whenever saved
     data turns out to carry none — the app is never without somewhere to file work. */
  /* Bumped whenever DEFAULT_UNITS gains an entry. A device that was set up
     before the change gets the new units added once, and once only — so a unit
     somebody deliberately removed does not reappear at every load. */
  var UNIT_SEED_VERSION = 2;

  /* When the seeded units and offices are dated.

     Not "now". They are the same sixteen colleges and the same fifteen desks on
     every device, written into this file rather than authored by anybody — so
     stamping them with the moment a phone happened to be opened claims an
     edit that never happened, and gives every device a different date for the
     identical thing.

     That is not tidiness. Merging is last-write-wins on this stamp, and it is
     strictly-greater, so a college renamed on the President's phone at the same
     millisecond as another phone's first visit was judged "not newer" and
     thrown away. It cost that rename silently, and it is why the sync suite
     failed about one run in ten on nothing but timing.

     A fixed date behind any real use means an edit always wins, and two devices
     that have never been touched agree exactly. */
  var SEEDED_AT = '2020-01-01T00:00:00.000Z';

  function seedUnits() {
    return DEFAULT_UNITS.map(function (u) {
      return {
        id: 'unit-' + u[1].toLowerCase(),
        kind: u[0], code: u[1], name: u[2], trackerName: u[3], active: true,
        createdAt: SEEDED_AT, updatedAt: SEEDED_AT
      };
    });
  }

  function blank() {
    return {
      version: 1,
      units: seedUnits(),
      unitsSeed: UNIT_SEED_VERSION,
      offices: seedOffices(),
      officesSeed: OFFICE_SEED_VERSION,
      term: blankTerm(),
      people: [], events: [], tasks: [], reports: [], letters: [],
      /* What has been deleted, and when. A row removed on one phone has to stay
         removed: without this the next device to sync sees it missing from the
         server, decides the server is behind, and puts it back. */
      deleted: {},
      /* Where syncing got to. `pulled` is the server clock of the newest change
         this device has taken in; asking for anything newer than that is the
         whole of the pull. */
      sync: { pulled: '', pushed: '', at: '', unitMap: {}, officeMap: {} },
      positions: DEFAULT_POSITIONS.slice(),
      committees: DEFAULT_COMMITTEES.slice(),
      org: JSON.parse(JSON.stringify(DEFAULT_ORG)),
      councilAt: '',
      seeded: false
    };
  }

  function load() {
    var raw = null;
    try { raw = global.localStorage.getItem(KEY); } catch (e) { raw = null; }
    if (!raw) {
      state = blank();
      /* Empty. The tracker used to open on an invented council — nine
         activities, sixteen officers, a closing date next month — so that the
         end of term could be walked through before it mattered. It was a good
         idea and it went wrong in the field: every device seeded its own copy
         with its own ids, syncing merged them, and officers opened the app onto
         three of everything and a closing date nobody had set. The rehearsal is
         a fixture the tests ask for now, not something the council is given. */
      save();
      return;
    }
    try {
      var parsed = JSON.parse(raw);
      state = normalize(parsed);
    } catch (e) {
      console.warn('Saved data could not be read; starting fresh.', e);
      state = blank();
    }
  }

  /* ---------- sanitising ----------
     Anything arriving from localStorage or a restored backup file is untrusted:
     the file may have been edited by hand or come from someone else. Every value
     is coerced to the shape the app expects before it is allowed into state, so a
     crafted file cannot smuggle markup into an id or a bogus value into an enum. */

  var LIMITS = { name: 80, role: 60, title: 200, text: 1000, reason: 300, org: 200 };

  function str(v, max) {
    if (typeof v !== 'string') {
      if (typeof v === 'number' && isFinite(v)) v = String(v);
      else return '';
    }
    // Strip control characters, then clamp.
    return v.replace(/[\u0000-\u001F\u007F]/g, '').slice(0, max).trim();
  }

  function id(v, prefix) {
    // Ids end up inside HTML attributes and selectors, so they are strictly shaped.
    return (typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v)) ? v : U.uid(prefix);
  }

  function oneOf(v, allowed, fallback) {
    return allowed.indexOf(v) >= 0 ? v : fallback;
  }

  function dateOnly(v) {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return '';
    var d = U.parse(v);
    if (!d) return '';
    // Reject impossible dates that still match the pattern, e.g. 2026-02-31.
    return d.toISOString().slice(0, 10) === v ? v : '';
  }

  function stamp(v) {
    if (typeof v !== 'string') return nowISO();
    var d = new Date(v);
    return isNaN(d.getTime()) ? nowISO() : d.toISOString();
  }

  // Only real raster data URLs may be rendered or printed. This blocks
  // javascript:, external URLs, and SVG (which can carry script).
  function emblem(v) {
    if (typeof v !== 'string') return '';
    if (!/^data:image\/(png|jpe?g);base64,[A-Za-z0-9+/=\s]+$/.test(v)) return '';
    return v.length > 1400000 ? '' : v;
  }

  /* A replacement letterhead for the accomplishment report. Bigger than the
     emblem because it is a full A4 sheet, and still capped: this lives in
     localStorage alongside everything else, and that has about five megabytes
     in total. */
  function letterhead(v) {
    if (typeof v !== 'string') return '';
    if (!/^data:image\/(png|jpe?g);base64,[A-Za-z0-9+/=\s]+$/.test(v)) return '';
    return v.length > 3000000 ? '' : v;
  }

  function email(v) {
    var t = str(v, 160).toLowerCase();
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(t) ? t : '';
  }

  function cleanPerson(p) {
    if (!p || typeof p !== 'object') return null;
    var name = str(p.name, LIMITS.name);
    if (!name) return null;
    return {
      id: id(p.id, 'per'),
      name: name,
      position: str(p.position, LIMITS.role),
      committee: str(p.committee, LIMITS.role),
      /* The directory is also the record of who was enrolled and for what. A
         person's access and unit are decisions an officer made; the position
         beside them is a label. */
      email: email(p.email),
      unitId: typeof p.unitId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(p.unitId) ? p.unitId : '',
      access: oneOf(p.access, ['officer', 'volunteer'], 'officer'),
      eventIds: (Array.isArray(p.eventIds) ? p.eventIds : []).filter(function (x) {
        return typeof x === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(x);
      }).slice(0, 200),
      // True once they have set a password and can actually sign in.
      claimed: !!p.claimed,
      /* The head of their unit: a Governor, or the Vice Governor who stands in.
         It is what opens their own council's settings to them, and nothing
         else — so it is the National government's to set. */
      isHead: !!p.isHead,
      active: p.active !== false,
      sample: !!p.sample,
      createdAt: stamp(p.createdAt),
      updatedAt: stamp(p.updatedAt)
    };
  }

  function cleanUnit(u) {
    if (!u || typeof u !== 'object') return null;
    var name = str(u.name, LIMITS.org);
    if (!name) return null;
    return {
      id: id(u.id, 'unt'),
      kind: oneOf(u.kind, UNIT_KINDS, 'province'),
      // A code is printed on reports and used nowhere as a key, so it is simply
      // clamped to the shape a code can take.
      code: str(u.code, 16).toUpperCase().replace(/[^A-Z0-9-]/g, ''),
      name: name,
      // What the header calls this tracker. Blank falls back to a sensible
      // reading of the unit, so data saved before this existed still shows a name.
      trackerName: str(u.trackerName, LIMITS.org),
      /* A unit's own letter template. Blank means it uses the Republic's, which
         is what almost every unit does — a college that has its own letterhead
         puts it here and its reports are printed on that instead. */
      letterhead: letterhead(u.letterhead),
      letterheadBy: str(u.letterheadBy, LIMITS.name),
      letterheadAt: u.letterheadAt ? stamp(u.letterheadAt) : '',
      active: u.active !== false,
      createdAt: stamp(u.createdAt),
      updatedAt: stamp(u.updatedAt)
    };
  }

  /* A feedback form is a Google Form, which comes in two shapes: the long
     docs.google.com/forms address and the forms.gle short link people actually
     share. Both are accepted; nothing else is. */
  function formLink(v) {
    if (typeof v !== 'string' || !v) return '';
    var t = v.trim().slice(0, 500);
    return /^https:\/\/(docs\.google\.com\/forms\/|forms\.gle\/)[^\s]*$/.test(t) ? t : '';
  }

  function cleanEvent(e) {
    if (!e || typeof e !== 'object') return null;
    var title = str(e.title, LIMITS.title);
    if (!title) return null;
    var start = dateOnly(e.dateStart);
    var end = dateOnly(e.dateEnd);
    return {
      id: id(e.id, 'evt'),
      // Which unit's activity this is. Checked against the roster in normalize(),
      // so a backup naming a unit that no longer exists cannot orphan an event.
      unitId: typeof e.unitId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(e.unitId) ? e.unitId : '',
      title: title,
      description: str(e.description, LIMITS.text),
      dateStart: start,
      dateEnd: end && start && end >= start ? end : '',
      venue: str(e.venue, LIMITS.title),
      headId: typeof e.headId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(e.headId) ? e.headId : '',
      status: oneOf(e.status, EVENT_STATUSES, 'Upcoming'),

      /* Every activity gathers feedback. That is the standing rule, so it is the
         default rather than something to remember to switch on — an activity
         saved before this existed, or by a client that knows nothing about it,
         still comes back requiring one.

         It can be waived, because not every activity can sensibly be evaluated,
         but a waiver is a departure from the standard and is recorded as one:
         who, when, and why. */
      feedbackRequired: e.feedbackRequired !== false,
      feedbackLink: formLink(e.feedbackLink),
      feedbackWaivedBy: str(e.feedbackWaivedBy, LIMITS.name),
      feedbackWaivedReason: str(e.feedbackWaivedReason, LIMITS.reason),
      feedbackWaivedAt: e.feedbackWaivedAt ? stamp(e.feedbackWaivedAt) : '',

      sample: !!e.sample,
      createdAt: stamp(e.createdAt),
      updatedAt: stamp(e.updatedAt)
    };
  }

  // Statuses that have been renamed since. Without this, older saved data and
  // older backup files would quietly fall back to "Not Started" and lose meaning.
  var STATUS_ALIASES = { 'Blocked': 'On hold', 'Waiting': 'On hold', 'Pending': 'Not Started' };

  function cleanTask(t) {
    if (!t || typeof t !== 'object') return null;
    var title = str(t.title, LIMITS.title);
    if (!title) return null;
    var raw = STATUS_ALIASES[t.status] || t.status;
    var status = oneOf(raw, STATUSES, 'Not Started');
    return {
      id: id(t.id, 'tsk'),
      kind: oneOf(t.kind, ['event', 'directive'], 'event'),
      unitId: id(t.unitId),
      eventId: typeof t.eventId === 'string' ? t.eventId : '',
      title: title,
      remarks: str(t.remarks, LIMITS.text),
      assigneeId: typeof t.assigneeId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(t.assigneeId) ? t.assigneeId : '',
      dueDate: dateOnly(t.dueDate),
      priority: oneOf(t.priority, PRIORITIES, 'Medium'),
      status: status,
      blockedReason: status === 'On hold' ? str(t.blockedReason, LIMITS.reason) : '',
      completedAt: status === 'Done' ? (t.completedAt ? stamp(t.completedAt) : nowISO()) : '',
      sample: !!t.sample,
      createdAt: stamp(t.createdAt),
      updatedAt: stamp(t.updatedAt)
    };
  }

  function assetIds(v) {
    if (!Array.isArray(v)) return [];
    return v.filter(function (x) {
      return typeof x === 'string' && /^[A-Za-z0-9_:-]{1,96}$/.test(x);
    }).slice(0, 60);
  }

  // A Drive link is the only URL the app ever stores, so it is checked strictly.
  function driveLink(v) {
    if (typeof v !== 'string' || !v) return '';
    var t = v.trim().slice(0, 500);
    return /^https:\/\/(drive|docs)\.google\.com\/[^\s]*$/.test(t) ? t : '';
  }

  function cleanReport(r) {
    if (!r || typeof r !== 'object') return null;
    var minutesMode = oneOf(r.minutes && r.minutes.mode, ['tasks', 'upload', 'skip'], 'tasks');
    return {
      id: id(r.id, 'rep'),
      eventId: typeof r.eventId === 'string' ? r.eventId : '',
      description: str(r.description, 4000),
      program: { assets: assetIds(r.program && r.program.assets) },
      photos: (Array.isArray(r.photos) ? r.photos : []).slice(0, 60).map(function (p) {
        return {
          assetId: (typeof p.assetId === 'string' && /^[A-Za-z0-9_:-]{1,96}$/.test(p.assetId)) ? p.assetId : '',
          caption: str(p && p.caption, 200)
        };
      }).filter(function (p) { return p.assetId; }),
      letters: (Array.isArray(r.letters) ? r.letters : []).slice(0, 40).map(function (l) {
        return { name: str(l && l.name, 160), assets: assetIds(l && l.assets) };
      }).filter(function (l) { return l.assets.length; }),
      minutes: { mode: minutesMode, assets: assetIds(r.minutes && r.minutes.assets) },
      liquidation: { assets: assetIds(r.liquidation && r.liquidation.assets) },
      signatories: {
        preparedBy: {
          name: str(r.signatories && r.signatories.preparedBy && r.signatories.preparedBy.name, LIMITS.name),
          position: str(r.signatories && r.signatories.preparedBy && r.signatories.preparedBy.position, LIMITS.role)
        },
        president: {
          name: str(r.signatories && r.signatories.president && r.signatories.president.name, LIMITS.name),
          show: !(r.signatories && r.signatories.president && r.signatories.president.show === false)
        },
        adviser: {
          name: str(r.signatories && r.signatories.adviser && r.signatories.adviser.name, LIMITS.name)
        },
        /* Anyone else who has to sign. The three fixed slots cover the usual
           case; a joint activity, a co-adviser or a department head does not
           fit them, and a report that cannot name its own signatories is not
           the report the council actually files. */
        others: ((r.signatories && Array.isArray(r.signatories.others)) ? r.signatories.others : [])
          .slice(0, 8).map(function (o) {
            return {
              name: str(o && o.name, LIMITS.name),
              position: str(o && o.position, LIMITS.role)
            };
          }).filter(function (o) { return o.name; })
      },
      evaluation: { assets: assetIds(r.evaluation && r.evaluation.assets) },
      driveLink: driveLink(r.driveLink),
      /* A link is only an archive if the file behind it survives turnover. This
         cannot be checked from the URL — a Shared Drive folder and a personal
         one look identical — so somebody says so on the record instead, and that
         attestation is what the end of term actually requires. */
      driveOwned: !!r.driveOwned,
      driveBy: str(r.driveBy, LIMITS.name),
      driveAt: r.driveAt ? stamp(r.driveAt) : '',
      status: oneOf(r.status, ['draft', 'filed'], 'draft'),
      createdAt: stamp(r.createdAt),
      updatedAt: stamp(r.updatedAt)
    };
  }

  /* ---------- one identity per record, everywhere ----------

     Ids used to be `tsk_mtpg8fm9`: unique on this device and meaningless on any
     other. Sync needs two phones to agree that a task is the same task, and
     Postgres wants a uuid, so ids are uuids now.

     Data saved before that carries the old shape. Rewriting an id means
     rewriting everything that points at it in the same pass — a task's event, a
     report's event, a letter's stops — so it is done here, over the whole state
     at once, where nothing can be missed.

     Units and offices are left alone deliberately. They are reference data
     seeded identically on every device from a fixed code list, and their ids
     (`unit-nat`, `office-dean`) are the same everywhere because of it. They are
     reconciled with the server by code at the first sync instead. */
  function normaliseIds(s) {
    var map = {};
    function keep(rec) {
      if (!rec || U.isUuid(rec.id)) return;
      var fresh = U.uid();
      map[rec.id] = fresh;
      rec.id = fresh;
    }
    s.people.forEach(keep);
    s.events.forEach(keep);
    s.tasks.forEach(keep);
    s.reports.forEach(keep);
    s.letters.forEach(keep);
    s.letters.forEach(function (l) { l.stops.forEach(keep); });

    if (!Object.keys(map).length) return s;
    var to = function (v) { return (v && map[v]) || v; };

    s.events.forEach(function (e) { e.headId = to(e.headId); });
    s.tasks.forEach(function (t) { t.eventId = to(t.eventId); t.assigneeId = to(t.assigneeId); });
    s.reports.forEach(function (r) { r.eventId = to(r.eventId); });
    s.people.forEach(function (p) {
      p.eventIds = (p.eventIds || []).map(to);
    });
    s.letters.forEach(function (l) { l.eventId = to(l.eventId); l.inChargeId = to(l.inChargeId); });

    // Tombstones name records too, and a resurrection is exactly what they exist
    // to prevent — so they are carried across with everything else.
    Object.keys(s.deleted || {}).forEach(function (kind) {
      var moved = {};
      Object.keys(s.deleted[kind]).forEach(function (k) { moved[to(k)] = s.deleted[kind][k]; });
      s.deleted[kind] = moved;
    });
    return s;
  }

  /* Called by the sync layer once it has learnt what the server calls a unit or
     an office. Same job as above, for the two kinds that are keyed by code. */
  function remapIds(map) {
    var to = function (v) { return (v && map[v]) || v; };
    var touched = false;
    Object.keys(map).forEach(function (k) { if (map[k] !== k) touched = true; });
    if (!touched) return false;

    state.units.forEach(function (u) { u.id = to(u.id); });
    state.offices.forEach(function (o) { o.id = to(o.id); });
    state.events.forEach(function (e) { e.unitId = to(e.unitId); });
    state.letters.forEach(function (l) {
      l.unitId = to(l.unitId);
      l.stops.forEach(function (st) { st.officeId = to(st.officeId); });
    });
    state.people.forEach(function (p) { p.unitId = to(p.unitId); });
    /* Directives too. A directive carries a unit of its own, because it has no
       activity to read one through — and that field was added without being
       added here, so it kept the id this device invented while everything around
       it moved to the server's. Pushing one then broke the foreign key, and the
       whole round with it. */
    state.tasks.forEach(function (t) { if (t.unitId) t.unitId = to(t.unitId); });
    commit();
    return true;
  }

  /* ---------- taking in what other devices did ----------

     The rule is last-write-wins, per record, on updatedAt. It is the right rule
     for a council: two officers almost never hold the same task at the same
     minute, and when they do, the later edit is the one that was made knowing
     more. It is not free, and it is worth being plain about the cost — if two
     people do edit one task within the same sync window, the earlier edit is
     replaced rather than merged. Nothing is lost that was not overwritten by a
     person who could see the same screen.

     A deletion beats an edit of the same age, because a record deleted and then
     re-uploaded is the failure people actually notice. */
  var COLLECTIONS = {
    unit:   { list: 'units',   clean: cleanUnit },
    person: { list: 'people',  clean: cleanPerson },
    event:  { list: 'events',  clean: cleanEvent },
    task:   { list: 'tasks',   clean: cleanTask },
    report: { list: 'reports', clean: cleanReport },
    letter: { list: 'letters', clean: cleanLetter },
    office: { list: 'offices', clean: cleanOffice }
  };

  function newer(a, b) {
    return String(a || '') > String(b || '');
  }

  /* One record from the server. Returns what happened, which is what lets the
     sync layer report "12 in, 3 out" rather than a spinner that means nothing. */
  function applyRemote(kind, rec) {
    var c = COLLECTIONS[kind];
    if (!c) return 'skipped';
    var clean = c.clean(rec);
    if (!clean || !U.isUuid(clean.id)) return 'skipped';
    /* Somebody's rehearsal, from a version that used to seed one and push it.
       Ignoring it is not enough — it would sit on the server forever, offered to
       every device on every round. Recording it as deleted is what sweeps it
       off, from whichever device happens to see it first. */
    if (clean.sample) {
      tombstone(kind, clean.id);
      return 'skipped';
    }

    // Deleted here since: the server has not heard yet, and will on the push.
    var gone = state.deleted[kind] && state.deleted[kind][clean.id];
    if (gone && !newer(clean.updatedAt, gone)) return 'skipped';

    var list = state[c.list];
    for (var i = 0; i < list.length; i++) {
      if (list[i].id !== clean.id) continue;
      if (!newer(clean.updatedAt, list[i].updatedAt)) return 'kept';
      list[i] = clean;
      return 'updated';
    }
    list.push(clean);
    return 'added';
  }

  /* A deletion from another device. */
  function applyRemoteDeletion(kind, rid, at) {
    var c = COLLECTIONS[kind];
    if (!c || !rid) return false;
    var list = state[c.list];
    /* A deletion removes the record. It used to make an exception for a record
       edited here after the deletion happened elsewhere — which sounds kind and
       was wrong twice over. It compared this device's clock against the server's,
       two clocks that must never be compared, so which one won was luck; and a
       record that comes back days later because somebody touched it is the
       failure people actually notice and cannot explain. Deleting is an explicit
       act by a person who could see the thing. It stands. */
    var found = false;
    var removed = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id !== rid) continue;
      removed = list[i];
      list.splice(i, 1);
      found = true;
      break;
    }
    /* Pictures live in IndexedDB under the report's id, and they are the only
       large thing this app keeps. Deleting something HERE has always freed
       them; a deletion arriving from another device freed nothing, so an
       activity cleared out by the President left its scans and its eight
       photographs on every other phone in the Republic, for ever, with no
       record of them anywhere to find them by.

       A term of activities is tens of megabytes of that. */
    var orphaned = [];
    if (kind === 'event') {
      state.tasks = state.tasks.filter(function (t) { return t.eventId !== rid; });
      state.reports = state.reports.filter(function (r) {
        if (r.eventId === rid) { orphaned.push(r.id); return false; }
        return true;
      });
    }
    if (kind === 'report' && removed) orphaned.push(removed.id);
    if (orphaned.length && global.AssetDB) {
      orphaned.forEach(function (id) { global.AssetDB.delPrefix(id + ':'); });
    }
    /* The same tidying deletePerson does, because otherwise the two devices show
       different things for ever: the one that pressed the button kept the
       carrier's name on a letter as plain text, and every other one was left
       pointing at somebody who no longer exists and showed no name at all.

       It matters more than it used to. Removing a member is done by the server
       now, so no device performs deletePerson at all — every one of them arrives
       here, and without this the name was simply lost everywhere.

       updatedAt is deliberately not bumped. Every device does this same tidying
       from the same tombstone and lands on the same answer, so there is nothing
       to tell anybody about; bumping would have fifty phones push the same rows
       at each other to say a thing they all already agree on. */
    if (kind === 'person' && found) {
      var gone = removed;
      state.tasks.forEach(function (t) { if (t.assigneeId === rid) t.assigneeId = ''; });
      state.events.forEach(function (e) { if (e.headId === rid) e.headId = ''; });
      state.letters.forEach(function (l) {
        if (l.inChargeId !== rid) return;
        l.inChargeId = '';
        if (!l.inChargeName && gone) l.inChargeName = gone.name;
      });
      if (lastPerson() === rid) setLastPerson('');
    }
    if (!state.deleted[kind]) state.deleted[kind] = {};
    state.deleted[kind][rid] = at || nowISO();
    return found;
  }

  /* Everything this device has that the server may not. Sent whole rather than
     as a diff: a record is small, and a diff is a second source of truth. */
  function outbound(since) {
    var out = { records: {}, deletions: [] };
    Object.keys(COLLECTIONS).forEach(function (kind) {
      out.records[kind] = state[COLLECTIONS[kind].list].filter(function (r) {
        /* The dry run stays on the device that made it. Each device seeds its
           own copy with its own ids, so syncing them merges two rehearsals into
           one and the council sees every invented officer twice. It is a
           rehearsal, not the council's work, and it has no business on a server
           everybody shares. */
        if (r.sample) return false;
        return U.isUuid(r.id) && (!since || newer(r.updatedAt, since));
      });
    });
    Object.keys(state.deleted).forEach(function (kind) {
      Object.keys(state.deleted[kind]).forEach(function (rid) {
        var at = state.deleted[kind][rid];
        if (!since || newer(at, since)) out.deletions.push({ kind: kind, id: rid, at: at });
      });
    });
    return out;
  }

  function syncState() { return state.sync; }

  /* Saved, deliberately without telling anyone.

     `commit()` notifies, the sync layer listens for changes so it can send them,
     and so a sync that ended by committing would schedule the next sync — which
     would end by committing, and so on every few seconds for as long as the app
     is open, on every phone, forever. Nothing here is on screen: where the sync
     got to is bookkeeping, not council work. It is written to disk and no view
     is asked to redraw. */
  /* The closing date as another device declared it. One row, so there is no
     merge to do — the later declaration stands, which is the same rule every
     record follows. */
  function applyRemoteTerm(t) {
    var clean = cleanTerm(t);
    if (!clean.declaredAt) return false;
    state.term = clean;
    commit();
    return true;
  }

  /* Forget where syncing got to, so the next round sends everything this device
     holds and takes in everything the server holds.

     Needed because the marks are the one piece of state that can be wrong in a
     way nothing else reveals. A round that failed part-way, a version with a
     bug in it, a device restored from a backup taken after its last sync — any
     of them can leave a device believing it has already sent work it never sent,
     and the symptom is silence: everything looks synced and nobody else has your
     activity. Re-sending is safe because every write is an upsert. */
  function resetSyncMarks(opts) {
    opts = opts || {};
    if (opts.push !== false) state.sync.pushed = '';
    if (opts.pull !== false) state.sync.pulled = '';
    save();
    return state.sync;
  }

  /* The council's own details as one thing: what is printed at the top of every
     report, the Republic's letter template, and the lists a form offers. Setup
     rather than work, which is why it was left out of the first sync — but "the
     letterhead is on the President's laptop and nowhere else" is exactly the
     disagreement this layer exists to prevent. */
  function council() {
    return {
      org: state.org,
      positions: state.positions,
      committees: state.committees,
      updatedAt: state.councilAt || ''
    };
  }

  function touchCouncil() {
    state.councilAt = bumpStamp(state.councilAt);
  }

  function applyRemoteCouncil(c) {
    if (!c || typeof c !== 'object') return false;
    if (!newer(c.updatedAt || '', state.councilAt || '')) return false;
    if (c.org && typeof c.org === 'object') {
      state.org.name = str(c.org.name, LIMITS.org) || state.org.name;
      state.org.address = str(c.org.address, LIMITS.org);
      state.org.email = str(c.org.email, LIMITS.org);
      state.org.emblem = emblem(c.org.emblem);
      state.org.letterhead = letterhead(c.org.letterhead);
      state.org.letterheadBy = str(c.org.letterheadBy, LIMITS.name);
      state.org.letterheadAt = c.org.letterheadAt ? stamp(c.org.letterheadAt) : '';
    }
    if (Array.isArray(c.positions)) state.positions = cleanList(c.positions, DEFAULT_POSITIONS);
    if (Array.isArray(c.committees)) state.committees = cleanList(c.committees, DEFAULT_COMMITTEES);
    state.councilAt = stamp(c.updatedAt) || nowISO();
    commit();
    return true;
  }

  function markSynced(patch) {
    Object.keys(patch || {}).forEach(function (k) { state.sync[k] = patch[k]; });
    save();
  }

  var DELETABLE = ['event', 'task', 'report', 'letter', 'person', 'office', 'unit'];

  /* Tombstones age out. A device that has been in a drawer for three months has
     bigger problems than one resurrected task, and keeping every deletion for
     the life of the council would grow without bound. */
  var TOMBSTONE_DAYS = 120;

  function cleanDeleted(d) {
    var out = {};
    if (!d || typeof d !== 'object') return out;
    var cut = U.addDays(U.today(), -TOMBSTONE_DAYS);
    DELETABLE.forEach(function (kind) {
      var src = d[kind];
      if (!src || typeof src !== 'object') return;
      var keep = {};
      Object.keys(src).slice(0, 5000).forEach(function (k) {
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(k)) return;
        var at = stamp(src[k]);
        if (at && at.slice(0, 10) >= cut) keep[k] = at;
      });
      if (Object.keys(keep).length) out[kind] = keep;
    });
    return out;
  }

  function cleanIdMap(m) {
    var out = {};
    if (!m || typeof m !== 'object') return out;
    Object.keys(m).slice(0, 500).forEach(function (k) {
      if (/^[A-Za-z0-9_-]{1,64}$/.test(k) && U.isUuid(m[k])) out[k] = m[k];
    });
    return out;
  }

  /* Recorded at the moment of deletion, so the next sync can say "this was
     removed" rather than the server saying "you are missing one". */
  function tombstone(kind, rid) {
    if (!rid) return;
    if (!state.deleted[kind]) state.deleted[kind] = {};
    state.deleted[kind][rid] = nowISO();
  }

  function deletions() { return state.deleted; }

  function isDeleted(kind, rid) {
    return !!(state.deleted[kind] && state.deleted[kind][rid]);
  }

  function cleanList(arr, fallback, max) {
    if (!Array.isArray(arr)) return fallback.slice();
    var seen = {};
    var out = arr.map(function (v) { return str(v, LIMITS.role); }).filter(function (v) {
      if (!v || seen[v.toLowerCase()]) return false;
      seen[v.toLowerCase()] = true;
      return true;
    }).slice(0, max || 60);
    return out.length ? out : fallback.slice();
  }

  function normalize(data) {
    var s = blank();
    if (!data || typeof data !== 'object') return s;

    /* Units are read before anything else, because events are filed under them.
       Duplicates are collapsed and a National unit is guaranteed, so there is
       always somewhere for council-wide work to sit. */
    var seenUnit = {};
    s.units = (Array.isArray(data.units) ? data.units : []).map(cleanUnit)
      .filter(function (u) {
        if (!u || seenUnit[u.id]) return false;
        seenUnit[u.id] = true;
        return true;
      });
    if (!s.units.length) s.units = seedUnits();
    if (!s.units.some(function (u) { return u.kind === 'national'; })) {
      s.units.unshift(seedUnits()[0]);
    }

    /* What is actually in the list now, rather than what arrived in the file.

       seenUnit was built from the saved units alone, and the two lines above
       add units without telling it. So a save with no units list — an old
       backup, a file written before units were stored, anything partial — got
       the sixteen colleges from the seed, and then the top-up below could not
       see them and added all sixteen again. Every college twice, on a device
       that had done nothing wrong.

       Adding a missing National unit had the same shape: unshifted, unrecorded,
       and then pushed a second time. Offices avoid both by topping up only when
       nothing was seeded, which is the same fix said another way. */
    seenUnit = {};
    s.units.forEach(function (u) { seenUnit[u.id] = true; });

    // A device set up before a unit existed is topped up once.
    var seenSeed = typeof data.unitsSeed === 'number' ? data.unitsSeed : 0;
    if (seenSeed < UNIT_SEED_VERSION) {
      seedUnits().forEach(function (u) {
        if (!seenUnit[u.id]) { s.units.push(u); seenUnit[u.id] = true; }
      });
    }
    s.unitsSeed = UNIT_SEED_VERSION;

    s.people = (Array.isArray(data.people) ? data.people : []).map(cleanPerson).filter(Boolean);
    s.events = (Array.isArray(data.events) ? data.events : []).map(cleanEvent).filter(Boolean);
    s.tasks = (Array.isArray(data.tasks) ? data.tasks : []).map(cleanTask).filter(Boolean);
    s.reports = (Array.isArray(data.reports) ? data.reports : []).map(cleanReport).filter(Boolean);
    /* Offices are read before letters, because a letter's trail points at them.
       A device set up before an office existed is topped up once, the same way
       units are. */
    var seenOffice = {};
    s.offices = (Array.isArray(data.offices) ? data.offices : []).map(cleanOffice)
      .filter(function (o) {
        if (!o || seenOffice[o.id]) return false;
        seenOffice[o.id] = true;
        return true;
      });
    if (!s.offices.length) s.offices = seedOffices();
    else if ((typeof data.officesSeed === 'number' ? data.officesSeed : 0) < OFFICE_SEED_VERSION) {
      var byId = {};
      s.offices.forEach(function (o) { byId[o.id] = o; });
      seedOffices().forEach(function (o) {
        if (!seenOffice[o.id]) { s.offices.push(o); seenOffice[o.id] = true; return; }
        /* Already here. The council's wording for its own desks has been
           corrected more than once, and a device that seeded the old wording
           should not be stuck with it — but only where nobody has since made
           the name their own. */
        var have = byId[o.id];
        if (have && have.seededName && have.seededName === have.name && have.name !== o.name) {
          have.name = o.name;
          have.seededName = o.name;
        } else if (have && !have.seededName) {
          have.seededName = have.name;
        }
      });
    }
    s.officesSeed = OFFICE_SEED_VERSION;

    s.letters = (Array.isArray(data.letters) ? data.letters : []).map(cleanLetter).filter(Boolean);

    s.term = cleanTerm(data.term);
    s.deleted = cleanDeleted(data.deleted);
    s.sync = {
      pulled: data.sync && typeof data.sync.pulled === 'string' ? stamp(data.sync.pulled) : '',
      pushed: data.sync && typeof data.sync.pushed === 'string' ? stamp(data.sync.pushed) : '',
      at: data.sync && typeof data.sync.at === 'string' ? stamp(data.sync.at) : '',
      unitMap: cleanIdMap(data.sync && data.sync.unitMap),
      officeMap: cleanIdMap(data.sync && data.sync.officeMap)
    };
    s.councilAt = data.councilAt ? stamp(data.councilAt) : '';
    s.positions = cleanList(data.positions, DEFAULT_POSITIONS);
    s.committees = cleanList(data.committees, DEFAULT_COMMITTEES);
    s.seeded = !!data.seeded;

    if (data.org && typeof data.org === 'object') {
      s.org.name = str(data.org.name, LIMITS.org) || DEFAULT_ORG.name;
      s.org.address = str(data.org.address, LIMITS.org);
      s.org.email = str(data.org.email, LIMITS.org);
      s.org.emblem = emblem(data.org.emblem);
      s.org.letterhead = letterhead(data.org.letterhead);
      s.org.letterheadBy = str(data.org.letterheadBy, LIMITS.name);
      s.org.letterheadAt = data.org.letterheadAt ? stamp(data.org.letterheadAt) : '';
    }

    // Drop references that point nowhere: a task cannot exist outside an event,
    // and an assignee or event head must be someone who actually exists.
    /* An event filed under a unit that is not in the roster — older data saved
       before units existed, or a backup from a different roster — becomes National
       work rather than disappearing. */
    var nat = s.units.filter(function (u) { return u.kind === 'national'; })[0];
    var unitIds = {};
    s.units.forEach(function (u) { unitIds[u.id] = true; });
    s.events.forEach(function (e) { if (!unitIds[e.unitId]) e.unitId = nat.id; });

    var eventIds = {}, personIds = {};
    s.events.forEach(function (e) { eventIds[e.id] = true; });
    s.people.forEach(function (p) { personIds[p.id] = true; });
    s.events.forEach(function (e) { if (!personIds[e.headId]) e.headId = ''; });
    s.tasks = s.tasks.filter(function (t) {
      return t.kind === 'directive' ? true : !!eventIds[t.eventId];
    });
    s.reports = s.reports.filter(function (r) { return eventIds[r.eventId]; });

    /* A letter whose event is gone becomes council business rather than
       vanishing, and a stop naming an office that no longer exists is dropped.
       A letter left with no route at all is not a letter we can track. */
    var officeIds = {};
    s.offices.forEach(function (o) { officeIds[o.id] = true; });
    s.letters.forEach(function (l) {
      if (l.eventId && !eventIds[l.eventId]) l.eventId = '';
      if (!unitIds[l.unitId]) l.unitId = nat.id;
      if (!personIds[l.inChargeId]) l.inChargeId = '';
      /* An office that has been deleted leaves its stops behind: the letter
         did go there. The name it was called at the time is kept so the trail
         still reads, and only a stop with neither is dropped. */
      l.stops.forEach(function (st) {
        if (st.officeId && !officeIds[st.officeId]) {
          if (!st.label) st.label = 'A former office';
          st.officeId = '';
        }
      });
      l.stops = l.stops.filter(function (st) { return st.officeId || st.label; });
    });
    s.letters = s.letters.filter(function (l) { return l.stops.length > 0; });
    s.tasks.forEach(function (t) { if (!personIds[t.assigneeId]) t.assigneeId = ''; });

    /* The rehearsal, wherever it still is.

       Devices that ran an older version are holding invented activities and
       officers, and some of it reached the server before it was kept off. This
       clears it once, on every device as it updates, and records the deletions
       so it goes from the server and from everybody else too. Nobody has to
       find a button, and it cannot come back: nothing seeds it any more. */
    var sampleEvents = {};
    s.events.forEach(function (e) { if (e.sample) sampleEvents[e.id] = 1; });
    var doomed = function (list, r) {
      if (r.sample) return true;
      // A task or a letter written against an invented activity goes with it.
      return (list !== 'people') && !!r.eventId && !!sampleEvents[r.eventId];
    };

    var KIND = { events: 'event', tasks: 'task', letters: 'letter',
                 people: 'person', reports: 'report' };
    var at = nowISO();
    Object.keys(KIND).forEach(function (list) {
      var going = s[list].filter(function (r) { return doomed(list, r); });
      if (!going.length) return;
      if (!s.deleted[KIND[list]]) s.deleted[KIND[list]] = {};
      going.forEach(function (r) { s.deleted[KIND[list]][r.id] = at; });
      s[list] = s[list].filter(function (r) { return !doomed(list, r); });
    });

    // The closing date the rehearsal invented is not the council's.
    if (s.term && s.term.declaredBy === 'Dry run') s.term = blankTerm();
    delete s.dryRun;

    return normaliseIds(s);
  }

  /* Whether the last attempt to write to this device failed.

     It used to be a toast and nothing else. A toast is gone in four seconds, and
     what follows is an officer working all afternoon on a screen that looks
     perfectly normal — every event added, every task ticked — with none of it
     written down. One refresh and the afternoon is gone, with no warning still
     on screen by the time it mattered.

     So the app is told, and keeps saying so until a save works. */
  var saveBroken = false;

  function storageBroken() { return saveBroken; }

  function save() {
    try {
      global.localStorage.setItem(KEY, JSON.stringify(state));
      if (saveBroken) { saveBroken = false; notify(); }
    } catch (e) {
      if (!saveBroken) {
        saveBroken = true;
        console.error('Could not save to browser storage.', e);
        if (global.UI && global.UI.toast) {
          global.UI.toast('Could not save — browser storage may be full or blocked.', 'error');
        }
        notify();
      }
    }
  }

  function notify() { listeners.forEach(function (fn) { fn(); }); }
  function subscribe(fn) { listeners.push(fn); }

  function commit() { save(); notify(); }

  var nowISO = function () { return new Date().toISOString(); };

  /* A stamp that is always later than the one before it.

     Used on every edit, not only on the singletons it was written for. An edit
     has to be newer than the version it replaces or it is not an edit at all —
     merging asks exactly that question and discards anything that is not. Plain
     "now" cannot promise it: a phone whose clock is corrected backwards, or two
     changes inside one millisecond, both produce an edit that is not newer than
     what it overwrites, and it disappears with nothing said.


     A phone's clock has millisecond resolution, and two changes to the same
     thing inside one millisecond is ordinary — a form saves, a sync fires, a
     second edit lands. Sync compares these stamps with a strict "newer than", so
     two equal ones mean the second change is invisible: it is never sent, and
     never taken in. Not an error anybody sees; just a letterhead that quietly
     does not travel. */
  function bumpStamp(previous) {
    var now = nowISO();
    if (!previous || now > previous) return now;
    return new Date(Date.parse(previous) + 1).toISOString();
  }

  /* ---------- people ---------- */

  function people(opts) {
    opts = opts || {};
    var list = state.people.slice();
    if (opts.activeOnly) list = list.filter(function (p) { return p.active !== false; });
    if (opts.unitId) list = list.filter(function (p) { return p.unitId === opts.unitId; });
    return list.sort(function (a, b) { return a.name.localeCompare(b.name); });
  }

  /* Who may be given a task on this activity.

     Not everybody in the Republic, which is what the picker used to offer: a
     national officer scrolled past every college's roster to find one of their
     own. It is the unit that owns the activity, plus anybody taken on for this
     activity in particular — which is how somebody from a college comes to be
     working on a national event without leaving their college. */
  /* Who this person may hand work to, on this activity.

     It used to be "everybody in the unit that owns the activity", which is right
     for the unit's own people and backwards for everybody else. A college helping
     with a National activity was offered the National government's entire roster
     — the Republic's executives, in a college officer's assignee picker — while
     their own team, the people actually doing the work, were the ones missing.

     A college's phone can still be holding those names from before the database
     was tightened; sync adds and updates and never takes away, so a roster
     downloaded once stays downloaded. Scoping here rather than trusting what
     happens to be on the device is what makes the picker right on a phone that
     has been signed in since before any of that. */
  function assignable(eventId) {
    var e = event(eventId);
    var evUnit = e ? e.unitId : nationalUnitId();
    var myUnit = (global.Auth && Auth.signedIn() && Auth.myUnitId()) || '';
    var national = !!(global.Auth && Auth.isNational && Auth.isNational());

    var seen = {};
    var out = [];
    var add = function (p) {
      if (seen[p.id]) return;
      seen[p.id] = true;
      out.push(p);
    };

    /* Your own people, always. This is the list a college officer wants and the
       one they were not being given. */
    if (myUnit) people({ activeOnly: true, unitId: myUnit }).forEach(add);

    /* The activity's own unit as well — but only for somebody who belongs to it,
       or for the National government, which oversees every unit. Otherwise a
       college is being offered another unit's roster. */
    if (national || !myUnit || evUnit === myUnit) {
      people({ activeOnly: true, unitId: evUnit }).forEach(add);
    }

    // And anybody taken on for this activity in particular, wherever they are from.
    if (eventId) {
      people({ activeOnly: true }).forEach(function (p) {
        if ((p.eventIds || []).indexOf(eventId) >= 0) add(p);
      });
    }
    return out.sort(function (a, b) { return a.name.localeCompare(b.name); });
  }

  function person(id) {
    if (!id) return null;
    for (var i = 0; i < state.people.length; i++) if (state.people[i].id === id) return state.people[i];
    return null;
  }

  function personName(id) {
    var p = person(id);
    return p ? p.name : 'Unassigned';
  }

  /* One person, and the whole store written to disk and the whole app redrawn
     after it. That is the right trade for somebody typing a name into a form.

     It is the wrong trade a hundred and fifty times in a row. A college pasting
     its roster in went through addPerson per line, so a 150-name list meant 150
     full saves and 150 full redraws, each one a little slower than the last
     because the thing being written keeps growing. What that looks like is the
     app hanging on the one screen built for doing a lot at once. */
  function addPeople(list) {
    var made = [];
    (list || []).forEach(function (data) {
      var p = buildPerson(data);
      if (!p) return;
      state.people.push(p);
      made.push(p);
    });
    if (made.length) commit();
    return made;
  }

  function buildPerson(data) {
    return cleanPerson({
      id: U.uid('per'),
      name: data.name, position: data.position, committee: data.committee,
      /* Whoever is adding them, not the National government by default. That
         default meant an officer enrolled into a college was filed as national,
         so their own Governor could not find them and the national roster filled
         with people who had never been national. */
      email: data.email, isHead: !!data.isHead,
      unitId: data.unitId ||
        ((global.Auth && Auth.signedIn() && Auth.myUnitId()) || nationalUnitId()),
      access: data.access, eventIds: data.eventIds, claimed: data.claimed,
      active: data.active !== false,
      createdAt: nowISO(), updatedAt: nowISO()
    });
  }

  function addPerson(data) {
    var p = buildPerson(data);
    if (!p) throw new Error('A person needs a name.');
    state.people.push(p);
    commit();
    return p;
  }

  /* Correct the directory from the server's own record of who was enrolled.

     An officer enrolled into a college was filed under Nationals, because the
     unit chosen on the form never reached addPerson. That is fixed going
     forward, and this repairs the rows already written: the server knows which
     unit each address was enrolled into, so where the two disagree the server
     wins. Matched on email, which is the only thing both sides agree on. */
  function reconcileDirectory(rows) {
    var byCode = {};
    state.units.forEach(function (u) { byCode[u.name] = u.id; });
    var fixed = 0;

    (rows || []).forEach(function (r) {
      var addr = email(r.email);
      if (!addr) return;
      var p = personByEmail(addr);
      if (!p) return;

      var unitName = (r.units && r.units.name) || r.unit_name || '';
      var uid = byCode[unitName] || '';
      var changed = false;

      if (uid && p.unitId !== uid) { p.unitId = uid; changed = true; }
      if (r.position && p.position !== r.position) { p.position = r.position; changed = true; }
      if (r.access && p.access !== r.access) { p.access = r.access; changed = true; }
      if (!p.claimed && r.active !== undefined) { p.claimed = true; changed = true; }

      if (changed) { p.updatedAt = bumpStamp(p.updatedAt); fixed++; }
    });

    if (fixed) commit();
    return fixed;
  }

  function personByEmail(addr) {
    var want = email(addr);
    if (!want) return null;
    for (var i = 0; i < state.people.length; i++) {
      if (state.people[i].email === want) return state.people[i];
    }
    return null;
  }

  /* The head, and the person standing in, for one unit. */
  function unitHeads(unitId) {
    return people({ unitId: unitId }).filter(function (p) { return p.isHead; });
  }

  function updatePerson(id, data) {
    var p = person(id);
    if (!p) return null;
    if ('name' in data) p.name = (data.name || '').trim();
    if ('position' in data) p.position = (data.position || '').trim();
    if ('committee' in data) p.committee = (data.committee || '').trim();
    if ('active' in data) p.active = !!data.active;
    if ('email' in data) p.email = email(data.email);
    if ('unitId' in data && unit(data.unitId)) p.unitId = data.unitId;
    if ('access' in data) p.access = oneOf(data.access, ['officer', 'volunteer'], p.access);
    if ('eventIds' in data && Array.isArray(data.eventIds)) p.eventIds = data.eventIds.slice(0, 200);
    if ('claimed' in data) p.claimed = !!data.claimed;
    if ('isHead' in data) p.isHead = !!data.isHead;
    p.updatedAt = bumpStamp(p.updatedAt);
    commit();
    return p;
  }

  /* ---------- volunteers ---------- */

  function volunteersFor(eventId) {
    return state.people.filter(function (p) {
      return p.access === 'volunteer' && p.active !== false &&
        (p.eventIds || []).indexOf(eventId) >= 0;
    }).sort(function (a, b) { return a.name.localeCompare(b.name); });
  }

  /* Taking a helper off an activity. If that was the only one they were on there
     is nothing left for them to reach, so they are deactivated rather than left
     holding an account that opens onto nothing. */
  function removeVolunteerFrom(personId, eventId) {
    var p = person(personId);
    if (!p) return null;
    p.eventIds = (p.eventIds || []).filter(function (x) { return x !== eventId; });
    if (!p.eventIds.length) p.active = false;
    p.updatedAt = bumpStamp(p.updatedAt);
    commit();
    return p;
  }

  // People are deactivated, never deleted, so past tasks keep their assignee.
  function setPersonActive(id, active) { return updatePerson(id, { active: active }); }

  /* What removing somebody would actually disturb. Asked before the fact so the
     confirmation can say it, rather than after, when it is a surprise. */
  function personHolds(id) {
    var assigned = state.tasks.filter(function (t) { return t.assigneeId === id; }).length;
    var heads = state.events.filter(function (e) { return e.headId === id; }).length;
    var carries = state.letters.filter(function (l) {
      return l.inChargeId === id && l.status === 'Routing';
    }).length;
    return { tasks: assigned, events: heads, letters: carries,
             total: assigned + heads + carries };
  }

  /* Removing a person, as opposed to deactivating one.

     Deactivating is right for an officer whose term ended: their name stays on
     the work they did, which is the whole point of a record. Removing is for a
     name that should never have been in the list — a typo, a duplicate, someone
     added to the wrong unit. Both are needed, and only the person doing it can
     tell which case this is.

     Whatever they held is released rather than deleted with them. A task
     survives losing its assignee; deleting the task because the person left
     would destroy the council's own record of the work. */
  /* Duplicates, and getting rid of them without anybody clicking Remove sixty
     times.

     They came from syncing the dry run. Each device seeds its own rehearsal with
     its own ids, so a second phone pulled the first one's thirteen invented
     officers, kept its own thirteen, and pushed them back — and every device
     after that made it worse. That no longer happens, but a council that has
     already synced is left holding the mess, and telling them to tidy it by hand
     is not an answer.

     Two people are the same person when the name and the unit match. Whoever was
     recorded first is kept, because that is the row other devices are most
     likely to agree on, and everything pointing at the others is moved onto it
     rather than deleted with them. */
  function duplicatePeople() {
    var groups = {};
    state.people.forEach(function (p) {
      var key = String(p.name || '').trim().toLowerCase() + '|' + (p.unitId || '');
      (groups[key] = groups[key] || []).push(p);
    });
    var dupes = [];
    Object.keys(groups).forEach(function (k) {
      if (groups[k].length > 1) dupes.push(groups[k]);
    });
    return dupes;
  }

  function duplicatePeopleCount() {
    return duplicatePeople().reduce(function (n, g) { return n + g.length - 1; }, 0);
  }

  function mergeDuplicatePeople() {
    var removed = 0;
    var dropped = {};

    duplicatePeople().forEach(function (group) {
      // Oldest first; the one the rest are folded into.
      group.sort(function (a, b) { return String(a.createdAt).localeCompare(String(b.createdAt)); });
      var keep = group[0];

      group.slice(1).forEach(function (drop) {
        state.tasks.forEach(function (t) {
          if (t.assigneeId === drop.id) { t.assigneeId = keep.id; t.updatedAt = bumpStamp(t.updatedAt); }
        });
        state.events.forEach(function (e) {
          if (e.headId === drop.id) { e.headId = keep.id; e.updatedAt = bumpStamp(e.updatedAt); }
        });
        state.letters.forEach(function (l) {
          if (l.inChargeId === drop.id) { l.inChargeId = keep.id; l.updatedAt = bumpStamp(l.updatedAt); }
        });
        // The activities they were taken on for belong to the person, not the row.
        (drop.eventIds || []).forEach(function (evId) {
          if ((keep.eventIds || []).indexOf(evId) < 0) keep.eventIds.push(evId);
        });
        // A duplicate that somebody had deactivated should not deactivate the keeper.
        if (drop.active !== false) keep.active = true;
        if (!keep.email && drop.email) keep.email = drop.email;

        tombstone('person', drop.id);
        dropped[drop.id] = true;
        removed++;
      });

      keep.updatedAt = bumpStamp(keep.updatedAt);
    });

    if (removed) {
      /* Only the rows this merge folded away. Reading the tombstone list instead
         would also take out anybody removed earlier for an unrelated reason. */
      state.people = state.people.filter(function (p) { return !dropped[p.id]; });
      commit();
    }
    return removed;
  }

  function deletePerson(id) {
    var p = person(id);
    if (!p) return false;

    state.tasks.forEach(function (t) {
      if (t.assigneeId === id) { t.assigneeId = ''; t.updatedAt = bumpStamp(t.updatedAt); }
    });
    state.events.forEach(function (e) {
      if (e.headId === id) { e.headId = ''; e.updatedAt = bumpStamp(e.updatedAt); }
    });
    state.letters.forEach(function (l) {
      if (l.inChargeId !== id) return;
      // The name is kept as typed text so the trail still says who was carrying it.
      l.inChargeId = '';
      if (!l.inChargeName) l.inChargeName = p.name;
      l.updatedAt = bumpStamp(l.updatedAt);
    });

    tombstone('person', id);
    state.people = state.people.filter(function (x) { return x.id !== id; });
    // The assignee picker remembers whoever was chosen last; it must not
    // remember somebody who is no longer in the directory.
    if (lastPerson() === id) setLastPerson('');
    commit();
    return true;
  }

  /* ---------- units ---------- */

  function units(opts) {
    opts = opts || {};
    var list = state.units.slice();
    if (opts.activeOnly) list = list.filter(function (u) { return u.active !== false; });
    if (opts.kind) list = list.filter(function (u) { return u.kind === opts.kind; });
    // The National government's own view: itself and the provinces, never the
    // independent bodies.
    if (opts.governed) list = list.filter(function (u) { return !isIndependent(u); });
    if (opts.independentOnly) list = list.filter(isIndependent);
    // National first, then the provinces alphabetically, then COMELEC and the
    // Judiciary — the order the Republic is usually written down in.
    return list.sort(function (a, b) {
      var d = UNIT_KIND_RANK[a.kind] - UNIT_KIND_RANK[b.kind];
      return d !== 0 ? d : a.name.localeCompare(b.name);
    });
  }

  function unit(id) {
    if (!id) return null;
    for (var i = 0; i < state.units.length; i++) if (state.units[i].id === id) return state.units[i];
    return null;
  }

  function unitName(id) {
    var u = unit(id);
    return u ? u.name : 'Unassigned unit';
  }

  function unitKindLabel(kind) { return UNIT_KIND_LABEL[kind] || 'Province'; }

  function nationalUnit() {
    for (var i = 0; i < state.units.length; i++) {
      if (state.units[i].kind === 'national') return state.units[i];
    }
    return state.units[0] || null;
  }

  function nationalUnitId() {
    var u = nationalUnit();
    return u ? u.id : '';
  }

  function addUnit(data) {
    var u = cleanUnit({
      id: U.uid('unt'),
      kind: data.kind, code: data.code, name: data.name,
      trackerName: data.trackerName, active: true,
      createdAt: nowISO(), updatedAt: nowISO()
    });
    if (!u) throw new Error('A unit needs a name.');
    // Only one National government, by definition.
    if (u.kind === 'national' && nationalUnit()) u.kind = 'province';
    state.units.push(u);
    commit();
    return u;
  }

  function updateUnit(id, data) {
    var u = unit(id);
    if (!u) return null;
    if ('name' in data) u.name = str(data.name, LIMITS.org) || u.name;
    if ('trackerName' in data) u.trackerName = str(data.trackerName, LIMITS.org);
    if ('code' in data) u.code = str(data.code, 16).toUpperCase().replace(/[^A-Z0-9-]/g, '');
    // The National unit's kind is never edited away, or council-wide work would
    // have nowhere to sit.
    if ('kind' in data && u.kind !== 'national' && UNIT_KINDS.indexOf(data.kind) >= 0 &&
        data.kind !== 'national') {
      u.kind = data.kind;
    }
    if ('active' in data && u.kind !== 'national') u.active = !!data.active;
    u.updatedAt = bumpStamp(u.updatedAt);
    commit();
    return u;
  }

  function setUnitActive(id, active) { return updateUnit(id, { active: active }); }

  /* A unit is only ever removed while it is empty. Once it holds events it is
     deactivated instead, so past work keeps the unit it was filed under. */
  function unitEventCount(id) {
    return state.events.filter(function (e) { return e.unitId === id; }).length;
  }

  function deleteUnit(id) {
    var u = unit(id);
    if (!u) return false;
    if (u.kind === 'national') throw new Error('The National government cannot be removed.');
    if (unitEventCount(id)) {
      throw new Error('That unit still holds events. Set it inactive instead, so its work keeps its unit.');
    }
    state.units = state.units.filter(function (x) { return x.id !== id; });
    commit();
    return true;
  }

  /* How a unit is doing: its events, and the work inside them. Archived events
     are left out, the same way they are everywhere else. */
  function unitStats(unitId) {
    var evs = state.events.filter(function (e) {
      return e.unitId === unitId && e.status !== 'Archived';
    });
    var ids = {};
    evs.forEach(function (e) { ids[e.id] = true; });
    var s = stats(state.tasks.filter(function (t) {
      return (t.kind || 'event') === 'event' && ids[t.eventId];
    }));
    s.events = evs.length;
    s.running = evs.filter(function (e) {
      return e.status === 'Upcoming' || e.status === 'Ongoing';
    }).length;
    return s;
  }

  /* ---------- events ---------- */

  function events(opts) {
    opts = opts || {};
    var list = state.events.slice();
    if (opts.unitId) list = list.filter(function (e) { return e.unitId === opts.unitId; });
    if (opts.excludeArchived) list = list.filter(function (e) { return e.status !== 'Archived'; });
    if (opts.activeOnly) {
      list = list.filter(function (e) { return e.status === 'Upcoming' || e.status === 'Ongoing'; });
    }
    return list.sort(function (a, b) {
      var ad = a.dateStart || '9999-12-31', bd = b.dateStart || '9999-12-31';
      if (ad !== bd) return ad < bd ? -1 : 1;
      return a.title.localeCompare(b.title);
    });
  }

  function event(id) {
    if (!id) return null;
    for (var i = 0; i < state.events.length; i++) if (state.events[i].id === id) return state.events[i];
    return null;
  }

  function addEvent(data) {
    var e = {
      id: U.uid('evt'),
      // Unstated means the council's own: National work.
      unitId: unit(data.unitId) ? data.unitId : nationalUnitId(),
      title: (data.title || '').trim(),
      description: (data.description || '').trim(),
      dateStart: data.dateStart || '',
      dateEnd: data.dateEnd || '',
      venue: (data.venue || '').trim(),
      headId: data.headId || '',
      status: EVENT_STATUSES.indexOf(data.status) >= 0 ? data.status : 'Upcoming',
      feedbackRequired: data.feedbackRequired !== false,
      feedbackLink: data.feedbackLink || '',
      createdAt: nowISO(),
      updatedAt: nowISO()
    };
    state.events.push(e);
    commit();
    return e;
  }

  function updateEvent(id, data) {
    var e = event(id);
    if (!e) return null;
    ['title', 'description', 'venue'].forEach(function (k) {
      if (k in data) e[k] = (data[k] || '').trim();
    });
    ['dateStart', 'dateEnd', 'headId'].forEach(function (k) {
      if (k in data) e[k] = data[k] || '';
    });
    if ('status' in data && EVENT_STATUSES.indexOf(data.status) >= 0) e.status = data.status;
    if ('unitId' in data && unit(data.unitId)) e.unitId = data.unitId;
    if ('feedbackLink' in data) e.feedbackLink = formLink(data.feedbackLink);
    e.updatedAt = bumpStamp(e.updatedAt);
    commit();
    return e;
  }

  /* Whether this activity still owes a feedback form. Derived, never stored, so
     it cannot drift from the link and the waiver. */
  function needsFeedback(e) {
    if (!e) return false;
    return e.feedbackRequired !== false && !e.feedbackLink;
  }

  function setFeedbackLink(id, link) {
    var e = event(id);
    if (!e) return null;
    var v = formLink(link);
    if (link && !v) {
      throw new Error('That needs to be a Google Forms link — docs.google.com/forms or forms.gle.');
    }
    e.feedbackLink = v;
    e.updatedAt = bumpStamp(e.updatedAt);
    commit();
    return e;
  }

  /* Waiving the requirement. The standard is that every activity is evaluated,
     so stepping outside it is written down rather than silently toggled. */
  function waiveFeedback(id, reason, by) {
    var e = event(id);
    if (!e) return null;
    var r = (reason || '').trim();
    if (r.length < 10) {
      throw new Error('Write down why this activity does not need a feedback form.');
    }
    e.feedbackRequired = false;
    e.feedbackWaivedReason = str(r, LIMITS.reason);
    e.feedbackWaivedBy = str(by || '', LIMITS.name);
    e.feedbackWaivedAt = nowISO();
    e.updatedAt = bumpStamp(e.updatedAt);
    commit();
    return e;
  }

  function restoreFeedback(id) {
    var e = event(id);
    if (!e) return null;
    e.feedbackRequired = true;
    e.feedbackWaivedReason = '';
    e.feedbackWaivedBy = '';
    e.feedbackWaivedAt = '';
    e.updatedAt = bumpStamp(e.updatedAt);
    commit();
    return e;
  }

  function deleteEvent(id) {
    state.tasks.forEach(function (t) { if (t.eventId === id) tombstone('task', t.id); });

    /* The report was marked deleted and then left sitting in state, so it
       lingered until the next page load tidied it away — and its photographs
       were never freed at all. A term's worth of deleted activities leaves
       hundreds of megabytes stranded in a phone's storage with nothing on any
       screen to say so. */
    var doomed = state.reports.filter(function (r) { return r.eventId === id; });
    doomed.forEach(function (r) { tombstone('report', r.id); });
    state.reports = state.reports.filter(function (r) { return r.eventId !== id; });

    state.tasks = state.tasks.filter(function (t) { return t.eventId !== id; });
    tombstone('event', id);
    state.events = state.events.filter(function (e) { return e.id !== id; });
    commit();

    if (global.AssetDB) {
      doomed.forEach(function (r) { global.AssetDB.delPrefix(r.id + ':'); });
    }
  }

  /* ---------- tasks ---------- */

  function tasks(filter) {
    filter = filter || {};
    var list = state.tasks.slice();
    if (filter.eventId) list = list.filter(function (t) { return t.eventId === filter.eventId; });
    if (filter.unitId) {
      list = list.filter(function (t) {
        var e = event(t.eventId);
        return !!e && e.unitId === filter.unitId;
      });
    }
    if (filter.kind) list = list.filter(function (t) { return (t.kind || 'event') === filter.kind; });
    if (filter.assigneeId !== undefined) {
      list = list.filter(function (t) { return (t.assigneeId || '') === (filter.assigneeId || ''); });
    }
    if (filter.status) list = list.filter(function (t) { return t.status === filter.status; });
    if (filter.pendingOnly) list = list.filter(function (t) { return t.status !== 'Done'; });
    if (filter.overdueOnly) list = list.filter(isOverdue);
    if (filter.excludeArchived) {
      list = list.filter(function (t) {
        if ((t.kind || 'event') === 'directive') return true;
        var e = event(t.eventId);
        return e && e.status !== 'Archived';
      });
    }
    return list;
  }

  function task(id) {
    if (!id) return null;
    for (var i = 0; i < state.tasks.length; i++) if (state.tasks[i].id === id) return state.tasks[i];
    return null;
  }

  function addTask(data) {
    // A directive is council business that belongs to no activity — a standing
    // instruction. Everything else still has to sit inside an event.
    var isDirective = data.kind === 'directive';
    if (!isDirective && (!data.eventId || !event(data.eventId))) {
      throw new Error('A task must belong to an event.');
    }
    var t = {
      id: U.uid('tsk'),
      kind: isDirective ? 'directive' : 'event',
      eventId: isDirective ? '' : data.eventId,
      /* A directive has no activity, so it has nothing to be scoped by unless it
         carries a unit of its own. Everything else reads its unit through the
         activity it sits in, and keeps doing so. */
      unitId: isDirective
        ? (data.unitId || (global.Auth && Auth.signedIn() && Auth.myUnitId()) || nationalUnitId())
        : '',
      title: (data.title || '').trim(),
      remarks: (data.remarks || '').trim(),
      assigneeId: data.assigneeId || '',
      dueDate: data.dueDate || '',
      priority: PRIORITIES.indexOf(data.priority) >= 0 ? data.priority : 'Medium',
      status: STATUSES.indexOf(data.status) >= 0 ? data.status : 'Not Started',
      blockedReason: (data.blockedReason || '').trim(),
      completedAt: '',
      createdAt: nowISO(),
      updatedAt: nowISO()
    };
    if (t.status === 'Done') t.completedAt = nowISO();
    state.tasks.push(t);
    commit();
    return t;
  }

  function updateTask(id, data) {
    var t = task(id);
    if (!t) return null;
    ['title', 'remarks', 'blockedReason'].forEach(function (k) {
      if (k in data) t[k] = (data[k] || '').trim();
    });
    if ('assigneeId' in data) t.assigneeId = data.assigneeId || '';
    if ('dueDate' in data) t.dueDate = data.dueDate || '';
    if ('eventId' in data && event(data.eventId)) t.eventId = data.eventId;
    if ('priority' in data && PRIORITIES.indexOf(data.priority) >= 0) t.priority = data.priority;
    if ('status' in data && STATUSES.indexOf(data.status) >= 0) applyStatus(t, data.status);
    if (t.status !== 'On hold') t.blockedReason = '';
    t.updatedAt = bumpStamp(t.updatedAt);
    commit();
    return t;
  }

  // completedAt is stamped the moment a task becomes Done, and cleared if it reopens.
  function applyStatus(t, status) {
    if (status === 'Done' && t.status !== 'Done') t.completedAt = nowISO();
    if (status !== 'Done') t.completedAt = '';
    t.status = status;
  }

  function setTaskStatus(id, status, blockedReason) {
    var patch = { status: status };
    if (status === 'On hold') patch.blockedReason = blockedReason || '';
    return updateTask(id, patch);
  }

  function deleteTask(id) {
    tombstone('task', id);
    state.tasks = state.tasks.filter(function (t) { return t.id !== id; });
    commit();
  }

  /* ---------- derived (never stored) ---------- */

  function isOverdue(t) {
    return !!t.dueDate && t.status !== 'Done' && t.dueDate < U.today();
  }

  function isPending(t) { return t.status !== 'Done'; }

  function isDueToday(t) { return !!t.dueDate && t.status !== 'Done' && t.dueDate === U.today(); }

  function isDueThisWeek(t) {
    return !!t.dueDate && t.status !== 'Done' && U.isWithin(t.dueDate, U.today(), U.endOfWeek());
  }

  function stats(list) {
    var s = { total: list.length, done: 0, pending: 0, overdue: 0, dueThisWeek: 0,
              blocked: 0, unassigned: 0 };
    list.forEach(function (t) {
      if (t.status === 'Done') s.done++; else s.pending++;
      if (isOverdue(t)) s.overdue++;
      if (isDueThisWeek(t)) s.dueThisWeek++;
      if (t.status === 'On hold') s.blocked++;
      /* Work nobody has taken. Finished work does not count: a task that got
         done without ever being assigned needs nobody now, and counting it
         would send an officer looking for a problem that has already gone. */
      if (!t.assigneeId && t.status !== 'Done') s.unassigned++;
    });
    s.percent = U.pct(s.done, s.total);
    return s;
  }

  function eventStats(eventId) { return stats(tasks({ eventId: eventId })); }

  // Sort helpers used by every list in the app. Soonest deadline first is the default.
  var PRIORITY_RANK = { High: 0, Medium: 1, Low: 2 };
  var STATUS_RANK = { 'On hold': 0, 'In Progress': 1, 'For Review': 2, 'Not Started': 3, Done: 4 };

  function byDueDate(a, b) {
    var ad = a.dueDate || '9999-12-31', bd = b.dueDate || '9999-12-31';
    if (ad !== bd) return ad < bd ? -1 : 1;
    return (PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]) || a.title.localeCompare(b.title);
  }

  function byPriority(a, b) {
    var d = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    return d !== 0 ? d : byDueDate(a, b);
  }

  function byStatus(a, b) {
    var d = STATUS_RANK[a.status] - STATUS_RANK[b.status];
    return d !== 0 ? d : byDueDate(a, b);
  }

  // Pending work floats above completed work, then soonest deadline.
  function byUrgency(a, b) {
    var ad = a.status === 'Done' ? 1 : 0, bd = b.status === 'Done' ? 1 : 0;
    if (ad !== bd) return ad - bd;
    return byDueDate(a, b);
  }

  /* ---------- remembered person (per device, not part of the data) ---------- */

  function lastPerson() {
    try { return global.localStorage.getItem(PERSON_KEY) || ''; } catch (e) { return ''; }
  }

  function setLastPerson(id) {
    try {
      if (id) global.localStorage.setItem(PERSON_KEY, id);
      else global.localStorage.removeItem(PERSON_KEY);
    } catch (e) { /* storage blocked — the picker still works for this visit */ }
  }

  /* ---------- positions & committees ---------- */

  function addListValue(kind, value) {
    var v = (value || '').trim();
    if (!v) return false;
    var list = state[kind];
    if (list.some(function (x) { return x.toLowerCase() === v.toLowerCase(); })) return false;
    list.push(v);
    list.sort(function (a, b) { return a.localeCompare(b); });
    touchCouncil();
    commit();
    return true;
  }

  function removeListValue(kind, value) {
    state[kind] = state[kind].filter(function (x) { return x !== value; });
    touchCouncil();
    commit();
  }

  /* ---------- accomplishment reports ---------- */

  function report(eventId) {
    for (var i = 0; i < state.reports.length; i++) {
      if (state.reports[i].eventId === eventId) return state.reports[i];
    }
    return null;
  }

  /* The report's id is the activity's id.

     There is one report per activity — the server holds reports.event_id
     unique — but the id used to be minted at random, so two officers opening
     the wizard for the same activity before either had synced produced two
     reports with different ids and the same activity. The second to reach the
     server was refused, and that phone then failed every round afterwards.

     Deriving the id from the activity means both devices produce the same one,
     so the two become one record on arrival instead of a collision. */
  function blankReport(eventId) {
    return {
      id: eventId, eventId: eventId, description: '',
      program: { assets: [] }, photos: [], letters: [],
      minutes: { mode: 'tasks', assets: [] }, evaluation: { assets: [] },
      liquidation: { assets: [] },
      signatories: {
        preparedBy: { name: '', position: '' },
        president: { name: '', show: true },
        adviser: { name: '' }
      },
      driveLink: '', driveOwned: false, driveBy: '', driveAt: '',
      status: 'draft',
      createdAt: nowISO(), updatedAt: nowISO()
    };
  }

  function saveReport(eventId, patch) {
    if (!event(eventId)) throw new Error('That event no longer exists.');
    var r = report(eventId);
    if (!r) { r = blankReport(eventId); state.reports.push(r); }
    Object.keys(patch || {}).forEach(function (k) {
      if (k === 'id' || k === 'eventId' || k === 'createdAt') return;
      r[k] = patch[k];
    });
    r.updatedAt = bumpStamp(r.updatedAt);
    // Run it back through the sanitiser so nothing malformed can settle in state.
    var idx = state.reports.indexOf(r);
    state.reports[idx] = cleanReport(r);
    commit();
    return state.reports[idx];
  }

  function deleteReport(eventId) {
    var r = report(eventId);
    if (r) tombstone('report', r.id);
    state.reports = state.reports.filter(function (x) { return x.eventId !== eventId; });
    commit();
    if (r && global.AssetDB) global.AssetDB.delPrefix(r.id + ':');
  }

  function reports() { return state.reports.slice(); }

  /* ---------- offices and letters ----------

     A letters tracker, not a letter store. No document is ever kept here: the
     paper is the paper. What a council actually loses is not the letter, it is
     the answer to "where is it now, and who has it" — so that is all this holds.

     "Received by" is typed in by whoever handed the letter over, because the
     clerk in the Dean's office is never going to sign in to this. It is a
     logbook kept honestly, not a signature, and it is worth saying plainly so
     nobody mistakes one for the other. */

  var OFFICE_SEED_VERSION = 3;

  /* A starting list, editable in Settings. Turnaround is how long that office
     usually takes; a letter sitting longer than that is called stuck, which is
     the difference between a record and something that tells you to go and
     chase it. */
  var DEFAULT_OFFICES = [
    // The council's own signatories come first: a letter is signed inside the
    // Republic before it is sent anywhere in the University.
    ['AUTH', 'The author / Senator / Governor',    1],
    ['GOV',  'Governor / FCUSR President',         2],
    ['PRES', 'FCUSR President',                    2],
    ['ADV',  'Adviser (JHS, SHS, National)',       2],
    ['DEAN', 'Dean/Principal',                     3],
    ['OSA',  'OSA, Director',                      3],
    ['BUD',  'Budget Officer / Accountant / Business Manager', 3],
    ['VPAA', 'VP for Academic Affairs',            5],
    ['VPF',  'VP for Finance',                     5],
    ['OP',   'University President',               7],
    // Not on any of the three standard routes, but real desks a letter reaches.
    ['GUID', 'Guidance Office',                    3],
    ['PPO',  'Physical Plant Office',              3],
    ['REG',  'Office of the Registrar',            3],
    ['CM',   'Campus Ministry',                    3],
    ['SEC',  'Security Office',                    2]
  ];

  /* Every letter the council sends out is signed by the FCUSR President. It is
     not one office among the others, so the app knows which one it is. */
  var PRESIDENT_CODE = 'PRES';

  /* The three routes the council actually uses, copied from the FCUSR's own
     briefing, in the order the signatures are collected. Offered when a letter
     is created so nobody types ten offices out again — and so a letter that
     skips a desk is a decision somebody made rather than something forgotten.

     The route can still be changed afterwards: these are the common cases, not
     the only ones. */
  var ROUTE_TEMPLATES = [
    {
      name: 'Collection of money or request for budget',
      codes: ['AUTH', 'GOV', 'PRES', 'ADV', 'DEAN', 'OSA', 'BUD', 'VPAA', 'VPF', 'OP']
    },
    {
      name: 'Permission to attend a conference or seminar',
      codes: ['AUTH', 'GOV', 'PRES', 'ADV', 'DEAN', 'OSA', 'BUD', 'VPAA', 'VPF', 'OP'],
      note: 'Attach the invitation letter.'
    },
    {
      name: 'Excusing students from their classes',
      codes: ['AUTH', 'GOV', 'PRES', 'ADV', 'DEAN', 'OSA', 'VPAA']
    },
    {
      name: 'Something else — start with the council',
      codes: ['AUTH', 'GOV', 'PRES'],
      note: 'Add the University offices this particular letter has to reach.'
    }
  ];

  var LETTER_STATUSES = ['Routing', 'Approved', 'Declined', 'Withdrawn'];
  var STOP_OUTCOMES = ['Approved', 'Noted', 'Returned for revision'];

  function seedOffices() {
    return DEFAULT_OFFICES.map(function (o) {
      return {
        id: 'office-' + o[0].toLowerCase(),
        code: o[0], name: o[1], turnaroundDays: o[2], active: true,
        /* The name this office was seeded with. If it still matches, nobody has
           renamed it and a correction to the council's own wording can be
           applied; if it does not, the name on screen is somebody's decision
           and is left alone. */
        seededName: o[1],
        createdAt: SEEDED_AT, updatedAt: SEEDED_AT
      };
    });
  }

  function cleanOffice(o) {
    if (!o || typeof o !== 'object') return null;
    var name = str(o.name, LIMITS.org);
    if (!name) return null;
    var days = Number(o.turnaroundDays);
    return {
      id: id(o.id, 'off'),
      code: str(o.code, 16).toUpperCase().replace(/[^A-Z0-9-]/g, ''),
      name: name,
      seededName: str(o.seededName, LIMITS.org),
      turnaroundDays: isFinite(days) && days > 0 && days < 400 ? Math.round(days) : 3,
      active: o.active !== false,
      createdAt: stamp(o.createdAt),
      updatedAt: stamp(o.updatedAt)
    };
  }

  /* A signatory is an office wherever there is one, because an office outlives
     whoever is sitting in it — "the Dean" is still right next year. Some
     signatures belong to no office at all, though: the senator who wrote the
     letter, an accountant standing in, a person named on this letter only. So a
     stop is an office id or, failing that, a typed name, and never neither. */
  function cleanStop(st) {
    if (!st || typeof st !== 'object') return null;
    var officeId = typeof st.officeId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(st.officeId)
      ? st.officeId : '';
    var label = str(st.label, LIMITS.name);
    if (!officeId && !label) return null;
    return {
      id: id(st.id, 'stp'),
      officeId: officeId,
      label: label,
      // Who walked it over, and who took it in. Both are names, not accounts.
      forwardedBy: str(st.forwardedBy, LIMITS.name),
      receivedBy: str(st.receivedBy, LIMITS.name),
      receivedAt: dateOnly(st.receivedAt),
      releasedAt: dateOnly(st.releasedAt),
      outcome: oneOf(st.outcome, STOP_OUTCOMES, ''),
      note: str(st.note, LIMITS.reason)
    };
  }

  function cleanLetter(l) {
    if (!l || typeof l !== 'object') return null;
    var subject = str(l.subject, LIMITS.title);
    if (!subject) return null;
    return {
      id: id(l.id, 'ltr'),
      unitId: typeof l.unitId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(l.unitId) ? l.unitId : '',
      /* Blank means council business that belongs to no activity, exactly the
         way a directive has no event. */
      eventId: typeof l.eventId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(l.eventId) ? l.eventId : '',
      subject: subject,
      /* Whoever is walking it round. Usually someone in the directory, but not
         always — so a typed name is allowed and kept beside the id. */
      inChargeId: typeof l.inChargeId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(l.inChargeId)
        ? l.inChargeId : '',
      inChargeName: str(l.inChargeName, LIMITS.name),
      deadline: dateOnly(l.deadline),
      status: oneOf(l.status, LETTER_STATUSES, 'Routing'),
      /* Set only when somebody answered, in as many words, that this letter
         never leaves the council — which is the one reason the President's
         signature may be missing from it. */
      internal: !!l.internal,
      stops: (Array.isArray(l.stops) ? l.stops : []).map(cleanStop).filter(Boolean).slice(0, 30),
      sample: !!l.sample,
      createdAt: stamp(l.createdAt),
      updatedAt: stamp(l.updatedAt)
    };
  }

  /* ---------- offices ---------- */

  function offices(opts) {
    opts = opts || {};
    var list = state.offices.slice();
    if (opts.activeOnly) list = list.filter(function (o) { return o.active !== false; });
    return list.sort(function (a, b) { return a.name.localeCompare(b.name); });
  }

  function office(oid) {
    if (!oid) return null;
    for (var i = 0; i < state.offices.length; i++) if (state.offices[i].id === oid) return state.offices[i];
    return null;
  }

  function officeName(oid) {
    var o = office(oid);
    return o ? o.name : 'Unknown office';
  }

  /* A code is what the route templates match on, so one is derived when the
     caller has not given one — otherwise every office added from the letters
     screen would share the empty code and the templates would match the wrong
     desk. Uniqueness matters more than prettiness here. */
  /* A code nothing else will have, including on somebody else's phone.

     It used to count up from the name until it found a gap in *this* device's
     list — so two officers each adding "Office of the Chaplain" both produced
     CHAPLA, under different ids. The server holds office codes unique, so the
     second one to sync was refused, and that device then failed the same way
     every round until somebody renamed the office. Nothing on screen would have
     said which office, or why.

     Seeded offices keep their fixed codes, because the route templates and the
     reconciliation both match on them. Anything typed in gets four random
     characters after the name, which no second device is going to hit. */
  function deriveCode(name) {
    var base = String(name || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    if (!base) base = 'OFF';
    var tail = '';
    for (var i = 0; i < 4; i++) {
      tail += 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)];
    }
    return (base.slice(0, 6) + '-' + tail).slice(0, 16);
  }

  function addOffice(data) {
    var o = cleanOffice({
      id: U.uid('off'), code: data.code || deriveCode(data.name), name: data.name,
      turnaroundDays: data.turnaroundDays, active: true,
      createdAt: nowISO(), updatedAt: nowISO()
    });
    if (!o) throw new Error('An office needs a name.');
    state.offices.push(o);
    commit();
    return o;
  }

  function updateOffice(oid, data) {
    var o = office(oid);
    if (!o) return null;
    if ('name' in data) o.name = str(data.name, LIMITS.org) || o.name;
    if ('code' in data) o.code = str(data.code, 16).toUpperCase().replace(/[^A-Z0-9-]/g, '');
    if ('turnaroundDays' in data) {
      var d = Number(data.turnaroundDays);
      if (isFinite(d) && d > 0 && d < 400) o.turnaroundDays = Math.round(d);
    }
    if ('active' in data) o.active = !!data.active;
    o.updatedAt = bumpStamp(o.updatedAt);
    commit();
    return o;
  }

  function setOfficeActive(oid, active) { return updateOffice(oid, { active: active }); }

  function officeLetterCount(oid) {
    return state.letters.filter(function (l) {
      return l.stops.some(function (s) { return s.officeId === oid; });
    }).length;
  }

  /* An office letters have passed through is deactivated, never deleted, so an
     old trail still names where the letter actually went. */
  function deleteOffice(oid) {
    if (officeLetterCount(oid)) {
      throw new Error('Letters have passed through that office. Set it inactive instead, ' +
        'so their trail still reads correctly.');
    }
    tombstone('office', oid);
    state.offices = state.offices.filter(function (o) { return o.id !== oid; });
    commit();
    return true;
  }

  function officeByCode(code) {
    for (var i = 0; i < state.offices.length; i++) {
      if (state.offices[i].code === code && state.offices[i].active !== false) return state.offices[i];
    }
    return null;
  }

  /* Which office is the President's. Returns '' if somebody has deleted or
     deactivated it, in which case the app cannot insist on a signature from a
     desk that no longer exists. */
  function presidentOfficeId() {
    var o = officeByCode(PRESIDENT_CODE);
    return o ? o.id : '';
  }

  function routeTemplates() {
    return ROUTE_TEMPLATES.map(function (t) {
      return {
        name: t.name,
        note: t.note || '',
        officeIds: t.codes.map(function (code) {
          var match = officeByCode(code);
          return match ? match.id : '';
        }).filter(Boolean)
      };
    }).filter(function (t) { return t.officeIds.length; });
  }

  /* ---------- letters ---------- */

  function letters(filter) {
    filter = filter || {};
    var list = state.letters.slice();
    if (filter.unitId) list = list.filter(function (l) { return l.unitId === filter.unitId; });
    if (filter.eventId) list = list.filter(function (l) { return l.eventId === filter.eventId; });
    if (filter.status) list = list.filter(function (l) { return l.status === filter.status; });
    if (filter.openOnly) list = list.filter(function (l) { return l.status === 'Routing'; });
    if (filter.attentionOnly) list = list.filter(letterNeedsAttention);
    return list.sort(byLetterUrgency);
  }

  function letter(lid) {
    if (!lid) return null;
    for (var i = 0; i < state.letters.length; i++) if (state.letters[i].id === lid) return state.letters[i];
    return null;
  }

  /* What to call a stop, wherever one is shown. */
  function stopName(st) {
    if (!st) return '';
    if (st.officeId) {
      var o = office(st.officeId);
      if (o) return o.name;
    }
    return st.label || 'Office';
  }

  /* How long this desk usually takes. A named person has no turnaround on
     record, so they get the same three days an unknown office would. */
  function stopTurnaround(st) {
    var o = st && st.officeId ? office(st.officeId) : null;
    return o ? o.turnaroundDays : 3;
  }

  /* Two stops are the same desk when they are the same office, or — for a
     person — the same name. Used to tell a second run at a desk from a new one. */
  function sameDesk(a, b) {
    if (!a || !b) return false;
    if (a.officeId || b.officeId) return a.officeId === b.officeId;
    return !!a.label && a.label === b.label;
  }

  function letterInCharge(l) {
    if (!l) return 'Unassigned';
    var p = person(l.inChargeId);
    return p ? p.name : (l.inChargeName || 'Unassigned');
  }

  /* A fresh attempt at the same desk, after that desk sent the letter back. */
  function respawn(st) {
    var fresh = newStop(st.officeId);
    fresh.label = st.label;
    return fresh;
  }

  function newStop(oid) {
    return {
      id: U.uid('stp'), officeId: oid, label: '', forwardedBy: '', receivedBy: '',
      receivedAt: '', releasedAt: '', outcome: '', note: ''
    };
  }

  /* A route arrives either as `route` — entries that may name an office or a
     person — or as plain `officeIds`, which is the same thing said the shorter
     way when every signatory is an office. */
  function toEntries(data) {
    if (Array.isArray(data.route)) return data.route;
    return (data.officeIds || []).map(function (oid) { return { officeId: oid }; });
  }

  function entryStop(e) {
    if (!e) return null;
    if (typeof e === 'string') e = { officeId: e };
    var oid = e.officeId && office(e.officeId) ? e.officeId : '';
    var label = str(e.label, LIMITS.name);
    if (!oid && !label) return null;
    var st = newStop(oid);
    st.label = label;
    return st;
  }

  function addLetter(data) {
    var stops = toEntries(data).map(entryStop).filter(Boolean);
    if (!stops.length) throw new Error('Choose at least one office or person to sign it.');

    var l = cleanLetter({
      id: U.uid('ltr'),
      unitId: unit(data.unitId) ? data.unitId : nationalUnitId(),
      eventId: data.eventId && event(data.eventId) ? data.eventId : '',
      subject: data.subject,
      inChargeId: data.inChargeId, inChargeName: data.inChargeName,
      deadline: data.deadline, status: 'Routing', stops: stops,
      internal: !!data.internal,
      createdAt: nowISO(), updatedAt: nowISO()
    });
    if (!l) throw new Error('Give the letter a subject.');
    state.letters.push(l);
    commit();
    return l;
  }

  function updateLetter(lid, data) {
    var l = letter(lid);
    if (!l) return null;
    if ('subject' in data) l.subject = str(data.subject, LIMITS.title) || l.subject;
    if ('eventId' in data) l.eventId = data.eventId && event(data.eventId) ? data.eventId : '';
    if ('inChargeId' in data) l.inChargeId = person(data.inChargeId) ? data.inChargeId : '';
    if ('inChargeName' in data) l.inChargeName = str(data.inChargeName, LIMITS.name);
    if ('deadline' in data) l.deadline = dateOnly(data.deadline);
    if ('status' in data && LETTER_STATUSES.indexOf(data.status) >= 0) l.status = data.status;
    if ('internal' in data) l.internal = !!data.internal;
    if (Array.isArray(data.route) || Array.isArray(data.officeIds)) setRoute(l, toEntries(data));
    l.updatedAt = bumpStamp(l.updatedAt);
    commit();
    return l;
  }

  /* An office that has the letter in front of it can refuse to sign until
     somebody else has signed first. That happens constantly, and until now the
     only way to record it was to edit the whole route — which is the one thing
     you cannot do calmly while standing at a counter. So: put a desk in at a
     named place, without disturbing anything already signed.

     `before` is the index to insert at. Anything already received or released
     is history and cannot be pushed aside, so the insertion point is clamped
     past it. */
  function insertStop(lid, entry, before) {
    var l = letter(lid);
    if (!l) return null;
    var st = entryStop(entry);
    if (!st) throw new Error('Choose an office, or type who has to sign.');
    if (l.stops.length >= 30) throw new Error('That letter already has thirty signatories on it.');

    var settled = l.stops.filter(function (s) { return s.receivedAt || s.releasedAt; }).length;
    var at = Math.max(settled, Math.min(Number(before), l.stops.length));
    if (!isFinite(at)) at = l.stops.length;

    l.stops.splice(at, 0, st);
    l.updatedAt = bumpStamp(l.updatedAt);
    commit();
    return l;
  }

  /* Changing the route keeps whatever has already happened. A stop an office has
     already taken the letter in at stays exactly as recorded, and only the ones
     not yet reached are rearranged — history is not editable by reordering. */
  function setRoute(l, entries) {
    var kept = l.stops.filter(function (s) { return s.receivedAt || s.releasedAt; });
    var fresh = entries.map(entryStop).filter(Boolean).filter(function (st) {
      return !kept.some(function (k) { return sameDesk(k, st); });
    }).map(function (st) {
      // Reuse the entry already standing for that desk, so its id survives.
      var existing = l.stops.filter(function (s) {
        return sameDesk(s, st) && !s.receivedAt && !s.releasedAt;
      })[0];
      return existing || st;
    });
    l.stops = kept.concat(fresh).slice(0, 30);
  }

  function deleteLetter(lid) {
    tombstone('letter', lid);
    state.letters = state.letters.filter(function (l) { return l.id !== lid; });
    commit();
  }

  /* ---------- where is it? ----------
     Everything below is worked out from the trail rather than stored, so it can
     never drift out of step with what was actually recorded. */

  function wasReturned(s) { return !!s && s.outcome === 'Returned for revision'; }

  function currentStop(l) {
    if (!l) return null;
    for (var i = 0; i < l.stops.length; i++) {
      if (!l.stops[i].releasedAt) return l.stops[i];
    }
    return null;
  }

  /* A second run at the same desk. When an office sends a letter back, the
     return stays in the trail as its own entry and a fresh one is opened
     beneath it — so the record reads "went to OSA, came back, went to OSA
     again" instead of quietly erasing the first attempt. */
  function isRepeatOf(l, s) {
    var i = l.stops.indexOf(s);
    var prev = i > 0 ? l.stops[i - 1] : null;
    return !!prev && wasReturned(prev) && sameDesk(prev, s);
  }

  function sentBackAwaitingRelodge(l) {
    var s = currentStop(l);
    return !!s && !s.receivedAt && isRepeatOf(l, s);
  }

  function stopState(s) {
    if (!s) return 'done';
    if (s.releasedAt) {
      if (wasReturned(s)) return 'returned';
      // Noted is not the same as signed, and the trail should not pretend it is.
      return s.outcome === 'Noted' ? 'noted' : 'released';
    }
    if (s.receivedAt) return 'received';
    return 'waiting';
  }

  // How long it has sat at the office currently holding it.
  function daysAtCurrent(l) {
    var s = currentStop(l);
    if (!s || !s.receivedAt) return 0;
    return Math.max(0, U.daysBetween(s.receivedAt, U.today()));
  }

  function isStuck(l) {
    if (!l || l.status !== 'Routing') return false;
    var s = currentStop(l);
    if (!s) return false;
    // Sent back and not yet handed in again: somebody has to act, so it counts
    // from the day it came back rather than after a grace period.
    if (sentBackAwaitingRelodge(l)) return true;
    if (!s.receivedAt) return false;
    return daysAtCurrent(l) > stopTurnaround(s);
  }

  function isLetterOverdue(l) {
    return !!l && l.status === 'Routing' && !!l.deadline && l.deadline < U.today();
  }

  function letterNeedsAttention(l) { return isStuck(l) || isLetterOverdue(l); }

  // One sentence: where it is, and since when.
  function letterWhere(l) {
    if (!l) return '';
    if (l.status === 'Approved') return 'Approved';
    if (l.status === 'Declined') return 'Declined';
    if (l.status === 'Withdrawn') return 'Withdrawn';

    var s = currentStop(l);
    if (!s) return 'Approved';
    var name = stopName(s);
    if (!s.receivedAt) {
      if (isRepeatOf(l, s)) return 'Returned by ' + name + ' — needs revising';
      var moved = l.stops.some(function (x) { return !!x.releasedAt; });
      return moved ? 'On its way to ' + name : 'Not yet sent — for ' + name;
    }
    var d = daysAtCurrent(l);
    return 'With ' + name + ' — ' + (d === 0 ? 'received today' : U.plural(d, 'day') + ' ago');
  }

  /* Offices cleared, out of offices on the route.

     A return is a second run at the same desk, not an extra desk, so it is left
     out of both halves — otherwise a letter that came back once could never
     reach 100% however many signatures it collected afterwards. */
  function letterProgress(l) {
    var live = l.stops.filter(function (s) { return !wasReturned(s); });
    var done = live.filter(function (s) { return !!s.releasedAt; }).length;
    return { done: done, total: live.length, percent: U.pct(done, live.length) };
  }

  /* ---------- recording the hand-over ---------- */

  function receiveStop(lid, stopId, data) {
    var l = letter(lid);
    if (!l) return null;
    var s = l.stops.filter(function (x) { return x.id === stopId; })[0];
    if (!s) return null;
    var who = str(data.receivedBy, LIMITS.name);
    if (!who) throw new Error('Write down who received it.');
    s.receivedBy = who;
    s.forwardedBy = str(data.forwardedBy, LIMITS.name);
    s.receivedAt = dateOnly(data.receivedAt) || U.today();
    s.releasedAt = '';
    s.outcome = '';
    l.status = 'Routing';
    l.updatedAt = bumpStamp(l.updatedAt);
    commit();
    return l;
  }

  function releaseStop(lid, stopId, data) {
    var l = letter(lid);
    if (!l) return null;
    var s = l.stops.filter(function (x) { return x.id === stopId; })[0];
    if (!s) return null;
    if (!s.receivedAt) throw new Error('Record that the office received it first.');
    s.outcome = oneOf(data.outcome, STOP_OUTCOMES, 'Approved');
    s.releasedAt = dateOnly(data.releasedAt) || U.today();
    s.note = str(data.note, LIMITS.reason);

    /* Sent back for revision. The return stays exactly as recorded and a fresh
       attempt at the same office is opened directly beneath it, so the trail
       shows both passes and the reason it came back is still readable. */
    if (wasReturned(s)) {
      var at = l.stops.indexOf(s);
      l.stops.splice(at + 1, 0, respawn(s));
      l.status = 'Routing';
    } else {
      l.status = currentStop(l) ? 'Routing' : 'Approved';
    }

    l.updatedAt = bumpStamp(l.updatedAt);
    commit();
    return l;
  }

  /* Kept for data saved before a return opened its own follow-up entry: it
     simply makes sure there is somewhere for the letter to go next. */
  function reopenStop(lid, stopId) {
    var l = letter(lid);
    if (!l) return null;
    var s = l.stops.filter(function (x) { return x.id === stopId; })[0];
    if (!s || !wasReturned(s)) return l;
    var at = l.stops.indexOf(s);
    var nextOne = l.stops[at + 1];
    if (!nextOne || !sameDesk(nextOne, s)) {
      l.stops.splice(at + 1, 0, respawn(s));
    }
    l.status = 'Routing';
    l.updatedAt = bumpStamp(l.updatedAt);
    commit();
    return l;
  }

  function setLetterStatus(lid, status) { return updateLetter(lid, { status: status }); }

  // Trouble first, then whatever is due soonest.
  function byLetterUrgency(a, b) {
    var ao = a.status === 'Routing' ? 0 : 1, bo = b.status === 'Routing' ? 0 : 1;
    if (ao !== bo) return ao - bo;
    var as = letterNeedsAttention(a) ? 0 : 1, bs = letterNeedsAttention(b) ? 0 : 1;
    if (as !== bs) return as - bs;
    var ad = a.deadline || '9999-12-31', bd = b.deadline || '9999-12-31';
    if (ad !== bd) return ad < bd ? -1 : 1;
    return a.subject.localeCompare(b.subject);
  }

  function letterStats(list) {
    var s = { total: list.length, routing: 0, approved: 0, stuck: 0, overdue: 0 };
    list.forEach(function (l) {
      if (l.status === 'Routing') s.routing++;
      if (l.status === 'Approved') s.approved++;
      if (isStuck(l)) s.stuck++;
      if (isLetterOverdue(l)) s.overdue++;
    });
    s.attention = list.filter(letterNeedsAttention).length;
    return s;
  }

  /* ---------- the term ----------

     The National executives declare when the administration ends. From that
     moment every unit is told the date and what it still owes.

     Two things this deliberately does NOT do:

     1. It does not lock anything. Work carries on before the date and after it —
        a deadline is a deadline, not a shutter.
     2. It does not delete anything by itself. When the date has passed and every
        unit has filed, the wipe becomes *available*; a national executive still
        has to press it, and only after downloading a backup. A wrong date or an
        early click must never be able to cost the council its year.

     While any unit is still outstanding the wipe is blocked outright. It can be
     unblocked only by a national executive recording a reason, which is kept. */

  function blankTerm() {
    return {
      endDate: '', note: '', declaredAt: '', declaredBy: '',
      overallLink: '', overallOwned: false, closedAt: '', override: null,
      /* What the closed administration leaves behind: unit names, activity
         titles and the links to their filed reports. Titles and links only — a
         few kilobytes — so the next administration inherits a readable record
         rather than an empty app, without keeping the working data the closing
         was meant to clear. */
      archive: [],
      /* When this was last changed, on the device that changed it. Syncing needs
         it: without a stamp there is nothing to compare, and every round would
         either overwrite a declaration or refuse to carry one. */
      updatedAt: ''
    };
  }

  function cleanTerm(t) {
    if (!t || typeof t !== 'object') return blankTerm();
    var o = blankTerm();
    o.endDate = dateOnly(t.endDate);
    o.note = str(t.note, LIMITS.text);
    o.updatedAt = t.updatedAt ? stamp(t.updatedAt) : '';
    o.declaredAt = t.declaredAt ? stamp(t.declaredAt) : '';
    o.declaredBy = str(t.declaredBy, LIMITS.name);
    o.overallLink = driveLink(t.overallLink);
    o.overallOwned = !!t.overallOwned;
    o.closedAt = t.closedAt ? stamp(t.closedAt) : '';
    o.archive = (Array.isArray(t.archive) ? t.archive : []).map(function (a) {
      if (!a || typeof a !== 'object') return null;
      var name = str(a.unitName, LIMITS.org);
      if (!name) return null;
      return {
        unitId: id(a.unitId, 'unt'),
        unitName: name,
        unitCode: str(a.unitCode, 16),
        complied: !!a.complied,
        events: (Array.isArray(a.events) ? a.events : []).slice(0, 400).map(function (e) {
          var title = str(e && e.title, LIMITS.title);
          if (!title) return null;
          return {
            title: title,
            dateStart: dateOnly(e.dateStart),
            dateEnd: dateOnly(e.dateEnd),
            driveLink: driveLink(e.driveLink),
            driveOwned: !!e.driveOwned
          };
        }).filter(Boolean)
      };
    }).filter(Boolean);

    if (t.override && typeof t.override === 'object') {
      o.override = {
        reason: str(t.override.reason, LIMITS.reason),
        by: str(t.override.by, LIMITS.name),
        at: stamp(t.override.at)
      };
      if (!o.override.reason) o.override = null;
    }
    return o;
  }

  function term() { return state.term; }

  function declareTerm(endDate, opts) {
    opts = opts || {};
    var d = dateOnly(endDate);
    if (!d) throw new Error('Pick the date the term ends.');
    state.term.endDate = d;
    state.term.note = (opts.note || '').trim().slice(0, LIMITS.text);
    state.term.declaredAt = nowISO();
    state.term.declaredBy = (opts.by || '').trim();
    state.term.override = null;
    state.term.updatedAt = bumpStamp(state.term.updatedAt);
    commit();
    return state.term;
  }

  function withdrawTerm() {
    state.term = blankTerm();
    commit();
  }

  function setOverallLink(link, owned) {
    var v = driveLink(link);
    if (link && !v) throw new Error('That needs to be a Google Drive or Docs link.');
    state.term.overallLink = v;
    state.term.overallOwned = !!owned;
    state.term.updatedAt = bumpStamp(state.term.updatedAt);
    commit();
    return state.term;
  }

  function overrideCompliance(reason, by) {
    var r = (reason || '').trim();
    if (r.length < 10) throw new Error('Write down why the outstanding units are being passed over.');
    state.term.override = { reason: r.slice(0, LIMITS.reason), by: (by || '').trim(), at: nowISO() };
    state.term.updatedAt = bumpStamp(state.term.updatedAt);
    commit();
    return state.term;
  }

  /* What a unit still owes. An activity is settled when it has been marked
     finished AND its accomplishment report has been filed — the Drive link is
     what counts as filed, because the file itself never lives here. */
  function unitCompliance(unitId) {
    var evs = state.events.filter(function (e) { return e.unitId === unitId; });
    var outstanding = evs.filter(function (e) {
      var r = report(e.id);
      var finished = e.status === 'Completed' || e.status === 'Archived';
      return !finished || !(r && r.driveLink);
    });
    /* Filed, but on a drive nobody has vouched for. Kept apart from the
       outstanding list because the work is done — what is missing is the promise
       that it will still be there next year. */
    var unvouched = evs.filter(function (e) {
      var r = report(e.id);
      return r && r.driveLink && !r.driveOwned;
    });
    return {
      unitId: unitId,
      events: evs.length,
      filed: evs.length - outstanding.length,
      outstanding: outstanding,
      unvouched: unvouched,
      complies: outstanding.length === 0 && unvouched.length === 0
    };
  }

  function compliance() {
    return units({ activeOnly: true }).map(function (u) {
      var c = unitCompliance(u.id);
      c.unit = u;
      return c;
    });
  }

  /* Where the term stands, in one object the screens can read without doing
     any arithmetic of their own. */
  function termStatus() {
    var t = state.term;
    if (!t.endDate) return { declared: false, closed: false };

    var daysLeft = U.daysBetween(U.today(), t.endDate);
    var rows = compliance();
    var short = rows.filter(function (c) { return !c.complies; });
    var atRisk = rows.reduce(function (n, c) { return n + c.unvouched.length; }, 0);

    return {
      declared: true,
      closed: !!t.closedAt,
      endDate: t.endDate,
      note: t.note,
      daysLeft: daysLeft,
      passed: daysLeft < 0,
      // Everyone has filed, or an executive has recorded a reason to proceed.
      allFiled: short.length === 0,
      overridden: !!t.override,
      outstandingUnits: short,
      compliance: rows,
      // Reports filed to a drive nobody has vouched for. These are what rot.
      atRisk: atRisk,
      // The wipe is offered only once the date has gone by and nothing is owed.
      canClose: daysLeft < 0 && (short.length === 0 || !!t.override) && !t.closedAt,
      blockedBy: daysLeft < 0 && short.length > 0 && !t.override ? short : []
    };
  }

  /* Closing the term. Everything the administration did is removed so the next
     one starts clean; the units, the letterhead and the link to the overall
     report are what carry over — the report itself lives in Drive, which is why
     a link was the right thing to keep all along. */
  function closeTerm(opts) {
    opts = opts || {};
    var st = termStatus();
    if (!st.declared) throw new Error('No closing date has been declared.');
    if (!st.canClose) {
      throw new Error(st.passed
        ? 'Some units have not filed yet, so nothing can be deleted.'
        : 'The term has not reached its closing date.');
    }

    var keepUnits = state.units;
    var keepOffices = state.offices;
    var keepOrg = state.org;
    /* The record of the year, taken before anything is removed. */
    var keepTerm = cleanTerm(state.term);
    keepTerm.closedAt = nowISO();
    keepTerm.updatedAt = bumpStamp(keepTerm.updatedAt);
    keepTerm.archive = units({ activeOnly: true }).map(function (u) {
      var c = unitCompliance(u.id);
      return {
        unitId: u.id, unitName: u.name, unitCode: u.code, complied: c.complies,
        events: state.events.filter(function (e) { return e.unitId === u.id; }).map(function (e) {
          var r = report(e.id);
          return {
            title: e.title, dateStart: e.dateStart, dateEnd: e.dateEnd,
            driveLink: r ? r.driveLink : '', driveOwned: !!(r && r.driveOwned)
          };
        })
      };
    }).filter(function (a) { return a.events.length; });
    if (opts.overallLink) keepTerm.overallLink = driveLink(opts.overallLink) || keepTerm.overallLink;

    // Pictures are held outside this record, so they are cleared too.
    var reportIds = state.reports.map(function (r) { return r.id; });

    state = blank();
    state.units = keepUnits;
    state.offices = keepOffices;
    state.org = keepOrg;
    state.term = keepTerm;
    state.seeded = true;
    commit();

    if (global.AssetDB) {
      reportIds.forEach(function (id) { global.AssetDB.delPrefix(id + ':'); });
    }
    try { global.localStorage.removeItem(PERSON_KEY); } catch (e) { /* nothing to clear */ }
    return keepTerm;
  }

  /* ---------- letter templates ---------- */

  function org() { return state.org; }

  /* The template a unit's reports are printed on: its own where it has one, the
     Republic's otherwise. Everything that prints asks this rather than reading
     org.letterhead directly, so adding a college's own template needed no
     change anywhere a report is made. */
  function templateFor(unitId) {
    var u = unit(unitId);
    if (u && u.letterhead) return u.letterhead;
    return state.org.letterhead || '';
  }

  function setUnitTemplate(unitId, data) {
    var u = unit(unitId);
    if (!u) return null;
    var lh = letterhead(data.letterhead);
    if (data.letterhead && !lh) {
      if (global.UI) {
        global.UI.toast('That template could not be used — PNG or JPG, under 3 MB.', 'error');
      }
      return u;
    }
    u.letterhead = lh;
    u.letterheadBy = lh ? str(data.letterheadBy, LIMITS.name) : '';
    u.letterheadAt = lh ? nowISO() : '';
    u.updatedAt = bumpStamp(u.updatedAt);
    commit();
    return u;
  }

  function updateOrg(data) {
    ['name', 'address', 'email'].forEach(function (k) {
      if (k in data) state.org[k] = str(data[k], LIMITS.org);
    });
    if ('letterhead' in data) {
      var lh = letterhead(data.letterhead);
      if (data.letterhead && !lh) {
        if (global.UI) {
          global.UI.toast('That letterhead could not be used — PNG or JPG, under 3 MB.', 'error');
        }
        return state.org;
      }
      state.org.letterhead = lh;
      state.org.letterheadBy = str(data.letterheadBy, LIMITS.name);
      state.org.letterheadAt = lh ? nowISO() : '';
    }

    // An uploaded emblem goes through the same check as a restored one.
    if ('emblem' in data) {
      var img = emblem(data.emblem);
      if (data.emblem && !img) {
        if (global.UI) global.UI.toast('That image could not be used — PNG or JPG only.', 'error');
        return state.org;
      }
      state.org.emblem = img;
    }
    touchCouncil();
    commit();
    return state.org;
  }

  /* ---------- backup ---------- */

  function toJSON() {
    return JSON.stringify({
      app: 'FCUSR Task Tracker',
      version: 1,
      exportedAt: nowISO(),
      data: state
    }, null, 2);
  }

  function fromJSON(text) {
    var parsed = JSON.parse(text);
    var data = parsed && parsed.data ? parsed.data : parsed;
    if (!data || (!Array.isArray(data.events) && !Array.isArray(data.tasks) && !Array.isArray(data.people))) {
      throw new Error('That file does not look like an FCUSR Task Tracker backup.');
    }
    state = normalize(data);
    commit();
    return {
      people: state.people.length,
      events: state.events.length,
      tasks: state.tasks.length
    };
  }

  // Wipes people, events and tasks. The letterhead is setup, not tracker data, so it stays.
  /* Take the council's work off this device, without telling anyone it was
     deleted.

     resetAll() is somebody deciding to wipe the tracker; this is a different
     act with the same shape. It leaves no tombstones, because nothing has been
     deleted from the council — the work is on the server and this device is
     simply no longer holding a copy. The marks go with it so the next person to
     sign in pulls their own. */
  function clearLocalCopy() {
    var reportIds = state.reports.map(function (r) { return r.id; });
    var keepOrg = state.org;
    var keepUnits = state.units;
    var keepOffices = state.offices;

    state = blank();
    state.org = keepOrg;
    state.units = keepUnits;
    state.offices = keepOffices;
    state.seeded = true;          // no rehearsal for whoever signs in next
    commit();

    // Photographs are held outside this record and are the largest thing here.
    if (global.AssetDB) {
      reportIds.forEach(function (id) { global.AssetDB.delPrefix(id + ':'); });
    }
  }

  function resetAll() {
    var keepOrg = state.org;
    var keepUnits = state.units;
    var keepOffices = state.offices;
    state = blank();
    state.org = keepOrg;
    state.units = keepUnits;
    state.offices = keepOffices;
    /* The units, the offices and the letterhead are setup and survive. A closing
       date is not setup — it belongs to the administration being deleted, and so
       does the dry run. */
    state.seeded = true;
    commit();
  }

  /* ---------- seed ---------- */

  /* An invented council, for the tests.

     It is no longer given to anybody: the app opens empty. The suites need
     something to walk through, so they ask for it by name — and the underscore
     is the whole point, because this is not part of what the app does. */
  function _seedRehearsal() {
    seed();
    /* The fixture is loaded deliberately, so it must not be swept away by the
       clearing pass that runs when real data is read back in. */
    ['events', 'tasks', 'letters', 'people', 'reports'].forEach(function (list) {
      state[list].forEach(function (r) { delete r.sample; });
    });
    commit();
    return state;
  }

  function seed() {
    var t = U.today();
    var d = function (n) { return U.addDays(t, n); };

    var roster = [
      /* Five, not a full executive board. This is a rehearsal, and every
         invented name is one more thing to tell apart from a real officer when
         the dry run ends. Five is enough to show work spread across people,
         which is the only thing the sample roster is for. */
      ['Althea Ramirez', 'President', 'Executive'],
      ['Miguel Fortaleza', 'VP–Internal', 'Programs'],
      ['Job Sarmiento', 'Secretary', 'Documentation'],
      ['Kyla Montaño', 'Treasurer', 'Finance'],
      ['Jomar Delgado', 'Business Manager', 'Logistics']
    ];
    var byPos = {};
    roster.forEach(function (r) {
      var p = {
        id: U.uid('per'), name: r[0], position: r[1], committee: r[2],
        email: '', unitId: nationalUnitId(), access: 'officer', eventIds: [], claimed: false,
        active: true, sample: true, createdAt: nowISO(), updatedAt: nowISO()
      };
      state.people.push(p);
      byPos[r[1]] = p.id;
    });

    var evs = [
      {
        title: 'Foundation Week 2026',
        description: 'Week-long university celebration: opening parade, socio-cultural night, and inter-college sports.',
        dateStart: d(26), dateEnd: d(30), venue: 'FCU Gymnasium and Quadrangle',
        headId: byPos['President'], status: 'Upcoming'
      },
      {
        title: 'Leadership Training Seminar',
        description: 'One-day seminar for incoming class officers and organization heads.',
        dateStart: d(9), dateEnd: '', venue: 'Function Hall, Administration Building',
        headId: byPos['VP–Internal'], status: 'Ongoing'
      },
      {
        title: 'Feeding Program — Barangay Culasi',
        description: 'Outreach feeding for 150 children in partnership with the barangay council.',
        dateStart: d(17), dateEnd: '', venue: 'Barangay Culasi Covered Court',
        headId: byPos['VP–Internal'], status: 'Upcoming'
      }
    ];
    var natId = nationalUnitId();
    var evIds = evs.map(function (e) {
      e.id = U.uid('evt');
      e.unitId = natId;
      e.sample = true;
      e.createdAt = nowISO();
      e.updatedAt = bumpStamp(e.updatedAt);
      state.events.push(e);
      return e.id;
    });

    // [event index, title, position, dueOffset, priority, status, remarks]
    var rows = [
      [0, 'Draft and route the activity proposal', 'Secretary', -5, 'High', 'Done', 'Signed by the Dean of Student Affairs.'],
      [0, 'Reserve the covered court for the opening parade', 'Business Manager', -4, 'Medium', 'Done', ''],
      [0, 'Secure gymnasium reservation', 'VP–Internal', -2, 'High', 'In Progress', 'Physical Plant asked for a second copy of the request letter.'],
      [0, 'Confirm the guest speaker', 'President', -3, 'High', 'On hold', ''],
      [0, 'Prepare the program budget', 'Treasurer', 2, 'High', 'In Progress', ''],
      [0, 'Finalize sports event mechanics', 'VP–Internal', 8, 'Medium', 'For Review', 'Sent to the Sports Committee for checking.'],
      [0, 'Design tarpaulin and poster set', 'Secretary', 6, 'Medium', 'Not Started', ''],
      [0, 'Book sound system and lights', 'Business Manager', 13, 'Medium', 'Not Started', ''],

      [1, 'Book the function hall', 'Secretary', -7, 'High', 'Done', ''],
      [1, 'Send invitation letters to resource speakers', 'VP–Internal', -1, 'High', 'In Progress', 'Two of three speakers have replied.'],
      [1, 'Post the registration form and reminder', 'Secretary', 1, 'Medium', 'In Progress', ''],
      [1, 'Prepare seminar kits and handouts', 'Treasurer', 3, 'Medium', 'Not Started', ''],
      [1, 'Arrange snacks and lunch for 60 pax', 'Business Manager', 5, 'Medium', 'Not Started', ''],
      [1, 'Prepare attendance sheets and evaluation forms', '', 7, 'Low', 'Not Started', 'Needs a volunteer from the Documentation Committee.'],

      [2, 'Canvass ingredients and packaging', 'Business Manager', -2, 'Medium', 'Not Started', ''],
      [2, 'Coordinate with Barangay Culasi officials', 'VP–Internal', 4, 'High', 'In Progress', 'Courtesy call set with the barangay captain.'],
      [2, 'Solicit donations from partner establishments', 'Treasurer', 10, 'High', 'Not Started', ''],
      [2, 'Prepare the master list of beneficiaries', 'Treasurer', 12, 'Medium', 'Not Started', ''],
      [2, 'Draft the documentation plan', 'Secretary', 14, 'Low', 'Not Started', '']
    ];

    rows.forEach(function (r) {
      var task = {
        id: U.uid('tsk'),
        eventId: evIds[r[0]],
        title: r[1],
        assigneeId: r[2] ? (byPos[r[2]] || '') : '',
        dueDate: d(r[3]),
        priority: r[4],
        status: r[5],
        remarks: r[6] || '',
        blockedReason: r[5] === 'On hold'
          ? 'Waiting for the Office of Student Affairs to endorse the invitation letter.' : '',
        completedAt: '',
        sample: true,
        createdAt: nowISO(),
        updatedAt: nowISO()
      };
      // Completed sample work is stamped a day before it was due, so the report
      // has believable "date completed" values.
      if (task.status === 'Done') {
        task.completedAt = new Date(U.parse(U.addDays(task.dueDate, -1)).getTime()).toISOString();
      }
      state.tasks.push(task);
    });

    /* ---- the provinces ----
       Enough real-looking work in a few colleges that the Republic roll-up on the
       Overview has something to say, and a national can open a college's activity
       and find it read-only. Marked as sample, so "Clear sample data" takes the
       whole lot out in one go. */
    function unitByCode(code) {
      for (var ui = 0; ui < state.units.length; ui++) {
        if (state.units[ui].code === code) return state.units[ui];
      }
      return null;
    }

    /* One Governor per college, and no more. The rehearsal only has to show
       that other units exist and are getting on with their own work; a second
       invented name per college shows nothing extra and is one more row to tell
       from a real officer when the dry run ends. */
    var lguRoster = [
      ['CN',   'Pauline Grace Alcantara', 'Governor', 'Executive'],
      ['COE',  'Rafael Guanzon',          'Governor', 'Executive'],
      ['CCS',  'Neil Patrick Oquendo',    'Governor', 'Executive'],
      ['CTE',  'Joyce Ann Palmares',      'Governor', 'Executive'],
      ['CBA',  'Dexter Lim',              'Governor', 'Executive']
    ];
    var lguPeople = {};
    lguRoster.forEach(function (r) {
      var u = unitByCode(r[0]);
      if (!u) return;
      var p = {
        id: U.uid('per'), name: r[1], position: r[2], committee: r[3],
        email: '', unitId: u.id, access: 'officer', eventIds: [], claimed: false,
        active: true, sample: true, createdAt: nowISO(), updatedAt: nowISO()
      };
      state.people.push(p);
      lguPeople[r[0] + ':' + r[2]] = p.id;
    });

    // [code, title, description, startOffset, endOffset, venue, head position, status]
    var lguEvents = [
      ['CN',  'Nurses Week 2026', 'Capping and pinning ceremony, skills competition, and a community blood-letting drive.',
        12, 15, 'CN Amphitheatre', 'Governor', 'Upcoming'],
      ['CN',  'Community Blood-Letting Drive', 'Partnership with the Philippine Red Cross Capiz Chapter.',
        -6, 0, 'Barangay Baybay Covered Court', 'Secretary', 'Completed'],
      ['COE', 'Engineering Week 2026', 'Bridge-building contest, technical quiz bowl, and the general assembly.',
        20, 24, 'COE Building and Quadrangle', 'Governor', 'Upcoming'],
      ['CCS', 'Hour of Code — Roxas City', 'Outreach coding workshop for two public high schools.',
        6, 0, 'CCS Computer Laboratory 2', 'Governor', 'Ongoing'],
      ['CTE', 'Teachers Day Tribute', 'Programme and tribute for the college faculty.',
        3, 0, 'CTE Function Room', 'Governor', 'Ongoing'],
      ['CBA', 'Business Month Kick-off', 'Opening programme and the inter-year sales challenge.',
        30, 33, 'CBA Audio-Visual Room', 'Governor', 'Upcoming']
    ];

    var lguEventIds = {};
    lguEvents.forEach(function (r) {
      var u = unitByCode(r[0]);
      if (!u) return;
      var ev = {
        id: U.uid('evt'), unitId: u.id, title: r[1], description: r[2],
        dateStart: d(r[3]), dateEnd: r[4] ? d(r[4]) : '', venue: r[5],
        headId: lguPeople[r[0] + ':' + r[6]] || '',
        status: r[7], sample: true, createdAt: nowISO(), updatedAt: nowISO()
      };
      state.events.push(ev);
      lguEventIds[r[1]] = ev.id;
    });

    // [event title, task, code:position of assignee, dueOffset, priority, status]
    var lguTasks = [
      ['Nurses Week 2026', 'Draft and route the activity proposal', 'CN:Governor', -3, 'High', 'Done'],
      ['Nurses Week 2026', 'Reserve the amphitheatre', 'CN:Governor', -1, 'High', 'In Progress'],
      ['Nurses Week 2026', 'Order caps and pins for 84 graduates', 'CN:Governor', 5, 'High', 'Not Started'],
      ['Nurses Week 2026', 'Invite the clinical instructors', 'CN:Governor', 7, 'Medium', 'Not Started'],
      ['Nurses Week 2026', 'Prepare the skills competition mechanics', '', 9, 'Medium', 'Not Started'],

      ['Community Blood-Letting Drive', 'Coordinate with the Red Cross chapter', 'CN:Governor', -12, 'High', 'Done'],
      ['Community Blood-Letting Drive', 'Secure the barangay permit', 'CN:Governor', -10, 'High', 'Done'],
      ['Community Blood-Letting Drive', 'Prepare the donor master list', 'CN:Governor', -7, 'Medium', 'Done'],

      ['Engineering Week 2026', 'Draft the activity proposal', 'COE:Governor', -2, 'High', 'For Review'],
      ['Engineering Week 2026', 'Canvass materials for the bridge contest', 'COE:Governor', 4, 'Medium', 'In Progress'],
      ['Engineering Week 2026', 'Book the quadrangle and sound system', 'COE:Governor', 8, 'Medium', 'Not Started'],
      ['Engineering Week 2026', 'Prepare the quiz bowl questions', '', 12, 'Low', 'Not Started'],

      ['Hour of Code — Roxas City', 'Letter to the two partner high schools', 'CCS:Governor', -4, 'High', 'Done'],
      ['Hour of Code — Roxas City', 'Reserve Computer Laboratory 2', 'CCS:Governor', -2, 'Medium', 'Done'],
      ['Hour of Code — Roxas City', 'Prepare the workshop handouts', 'CCS:Governor', 1, 'High', 'In Progress'],
      ['Hour of Code — Roxas City', 'Arrange snacks for 60 participants', 'CCS:Governor', 2, 'Medium', 'On hold'],

      ['Teachers Day Tribute', 'Programme and script', 'CTE:Governor', -1, 'High', 'In Progress'],
      ['Teachers Day Tribute', 'Tokens for the faculty', 'CTE:Governor', 2, 'Medium', 'Not Started'],

      ['Business Month Kick-off', 'Draft the activity proposal', 'CBA:Governor', 10, 'High', 'Not Started'],
      ['Business Month Kick-off', 'Sales challenge mechanics', 'CBA:Governor', 16, 'Medium', 'Not Started']
    ];

    lguTasks.forEach(function (r) {
      var evId = lguEventIds[r[0]];
      if (!evId) return;
      var t = {
        id: U.uid('tsk'), kind: 'event', eventId: evId, title: r[1],
        assigneeId: r[2] ? (lguPeople[r[2]] || '') : '',
        dueDate: d(r[3]), priority: r[4], status: r[5], remarks: '',
        blockedReason: r[5] === 'On hold'
          ? 'Waiting on the canteen to confirm the package price.' : '',
        completedAt: '', sample: true, createdAt: nowISO(), updatedAt: nowISO()
      };
      if (t.status === 'Done') {
        t.completedAt = new Date(U.parse(U.addDays(t.dueDate, -1)).getTime()).toISOString();
      }
      state.tasks.push(t);
    });

    /* A couple of letters in flight, including one that has been sent back, so
       the trail shows both passes without anyone having to stage it. */
    function officeByCode(code) {
      for (var oi = 0; oi < state.offices.length; oi++) {
        if (state.offices[oi].code === code) return state.offices[oi];
      }
      return null;
    }
    function stopFor(code) {
      var o = officeByCode(code);
      return o ? { id: U.uid('stp'), officeId: o.id, forwardedBy: '', receivedBy: '',
                   receivedAt: '', releasedAt: '', outcome: '', note: '' } : null;
    }
    function seedLetter(unitCode, subject, evTitle, inCharge, route, deadlineOffset) {
      var u = unitByCode(unitCode);
      if (!u) return null;
      var stops = route.map(stopFor).filter(Boolean);
      if (!stops.length) return null;
      var l = {
        id: U.uid('ltr'), unitId: u.id, eventId: lguEventIds[evTitle] || '',
        subject: subject, inChargeId: '', inChargeName: inCharge,
        deadline: deadlineOffset === null ? '' : d(deadlineOffset),
        status: 'Routing', stops: stops, sample: true,
        createdAt: nowISO(), updatedAt: nowISO()
      };
      state.letters.push(l);
      return l;
    }

    var l1 = seedLetter('CN', 'Activity proposal — Nurses Week 2026', 'Nurses Week 2026',
      'Pauline Grace Alcantara', ['ADV', 'DEAN', 'OSA', 'VPAA', 'OP'], 8);
    if (l1) {
      l1.stops[0].receivedBy = 'Ms. Delos Reyes';
      l1.stops[0].forwardedBy = 'Pauline Grace Alcantara';
      l1.stops[0].receivedAt = d(-11);
      l1.stops[0].releasedAt = d(-10);
      l1.stops[0].outcome = 'Approved';
      // Sitting at the Dean's office well past its usual turnaround.
      l1.stops[1].receivedBy = 'Mrs. Ferrer';
      l1.stops[1].forwardedBy = 'Pauline Grace Alcantara';
      l1.stops[1].receivedAt = d(-9);
    }

    var l2 = seedLetter('COE', 'Request to use the quadrangle', 'Engineering Week 2026',
      'Rafael Guanzon', ['OSA', 'PPO'], 5);
    if (l2) {
      // Sent back, and the second run at the same desk sits under it.
      l2.stops[0].receivedBy = 'Sir Alvarez';
      l2.stops[0].forwardedBy = 'Rafael Guanzon';
      l2.stops[0].receivedAt = d(-6);
      l2.stops[0].releasedAt = d(-4);
      l2.stops[0].outcome = 'Returned for revision';
      l2.stops[0].note = 'Attach the equipment list and the clean-up plan.';
      var again = stopFor('OSA');
      if (again) l2.stops.splice(1, 0, again);
    }

    seedLetter('CCS', 'Excuse letter for the Hour of Code facilitators',
      'Hour of Code — Roxas City', 'Neil Patrick Oquendo', ['OSA', 'DEAN'], 2);

    /* Every letter above belongs to a college, and the person rehearsing this is
       usually a national executive — who would open the Letters tab and find it
       empty, which teaches them the tracker does not work rather than how it
       does. So the National government carries its own, on the council's real
       routes, including one that has to be chased. */
    var n1 = seedLetter('NAT', 'Request for the General Assembly budget', 'General Assembly 2026',
      'Althea Ramirez', ['AUTH', 'GOV', 'PRES', 'ADV', 'DEAN', 'OSA', 'BUD', 'VPAA', 'VPF', 'OP'], 12);
    if (n1) {
      ['Althea Ramirez', 'Arron D. Aperocho', 'Arron D. Aperocho'].forEach(function (who, i) {
        n1.stops[i].receivedBy = who;
        n1.stops[i].forwardedBy = 'Althea Ramirez';
        n1.stops[i].receivedAt = d(-9 + i);
        n1.stops[i].releasedAt = d(-8 + i);
        n1.stops[i].outcome = 'Approved';
      });
      // Sitting with the adviser longer than that desk usually takes.
      n1.stops[3].receivedBy = 'Sir Gonzales';
      n1.stops[3].forwardedBy = 'Althea Ramirez';
      n1.stops[3].receivedAt = d(-7);
    }

    var n2 = seedLetter('NAT', 'Permission to attend the regional student leaders\u2019 congress',
      '', 'Miguel Fortaleza',
      ['AUTH', 'GOV', 'PRES', 'ADV', 'DEAN', 'OSA', 'BUD', 'VPAA', 'VPF', 'OP'], 4);
    if (n2) {
      n2.stops[0].receivedBy = 'Miguel Fortaleza';
      n2.stops[0].forwardedBy = 'Miguel Fortaleza';
      n2.stops[0].receivedAt = d(-3);
      n2.stops[0].releasedAt = d(-3);
      n2.stops[0].outcome = 'Approved';
      // Sent back by the President — the extra progress entry the trail shows.
      n2.stops[1].receivedBy = 'Arron D. Aperocho';
      n2.stops[1].forwardedBy = 'Miguel Fortaleza';
      n2.stops[1].receivedAt = d(-2);
      n2.stops[1].releasedAt = d(-1);
      n2.stops[1].outcome = 'Returned for revision';
      n2.stops[1].note = 'Attach the invitation letter before this goes any further.';
      var retry = stopFor('GOV');
      if (retry) n2.stops.splice(2, 0, retry);
    }

    // One kept inside the council, so the President-signs-everything rule and
    // its one exception are both visible in the rehearsal.
    var n3 = seedLetter('NAT', 'Minutes of the 3rd Executive Board meeting', '',
      'Althea Ramirez', ['AUTH', 'GOV'], null);
    if (n3) n3.internal = true;

    state.seeded = true;
  }

  global.Store = {
    STATUSES: STATUSES, PRIORITIES: PRIORITIES, EVENT_STATUSES: EVENT_STATUSES,
    UNIT_KINDS: UNIT_KINDS,
    units: units, unit: unit, unitName: unitName, unitKindLabel: unitKindLabel,
    isIndependent: isIndependent, trackerTitle: trackerTitle, trackerName: trackerName,
    nationalUnit: nationalUnit, nationalUnitId: nationalUnitId, unitStats: unitStats,
    addUnit: addUnit, updateUnit: updateUnit, setUnitActive: setUnitActive,
    deleteUnit: deleteUnit, unitEventCount: unitEventCount,
    load: load, save: save, subscribe: subscribe,
    raw: function () { return state; },
    positions: function () { return state.positions.slice(); },
    committees: function () { return state.committees.slice(); },
    addListValue: addListValue, removeListValue: removeListValue,
    LETTER_STATUSES: LETTER_STATUSES, STOP_OUTCOMES: STOP_OUTCOMES,
    offices: offices, office: office, officeName: officeName,
    addOffice: addOffice, updateOffice: updateOffice, setOfficeActive: setOfficeActive,
    deleteOffice: deleteOffice, officeLetterCount: officeLetterCount,
    routeTemplates: routeTemplates,
    letters: letters, letter: letter, addLetter: addLetter, updateLetter: updateLetter,
    deleteLetter: deleteLetter, letterInCharge: letterInCharge,
    currentStop: currentStop, stopState: stopState, daysAtCurrent: daysAtCurrent,
    wasReturned: wasReturned, isRepeatOf: isRepeatOf,
    isStuck: isStuck, isLetterOverdue: isLetterOverdue, letterNeedsAttention: letterNeedsAttention,
    letterWhere: letterWhere, letterProgress: letterProgress, letterStats: letterStats,
    receiveStop: receiveStop, releaseStop: releaseStop, reopenStop: reopenStop,
    applyRemote: applyRemote, applyRemoteDeletion: applyRemoteDeletion,
    applyRemoteTerm: applyRemoteTerm,
    council: council, applyRemoteCouncil: applyRemoteCouncil,
    outbound: outbound, deletions: deletions, isDeleted: isDeleted,
    syncState: syncState, markSynced: markSynced, remapIds: remapIds,
    storageBroken: storageBroken,
    now: nowISO,
    resetSyncMarks: resetSyncMarks,
    commit: commit,
    insertStop: insertStop, presidentOfficeId: presidentOfficeId,
    stopName: stopName, stopTurnaround: stopTurnaround, sameDesk: sameDesk,
    officeByCode: officeByCode,
    setLetterStatus: setLetterStatus, byLetterUrgency: byLetterUrgency,
    org: org, updateOrg: updateOrg,
    templateFor: templateFor, setUnitTemplate: setUnitTemplate,
    term: term, termStatus: termStatus, declareTerm: declareTerm, withdrawTerm: withdrawTerm,
    compliance: compliance, unitCompliance: unitCompliance,
    overrideCompliance: overrideCompliance, setOverallLink: setOverallLink, closeTerm: closeTerm,
    report: report, reports: reports, saveReport: saveReport, deleteReport: deleteReport,
    people: people, person: person, personName: personName, personByEmail: personByEmail,
    assignable: assignable,
    volunteersFor: volunteersFor, removeVolunteerFrom: removeVolunteerFrom,
    addPerson: addPerson, addPeople: addPeople, updatePerson: updatePerson, setPersonActive: setPersonActive,
    deletePerson: deletePerson, personHolds: personHolds, unitHeads: unitHeads,
    reconcileDirectory: reconcileDirectory,
    duplicatePeopleCount: duplicatePeopleCount, mergeDuplicatePeople: mergeDuplicatePeople,
    events: events, event: event, addEvent: addEvent, updateEvent: updateEvent, deleteEvent: deleteEvent,
    needsFeedback: needsFeedback, setFeedbackLink: setFeedbackLink,
    waiveFeedback: waiveFeedback, restoreFeedback: restoreFeedback,
    tasks: tasks, task: task, addTask: addTask, updateTask: updateTask,
    setTaskStatus: setTaskStatus, deleteTask: deleteTask,
    isOverdue: isOverdue, isPending: isPending, isDueToday: isDueToday, isDueThisWeek: isDueThisWeek,
    stats: stats, eventStats: eventStats,
    byDueDate: byDueDate, byPriority: byPriority, byStatus: byStatus, byUrgency: byUrgency,
    lastPerson: lastPerson, setLastPerson: setLastPerson,
    toJSON: toJSON, fromJSON: fromJSON,
    resetAll: resetAll,
    clearLocalCopy: clearLocalCopy, _seedRehearsal: _seedRehearsal
  };
})(window);
