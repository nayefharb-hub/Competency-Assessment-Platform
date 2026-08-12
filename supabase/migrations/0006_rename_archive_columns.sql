-- 0006 — rename the archive columns to say what they mean.
--
-- 0003 named them deleted_at/deleted_by/deleted_reason, but the feature never
-- deletes: archiving KEEPS the row, its scores and its timings, and only takes
-- it out of the live lists and rollups (see archiveAssessment in
-- lib/db/assessment.ts, and 0003's own comment: "Archive, not delete"). The
-- "deleted_" prefix was the one place the schema still called it a delete, and
-- it read as a contradiction next to every archive/restore path around it.
--
--   deleted_at     -> archived_at
--   deleted_by     -> archived_by
--   deleted_reason -> archived_reason
--
-- Postgres rewrites everything that DEPENDS on these columns as part of the
-- rename, so there is nothing else to change in the database:
--   * the partial unique index assessment_one_live_per_cycle (0004) and the
--     assessment_live_idx (0003) both carry a `where deleted_at is null`
--     predicate — the rename rewrites both predicates to `archived_at is null`.
--   * the column COMMENT on deleted_at moves to archived_at unchanged; it is
--     refreshed below so its wording matches the new name.
--
-- Idempotent: each rename is guarded so re-running is a no-op. Safe to run
-- BEFORE the matching code deploys only if the code is not yet live — old code
-- selects deleted_* and would 500 the moment this runs. RUN THIS TOGETHER WITH
-- THE DEPLOY that ships the archived_* code, the same way 0003 was tied to its
-- PR: the running build and this column set must agree.

begin;

do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'assessment'
       and column_name = 'deleted_at'
  ) then
    alter table public.assessment rename column deleted_at     to archived_at;
    alter table public.assessment rename column deleted_by     to archived_by;
    alter table public.assessment rename column deleted_reason to archived_reason;
  end if;
end $$;

comment on column public.assessment.archived_at is
  'Archive, not delete. A hard delete removes started_at/completed_at, which
   silently moves the median time-to-complete — the number the pilot exists to
   produce. Archived rows drop out of every list and rollup but keep their
   timing, so the metric stays reconstructible. Read paths must filter
   archived_at is null.';

commit;

-- verify ---------------------------------------------------------------------
do $$
declare
  has_new  boolean;
  has_old  boolean;
  idx_pred text;
begin
  select exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'assessment'
       and column_name = 'archived_at'
  ) into has_new;
  select exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'assessment'
       and column_name = 'deleted_at'
  ) into has_old;

  if not has_new then
    raise exception '0006 failed: archived_at missing';
  end if;
  if has_old then
    raise exception '0006 failed: deleted_at still present';
  end if;

  -- The partial unique index must still be the one-live-per-cycle guard, now
  -- keyed on archived_at. If the rename had not carried the predicate, this
  -- would catch it before the app does.
  select pg_get_expr(indpred, indrelid) into idx_pred
    from pg_index
    join pg_class on pg_class.oid = pg_index.indexrelid
   where pg_class.relname = 'assessment_one_live_per_cycle';
  if idx_pred is null or position('archived_at' in idx_pred) = 0 then
    raise exception '0006 failed: assessment_one_live_per_cycle predicate did not follow the rename (got: %)', idx_pred;
  end if;

  raise notice '0006 OK — archive columns renamed; live-per-cycle index follows archived_at';
end $$;
