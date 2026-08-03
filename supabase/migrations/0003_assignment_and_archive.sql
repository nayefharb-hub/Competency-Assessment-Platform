-- 0003_assignment_and_archive.sql
--
-- Adds three things at once, deliberately. Migrations here are pasted into the
-- Supabase SQL Editor by hand and nothing records what has been applied, so two
-- migrations is two chances to run one and forget the other.
--
--   1. must_change_password  — the admin sets a password, the user must replace
--                              it on first sign-in (PR A1)
--   2. assigned_at/_by       — an assessment is ASSIGNED by an admin, not
--                              created by someone visiting /assess (PR A2)
--   3. deleted_at/_by/_reason — archive instead of destroy, so the completion
--                              metric stays reconstructible (PR B)
--
-- Safe to run twice: every statement is guarded. Safe to run BEFORE the code
-- ships: old code ignores columns it does not select.
--
-- RUN THIS BEFORE MERGING PR A1. Vercel deploys on merge, and code selecting a
-- column that does not exist fails at request time, not build time — so the
-- deployment would go green and then 500.

begin;

-- 1 ------------------------------------------------------------------ password
alter table public.app_user
  add column if not exists must_change_password boolean not null default false;

comment on column public.app_user.must_change_password is
  'Set when an admin creates the account or resets the password. Cleared when the
   user sets their own. Enforced server-side in lib/auth.ts requireUser() — it
   cannot live in proxy.ts, which runs on the edge with only the anon key and
   cannot read this table.';

-- Every account that exists today was created with a password somebody else
-- chose, so every one of them must change it. Includes the owner's: that is
-- deliberate, and it also rotates a password that was exposed in a session
-- transcript.
update public.app_user
   set must_change_password = true
 where must_change_password = false;

-- 2 ---------------------------------------------------------------- assignment
alter table public.assessment
  add column if not exists assigned_at timestamptz,
  add column if not exists assigned_by uuid references public.app_user(id);

comment on column public.assessment.assigned_at is
  'When an admin assigned this cycle to this person. NULL means the row predates
   assignment (auto-created on first visit to /assess). The count of assigned
   rows is the completion metric denominator — before this existed it had to be
   guessed from how many people held logins.';

create index if not exists assessment_assigned_idx
  on public.assessment(cycle, assigned_at);

-- Bin the auto-created rows. At migration time this is exactly the backlog of
-- assessments nobody asked for — today, one draft belonging to the owner, who
-- asked for it to be binned rather than backfilled.
--
-- Guarded to state='draft' on purpose: a submitted or approved record must
-- never be reachable by this statement, whatever the row count turns out to be
-- when it actually runs.
delete from public.assessment
 where assigned_at is null
   and state = 'draft';

-- 3 ------------------------------------------------------------------- archive
alter table public.assessment
  add column if not exists deleted_at     timestamptz,
  add column if not exists deleted_by     uuid references public.app_user(id),
  add column if not exists deleted_reason text;

comment on column public.assessment.deleted_at is
  'Archive, not delete. A hard delete removes started_at/completed_at, which
   silently moves the median time-to-complete — the number the pilot exists to
   produce. Archived rows drop out of every list and rollup but keep their
   timing, so the metric stays reconstructible. Read paths must filter
   deleted_at is null.';

create index if not exists assessment_live_idx
  on public.assessment(cycle) where deleted_at is null;

-- verify ---------------------------------------------------------------------
do $$
declare
  n_flagged int;
  n_orphan  int;
begin
  select count(*) into n_flagged from public.app_user where must_change_password;
  select count(*) into n_orphan  from public.assessment where assigned_at is null;

  raise notice 'accounts requiring a password change: %', n_flagged;
  raise notice 'assessments with no assigner remaining: % (expect 0 drafts; any left are submitted/approved and were deliberately spared)', n_orphan;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'app_user'
       and column_name = 'must_change_password'
  ) then
    raise exception '0003 failed: must_change_password missing';
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'assessment'
       and column_name = 'assigned_at'
  ) then
    raise exception '0003 failed: assigned_at missing';
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'assessment'
       and column_name = 'deleted_at'
  ) then
    raise exception '0003 failed: deleted_at missing';
  end if;

  raise notice '0003 applied cleanly.';
end $$;

commit;
