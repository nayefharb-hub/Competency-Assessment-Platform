# Project status & handoff

Last updated: 2026-08-03. Read this first — it says where the build is and what
the next step is. Everything referenced here is committed.

## Why this exists (don't lose this framing)

**Prototype:** assess KIB's ~9 PMs against IPMA ICB4 this cycle. The Head of
Strategy asked for it; it's a committed line in this year's business plan. The
Head of PMO (the builder) is the sole assessor.

**Long term:** an open, multi-tenant platform — any organisation defines or
imports its own framework (domain → competency → indicator + scoring) and
assesses its people against it, sold by subscription. KIB is the first customer
and design partner; commercial demand elsewhere is a thesis, not evidence, and
does **not** drive prototype scope.

**The wedge:** the pains are all in the *assessment loop* — collection,
self/assessor reconciliation, rollup, trends — not in framework authoring. So
the prototype ships ICB4 only, with **no multi-framework authoring/import
engine**. Admin editing of *this* framework is in scope; a framework *builder*
is not.

**What the prototype is really testing:** whether PMs actually finish the
assessment online when they might not finish a spreadsheet, and whether the
rollup changes real training and staffing decisions. The existing Excel workbook
already satisfies the business-plan commitment, which de-risks the app — it can
be an honest product test rather than a must-ship dependency.

Consequences that are load-bearing in the code: framework stored as **data, not
constants**; rating scale as a **swappable module** (PDCF variant later);
`lib/framework.ts` as a **single seam** for the data source. These are cheap now
and keep the platform reachable — don't remove them as "unused generality."

## Where we are

| Task | State |
|---|---|
| Design doc (`/office-hours`) | **APPROVED** — `docs/design-competency-assessment-platform.md` |
| Eng plan (`/plan-eng-review`) | **CLEARED** — `docs/eng-plan-competency-assessment-platform.md` |
| Design system (`/design-consultation`) | **LOCKED** — `DESIGN.md` |
| T0 — extract & verify workbook | **DONE** — `data/seed/`, `docs/rollup-spec.md` |
| T1 — app scaffold, four screens | **DONE** — running on seed data |
| T2 — database | **applied, seeded, and VERIFIED in Supabase**; app NOT yet wired to it |

Database verified 2026-08-03 by running the query below in the SQL Editor — all
11 checks matched: 133 controls (132 active, 4.3.2.6 inactive), 28 elements,
3 areas, 586 measures, 6 scale levels, 4 benchmark profiles, 116 benchmark
targets, RLS on all 13 tables with 0 policies.

## Next step

**Wire the app to Supabase.** The database is live and seeded; the four screens
still read `data/seed/icb4-framework.json` through `lib/framework.ts`.

`lib/framework.ts` is the single seam — swapping it to query Supabase is the
whole job, plus:
1. A server-only Supabase client (service key, `server-only` import guard).
2. Auth: invite-only login, session → `app_user` role.
3. Persist self-scores, the assessor's review-and-revise, and approval
   (snapshot targets on approve, per `docs/rollup-spec.md` §6).
4. Completion instrumentation (T9 in the plan — it is P1, it's the whole thesis).

## Supabase

Project ref `gkqydskmnexhneqsvvvt`. Applied via the SQL Editor, in this order:
`supabase/migrations/0001_init.sql` → `0002_rls.sql` → `supabase/seed.sql`.
All three returned success; `seed.sql` self-verifies and rolls back on any
count mismatch. See `supabase/README.md`.

**Credentials are NOT in the repo.** Copy `.env.example` to `.env.local` and
fill in URL + publishable key + secret key from Settings → API. `.env.local` is
gitignored.

**Rotate the secret key when the pilot is done** — it was pasted into a session
transcript on 2026-08-03.

### Network access (important for cloud sessions)

`*.supabase.co` is **not** in the default Trusted allowlist, so a cloud session
cannot reach the database unless the environment's **Network access** is set to
**Custom** with `*.supabase.co` added (and "Also include default list of common
package managers" checked, or npm/GitHub break). Changing this only affects
sessions started afterwards.

If the current session cannot reach Supabase, verify the database by running SQL
in the Supabase SQL Editor instead — that path always works.

## Verify the database quickly

```sql
select 'controls' as item, count(*)::text as value from public.control
union all select 'controls active',      count(*)::text from public.control where active
union all select 'competence elements',  count(*)::text from public.competence_element
union all select 'areas',                count(*)::text from public.competence_area
union all select 'measures',             count(*)::text from public.measure
union all select 'scale levels',         count(*)::text from public.scale_level
union all select 'benchmark profiles',   count(*)::text from public.benchmark_profile
union all select 'benchmark targets',    count(*)::text from public.benchmark_target
union all select 'tables with RLS on',   count(*)::text from pg_tables  where schemaname='public' and rowsecurity
union all select 'RLS policies (want 0)',count(*)::text from pg_policies where schemaname='public'
union all select 'inactive control',     string_agg(code,',')          from public.control where not active
order by item;
```

Expected: areas 3 · benchmark profiles 4 · benchmark targets 116 · competence
elements 28 · controls 133 · controls active 132 · inactive control 4.3.2.6 ·
measures 586 · RLS policies 0 · scale levels 6 · tables with RLS on 13.

## Decisions that must not be re-litigated

Full rationale is in the design doc and `CLAUDE.md`; the short version:

- **Single framework (ICB4) only.** No multi-framework authoring/import engine
  until a pilot earns it. Admin editing of *this* framework is in scope.
- **ICB4 source text is never edited.** KIB clarifications go in `kib_note`,
  alongside.
- **Scale is APM 0–5**, built as a swappable module; PDCF is a later variant
  tested on real scores, not a rebuild now. Level 0 is **"Unaware"** — there is
  no "N/A" option.
- **Two scores:** `self_level` and the authoritative `assessor_level`. The
  assessor reviews and revises (accept as-is or override), rather than
  re-scoring from scratch.
- **Access control lives in the server data layer**, not RLS. Postgres RLS
  cannot hide columns by row-state. RLS is deny-by-default defence in depth.
- **Auth is an invite-only allowlist** for the pilot; SSO/AD deferred.
- **The tool supports a decision, never gates one.** No pass/fail verdicts.

## Use gstack for the next phase

The SessionStart hook installs gstack. Once the app is wired to the database,
run these before shipping: `/review` on the diff, `/qa` against the running app,
`/design-review` against `DESIGN.md`, then `/ship`. Use `/investigate` for bugs
rather than ad-hoc debugging. See the routing table in `CLAUDE.md`.

## Open items

1. **Completion baseline** — has this team had completion/lateness problems
   before? Needed to judge whether the online form actually helps (design doc's
   assignment). Five-minute desk check, no PM time.
2. **What decision the rollup drives** (training budget? staffing?) — confirm
   before polishing the dashboard.
3. **Escalation reads oddly in the UI**: a CE at 3.0/3 can show "Capability
   Deficit" when one control sits 2+ levels below its own target. Correct per
   the brief; may want a visual cue explaining why.
4. **Vercel deploy** not set up yet.
