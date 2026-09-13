/* Full UI walk-through in jsdom — no browser window needed.
       npm install jsdom        (once)
       node tests/run-ui.js
*/
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const errors = [];
const results = [];
const check = (name, cond, extra = '') => {
  results.push({ name, pass: !!cond, extra });
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (extra ? '   — ' + extra : ''));
};

const vc = new VirtualConsole();
vc.on('jsdomError', (e) => errors.push('jsdomError: ' + (e.detail || e).toString().split('\n')[0]));
vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));

const dom = new JSDOM(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'), {
  url: 'http://localhost/index.html', runScripts: 'dangerously',
  virtualConsole: vc, pretendToBeVisual: true
});
const { window } = dom;

const FILES = [
  'vendor/jspdf.umd.min.js', 'vendor/jspdf.plugin.autotable.min.js',
  'assets/js/util.js', 'assets/js/store.js', 'assets/js/ui.js', 'assets/js/report.js',
  'assets/js/asset-db.js', 'assets/js/camera.js', 'assets/js/accomplishment.js', 'assets/js/accomplishment-pdf.js',
  'assets/js/accomplishment-word.js', 'assets/js/accomplishment-ui.js', 'assets/js/backend/config.js', 'assets/js/backend/backend.js', 'assets/js/auth.js', 'assets/js/term-ui.js', 'assets/js/term-pdf.js',
  'assets/js/letter-slip.js', 'assets/js/roster-pdf.js', 'assets/js/views/signin.js', 'assets/js/views/dashboard.js', 'assets/js/views/mytasks.js', 'assets/js/views/directives.js', 'assets/js/views/events.js',
  'assets/js/views/event-detail.js',
  'assets/js/views/letters.js', 'assets/js/views/letter-detail.js', 'assets/js/views/settings.js',
  'assets/js/forms.js', 'assets/js/app.js'
];

/* The app reads its backend credentials from config.js, which now holds a live
   Supabase project — and a configured backend changes how the whole app behaves:
   the front door stands, and nobody sees anything until they sign in. A test
   suite must not inherit that from a deployment file. It decides the mode it is
   testing, so this stands in for config.js and the walk-through below runs the
   way a council runs it before Supabase is connected. The gate is tested on its
   own, further down, by switching the credentials on at runtime. */
const TEST_CONFIG = "window.FCU_BACKEND = { driver: 'supabase', " +
  "supabase: { url: '', anonKey: '' }, appsscript: { url: '' } };";

window.HTMLCanvasElement.prototype.getContext = () => null;
window.scrollTo = () => {};
window.Element.prototype.scrollIntoView = function () {};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async function main() {
console.log('--- boot ---');
try {
  FILES.forEach((f) => {
    const s = window.document.createElement('script');
    s.textContent = f === 'assets/js/backend/config.js'
      ? TEST_CONFIG
      : fs.readFileSync(path.join(ROOT, f), 'utf8');
    window.document.head.appendChild(s);
  });
  if (window.document.readyState === 'loading') {
    window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));
  }
  // The app opens empty; the walk-through needs a council to walk through.
  window.Store._seedRehearsal();
  window.App.render();
  check('all scripts evaluated', true);
  /* Nothing greets anybody at the door any more. The app used to open on an
     invented council and a notice explaining it; both are gone. */
  check('no rehearsal notice on arrival',
    !window.document.querySelector('.modal-backdrop'));
  window.document.querySelectorAll('.modal-backdrop [data-close]').forEach((b) =>
    b.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    check('and the screen is clear', !window.document.querySelector('.modal-backdrop'));
  /* This sandbox has no fetch() and no IndexedDB, which is the point: start-up
     must not depend on either. Loading the council seal for the report header
     once threw here and took the whole boot with it — no screen was wired at
     all — so a browser that blocks or lacks an API has to cost a picture, never
     the app. */
  check('boots where fetch() does not exist', typeof window.fetch !== 'function');
  check('and the app still came up', !!window.App && !!window.Store);
} catch (e) {
  check('all scripts evaluated', false, e.message);
  console.log(e.stack);
  process.exit(1);
}

const D = window.document;
const $ = (s) => D.querySelector(s);
const $$ = (s) => Array.from(D.querySelectorAll(s));
const view = () => $('#view');
const text = () => view().textContent.replace(/\s+/g, ' ');
const S = window.Store;

const goto = (h) => { window.location.hash = h; window.dispatchEvent(new window.Event('hashchange')); };
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
const setValue = (el, v) => {
  el.value = v;
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
  el.dispatchEvent(new window.Event('change', { bubbles: true }));
};

check('booted with a rendered view', view().children.length > 0);
check('no errors on boot', errors.length === 0, errors.join(' | '));

/* ---------------- the front door ----------------
   Offline there is nothing to authenticate against and a password box would be
   theatre, so the app opens straight in. Connect a backend and the door stands.
   Both are real states of this app — a council runs offline until Supabase is
   wired — so both are checked here by switching the credentials at runtime. */
console.log('\n--- the gate ---');
check('offline, the app opens without asking', !$('.gate-card') && !!$('#view').children.length);
check('and it knows it is offline', window.Auth.isOffline());

const CFG = window.Backend.config.supabase;
CFG.url = 'https://example.supabase.co';
CFG.anonKey = 'sb_publishable_test';
window.App.render();
check('with a backend connected the door stands', !!$('.gate-card'));
check('the shell is hidden behind it', D.body.classList.contains('is-gated'));
check('and the Republic\'s work is not on screen', !$('.photo-hero'));
check('the sign-in card is the whole screen', !!$('.gate .gate-card'));

CFG.url = '';
CFG.anonKey = '';
window.App.render();
check('and it opens again once the backend is gone', !$('.gate-card') &&
  !D.body.classList.contains('is-gated'));

/* ---------------- scroll regressions ---------------- */
console.log('\n--- scroll behaviour ---');
const css = fs.readFileSync(path.join(ROOT, 'assets/css/app.css'), 'utf8');
const uiSrc = fs.readFileSync(path.join(ROOT, 'assets/js/ui.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(ROOT, 'assets/js/app.js'), 'utf8');

check('no overflow-x wrapper around sticky headers', !/\.table-wrap/.test(css));
check('tasks are rows, not wide tables', $$('.task').length > 0 && $$('table').length === 0);
check('menu closes on page scroll only, not nested scroll',
  !/addEventListener\('scroll',\s*closeMenu,\s*true\)/.test(uiSrc) &&
  /addEventListener\('scroll',\s*closeMenu\)/.test(uiSrc));
check('menu is position:fixed', /\.menu\s*{[^}]*position:\s*fixed/.test(css));
check('scroll lock is a class on <html>', /is-locked/.test(uiSrc) && !/body\.style\.overflow/.test(uiSrc));
check('lock rule covers html and body',
  /html\.is-locked,\s*html\.is-locked body\s*{\s*overflow:\s*hidden/.test(css));
check('anchors clear the sticky bar', /scroll-padding-top:/.test(css));
check('sticky chrome is one 48px strip', /--nav-h:\s*48px/.test(css));
check('header-measuring JS removed', !/measureHeader/.test(appSrc));

const htmlEl = D.documentElement;
check('not locked at rest', !htmlEl.classList.contains('is-locked'));
const c1 = window.UI.modal({ title: 'A', body: 'a' });
const c2 = window.UI.modal({ title: 'B', body: 'b' });
check('nested dialogs hold the lock', htmlEl.classList.contains('is-locked'));
c2();
check('inner close keeps the lock', htmlEl.classList.contains('is-locked'));
c1();
check('last close releases it', !htmlEl.classList.contains('is-locked'));
c1();
check('double close is safe', !htmlEl.classList.contains('is-locked'));

/* ---------------- security ---------------- */
console.log('\n--- security ---');
const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
check('a Content-Security-Policy is declared', /Content-Security-Policy/.test(indexHtml));
check('CSP blocks external and inline script',
  /default-src 'none'/.test(indexHtml) && /script-src 'self'/.test(indexHtml) &&
  !/script-src[^;]*unsafe-inline/.test(indexHtml));
check('no inline event handlers in the markup', !/\son[a-z]+=["']/.test(indexHtml));

// Markup in user text must render as text, never as elements.
const evilEvent = S.addEvent({ title: '<img src=x onerror=alert(1)>Pwn', dateStart: window.U.today() });
S.addTask({ eventId: evilEvent.id, title: '"><script>alert(1)</script>', dueDate: window.U.today() });
goto('#/events/' + evilEvent.id);
check('script tags in a title do not become elements', view().querySelectorAll('script, img').length === 0);
check('the text is shown literally, escaped', text().includes('<script>alert(1)</script>'));
check('no stray injected attributes',
  !view().innerHTML.includes('onerror=') || view().innerHTML.includes('onerror=alert(1)&gt;'));
S.deleteEvent(evilEvent.id);

// A hostile backup file must be neutralised, not trusted.
const good = S.toJSON();
S.fromJSON(JSON.stringify({ data: {
  people: [{ id: '" onmouseover="alert(1)', name: 'Bad Id' }],
  events: [{ id: 'evt_x', title: 'Ok', status: 'Nope', dateStart: '2026-02-31' }],
  tasks: [{ id: 'tsk_x', eventId: 'evt_x', title: 'T', status: 'Fake', priority: 'Nope' }],
  org: { emblem: 'javascript:alert(1)' }
} }));
check('hostile id is replaced with a safe one', /^[A-Za-z0-9_-]+$/.test(S.people()[0].id), S.people()[0].id);
check('impossible date is dropped', S.events()[0].dateStart === '');
check('bad enums fall back', S.events()[0].status === 'Upcoming' && S.tasks()[0].status === 'Not Started');
check('script-capable emblem rejected', S.org().emblem === '');
goto('#/settings');
check('restored hostile data renders without injecting', view().querySelectorAll('script').length === 0);
S.fromJSON(good);

/* ---------------- simplification ---------------- */
console.log('\n--- shape of the UI ---');
goto('#/dashboard');
check('3 summary pills, not 5 tiles', $$('.pill').length === 3);
/* The Overview is four blocks and stays four blocks: what needs attention, the
   letters worth chasing, how each unit is faring, and the events themselves.
   Counting raw lists broke the moment a block gained a fold, so name them. */
const heads = $$('.section-head h2').map((h) => h.textContent.replace(/\s+/g, ' ').trim());
check('Needs attention comes first', /^Needs attention/.test(heads[0]), heads.join(' | '));
check('Letters has its own block', heads.some((h) => /^Letters/.test(h)), heads.join(' | '));
/* The roll-up is a fold now, not a section heading — nine colleges listed in
   full pushed a phone's first screen away for information that usually needs no
   action. It states how things stand and opens when asked. */
check('Republic roll-up is there for a national', !!$('[data-toggle-republic]'));
check('and it starts closed', $('.roll').getAttribute('data-open') === 'false');
click($('[data-toggle-republic]'));
check('opening it shows the units', $('.roll').getAttribute('data-open') === 'true' &&
  $('.roll-body .list').children.length > 0);
click($('[data-toggle-republic]'));
check('and the events are last', /^Events/.test(heads[heads.length - 1]), heads.join(' | '));
check('five nav tabs', $$('.tab').length === 5);
check('Letters is one of them', $$('.tab').some((t) => t.getAttribute('data-route') === 'letters'));
goto('#/events');
check('no second search box', !$('#f-q'));
const foundation = S.events().find((e) => e.title.startsWith('Foundation'));
goto('#/events/' + foundation.id);
check('2 grouping options', $$('[data-group-by]').length === 2);
check('event admin behind one menu', !!$('[data-more]'));
S.setLastPerson(S.people()[0].id);
goto('#/my-tasks');
check('one segmented filter, no dropdown stack',
  $$('[data-filter]').length === 3 && !$('#f-status') && !$('#f-sort'));

/* ---------------- core flow ---------------- */
console.log('\n--- create event → add tasks ---');
const before = S.events().length;
goto('#/events');
click($('[data-create-event]'));
setValue($('#f-title'), 'General Assembly 2026');
setValue($('#f-dateStart'), window.U.addDays(window.U.today(), 20));
click($('[data-save]'));
check('event created', S.events().length === before + 1);
const created = S.events().find((e) => e.title === 'General Assembly 2026');
check('landed on the new event', window.location.hash === '#/events/' + created.id);
goto('#/events/' + created.id);
check('empty state invites the first task', text().includes('No tasks under this event yet'));
check('add form already open', !!$('#a-title'));

/* The people this activity may actually be assigned to: the unit that owns it,
   plus anyone taken on for it in particular. Not the whole Republic — a
   national officer should not scroll past nine colleges to find their own. */
const people = S.assignable(created.id);
['Book the auditorium', 'Prepare the agenda', 'Invite the deans'].forEach((t, i) => {
  setValue($('#a-title'), t);
  setValue($('#a-assignee'), people[i].id);
  click($('[data-save-task]'));
});
check('three tasks added in a row', S.tasks({ eventId: created.id }).length === 3);
check('form stays open', !!$('#a-title'));
check('title clears each time', $('#a-title').value === '');
check('assignee carries over', $('#a-assignee').value === people[2].id);
check('the picker offers this unit, not the Republic',
  people.length < S.people().length && people.every((p2) => p2.unitId === created.unitId),
  people.length + ' of ' + S.people().length);
check('and somebody from another college is not on offer',
  !$$('#a-assignee option').some((o) => {
    const p2 = S.person(o.value);
    return p2 && p2.unitId !== created.unitId;
  }));
check('task cannot exist outside an event',
  (() => { try { S.addTask({ title: 'x' }); return false; } catch (e) { return true; } })());

console.log('\n--- inline status editing ---');
const first = S.tasks({ eventId: created.id })[0];
click($$('[data-status-for]').find((c) => c.getAttribute('data-status-for') === first.id));
check('status menu opens', !!$('.menu'));
check('five statuses offered', $$('.menu button').length === 5);
click($$('.menu button').find((b) => b.getAttribute('data-set') === 'Done'));
check('saved with no modal', S.task(first.id).status === 'Done');
check('completedAt stamped', !!S.task(first.id).completedAt);
check('done tasks drop the countdown chip',
  !window.UI.taskRow(S.task(first.id), []).includes('days late'));

const second = S.tasks({ eventId: created.id })[1];
click($$('[data-status-for]').find((c) => c.getAttribute('data-status-for') === second.id));
click($$('.menu button').find((b) => b.getAttribute('data-set') === 'On hold'));
check('on hold asks why', !!$('#blk'));
setValue($('#blk'), 'Waiting for the adviser.');
click($('[data-ok]'));
await sleep(10);
check('reason stored', S.task(second.id).blockedReason === 'Waiting for the adviser.');

console.log('\n--- grouping and event menu ---');
goto('#/events/' + created.id);
click($('[data-group-by="assignee"]'));
check('group by person', $$('.group').length > 1);
check('group headers carry counts', /\d+ of \d+ done/.test(text()));
click($('[data-group-by="flat"]'));
click($('[data-more]'));
check('⋯ menu opens with 3 actions', $$('.menu button').length === 3);
click($$('.menu button').find((b) => b.getAttribute('data-set') === 'archive'));
check('archive works', S.event(created.id).status === 'Archived');
S.updateEvent(created.id, { status: 'Upcoming' });

console.log('\n--- my tasks ---');
S.setLastPerson('');
goto('#/my-tasks');
check('asks for a name', text().includes('Select your name'));
setValue($('#person-select'), people[0].id);
check('remembered on this device', S.lastPerson() === people[0].id);
goto('#/my-tasks');
check('shows the person', text().includes(people[0].name));
check('grouped by event', $$('.group').length >= 1);

console.log('\n--- access control ---');
const Auth = window.Auth;

// Nobody signed in: Settings refuses to open.
goto('#/settings');
check('Settings is closed to a stranger', !$('[data-add-person]') && !!$('#ask-exec'));

// Signing in offline treats you as a national executive.
await Auth.signIn('', '');
check('an executive is recognised', Auth.isExecutive() === true);
goto('#/settings');
check('Settings opens for an executive', !!$('[data-add-person]'));
/* One form for everybody: an email makes them able to sign in, no email
   makes them somebody work can be assigned to. Two doors to one room was
   how a person could be added with no way to ever log in. */
check('adding somebody lives there', !!$('[data-add-person]'));
check('the officer list can be generated', !!$('[data-roster]'));
check('a person can change their own password', !!$('[data-change-pw]'));

// Now become a volunteer enrolled into exactly one event.
// A national activity that is still running: a volunteer's access is derived
// from the event being live, so a completed one would fail for the wrong reason.
const volEvent = S.events({ unitId: S.nationalUnitId(), activeOnly: true })[0];
Auth.adopt({
  id: 'vol1', full_name: 'Helper', position: 'Logistics Volunteer',
  unit_name: 'FCUSR Nationals', unit_kind: 'national', access: 'volunteer',
  eventIds: [volEvent.id]
});
check('a volunteer is not an executive', Auth.isExecutive() === false);
check('they see only their own event', Auth.visibleEvents().length === 1);
check('and may open it', Auth.canSee(volEvent.id) === true);
const otherEvent = S.events({ unitId: S.nationalUnitId() }).find((e) => e.id !== volEvent.id);
check('but not somebody else\'s', Auth.canSee(otherEvent.id) === false);

goto('#/overview');
check('the Overview is closed to them', text().includes('Not available to volunteers'));
goto('#/directives');
check('so are Directives', text().includes('Not available to volunteers'));
goto('#/settings');
check('and Settings', !$('[data-enrol]'));
goto('#/events/' + otherEvent.id);
check('opening another event is refused', text().includes('Not your event'));
goto('#/events');
check('their own event still lists', $$('.event-row').length === 1);
check('they cannot create events', !$('[data-create-event]'));

// Completing the activity ends their access by itself.
const wasStatus = S.event(volEvent.id).status;
S.updateEvent(volEvent.id, { status: 'Completed' });
check('access ends when the event completes', Auth.visibleEvents().length === 0);
check('and the event can no longer be opened', Auth.canSee(volEvent.id) === false);
S.updateEvent(volEvent.id, { status: wasStatus });
check('re-opening the event restores it', Auth.canSee(volEvent.id) === true);

// Back to an executive for the rest of the walk-through.
await Auth.signIn('', '');

console.log('\n--- settings ---');
goto('#/settings');

/* One row of tabs, one panel. It was ten collapsed rows stacked down the page,
   which meant remembering which heading the letterhead lived under. */
check('settings are tabs, not a stack of folds', $$('.set-tab').length > 4,
  $$('.set-tab').length + ' tabs');
check('exactly one panel is on screen', $$('.set-panel:not([hidden])').length === 1);
check('and it is open on arrival', !!$('.set-panel:not([hidden]) [data-add-person]'));

/* The roster and who may sign in are one subject and one tab. They were two,
   and somebody looking for an officer had to guess which heading held them. */
check('there is no separate People tab', !$('[data-set-tab="people"]'),
  $$('.set-tab').map((b) => b.textContent).join(' | '));
check('the roster is on the same panel as enrolment',
  !!$('.set-panel:not([hidden]) [data-add-person]') && text().includes('Althea Ramirez'));
check('deactivate is offered', text().includes('Deactivate'));
check('and so is removing somebody outright', !!$('[data-remove-person]'));

click($$('[data-set-tab]').find((b) => b.getAttribute('data-set-tab') === 'units'));
check('choosing a tab shows its panel',
  !!$('[data-panel="units"]') && !$('[data-panel="units"]').hidden);
check('and hides the one before it', $('[data-panel="access"]').hidden);

click($$('[data-set-tab]').find((b) => b.getAttribute('data-set-tab') === 'backup'));
check('backup offered', !!$('[data-backup]') && !!$('#restore-file'));
click($$('[data-set-tab]').find((b) => b.getAttribute('data-set-tab') === 'letterhead'));
check('emblem slot offered', !!$('#emblem-file'));

/* ---- a unit's roster, from the unit ----
   Enrolling a college's officers used to mean going to a page headed "Access"
   and picking the college from a dropdown. It belongs with the unit. */
console.log('\n--- enrolling into a unit ---');
{
  const dlg = () => $$('.modal-backdrop').pop();
  $$('.modal-backdrop').forEach((e) => e.remove());

  goto('#/settings');
  click($$('[data-set-tab]').find((b) => b.getAttribute('data-set-tab') === 'units'));
  check('every unit offers its own people', $$('[data-unit-people]').length > 1,
    $$('[data-unit-people]').length + ' units');

  const cn = S.units().find((u) => u.code === 'CN');
  click($$('[data-unit-people]').find((b) => b.getAttribute('data-unit-people') === cn.id));
  check('the unit\u2019s roster opens', !!dlg() && /College of Nursing/.test(dlg().textContent));
  check('and offers to add one or a list',
    !!dlg().querySelector('[data-up-add]') && !!dlg().querySelector('[data-up-import]'));
  check('it says who runs the unit', /Who runs/i.test(dlg().textContent));

  /* Naming a head is what opens that unit's settings to them — and only
     theirs. It is the President's to do. */
  const gov = S.people({ unitId: cn.id })[0];
  check('the unit has somebody to name', !!gov, S.people({ unitId: cn.id }).length + ' in CN');
  check('and a control to name them', !!dlg().querySelector('[data-up-head="' + gov.id + '"]'));

  click(dlg().querySelector('[data-up-head="' + gov.id + '"]'));
  click(dlg().querySelector('[data-ok]'));
  await sleep(10);
  check('naming them is recorded', S.person(gov.id).isHead === true);

  /* And that standing is exactly what a scoped Settings turns on. */
  const before = window.Auth.current();
  /* Signing in as somebody else clears the device — which is the point of it,
     and means this section has to put the council's work back when it is done
     pretending to be a Governor. */
  const snapshot = S.toJSON();
  /* Standing only means anything where there are accounts. Offline the app
     falls back to the rule that held before they existed, so this section
     needs a backend connected to be asking a real question. */
  const CFG2 = window.Backend.config.supabase;
  CFG2.url = 'https://example.supabase.co';
  CFG2.anonKey = 'sb_publishable_test';
  window.Auth.adopt({ id: 'gov-1', full_name: gov.name, position: 'Governor',
    unit_id: cn.id, unit_name: cn.name, unit_kind: cn.kind, access: 'officer', is_head: true });
  check('a head may open Settings', window.Auth.canOpenSettings());
  check('but is not national', !window.Auth.isNational());
  check('and is not the President', !window.Auth.isPresident());
  goto('#/settings');
  check('they get their own unit only', /College of Nursing/.test(text()), text().slice(0, 80));
  check('and not the Republic\u2019s letterhead', !$('[data-panel="letterhead"]'));
  check('nor the closing date', !$('[data-panel="term"]'));
  check('nor the unit list', !$('[data-panel="units"]'));

  CFG2.url = '';
  CFG2.anonKey = '';
  window.Auth.adopt({ id: 'local', full_name: before.name, position: before.position,
    unit_id: before.unitId, unit_name: before.unitName, unit_kind: before.unitKind,
    access: before.access, is_head: true });
  S.fromJSON(snapshot);
  check('and the device was cleared when the account changed, then restored',
    S.events().length > 0, S.events().length + ' events');
  S.updatePerson(gov.id, { isHead: false });
  $$('.modal-backdrop').forEach((e) => e.remove());
}

console.log('\n--- export and search ---');
goto('#/events/' + foundation.id);
click($('[data-export]'));
check('export dialog opens', !!$('#pending-only'));
// Scope to the dialog on top: an earlier modal left open would otherwise be
// the one this reads.
check('names the file', /FCUSR-TaskReport-Foundation-Week-2026-\d{4}-\d{2}-\d{2}\.pdf/
  .test($$('.modal-body').pop().textContent),
  ($$('.modal-body').pop().textContent || '').replace(/\s+/g, ' ').slice(0, 90));
click($('[data-close]'));
click($('#btn-search'));
setValue($('#q'), 'tarpaulin');
await sleep(220);
check('search finds tasks', $('#results').textContent.includes('Design tarpaulin'));
setValue($('#q'), 'althea');
await sleep(220);
check('search finds people', $('#results').textContent.includes('Althea Ramirez'));
click($('[data-close]'));

console.log('\n--- deletion is confirmed ---');
goto('#/events/' + created.id);
const n0 = S.tasks({ eventId: created.id }).length;
click($$('[data-edit]')[0]);
click($('[data-delete]'));
check('asks before deleting', !!$('[data-ok]'));
click($('[data-cancel]'));
await sleep(10);
check('cancel deletes nothing', S.tasks({ eventId: created.id }).length === n0);

console.log('\n--- accomplishment report ---');
const A = window.Accomplishment;
const evId = foundation.id;

// Nothing appears until the activity is actually finished.
goto('#/events/' + evId);
check('no report banner while tasks are pending', !$('[data-open-report]') && !$('[data-mark-complete]'));

S.tasks({ eventId: evId }).forEach((t) => S.setTaskStatus(t.id, 'Done'));
goto('#/events/' + evId);
check('all tasks done offers the completion toggle', !!$('[data-mark-complete]'));

/* Every activity is evaluated, and that is enforced rather than suggested: an
   activity with no feedback form cannot be marked finished, however complete
   its tasks are. */
check('the missing feedback form is called out', !!$('.fb-banner.is-missing'));
click($('[data-mark-complete]'));
check('and completion is refused without it', S.event(evId).status !== 'Completed');

S.setFeedbackLink(evId, 'https://forms.gle/abc123');
goto('#/events/' + evId);
check('with a form the banner turns green', !!$('.fb-banner.is-done'));
click($('[data-mark-complete]'));
check('marking complete sets the event status', S.event(evId).status === 'Completed');
goto('#/events/' + evId);
check('report becomes the last step', !!$('[data-open-report]'));
check('activity sits at 90% before the report', /90% of the whole activity/.test(text()));

const draft = A.draftFor(evId);
check('a fresh report is empty', A.progress(draft).done === 0);
check('description needs real content', !A.stepDone(draft, 'description'));
draft.description = 'x'.repeat(40);
check('description counts once written', A.stepDone(draft, 'description'));
check('photos require the minimum', !A.stepDone(draft, 'photos'));
draft.photos = Array.from({ length: A.MIN_PHOTOS - 1 }, (_, i) => ({ assetId: 'a' + i, caption: '' }));
check(A.MIN_PHOTOS - 1 + ' photos is still short', !A.stepDone(draft, 'photos'));
draft.photos.push({ assetId: 'a99', caption: '' });
check(A.MIN_PHOTOS + ' photos passes', A.stepDone(draft, 'photos'));
check('a letter needs both a name and pages',
  (() => { draft.letters = [{ name: '', assets: ['x'] }]; return !A.stepDone(draft, 'letters'); })());
draft.letters = [{ name: 'Letter of Intent', assets: ['x'] }];
check('a named letter with pages passes', A.stepDone(draft, 'letters'));
check('minutes is the only optional step', A.stepDone(draft, 'minutes'));

draft.program.assets = ['p1'];
draft.evaluation.assets = ['e1'];
check('signatories are required', !A.stepDone(draft, 'signatories'));
draft.signatories = { preparedBy: { name: 'Trisha Villanueva', position: 'PIO' },
                      president: { name: 'Arron Aperocho', show: true },
                      adviser: { name: 'Janrie Agam' } };
check('naming the preparer satisfies it', A.stepDone(draft, 'signatories'));
check('every required section now complete', A.progress(draft).done === A.progress(draft).total);

// The report is stored on the event, and survives the sanitiser.
S.saveReport(evId, draft);
const saved = S.report(evId);
check('report saved against the event', !!saved && saved.eventId === evId);
check('photos kept', saved.photos.length === A.MIN_PHOTOS);
S.saveReport(evId, { driveLink: 'javascript:alert(1)' });
check('a non-Drive link is refused', S.report(evId).driveLink === '');
S.saveReport(evId, { driveLink: 'https://drive.google.com/file/d/abc/view' });
check('a real Drive link is kept', S.report(evId).driveLink.indexOf('https://drive.google.com/') === 0);

const wizSrc = fs.readFileSync(path.join(ROOT, 'assets/js/accomplishment-ui.js'), 'utf8');
check('uploading a photo is the only way in',
  /data-pick=/.test(wizSrc) && !/data-scan=/.test(wizSrc) && !/data-camera=/.test(wizSrc));
check('eight photos are required', A.MIN_PHOTOS === 8);
check('the camera is a real stream, not the mobile-only capture attribute',
  !/capture="environment"/.test(wizSrc) &&
  /getUserMedia/.test(fs.readFileSync(path.join(ROOT, 'assets/js/camera.js'), 'utf8')));
check('camera refuses politely on an insecure page',
  /secure\(\)/.test(fs.readFileSync(path.join(ROOT, 'assets/js/camera.js'), 'utf8')));
check('each upload block carries instructions', /data-howto=/.test(wizSrc));
check('pages can be reordered and removed', /data-move=/.test(wizSrc) && /data-drop=/.test(wizSrc));
check('the preview renders the real PDF', /previewURL/.test(wizSrc));
check('the preview is live per step, not only at the end',
  /refreshPreview/.test(wizSrc) && /STEP_PAGE/.test(wizSrc) && /#page=/.test(wizSrc));
check('CSP allows the blob preview frame', /frame-src blob:/.test(indexHtml));

const pdfSrc = fs.readFileSync(path.join(ROOT, 'assets/js/accomplishment-pdf.js'), 'utf8');
check('every section starts on its own page', /function startSection/.test(pdfSrc) && /doc\.addPage\(\)/.test(pdfSrc));
check('page 1 is the generated cover', /startSection\('cover'\)/.test(pdfSrc));
check('the letter of intent comes next', (() => {
  const cover = pdfSrc.indexOf("startSection('cover')");
  const letters = pdfSrc.indexOf("documentSection('letters'");
  const desc = pdfSrc.indexOf("startSection('description'");
  return cover < letters && letters < desc;
})());
// jsPDF's own align:'justify' does nothing when it is handed one line at a
// time, which is how this used to be called — the option was there, the text
// came out flush left, and the old check passed on the presence of the option
// rather than the result. Spacing is now worked out here; tests/report-proof.js
// checks what actually lands on the page.
check('justification is computed, not delegated',
  /function justifyLine/.test(pdfSrc) && /getTextWidth/.test(pdfSrc));
check('the closing line of a paragraph is left alone', /!last/.test(pdfSrc));
check('no sheet leaves with only the letterhead on it', /pruneEmptyPages/.test(pdfSrc));
check('photos print without captions', !/p\.caption/.test(pdfSrc));
check('body text is 12pt', /size \|\| 12/.test(pdfSrc));
check('section titles are centred', /toUpperCase\(\), A4\.w \/ 2, y, \{ align: 'center' \}/.test(pdfSrc));
check('the gold rules under titles are gone', !/setLineWidth\(0\.7\)/.test(pdfSrc));
check('photos print four to a page', /rowsPerPage = 2/.test(pdfSrc) && /cols = 2/.test(pdfSrc));
check('liquidation has its own section', /documentSection\('liquidation'/.test(pdfSrc));
check('minutes fall back to the task assignment',
  /Task Assignment and Deliberation/.test(pdfSrc));
check('signatories are filled in by the user', /report\.signatories/.test(pdfSrc));
check('the president can be left off', /pres\.show !== false/.test(pdfSrc));
check('the cover no longer says submitted or generated',
  !/Submitted to the Office/.test(pdfSrc) && !/'Generated ' \+ U\.nowStamp/.test(pdfSrc));
check('footer is bottom-right with title and page', /align: 'right'/.test(pdfSrc) && /Page ' \+ i \+ ' of '/.test(pdfSrc));

console.log('\n--- directives ---');
goto('#/directives');
check('Directives has its own screen', text().includes('Directives'));
const dBefore = S.tasks({ kind: 'directive' }).length;
if (!$('#d-title')) click($('[data-open-add]'));
setValue($('#d-title'), 'Follow up the adviser on the budget memo');
click($('[data-save]'));
check('a directive saves without an event', S.tasks({ kind: 'directive' }).length === dBefore + 1);
const dir = S.tasks({ kind: 'directive' })[0];
check('it genuinely has no parent event', !dir.eventId && dir.kind === 'directive');
check('event work still requires an event',
  (() => { try { S.addTask({ title: 'x' }); return false; } catch (e) { return true; } })());
goto('#/overview');
check('directives stay out of the Overview', !text().includes('budget memo'));

/* Every step of the wizard must draw its own body. This is here because two of
   them did not: `stepBody()` had no branch for Signatories or Liquidation, so
   both fell through to the Review screen. Signatories counts towards progress,
   so with no way to type a name the export button could never enable — and the
   report's signature block printed blank. The PDF tests never saw it because
   they build a draft in code and never open the wizard. */
console.log('\n--- every wizard step draws itself ---');
{
  // jsdom has no IndexedDB. The wizard must survive that — see the catch in
  // open() — but stub it here so the steps themselves are what is under test.
  window.AssetDB.getMany = (ids) => Promise.resolve(ids.map((id) => ({ id, dataUrl: null })));

  window.AccomplishmentUI.open(evId);
  await sleep(30);                      // the wizard warms its picture cache first
  const stepBtns = () => Array.from(D.querySelectorAll('#wiz [data-step]'));
  check('the wizard opens', stepBtns().length === A.STEPS.length, stepBtns().length + ' steps');

  const seen = {};
  A.STEPS.forEach((step, i) => {
    click(stepBtns()[i]);
    const body = $('#wiz');
    const t = body.textContent.replace(/\s+/g, ' ');
    seen[step.key] = t;
    check('“' + step.label + '” shows its own heading', t.includes(step.title), t.slice(0, 70));
  });

  // The review-only controls must appear on review and nowhere else.
  A.STEPS.forEach((step, i) => {
    click(stepBtns()[i]);
    const hasExport = !!$('[data-export]');
    if (step.key === 'review') check('review offers the export', hasExport);
    else check('“' + step.label + '” is not the review screen', !hasExport);
  });

  // And the fields that were missing are really there and really bind.
  click(stepBtns()[A.STEPS.findIndex((x) => x.key === 'signatories')]);
  check('signatories has a name field', !!$('#sg-prep-name'));
  check('and a position field', !!$('#sg-prep-pos'));
  check('and the adviser', !!$('#sg-adv-name'));
  setValue($('#sg-prep-name'), 'Job Sarmiento');
  setValue($('#sg-prep-pos'), 'Secretary, FCUSR Nationals');
  const st = A._state();
  check('typing a name reaches the draft', st.draft.signatories.preparedBy.name === 'Job Sarmiento');
  check('and so does the position', st.draft.signatories.preparedBy.position === 'Secretary, FCUSR Nationals');
  check('which satisfies the step', A.stepDone(st.draft, 'signatories'));

  // Three fixed slots do not fit a joint activity or a co-adviser, and a report
  // that cannot name its own signatories is not the one the council files.
  check('more signatories can be added', !!$('[data-sg-add]'));
  click($('[data-sg-add]'));
  check('a row appears', $$('[data-sg-name]').length === 1);
  setValue($$('[data-sg-name]')[0], 'Dr. Ma. Luisa Arroyo');
  setValue($$('[data-sg-pos]')[0], 'Dean, College of Nursing');
  check('the extra signatory reaches the draft',
    A._state().draft.signatories.others[0].name === 'Dr. Ma. Luisa Arroyo');
  check('with their position', A._state().draft.signatories.others[0].position === 'Dean, College of Nursing');

  click(stepBtns()[A.STEPS.findIndex((x) => x.key === 'liquidation')]);
  check('liquidation offers an uploader', !!$('[data-grid="liquidation"]'));

  const close = $('[data-save-close]');
  if (close) click(close);
}

console.log('\n--- word export ---');
const wordSrc = fs.readFileSync(path.join(ROOT, 'assets/js/accomplishment-word.js'), 'utf8');
check('a Word file can be produced', typeof window.AccomplishmentWord.save === 'function');
check('sections break onto their own page, as in the PDF',
  /page-break-before:always/.test(wordSrc));
check('nothing else is force-broken',
  (wordSrc.match(/page-break-before/g) || []).length <= 2);
check('pictures sit in movable boxes', /v:textbox|v:shape/.test(wordSrc));
check('body text is justified at 12pt',
  /text-align:justify/.test(wordSrc) && /font-size:12pt/.test(wordSrc));

console.log('\n--- filing the report ---');
const uiSrc2 = fs.readFileSync(path.join(ROOT, 'assets/js/accomplishment-ui.js'), 'utf8');
/* These test the substance, not the sentence. The wording was shortened once —
   the instructions were fifteen lines of reasoning before the four steps an
   officer standing at the computer actually needed — and three of these failed
   on phrasing alone while every fact they guard was still on the screen. A test
   that breaks on a rewrite it should not care about teaches people to change
   the test. */
check('an upload window follows the download', /function uploadWindow/.test(uiSrc2));
check('it warns against a personal account',
  /FCUSR\s*<\/strong>\s*owns|owned by the FCUSR|FCUSR\\u2019s own account/.test(uiSrc2) &&
  /personal/.test(uiSrc2));
check('it explains that only the link is kept',
  /keeps the link|never the file itself/.test(uiSrc2));
check('it insists the file is not deleted', /Never delete or move the file/.test(uiSrc2));
check('and the steps come before the reasoning',
  uiSrc2.indexOf('Open <strong>Google Drive</strong>') <
  uiSrc2.indexOf('Two things that matter'),
  'the reasoning is above the instructions again');

/* ---------------- the preview while it is still being filled in ----------------
   A section only exists in the document once there is something in it, so for
   the whole time an officer is working most of them are not there. The preview
   asked for the page of the section they were on, got nothing, and quietly
   showed page 1 instead — under a heading that said "Preview of this page".

   Six of the nine steps therefore showed the cover. Nothing was broken and it
   looked broken, and an officer with no reason to doubt the heading is being
   told their photos went somewhere they did not. */
console.log('\n--- the preview says when a section is not there yet ---');
{
  const src = fs.readFileSync(path.join(ROOT, 'assets/js/accomplishment-ui.js'), 'utf8');
  check('there is a sentence for every section that can be empty',
    ['description', 'program', 'photos', 'letters', 'minutes', 'evaluation', 'liquidation']
      .every((k) => new RegExp(k + ':\\s*\'').test(src.slice(src.indexOf('STEP_APPEARS')))),
    'STEP_APPEARS does not cover every step');
  check('and a missing page is said, not silently swapped for the cover',
    /page === undefined && STEP_APPEARS\[stepKey\]/.test(src));
  check('the heading no longer promises a page it may not be showing',
    !/Preview of this page/.test(src));

  const css = fs.readFileSync(path.join(ROOT, 'assets/css/app.css'), 'utf8');
  check('and the message has somewhere to be drawn', /\.pv-empty/.test(css));
}

/* The one fact the whole screen exists to establish, said where an officer is
   actually standing: on the activity page, before they open the wizard at all. */
console.log('\n--- ready to export is visible without opening the wizard ---');
{
  const src = fs.readFileSync(path.join(ROOT, 'assets/js/views/event-detail.js'), 'utf8');
  check('the activity page knows when the report is finished',
    /var ready = p\.done === p\.total/.test(src));
  check('and says so rather than counting sections at you',
    /Ready to export/.test(src));
  check('with the go colour on the button', /ready \? 'btn-go '/.test(src));

  const css = fs.readFileSync(path.join(ROOT, 'assets/css/app.css'), 'utf8');
  check('which is defined', /\.report-banner\.is-ready/.test(css));

  // Two documents, two names. Both used to be called "Export PDF".
  check('the task list is not called the same thing as the report',
    /Task list \(PDF\)/.test(src) && !/>Export PDF/.test(src));
}

/* ---------------- a browser that will not store pictures ----------------
   A private window, or a school machine locked down. What came back was the
   browser's own word for it — "blocked", or a DOMException carrying no message
   at all — and that was what an officer read as the reason their report would
   not build.

   Worse, the failure was remembered: the promise that failed was cached, so the
   first refusal turned pictures off for the rest of the session even after
   whatever caused it had gone. */
console.log('\n--- pictures refused by the browser ---');
{
  const src = fs.readFileSync(path.join(ROOT, 'assets/js/asset-db.js'), 'utf8');
  check('the reason is said in words somebody can act on',
    /private or incognito window/.test(src));
  check('a browser that throws instead of reporting is caught too',
    /try \{ req = global\.indexedDB\.open/.test(src));
  check('and a refusal is not remembered for the whole session',
    /dbPromise\.catch\(function \(\) \{ dbPromise = null; \}\)/.test(src),
    'one failure would keep pictures off until the tab is closed');
}

/* ---------------- what somebody is, asked once and sent everywhere ----------------
   It was never asked. Whichever form got opened decided: the person form always
   enrolled an officer, the helper form always enrolled a volunteer, the roster
   import always enrolled an officer. Moving somebody between the two was
   therefore not something the app could do. */
console.log('\n--- the person form asks what somebody is ---');
{
  const src = fs.readFileSync(path.join(ROOT, 'assets/js/forms.js'), 'utf8');
  check('the form has a choice of officer or volunteer', /id="f-access"/.test(src));
  check('and what it says is what gets saved here',
    /data\.access = accSel && accSel\.value === 'volunteer'/.test(src));
  check('and what gets sent to the server',
    /access: data\.access/.test(src),
    'the form still hard-codes what it enrols people as');

  /* Being put on an activity adds an activity. It is not a demotion, and it
     used to be one: an officer helping out was sent back down to volunteer. */
  check('helping at an activity does not demote an officer',
    /var keepsOfficer = !!\(existing && existing\.access !== 'volunteer'\)/.test(src));
  check('and does not move them into another unit for the afternoon',
    /keepsOfficer \? \(existing\.unitId \|\| e\.unitId\) : e\.unitId/.test(src));

  const sync = fs.readFileSync(path.join(ROOT, 'assets/js/sync.js'), 'utf8');
  check('and a change of office is noticed without closing the tab',
    /Auth\.refresh\(\)/.test(sync));
}

console.log('\n--- backend wiring ---');
const Backend = window.Backend;
check('Supabase is the selected driver', Backend.config.driver === 'supabase');
check('falls back to local until credentials are filled in', Backend.isFallback() === true);
check('app still works offline in the meantime', Backend.driverName() === 'This browser only');
check('CSP allows Supabase and nothing else',
  /connect-src 'self' https:\/\/\*\.supabase\.co/.test(indexHtml));

console.log('\n--- accessibility ---');
goto('#/dashboard');
check('progress bars expose values', $$('[role="progressbar"]').length > 0);
check('current tab marked', !!$('.tab[aria-current="page"]'));
check('status chips are labelled buttons',
  $$('[data-status-for]').every((c) => c.tagName === 'BUTTON' && c.getAttribute('aria-label')));
check('pills report pressed state', $$('.pill[aria-pressed]').length === 3);
check('skip link present', !!$('.skip-link'));

console.log('\n--- the letters tracker ---');
{
  const office = (code) => S.offices().find((o) => o.code === code);
  const dean = office('DEAN'), osa = office('OSA');
  const ev = S.events()[0];

  const L = S.addLetter({
    subject: 'Request to use the gymnasium', eventId: ev.id, unitId: S.nationalUnitId(),
    inChargeName: 'Job Sarmiento', officeIds: [dean.id, osa.id]
  });

  goto('#/letters');
  check('the letters screen opens', /Letters/.test(view().textContent));
  check('the letter is listed', text().includes('Request to use the gymnasium'));
  check('and says where it is', /not yet sent/i.test(text()), text().slice(0, 120));
  check('who is carrying it is on the row', text().includes('Job Sarmiento'));

  goto('#/letters/' + L.id);
  check('a letter opens on its own screen', text().includes('Request to use the gymnasium'));
  check('the trail lists every office', $$('.trail-stop').length === 2);
  check('only the office holding it offers a button', $$('[data-receive]').length === 1);
  check('and it is the first one', $('[data-receive]').getAttribute('data-receive') === L.stops[0].id);

  // Hand it over, through the real dialog. Queries are scoped to the dialog on
  // top: an earlier screen or a stale modal must not answer for it.
  const dlg = () => $$('.modal-backdrop').pop();
  const inDlg = (sel) => dlg().querySelector(sel);

  click($('[data-receive]'));
  check('the hand-over dialog opens', !!dlg() && !!inDlg('#f-rby'));
  setValue(inDlg('#f-rby'), 'Mrs. Ferrer');
  click(inDlg('[data-save]'));
  check('the hand-over is recorded', S.letter(L.id).stops[0].receivedBy === 'Mrs. Ferrer');
  const has = (phrase, o) => text().toLowerCase().includes(phrase + ' ' + S.officeName(o.id).toLowerCase());
  check('the screen now names the office', has('with', dean), text().slice(0, 140));
  check('and offers the outcome next', $$('[data-release]').length === 1);

  // A blank receiver is refused.
  click($('[data-release]'));
  const outcomes = Array.from(dlg().querySelectorAll('[data-outcome]'));
  check('the three outcomes are offered', outcomes.length === 3);
  click(outcomes.find((b) => b.getAttribute('data-outcome') === 'Returned for revision'));
  click(inDlg('[data-save]'));
  check('sending it back demands a reason', !!inDlg('.field.has-error'));
  setValue(inDlg('#f-xnote'), 'Budget breakdown missing');
  click(inDlg('[data-save]'));

  goto('#/letters/' + L.id);
  check('a returned letter says so', has('returned by', dean), text().slice(0, 160));
  check('it does not advance to the next office', !has('with', osa));
  /* A return opens a fresh attempt at the same office directly beneath it, so
     there is nothing to "reopen" — the next hand-over is already waiting, and
     the reason it came back stays readable above it. */
  check('a second run at that office is waiting', $$('.trail-stop').length === 3);
  check('the return is still shown', /returned for revision/i.test(text()));
  check('with the reason', text().includes('Budget breakdown missing'));
  check('and the next hand-over is ready', $$('[data-receive]').length === 1);

  goto('#/overview');
  check('a letter needing a chase reaches the Overview', text().includes('Request to use the gymnasium'));

  goto('#/events/' + ev.id);
  // The activity's sections are tabs now, so the letters live behind their own.
  check('the activity has a Letters tab', !!$('[data-tab="letters"]'));
  click($('[data-tab="letters"]'));
  check('and it shows under its activity', text().includes('Request to use the gymnasium'));
  click($('[data-tab="tasks"]'));
  check('tasks come back', $$('.task').length > 0);

  /* A letter belongs to a unit. The list filters by unit, but typing the address
     of one must not get round that — an independent body's correspondence is
     sealed from the National government, and the other way about. */
  const duag = S.units().find((u) => u.code === 'DUAG');
  const before = window.Auth.current();
  window.Auth.adopt({ id: 'local', full_name: 'Festival Officer', position: 'Chair',
    unit_id: duag.id, unit_name: duag.name, unit_kind: duag.kind, access: 'officer' });
  goto('#/letters/' + L.id);
  check('another unit cannot open your letter by address', /not your letter/i.test(text()), text().slice(0, 80));
  goto('#/letters');
  check('and it is not in their list', !text().includes('Request to use the gymnasium'));
  window.Auth.adopt({ id: 'local', full_name: before.name, position: before.position,
    unit_id: before.unitId, unit_name: before.unitName, unit_kind: before.unitKind,
    access: before.access });

  S.deleteLetter(L.id);
}

/* ---- the signatories, through the real form ----
   Three rules the council gave, each of which is a dialog somebody has to get
   past: the President signs everything, a signatory may be a person, and an
   office already holding the letter can demand another signature first. */
console.log('\n--- signatories ---');
{
  // Anything an earlier block left open would answer for the dialog on top.
  $$('.modal-backdrop').forEach((e) => e.remove());

  const dlg = () => $$('.modal-backdrop').pop();        // whatever is on top
  const inDlg = (sel) => dlg().querySelector(sel);
  const dlgAll = (sel) => Array.from(dlg().querySelectorAll(sel));
  const presId = S.presidentOfficeId();
  // A confirmation answers through a promise, so the redraw lands a tick later.
  const settle = () => new Promise((r) => setTimeout(r, 0));

  goto('#/letters');
  click($('[data-new-letter]'));
  check('the letter form opens', !!inDlg('#f-lsubject'));
  // Held by reference: a confirmation opens on top of it and must not be mistaken for it.
  const form = dlg();
  const inForm = (sel) => form.querySelector(sel);
  const formAll = (sel) => Array.from(form.querySelectorAll(sel));
  setValue(inDlg('#f-lsubject'), 'Request for the foundation week budget');

  // Start from the council's own route.
  const tpl = inDlg('#f-ltemplate');
  const budget = Array.from(tpl.options).find((o) => /Collection of money/.test(o.text));
  check('the council routes are offered by name', !!budget);
  setValue(tpl, budget.value);
  check('picking one lays out all ten signatories', dlgAll('.route-pick li').length === 10,
    dlgAll('.route-pick li').length + ' rows');
  check('and the President is marked as signing everything',
    /signs everything/i.test(inDlg('.route-pick').textContent));

  // The conference route carries an instruction of its own.
  const conf = Array.from(tpl.options).find((o) => /conference/i.test(o.text));
  setValue(tpl, conf.value);
  check('a route with an instruction shows it',
    /attach the invitation letter/i.test(inDlg('#tpl-note').textContent),
    inDlg('#tpl-note').textContent);

  setValue(tpl, budget.value);

  // Removing the President must ask whether the letter stays inside the council.
  const presRow = dlgAll('.route-pick li').findIndex((li) => /signs everything/i.test(li.textContent));
  click(dlgAll('[data-rdrop]')[presRow]);
  check('removing the President asks a question first',
    /President signs this/i.test(dlg().textContent), dlg().textContent.slice(0, 90));
  click(inDlg('[data-cancel]'));
  await settle();
  check('and keeping them leaves the route alone', formAll('.route-pick li').length === 10);

  // Answering that it is internal is the one way through.
  formAll('[data-rdrop]')[presRow].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  click(inDlg('[data-ok]'));
  await settle();
  check('saying it is internal removes them', formAll('.route-pick li').length === 9,
    formAll('.route-pick li').length + ' rows');
  check('and the gap is said plainly, with a way back',
    /No FCUSR President on this letter/i.test(form.textContent) && !!inForm('[data-readd]'));

  click(inForm('[data-readd]'));
  check('putting them back restores the route', formAll('.route-pick li').length === 10);

  // A signatory who holds no office.
  setValue(inForm('#f-laddoffice'), '__typed');
  check('choosing a person reveals the name box', !inForm('#f-lnamerow').hidden);
  setValue(inForm('#f-laddname'), 'Sen. Kyla Villanueva');
  click(inForm('[data-addname]'));
  check('a person joins the signatories', formAll('.route-pick li').length === 11);
  check('and is marked as a person, not an office',
    /Sen\. Kyla Villanueva/.test(form.textContent) &&
    /person/i.test(formAll('.route-pick li')[10].textContent));

  // An office the council uses that the seeded list has never heard of.
  setValue(inForm('#f-laddoffice'), '__office');
  check('a new office can be typed', !inForm('#f-lnamerow').hidden);
  check('and it says the office will be kept',
    /list of offices/i.test(inForm('#f-lnamehint').textContent),
    inForm('#f-lnamehint').textContent.slice(0, 60));
  setValue(inForm('#f-laddname'), 'Office of the Chaplain');
  click(inForm('[data-addname]'));
  check('the new office joins the signatories', formAll('.route-pick li').length === 12);
  check('it is an office, not a one-off name',
    !/person/i.test(formAll('.route-pick li')[11].textContent),
    formAll('.route-pick li')[11].textContent);
  const chap = S.offices().find((o) => o.name === 'Office of the Chaplain');
  check('and it is on the council list for next time', !!chap);
  check('with a code of its own, so templates cannot mismatch',
    !!chap.code && S.offices().filter((o) => o.code === chap.code).length === 1, chap.code);
  check('the dropdown learns it without a redraw',
    !!inForm('#f-laddoffice option[value="' + chap.id + '"]'));

  // Typing it a second time must not make a duplicate office.
  setValue(inForm('#f-laddoffice'), '__office');
  setValue(inForm('#f-laddname'), 'office of the chaplain');
  click(inForm('[data-addname]'));
  check('typing the same office again does not duplicate it',
    S.offices().filter((o) => /chaplain/i.test(o.name)).length === 1);
  check('and it is not added to the route twice', formAll('.route-pick li').length === 12);

  click(inForm('[data-save]'));
  await settle();
  const made = S.letters().find((x) => x.subject === 'Request for the foundation week budget');
  check('the letter saves with every signatory', !!made && made.stops.length === 12, made && made.stops.length);
  check('the President is on it', made.stops.some((x) => x.officeId === presId));
  check('it is not marked internal', made.internal === false);
  check('and the person was kept by name',
    made.stops[10].label === 'Sen. Kyla Villanueva' && made.stops[10].officeId === '');

  /* ---- an office that will not sign until somebody else has ---- */
  goto('#/letters/' + made.id);
  check('the desk holding it can ask for another signature first',
    $$('[data-insert]').length === 1);
  click($('[data-insert]'));
  check('the insert dialog opens', !!inDlg('#f-isoffice'));
  check('and offers a person as well as an office',
    Array.from(inDlg('#f-isoffice').options).some((o) => o.value === '__typed'));
  setValue(inDlg('#f-isoffice'), S.officeByCode('REG').id);
  setValue(inDlg('#f-iswhere'), 'before');
  click(inDlg('[data-save]'));

  const after = S.letter(made.id);
  check('the office goes in ahead of the one holding it',
    after.stops[0].officeId === S.officeByCode('REG').id, S.stopName(after.stops[0]));
  check('and nothing else was disturbed', after.stops.length === 13);
  check('the screen now waits on the new office',
    /Office of the Registrar/.test(text()), text().slice(0, 120));

  S.deleteLetter(made.id);
}

/* ---------------- a task nobody is holding ----------------
   Everything else on a task row describes work in progress. "Unassigned" is
   the one thing on it that will not fix itself, and it was set in the same
   grey as the due date beside it. */
console.log('\n--- an unassigned task says so in red ---');
{
  const S = window.Store;
  const ev = S.events()[0];
  const held = S.addTask({ kind: 'event', eventId: ev.id, title: 'Held by somebody',
    assigneeId: (S.people()[0] || {}).id || '', dueDate: '2026-10-01' });
  const loose = S.addTask({ kind: 'event', eventId: ev.id, title: 'Held by nobody',
    dueDate: '2026-10-01' });

  const looseRow = window.UI.taskRow(loose, [S.personName(loose.assigneeId)]);
  const heldRow = window.UI.taskRow(held, [S.personName(held.assigneeId)]);

  check('the unassigned label is marked',
    /<span class="unassigned">Unassigned<\/span>/.test(looseRow), looseRow.slice(0, 160));
  check('and a person\u2019s name is left alone',
    !/class="unassigned"/.test(heldRow), heldRow.slice(0, 160));

  // The colour has to actually be defined, or the class marks nothing.
  const css = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'assets', 'css', 'app.css'), 'utf8');
  check('the class is given the overdue red',
    /\.task-meta \.unassigned\s*\{[^}]*--st-overdue-fg/.test(css));
  check('and so is the heading the tasks are grouped under',
    /\.group-title\.unassigned\s*\{[^}]*--st-overdue-fg/.test(css));

  /* The row is only half of it. An officer looking for unclaimed work would
     otherwise have to open every activity in turn, which is how a task sits
     unclaimed until the week it was due. */
  const before = S.eventStats(ev.id).unassigned;
  const extra = S.addTask({ kind: 'event', eventId: ev.id, title: 'Also nobody\u2019s' });
  check('the event counts what nobody has taken',
    S.eventStats(ev.id).unassigned === before + 1,
    before + ' \u2192 ' + S.eventStats(ev.id).unassigned);

  /* Finished work does not count. A task that got done without ever being
     assigned needs nobody now, and counting it sends somebody looking for a
     problem that has already gone. */
  S.updateTask(extra.id, { status: 'Done' });
  check('and stops counting it once it is done',
    S.eventStats(ev.id).unassigned === before,
    String(S.eventStats(ev.id).unassigned));

  S.deleteTask(extra.id);
  S.deleteTask(held.id);
  S.deleteTask(loose.id);
}

/* ---------------- a letter nobody is carrying ---------------- */
console.log('\n--- a letter nobody is carrying says so in red ---');
{
  const S = window.Store;
  const l = S.letters()[0];
  if (l) {
    S.updateLetter(l.id, { inChargeId: '', inChargeName: '' });
    goto('#/letters');
    const html = window.document.getElementById('view').innerHTML;
    check('the carrier reads Unassigned, in red',
      /<span class="unassigned">Unassigned<\/span>/.test(html),
      html.slice(0, 120));
  } else {
    check('there is a letter to check', false, 'the fixture has none');
  }
}

/* ---------------- the accomplishment report wizard ----------------
   The screen an officer meets at the end of every activity, and the one thing
   it has to answer is whether the report is finished. It used to answer that
   only on the last step, so the way to find out was to walk to the end. */
console.log('\n--- the report wizard says whether it is finished ---');
{
  const S = window.Store;
  const D = window.document;
  const ev = S.events()[0];

  /* The preview points at the page for the step you are on. Two steps were
     missing from that map — Liquidation, which has a page of its own and was
     landing the reader on the cover, and Signatories, which is drawn on the
     cover and was right only by accident. */
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'assets', 'js', 'accomplishment-ui.js'), 'utf8');
  const mapped = (src.match(/var STEP_PAGE = \{([\s\S]*?)\};/) || [])[1] || '';
  window.Accomplishment.STEPS.forEach((st) => {
    check('the preview knows where ' + st.label + ' is',
      new RegExp('\\b' + st.key + ':').test(mapped), mapped.replace(/\s+/g, ' ').slice(0, 120));
  });

  window.AccomplishmentUI.open(ev.id);
  await sleep(60);

  const banner = () => D.querySelector('.wiz-ready');
  check('the wizard opens', !!banner());
  check('and says plainly it is not finished',
    banner() && !banner().classList.contains('is-ready'),
    banner() && banner().className);
  check('naming the sections still to fill in',
    /still to fill in/i.test(banner().textContent), banner().textContent.slice(0, 90));

  // Fill in everything the report needs.
  const st = window.Accomplishment._state();
  const d = st.draft;
  d.description = 'A paragraph long enough to count as a proper write-up of the activity for the OSA.';
  d.program = { assets: ['a1'] };
  d.photos = Array.from({ length: window.Accomplishment.MIN_PHOTOS }, (_, i) => ({ assetId: 'p' + i, caption: '' }));
  d.letters = [{ name: 'Letter of Intent', assets: ['l1'] }];
  d.evaluation = { assets: ['e1'] };
  d.signatories.preparedBy = { name: 'Job Sarmiento', position: 'Secretary' };
  D.querySelector('[data-step="0"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(60);

  check('once everything is in, it goes green',
    banner() && banner().classList.contains('is-ready'), banner() && banner().className);
  check('and says so in words, not only in colour',
    /ready to export/i.test(banner().textContent), banner().textContent.slice(0, 90));
  check('with a way straight to the export step',
    !!D.querySelector('[data-goto-export]'));

  D.querySelector('[data-goto-export]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(60);

  check('which lands on the last step',
    st.step === window.Accomplishment.STEPS.length - 1, String(st.step));
  /* A button that is visible, enabled and silent when pressed teaches people
     that the screen is broken. */
  check('where Next is out of the way, having nothing left to do',
    D.querySelector('[data-next]').hidden);
  check('the export button is offered',
    !!D.querySelector('[data-export]') && !D.querySelector('[data-export]').disabled);
  check('and it is the green one',
    /btn-go/.test(D.querySelector('[data-export]').className),
    D.querySelector('[data-export]').className);
  check('the step is called Export, not Review',
    /Export/.test(D.querySelector('[data-step="8"]').textContent),
    D.querySelector('[data-step="8"]').textContent);

  /* A phone very often refuses to show a PDF inside the page: the frame is
     ignored, or the file is offered as a download, and what the officer gets is
     a grey box that never fills in. The report is fine; the preview OF it is
     what cannot be drawn — and from the outside those look identical, so it
     reads as a broken screen. There has to be a way to see the thing either
     way, and it must not depend on guessing the browser right. */
  check('there is always a way to open the preview',
    !!D.querySelector('[data-open-preview]'));

  /* Pictures go in one at a time. A failure on the fifth of eight used to
     redraw the four that made it and save none of them — on screen, in the
     draft in memory, and written down nowhere. A reload then lost four uploads
     and left their images in storage with nothing naming them. */
  {
    let n = 0;
    window.AssetDB.addFile = function (reportId) {
      n += 1;
      if (n === 3) return Promise.reject(new Error('the file could not be read'));
      return Promise.resolve({ id: reportId + ':img' + n, dataUrl: 'data:image/jpeg;base64,QUJD' });
    };
    st.step = 2;                                    // Photos
    st.draft.photos = [];
    D.querySelector('[data-step="2"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await sleep(40);

    const saved = () => {
      const raw = JSON.parse(window.localStorage.getItem('fcusr.tracker.v1') || '{}');
      const r = (raw.reports || []).filter((x) => x.eventId === ev.id)[0];
      return r ? (r.photos || []).length : 0;
    };

    await window.AccomplishmentUI._addFiles('photos', [{}, {}, {}, {}]);
    await sleep(60);
    check('the pictures that went in are kept on screen',
      st.draft.photos.length === 2, String(st.draft.photos.length));
    check('and written down, not just drawn', saved() === 2, String(saved()));
  }

  /* Reopened last, because it throws away the wizard's state and anything
     holding a reference to it. */
  D.querySelectorAll('.modal-backdrop').forEach((m) => m.remove());
  Object.defineProperty(window.navigator, 'pdfViewerEnabled', { get: () => false, configurable: true });
  window.AccomplishmentUI.open(ev.id);
  await sleep(60);
  check('a browser that will not show one is told so, not left with a grey box',
    /will not show a PDF/i.test((D.querySelector('#pv-frame') || {}).textContent || ''),
    (D.querySelector('#pv-frame') || {}).textContent);
  check('and the way out is still there', !!D.querySelector('[data-open-preview]'));
  Object.defineProperty(window.navigator, 'pdfViewerEnabled', { get: () => true, configurable: true });

  D.querySelectorAll('.modal-backdrop').forEach((m) => m.remove());
}

/* ---------------- a browser that will not save ----------------
   A full browser, or a private window, refuses to store anything. The app used
   to say so in a toast and carry on looking perfectly normal — so an officer
   works all afternoon, every event added and every task ticked, with none of it
   written down, and one refresh ends it. A warning that is gone in four seconds
   is not a warning about something that lasts. */
console.log('\n--- a browser that will not save says so, and keeps saying it ---');
{
  const D = window.document;
  /* jsdom's Storage ignores an own-property stub on setItem — it has to go on
     the prototype, which is also where a real browser's lives. Worth knowing:
     stubbing it the obvious way silently does nothing, and the test then proves
     that storage working is handled, which nobody doubted. */
  const proto = Object.getPrototypeOf(window.localStorage);
  const real = proto.setItem;
  proto.setItem = function (k, v) {
    if (k === 'fcusr.tracker.v1') { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; }
    return real.call(this, k, v);
  };
  window.Store.addEvent({ title: 'probe', unitId: window.Store.nationalUnitId() });
  check('the stub actually refuses writes', window.Store.storageBroken(),
    'storage did not refuse, so the rest of this section proves nothing');

  window.Store.addEvent({ title: 'Made while storage was full', unitId: window.Store.nationalUnitId() });
  await sleep(60);

  const bar = () => D.getElementById('storage-bar');
  check('a bar appears and stays', !!bar());
  check('and it says nothing is being saved',
    bar() && /not being saved/i.test(bar().textContent), bar() && bar().textContent.slice(0, 80));
  check('the work is still on the screen, not thrown away',
    window.Store.events().some((e) => e.title === 'Made while storage was full'));

  // A second change must not stack a second bar.
  window.Store.addEvent({ title: 'And another', unitId: window.Store.nationalUnitId() });
  await sleep(60);
  check('and one bar, however many changes', D.querySelectorAll('#storage-bar').length === 1,
    String(D.querySelectorAll('#storage-bar').length));

  proto.setItem = real;
  window.Store.addEvent({ title: 'After storage came back', unitId: window.Store.nationalUnitId() });
  await sleep(60);
  check('and it goes when saving works again', !bar());

  window.Store.events()
    .filter((e) => /probe|Made while storage was full|And another|After storage came back/.test(e.title))
    .forEach((e) => window.Store.deleteEvent(e.id));
}

console.log('\n--- console cleanliness ---');
/* One error is deliberate: the section above refuses every write to storage on
   purpose, and the app is right to complain about it in the console. Anything
   else is a fault. Named exactly rather than loosened, so a real storage error
   somewhere else still fails this. */
const deliberate = /Could not save to browser storage/;
const unexpected = errors.filter((e) => !deliberate.test(e));
check('no console errors across the walk-through', unexpected.length === 0,
  unexpected.slice(0, 4).join(' | '));
check('and the storage complaint was raised exactly once, where it was asked for',
  errors.filter((e) => deliberate.test(e)).length === 1,
  String(errors.filter((e) => deliberate.test(e)).length));

const failed = results.filter((r) => !r.pass);
console.log('\n========================================');
console.log(results.length - failed.length + ' passed, ' + failed.length + ' failed');
if (failed.length) {
  failed.forEach((f) => console.log('  FAILED: ' + f.name + (f.extra ? '  — ' + f.extra : '')));
  process.exit(1);
}
/* Explicitly, like every other suite. The app runs timers — syncing, the
   version check — and a browser is right to let them run. A harness that exits
   only when nothing is left scheduled is really asserting that the app holds no
   timers, which is neither true nor anything worth asserting. */
process.exit(0);
})();
