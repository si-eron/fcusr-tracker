/* FCUSR Task Tracker — the dialogs shared by more than one screen:
   create/edit an event, edit a task, add/edit a person. */
(function (global) {
  'use strict';

  function field(opts) {
    return '<div class="field" data-field="' + opts.name + '">' +
      '<label for="f-' + opts.name + '">' + U.esc(opts.label) +
      (opts.required ? ' <span class="req" aria-hidden="true">*</span>' : '') + '</label>' +
      opts.control +
      (opts.hint ? '<div class="hint">' + U.esc(opts.hint) + '</div>' : '') +
      '<div class="error-text" hidden></div></div>';
  }

  function showError(root, name, message) {
    var f = root.querySelector('[data-field="' + name + '"]');
    if (!f) return;
    f.classList.add('has-error');
    var e = f.querySelector('.error-text');
    e.textContent = message;
    e.hidden = false;
    var input = f.querySelector('input,select,textarea');
    if (input) input.focus();
  }

  function clearErrors(root) {
    U.els('.field.has-error', root).forEach(function (f) {
      f.classList.remove('has-error');
      var e = f.querySelector('.error-text');
      if (e) e.hidden = true;
    });
  }

  /* ---------- event ---------- */

  function eventForm(eventId, opts) {
    opts = opts || {};
    var ev = eventId ? Store.event(eventId) : null;
    var isNew = !ev;
    var e = ev || {
      title: '', description: '', dateStart: U.today(), dateEnd: '', venue: '',
      headId: '', status: 'Upcoming', feedbackRequired: true, feedbackLink: '',
      unitId: opts.unitId || (global.Auth ? Auth.myUnitId() : Store.nationalUnitId())
    };


    var body =
      field({
        name: 'title', label: 'Event title', required: true,
        control: '<input type="text" id="f-title" data-autofocus maxlength="120" value="' + U.esc(e.title) + '" placeholder="e.g. Foundation Week 2026">'
      }) +
      field({
        name: 'description', label: 'Short description',
        control: '<textarea id="f-description" maxlength="400" placeholder="What is this event or program about?">' + U.esc(e.description) + '</textarea>'
      }) +
      '<div class="field-row">' +
      field({
        name: 'dateStart', label: 'Event date', required: true,
        control: '<input type="date" id="f-dateStart" value="' + U.esc(e.dateStart) + '">'
      }) +
      field({
        name: 'dateEnd', label: 'End date',
        control: '<input type="date" id="f-dateEnd" value="' + U.esc(e.dateEnd) + '">',
        hint: 'Leave blank for a one-day event.'
      }) +
      '</div>' +
      field({
        name: 'venue', label: 'Venue',
        control: '<input type="text" id="f-venue" maxlength="120" value="' + U.esc(e.venue) + '" placeholder="e.g. FCU Gymnasium">'
      }) +
      /* Every activity is evaluated. The field sits here rather than in the
         report wizard because the form has to exist before the activity runs —
         asking for it afterwards is asking too late to be any use. */
      field({
        name: 'feedbackLink', label: 'Feedback form',
        control: '<input type="text" id="f-feedback" maxlength="300" value="' +
          U.esc(e.feedbackLink || '') + '" placeholder="https://forms.gle/…">',
        hint: e.feedbackRequired === false
          ? 'Not required for this activity. The requirement can be put back from the activity itself.'
          : 'Required by standard. Make a Google Form and paste its link. You can add it later, ' +
            'but the activity cannot be marked completed without one.'
      }) +
      '<div class="field-row">' +
      field({
        name: 'headId', label: 'Event head',
        control: '<select id="f-headId">' + UI.peopleOptions(e.headId, true, e.id).replace('>Unassigned<', '>Not set yet<') + '</select>'
      }) +
      field({
        name: 'status', label: 'Status',
        control: '<select id="f-status">' + UI.selectOptions(Store.EVENT_STATUSES, e.status) + '</select>'
      }) +
      '</div>';

    UI.modal({
      title: isNew ? 'Create event' : 'Edit event',
      body: body,
      footer: '<button type="button" class="btn" data-close>Cancel</button>' +
        '<button type="button" class="btn btn-primary" data-save>' + (isNew ? 'Create event' : 'Save changes') + '</button>',
      onMount: function (root, close) {
        function submit() {
          clearErrors(root);
          var data = {
            title: root.querySelector('#f-title').value.trim(),
            description: root.querySelector('#f-description').value,
            dateStart: root.querySelector('#f-dateStart').value,
            dateEnd: root.querySelector('#f-dateEnd').value,
            venue: root.querySelector('#f-venue').value,
            headId: root.querySelector('#f-headId').value,
            status: root.querySelector('#f-status').value
          };
          /* There is no "whose event" to choose. You are signed in to one
             unit's tracker, so an event you create there is that unit's — the
             question only ever had one answer. */
          if (isNew) data.unitId = e.unitId;

          data.feedbackLink = root.querySelector('#f-feedback').value.trim();
          if (data.feedbackLink &&
              !/^https:\/\/(docs\.google\.com\/forms\/|forms\.gle\/)/.test(data.feedbackLink)) {
            return showError(root, 'feedbackLink',
              'That needs to be a Google Forms link \u2014 forms.gle or docs.google.com/forms.');
          }

          if (!data.title) return showError(root, 'title', 'Give the event a title.');
          if (!data.dateStart) return showError(root, 'dateStart', 'Pick the event date.');
          if (data.dateEnd && data.dateEnd < data.dateStart) {
            return showError(root, 'dateEnd', 'The end date cannot be before the start date.');
          }
          if (isNew) {
            var created = Store.addEvent(data);
            close();
            UI.toast('Event created.');
            // Straight into the new event, ready for its first task.
            global.ViewEventDetail.openAddTaskOnLoad();
            App.go('#/events/' + created.id);
          } else {
            Store.updateEvent(eventId, data);
            close();
            UI.toast('Event saved.');
          }
        }
        root.querySelector('[data-save]').addEventListener('click', submit);
        root.querySelector('#f-title').addEventListener('keydown', function (e2) {
          if (e2.key === 'Enter') { e2.preventDefault(); submit(); }
        });
      }
    });
  }

  /* ---------- task ---------- */

  function taskForm(taskId) {
    var t = Store.task(taskId);
    if (!t) return;
    var ev = Store.event(t.eventId);

    var body =
      field({
        name: 'title', label: 'Task', required: true,
        control: '<input type="text" id="f-title" data-autofocus maxlength="160" value="' + U.esc(t.title) + '">'
      }) +
      '<div class="field-row">' +
      field({
        name: 'assigneeId', label: 'Assigned to',
        control: '<select id="f-assigneeId">' + UI.peopleOptions(t.assigneeId, true, t.eventId) + '</select>'
      }) +
      field({
        name: 'dueDate', label: 'Due date',
        control: '<input type="date" id="f-dueDate" value="' + U.esc(t.dueDate) + '">'
      }) +
      '</div>' +
      '<div class="field-row">' +
      field({
        name: 'priority', label: 'Priority',
        control: '<select id="f-priority">' + UI.selectOptions(Store.PRIORITIES, t.priority) + '</select>'
      }) +
      field({
        name: 'status', label: 'Status',
        control: '<select id="f-status">' + UI.selectOptions(Store.STATUSES, t.status) + '</select>'
      }) +
      '</div>' +
      '<div id="blocked-wrap"' + (t.status === 'On hold' ? '' : ' hidden') + '>' +
      field({
        name: 'blockedReason', label: 'Why is it on hold?', required: true,
        control: '<input type="text" id="f-blockedReason" maxlength="140" value="' + U.esc(t.blockedReason) + '" placeholder="e.g. Waiting for the adviser to sign.">'
      }) + '</div>' +
      field({
        name: 'remarks', label: 'Remarks',
        control: '<textarea id="f-remarks" maxlength="400" placeholder="Anything the officer should know.">' + U.esc(t.remarks) + '</textarea>'
      }) +
      '<div class="field-row">' +
      field({
        name: 'eventId', label: 'Event', required: true,
        control: '<select id="f-eventId">' + UI.selectOptions(
          Store.events().map(function (e) { return { value: e.id, label: e.title }; }), t.eventId
        ) + '</select>',
        hint: 'Every task belongs to an event.'
      }) + '</div>' +
      '<p class="tiny muted" style="margin:2px 0 0">Last updated ' + U.esc(U.fmtStamp(t.updatedAt)) +
      (t.completedAt ? ' · Completed ' + U.esc(U.fmtStamp(t.completedAt)) : '') + '</p>';

    UI.modal({
      title: 'Edit task',
      body: body,
      footer:
        '<button type="button" class="btn btn-danger left" data-delete>' + UI.icon('trash') + 'Delete</button>' +
        '<button type="button" class="btn" data-close>Cancel</button>' +
        '<button type="button" class="btn btn-primary" data-save>Save changes</button>',
      onMount: function (root, close) {
        var statusSel = root.querySelector('#f-status');
        var blockedWrap = root.querySelector('#blocked-wrap');
        statusSel.addEventListener('change', function () {
          blockedWrap.hidden = statusSel.value !== 'On hold';
        });

        root.querySelector('[data-save]').addEventListener('click', function () {
          clearErrors(root);
          var data = {
            title: root.querySelector('#f-title').value.trim(),
            assigneeId: root.querySelector('#f-assigneeId').value,
            dueDate: root.querySelector('#f-dueDate').value,
            priority: root.querySelector('#f-priority').value,
            status: statusSel.value,
            remarks: root.querySelector('#f-remarks').value,
            blockedReason: root.querySelector('#f-blockedReason').value.trim(),
            eventId: root.querySelector('#f-eventId').value
          };
          if (!data.title) return showError(root, 'title', 'Give the task a title.');
          if (data.status === 'On hold' && !data.blockedReason) {
            return showError(root, 'blockedReason', 'Add a one-line reason.');
          }
          Store.updateTask(taskId, data);
          close();
          UI.toast('Task saved.');
        });

        root.querySelector('[data-delete]').addEventListener('click', function () {
          UI.confirm({
            title: 'Delete this task?',
            message: '“' + t.title + '” will be removed from ' + (ev ? ev.title : 'this event') + '.',
            detail: 'This cannot be undone.',
            confirmLabel: 'Delete task'
          }).then(function (ok) {
            if (!ok) return;
            Store.deleteTask(taskId);
            close();
            UI.toast('Task deleted.');
          });
        });
      }
    });
  }


  /* ---------- enrolment ----------
     The single door through which access is created. Position is free text and
     grants nothing; the toggle and the event list are what actually decide what
     the person can reach. */

  /* A unit — the National government, a province (a college or school level),
     COMELEC, or the Supreme Court. Names and codes are edited here rather than in
     code, because the roster of colleges changes and the app must not need a
     developer when it does. */
  function unitForm(unitId) {
    var u = unitId ? Store.unit(unitId) : null;
    var isNew = !u;
    var isNational = !!u && u.kind === 'national';
    var held = u ? Store.unitEventCount(u.id) : 0;
    var d = u || { name: '', code: '', kind: 'province', active: true };

    var KINDS = [
      ['province', 'Province — a college or school level'],
      ['comelec', 'COMELEC'],
      ['judiciary', 'Judiciary'],
      ['branch', 'Independent body — runs its own tracker']
    ];

    var body =
      field({
        name: 'name', label: 'Name', required: true,
        control: '<input type="text" id="f-uname" data-autofocus maxlength="120" value="' +
          U.esc(d.name) + '" placeholder="e.g. College of Nursing">'
      }) +
      field({
        name: 'code', label: 'Short code',
        control: '<input type="text" id="f-ucode" maxlength="16" value="' + U.esc(d.code) + '" placeholder="e.g. CN">',
        hint: 'Shown as a badge beside their events. Letters and numbers only.'
      }) +
      field({
        name: 'trackerName', label: 'Name in the header',
        control: '<input type="text" id="f-utracker" maxlength="120" value="' +
          U.esc(Store.trackerName(d)) + '" placeholder="e.g. FCUSR COE">',
        hint: 'What their people see at the top of the screen, with ' +
          '&ldquo;Task Tracker&rdquo; added after it.'
      }) +
      (isNational
        ? '<p class="small muted">This is the National government. It cannot be renamed to another kind, ' +
          'made inactive, or removed &mdash; council-wide work is filed here.</p>'
        : field({
            name: 'kind', label: 'Kind',
            control: '<select id="f-ukind">' + KINDS.map(function (k) {
              return '<option value="' + k[0] + '"' + (d.kind === k[0] ? ' selected' : '') + '>' +
                U.esc(k[1]) + '</option>';
            }).join('') + '</select>'
          })) +
      (!isNew && !isNational
        ? '<p class="small muted">' + (held
            ? U.plural(held, 'event') + ' filed here. A unit holding events can be set inactive but not removed, ' +
              'so past work keeps its unit.'
            : 'Nothing is filed here yet, so it can be removed outright.') + '</p>'
        : '');

    UI.modal({
      title: isNew ? 'Add unit' : 'Edit unit',
      body: body,
      footer: '<button type="button" class="btn" data-close>Cancel</button>' +
        (!isNew && !isNational && !held
          ? '<button type="button" class="btn btn-danger" data-remove>Remove</button>' : '') +
        '<button type="button" class="btn btn-primary" data-save>' + (isNew ? 'Add unit' : 'Save') + '</button>',
      onMount: function (root, close) {
        function submit() {
          clearErrors(root);
          var kindEl = root.querySelector('#f-ukind');
          var data = {
            name: root.querySelector('#f-uname').value.trim(),
            code: root.querySelector('#f-ucode').value.trim(),
            trackerName: root.querySelector('#f-utracker').value.trim(),
            kind: kindEl ? kindEl.value : d.kind
          };
          if (!data.name) return showError(root, 'name', 'Give the unit a name.');
          if (isNew) {
            Store.addUnit(data);
            close();
            UI.toast(data.name + ' added.');
          } else {
            Store.updateUnit(unitId, data);
            close();
            UI.toast('Unit saved.');
          }
        }
        root.querySelector('[data-save]').addEventListener('click', submit);
        root.querySelector('#f-uname').addEventListener('keydown', function (e2) {
          if (e2.key === 'Enter') { e2.preventDefault(); submit(); }
        });

        var rm = root.querySelector('[data-remove]');
        if (rm) rm.addEventListener('click', function () {
          UI.confirm({
            title: 'Remove ' + d.name + '?',
            message: 'It disappears from the unit list and from every picker.',
            detail: 'Nothing is filed under it, so no work is lost. You can add it back later.',
            confirmLabel: 'Remove unit'
          }).then(function (ok) {
            if (!ok) return;
            try {
              Store.deleteUnit(unitId);
              close();
              UI.toast(d.name + ' removed.');
            } catch (err) {
              UI.toast(err.message, 'error');
            }
          });
        });
      }
    });
  }

  /* ---------- offices ---------- */

  /* An office a letter passes through. The turnaround is the only number here
     and it earns its place: it is what lets the tracker say "this has been
     sitting there too long" instead of only "it is there". */
  function officeForm(officeId) {
    var o = officeId ? Store.office(officeId) : null;
    var isNew = !o;
    var held = o ? Store.officeLetterCount(o.id) : 0;
    var d = o || { name: '', code: '', turnaroundDays: 3 };

    var body =
      field({
        name: 'name', label: 'Office', required: true,
        control: '<input type="text" id="f-oname" data-autofocus maxlength="120" value="' +
          U.esc(d.name) + '" placeholder="e.g. Office of Student Affairs">'
      }) +
      '<div class="field-row">' +
      field({
        name: 'code', label: 'Short code',
        control: '<input type="text" id="f-ocode" maxlength="16" value="' + U.esc(d.code) +
          '" placeholder="e.g. OSA">'
      }) +
      field({
        name: 'turnaround', label: 'Usually takes', required: true,
        control: '<input type="number" id="f-odays" min="1" max="120" value="' +
          U.esc(String(d.turnaroundDays)) + '">',
        hint: 'Days. A letter left longer than this is flagged for chasing.'
      }) +
      '</div>' +
      (!isNew
        ? '<p class="small muted">' + (held
            ? U.plural(held, 'letter') + ' has passed through here. An office with a trail can be ' +
              'set inactive but not removed, so old trails still read correctly.'
            : 'No letter has been through here yet, so it can be removed outright.') + '</p>'
        : '');

    UI.modal({
      title: isNew ? 'Add an office' : 'Edit office',
      body: body,
      footer: '<button type="button" class="btn" data-close>Cancel</button>' +
        (!isNew && !held ? '<button type="button" class="btn btn-danger" data-remove>Remove</button>' : '') +
        '<button type="button" class="btn btn-primary" data-save>' + (isNew ? 'Add office' : 'Save') + '</button>',
      onMount: function (root, close) {
        function submit() {
          clearErrors(root);
          var data = {
            name: root.querySelector('#f-oname').value.trim(),
            code: root.querySelector('#f-ocode').value.trim(),
            turnaroundDays: root.querySelector('#f-odays').value
          };
          if (!data.name) return showError(root, 'name', 'Give the office a name.');
          var days = Number(data.turnaroundDays);
          if (!isFinite(days) || days < 1) {
            return showError(root, 'turnaround', 'How many days does it usually take?');
          }
          if (isNew) Store.addOffice(data); else Store.updateOffice(officeId, data);
          close();
          UI.toast(isNew ? data.name + ' added.' : 'Office saved.');
        }
        root.querySelector('[data-save]').addEventListener('click', submit);
        root.querySelector('#f-oname').addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { e.preventDefault(); submit(); }
        });

        var rm = root.querySelector('[data-remove]');
        if (rm) rm.addEventListener('click', function () {
          try {
            Store.deleteOffice(officeId);
            close();
            UI.toast(d.name + ' removed.');
          } catch (err) { UI.toast(err.message, 'error'); }
        });
      }
    });
  }

  /* ---------- letters ---------- */

  /* Whoever is walking the letter round. Usually an officer already in the
     directory, but a letter is sometimes carried by someone who is not, so a
     typed name is allowed rather than forcing a fake directory entry. */
  function inChargeControl(l) {
    var chosen = l && l.inChargeId ? l.inChargeId : (l && l.inChargeName ? '__typed' : '');
    return '<select id="f-lcharge">' +
      '<option value="">Not decided yet</option>' +
      Store.people({ activeOnly: true }).map(function (p) {
        return '<option value="' + U.esc(p.id) + '"' + (chosen === p.id ? ' selected' : '') + '>' +
          U.esc(p.name) + (p.position ? ' — ' + U.esc(p.position) : '') + '</option>';
      }).join('') +
      '<option value="__typed"' + (chosen === '__typed' ? ' selected' : '') + '>Someone else…</option>' +
      '</select>' +
      '<input type="text" id="f-lchargename" maxlength="80" placeholder="Their name" ' +
      'style="margin-top:8px"' + (chosen === '__typed' ? '' : ' hidden') + ' value="' +
      U.esc(l ? l.inChargeName : '') + '">';
  }

  /* The FCUSR President signs the council's papers. The one exception anybody
     could name is a letter that never leaves the council, so that is exactly
     what this asks — and the answer is kept on the letter, because "we decided
     this one is internal" is a fact worth being able to see later. */
  function askIfInternal(subject) {
    return UI.confirm({
      title: 'The FCUSR President signs this',
      message: 'The President signs every letter and communication the council ' +
        'sends out. Taking them off the list is only right if ' +
        (subject ? '\u201c' + subject + '\u201d' : 'this letter') +
        ' stays inside the FCUSR and goes to no University office.',
      detail: 'If it is going to an adviser, a dean, the OSA or anyone else outside ' +
        'the council, the President signs it first.',
      tone: 'primary',
      cancelLabel: 'Keep the President',
      confirmLabel: 'It is internal — remove'
    });
  }

  function letterForm(letterId, opts) {
    opts = opts || {};
    var l = letterId ? Store.letter(letterId) : null;
    var isNew = !l;
    var d = l || {
      subject: '', eventId: opts.eventId || '', inChargeId: '', inChargeName: '',
      deadline: '', stops: []
    };

    // The offices already chosen, in order. Stops that have happened cannot be
    // moved, so they are shown locked.
    /* Entries, not office ids: most signatories are an office, but a letter can
       also be signed by somebody who holds none. */
    var route = (d.stops || []).map(function (s) {
      return { officeId: s.officeId, label: s.label };
    });
    var lockedCount = (d.stops || []).filter(function (s) { return s.receivedAt || s.releasedAt; }).length;
    var templates = Store.routeTemplates();
    var openEvents = Store.events({ activeOnly: true });

    var body =
      field({
        name: 'subject', label: 'What the letter is about', required: true,
        control: '<input type="text" id="f-lsubject" data-autofocus maxlength="200" value="' +
          U.esc(d.subject) + '" placeholder="e.g. Request to use the gymnasium">',
        hint: 'The subject line. No document is stored here — this only tracks where it has got to.'
      }) +
      field({
        name: 'eventId', label: 'For which activity',
        control: '<select id="f-levent">' +
          '<option value="">Council business — no activity</option>' +
          openEvents.map(function (e) {
            return '<option value="' + U.esc(e.id) + '"' + (d.eventId === e.id ? ' selected' : '') + '>' +
              U.esc(e.title) + '</option>';
          }).join('') + '</select>'
      }) +
      '<div class="field-row">' +
      field({ name: 'inCharge', label: 'Who is processing it', control: inChargeControl(l) }) +
      field({
        name: 'deadline', label: 'Needed by',
        control: '<input type="date" id="f-ldeadline" value="' + U.esc(d.deadline) + '">',
        hint: 'Optional.'
      }) +
      '</div>' +
      '<div class="field"><span class="field-label">Signatories, in order <span class="req">*</span></span>' +
      '<p class="hint" style="margin:-2px 0 8px">Every desk the letter has to be signed at, ' +
      'from the person who wrote it to the last signature. Start from one of the council&rsquo;s ' +
      'three usual letters and change what does not apply.</p>' +
      (templates.length
        ? '<select id="f-ltemplate" style="margin-bottom:10px">' +
          '<option value="">Start from a common letter…</option>' +
          templates.map(function (t, i) {
            return '<option value="' + i + '">' + U.esc(t.name) + '</option>';
          }).join('') + '</select>'
        : '') +
      '<div id="tpl-note" hidden></div>' +
      '<div id="route-list"></div>' +
      '<div class="row" style="gap:6px;flex-wrap:nowrap;margin-top:8px">' +
      '<select id="f-laddoffice" style="flex:1">' +
      '<option value="">Add an office or person…</option>' +
      Store.offices({ activeOnly: true }).map(function (o) {
        return '<option value="' + U.esc(o.id) + '">' + U.esc(o.name) + '</option>';
      }).join('') +
      '<option value="__office">An office that is not listed…</option>' +
      '<option value="__typed">Somebody with no office…</option>' +
      '</select></div>' +
      '<div class="row" style="gap:6px;flex-wrap:nowrap;margin-top:6px" id="f-lnamerow" hidden>' +
      '<input type="text" id="f-laddname" maxlength="80" style="flex:1">' +
      '<button type="button" class="btn" data-addname>Add</button></div>' +
      '<p class="hint" id="f-lnamehint" hidden style="margin:6px 2px 0"></p>' +
      '<div class="error-text" hidden>Choose at least one office or person.</div></div>';

    UI.modal({
      title: isNew ? 'Track a letter' : 'Edit letter',
      wide: true,
      body: body,
      footer: '<button type="button" class="btn" data-close>Cancel</button>' +
        '<button type="button" class="btn btn-primary" data-save>' +
        (isNew ? 'Start tracking' : 'Save changes') + '</button>',
      onMount: function (root, close) {
        var listEl = root.querySelector('#route-list');
        var noteEl = root.querySelector('#tpl-note');
        var presidentId = Store.presidentOfficeId();
        var internal = !!d.internal;

        function indexOfPresident() {
          if (!presidentId) return -1;
          for (var i = 0; i < route.length; i++) if (route[i].officeId === presidentId) return i;
          return -1;
        }
        function hasPresident() { return !presidentId || indexOfPresident() >= 0; }

        function drawRoute() {
          if (!route.length) {
            listEl.innerHTML = '<p class="small muted" style="margin:0">Nothing chosen yet — ' +
              'pick a common route above, or add offices one at a time.</p>';
            return;
          }
          listEl.innerHTML = '<ol class="route-pick">' + route.map(function (e, i) {
            var locked = i < lockedCount;
            var pres = presidentId && e.officeId === presidentId;
            return '<li' + (locked ? ' class="is-locked"' : '') + '>' +
              '<span class="rp-n">' + (i + 1) + '</span>' +
              '<span class="rp-name">' + U.esc(Store.stopName(e)) +
                (!e.officeId ? ' <span class="chip chip-plain">person</span>' : '') +
                (pres ? ' <span class="chip st-done">signs everything</span>' : '') +
                (locked ? ' <span class="chip chip-plain">already been</span>' : '') + '</span>' +
              (locked ? '' :
                '<span class="rp-bar">' +
                '<button type="button" class="btn btn-sm btn-ghost" data-rmove="' + i + ':-1"' +
                  (i <= lockedCount ? ' disabled' : '') + ' aria-label="Move up">↑</button>' +
                '<button type="button" class="btn btn-sm btn-ghost" data-rmove="' + i + ':1"' +
                  (i === route.length - 1 ? ' disabled' : '') + ' aria-label="Move down">↓</button>' +
                '<button type="button" class="btn btn-sm btn-ghost" data-rdrop="' + i + '" ' +
                  'aria-label="Remove">' + UI.icon('close') + '</button></span>') +
              '</li>';
          }).join('') + '</ol>';

          U.els('[data-rmove]', listEl).forEach(function (b) {
            b.addEventListener('click', function () {
              var parts = b.getAttribute('data-rmove').split(':');
              var i = Number(parts[0]), dir = Number(parts[1]);
              var j = i + dir;
              if (j < lockedCount || j >= route.length) return;
              var t = route[i]; route[i] = route[j]; route[j] = t;
              drawRoute();
            });
          });
          U.els('[data-rdrop]', listEl).forEach(function (b) {
            b.addEventListener('click', function () {
              var i = Number(b.getAttribute('data-rdrop'));
              if (presidentId && route[i].officeId === presidentId && !internal) {
                return askIfInternal(root.querySelector('#f-lsubject').value.trim())
                  .then(function (ok) {
                    if (!ok) return;
                    internal = true;
                    route.splice(i, 1);
                    drawRoute();
                  });
              }
              route.splice(i, 1);
              drawRoute();
            });
          });

          // Said under the list, where the gap is, rather than only on removal.
          if (!hasPresident()) {
            listEl.insertAdjacentHTML('beforeend',
              '<div class="gate-note" style="margin:10px 0 0">' + UI.icon('alert') +
              '<span><strong>No FCUSR President on this letter.</strong> That is only right ' +
              'for a letter that stays inside the council. ' +
              '<button type="button" class="linkish" data-readd>Put the President back</button>' +
              '</span></div>');
            var re = listEl.querySelector('[data-readd]');
            if (re) re.addEventListener('click', function () {
              internal = false;
              route.splice(Math.min(lockedCount + 2, route.length), 0, { officeId: presidentId, label: '' });
              drawRoute();
            });
          }
        }
        drawRoute();

        var tpl = root.querySelector('#f-ltemplate');
        if (tpl) tpl.addEventListener('change', function () {
          if (tpl.value === '') return;
          var picked = templates[Number(tpl.value)];
          // Anything already visited stays; the rest is replaced by the template.
          var head = route.slice(0, lockedCount);
          route = head.concat(picked.officeIds.filter(function (oid) {
            return !head.some(function (e) { return e.officeId === oid; });
          }).map(function (oid) { return { officeId: oid, label: '' }; }));
          internal = false;
          tpl.value = '';
          // Some routes carry an instruction of their own; it belongs on screen
          // at the moment the route is chosen, not in a handbook nobody opens.
          if (picked.note) {
            noteEl.innerHTML = '<div class="gate-note" style="margin:0 0 10px">' + UI.icon('alert') +
              '<span>' + U.esc(picked.note) + '</span></div>';
            noteEl.hidden = false;
          } else {
            noteEl.hidden = true;
            noteEl.innerHTML = '';
          }
          drawRoute();
        });

        var add = root.querySelector('#f-laddoffice');
        var nameRow = root.querySelector('#f-lnamerow');
        var nameIn = root.querySelector('#f-laddname');
        var nameHint = root.querySelector('#f-lnamehint');
        var typedMode = 'person';   // 'person' = this letter only · 'office' = added to the list

        add.addEventListener('change', function () {
          if (!add.value) return;
          if (add.value === '__typed' || add.value === '__office') {
            typedMode = add.value === '__office' ? 'office' : 'person';
            nameRow.hidden = false;
            nameHint.hidden = false;
            nameIn.placeholder = typedMode === 'office'
              ? 'Name of the office' : 'Who has to sign — name or title';
            nameHint.textContent = typedMode === 'office'
              ? 'Added to the council\u2019s list of offices, so the next letter can pick it ' +
                'straight from the dropdown. Edit or remove it later in Settings.'
              : 'Kept on this letter only. Use an office instead wherever there is one \u2014 ' +
                'an office outlasts whoever is sitting in it.';
            nameIn.value = '';
            nameIn.focus();
            add.value = '';
            return;
          }
          var oid = add.value;
          if (!route.some(function (e) { return e.officeId === oid; })) {
            route.push({ officeId: oid, label: '' });
          }
          add.value = '';
          drawRoute();
        });

        function addTypedName() {
          var name = nameIn.value.trim();
          if (!name) return nameIn.focus();

          if (typedMode === 'office') {
            var existing = Store.offices().filter(function (o) {
              return o.name.toLowerCase() === name.toLowerCase();
            })[0];
            var made;
            try {
              made = existing || Store.addOffice({ name: name });
            } catch (err) {
              return UI.toast(err.message || 'That office could not be added.', 'error');
            }
            if (existing && existing.active === false) Store.setOfficeActive(existing.id, true);
            if (!route.some(function (e) { return e.officeId === made.id; })) {
              route.push({ officeId: made.id, label: '' });
            }
            // The dropdown has to learn the new office without redrawing the form.
            if (!add.querySelector('option[value="' + made.id + '"]')) {
              var opt = document.createElement('option');
              opt.value = made.id;
              opt.textContent = made.name;
              add.insertBefore(opt, add.querySelector('option[value="__office"]'));
            }
            UI.toast(existing ? made.name + ' was already on the list.' : made.name + ' added to the offices.');
          } else {
            route.push({ officeId: '', label: name });
          }

          nameIn.value = '';
          nameRow.hidden = true;
          nameHint.hidden = true;
          drawRoute();
        }
        root.querySelector('[data-addname]').addEventListener('click', addTypedName);
        nameIn.addEventListener('keydown', function (ev) {
          if (ev.key === 'Enter') { ev.preventDefault(); addTypedName(); }
        });

        var charge = root.querySelector('#f-lcharge');
        var chargeName = root.querySelector('#f-lchargename');
        charge.addEventListener('change', function () {
          chargeName.hidden = charge.value !== '__typed';
          if (!chargeName.hidden) chargeName.focus();
        });

        root.querySelector('[data-save]').addEventListener('click', function () {
          clearErrors(root);
          var subject = root.querySelector('#f-lsubject').value.trim();
          if (!subject) return showError(root, 'subject', 'What is the letter about?');
          if (!route.length) {
            var f = listEl.closest('.field');
            f.classList.add('has-error');
            f.querySelector('.error-text').hidden = false;
            return;
          }

          var data = {
            subject: subject,
            eventId: root.querySelector('#f-levent').value,
            deadline: root.querySelector('#f-ldeadline').value,
            inChargeId: charge.value === '__typed' ? '' : charge.value,
            inChargeName: charge.value === '__typed' ? chargeName.value.trim() : '',
            route: route,
            internal: !hasPresident() && internal
          };

          /* A route can lose the President without the remove button — a
             template picked over the top of one, say — so the question is asked
             again here rather than trusted to have been asked already. */
          if (!hasPresident() && !internal) {
            return askIfInternal(subject).then(function (ok) {
              if (!ok) {
                internal = false;
                route.splice(Math.min(lockedCount + 2, route.length), 0,
                  { officeId: presidentId, label: '' });
                return drawRoute();
              }
              internal = true;
              data.internal = true;
              commit();
            });
          }
          commit();

          function commit() {
          if (isNew) {
            data.unitId = global.Auth ? Auth.myUnitId() : Store.nationalUnitId();
            var made = Store.addLetter(data);
            close();
            UI.toast('Now tracking that letter.');
            App.go('#/letters/' + made.id);
          } else {
            Store.updateLetter(letterId, data);
            close();
            UI.toast('Letter saved.');
          }
          }
        });
      }
    });
  }

  /* ---------- an office asks for another signature first ----------

     A dean who will not sign until the OSA has, an accountant who wants the
     adviser's name on it first. The letter is already out, so the route is not
     a plan any more — it is a thing in someone's hands. This puts one desk in,
     immediately before or after the desk holding it, and leaves everything
     already signed exactly as it was. */

  function insertStopForm(letterId, stopId) {
    var l = Store.letter(letterId);
    if (!l) return;
    var at = -1;
    l.stops.forEach(function (s, i) { if (s.id === stopId) at = i; });
    if (at < 0) return;

    var here = Store.stopName(l.stops[at]);
    var choices = Store.offices({ activeOnly: true });

    var body =
      '<p class="small" style="margin-top:0">' + U.esc(here) + ' has the letter. ' +
      'Add whoever they are waiting on — the route keeps everything already signed.</p>' +
      field({
        name: 'office', label: 'Who has to sign', required: true,
        control: '<select id="f-isoffice" data-autofocus>' +
          '<option value="">Choose an office or person…</option>' +
          choices.map(function (o) {
            return '<option value="' + U.esc(o.id) + '">' + U.esc(o.name) + '</option>';
          }).join('') +
          '<option value="__office">An office that is not listed…</option>' +
          '<option value="__typed">Somebody with no office…</option>' +
          '</select>' +
          '<input type="text" id="f-isname" maxlength="80" style="margin-top:8px" hidden>',
        hint: 'An office wherever there is one — it outlasts whoever is sitting in it. ' +
          'Type a name only when the signature belongs to no office.'
      }) +
      field({
        name: 'where', label: 'Signs when',
        control: '<select id="f-iswhere">' +
          '<option value="before">Before ' + U.esc(here) + ' — they are waiting on it</option>' +
          '<option value="after">After ' + U.esc(here) + ' — sent on there next</option>' +
          '</select>'
      });

    UI.modal({
      title: 'Add an office to the route',
      body: body,
      footer: '<button type="button" class="btn" data-close>Cancel</button>' +
        '<button type="button" class="btn btn-primary" data-save>Add the office</button>',
      onMount: function (root, close) {
        var pick = root.querySelector('#f-isoffice');
        var typed = root.querySelector('#f-isname');
        pick.addEventListener('change', function () {
          typed.hidden = pick.value !== '__typed' && pick.value !== '__office';
          typed.placeholder = pick.value === '__office'
            ? 'Name of the office — added to the list'
            : 'Their name or title — this letter only';
          if (!typed.hidden) typed.focus();
        });

        root.querySelector('[data-save]').addEventListener('click', function () {
          clearErrors(root);
          var entry;
          if (pick.value === '__typed' || pick.value === '__office') {
            var name = typed.value.trim();
            if (!name) {
              return showError(root, 'office', pick.value === '__office'
                ? 'What is the office called?' : 'Who has to sign it?');
            }
            if (pick.value === '__office') {
              var existing = Store.offices().filter(function (o) {
                return o.name.toLowerCase() === name.toLowerCase();
              })[0];
              var made;
              try {
                made = existing || Store.addOffice({ name: name });
              } catch (err) {
                return showError(root, 'office', err.message);
              }
              if (existing && existing.active === false) Store.setOfficeActive(existing.id, true);
              entry = { officeId: made.id, label: '' };
            } else {
              entry = { officeId: '', label: name };
            }
          } else if (pick.value) {
            entry = { officeId: pick.value, label: '' };
          } else {
            return showError(root, 'office', 'Who has to sign first?');
          }

          var where = root.querySelector('#f-iswhere').value;
          try {
            Store.insertStop(letterId, entry, where === 'before' ? at : at + 1);
          } catch (err) {
            return showError(root, 'office', err.message);
          }
          close();
          UI.toast((entry.label || Store.officeName(entry.officeId)) +
            ' added ' + where + ' ' + here + '.');
        });
      }
    });
  }

  /* ---------- the hand-over ----------
     The clerk who takes the letter in will never use this app, so their name is
     typed by whoever handed it over. That makes this a logbook rather than a
     signature, which is worth being plain about on the form itself. */
  function receiveForm(letterId, stopId) {
    var l = Store.letter(letterId);
    if (!l) return;
    var s = l.stops.filter(function (x) { return x.id === stopId; })[0];
    if (!s) return;

    var carrier = Store.letterInCharge(l);
    var body =
      '<p class="small">Handing <strong>' + U.esc(l.subject) + '</strong> in at ' +
      '<strong>' + U.esc(Store.stopName(s)) + '</strong>.</p>' +
      field({
        name: 'receivedBy', label: 'Who received it', required: true,
        control: '<input type="text" id="f-rby" data-autofocus maxlength="80" ' +
          'placeholder="Name of the person at the office">',
        hint: 'Typed in by you — nobody at that office signs in here.'
      }) +
      '<div class="field-row">' +
      field({
        name: 'forwardedBy', label: 'Who handed it over',
        control: '<input type="text" id="f-rfrom" maxlength="80" value="' +
          U.esc(carrier === 'Unassigned' ? '' : carrier) + '">'
      }) +
      field({
        name: 'receivedAt', label: 'Date',
        control: '<input type="date" id="f-rwhen" value="' + U.esc(U.today()) + '">'
      }) +
      '</div>';

    UI.modal({
      title: 'Record the hand-over',
      body: body,
      footer: '<button type="button" class="btn" data-close>Cancel</button>' +
        '<button type="button" class="btn btn-primary" data-save>Record it</button>',
      onMount: function (root, close) {
        function submit() {
          clearErrors(root);
          var who = root.querySelector('#f-rby').value.trim();
          if (!who) return showError(root, 'receivedBy', 'Write down who received it.');
          try {
            Store.receiveStop(letterId, stopId, {
              receivedBy: who,
              forwardedBy: root.querySelector('#f-rfrom').value.trim(),
              receivedAt: root.querySelector('#f-rwhen').value
            });
            close();
            UI.toast('Recorded — ' + Store.stopName(s) + ' has it.');
          } catch (err) { showError(root, 'receivedBy', err.message); }
        }
        root.querySelector('[data-save]').addEventListener('click', submit);
        root.querySelector('#f-rby').addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { e.preventDefault(); submit(); }
        });
      }
    });
  }

  /* What came back out of the office. "Returned for revision" is the one that
     matters most: it sends the letter backwards, not forwards. */
  function releaseForm(letterId, stopId) {
    var l = Store.letter(letterId);
    if (!l) return;
    var s = l.stops.filter(function (x) { return x.id === stopId; })[0];
    if (!s) return;

    var outcome = 'Approved';
    var body =
      '<p class="small"><strong>' + U.esc(Store.stopName(s)) + '</strong> has finished with ' +
      '<strong>' + U.esc(l.subject) + '</strong>.</p>' +
      '<div class="field"><span class="field-label">What happened <span class="req">*</span></span>' +
      '<div class="segmented" style="width:100%">' +
        Store.STOP_OUTCOMES.map(function (o, i) {
          return '<button type="button" data-outcome="' + U.esc(o) + '"' +
            (i === 0 ? ' class="is-active" aria-pressed="true"' : ' aria-pressed="false"') + '>' +
            U.esc(o === 'Returned for revision' ? 'Sent back' : o) + '</button>';
        }).join('') +
      '</div><div class="hint" id="outcome-hint">Signed and passed on.</div></div>' +
      '<div class="field-row">' +
      field({
        name: 'releasedAt', label: 'Date',
        control: '<input type="date" id="f-xwhen" value="' + U.esc(U.today()) + '">'
      }) +
      '</div>' +
      field({
        name: 'note', label: 'Note',
        control: '<textarea id="f-xnote" maxlength="300" placeholder="Anything worth remembering"></textarea>',
        hint: 'Optional — but say why if it was sent back.'
      });

    UI.modal({
      title: 'Record the outcome',
      body: body,
      footer: '<button type="button" class="btn" data-close>Cancel</button>' +
        '<button type="button" class="btn btn-primary" data-save>Record it</button>',
      onMount: function (root, close) {
        var hint = root.querySelector('#outcome-hint');
        U.els('[data-outcome]', root).forEach(function (b) {
          b.addEventListener('click', function () {
            outcome = b.getAttribute('data-outcome');
            U.els('[data-outcome]', root).forEach(function (o) {
              var on = o === b;
              o.classList.toggle('is-active', on);
              o.setAttribute('aria-pressed', String(on));
            });
            hint.textContent = outcome === 'Returned for revision'
              ? 'It comes back to you. The office is not cleared, and the letter goes in again once it is fixed.'
              : outcome === 'Noted'
                ? 'Seen and passed on without a signature.'
                : 'Signed and passed on.';
          });
        });

        root.querySelector('[data-save]').addEventListener('click', function () {
          clearErrors(root);
          var note = root.querySelector('#f-xnote').value.trim();
          if (outcome === 'Returned for revision' && !note) {
            return showError(root, 'note', 'Say what has to be fixed, or nobody will know.');
          }
          try {
            Store.releaseStop(letterId, stopId, {
              outcome: outcome,
              releasedAt: root.querySelector('#f-xwhen').value,
              note: note
            });
            close();
            var after = Store.letter(letterId);
            UI.toast(after.status === 'Approved'
              ? 'Fully approved — that is the last office.'
              : outcome === 'Returned for revision'
                ? 'Sent back. It is with ' + Store.letterInCharge(after) + ' now.'
                : 'Recorded. ' + Store.letterWhere(after) + '.');
          } catch (err) { showError(root, 'note', err.message); }
        });
      }
    });
  }

  /* ---------- the feedback form ---------- */

  function feedbackForm(eventId) {
    var e = Store.event(eventId);
    if (!e) return;

    UI.modal({
      title: 'Feedback form',
      body:
        '<p class="small">Make a Google Form for <strong>' + U.esc(e.title) + '</strong> and paste ' +
        'its link here. The form itself lives in Google &mdash; this only records where it is, ' +
        'the same way the accomplishment report does.</p>' +
        field({
          name: 'link', label: 'Link to the form', required: true,
          control: '<input type="text" id="fb-link" data-autofocus maxlength="300" value="' +
            U.esc(e.feedbackLink || '') + '" placeholder="https://forms.gle/…">',
          hint: 'Either shape works: forms.gle/… or docs.google.com/forms/…'
        }) +
        '<p class="small muted">Set the form to accept responses from anyone, or the people you ' +
        'are asking will be turned away.</p>',
      footer: '<button type="button" class="btn" data-close>Cancel</button>' +
        '<button type="button" class="btn btn-primary" data-save>Save the link</button>',
      onMount: function (root, close) {
        function submit() {
          clearErrors(root);
          var v = root.querySelector('#fb-link').value.trim();
          if (!v) return showError(root, 'link', 'Paste the link to the form.');
          try {
            Store.setFeedbackLink(eventId, v);
            close();
            UI.toast('Feedback form saved.');
          } catch (err) { showError(root, 'link', err.message); }
        }
        root.querySelector('[data-save]').addEventListener('click', submit);
        root.querySelector('#fb-link').addEventListener('keydown', function (ev) {
          if (ev.key === 'Enter') { ev.preventDefault(); submit(); }
        });
      }
    });
  }

  /* Setting the requirement aside. The standard is that every activity is
     evaluated, so a departure from it is written down rather than toggled. */
  function waiveFeedbackForm(eventId) {
    var e = Store.event(eventId);
    if (!e) return;

    UI.modal({
      title: 'No feedback form for this one?',
      body:
        '<p class="small">Every activity is evaluated &mdash; that is the standing rule, and this ' +
        'sets it aside for <strong>' + U.esc(e.title) + '</strong> only.</p>' +
        field({
          name: 'reason', label: 'Why this activity does not need one', required: true,
          control: '<textarea id="fb-why" data-autofocus maxlength="300" ' +
            'placeholder="e.g. An internal working meeting with no participants to survey."></textarea>',
          hint: 'A sentence. It is kept on the activity and read at handover.'
        }),
      footer: '<button type="button" class="btn" data-close>Cancel</button>' +
        '<button type="button" class="btn btn-primary" data-save>Set it aside</button>',
      onMount: function (root, close) {
        root.querySelector('[data-save]').addEventListener('click', function () {
          clearErrors(root);
          var why = root.querySelector('#fb-why').value.trim();
          var who = (global.Auth && Auth.current() && Auth.current().name) || '';
          try {
            Store.waiveFeedback(eventId, why, who);
            close();
            UI.toast('Recorded. No feedback form is required for this activity.');
          } catch (err) { showError(root, 'reason', err.message); }
        });
      }
    });
  }

  /* ---------- volunteers ---------- */

  /* Taking on one helper for one activity. Three questions, because the other
     two — which unit, and which event — are already settled by where you were
     standing when you pressed the button. */
  function volunteerForm(eventId) {
    var e = Store.event(eventId);
    if (!e) return;

    var body =
      field({
        name: 'name', label: 'Full name', required: true,
        control: '<input type="text" id="v-name" data-autofocus maxlength="80" placeholder="Juan D. Dela Cruz">'
      }) +
      field({
        name: 'email', label: 'Email', required: true,
        control: '<input type="text" id="v-email" maxlength="120" placeholder="juan@filamer.edu.ph">',
        hint: 'This is how they sign in. They choose their own password afterwards.'
      }) +
      field({
        name: 'position', label: 'Role in this activity',
        control: '<input type="text" id="v-position" maxlength="60" placeholder="e.g. Logistics Volunteer">',
        hint: 'A label printed on reports. It does not change what they can open.'
      }) +
      '<div class="card" style="background:var(--gold-50);border-color:var(--gold-300)">' +
      '<div class="small"><strong>' + U.esc(e.title) + '</strong> only, and only while it is running. ' +
      'When this activity is completed their access ends by itself.</div></div>';

    UI.modal({
      title: 'Add a volunteer',
      body: body,
      footer: '<button type="button" class="btn" data-close>Cancel</button>' +
        '<button type="button" class="btn btn-primary" data-save>Add volunteer</button>',
      onMount: function (root, close) {
        root.querySelector('[data-save]').addEventListener('click', function () {
          clearErrors(root);
          var name = root.querySelector('#v-name').value.trim();
          var addr = root.querySelector('#v-email').value.trim();
          var position = root.querySelector('#v-position').value.trim();

          if (!name) return showError(root, 'name', 'Enter their name.');
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) {
            return showError(root, 'email', 'That email address does not look right.');
          }
          var already = Store.personByEmail(addr);
          if (already && (already.eventIds || []).indexOf(eventId) >= 0) {
            return showError(root, 'email', already.name + ' is already on this activity.');
          }

          enrolVolunteer({ name: name, email: addr, position: position }, e)
            .then(function () {
              close();
              UI.toast(name + ' added to ' + e.title + '.');
            })
            .catch(function (err) { showError(root, 'email', err.message || 'That could not be added.'); });
        });
      }
    });
  }

  /* One helper, recorded on the device and — once Supabase is connected — with
     the backend too. Someone already in the directory is put on this activity as
     well rather than entered twice. */
  function enrolVolunteer(v, e) {
    var existing = Store.personByEmail(v.email);
    var eventIds = existing
      ? (existing.eventIds || []).concat([e.id]).filter(function (x, i, a) { return a.indexOf(x) === i; })
      : [e.id];

    /* An officer helping at an activity is still an officer. This used to send
       'volunteer' whoever it was, so an executive who promoted somebody and then
       put them on an activity sent them quietly back down — and the person found
       out by signing in to the wrong app. Being enrolled onto an activity adds an
       activity; it is not a demotion. */
    var keepsOfficer = !!(existing && existing.access !== 'volunteer');
    var access = keepsOfficer ? 'officer' : 'volunteer';

    if (existing) {
      Store.updatePerson(existing.id, {
        eventIds: eventIds, access: access, active: true,
        position: v.position || existing.position
      });
    } else {
      Store.addPerson({
        name: v.name, position: v.position, email: v.email,
        unitId: e.unitId, access: 'volunteer', eventIds: eventIds
      });
    }

    return Backend.enrol({
      email: v.email, full_name: v.name, position: v.position,
      /* An officer keeps the unit they hold office in. Filing them under the
         activity's unit would move a National officer into a college for the
         sake of one afternoon's help. */
      unit_id: keepsOfficer ? (existing.unitId || e.unitId) : e.unitId,
      access: access, eventIds: eventIds
    }).catch(function (err) {
      // Offline there is no server to record it on. The helper is still on the
      // activity so work can be assigned; the login follows once it is connected.
      if (Auth.isOffline()) return;
      throw err;
    });
  }

  /* ---------- importing a list ----------
     Hundreds of helpers is a spreadsheet, not a form filled in three hundred
     times. A file exported from Excel or Google Sheets goes straight in. */

  /* A small CSV reader: quoted fields, doubled quotes inside them, and any of
     the three line endings a spreadsheet might produce. */
  function parseCSV(text) {
    var rows = [], row = [], field = '', quoted = false, i = 0;
    text = String(text).replace(/^﻿/, '');       // Excel's byte-order mark
    while (i < text.length) {
      var c = text[i];
      if (quoted) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          quoted = false; i++; continue;
        }
        field += c; i++; continue;
      }
      if (c === '"') { quoted = true; i++; continue; }
      if (c === ',') { row.push(field); field = ''; i++; continue; }
      if (c === '\r' || c === '\n') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); rows.push(row); row = []; field = ''; i++; continue;
      }
      field += c; i++;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (c) { return c.trim() !== ''; }); });
  }

  /* Reads the header row so the columns can be in any order, and copes with a
     file that has no header at all by assuming name, email, role. */
  function readVolunteerCSV(text) {
    var rows = parseCSV(text);
    if (!rows.length) return { rows: [], error: 'That file is empty.' };

    var head = rows[0].map(function (h) { return h.trim().toLowerCase(); });
    var looksLikeHeader = head.some(function (h) {
      return h === 'name' || h === 'email' || h.indexOf('e-mail') >= 0;
    });

    var col = { name: 0, email: 1, position: 2 };
    if (looksLikeHeader) {
      head.forEach(function (h, i) {
        if (h === 'name' || h === 'full name' || h === 'full_name') col.name = i;
        else if (h === 'email' || h === 'e-mail' || h === 'email address') col.email = i;
        else if (h === 'position' || h === 'role' || h === 'committee') col.position = i;
      });
      rows = rows.slice(1);
    }

    var seen = {};
    var out = rows.map(function (r, n) {
      var name = (r[col.name] || '').trim();
      var addr = (r[col.email] || '').trim().toLowerCase();
      var position = (r[col.position] || '').trim();
      var problem = '';
      if (!name) problem = 'No name';
      else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) problem = 'Email does not look right';
      else if (seen[addr]) problem = 'Listed twice in this file';
      if (!problem) seen[addr] = true;
      return { line: n + (looksLikeHeader ? 2 : 1), name: name, email: addr, position: position, problem: problem };
    });
    return { rows: out, error: '' };
  }

  function importVolunteersForm(eventId) {
    var e = Store.event(eventId);
    if (!e) return;
    var parsed = null;

    UI.modal({
      title: 'Import volunteers',
      wide: true,
      body:
        '<p class="small">A spreadsheet with one helper per row, saved as <strong>CSV</strong>. ' +
        'In Excel or Google Sheets: <em>File → Download → Comma-separated values</em>.</p>' +
        '<div class="card" style="background:var(--gold-50);border-color:var(--gold-300)">' +
        '<div class="small strong" style="margin-bottom:4px">Columns</div>' +
        '<div class="small muted">A header row of <code>name, email, role</code>. ' +
        'The order does not matter, and anything else in the file is ignored. ' +
        'Everyone imported here joins <strong>' + U.esc(e.title) + '</strong> as a volunteer.</div></div>' +
        '<div class="row" style="margin:14px 0">' +
        '<label class="btn">' + UI.icon('upload') + 'Choose the file' +
        '<input type="file" id="v-csv" accept=".csv,text/csv,text/plain" hidden></label>' +
        '<button type="button" class="btn btn-ghost btn-sm" data-sample>Download a blank one</button>' +
        '</div>' +
        '<div id="v-preview"></div>',
      footer: '<button type="button" class="btn" data-close>Cancel</button>' +
        '<button type="button" class="btn btn-primary" data-save disabled>Import</button>',
      onMount: function (root, close) {
        var save = root.querySelector('[data-save]');
        var preview = root.querySelector('#v-preview');

        root.querySelector('[data-sample]').addEventListener('click', function () {
          UI.downloadFile('FCUSR-volunteers-template.csv',
            'name,email,role\nJuan D. Dela Cruz,juan@filamer.edu.ph,Logistics Volunteer\n',
            'text/csv');
        });

        root.querySelector('#v-csv').addEventListener('change', function (ev) {
          var f = ev.target.files && ev.target.files[0];
          if (!f) return;
          if (f.size > 2 * 1024 * 1024) {
            preview.innerHTML = '<p class="small error-text" hidden="false">That file is very large — ' +
              'split it into a few smaller ones.</p>';
            return;
          }
          var reader = new FileReader();
          reader.onload = function () {
            var res = readVolunteerCSV(String(reader.result));
            parsed = res.rows;
            var good = parsed.filter(function (r) { return !r.problem; });
            var bad = parsed.filter(function (r) { return r.problem; });

            preview.innerHTML =
              '<div class="section-head" style="margin-top:4px"><h2>' +
              U.plural(good.length, 'volunteer') + ' ready</h2>' +
              (bad.length ? '<span class="section-note">' + U.plural(bad.length, 'row') +
                ' will be skipped</span>' : '') + '</div>' +
              '<div class="list" style="max-height:260px;overflow:auto">' +
              parsed.slice(0, 200).map(function (r) {
                return '<div class="task"><span class="task-main" style="cursor:default">' +
                  '<span class="task-title">' + U.esc(r.name || '(no name)') + '</span>' +
                  '<span class="task-meta">' + U.esc(r.email || '—') +
                  (r.position ? '<span class="sep">·</span>' + U.esc(r.position) : '') +
                  '</span></span><span class="task-right">' +
                  (r.problem
                    ? '<span class="chip st-overdue"><span class="dot"></span>' + U.esc(r.problem) + '</span>'
                    : '<span class="chip st-done"><span class="dot"></span>Line ' + r.line + '</span>') +
                  '</span></div>';
              }).join('') + '</div>' +
              (parsed.length > 200 ? '<p class="tiny muted">Showing the first 200 of ' +
                parsed.length + '.</p>' : '');

            save.disabled = good.length === 0;
            save.textContent = 'Import ' + U.plural(good.length, 'volunteer');
          };
          reader.onerror = function () { UI.toast('That file could not be read.', 'error'); };
          reader.readAsText(f);
        });

        save.addEventListener('click', function () {
          var queue = (parsed || []).filter(function (r) { return !r.problem; });
          if (!queue.length) return;
          save.disabled = true;

          var done = 0, failed = [];
          // One at a time, so a rejected row names itself instead of the whole
          // import failing as one lump.
          queue.reduce(function (chain, r) {
            return chain.then(function () {
              return enrolVolunteer(r, e).then(function () { done++; }, function (err) {
                failed.push(r.email + ' — ' + (err.message || 'refused'));
              }).then(function () {
                save.textContent = 'Importing… ' + (done + failed.length) + ' of ' + queue.length;
              });
            });
          }, Promise.resolve()).then(function () {
            close();
            if (!failed.length) {
              UI.toast(U.plural(done, 'volunteer') + ' added to ' + e.title + '.');
            } else {
              UI.modal({
                title: 'Imported with ' + U.plural(failed.length, 'problem'),
                body: '<p class="small">' + U.plural(done, 'volunteer') + ' went in. These did not:</p>' +
                  '<ul class="small" style="padding-left:18px;line-height:1.7">' +
                  failed.slice(0, 30).map(function (m) { return '<li>' + U.esc(m) + '</li>'; }).join('') +
                  '</ul>',
                footer: '<button type="button" class="btn btn-primary" data-close>Close</button>'
              });
            }
          });
        });
      }
    });
  }

  /* The events a volunteer for this unit could be put on. Volunteers help with
     their own unit's activities, so the list follows the unit picker. */
  /* What to tell somebody who has just been given an account. Shared by the
     enrolment form and the person form, so the instruction cannot be right in
     one and stale in the other — which is exactly what happened when the door
     stopped having a "Set my password" button and only one of them was updated. */
  function invitedDialog(name, addr) {
    UI.modal({
      title: name + ' can now sign in',
      body: '<p class="small">Send them the link to the tracker and this line:</p>' +
        '<div class="card" style="background:var(--gold-50);border-color:var(--gold-300)">' +
        '<p class="small" style="margin:0">Open the site, type <strong>' + U.esc(addr) +
        '</strong> and a password you will remember, then press <strong>Sign in</strong>. ' +
        'It will ask you to set that password the first time.</p></div>' +
        '<p class="small muted">Nobody else ever sees that password, and the address only ' +
        'works because you have just enrolled it.</p>',
      footer: '<button type="button" class="btn btn-primary" data-close>Done</button>'
    });
  }

  /* ---------- one unit's roster ----------

     Opened from the unit itself, because that is where somebody is standing
     when they think "the College of Nursing needs its officers in". Choosing
     the college from a dropdown on a page headed "Access" was asking them to
     start again somewhere else.

     It carries the whole job: who is in this unit, adding one, adding a list
     from a spreadsheet, and naming the Governor and Vice Governor — who get
     their own council's settings and nothing beyond it. */

  function unitPeopleForm(unitId) {
    var u = Store.unit(unitId);
    if (!u) return;
    var president = !global.Auth || Auth.isPresident() || Auth.isOffline();

    function body() {
      var list = Store.people({ unitId: unitId });
      var heads = list.filter(function (p) { return p.isHead; });

      var html = '<p class="small" style="margin-top:0">' +
        U.plural(list.length, 'person', 'people') + ' in ' + U.esc(u.name) + '. ' +
        'Anybody here can be given work on this unit\u2019s activities.</p>';

      html += '<div class="row" style="margin-bottom:14px">' +
        '<button type="button" class="btn btn-primary" data-up-add>' + UI.icon('plus') +
        'Add someone</button>' +
        '<button type="button" class="btn" data-up-import>' + UI.icon('upload') +
        'Add a list</button>' + '</div>';

      /* Standing, said before the list, because it is the question somebody
         opens this to answer. */
      html += '<div class="card" style="background:var(--gold-50);border-color:var(--gold-300);margin-bottom:14px">' +
        '<div class="strong" style="margin-bottom:4px">Who runs ' + U.esc(u.name) + '</div>' +
        (heads.length
          ? '<div class="small">' + heads.map(function (p) {
              return U.esc(p.name) + (p.position ? ' \u2014 ' + U.esc(p.position) : '');
            }).join('<br>') + '</div>'
          : '<div class="small muted">Nobody named yet. The Governor and Vice Governor open ' +
            'this unit\u2019s settings \u2014 their own roster and nothing else.</div>') +
        (president ? '' :
          '<div class="tiny muted" style="margin-top:6px">Only the FCUSR President names them.</div>') +
        '</div>';

      if (!list.length) {
        html += UI.empty('Nobody yet', 'Add the Governor first, then the rest of the council.');
        return html;
      }

      html += '<div class="list">' + list.map(function (p) {
        return '<div class="task"><span class="task-main" style="cursor:default">' +
          '<span class="task-title">' + U.esc(p.name) +
            (p.isHead ? ' <span class="chip st-done">runs this unit</span>' : '') +
            (p.active === false ? ' <span class="chip st-not-started">Inactive</span>' : '') +
            (p.access === 'volunteer' ? ' <span class="chip chip-plain">volunteer</span>' : '') +
          '</span>' +
          '<span class="task-meta">' + U.esc(p.position || 'No position') +
            '<span class="sep">\u00b7</span>' +
            U.esc(p.email || 'no sign-in') + '</span></span>' +
          (president && p.access !== 'volunteer'
            ? '<span class="task-right"><button type="button" class="btn btn-sm" ' +
              'data-up-head="' + U.esc(p.id) + '">' +
              (p.isHead ? 'Stand down' : 'Make head') + '</button></span>'
            : '') +
          '</div>';
      }).join('') + '</div>';

      return html;
    }

    UI.modal({
      title: u.name,
      wide: true,
      body: body(),
      footer: '<button type="button" class="btn btn-primary" data-close>Done</button>',
      onMount: function (root, close) {
        function redraw() {
          root.querySelector('.modal-body').innerHTML = body();
          wire();
        }

        function wire() {
          var add = root.querySelector('[data-up-add]');
          if (add) add.addEventListener('click', function () {
            close();
            personForm(null, { unitId: unitId });
          });

          var imp = root.querySelector('[data-up-import]');
          if (imp) imp.addEventListener('click', function () {
            close();
            importPeopleForm(unitId);
          });

          U.els('[data-up-head]', root).forEach(function (b) {
            b.addEventListener('click', function () {
              var p = Store.person(b.getAttribute('data-up-head'));
              if (!p) return;
              var making = !p.isHead;

              UI.confirm({
                title: making ? 'Put ' + p.name + ' in charge of ' + u.name + '?' : p.name + ' stands down?',
                message: making
                  ? p.name + ' will be able to open this unit\u2019s settings \u2014 its roster, ' +
                    'and nothing belonging to any other unit or to the Republic.'
                  : p.name + ' keeps their place in ' + u.name + ' but no longer opens its settings.',
                detail: making
                  ? 'The Governor and the Vice Governor are both heads. Naming somebody does not ' +
                    'unname anybody else.'
                  : '',
                tone: 'primary',
                cancelLabel: 'Leave it',
                confirmLabel: making ? 'Put them in charge' : 'Stand them down'
              }).then(function (ok) {
                if (!ok) return;
                Store.updatePerson(p.id, { isHead: making });

                // The server decides standing; without an address there is no
                // account to decide anything about yet.
                if (p.email && global.Auth && !Auth.isOffline()) {
                  Backend.setHead(p.email, making).catch(function (err) {
                    UI.toast(err.message || 'Saved here, but the server refused.', 'error');
                  });
                }
                UI.toast(making ? p.name + ' now runs ' + u.name + '.'
                                : p.name + ' has stood down.');
                redraw();
              });
            });
          });
        }
        wire();
      }
    });
  }

  /* ---------- a whole council at once ----------

     Typing sixteen officers in one at a time is how a system gets abandoned in
     week one. A spreadsheet with a row each, saved as CSV.

     The email column is optional here, and that is the difference from the
     volunteer import: a council roster is full of people who do the work and
     never sign in. A row with an address gets an account waiting for it; a row
     without one is simply somebody tasks can be given to. */

  function readRosterCSV(text) {
    var rows = parseCSV(text);
    if (!rows.length) return { rows: [], error: 'That file is empty.' };

    var head = rows[0].map(function (h) { return h.trim().toLowerCase(); });
    var looksLikeHeader = head.some(function (h) {
      return h === 'name' || h === 'email' || h === 'position' || h.indexOf('e-mail') >= 0;
    });

    var col = { name: 0, position: 1, email: 2 };
    if (looksLikeHeader) {
      head.forEach(function (h, i) {
        if (h === 'name' || h === 'full name' || h === 'full_name') col.name = i;
        else if (h === 'email' || h === 'e-mail' || h === 'email address') col.email = i;
        else if (h === 'position' || h === 'role') col.position = i;
        else if (h === 'committee') col.committee = i;
      });
      rows = rows.slice(1);
    }

    var seen = {};
    var out = [];
    rows.forEach(function (r, n) {
      var name = (r[col.name] || '').trim();
      // A trailing blank line in a spreadsheet is not a person.
      if (!name && !(r[col.email] || '').trim()) return;

      var addr = (r[col.email] || '').trim().toLowerCase();
      var problem = '';
      if (!name) problem = 'No name';
      else if (addr && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) problem = 'That email does not look right';
      else if (addr && seen[addr]) problem = 'That email is listed twice in this file';
      else if (addr && Store.personByEmail(addr)) problem = 'Already in the directory';
      if (!problem && addr) seen[addr] = true;

      out.push({
        line: n + (looksLikeHeader ? 2 : 1),
        name: name, email: addr,
        position: (r[col.position] || '').trim(),
        committee: (col.committee !== undefined ? (r[col.committee] || '') : '').trim(),
        problem: problem
      });
    });
    return { rows: out, error: '' };
  }

  function importPeopleForm(unitId) {
    var u = Store.unit(unitId);
    if (!u) return;
    var parsed = null;

    UI.modal({
      title: 'Add a list to ' + u.name,
      wide: true,
      body:
        '<p class="small" style="margin-top:0">A spreadsheet with one person per row, saved as ' +
        '<strong>CSV</strong>. In Excel or Google Sheets: <em>File \u2192 Download \u2192 ' +
        'Comma-separated values</em>.</p>' +
        '<div class="card" style="background:var(--gold-50);border-color:var(--gold-300)">' +
        '<div class="small strong" style="margin-bottom:4px">Columns</div>' +
        '<div class="small muted">A header row of <code>name, position, email</code>. The order ' +
        'does not matter and anything else in the file is ignored.<br><br>' +
        '<strong>Email is optional.</strong> With one, that person can sign in and see their own ' +
        'tasks. Without one, they are somebody work can be assigned to \u2014 which is most of a ' +
        'council. Everybody here joins <strong>' + U.esc(u.name) + '</strong>.</div></div>' +
        '<div class="row" style="margin:14px 0">' +
        '<label class="btn">' + UI.icon('upload') + 'Choose the file' +
        '<input type="file" id="r-csv" accept=".csv,text/csv,text/plain" hidden></label>' +
        '<button type="button" class="btn btn-ghost btn-sm" data-sample>Download a blank one</button>' +
        '</div>' +
        '<div id="r-preview"></div>',
      footer: '<button type="button" class="btn" data-close>Cancel</button>' +
        '<button type="button" class="btn btn-primary" data-save disabled>Add them</button>',
      onMount: function (root, close) {
        var save = root.querySelector('[data-save]');
        var preview = root.querySelector('#r-preview');

        root.querySelector('[data-sample]').addEventListener('click', function () {
          UI.downloadFile('FCUSR-' + U.slug(u.name) + '-roster.csv',
            'name,position,email\n' +
            'Juan D. Dela Cruz,Governor,juan@filamer.edu.ph\n' +
            'Maria S. Santos,Secretary,\n',
            'text/csv');
        });

        root.querySelector('#r-csv').addEventListener('change', function (ev) {
          var f = ev.target.files && ev.target.files[0];
          if (!f) return;
          if (f.size > 2 * 1024 * 1024) {
            preview.innerHTML = '<div class="error-text">That file is very large \u2014 ' +
              'split it into a few smaller ones.</div>';
            return;
          }
          var reader = new FileReader();
          reader.onload = function () {
            var res = readRosterCSV(String(reader.result));
            parsed = res.rows;
            var good = parsed.filter(function (r) { return !r.problem; });
            var bad = parsed.filter(function (r) { return r.problem; });

            preview.innerHTML =
              (res.error ? '<div class="error-text">' + U.esc(res.error) + '</div>' : '') +
              '<p class="small strong">' + U.plural(good.length, 'person', 'people') +
              ' ready' + (bad.length ? ', ' + bad.length + ' skipped' : '') + '</p>' +
              (good.length
                ? '<div class="list">' + good.slice(0, 12).map(function (r) {
                    return '<div class="task"><span class="task-main" style="cursor:default">' +
                      '<span class="task-title">' + U.esc(r.name) + '</span>' +
                      '<span class="task-meta">' + U.esc(r.position || 'No position') +
                      '<span class="sep">\u00b7</span>' +
                      U.esc(r.email || 'no sign-in') + '</span></span></div>';
                  }).join('') +
                  (good.length > 12 ? '<div class="task"><span class="task-main" ' +
                    'style="cursor:default"><span class="task-meta">and ' +
                    (good.length - 12) + ' more</span></span></div>' : '') +
                  '</div>'
                : '') +
              (bad.length
                ? '<p class="small muted" style="margin-top:10px">Skipped: ' +
                  bad.slice(0, 6).map(function (r) {
                    return 'line ' + r.line + ' (' + U.esc(r.problem) + ')';
                  }).join(', ') + (bad.length > 6 ? ', and more' : '') + '</p>'
                : '');

            save.disabled = !good.length;
          };
          reader.readAsText(f);
        });

        save.addEventListener('click', function () {
          var good = (parsed || []).filter(function (r) { return !r.problem; });
          if (!good.length) return;
          save.disabled = true;
          save.textContent = 'Adding\u2026';

          /* Everybody first, in one write. Going through addPerson per line saved
             the whole store and redrew the whole app once per name, which is a
             fair trade for one person typed into a form and a hang for a college
             pasting its roster in. */
          var added = Store.addPeople(good.map(function (r) {
            return {
              name: r.name, position: r.position, committee: r.committee,
              email: r.email, unitId: unitId, access: 'officer'
            };
          })).length;

          var invited = 0, failed = 0;
          var chain = Promise.resolve();

          good.forEach(function (r) {
            chain = chain.then(function () {
              if (!r.email || (global.Auth && Auth.isOffline())) return;
              return Backend.enrol({
                email: r.email, full_name: r.name, position: r.position,
                unit_id: unitId, access: 'officer', eventIds: []
              }).then(function () { invited++; })
                .catch(function () { failed++; });
            });
          });

          chain.then(function () {
            close();
            UI.modal({
              title: U.plural(added, 'person', 'people') + ' added to ' + u.name,
              body: '<p class="small">' +
                (invited
                  ? U.plural(invited, 'of them') + ' gave an email address, so ' +
                    (invited === 1 ? 'that person' : 'they') + ' can sign in. Send them the link ' +
                    'and this line:</p>' +
                    '<div class="card" style="background:var(--gold-50);border-color:var(--gold-300)">' +
                    '<p class="small" style="margin:0">Open the site, type your Filamer email and a ' +
                    'password you will remember, then press <strong>Sign in</strong>. It will ask ' +
                    'you to set that password the first time.</p></div>'
                  : 'None of them gave an email address, so they cannot sign in \u2014 they are ' +
                    'people work can be assigned to. Add an address later and they can.</p>') +
                (failed ? '<p class="small error-text">' + U.plural(failed, 'account') +
                  ' could not be created on the server. They are in the list here; try enrolling ' +
                  'them again in a moment.</p>' : ''),
              footer: '<button type="button" class="btn btn-primary" data-close>Done</button>'
            });
          });
        });
      }
    });
  }

  /* ---------- who can sign in ----------

     Enrolling somebody creates a row saying the address may have an account,
     not an account. Until that person turns up and sets a password there is
     nothing to sign in with — and with sixteen officers spread across nine
     colleges, the question that decides whether a term starts on time is
     simply "who still has not". Nothing showed it, so nobody could chase it.

     Two lists, then: waiting, and in. Both come from the server, filtered by
     the same rules that decide what anyone may see, so an LGU head gets their
     own college and the nationals get the Republic. */

  function inviteLink() {
    var l = global.location;
    return l ? (l.origin + l.pathname) : '';
  }

  function groupMessage() {
    return 'FCUSR Task Tracker — your account is ready.\n\n' +
      'Open: ' + inviteLink() + '\n' +
      'Type your Filamer email and a password you will remember, then press Sign in.\n\n' +
      'The first time, it will ask you to set that password. Choose it yourself — ' +
      'nobody in the council can see it, so do not send it to anyone.';
  }

  function personalMessage(name, email) {
    return 'Hi ' + (name || 'there') + ' — your FCUSR Task Tracker account is ready.\n\n' +
      'Open: ' + inviteLink() + '\n' +
      'Email: ' + email + '\n' +
      'Then type a password you will remember and press Sign in.\n\n' +
      'It will ask you to set that password the first time. Choose it yourself — ' +
      'nobody in the council can see it.';
  }

  function rosterList() {
    var offline = !global.Auth || Auth.isOffline();

    UI.modal({
      title: 'Who can sign in',
      wide: true,
      body: '<div data-acc>' + (offline ? offlineBody() :
        '<p class="small muted" style="margin:0">Asking the server…</p>') + '</div>',
      footer: '<button type="button" class="btn" data-close>Close</button>' +
        '<button type="button" class="btn btn-primary" data-download>' +
        UI.icon('pdf') + 'Download as PDF</button>',
      onMount: function (root) {
        var host = root.querySelector('[data-acc]');
        var last = { pending: [], roster: [] };

        var dl = root.querySelector('[data-download]');
        dl.addEventListener('click', function () {
          /* On the council's letterhead rather than as a text file: this is a
             document an adviser asks for and somebody files, not a data dump. */
          if (!global.RosterPDF) {
            UI.downloadFile('FCUSR-WhoCanSignIn-' + U.today() + '.txt', asText(last), 'text/plain');
            return UI.toast('List downloaded.');
          }
          dl.disabled = true;
          RosterPDF.save(last).then(function () {
            UI.toast('Downloaded. It carries no passwords — this system holds none.');
          }).catch(function (err) {
            UI.toast(err.message || 'The list could not be made.', 'error');
          }).then(function () { dl.disabled = false; });
        });

        if (offline) return;
        load();

        function load() {
          Promise.all([Backend.pending(), Backend.roster()]).then(function (r) {
            last = { pending: r[0] || [], roster: r[1] || [] };
            /* While we have the server's version, put the directory right. It
               knows which unit each address was enrolled into, and until this
               existed the local copy could disagree without anybody noticing —
               which is how officers went missing from their own Governor's
               assignee list. */
            var fixed = Store.reconcileDirectory(last.roster.concat(last.pending));
            if (fixed) UI.toast(U.plural(fixed, 'person', 'people') + ' put in the right unit.');
            paint();
          }).catch(function (err) {
            host.innerHTML = '<div class="empty" style="border-color:var(--st-overdue-bd);' +
              'background:var(--st-overdue-bg)"><strong>The list could not be read.</strong>' +
              '<p>' + U.esc(err.message || 'The server did not answer.') + '</p></div>';
          });
        }

        function paint() {
          host.innerHTML = view(last.pending, last.roster);
          wire();
        }

        function wire() {
          var g = host.querySelector('[data-copy-group]');
          if (g) g.addEventListener('click', function () {
            UI.copyText(groupMessage())
              .then(function () { UI.toast('Message copied — paste it into the group chat.'); })
              .catch(function (e) { UI.toast(e.message, 'error'); });
          });

          U.els('[data-copy-one]', host).forEach(function (b) {
            b.addEventListener('click', function () {
              UI.copyText(personalMessage(b.getAttribute('data-name'), b.getAttribute('data-copy-one')))
                .then(function () { UI.toast('Copied — send it to ' + b.getAttribute('data-name') + '.'); })
                .catch(function (e) { UI.toast(e.message, 'error'); });
            });
          });

          /* One word, one meaning. This used to be "Withdraw", and a withdrawn
             person stayed on the list under a heading of their own with every
             button taken away — so the only way back was to enrol the address
             again, which did not work either. Now: Remove takes them off the
             list, and Add someone puts them back. */
          /* Somebody has forgotten theirs. There is no emailed link — sending
             mail needs a sender configured in Supabase, and without one that
             button only reports an error. So the executive sets a password and
             says it out loud, which is what happens in the office anyway. */
          U.els('[data-setpw]', host).forEach(function (b) {
            b.addEventListener('click', function () {
              var email = b.getAttribute('data-setpw');
              var name = b.getAttribute('data-name');
              var working = false;

              UI.modal({
                title: 'Set a password for ' + name,
                body:
                  '<p class="small">They will be signed out everywhere and will use this ' +
                  'from now on. If their account was switched off, this switches it back on. ' +
                  'Tell them what it is, and tell them to change it once they are in ' +
                  '\u2014 Settings &rarr; Change my password.</p>' +
                  '<div class="field" style="margin-top:14px"><label for="sp-a">New password</label>' +
                  '<input type="text" id="sp-a" autocomplete="off" spellcheck="false" ' +
                  'data-autofocus value="' + U.esc(suggestPassword()) + '"></div>' +
                  '<div class="hint">Shown as plain text on purpose: you have to be able to ' +
                  'read it out. At least eight characters.</div>' +
                  '<div class="error-text" data-err hidden></div>' +
                  '<p class="small muted">You cannot see the password they had. It is stored ' +
                  'scrambled and nobody can read it back \u2014 not even you \u2014 which is ' +
                  'why a new one has to be set rather than looked up.</p>',
                footer: '<button type="button" class="btn" data-close>Close</button>' +
                  '<button type="button" class="btn btn-primary" data-go>Set it</button>',
                onMount: function (root2, close) {
                  var input = root2.querySelector('#sp-a');
                  var err = root2.querySelector('[data-err]');
                  var go = root2.querySelector('[data-go]');
                  go.addEventListener('click', function () {
                    if (working) return;
                    var pw = input.value || '';
                    if (pw.length < 8) {
                      err.hidden = false;
                      err.textContent = 'Too short \u2014 use at least eight characters.';
                      return;
                    }
                    working = true;
                    go.disabled = true;
                    go.textContent = 'One moment\u2026';
                    Auth.setMemberPassword(email, pw).then(function () {
                      close();
                      UI.modal({
                        title: 'Done',
                        body: '<p class="small">' + U.esc(name) + ' can sign in with:</p>' +
                          '<p class="strong" style="font-size:20px;letter-spacing:.5px;' +
                          'margin:10px 0;word-break:break-all">' + U.esc(pw) + '</p>' +
                          '<p class="small muted">This is the only time it is shown. Give it to ' +
                          'them now, and ask them to change it once they are in.</p>',
                        footer: '<button type="button" class="btn btn-primary" data-close>Right</button>'
                      });
                    }).catch(function (e) {
                      working = false;
                      go.disabled = false;
                      go.textContent = 'Set it';
                      if (e && e.setupMissing) { close(); return setupNeeded(); }
                      err.hidden = false;
                      err.textContent = (e && e.message) || 'That could not be set.';
                    });
                  });
                }
              });
            });
          });

          U.els('[data-remove]', host).forEach(function (b) {
            b.addEventListener('click', function () {
              var email = b.getAttribute('data-remove');
              var name = b.getAttribute('data-name');
              var waiting = b.getAttribute('data-waiting') === '1';
              UI.confirm({
                title: 'Remove ' + name + '?',
                message: waiting
                  ? 'The enrolment for ' + email + ' is removed, so nobody can claim it. ' +
                    'Use this when an address was wrong or the person is no longer coming in.'
                  : 'Their account and sign-in for ' + email + ' are deleted. Their tasks, ' +
                    'letters and everything they filed stay exactly where they are, and ' +
                    'their name still reads correctly on all of it.',
                detail: waiting
                  ? 'You can enrol the address again at any time.'
                  : 'This cannot be undone. Adding them again gives them a new account on the ' +
                    'same address \u2014 they choose a password as if it were their first day.',
                confirmLabel: 'Remove'
              }).then(function (ok) {
                if (!ok) return;
                b.disabled = true;
                Backend.remove(email).then(function () {
                  UI.toast(name + ' removed. Add them again any time.');
                  load();
                }).catch(function (err) {
                  b.disabled = false;
                  if (err && err.setupMissing) return setupNeeded();
                  UI.toast(err.message || 'That could not be done.', 'error');
                });
              });
            });
          });
        }
      }
    });
  }

  function offlineBody() {
    var people = Store.people();
    return '<div class="card" style="background:var(--gold-50);border-color:var(--gold-300)">' +
      '<div class="strong" style="margin-bottom:3px">No accounts yet</div>' +
      '<div class="small">The Supabase project has not been connected, so nobody signs in and ' +
      'everything stays on this device. The people below are names on tasks, not logins.</div></div>' +
      (people.length
        ? '<div class="list" style="margin-top:14px">' + people.map(function (p) {
            return '<div class="task"><span class="task-main" style="cursor:default">' +
              '<span class="task-title">' + U.esc(p.name) + '</span>' +
              '<span class="task-meta">' + U.esc(p.position || 'No position') + '</span>' +
              '</span></div>';
          }).join('') + '</div>'
        : '<p class="small muted">Nobody has been added yet.</p>');
  }

  /* One person, one row.

     These were two lists laid side by side — waiting enrolments from one table,
     accounts from another — and somebody can be in both. An officer withdrawn
     under the old rules kept their account while losing their enrolment; enrol
     them again and they appear under "Waiting to sign in", which is where the
     Set password button is deliberately not offered, because somebody waiting
     has no account to set one on. Except she did have one. She had signed in
     for months.

     So it is not "waiting or not" that decides anything here. It is whether an
     account exists, which is the only thing that says whether a password can be
     set — and merging the two lists on the address is what makes that
     answerable at all. */
  function merge(pending, roster) {
    var byEmail = {};
    var key = function (e) { return String(e || '').trim().toLowerCase(); };

    (roster || []).forEach(function (p) {
      if (!key(p.email)) return;
      byEmail[key(p.email)] = {
        email: p.email, full_name: p.full_name, position: p.position,
        units: p.units, access: p.access,
        hasAccount: true, active: p.active !== false, waiting: false
      };
    });

    (pending || []).forEach(function (e) {
      var k = key(e.email);
      if (!k) return;
      if (byEmail[k]) {
        /* Enrolled again over an account that already exists. They do not need
           an invitation; they need their password set, or removing properly. */
        byEmail[k].reEnrolled = true;
        if (e.full_name) byEmail[k].full_name = e.full_name;
        if (e.position) byEmail[k].position = e.position;
        return;
      }
      byEmail[k] = {
        email: e.email, full_name: e.full_name, position: e.position,
        units: e.units, access: e.access,
        hasAccount: false, active: true, waiting: true
      };
    });

    return Object.keys(byEmail).map(function (k) { return byEmail[k]; })
      .sort(function (x, y) {
        return String(x.full_name || x.email).localeCompare(String(y.full_name || y.email));
      });
  }

  function view(pending, roster) {
    var all = merge(pending, roster);
    var waiting = all.filter(function (p) { return p.waiting; });
    var accounts = all.filter(function (p) { return p.hasAccount; });
    var canSignIn = accounts.filter(function (p) { return p.active; });
    var mine = (global.Auth && Auth.current()) ? Auth.current().email : '';

    /* Not styled as an alarm. On the first day of a term everybody is waiting,
       and a screen that is red the moment it is doing its job teaches people to
       stop reading it. The count on the section below carries the urgency. */
    var html = '<div class="where-now" style="margin-bottom:16px">' +
      '<span class="wn-label">Where things stand</span>' +
      '<span class="wn-line">' + U.plural(canSignIn.length, 'person', 'people') + ' can sign in' +
      (waiting.length ? ' \u00b7 ' + waiting.length + ' still to set a password' : '') + '</span>' +
      (waiting.length
        ? '<span class="wn-note">Nobody can be chased into a system they have not opened. ' +
          'Send them the link.</span>'
        : '') +
      '</div>';

    if (waiting.length) {
      html += '<div class="section" style="margin-bottom:18px">' +
        '<div class="section-head"><h2>Waiting to sign in ' +
        '<span class="chip st-overdue"><span class="dot"></span>' + waiting.length + '</span></h2></div>' +
        '<p class="small muted" style="margin:0 2px 10px">Enrolled, but they have not opened the site ' +
        'and set a password yet. Until they do there is no account &mdash; only your enrolment.</p>' +
        '<button type="button" class="btn btn-sm" style="margin-bottom:10px" data-copy-group>' +
        'Copy the message for the group chat</button>' +
        '<div class="list">' + waiting.map(function (e) { return row(e, mine); }).join('') +
        '</div></div>';
    }

    html += '<div class="section">' +
      '<div class="section-head"><h2>Has an account' +
      (accounts.length ? ' <span class="chip chip-plain">' + accounts.length + '</span>' : '') +
      '</h2></div>';
    html += accounts.length
      ? '<div class="list">' + accounts.map(function (p) { return row(p, mine); }).join('') + '</div>'
      : '<p class="small muted" style="margin:0 2px">Nobody has set a password yet.</p>';
    html += '</div>';

    return html;
  }

  /* The site is ahead of its database. Not a mistake anybody made at this
     screen, and not something a toast should carry away after four seconds —
     nothing on this page will work until somebody runs the file. */
  function setupNeeded() {
    UI.modal({
      title: 'One setup step is missing',
      body:
        '<p class="small">The site has been updated but the database has not, so removing ' +
        'somebody and setting a password cannot work yet. Nothing is broken and nothing has ' +
        'been lost.</p>' +
        '<div class="card" style="background:var(--gold-50);border-color:var(--gold-300);margin-top:14px">' +
        '<div class="strong" style="margin-bottom:4px">What to do</div>' +
        '<ol class="small" style="padding-left:18px;line-height:1.8;margin:0">' +
        '<li>Open <strong>backend/supabase/remove.sql</strong> in the project.</li>' +
        '<li>Copy all of it.</li>' +
        '<li>Supabase &rarr; <strong>SQL Editor</strong> &rarr; New query &rarr; paste &rarr; ' +
        '<strong>Run</strong>.</li>' +
        '</ol></div>' +
        '<p class="small muted">It only has to be done once, and it is safe to run twice.</p>',
      footer: '<button type="button" class="btn btn-primary" data-close>Right</button>'
    });
  }

  /* Something an officer can read down a phone line without spelling it. No
     l/1/O/0, and a number on the end because eight characters is the floor. */
  function suggestPassword() {
    var words = ['filamer', 'republic', 'roxas', 'capiz', 'gazette', 'session',
                 'quorum', 'charter', 'plenary', 'banner'];
    var pick = function (a) { return a[Math.floor(Math.random() * a.length)]; };
    return pick(words) + '-' + pick(words) + '-' + (100 + Math.floor(Math.random() * 900));
  }

  function row(p, mine) {
    var email = p.email || '';
    var name = p.full_name || email || 'Somebody';
    var isMe = mine && email && mine.toLowerCase() === email.toLowerCase();
    var waiting = !!p.waiting;

    var meta = [p.position || 'No position'];
    if (p.units && p.units.name) meta.push(p.units.name);

    /* Two states worth saying out loud, because both used to be invisible and
       both are the reason somebody is standing in the office unable to get in. */
    var note = '';
    if (p.hasAccount && !p.active) {
      note = ' <span class="chip st-overdue"><span class="dot"></span>cannot sign in</span>';
    } else if (p.reEnrolled) {
      note = ' <span class="chip chip-plain">enrolled again</span>';
    }

    return '<div class="task"><span class="task-main" style="cursor:default">' +
      '<span class="task-title">' + U.esc(name) +
        (isMe ? ' <span class="chip chip-plain">you</span>' : '') + note + '</span>' +
      '<span class="task-meta">' + meta.map(U.esc).join('<span class="sep">\u00b7</span>') + '</span>' +
      '<span class="task-meta">' + U.esc(email) + '</span>' +
      '</span>' +
      (isMe ? '' :
        '<span class="task-right" style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">' +
        (waiting
          ? '<button type="button" class="btn btn-sm" data-copy-one="' + U.esc(email) +
            '" data-name="' + U.esc(name) + '">Copy invite</button>'
          : '') +
        /* Offered on the one thing that decides it: whether an account exists.
           It used to hang off "is this person in the waiting list", which put it
           out of reach of exactly the people who needed it. */
        (p.hasAccount
          ? '<button type="button" class="btn btn-sm" data-setpw="' + U.esc(email) +
            '" data-name="' + U.esc(name) + '">Set password</button>'
          : '') +
        '<button type="button" class="btn btn-sm btn-ghost" data-remove="' + U.esc(email) +
        '" data-name="' + U.esc(name) + '" data-waiting="' + (waiting ? '1' : '0') +
        '">Remove</button></span>') +
      '</div>';
  }

  /* The same grouping the screen uses. It used to do its own — waiting from one
     table, accounts from another — so somebody in both appeared twice, and
     anybody switched off appeared in neither. A list that disagrees with the
     screen it was printed from is worse than no list. */
  function asText(last) {
    var all = merge(last.pending, last.roster);
    var waiting = all.filter(function (p) { return p.waiting; });
    var accounts = all.filter(function (p) { return p.hasAccount; });
    var line = function (p) {
      return '  ' + (p.full_name || '—') + '  —  ' + (p.position || 'No position') +
        '  —  ' + (p.email || '') +
        (p.hasAccount && !p.active ? '  —  CANNOT SIGN IN' : '');
    };

    var lines = ['FCUSR Task Tracker — who can sign in', U.fmtDate(U.today()), ''];
    if (waiting.length) {
      lines.push('WAITING TO SIGN IN (' + waiting.length + ')');
      waiting.forEach(function (e) { lines.push(line(e)); });
      lines.push('');
    }
    lines.push('HAS AN ACCOUNT (' + accounts.length + ')');
    if (!accounts.length) lines.push('  nobody yet');
    accounts.forEach(function (p) { lines.push(line(p)); });
    return lines.join('\n') + '\n';
  }

  /* ---------- person ---------- */

  function personForm(personId, opts) {
    opts = opts || {};
    var p = personId ? Store.person(personId) : null;
    var isNew = !p;
    // Opened from a unit, that unit is the answer — not wherever the person
    // doing it happens to belong.
    var myUnit = opts.unitId ||
      ((global.Auth && Auth.signedIn()) ? Auth.myUnitId() : Store.nationalUnitId());
    var d = p || { name: '', position: '', committee: '', active: true, unitId: myUnit };
    // Only the President moves people between units; a Governor's people are theirs.
    var canPickUnit = !global.Auth || Auth.isPresident() || Auth.isOffline();

    var body =
      field({
        name: 'name', label: 'Full name', required: true,
        control: '<input type="text" id="f-name" data-autofocus maxlength="80" value="' + U.esc(d.name) + '">'
      }) +
      /* Which unit somebody belongs to decides where they can be given work, so
         it cannot be left to a default. It was, and every person added this way
         landed in FCUSR Nationals whoever added them. */
      (canPickUnit
        ? field({
            name: 'unitId', label: 'Unit', required: true,
            control: '<select id="f-unit">' + Store.units({ activeOnly: true }).map(function (u) {
              return '<option value="' + U.esc(u.id) + '"' +
                (u.id === (d.unitId || myUnit) ? ' selected' : '') + '>' + U.esc(u.name) + '</option>';
            }).join('') + '</select>',
            hint: 'They can be given work on this unit\u2019s activities.'
          })
        : '<input type="hidden" id="f-unit" value="' + U.esc(d.unitId || myUnit) + '">') +
      '<div class="field-row">' +
      field({
        name: 'position', label: 'Position',
        control: UI.suggestInput('f-position', d.position, Store.positions(), 'Start typing, or pick one'),
        hint: 'The posts in the FCUSR Constitution are offered as you type. Anything else is fine too — ' +
          'a position is a label printed on reports, and it grants nobody anything.'
      }) +
      field({
        name: 'committee', label: 'Committee',
        control: UI.suggestInput('f-committee', d.committee, Store.committees(), 'Optional')
      }) +
      '</div>' +
      /* One form, because "add a person" and "enrol someone" were two doors to
         the same room. Somebody in the directory can be given work; somebody
         with an email can also sign in. That is one difference, and it belongs
         on one field rather than in a choice made before the form opens. */
      field({
        name: 'email', label: 'Email',
        control: '<input type="email" id="f-email" maxlength="120" autocapitalize="off" ' +
          'spellcheck="false" value="' + U.esc(d.email || '') + '" placeholder="juan@filamer.edu.ph">',
        hint: d.email
          ? 'They can sign in with this address.'
          : 'Optional. With an address they can sign in and see their own tasks; without one ' +
            'they are simply somebody work can be assigned to.'
      }) +

      /* What this person IS, asked plainly.

         It was never asked. It was implied by whichever form you happened to
         open: this one always enrolled an officer, the helper form always
         enrolled a volunteer, and the roster import always enrolled an officer.
         So moving somebody between the two was not something the app could do —
         an executive promoting a volunteer changed the account and left the
         directory saying volunteer, or put them on an activity afterwards and
         silently sent them back down again. */
      field({
        name: 'access', label: 'What they are',
        control: '<select id="f-access">' +
          '<option value="officer"' + (d.access !== 'volunteer' ? ' selected' : '') + '>' +
          'Officer &mdash; their unit\u2019s work</option>' +
          '<option value="volunteer"' + (d.access === 'volunteer' ? ' selected' : '') + '>' +
          'Volunteer &mdash; only the activities they are put on</option>' +
          '</select>',
        hint: 'An officer of the National government reaches the whole Republic. A volunteer ' +
          'sees only the activities somebody enrols them into.'
      }) +
      (isNew ? '' :
        '<div class="field"><label class="checkbox"><input type="checkbox" id="f-active"' + (d.active !== false ? ' checked' : '') + '>' +
        '<span>Active officer<span class="hint">Deactivated officers keep their past tasks but no longer appear in assignee lists.</span></span></label></div>');

    UI.modal({
      title: isNew ? 'Add person' : 'Edit person',
      body: body,
      footer: '<button type="button" class="btn" data-close>Cancel</button>' +
        '<button type="button" class="btn btn-primary" data-save>' + (isNew ? 'Add person' : 'Save changes') + '</button>',
      onMount: function (root, close) {
        function submit() {
          clearErrors(root);
          var data = {
            name: root.querySelector('#f-name').value.trim(),
            position: root.querySelector('#f-position').value,
            committee: root.querySelector('#f-committee').value
          };
          var uSel = root.querySelector('#f-unit');
          if (uSel) data.unitId = uSel.value;
          var addr = (root.querySelector('#f-email').value || '').trim();
          if (addr && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) {
            return showError(root, 'email', 'That email address does not look right.');
          }
          data.email = addr;
          if (!data.name) return showError(root, 'name', 'Enter the officer’s name.');

          var accSel = root.querySelector('#f-access');
          data.access = accSel && accSel.value === 'volunteer' ? 'volunteer' : 'officer';

          if (isNew) Store.addPerson(data);
          else {
            data.active = root.querySelector('#f-active').checked;
            Store.updatePerson(personId, data);
          }

          /* An address means an account. Enrolling records the decision; the
             person sets their own password the first time they open the site,
             which is why the app never handles anybody else's. */
          if (!addr || (global.Auth && Auth.isOffline())) {
            close();
            return UI.toast(isNew ? 'Person added.' : 'Person saved.');
          }

          Backend.enrol({
            email: addr, full_name: data.name, position: data.position,
            unit_id: data.unitId || Store.nationalUnitId(),
            // What the form was told, not what this form used to assume.
            access: data.access,
            eventIds: data.access === 'volunteer' ? (d.eventIds || []) : []
          }).then(function () {
            close();
            invitedDialog(data.name, addr);
          }).catch(function (err) {
            close();
            UI.toast(err.message || 'Saved here, but the account could not be created.', 'error');
          });
          return;
        }
        root.querySelector('[data-save]').addEventListener('click', submit);
        root.querySelector('#f-name').addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { e.preventDefault(); submit(); }
        });
      }
    });
  }

  global.Forms = {
    mergeRoster: merge, asText: asText,
    unitForm: unitForm,
    feedbackForm: feedbackForm, waiveFeedbackForm: waiveFeedbackForm,
    officeForm: officeForm, letterForm: letterForm,
    receiveForm: receiveForm, releaseForm: releaseForm, insertStopForm: insertStopForm,
    askIfInternal: askIfInternal,
    volunteerForm: volunteerForm, importVolunteersForm: importVolunteersForm,
    readVolunteerCSV: readVolunteerCSV, parseCSV: parseCSV,
    eventForm: eventForm, taskForm: taskForm, personForm: personForm,
    rosterList: rosterList, unitPeopleForm: unitPeopleForm,
    importPeopleForm: importPeopleForm,
    groupMessage: groupMessage, personalMessage: personalMessage,
    field: field, showError: showError, clearErrors: clearErrors
  };
})(window);
