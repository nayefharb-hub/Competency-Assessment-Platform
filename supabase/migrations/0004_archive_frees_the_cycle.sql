-- 0004 — one LIVE assessment per person per cycle, not one ever.
--
-- 0001 declared `unique (assessee_id, cycle)`. That was right while the only
-- way an assessment ended was by being completed. Archiving (N6) breaks it:
-- an archived row still occupies the slot, so "withdraw Ethan's cycle" would
-- permanently prevent Ethan being assigned that cycle again — and the failure
-- would surface as a database error on the Assign button, with nothing on
-- screen explaining why one person cannot be assigned.
--
-- The rule we actually want is "at most one assessment that still counts".
-- A partial unique index says exactly that, and lets an archived row keep
-- sitting alongside its replacement as the history it is meant to be.
--
-- Idempotent: safe to re-run.

begin;

alter table public.assessment
  drop constraint if exists assessment_assessee_id_cycle_key;

drop index if exists public.assessment_one_live_per_cycle;

create unique index assessment_one_live_per_cycle
  on public.assessment (assessee_id, cycle)
  where deleted_at is null;

commit;

-- ---------------------------------------------------------------- verify
-- Fails loudly rather than reporting success it did not achieve.
do $$
declare
  has_old_constraint boolean;
  has_new_index      boolean;
begin
  select exists (
    select 1 from pg_constraint
    where conrelid = 'public.assessment'::regclass
      and conname  = 'assessment_assessee_id_cycle_key'
  ) into has_old_constraint;

  select exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and tablename  = 'assessment'
      and indexname  = 'assessment_one_live_per_cycle'
  ) into has_new_index;

  if has_old_constraint then
    raise exception '0004 failed: the old unique constraint is still present';
  end if;
  if not has_new_index then
    raise exception '0004 failed: the partial unique index was not created';
  end if;

  raise notice '0004 OK — one live assessment per person per cycle; archived rows no longer hold the slot';
end $$;
