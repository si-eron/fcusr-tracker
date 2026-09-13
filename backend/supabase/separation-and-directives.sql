-- FCUSR Task Tracker — separation AND directives, in one run
--
-- Run this in Supabase → SQL Editor. Safe to run twice.
--
-- This replaces backend/supabase/separation.sql and backend/supabase/directives.sql.
-- Run this one instead of either; running it after them changes nothing.
--
-- ---------------------------------------------------------------------------
-- WHY BOTH AT ONCE
--
-- separation.sql was written but never run. It was checked for by asking the
-- database whether its functions existed — and the check could not tell
-- "missing" from "not yours to call", so it came back inconclusive and was
-- recorded as done on the strength of a conversation instead. It was not done.
--
-- That is why a college officer assigning a task can still see every National
-- officer: `people` is still readable by anybody signed in, which is the first
-- thing separation.sql was written to stop.
--
-- And directives.sql cannot be run on its own, because its policies call
-- in_event() — which separation.sql was supposed to have created.
--
-- Checked before writing this, rather than assumed:
--   sees_unit, event_unit, my_access, my_email, my_unit, is_national  present
--   in_event, is_head_of                                             missing
--   task_unit                                                        missing
--
-- ---------------------------------------------------------------------------
-- WHAT IT FIXES
--
--   1. A college officer, and a volunteer, can read the whole Republic's
--      directory — every name and email in it. That is the "LGU can see the
--      National officers" you are looking at.
--   2. A volunteer can read every activity, task and report of their college,
--      not only the ones they were enrolled in.
--   3. A volunteer can read their college's letters.
--   4. A volunteer can read the enrolment list and their college's profiles,
--      both of which carry email addresses.
--   5. Anybody signed in can read the whole event_members table.
--   6. A directive cannot be stored at all, because tasks.event_id is NOT NULL
--      and a directive has no activity. No directive has ever synced.
--   7. A Governor cannot save their own council's letter template.
--
-- ---------------------------------------------------------------------------
-- THE RULE THAT KEEPS THIS FROM LOCKING EVERYONE OUT
--
-- A policy that reads another table makes that table's policies run, and if
-- those read back, Postgres stops with "infinite recursion detected" and nobody
-- can sign in. That has happened on this database once already.
--
-- So every policy below asks its questions ONLY through the small functions at
-- the top, each `security definer` and therefore answering without triggering
-- any policy. No policy names a table directly.

-- ========================================================== 1. the helpers

-- Is the caller attached to this activity? Reads event_members as the owner, so
-- event_members' own policy never runs and cannot loop back.
create or replace function in_event(ev uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from event_members
    where event_id = ev and profile_id = auth.uid()
  );
$$;

-- Is the caller the head — Governor or Vice Governor — of this unit?
create or replace function is_head_of(u uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from profiles
    where id = auth.uid() and active and is_head
      and access = 'officer' and unit_id = u
  );
$$;

-- ================================================ 2. a task without an activity
-- A directive is council business belonging to no activity — a standing
-- instruction with a tab of its own. event_id was NOT NULL, so every directive
-- ever written was refused by the database and the tab has been a private
-- notebook on each device.
--
-- Dropping NOT NULL leaves the question every policy asks — which unit is this —
-- with nothing to read, since a task's unit was always reached through its
-- event. So a task gets a unit of its own, used only when there is no event.
-- Every task written so far has an event and keeps answering through it.

alter table tasks alter column event_id drop not null;
alter table tasks add column if not exists unit_id uuid references units(id) on delete cascade;
create index if not exists tasks_unit_idx on tasks(unit_id);

create or replace function task_unit(ev uuid, own uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select coalesce((select unit_id from events where id = ev), own);
$$;

-- ========================================================== 3. the directory
-- Names, positions and email addresses of everybody the council tracks. An
-- officer needs their own unit's; the National government needs everyone's; a
-- volunteer needs neither. This is the one you are looking at.

drop policy if exists people_read on people;
create policy people_read on people for select using (
  is_national()
  or (my_access() = 'officer' and unit_id = my_unit())
);

-- ============================================ 4. activities and their work
-- An officer sees their unit's, and the National government sees every unit's
-- except the sealed ones. A volunteer sees the activities they were enrolled
-- in, and nothing else — which is what the app has always claimed.

drop policy if exists events_read on events;
create policy events_read on events for select using (
  (my_access() = 'officer' and sees_unit(unit_id))
  or in_event(id)
);

drop policy if exists reports_read on reports;
create policy reports_read on reports for select using (
  (my_access() = 'officer' and sees_unit(event_unit(event_id)))
  or in_event(event_id)
);

-- Tasks ask through their activity where they have one, and through their own
-- unit where they do not. That is what lets a directive exist.

drop policy if exists tasks_read on tasks;
create policy tasks_read on tasks for select using (
  (my_access() = 'officer' and sees_unit(task_unit(event_id, unit_id)))
  or in_event(event_id)
);

-- A volunteer may still tick off a task given to them, directive or not.
drop policy if exists tasks_update on tasks;
create policy tasks_update on tasks for update using (
  (my_email() is not null and exists (
    select 1 from people pe where pe.id = tasks.assignee_id
      and lower(pe.body->>'email') = my_email()))
  or (my_access() = 'officer' and sees_unit(task_unit(event_id, unit_id)))
);

drop policy if exists tasks_insert on tasks;
create policy tasks_insert on tasks for insert
  with check (my_access() = 'officer' and sees_unit(task_unit(event_id, unit_id)));

drop policy if exists tasks_delete on tasks;
create policy tasks_delete on tasks for delete
  using (my_access() = 'officer' and sees_unit(task_unit(event_id, unit_id)));

-- ============================================================== 5. letters
-- A letter's trail names people and offices and says what was refused and why.
-- It is officers' business; a volunteer helping at an activity is not part of
-- the correspondence.

drop policy if exists letters_read on letters;
create policy letters_read on letters for select using (
  my_access() = 'officer' and sees_unit(unit_id)
);

-- ============================================================ 6. addresses
-- Both carry email addresses. Reading your own row stays, because everybody
-- must be able to see who they are signed in as.

drop policy if exists profiles_read on profiles;
create policy profiles_read on profiles for select using (
  id = auth.uid()
  or is_national()
  or (my_access() = 'officer' and unit_id = my_unit())
);

drop policy if exists enrolments_read on enrolments;
create policy enrolments_read on enrolments for select using (
  is_national()
  or (my_access() = 'officer' and unit_id = my_unit())
);

-- ================================================ 7. who is attached to what
-- A volunteer needs their own rows, to know which activities they were taken on
-- for. They do not need anybody else's.

drop policy if exists members_read on event_members;
create policy members_read on event_members for select using (
  profile_id = auth.uid()
  or (my_access() = 'officer' and sees_unit(event_unit(event_id)))
);

-- ======================================== 8. a Governor's own council
-- The fault in the other direction: a unit's letter template is stored on the
-- unit, and units could only be written by the National government, so a
-- Governor's settings saved on their phone and reached nobody.
--
-- UPDATE only. `for all` would cover DELETE as well, and a Governor who may
-- edit their council's template must not be able to remove the council.

drop policy if exists units_write on units;
drop policy if exists units_update on units;
create policy units_update on units for update
  using (is_national() or is_head_of(id))
  with check (is_national() or is_head_of(id));

-- A unit row carries `kind`, and `kind` is what is_national() reads. A Governor
-- who could set their own college's kind to 'national' would make every member
-- of it a national officer.
create or replace function guard_unit_grants() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if is_national() then return new; end if;
  if new.id   is distinct from old.id
  or new.kind is distinct from old.kind
  or new.code is distinct from old.code then
    raise exception
      'A unit''s kind and code are set by the National government. You may change your own council''s template.';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_unit_grants on units;
create trigger guard_unit_grants
  before update on units
  for each row execute function guard_unit_grants();

-- The app saves by upsert, and Postgres checks the INSERT rule even when the
-- row already exists and the write becomes an update — so without is_head_of
-- here a Governor's save would be refused by the very policy meant to allow it.
-- is_head_of(id) is only ever true for a unit that head already belongs to, so
-- no new college can be created through it.
drop policy if exists units_insert on units;
create policy units_insert on units for insert
  with check (is_national() or is_head_of(id));

drop policy if exists units_delete on units;
create policy units_delete on units for delete using (is_national());

-- ---------------------------------------------------------------------------
-- DELIBERATELY LEFT OPEN
--
-- `deletions` stays readable by anybody signed in. It holds no content — an id,
-- a kind and a time — and every device must learn about every deletion or a
-- record removed on one phone comes back from another. Narrowing it risks data
-- coming back from the dead, which is worse than telling a volunteer that
-- something they could never read has been deleted.
--
-- `units` and `council` stay readable by anybody signed in: the college list and
-- the letterhead are what the app is drawn from.

-- ---------------------------------------------------------------------------
-- DID IT TAKE?

select 'in_event'   as needed, (to_regprocedure('public.in_event(uuid)')        is not null) as installed
union all select 'is_head_of',  to_regprocedure('public.is_head_of(uuid)')      is not null
union all select 'task_unit',   to_regprocedure('public.task_unit(uuid,uuid)')  is not null
union all select 'tasks.event_id may be empty',
  (select is_nullable = 'YES' from information_schema.columns
    where table_name = 'tasks' and column_name = 'event_id')
union all select 'tasks has a unit of its own',
  exists (select 1 from information_schema.columns
    where table_name = 'tasks' and column_name = 'unit_id')
order by 1;
