# Project status & handoff

Last updated: 2026-08-03 (app wired to Supabase). Read this first — it says where
the build is and what the next step is. Everything referenced here is committed.

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
| T1 — app scaffold, four screens | **DONE** |
| T2 — database + server data layer | **DONE** — schema applied, seeded, verified |
| T3 — seed ICB4 | **DONE** — 11/11 checks against the live database |
| T4 — assessment loop (PM) | **DONE** — scores persist; draft → self_submitted |
| T5 — assessor review-and-revise | **DONE** — override, accept-all, approve + snapshot |
| T6 — rollup engine | **DONE** — reads real scores; snapshot targets after approval |
| T7 — results + assessor overview | **DONE** |
| T8 — admin editor | **DONE** — tunable layer only, ICB4 source read-only |
| T9 — completion instrumentation | **DONE** — finished flag + median time-to-complete |
| T10 — trends across cycles | not started (P3, schema-ready) |

**The app now runs on Postgres, not the JSON seed.** `lib/framework.ts` is still
the single seam; it queries Supabase instead of `data/seed/icb4-framework.json`.
The seed JSON stays in the repo as the source `supabase/seed.sql` was generated
from — it is no longer read at runtime.

Verified 2026-08-03 against the live database:
- `npm run verify:db` — 11/11 (133 controls, 132 active, 4.3.2.6 inactive, 28
  elements, 3 areas, 586 measures, 6 scale levels, 4 profiles, 116 targets,
  and the per-area splits 24/49/60).
- `npm run e2e` — 67/67 through a real browser against the running app, then
  checked in Postgres directly. Covers auth, role gates, target blinding,
  score persistence, submit, review, accept-all, approve + snapshot, locking,
  cross-user access, rollup arithmetic, and the admin editor.

## What was built

- **`lib/supabase/server.ts`** — service-role client behind `import "server-only"`,
  so a client component importing it is a build error. The browser only ever
  holds the anon key, which reads nothing (RLS on, zero policies).
- **`lib/framework.ts`** — the seam, now querying Postgres. Two entry points, and
  the difference is a security boundary: `getFramework()` (assessor/admin) and
  `getAssesseeFramework()`, which strips target, priority, reason and kib_note.
  Redaction is in the data layer, not in JSX, so no page or action can leak past
  it. (`kib_note` carries target provenance — "Senior baseline / junior target" —
  which is why the PM does not see it. Per the eng plan's state machine.)
- **Auth** — invite-only. `app_user` IS the allowlist: a valid Supabase session
  with no `app_user` row gets nothing. `scripts/invite.mjs` creates both halves
  of an account. Password login; SSO still deferred.
- **Persistence** — self-scores, assessor overrides, accept-all, approval with
  the target snapshot (`docs/rollup-spec.md` §6). Every transition is guarded in
  the WHERE clause AND checked for a matched row, because a PostgREST update
  that matches nothing is not an error and would otherwise report success.
- **Completion instrumentation** — `started_at` on first save, `completed_at` on
  submit; the assessor's first screen leads with finished-count and median
  time-to-complete. Only `assessee`-role people count, so the Head of PMO
  opening the form cannot move the number.

## Next step

**Deploy to Vercel** (still not set up), then run the pilot. Before that:

1. Set the four env vars in Vercel from `.env.example`.
2. Invite the ~9 PMs: `npm run invite add <email> "<Name>" assessee --title "..."`.
3. Confirm the completion baseline desk check (open item 1 below) — the median
   time-to-complete number means little without it.

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

From the repo (uses the app's own credentials, so it also proves the service key
reaches every table the app needs):

```bash
npm run verify:db            # 11 schema/seed checks, exits non-zero on mismatch
npm run e2e                  # full loop through a browser; needs the app running
                             # ADMIN_EMAIL=... ADMIN_PASSWORD=... npm run e2e
```

`e2e` writes to whatever database it is pointed at. It refuses to run without
`--write`, touches only two `@example.test` accounts it creates, and deletes them
plus their assessments afterwards. It also restores control 4.3.1.3 to its seeded
values after exercising the admin editor.

Or in the Supabase SQL Editor:

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
- **The PM does not see `kib_note` either.** It carries target provenance
  ("Senior baseline / junior target"), so showing it would defeat the
  anti-anchoring rule. It belongs to the admin layer, alongside priority and
  reason. Redacted in `getAssesseeFramework()`, not in the JSX.
- **Targets snapshot at approval, never before.** Editing a target in the admin
  screen changes future rollups only; approved assessments keep their frozen
  values.

## Use gstack for the next phase

The SessionStart hook installs gstack. Use `/investigate` for bugs rather than
ad-hoc debugging, `/review` before landing, `/qa` against the running app,
`/design-review` against `DESIGN.md`, then `/ship`. See the routing table in
`CLAUDE.md`.

## Open items

1. **Completion baseline** — has this team had completion/lateness problems
   before? Needed to judge whether the online form actually helps (design doc's
   assignment). Five-minute desk check, no PM time. The app now measures the
   "after"; this is the "before" it gets compared against.
2. **What decision the rollup drives** (training budget? staffing?) — confirm
   before polishing the dashboard.
3. **Escalation reads oddly in the UI**: a CE at 3.0/3 can show "Capability
   Deficit" when one control sits 2+ levels below its own target. Correct per
   the brief; may want a visual cue explaining why.
4. **Vercel deploy** not set up yet.
5. **General Sans is not in the repo.** `DESIGN.md` specifies it for headings;
   Fontshare is unreachable from the build environment, so headings currently
   fall back to Geist (which IS self-hosted, per spec, for body/UI/data). One
   file drop finishes it — see the Typography section of `DESIGN.md`.
6. **Rotate the admin's temporary password.** The account was created during the
   wiring session and its first password was printed to a transcript.
7. **CE targets do not re-point by benchmark profile.** Per-control targets do
   (`targetsForProfile`), but CE targets are APM's published values for the
   Intermediate profile, taken from the workbook's Results sheet. Anything other
   than Intermediate needs published CE targets we do not have. Default is
   Intermediate, so this does not bite yet.
