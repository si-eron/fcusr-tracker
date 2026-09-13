-- FCUSR Task Tracker — directives, which have never synced
--
-- Run this in Supabase → SQL Editor. Safe to run twice.
--
-- ---------------------------------------------------------------------------
-- WHAT WAS WRONG
--
-- A directive is council business that belongs to no activity — a standing
-- instruction, with its own tab in the app. It is stored as a task with no
-- event, and `tasks.event_id` is NOT NULL here.
--
-- So every directive ever written was refused by the database. Before refused
-- rows were survivable that broke the whole sync round; after, it was skipped
-- in silence. Either way no directive has ever reached a second phone, and the
-- Directives tab has quietly been a private notebook on each device.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS CHANGES
--
-- event_id becomes optional, because a directive genuinely has no event and
-- saying otherwise was the lie underneath all of it.
--
-- That leaves the question every policy here asks — which unit does this belong
-- to — with no answer, since a task's unit was always read through its event.
-- So a task gets a unit of its own, used only when there is no event to ask.
--
-- Nothing existing moves: every task written so far has an event, and keeps
-- answering through it exactly as before.

alter table tasks alter column event_id drop not null;

alter table tasks add column if not exists unit_id uuid references units(id) on delete cascade;

create index if not exists tasks_unit_idx on tasks(unit_id);

-- Which unit a task belongs to: its activity's, or its own when it has none.
create or replace function task_unit(ev uuid, own uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select coalesce((select unit_id from events where id = ev), own);
$$;

-- ------------------------------------------------------------- the policies
-- Identical to the ones separation.sql installed, with event_unit(event_id)
-- replaced by task_unit(event_id, unit_id). A task with an activity behind it
-- is scoped by the activity, exactly as before; a directive is scoped by the
-- unit it was written for.

drop policy if exists tasks_read on tasks;
create policy tasks_read on tasks for select using (
  (my_access() = 'officer' and sees_unit(task_unit(event_id, unit_id)))
  or in_event(event_id)
);

/* A volunteer may still tick off a task given to them, directive or not. */
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

-- --------------------------------------------------- directives already written
-- Every directive sitting on somebody's phone is about to arrive for the first
-- time, carrying the unit of whoever wrote it. Nothing to do here for those.
--
-- But a task already on the server with no unit_id and no event cannot exist —
-- event_id was NOT NULL until a moment ago — so there is nothing to backfill.
-- This is only here to say that was checked rather than assumed.

select count(*) as tasks_with_neither_event_nor_unit
from tasks where event_id is null and unit_id is null;
