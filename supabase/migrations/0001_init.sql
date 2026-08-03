-- 0001_init.sql — Competency Assessment Platform schema
--
-- Design notes (see docs/eng-plan-competency-assessment-platform.md):
--   * The framework is DATA, not hardcoded constants: it is edited through the
--     admin screen and a second rating scale (PDCF) may be added later.
--   * Two scores per control: self_level (the PM) and assessor_level
--     (authoritative — what results show). assessor_level defaults to self_level;
--     the assessor accepts as-is or overrides specific controls.
--   * Inactive controls contribute nothing to any rollup, gap or result.
--   * ICB4 source text is never edited. KIB clarifications live in kib_note.

-- ---------------------------------------------------------------- rating scale
-- Swappable module: APM 0-5 ships first, a PDCF variant can be added as a second
-- row here without touching the assessment tables.
create table public.scale (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,                -- "APM Competence Framework 3rd Edition"
  axis        text not null,                -- "Application"
  created_at  timestamptz not null default now()
);

create table public.scale_level (
  id          uuid primary key default gen_random_uuid(),
  scale_id    uuid not null references public.scale(id) on delete cascade,
  level       smallint not null check (level between 0 and 5),
  label       text not null,                -- Unaware / Aware / Practised / ...
  knowledge   text,                         -- APM canonical wording
  application text,                         -- APM canonical wording (targets use this axis)
  kib_gloss   text,                         -- plain-language restatement shown to the PM
  unique (scale_id, level)
);

-- ------------------------------------------------------------------ framework
create table public.framework (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,                -- "IPMA ICB4"
  version     text not null,                -- "v4.0.1"
  scale_id    uuid not null references public.scale(id),
  created_at  timestamptz not null default now(),
  unique (name, version)
);

create table public.competence_area (
  id            uuid primary key default gen_random_uuid(),
  framework_id  uuid not null references public.framework(id) on delete cascade,
  code          text not null,              -- perspective | people | practice
  name          text not null,
  sort_order    smallint not null,
  unique (framework_id, code)
);

create table public.competence_element (
  id            uuid primary key default gen_random_uuid(),
  framework_id  uuid not null references public.framework(id) on delete cascade,
  area_id       uuid not null references public.competence_area(id) on delete cascade,
  code          text not null,              -- "4.3.1"
  name          text not null,
  -- APM published value. NEVER computed or averaged from control targets.
  target_level  smallint check (target_level between 0 and 5),
  sort_order    smallint not null,
  unique (framework_id, code)
);

create table public.control (
  id              uuid primary key default gen_random_uuid(),
  framework_id    uuid not null references public.framework(id) on delete cascade,
  ce_id           uuid not null references public.competence_element(id) on delete cascade,
  code            text not null,            -- "4.3.1.1"
  indicator       text not null,            -- ICB4 source text — never edited
  description     text,                     -- ICB4 source text — never edited
  active          boolean not null default true,
  priority        text check (priority in ('High','Medium','Low')),
  reason          text,                     -- required when not Active/High
  kib_note        text,                     -- KIB clarification, sits ALONGSIDE the source text
  apm_competence  text,
  target_level    smallint check (target_level between 0 and 5),
  target_source   text,                     -- 'APM (published)' | 'Derived (priority rule)'
  sort_order      smallint not null,
  updated_at      timestamptz not null default now(),
  unique (framework_id, code)
);

-- Reference only: measures explain an indicator and are never scored.
create table public.measure (
  id          uuid primary key default gen_random_uuid(),
  control_id  uuid not null references public.control(id) on delete cascade,
  seq         smallint not null,
  text        text not null,
  unique (control_id, seq)
);

-- ------------------------------------------------------------ benchmark profiles
-- APM role profiles (Entry / Intermediate / Advanced / Master). Selecting a
-- profile re-points every control target.
create table public.benchmark_profile (
  id            uuid primary key default gen_random_uuid(),
  framework_id  uuid not null references public.framework(id) on delete cascade,
  name          text not null,              -- "Intermediate"
  sort_order    smallint not null,
  unique (framework_id, name)
);

create table public.benchmark_target (
  id              uuid primary key default gen_random_uuid(),
  profile_id      uuid not null references public.benchmark_profile(id) on delete cascade,
  apm_competence  text not null,
  -- null means APM marks the competence not relevant (N/R) at this level
  level           smallint check (level between 0 and 5),
  unique (profile_id, apm_competence)
);

-- ----------------------------------------------------------------- app users
-- Mirrors auth.users. Signup is invite-only (public signup disabled).
create type public.user_role as enum ('assessee', 'assessor', 'admin');

create table public.app_user (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text not null unique,
  full_name   text not null,
  job_title   text,
  role        public.user_role not null default 'assessee',
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------- assessments
-- draft -> self_submitted -> approved (locked)
create type public.assessment_state as enum ('draft', 'self_submitted', 'approved');

create table public.assessment (
  id            uuid primary key default gen_random_uuid(),
  framework_id  uuid not null references public.framework(id),
  profile_id    uuid not null references public.benchmark_profile(id),
  assessee_id   uuid not null references public.app_user(id) on delete cascade,
  assessor_id   uuid references public.app_user(id),
  cycle         text not null,              -- "2026"
  state         public.assessment_state not null default 'draft',
  created_at    timestamptz not null default now(),
  submitted_at  timestamptz,                -- PM submitted their self-assessment
  approved_at   timestamptz,                -- assessor approved; record is locked
  -- completion instrumentation (the prototype's central metric)
  started_at    timestamptz,
  completed_at  timestamptz,
  unique (assessee_id, cycle)
);

create table public.score (
  id                uuid primary key default gen_random_uuid(),
  assessment_id     uuid not null references public.assessment(id) on delete cascade,
  control_id        uuid not null references public.control(id),
  self_level        smallint check (self_level between 0 and 5),
  -- authoritative: what the results show. Defaults to self_level on submit.
  assessor_level    smallint check (assessor_level between 0 and 5),
  -- distinguishes a real review from a blanket "accept all"
  assessor_touched  boolean not null default false,
  evidence          text,                   -- optional, never scored
  updated_at        timestamptz not null default now(),
  unique (assessment_id, control_id)
);

-- Targets frozen at approval so historic gaps never shift if the profile changes.
create table public.target_snapshot (
  assessment_id uuid not null references public.assessment(id) on delete cascade,
  control_id    uuid not null references public.control(id),
  target_level  smallint check (target_level between 0 and 5),
  primary key (assessment_id, control_id)
);

-- ------------------------------------------------------------------- indexes
create index control_ce_idx           on public.control(ce_id);
create index control_active_idx       on public.control(framework_id, active);
create index measure_control_idx      on public.measure(control_id);
create index ce_area_idx              on public.competence_element(area_id);
create index score_assessment_idx     on public.score(assessment_id);
create index assessment_assessee_idx  on public.assessment(assessee_id);
create index benchmark_target_profile_idx on public.benchmark_target(profile_id);

-- --------------------------------------------------------------- updated_at
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger control_touch
  before update on public.control
  for each row execute function public.touch_updated_at();

create trigger score_touch
  before update on public.score
  for each row execute function public.touch_updated_at();
