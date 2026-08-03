# Applying the database

Two ways. **Path A needs nothing but a browser** and is the one to use if this
agent's environment cannot reach `*.supabase.co` (egress policy).

## Path A — Supabase SQL Editor (no tooling required)

In the Supabase dashboard → **SQL Editor** → New query. Paste and **Run** each
file in order, waiting for each to finish:

1. `supabase/migrations/0001_init.sql` — 13 tables
2. `supabase/migrations/0002_rls.sql` — RLS deny-by-default + service_role grants
3. `supabase/seed.sql` — the ICB4 framework (206 KB; paste it whole)

`seed.sql` verifies itself: it raises an exception and rolls back unless it ends
with exactly 133 controls (132 active), 28 elements, 3 areas, 586 measures and 6
scale levels. Success prints:

    NOTICE: Seed verified: 133 controls (132 active), 28 elements, 586 measures.

To reseed: `delete from public.framework where name='IPMA ICB4';` then re-run
`seed.sql` (children cascade).

## Path B — from a machine that can reach Supabase

    cp .env.example .env.local        # fill in URL + keys
    npm install
    export $(grep -v '^#' .env.local | xargs)
    node scripts/seed.mjs             # --reset to replace an existing framework

Migrations still need to be applied first (SQL Editor, or `psql` with the
connection string from Settings → Database).

## Regenerating seed.sql

`supabase/seed.sql` is generated from the verified T0 extraction — do not edit it
by hand:

    python3 scripts/gen_seed_sql.py

## Security posture

Access control lives in the server-side data layer (service key, server-only).
RLS is enabled on all 13 tables with **zero policies** = deny-by-default for
`anon` and `authenticated`; `service_role` is granted explicitly so the app does
not depend on project-level default privileges. Postgres RLS cannot hide columns
based on a row's state, so "the PM must not see assessor scores or targets before
approval" is enforced in the data layer — see the note at the top of
`0002_rls.sql`.
