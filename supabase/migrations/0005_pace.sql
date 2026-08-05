-- 0005 — how long each control actually took (D28).
--
-- WHY A COLUMN AND NOT A DERIVATION. `score.updated_at` is already stamped
-- per control, so the gap between consecutive saves looks like free pace data.
-- It was measured against what it has to detect and rejected (D28):
--
--   * the FIRST control of every sitting has no predecessor, so it is
--     unmeasurable — and "sat down, answered one, left" is exactly the shape
--     of the behaviour being looked for;
--   * scoring out of order attributes the gap to the wrong control;
--   * re-scoring one control silently corrupts its neighbour's gap;
--   * a gap cannot tell four minutes of thinking from four minutes of lunch.
--
-- The browser knows the answer directly: the control was rendered at T, the
-- PM pressed Next at T+n. `dwell_ms` records n.
--
-- WHAT IT IS FOR, stated here because a timing column on a staff record
-- deserves an explicit purpose. Rushing throws off the results — an
-- assessment clicked through in nine minutes is nine minutes of noise the
-- assessor then has to trust. Pace is a FLAG, never a verdict: it says where
-- to look, and the answer content (spread of levels used, whether evidence was
-- ever written) is what actually distinguishes a fast expert from a rusher.
-- PMs are told it is recorded — see docs/design-assessment-flow-and-pace.md
-- (D21). A measurement people are not told about is a trap, not an instrument.
--
-- NULL means "not known", and that is a real and common state, not a defect:
-- every score written before this migration, every answer whose clock exceeded
-- the sanity ceiling, and every answer saved by a client that could not time
-- it. The analysis reports how many readings it HAS rather than assuming the
-- absent ones were fast.
--
-- Idempotent: safe to re-run.

begin;

alter table public.score
  add column if not exists dwell_ms integer;

-- WHY A SECOND TIMESTAMP, WHEN `updated_at` IS RIGHT THERE.
--
-- Because `updated_at` cannot order these readings, and a review pass caught
-- the first version of the code asserting that it could. The `score_touch`
-- trigger in 0001 rewrites `updated_at` on EVERY update, and
-- `submitSelfAssessment` upserts all 132 score rows to prefill the assessor's
-- sheet — so the moment a PM presses Submit, every row carries one identical
-- timestamp. The "did they speed up?" trend would then be splitting an
-- arbitrary heap order down the middle, and could report a PM who sped up as
-- having slowed down, in exactly the state the assessor looks at.
-- `setAssessorLevels` is more pointed still: it re-stamps only the controls
-- the assessor already doubted.
--
-- `answered_at` is written by ONE function (`saveSelfScore`) and only
-- alongside `dwell_ms`, so it timestamps the same event the duration measures.
-- Every assessor-side path omits it, and a column absent from an upsert
-- payload is left alone.
alter table public.score
  add column if not exists answered_at timestamptz;

-- A negative reading is a broken clock, not a fast answer. The ceiling is
-- enforced in the server action (a value over it is stored as NULL rather than
-- saturated, so a capped reading never enters a median pretending to be real);
-- this constraint is the backstop for anything that reaches the table by
-- another route.
alter table public.score
  drop constraint if exists score_dwell_ms_sane;

alter table public.score
  add constraint score_dwell_ms_sane
  check (dwell_ms is null or (dwell_ms >= 0 and dwell_ms <= 86400000));

comment on column public.score.dwell_ms is
  'Milliseconds the control was on screen and visible before the PM FIRST '
  'answered it. Paused while the tab is hidden; not overwritten by a later '
  'revision. NULL = not measured.';

comment on column public.score.answered_at is
  'When the measured first answer was given. Written only beside dwell_ms. '
  'Use this to order readings, never updated_at (which a trigger rewrites).';

commit;

-- ---------------------------------------------------------------- verify
-- Fails loudly rather than reporting success it did not achieve.
do $$
declare
  has_dwell      boolean;
  has_answered   boolean;
  has_constraint boolean;
begin
  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'score' and column_name = 'dwell_ms'
  ) into has_dwell;

  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'score' and column_name = 'answered_at'
  ) into has_answered;

  select exists (
    select 1 from pg_constraint
    where conrelid = 'public.score'::regclass
      and conname  = 'score_dwell_ms_sane'
  ) into has_constraint;

  if not has_dwell then
    raise exception '0005 failed: score.dwell_ms was not created';
  end if;
  if not has_answered then
    raise exception '0005 failed: score.answered_at was not created';
  end if;
  if not has_constraint then
    raise exception '0005 failed: the sanity constraint was not created';
  end if;

  raise notice '0005 OK — score.dwell_ms + answered_at record time-on-control; NULL means not measured';
end $$;
