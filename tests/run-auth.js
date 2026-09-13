/* The credential path, driven end to end against a stand-in Supabase.

       node tests/run-auth.js

   There is no live project here, and that is the point: the fake below answers
   the same URLs the real one does and records every request, so the questions
   that actually decide whether people can sign in on deployment day get answered
   now rather than in front of the council.

   What it walks: an executive enrols an address · that person sets their own
   password · the app asks who they are · the page is refreshed · the hour runs
   out and the token is exchanged · a volunteer sees only their own activities ·
   signing out leaves nothing behind.
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

const vc = new VirtualConsole();
const dom = new JSDOM(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'), {
  url: 'http://localhost/index.html', runScripts: 'dangerously',
  virtualConsole: vc, pretendToBeVisual: true
});
const { window } = dom;
window.HTMLCanvasElement.prototype.getContext = () => null;
window.scrollTo = () => {};
window.Element.prototype.scrollIntoView = function () {};

/* ---------------- the stand-in ----------------
   Small on purpose. It enforces only the things the client is being tested
   against: a token proves who you are, an unknown token proves nothing, and a
   profile appears only where an enrolment was recorded first. */

const SB = {
  url: 'https://stand-in.supabase.co',
  anonKey: 'anon-key-for-the-test',
  users: {},          // email → { id, password }
  enrolments: {},     // email → { unit_id, access, event_ids, full_name, position }
  profiles: {},       // id → profile row
  members: [],        // { event_id, profile_id }
  tokens: {},         // access token → { userId, expiresAt }
  refreshes: {},      // refresh token → userId
  requests: [],       // every call the client made
  missing: [],        // functions this database has not had installed yet
  n: 0
};

const NAT = 'unit-nat-uuid';
const CN = 'unit-cn-uuid';
const units = [
  { id: NAT, name: 'FCUSR Nationals', kind: 'national', code: 'NAT' },
  { id: CN, name: 'College of Nursing', kind: 'province', code: 'CN' }
];

function issue(userId, ttl = 3600) {
  const access = 'acc-' + (++SB.n);
  const refresh = 'ref-' + (++SB.n);
  SB.tokens[access] = { userId, expiresAt: Date.now() + ttl * 1000 };
  SB.refreshes[refresh] = userId;
  return { access_token: access, refresh_token: refresh, expires_in: ttl };
}

function bearerUser(headers) {
  const auth = (headers && (headers.Authorization || headers.authorization)) || '';
  const tok = auth.replace(/^Bearer /, '');
  const rec = SB.tokens[tok];
  if (rec) {
    if (rec.expiresAt < Date.now()) return null; // the server refuses a lapsed token
    return rec.userId;
  }
  return null;
}

// The trigger the schema installs on auth.users: sign-up turns a waiting
// enrolment into a profile, and nothing otherwise.
function claimEnrolment(user) {
  const e = SB.enrolments[user.email];
  if (!e) return;
  SB.profiles[user.id] = {
    id: user.id, email: user.email, full_name: e.full_name, position: e.position,
    unit_id: e.unit_id, access: e.access, is_head: false, active: true,
    units: units.find((u) => u.id === e.unit_id)
  };
  (e.event_ids || []).forEach((ev) => SB.members.push({ event_id: ev, profile_id: user.id }));
  e.claimed_at = new Date().toISOString();
}

function reply(status, body) {
  return Promise.resolve({
    ok: status < 400, status,
    text: () => Promise.resolve(body === undefined ? '' : JSON.stringify(body))
  });
}

window.fetch = function (url, opts) {
  opts = opts || {};
  const u = String(url).replace(SB.url, '');
  const body = opts.body ? JSON.parse(opts.body) : {};
  const who = bearerUser(opts.headers);
  SB.requests.push({ url: u, method: opts.method || 'GET', auth: !!who });

  if (!(opts.headers || {}).apikey) return reply(401, { message: 'No API key.' });

  /* ---- auth ---- */
  if (u.indexOf('/auth/v1/signup') === 0) {
    /* What Supabase actually answers: 422, and the sentence under `msg` rather
       than `message`. The stand-in used to say 400 with `message`, which the
       client happened to read — so the client's failure to read a real reply
       was invisible here and reached a student as the words "HTTP 422". */
    if (SB.users[body.email]) {
      return reply(422, { code: 422, error_code: 'user_already_exists',
                          msg: 'User already registered' });
    }
    const user = { id: 'user-' + (++SB.n), email: body.email, password: body.password };
    SB.users[body.email] = user;
    claimEnrolment(user);                       // the trigger
    return reply(200, Object.assign(issue(user.id), { user: { id: user.id, email: user.email } }));
  }
  if (u.indexOf('/auth/v1/token?grant_type=password') === 0) {
    const user = SB.users[body.email];
    if (!user || user.password !== body.password) {
      return reply(400, { error_description: 'Invalid login credentials' });
    }
    return reply(200, Object.assign(issue(user.id), { user: { id: user.id, email: user.email } }));
  }
  if (u.indexOf('/auth/v1/token?grant_type=refresh_token') === 0) {
    const userId = SB.refreshes[body.refresh_token];
    if (!userId) return reply(400, { error_description: 'Invalid Refresh Token' });
    const email = Object.keys(SB.users).find((e) => SB.users[e].id === userId);
    return reply(200, Object.assign(issue(userId), { user: { id: userId, email } }));
  }
  if (u.indexOf('/auth/v1/logout') === 0) return reply(204);
  if (u.indexOf('/auth/v1/user') === 0) {
    if (!who) return reply(401, { message: 'invalid claim: missing sub claim' });
    if (opts.method === 'PUT') {
      const email = Object.keys(SB.users).find((e) => SB.users[e].id === who);
      SB.users[email].password = body.password;
      return reply(200, { id: who, email });
    }
    const email = Object.keys(SB.users).find((e) => SB.users[e].id === who);
    return reply(200, { id: who, email });
  }

  /* ---- rest ---- */
  if (!who) return reply(401, { message: 'JWT expired or missing' });

  if (u.indexOf('/rest/v1/units') === 0) return reply(200, units);

  if (u.indexOf('/rest/v1/profiles') === 0) {
    const m = u.match(/id=eq\.([^&]+)/);
    // Without a filter the database hands back everything this person may read.
    const all = Object.keys(SB.profiles).map((k) => SB.profiles[k]);
    return reply(200, m ? all.filter((p) => p.id === decodeURIComponent(m[1])) : all);
  }
  if (u.indexOf('/rest/v1/event_members') === 0) {
    const m = u.match(/profile_id=eq\.([^&]+)/);
    return reply(200, SB.members.filter((r) => !m || r.profile_id === decodeURIComponent(m[1]))
      .map((r) => ({ event_id: r.event_id })));
  }
  if (u.indexOf('/rest/v1/enrolments') === 0) {
    return reply(200, Object.keys(SB.enrolments)
      .filter((e) => !SB.enrolments[e].claimed_at)
      .map((e) => Object.assign({ email: e }, SB.enrolments[e])));
  }
  if (u.indexOf('/rest/v1/rpc/enroll_member') === 0) {
    const actor = SB.profiles[who];
    if (!actor || actor.access !== 'officer') return reply(403, { message: 'You may not enrol members.' });
    const actorUnit = units.find((x) => x.id === actor.unit_id);
    if (actorUnit.kind !== 'national' && actor.unit_id !== body.p_unit_id) {
      return reply(403, { message: 'You may not enrol members for that unit.' });
    }
    const clean = body.p_email.toLowerCase().trim();
    SB.enrolments[clean] = {
      email: clean,
      full_name: body.p_full_name, position: body.p_position,
      unit_id: body.p_unit_id, access: body.p_access, event_ids: body.p_event_ids || []
    };

    /* A login with no account behind it: they set a password before anybody
       enrolled them. Updating profiles by email matches nothing, so the profile
       is made here — otherwise the enrolment reports success and the person is
       told to ask an executive for ever. */
    const user = SB.users[clean];
    if (user && !SB.profiles[user.id]) {
      SB.profiles[user.id] = {
        id: user.id, email: clean,
        full_name: body.p_full_name || clean.split('@')[0],
        position: body.p_position || '', unit_id: body.p_unit_id,
        access: body.p_access, is_head: false, active: true,
        units: units.find((u) => u.id === body.p_unit_id)
      };
      (body.p_event_ids || []).forEach((ev) =>
        SB.members.push({ event_id: ev, profile_id: user.id }));
      SB.enrolments[clean].claimed_at = new Date().toISOString();
    }
    /* Enrolling is the act of saying somebody may sign in. The real function
       used to leave `active` alone, so an address that had once been removed
       could be enrolled over and over and still be refused at the door — and
       this stand-in never set it either, so nothing here noticed. */
    Object.keys(SB.profiles).forEach((k) => {
      if (SB.profiles[k].email === String(body.p_email || '').toLowerCase().trim()) {
        SB.profiles[k].active = true;
      }
    });
    return reply(200, body.p_email);
  }
  /* PostgREST answers a function it does not know with 404. A council running a
     site newer than its database sees exactly this, and the app has to say so
     rather than reach for whatever older function happens to still be there. */
  const rpc = u.indexOf('/rest/v1/rpc/') === 0 ? u.slice('/rest/v1/rpc/'.length).split('?')[0] : '';
  if (rpc && (SB.missing || []).indexOf(rpc) >= 0) {
    return reply(404, { code: 'PGRST202',
      message: 'Could not find the function public.' + rpc + ' in the schema cache' });
  }

  if (u.indexOf('/rest/v1/rpc/set_member_password') === 0) {
    const actor = SB.profiles[who];
    const actorUnit = actor && units.find((x) => x.id === actor.unit_id);
    const email = String(body.p_email || '').toLowerCase().trim();
    if (!actor || actor.access !== 'officer' || !actorUnit || actorUnit.kind !== 'national') {
      return reply(403, { message: 'You may not set that member\'s password.' });
    }
    if (actor.email === email) return reply(400, { message: 'Use Change my password for your own.' });
    if (!SB.users[email]) {
      return reply(400, { message: 'Nobody has signed in with that address yet.' });
    }
    if (!body.p_password || String(body.p_password).length < 8) {
      return reply(400, { message: 'A password must be at least eight characters.' });
    }
    SB.users[email].password = body.p_password;
    /* And back on. Setting a password is the act of saying somebody may sign
       in; leaving them switched off would make the button a lie. */
    Object.keys(SB.profiles).forEach((k) => {
      if (SB.profiles[k].email === email) SB.profiles[k].active = true;
    });
    /* Whoever was signed in as them is signed out. Setting a password and
       leaving the old sessions alive would leave the person you just locked out
       still inside until their token happened to lapse. */
    Object.keys(SB.tokens).forEach((t) => {
      if (SB.tokens[t].userId === SB.users[email].id) delete SB.tokens[t];
    });
    return reply(200, true);
  }
  if (u.indexOf('/rest/v1/rpc/remove_member') === 0 ||
      u.indexOf('/rest/v1/rpc/withdraw_member') === 0) {
    const actor = SB.profiles[who];
    if (!actor || actor.access !== 'officer') return reply(403, { message: 'You may not remove anyone.' });
    const email = String(body.p_email || '').toLowerCase().trim();
    if (actor.email === email) return reply(400, { message: 'You cannot remove your own access.' });
    /* Remove means remove. The login goes, and profiles cascades from it, which
       is what leaves the address free for an ordinary first-time enrolment
       afterwards. Half-removing somebody is what made this impossible to undo
       from inside the app. The council's work is untouched: a task points at
       the directory entry, not at the login. */
    delete SB.enrolments[email];
    delete SB.users[email];
    Object.keys(SB.profiles).forEach((k) => {
      if (SB.profiles[k].email === email) delete SB.profiles[k];
    });
    return reply(200, true);
  }
  if (u.indexOf('/rest/v1/audit_log') === 0) return reply(200, []);

  return reply(404, { message: 'no route: ' + u });
};

const FILES = [
  'vendor/jspdf.umd.min.js', 'vendor/jspdf.plugin.autotable.min.js',
  'assets/js/util.js', 'assets/js/store.js', 'assets/js/ui.js', 'assets/js/report.js',
  'assets/js/asset-db.js', 'assets/js/camera.js', 'assets/js/accomplishment.js',
  'assets/js/accomplishment-pdf.js', 'assets/js/accomplishment-word.js',
  'assets/js/accomplishment-ui.js', 'assets/js/backend/config.js', 'assets/js/backend/backend.js',
  'assets/js/auth.js', 'assets/js/term-ui.js', 'assets/js/term-pdf.js', 'assets/js/letter-slip.js', 'assets/js/roster-pdf.js', 'assets/js/views/signin.js', 'assets/js/views/dashboard.js', 'assets/js/views/mytasks.js',
  'assets/js/views/directives.js', 'assets/js/views/events.js', 'assets/js/views/event-detail.js',
  'assets/js/views/letters.js', 'assets/js/views/letter-detail.js',
  'assets/js/views/settings.js', 'assets/js/forms.js', 'assets/js/app.js'
];

(async function main() {
  /* config.js holds the council's real Supabase project. This suite is about
     what the driver does, so it supplies its own credentials at each step and
     must start from nothing — otherwise the first assertion below would be
     testing a deployment file rather than the code. */
  const TEST_CONFIG = "window.FCU_BACKEND = { driver: 'supabase', " +
    "supabase: { url: '', anonKey: '' }, appsscript: { url: '' } };";

  FILES.forEach((f) => {
    const s = window.document.createElement('script');
    s.textContent = f === 'assets/js/backend/config.js'
      ? TEST_CONFIG
      : fs.readFileSync(path.join(ROOT, f), 'utf8');
    window.document.head.appendChild(s);
  });
  window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));

  const { Backend, Auth, Store } = window;

  /* Every suite now stubs config.js, which means nothing would notice if the
     real one were emptied — and an empty config.js is a live site with its front
     door wedged open, showing whatever happens to be on the visitor's device.
     So the deployed file is read here as text and checked for what it must hold. */
  console.log('\n--- the deployed credentials ---');
  {
    const cfg = fs.readFileSync(path.join(ROOT, 'assets/js/backend/config.js'), 'utf8');
    const url = (cfg.match(/url:\s*'([^']*)'/) || [])[1] || '';
    const key = (cfg.match(/anonKey:\s*'([^']*)'/) || [])[1] || '';
    check('a project URL is deployed', /^https:\/\/[a-z0-9]+\.supabase\.co$/.test(url), url);
    check('and a publishable key with it', key.length > 20, key.slice(0, 24) + '…');
    check('the driver is supabase', /driver:\s*'supabase'/.test(cfg));
    /* The one that would matter. A secret key in a page students can read hands
       every row in the Republic to anyone who opens the developer tools. */
    check('no secret key is anywhere in the page',
      !/sb_secret_|service_role/.test(cfg));
  }

  console.log('\n--- before anything is configured ---');
  check('with no credentials the app falls back to local', Backend.isFallback());
  check('and still runs, treating this device as national',
    await Auth.signIn('', '').then(() => Auth.isNational()));
  await Auth.signOut();

  // Point the app at the stand-in.
  Backend.config.supabase.url = SB.url;
  Backend.config.supabase.anonKey = SB.anonKey;
  check('once the two values are in, Supabase is live', !Backend.isFallback());
  check('and it is Supabase that answers', Backend.driverName() === 'Supabase');

  /* ---------------- the founding officer ---------------- */
  console.log('\n--- the founding national officer ---');
  // Set up by hand in the SQL editor, exactly as backend/SETUP.md describes.
  SB.users['president@filamer.edu.ph'] = { id: 'user-pres', password: 'presidentpass' };
  SB.profiles['user-pres'] = {
    id: 'user-pres', email: 'president@filamer.edu.ph', full_name: 'Althea Ramirez',
    position: 'President', unit_id: NAT, access: 'officer', is_head: true, active: true,
    units: units[0]
  };

  await Auth.signIn('president@filamer.edu.ph', 'presidentpass');
  check('the president signs in', Auth.signedIn());
  check('and is read as a national officer', Auth.isNational() && !Auth.isVolunteer());
  check('under the right name', Auth.current().name === 'Althea Ramirez');
  check('and the right unit', Auth.current().unitName === 'FCUSR Nationals');

  const wrong = await Auth.signIn('president@filamer.edu.ph', 'not-the-password')
    .then(() => null, (e) => e.message);
  check('a wrong password is refused', !!wrong, wrong || 'it was accepted');

  /* ---------------- who am I ---------------- */
  console.log('\n--- asking who is signed in ---');
  await Auth.signIn('president@filamer.edu.ph', 'presidentpass');
  // A national may read every profile in the Republic. Asking without naming
  // yourself is how you end up signed in as whoever the database returns first.
  const whoCalls = SB.requests.filter((r) => r.url.indexOf('/rest/v1/profiles?') === 0);
  check('the profile is asked for by id, never "the first row"',
    whoCalls.length > 0 && whoCalls.every((r) => /id=eq\./.test(r.url)),
    whoCalls.map((r) => r.url).join(' '));

  /* ---------------- enrolling a volunteer ---------------- */
  console.log('\n--- enrolling someone who has never signed in ---');
  const nurseEvent = 'event-cn-1';
  await Backend.enrol({
    email: 'Rhea.Solis@filamer.edu.ph', full_name: 'Rhea Solis',
    position: 'Logistics Volunteer', unit_id: CN, access: 'volunteer',
    eventIds: [nurseEvent]
  });
  check('the enrolment is recorded against the address',
    !!SB.enrolments['rhea.solis@filamer.edu.ph']);
  check('no login exists yet', !SB.users['rhea.solis@filamer.edu.ph']);
  check('and no profile has been invented',
    !Object.keys(SB.profiles).some((k) => SB.profiles[k].email === 'rhea.solis@filamer.edu.ph'));
  check('the events they may help with travel with the enrolment',
    SB.enrolments['rhea.solis@filamer.edu.ph'].event_ids[0] === nurseEvent);

  const pending = await Backend.pending();
  check('and it shows as waiting until they claim it',
    pending.some((p) => p.email === 'rhea.solis@filamer.edu.ph'));

  /* ---------------- claiming it ---------------- */
  console.log('\n--- that person sets their own password ---');
  await Auth.signOut();
  await Auth.signUp('rhea.solis@filamer.edu.ph', 'nursingpower');
  check('signing up gets them in', Auth.signedIn());
  check('as a volunteer, not an officer', Auth.isVolunteer() && !Auth.isNational());
  check('in the unit the executive chose, not one they picked',
    Auth.current().unitName === 'College of Nursing');
  check('carrying the activity they were taken on for',
    Auth.current().eventIds.indexOf(nurseEvent) >= 0);
  check('the password is their own — the app never held it',
    SB.users['rhea.solis@filamer.edu.ph'].password === 'nursingpower');

  /* ---------------- a stranger ---------------- */
  console.log('\n--- somebody nobody enrolled ---');
  await Auth.signOut();
  const stranger = await Auth.signUp('random.person@gmail.com', 'letmein12345')
    .then(() => null, (e) => e.message);
  check('can make a login and still get nothing', !!stranger);
  check('and is told plainly why', /enrol/i.test(stranger || ''), stranger || '');
  check('and that their password is not the problem',
    /password is set and it works/i.test(stranger || ''), stranger || '');
  check('no profile was created for them',
    !Object.keys(SB.profiles).some((k) => SB.profiles[k].email === 'random.person@gmail.com'));
  check('so the app does not consider them signed in', !Auth.signedIn());

  /* ---------------- a volunteer cannot enrol ---------------- */
  console.log('\n--- a volunteer tries to enrol somebody ---');
  await Auth.signIn('rhea.solis@filamer.edu.ph', 'nursingpower');
  const refused = await Backend.enrol({
    email: 'friend@filamer.edu.ph', full_name: 'A Friend', position: 'President',
    unit_id: NAT, access: 'officer', eventIds: []
  }).then(() => null, (e) => e.message);
  check('the server refuses, whatever the app would have allowed', !!refused, refused || '');
  check('no account appeared', !SB.enrolments['friend@filamer.edu.ph']);
  check('and a grand-sounding position changed nothing',
    Auth.isVolunteer() && !Auth.isExecutive());

  /* ---------------- refreshing the page ---------------- */
  console.log('\n--- the page is refreshed ---');
  await Auth.signIn('president@filamer.edu.ph', 'presidentpass');
  const stored = window.localStorage.getItem('fcusr.tracker.sb');
  check('the session is kept on the device, not only in memory', !!stored);
  check('with a refresh token to renew it', !!JSON.parse(stored || '{}').refresh);

  // What a reload does: the module's variables are gone, the storage is not.
  Backend.use('supabase');
  check('memory is cleared, as a reload would', !Backend.session());
  const back = await Backend.restore();
  check('the session is picked back up', !!back && back.email === 'president@filamer.edu.ph');
  check('and it is a real one — the calls are authorised',
    SB.requests[SB.requests.length - 1].auth);

  /* ---------------- the hour runs out ---------------- */
  console.log('\n--- the token expires mid-meeting ---');
  const live = Backend.session();
  const oldToken = live.token;
  // Both sides age: the server stops honouring it, and the client knows it is due.
  SB.tokens[oldToken].expiresAt = Date.now() - 1000;
  live.expiresAt = Date.now() - 1000;
  const after = await Backend.units();
  check('the request still succeeds', Array.isArray(after) && after.length === 2);
  check('because the token was exchanged, not reused',
    Backend.session().token !== oldToken);
  check('and nobody was signed out', !!Backend.session().token);

  /* ---------------- a dead refresh token ---------------- */
  console.log('\n--- the refresh token is revoked too ---');
  const s2 = Backend.session();
  SB.tokens[s2.token].expiresAt = Date.now() - 1000;
  s2.expiresAt = Date.now() - 1000;
  delete SB.refreshes[s2.refresh];
  const dead = await Backend.units().then(() => null, (e) => e.message);
  check('the app does not pretend it is still signed in', !Backend.session() || !!dead);

  /* ---------------- signing out ---------------- */
  console.log('\n--- signing out ---');
  await Auth.signIn('president@filamer.edu.ph', 'presidentpass');
  await Auth.signOut();
  check('nothing is left in storage', !window.localStorage.getItem('fcusr.tracker.sb'));
  check('and the app knows nobody is signed in', !Auth.signedIn() && !Backend.session());

  /* ---------------- who can sign in ----------------
     Enrolling somebody is not the same as their having an account, and until
     this screen existed nothing said which of the two a name was. */
  console.log('\n--- who can sign in ---');
  {
    const D = window.document;
    await Auth.signIn('president@filamer.edu.ph', 'presidentpass');

    // Somebody enrolled who has never turned up.
    SB.enrolments['waiting.one@filamer.edu.ph'] = {
      full_name: 'Waiting One', position: 'Auditor',
      unit_id: CN, access: 'officer', event_ids: []
    };

    window.Forms.rosterList();
    await new Promise((r) => setTimeout(r, 80));
    const acc = D.querySelector('[data-acc]');
    const txt = () => acc.textContent.replace(/\s+/g, ' ');

    check('the list opens', !!acc, txt().slice(0, 70));
    check('it names the person who has not signed in', /Waiting One/.test(txt()));
    check('and says they are waiting', /Waiting to sign in/i.test(txt()));
    check('the ones with accounts are listed apart', /Has an account/.test(txt()));
    check('somebody who claimed theirs is on the signed-in side', /Rhea/.test(txt()));
    check('a waiting enrolment offers an invitation to send',
      !!acc.querySelector('[data-copy-one="waiting.one@filamer.edu.ph"]'));
    check('and the invitation carries the address, not a password', (() => {
      const msg = window.Forms.personalMessage('Waiting One', 'waiting.one@filamer.edu.ph');
      return /waiting\.one@filamer\.edu\.ph/.test(msg) && !/password[^.]*:/i.test(msg);
    })());
    check('you cannot remove yourself',
      !acc.querySelector('[data-remove="president@filamer.edu.ph"]'));

    /* Where an executive goes when somebody has forgotten theirs. Offered only
       for people who have actually signed in: a waiting enrolment has no
       account yet, so there is no password to set — they choose their own. */
    /* Enrolled as Rhea.Solis@… and listed as rhea.solis@… — the address is
       folded to lower case on the way in, and the server folds again before it
       matches, so neither the button nor the function cares how it was typed. */
    check('somebody with an account can be given a new password',
      !!acc.querySelector('[data-setpw="rhea.solis@filamer.edu.ph"]'),
      [...acc.querySelectorAll('[data-setpw]')]
        .map((b) => b.getAttribute('data-setpw')).join(', ') || 'none offered');
    check('a waiting enrolment is not offered one',
      !acc.querySelector('[data-setpw="waiting.one@filamer.edu.ph"]'));
    check('and you are not offered it on yourself',
      !acc.querySelector('[data-setpw="president@filamer.edu.ph"]'));

    /* The case a real officer was stuck in.

       Withdrawn under the old rules, which kept her account and deleted her
       enrolment; then enrolled again, which made a fresh enrolment nobody had
       claimed. Two lists, and she was in both — so she showed under "Waiting to
       sign in", where Set password is deliberately not offered because somebody
       waiting has no account to set one on. Except she had one. She had been
       signing in for months, and there was no screen anywhere that could reach
       her account.

       Her profile was also switched off, and the list only showed people who
       were switched on — so the row that could have explained it was not drawn
       at all. */
    SB.profiles['p-angel'] = {
      id: 'p-angel', email: 'angel@filamer.edu.ph', full_name: 'Angel Rutor',
      position: 'Senator', unit_id: NAT, access: 'officer', is_head: false,
      active: false, units: units.find((u) => u.id === NAT)
    };
    SB.users['angel@filamer.edu.ph'] = { id: 'p-angel', password: 'forgotten', email: 'angel@filamer.edu.ph' };
    SB.enrolments['angel@filamer.edu.ph'] = {
      email: 'angel@filamer.edu.ph', full_name: 'Angel Rutor', position: 'Senator',
      unit_id: NAT, access: 'officer', event_ids: []
    };
    await window.Forms.rosterList();
    await new Promise((r) => setTimeout(r, 80));
    const acc2 = [...D.querySelectorAll('.modal-backdrop')].pop();
    const txt2 = () => acc2.textContent.replace(/\s+/g, ' ');

    check('somebody re-enrolled over an existing account is shown once',
      (txt2().match(/Angel Rutor/g) || []).length === 1,
      (txt2().match(/Angel Rutor/g) || []).length + ' rows');
    check('and her password can be set, which is the whole point',
      !!acc2.querySelector('[data-setpw="angel@filamer.edu.ph"]'),
      [...acc2.querySelectorAll('[data-setpw]')]
        .map((b) => b.getAttribute('data-setpw')).join(', ') || 'none offered');
    check('she is not filed away as somebody waiting for an invitation',
      !acc2.querySelector('[data-copy-one="angel@filamer.edu.ph"]'));
    check('and the row says she cannot sign in, rather than saying nothing',
      /cannot sign in/i.test(txt2()), txt2().slice(0, 140));

    /* The screen was fixed; the list people actually file was not. It grouped
       waiting from one table and accounts from another, so she was printed
       twice in two sections that contradicted each other. A roster an adviser
       files has to say one thing, and the same thing the screen said. */
    const printed = window.Forms.asText
      ? window.Forms.asText({ pending: Object.keys(SB.enrolments).map((k) => SB.enrolments[k]),
                              roster: Object.keys(SB.profiles).map((k) => SB.profiles[k]) })
      : '';
    if (printed) {
      check('the downloaded list names her once, not twice',
        (printed.match(/Angel Rutor/g) || []).length === 1,
        (printed.match(/Angel Rutor/g) || []).length + ' times');
      check('and says she cannot sign in rather than leaving her out',
        /Angel Rutor[^\n]*CANNOT SIGN IN/.test(printed),
        (printed.split('\n').find((l) => /Angel/.test(l)) || 'not listed at all'));
    }

    delete SB.profiles['p-angel'];
    delete SB.users['angel@filamer.edu.ph'];
    delete SB.enrolments['angel@filamer.edu.ph'];
    acc2.remove();
    check('and the word is Remove, not Withdraw',
      !/Withdraw/.test(acc.innerHTML), 'the roster still says Withdraw');

    // Removing a waiting enrolment takes it away so nobody can claim it.
    const before = SB.requests.length;
    acc.querySelector('[data-remove="waiting.one@filamer.edu.ph"]')
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 20));
    D.querySelector('.modal-backdrop [data-ok]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 80));
    check('removing calls the server', SB.requests.length > before &&
      SB.requests.some((r) => /remove_member/.test(r.url)));
    check('the enrolment is gone', !SB.enrolments['waiting.one@filamer.edu.ph']);
    check('and the list refreshed without it', !/Waiting One/.test(txt()), txt().slice(0, 90));

    D.querySelectorAll('.modal-backdrop').forEach((e) => e.remove());
  }

  /* ---------------- removed, then wanted back ----------------
     The failure a council actually hits. Somebody is taken off the list — they
     dropped the subject, or the address was wrong — and a week later they are
     back. Removing set active = false; enrolling never set it true again. So
     the executive enrolled them, was told it worked, saw them on the list, and
     they still could not sign in: the door said their account had been
     withdrawn, and there was nothing in the app that could undo it.

     Nothing tested this because nothing ever enrolled the same address twice. */
  console.log('\n--- somebody removed, then added back ---');
  {
    const email = 'returner@filamer.edu.ph';
    const uid = 'u-returner';
    SB.users[email] = { id: uid, password: 'returnerpass', email: email };
    SB.enrolments[email] = {
      email: email, full_name: 'Returner One', position: 'Senator',
      unit_id: NAT, access: 'officer', event_ids: []
    };
    claimEnrolment(SB.users[email]);

    check('they can sign in to begin with', !!(await Auth.signIn(email, 'returnerpass')));
    await Auth.signOut();

    await Auth.signIn('president@filamer.edu.ph', 'presidentpass');
    await Backend.remove(email);

    /* Remove means remove. Half-removing somebody — switching them off and
       leaving the login, the profile and the enrolment standing — is what made
       this impossible to undo: enrolling them again reported success and they
       still could not get in, and no screen in the app could put it right. */
    check('the account is gone', !SB.profiles[uid]);
    check('the login is gone', !SB.users[email]);
    check('and so is the enrolment', !SB.enrolments[email]);

    // The executive puts them back the only way the app offers: enrol again.
    await Backend.enrol({
      email: email, full_name: 'Returner One', position: 'Senator',
      unit_id: NAT, access: 'officer', eventIds: []
    });
    await Auth.signOut();

    /* An ordinary first day. The address has no account, so the door refuses
       the old password and offers to set a new one — which is exactly the path
       somebody enrolled for the first time takes. */
    let refused = false;
    try { await Auth.signIn(email, 'returnerpass'); } catch (e) { refused = !!e.badCredentials; }
    check('the old password is not still lying around', refused);

    const back = await Auth.signUp(email, 'a-fresh-start');
    check('setting a new one lets them in', !!back && Auth.signedIn(),
      'still locked out after being added back');
    check('and they come back as who they were enrolled as',
      Auth.current().name === 'Returner One', Auth.current() && Auth.current().name);
    await Auth.signOut();
  }

  /* ---------------- a forgotten password ----------------
     There is no emailed link and deliberately so: sending mail needs a sender
     configured in Supabase, and without one that button only reports an error —
     which is exactly what this council got when they tried it. What a council
     has instead is an executive who sets a password and says it out loud. */
  console.log('\n--- an executive sets a forgotten password ---');
  {
    const email = 'forgetful@filamer.edu.ph';
    SB.users[email] = { id: 'u-forget', password: 'the-old-one', email: email };
    SB.enrolments[email] = {
      email: email, full_name: 'Forgetful One', position: 'Senator',
      unit_id: NAT, access: 'officer', event_ids: []
    };
    claimEnrolment(SB.users[email]);
    await Auth.signOut();

    /* A volunteer must not be able to set anybody's password. This is the whole
       weight of the feature: whoever can call it can set a password and then
       sign in as that person. */
    const vol = 'helper@filamer.edu.ph';
    SB.users[vol] = { id: 'u-helper', password: 'helperpass', email: vol };
    SB.enrolments[vol] = {
      email: vol, full_name: 'Helper One', position: '', unit_id: NAT,
      access: 'volunteer', event_ids: []
    };
    claimEnrolment(SB.users[vol]);
    await Auth.signIn(vol, 'helperpass');
    let stopped = false;
    try { await Auth.setMemberPassword(email, 'not-your-place'); }
    catch (e) { stopped = true; }
    check('a volunteer cannot set anybody\u2019s password', stopped);
    check('and the password is untouched', SB.users[email].password === 'the-old-one');
    await Auth.signOut();

    await Auth.signIn('president@filamer.edu.ph', 'presidentpass');
    let tooShort = false;
    try { await Auth.setMemberPassword(email, 'short'); } catch (e) { tooShort = true; }
    check('a password under eight characters is refused', tooShort);

    let ownAccount = false;
    try { await Auth.setMemberPassword('president@filamer.edu.ph', 'sneaky-one'); }
    catch (e) { ownAccount = true; }
    check('and you cannot use it on your own account', ownAccount);

    // Switched off, the way somebody withdrawn under the old rules is.
    SB.profiles['u-forget'].active = false;
    await Auth.setMemberPassword(email, 'a-brand-new-one');
    check('the executive sets it', SB.users[email].password === 'a-brand-new-one');
    check('and it switches the account back on, or the button is a lie',
      SB.profiles['u-forget'].active === true);
    await Auth.signOut();

    check('the old password no longer works', await (async () => {
      try { await Auth.signIn(email, 'the-old-one'); return false; } catch (e) { return true; }
    })());
    check('and the new one does', !!(await Auth.signIn(email, 'a-brand-new-one')));
    await Auth.signOut();
  }

  /* ---------------- the site ahead of its database ----------------
     The fault that cost a council a day, and it was not in the database.

     Remove called remove_member and, when the database did not have it yet,
     quietly called withdraw_member instead so that "something" happened.
     withdraw_member is the OLD behaviour: it switches a person off and leaves
     the account, the profile and everything else standing. So Remove reported
     success, the person stayed on the list, and nothing anywhere said the
     database was a step behind. The executive did the right thing four times
     and watched it not work.

     A missing function is said out loud now. Doing the old, broken thing
     quietly is worse than failing. */
  console.log('\n--- the site is ahead of its database ---');
  {
    await Auth.signIn('president@filamer.edu.ph', 'presidentpass');
    const email = 'stranded@filamer.edu.ph';
    SB.users[email] = { id: 'u-stranded', password: 'somepass', email: email };
    SB.enrolments[email] = {
      email: email, full_name: 'Stranded One', position: 'Senator',
      unit_id: NAT, access: 'officer', event_ids: []
    };
    claimEnrolment(SB.users[email]);

    // A database that has not had remove.sql run on it yet.
    SB.missing = ['remove_member', 'set_member_password'];

    let removeErr = null;
    try { await Backend.remove(email); } catch (e) { removeErr = e; }
    check('removing says the setup step is missing', !!(removeErr && removeErr.setupMissing),
      removeErr && removeErr.message);
    check('and it names the file to run',
      !!removeErr && /remove\.sql/.test(removeErr.message), removeErr && removeErr.message);
    check('and it did NOT quietly switch them off instead',
      SB.profiles['u-stranded'] && SB.profiles['u-stranded'].active === true,
      'the old behaviour ran behind the executive\u2019s back');
    check('nor delete their enrolment behind the scenes', !!SB.enrolments[email]);

    let pwErr = null;
    try { await Auth.setMemberPassword(email, 'a-new-password'); } catch (e) { pwErr = e; }
    check('setting a password says the same thing', !!(pwErr && pwErr.setupMissing),
      pwErr && pwErr.message);
    check('and the password was left alone', SB.users[email].password === 'somepass');

    // With the file run, both work.
    SB.missing = [];
    await Auth.setMemberPassword(email, 'a-new-password');
    check('once the file is run, setting a password works',
      SB.users[email].password === 'a-new-password');
    await Backend.remove(email);
    check('and removing really removes', !SB.profiles['u-stranded'] && !SB.users[email]);
  }

  /* ---------------- turning up before you were enrolled ----------------
     The volunteer's trap, and the one a council hits most, because a volunteer
     is the person handed the link casually and told to sign up.

     A profile is made in one place only: the trigger that fires when a login is
     created, and only if an enrolment is already sitting there. So somebody who
     sets a password first gets a login and no profile. The executive then
     enrols them — and enroll_member updates profiles by email, which matches
     nothing, because there is no profile row to update. The enrolment is never
     claimed either, since claiming only happens when a login is created and
     theirs already exists.

     They sign in with the password they set, and are told to ask a national
     executive. Every time. The executive can see they did the right thing. */
  console.log('\n--- somebody who set a password before being enrolled ---');
  {
    const email = 'eager@filamer.edu.ph';
    await Auth.signOut();

    // Step one: they open the site first and set a password. Nobody has enrolled
    // them, so there is a login and nothing behind it.
    let told = '';
    try { await Auth.signUp(email, 'eagerpass'); } catch (e) { told = e.message || ''; }
    check('the login is made', !!SB.users[email]);
    check('but there is no account behind it yet',
      !Object.keys(SB.profiles).some((k) => SB.profiles[k].email === email));
    check('and they are told the password is fine, not that it failed',
      /password is set and it works/i.test(told), told.slice(0, 90));
    check('and told what is actually missing', /enrol/i.test(told));

    // Step two: the executive does exactly what they were asked to do.
    await Auth.signIn('president@filamer.edu.ph', 'presidentpass');
    await Backend.enrol({
      email: email, full_name: 'Eager Volunteer', position: 'Volunteer',
      unit_id: NAT, access: 'volunteer', eventIds: []
    });
    await Auth.signOut();

    check('enrolling them now makes the account',
      Object.keys(SB.profiles).some((k) => SB.profiles[k].email === email),
      'enrolling matched no profile row, so it did nothing at all');

    // Step three: they come back with the password they already chose.
    const back = await Auth.signIn(email, 'eagerpass').catch((e) => e.message);
    check('and the password they already chose lets them in',
      typeof back === 'object' && Auth.signedIn(),
      typeof back === 'string' ? back : 'not signed in');
    check('as the person they were enrolled as',
      Auth.signedIn() && Auth.current().name === 'Eager Volunteer',
      Auth.signedIn() ? Auth.current().name : '(nobody)');
    await Auth.signOut();
  }

  /* ---------------- moving somebody between offices ----------------
     A volunteer made a national officer, which is an ordinary thing a council
     does and something the app could not do at all.

     What somebody IS was never asked. It was implied by whichever form got
     opened: the person form always enrolled an officer, the helper form always
     enrolled a volunteer, the roster import always enrolled an officer. So an
     executive promoting a volunteer changed the account and left the directory
     still saying volunteer — and if they then put that person on an activity,
     the helper form sent them quietly back down to volunteer again. The person
     found out by signing in to the wrong app. */
  console.log('\n--- a volunteer made an officer ---');
  {
    await Auth.signIn('president@filamer.edu.ph', 'presidentpass');
    const email = 'helper@filamer.edu.ph';

    await Backend.enrol({
      email: email, full_name: 'Helper One', position: 'Committee member',
      unit_id: CN, access: 'volunteer', eventIds: []
    });
    check('they start as a volunteer',
      SB.enrolments[email] && SB.enrolments[email].access === 'volunteer',
      SB.enrolments[email] && SB.enrolments[email].access);

    // The executive moves them up, which is what the form now actually sends.
    await Backend.enrol({
      email: email, full_name: 'Helper One', position: 'Senator',
      unit_id: NAT, access: 'officer', eventIds: []
    });
    check('the account says officer afterwards',
      SB.enrolments[email].access === 'officer', SB.enrolments[email].access);
    check('and in the National government',
      SB.enrolments[email].unit_id === NAT);

    /* And when they open the app they are one. This is the part that was
       failing on a real phone: the account changed and the screens did not. */
    SB.users[email] = { id: 'u-helper', password: 'helperpass', email: email };
    claimEnrolment(SB.users[email]);
    await Auth.signOut();
    const who = await Auth.signIn(email, 'helperpass');
    check('they are greeted as an officer, not a volunteer',
      !!who && !Auth.isVolunteer(), 'still the volunteer interface');
    /* The profile carries the National unit. myUnitId() maps that onto the unit
       this device knows, and this suite never syncs, so it lands on the local
       National one — which is the same place. What matters is that the app now
       treats them as national rather than as a college's helper. */
    check('and the app treats them as national', Auth.isNational(),
      'the account says officer but the app does not see a national officer');

    /* Somebody already signed in when the change is made. The app used to read
       this once, at sign-in, so they kept the old screens until they thought to
       close the tab — with nothing suggesting they should. */
    SB.profiles['u-helper'].access = 'volunteer';
    const changed = await Auth.refresh();
    check('a change made while they are signed in is noticed', changed === true);
    check('and takes effect without closing the tab', Auth.isVolunteer());

    SB.profiles['u-helper'].access = 'officer';
    check('and back again', (await Auth.refresh()) === true && !Auth.isVolunteer());
    await Auth.signOut();
  }

  /* ---------------- leaving a shared computer ----------------
     A council runs on the library PC and the org room laptop. Signing out has
     to take the council's work with it, or the next person to sign in opens the
     app onto somebody else's units — syncing only ever adds and updates, and
     never removes what they should not be seeing. */
  console.log('\n--- signing out clears the computer ---');
  {
    const D = window.document;
    await Auth.signIn('president@filamer.edu.ph', 'presidentpass');
    check('signed in to begin with', Auth.signedIn());

    window.Store.addEvent({ title: 'Left behind', unitId: window.Store.nationalUnitId() });
    check('and the device is holding work', window.Store.events().length > 0);

    // Sync is not loaded in this suite, so sign-out has nothing to send through
    // and clears on its own terms; that is the path a browser without it takes.
    await Auth.signOut();
    check('the session is gone', !Auth.signedIn());
    check('there is a way out at all', typeof Auth.signOut === 'function');

    // And somebody else signing in on the same computer does not inherit it.
    window.Store.addEvent({ title: 'Someone else\u2019s', unitId: window.Store.nationalUnitId() });
    const before = window.Store.events().length;
    Auth.adopt({ id: 'a-different-person', email: 'other@filamer.edu.ph',
      full_name: 'Another Officer', unit_id: window.Store.nationalUnitId(),
      unit_name: 'FCUSR Nationals', unit_kind: 'national', access: 'officer' });
    check('a different account does not inherit the last one\u2019s work',
      window.Store.events().length < before || before === 0,
      before + ' → ' + window.Store.events().length);
    await Auth.signOut();
  }

  /* ---------------- the doorstep ----------------
     A session is read out of localStorage instantly and trustingly. Confirming
     it with the backend takes a moment, and the app used to draw the Republic
     during that moment on the strength of a name in browser storage — so a
     lapsed session, or a phone picked up by somebody else, got a look at the
     council's work before being asked who they were. */
  console.log('\n--- before the session is confirmed ---');
  {
    const D = window.document;
    const view = () => D.getElementById('view');
    const txt = () => view().textContent.replace(/\s+/g, ' ');

    await Auth.signOut();
    // A name this device remembers, of the kind a lapsed session leaves behind.
    window.localStorage.setItem('fcusr.tracker.me', JSON.stringify({
      id: 'ghost', email: 'someone@filamer.edu.ph', name: 'Someone', access: 'officer',
      unitId: window.Store.nationalUnitId(), unitName: 'FCUSR Nationals', unitKind: 'national'
    }));

    const pending = Auth.resume();
    check('the app does not yet claim to know who this is', !Auth.settled());
    window.App.render();
    check('so neither the Republic nor the sign-in form is drawn',
      !/Needs attention/.test(txt()) && !D.querySelector('[data-mode]'), txt().slice(0, 70));
    check('it says what it is doing instead', /checking your sign-in/i.test(txt()), txt().slice(0, 70));
    check('and the navigation stays hidden', D.body.classList.contains('is-gated'));

    await pending;
    check('once the backend has answered, the app has settled', Auth.settled());
    check('and a session it would not confirm is not honoured', !Auth.signedIn());
    window.App.render();
    check('now the door is shown', !!D.querySelector('.gate-card') &&
      !/checking your sign-in/i.test(txt()));

    /* Nothing the app wants to announce may be announced to a stranger. The
       closing date and what the unit still owes were being said at boot,
       before anyone had been asked who they were. */
    check('and no notice was put in front of them',
      !D.querySelector('.modal-backdrop'),
      (D.querySelector('.modal-backdrop') || { textContent: '' }).textContent.slice(0, 60));
  }

  /* ---------------- the front door ---------------- */
  console.log('\n--- the gate ---');
  {
    const D = window.document;
    const view = () => D.getElementById('view');
    const txt = () => view().textContent.replace(/\s+/g, ' ');

    await Auth.signOut();
    window.App.render();
    check('signed out, the app shows the door instead', !!D.querySelector('.gate-card'), txt().slice(0, 60));
    check('and not the Overview', !/Needs attention/.test(txt()));
    check('the navigation goes with it', D.body.classList.contains('is-gated'));
    check('one form, not a choice of two', D.querySelectorAll('[data-mode]').length === 0);
    check('and it asks for both halves',
      !!D.querySelector('#gate-email') && !!D.querySelector('#gate-pass'));

    // A bad address never reaches the network.
    const before = SB.requests.length;
    D.querySelector('#gate-email').value = 'not-an-address';
    D.querySelector('#gate-pass').value = 'whatever';
    D.querySelector('.gate-go').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    check('a malformed address is caught here', SB.requests.length === before);
    check('and it says so', /does not look right/i.test(txt()), txt().slice(0, 80));

    /* ---- an address that has never had a password ----
       The door must not report this as a bad password: it must stop the person
       and make them set one, with no way past the dialog. */
    SB.enrolments['newbie@filamer.edu.ph'] = {
      full_name: 'Newbie Officer', position: 'Secretary',
      unit_id: CN, access: 'officer', event_ids: []
    };
    D.querySelector('#gate-email').value = 'newbie@filamer.edu.ph';
    D.querySelector('#gate-pass').value = 'whatever-they-typed';
    D.querySelector('.gate-go').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));

    const ftDialog = () => {
      const f = D.querySelector('#ft-a');
      return f ? f.closest('.modal-backdrop') : null;
    };
    const dlg = ftDialog();
    check('a first sign-in is stopped and asked for a password', !!dlg);
    check('and it is not signed in yet', !Auth.signedIn());
    check('it offers no corner to escape through', !dlg.querySelector('.modal-head [data-close]'));
    check('the dialog cannot be clicked away', (() => {
      dlg.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
      return !!ftDialog();
    })());
    check('nor pressed away', (() => {
      D.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return !!ftDialog();
    })());

    // Too short, and the two must agree.
    D.querySelector('#ft-a').value = 'short';
    D.querySelector('#ft-b').value = 'short';
    dlg.querySelector('[data-go]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    check('a short password is refused', !SB.users['newbie@filamer.edu.ph']);
    D.querySelector('#ft-a').value = 'a-real-password';
    D.querySelector('#ft-b').value = 'a-real-passwrod';
    dlg.querySelector('[data-go]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    check('and so is a mistyped repeat', !SB.users['newbie@filamer.edu.ph']);

    D.querySelector('#ft-b').value = 'a-real-password';
    dlg.querySelector('[data-go]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
    check('setting one claims the enrolment', !!SB.users['newbie@filamer.edu.ph']);
    check('and lets them straight in', Auth.signedIn() && Auth.current().name === 'Newbie Officer');
    check('the dialog is gone', !ftDialog());
    check('and so is the door', !D.querySelector('.gate-card'));

    // A wrong password on an address that DOES have one is still a wrong password.
    await Auth.signOut();
    window.App.render();
    D.querySelector('#gate-email').value = 'newbie@filamer.edu.ph';
    D.querySelector('#gate-pass').value = 'not-it';
    D.querySelector('.gate-go').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
    const dlg2 = ftDialog();
    D.querySelector('#ft-a').value = 'another-password';
    D.querySelector('#ft-b').value = 'another-password';
    dlg2.querySelector('[data-go]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
    check('a claimed address cannot be re-claimed',
      SB.users['newbie@filamer.edu.ph'].password === 'a-real-password');
    /* This used to end here, with a sentence saying the address already had a
       password and nothing to do about it. The person standing at that message
       is nearly always somebody who has forgotten theirs, so they are handed
       the way out instead of the fact. */
    check('the dead end is gone', !ftDialog());
    const fp = [...D.querySelectorAll('.modal-backdrop')]
      .find((m) => /forgotten password/i.test(m.textContent));
    check('and it says what to do instead', !!fp);
    check('which is to ask an executive, naming where they do it',
      fp && /national executive/i.test(fp.textContent) && /Set password/i.test(fp.textContent),
      fp && fp.textContent.replace(/\s+/g, ' ').slice(0, 110));

    fp.querySelector('[data-close]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 30));
    check('closing it leaves you at the door, not inside',
      !Auth.signedIn() && !!D.querySelector('.gate-card'));

    // The real thing.
    D.querySelector('#gate-email').value = 'president@filamer.edu.ph';
    D.querySelector('#gate-pass').value = 'presidentpass';
    D.querySelector('.gate-go').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
    check('a good sign-in opens the app', Auth.signedIn());
    check('the door is gone', !D.querySelector('.gate-card'));
    check('and the navigation is back', !D.body.classList.contains('is-gated'));

    // Offline there is nothing to sign in to, so the door must not stand.
    const url = Backend.config.supabase.url;
    Backend.config.supabase.url = '';
    await Auth.signOut();
    window.App.render();
    check('with no backend the app opens straight in', !D.querySelector('.gate-card'));
    Backend.config.supabase.url = url;
  }

  /* ---------------- the anon key is never the credential ---------------- */
  console.log('\n--- what actually goes over the wire ---');
  check('every call carries the project key', SB.requests.length > 0);
  /* Passwords go to Supabase Auth and to exactly one other place: the function
     an executive uses to set somebody's when they have forgotten it. There is
     no way to do that without sending it once — it has to reach the server to
     be hashed — and naming that one destination here is the point. Anything
     else carrying a password is a leak, and this is what would say so. */
  const PASSWORD_MAY_GO_TO = ['/auth/v1/', '/rest/v1/rpc/set_member_password'];
  const carried = SB.requests.filter((r) => /password|signup/.test(JSON.stringify(r)));
  check('a password is only ever sent where one has to be',
    carried.every((r) => PASSWORD_MAY_GO_TO.some((ok) => r.url.indexOf(ok) === 0)),
    carried.filter((r) => !PASSWORD_MAY_GO_TO.some((ok) => r.url.indexOf(ok) === 0))
      .map((r) => r.url).join(', '));
  check('and setting one for somebody else really did go over the wire',
    carried.some((r) => r.url.indexOf('/rest/v1/rpc/set_member_password') === 0));

  /* ---------------- the page ships closed ----------------
   The tab bar, the search and the settings button are markup in index.html,
   not something a script draws. Before this, <body> carried no class, so all
   three were on screen from the moment the file was parsed and only went away
   once app.js had run and decided nobody was signed in. On a slow phone that
   is a visible flash of the Republic's shell to a stranger; if a script is
   blocked outright it is not a flash at all, it is the state the page stays
   in. Closed by default, opened by script, is the way round that fails safe. */
console.log('\n--- the page ships closed ---');
{
  const html = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'index.html'), 'utf8');
  const body = (html.match(/<body[^>]*>/) || [''])[0];
  check('index.html starts gated', /class="[^"]*\bis-gated\b/.test(body), body);

  const css = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'assets', 'css', 'app.css'), 'utf8');
  ['\\.tabs', '#btn-search', '#btn-settings'].forEach((sel) => {
    check('and being gated hides ' + sel.replace('\\', ''),
      new RegExp('body\\.is-gated\\s+' + sel).test(css));
  });

  // And the app must still be able to open it, or nobody ever gets in.
  const app = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'assets', 'js', 'app.js'), 'utf8');
  check('and app.js takes the class off once somebody is signed in',
    /classList\.remove\('is-gated'\)/.test(app));
}

console.log('\n========================================');
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.log('\nCRASHED: ' + e.message);
  console.log(e.stack);
  process.exit(1);
});
