-- 0002_rls.sql — Row Level Security as defence in depth.
--
-- ARCHITECTURE NOTE — read before adding policies.
--
-- Access control for this app lives in the SERVER-SIDE DATA LAYER (Next.js
-- server code using the service_role key, which bypasses RLS). The browser is
-- never given a table-capable key. RLS here is a second line of defence, not
-- the primary control.
--
-- Postgres RLS cannot hide individual COLUMNS based on a row's state, so the
-- "PM must not see the assessor's scores or the targets before approval" rule
-- CANNOT be expressed here — it is enforced by column selection in the server
-- data layer. Do not attempt to re-implement it with policies.
--
-- Therefore: enable RLS everywhere and grant NOTHING to anon/authenticated.
-- Deny-by-default. If a key ever leaks to a browser, it reads zero rows.

alter table public.scale               enable row level security;
alter table public.scale_level         enable row level security;
alter table public.framework           enable row level security;
alter table public.competence_area     enable row level security;
alter table public.competence_element  enable row level security;
alter table public.control             enable row level security;
alter table public.measure             enable row level security;
alter table public.benchmark_profile   enable row level security;
alter table public.benchmark_target    enable row level security;
alter table public.app_user            enable row level security;
alter table public.assessment          enable row level security;
alter table public.score               enable row level security;
alter table public.target_snapshot     enable row level security;

-- Belt and braces: revoke the Data API roles' privileges on this schema so a
-- table is never reachable from a browser even if a policy is added by mistake.
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;

alter default privileges in schema public
  revoke all on tables from anon, authenticated;

-- Grant the server role explicitly rather than relying on project defaults.
-- The project has "automatically expose new tables" turned OFF, which changes
-- Supabase's default privileges; stating what we need here keeps the migration
-- self-contained and means a settings change can never lock the app out.
grant usage on schema public to service_role;
grant all on all tables     in schema public to service_role;
grant all on all sequences  in schema public to service_role;
grant all on all functions  in schema public to service_role;

alter default privileges in schema public
  grant all on tables to service_role;
alter default privileges in schema public
  grant all on sequences to service_role;

-- No policies are created on purpose. RLS with zero policies = deny all for
-- anon and authenticated. service_role (server-side only) bypasses RLS.
--
-- If you later move any read path to the browser, add a narrow policy HERE and
-- write a test proving an assessee cannot read another assessee's rows, nor any
-- assessor-only column before the assessment is approved.
