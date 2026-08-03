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

## Inviting people

There is no public signup. `public.app_user` IS the allowlist — a valid Supabase
Auth session with no `app_user` row is refused at sign-in — and this script
writes both halves of an account:

    npm run invite list
    npm run invite add someone@kib.com.kw "Full Name" assessee --title "Project Manager"
    npm run invite add head@kib.com.kw    "Full Name" admin    --title "Head of PMO"
    npm run invite remove someone@kib.com.kw

Roles are `assessee` | `assessor` | `admin`. Without `--password` a random one is
generated and printed once — hand it over out of band. Only `assessee` accounts
count toward the completion metric, so give the Head of PMO `admin` (which also
carries assessor rights) rather than `assessee`.

## Verifying

    npm run verify:db     # 11 schema/seed checks against the live database
    npm run e2e           # full assessment loop through a browser, then checked
                          # in Postgres. Writes; see docs/STATUS.md before running.

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
