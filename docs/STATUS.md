# Project status & handoff

Last updated: 2026-08-05 (the shape-of-the-work arc: PRs #22–#24 — areas/competencies, durations, stalls, and pace). Read this first — it says where the build is and what the next step is.
Everything referenced here is committed.

**Live.** Deployed on Vercel from `main`. Migrations `0003`, `0004` and
`0005` are applied (`0005` on 2026-08-05, by the owner, in the SQL Editor).
Access-token lifetime was cut 60 min → 15 min the same day, and measured at
900s rather than taken on trust. Pilot feedback from using it is logged in
`docs/pilot-feedback.md` (15 notes, triaged); the plan for the rest is
`docs/eng-plan-admin-and-ux.md`.

---

## Picking this up in a new session — read this first

**1. Recreate `.env.local` before anything else.** It is gitignored and the
session container is ephemeral, so a fresh session has no credentials and every
script fails with "Missing SUPABASE_URL". Copy `.env.example` and fill in the
four values from Supabase → Project Settings → API. Nothing else works until
this exists.

**2. Network access.** `*.supabase.co` must be in the environment's Network
access allowlist (Custom + "include default package managers"), or the session
cannot reach the database at all. `*.vercel.app` is **not** reachable from the
agent sandbox and probably cannot be — so nothing an agent says about the
deployed site is verified. Test the code locally against the real database;
confirming production is the owner's step.

**3. The password gate is live.** Every account carries
`must_change_password = true` until its owner replaces the password. On first
sign-in you land on `/change-password` and cannot leave it. This is expected, not
a bug. `scripts/e2e.mjs` is unaffected — it creates and deletes its own QA
accounts and needs no real credentials.

**4. Prove the environment before building anything:**

```bash
npm install
npm run verify:db          # expect 11/11
npm run build && npm start &
npm run e2e                # expect 235/235 — writes, then cleans up after itself
npm run test:unit          # expect 47/47 — pure logic, no database
```

If `verify:db` fails, stop: it is credentials or network, not code.

**If `e2e` dies with "Executable doesn't exist at /opt/pw-browsers/…":** the
cloud sandbox ships a pinned Chromium build that will not match whatever
`playwright@^1.62.1` floats to. Do **not** run `npx playwright install` — it is
blocked and unnecessary. Point the suite at the preinstalled browser instead:

```bash
E2E_CHROMIUM=/opt/pw-browsers/chromium npm run e2e
```

`scripts/e2e.mjs:24` already reads that variable; nothing needs changing.

**5. Where things are.**

| Want | Read |
|---|---|
| What the owner asked for and what happened to it | `docs/pilot-feedback.md` (N1–N21) |
| What to build next and in what order | `docs/eng-plan-admin-and-ux.md` |
| Visual rules — locked, do not deviate | `DESIGN.md` |
| Rollup arithmetic contract | `docs/rollup-spec.md` |

**6. PR A2 — assignment (N7) is DONE.** `getOrCreateAssessment` is gone; an
assessment exists only because an admin assigned it, from `/admin/people`. The
completion denominator is now a count of assignments, and both crutches — the
`Math.max(invitedCount, …)` fudge and the `assessee_is_pm` filter — are deleted
rather than left to disagree quietly with it. `CompletionStats.invited` is
renamed `assigned`, because that is what it counts. Withdrawing an assignment is
allowed only while nothing has been scored. No migration was needed: `0003`
already added `assigned_at` / `assigned_by`.

**PR B — archive (N6) is DONE and migration `0004` is APPLIED** (2026-08-04). It
replaced `unique (assessee_id, cycle)` with a partial unique index over live
rows, so an archived record no longer holds the slot. Verified both directions
against the live database: re-assigning after an archive succeeds, and two live
assessments for one person and cycle are still refused.

**N14 is DONE** — the owner approved the DESIGN.md amendment, which is applied
(§Layout gains the interactive-panel exception; two rows in the decisions log).
The self-assessment is prose-left / scoring-right and pinned above 1100px, one
column with a fixed action bar below it. Save is on screen on load at every width
tested, on the longest control in ICB4 as well as the shortest.

**PR C is DONE** — N10 mobile (header chrome 204px → 122px on a phone; tables
as cards below 560px), N12 Light/Dark/Auto in a cookie with no client component,
N5 controls filter as a query parameter, N4 scored-state emphasis decided after
N5 as planned. `DESIGN.md` gains three decision-log rows.

**The feature backlog is empty; a performance arc followed it.** PRs #9–#13 are
merged (N16–N21) — see "The performance arc" below. The next step is still to
run the cycle: add the nine PMs on **People**, assign them, and let the
completion figure collect. Most of what is still open is the owner's call — see
item 7 — with two exceptions carried in the open items list: the N21
verification and one unpinned e2e flake.

**7. Everything still open is blocked on the owner, not on code.**
- **N1 / N1b** — untick Preview and Development on the two secret-bearing Vercel
  env vars, and decide whether a staging Supabase project is wanted.
- **N15 session bounds** — an inactivity window and an absolute cap. The code
  side is one constant; the rest is a Supabase dashboard setting.
- **The reading measure** — prose renders at 72–73 characters against the 60–70
  DESIGN.md asks for. `48ch` would land in range; left alone because it moves
  every page and belongs with the palette judgement.
- **SMTP** — gates emailed invite links and self-service password reset. Needs
  an IT/policy answer on whether a third-party sender is acceptable for a bank.
- **Palette** — approved but deliberately deferred until the fixed reading
  measure has been judged. See the `DESIGN.md` decisions log for the reasoning
  and the recommended direction if it is still wanted.

**8. Do not use the owner's account for testing.** Use a disposable
`@example.test` account, as `scripts/e2e.mjs` does. Filling and then emptying
the owner's live assessment mid-session is a mistake that has already been made
once — see N13.

---

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

Verified 2026-08-05 against the live database:
- `npm run verify:db` — 11/11 (133 controls, 132 active, 4.3.2.6 inactive, 28
  elements, 3 areas, 586 measures, 6 scale levels, 4 profiles, 116 targets,
  and the per-area splits 24/49/60).
- `npm run e2e` — **235/235** through a real browser against the running app,
  then checked in Postgres directly. Covers auth, assignment, role gates, target
  blinding, score persistence, submit, review, accept-all, approve + snapshot,
  locking, cross-user access, rollup arithmetic, the admin editor, the password
  gate, the People screen, session-cookie flags, archive/restore, the
  area/competency navigation, the pace disclosure and `/analysis`
  authorisation, and the N14 layout guarantee (Save on screen without scrolling at three viewports on both
  the shortest and longest controls, with the prose still capped at the reading
  measure).

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
  time-to-complete. The denominator is the number of people an admin **assigned**
  this cycle — a recorded fact, not an inference from who holds a login.

## The performance arc (PRs #9–#13, N16–N21)

The app was slow in production. Five PRs, and the useful output is as much about
*how the investigation went wrong* as about what got faster.

| PR | What it found | Result |
|---|---|---|
| #9 | 18 Supabase calls per page; wrong function region | 18 → 4 calls; region pinned `fra1` |
| #10 | Supabase charges ~31ms **per REST call** before the query runs, so round-trip *count* is the multiplier | framework 9 queries → 1; median DB time per page 1300ms → 222ms |
| #11 | Bracketed the save action; killed the author's own `revalidatePath` theory (measured 0–1ms) | ~50% of a save is Next/Vercel machinery *outside* our code |
| #12 | **N19** a failed `app_user` query and "not on the allowlist" shared a branch — a transient DB error signed the admin out, silently. **N20** an orphan `auth.users` row held an email hostage with no route out | both fixed; N20 was also the N17 flake, now deterministic |
| #13 | 98 of 101 prefetches rendered nothing — and deleting them exposed 14 tests passing on unrelated network noise | prefetching off via `app/link.tsx`; `click`-then-`networkidle` eliminated |

**Three things worth not re-learning:**

1. **"I could not find out" and "the answer is no" are different answers.**
   Collapsing them (N19) turned an availability blip into a security-shaped lie
   told to a legitimate user.
2. **A test that passes because of unrelated traffic is indistinguishable from a
   test that passes** — until the traffic changes. The suite had that property
   for weeks (N21).
3. **On this platform, measure first and explain second.** Three mechanisms were
   proposed and disproved: `unstable_cache`, the function region, and — after
   the owner confirmed Fluid Compute was on all along — the concurrency model
   itself. See the correction at the end of N21.

**Fluid Compute is ON** and was on throughout. That imposes a rule on all future
server code: **no per-user state at module scope**, because instances now serve
requests concurrently. The audit that certifies the current code, and the one
known race, are in `docs/deploy.md` → "Runtime: Fluid Compute".

**The arc is closed. Verified in production 2026-08-05: zero cold starts** on a
live single-user session (`hot` 12, `prewarmed` 2, `cold` none). The churn that
started this — 12 instances for one user — does not reproduce. Consistent with
the rule above, the *outcome* is recorded and the *cause* is not claimed:
Fluid's prewarming and the prefetch removal cannot be separated by this
measurement. Full numbers and the two dead ends in `docs/pilot-feedback.md` →
"Resolution (2026-08-05)".

## Next step

**Invite the nine PMs, assign them the cycle, and run it.** Deployment is done
(`docs/deploy.md`); neither adding people nor assigning needs a terminal — sign
in as an admin and use **People** in the nav. Adding someone does not start
anything; assigning does, and that assignment is what the completion figure
counts.

Then:

1. Confirm the completion baseline desk check (open item 1 below) — the median
   time-to-complete number means little without it.
2. Work through the remaining pilot-feedback items in the order set out in
   `docs/eng-plan-admin-and-ux.md`: **A2** (assignment — makes the completion
   denominator a fact rather than a guess), **B** (archive), then **C** (the
   rest of the UX pass: mobile, theme toggle, controls filter).

## Supabase

Project ref `gkqydskmnexhneqsvvvt`. Applied via the SQL Editor, in this order:
`supabase/migrations/0001_init.sql` → `0002_rls.sql` → `supabase/seed.sql`,
then `0003_assignment_and_archive.sql` (applied 2026-08-03),
`0004_archive_frees_the_cycle.sql`, and `0005_pace.sql` (applied 2026-08-05).
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
npm run e2e                  # full loop through a browser; needs the app running.
                             # Self-contained: it creates and deletes its own QA
                             # accounts, and needs no real credentials.
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
- **Preview deployments reuse the production Supabase project, and are safe only
  because Vercel Authentication guards them** (2026-08-05). Environment variables
  are scoped to `Preview` as well as `Production` so preview URLs actually work —
  before this, a change could only be seen by merging it, which is how #14 and
  #15 came to be reviewed after landing. The service-role key on a shareable URL
  is defensible *only* while *Deployment Protection → Vercel Authentication* is
  on (Standard Protection). **Turn that off and the preview scoping must come off
  too.** A separate preview Supabase project is the alternative if isolation is
  ever needed; rationale and trigger conditions in `docs/deploy.md`.

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
3. ~~**Escalation reads oddly in the UI**~~ — done (2026-08-05). A CE at 3.0/3
   showing "Capability Deficit" now names the control that forced it: *"deficit
   driven by 4.3.1.2, scored 1 against target 3"*. Shown **only** where
   escalation actually changed the verdict — where the mean is also short the
   badge needs no defence, and explaining it anyway would train people to skim
   the line in the case that matters. No new visual element: it reuses the
   existing `<small>` row that already carries *"weakest …"*, so `DESIGN.md`
   is untouched. The wording and placement are still the owner's to approve.
   Engine change is presentation-only — `health` arithmetic is unchanged, and
   `rollup-spec.md` §4 records why.
4. ~~**Vercel deploy**~~ — done. See `docs/deploy.md`.
8. **Migration tracking.** Nothing records which migrations have been applied to
   which database. Survivable with one database, guesswork with two — close it
   before standing up staging (pilot-feedback N1b).
9. **SMTP.** Blocks emailed invite links and self-service password reset. Needs
   an IT answer on whether a third-party sender is acceptable, not just code.
5. **General Sans is not in the repo.** `DESIGN.md` specifies it for headings;
   Fontshare is unreachable from the build environment, so headings currently
   fall back to Geist (which IS self-hosted, per spec, for body/UI/data). One
   file drop finishes it — see the Typography section of `DESIGN.md`.
6. ~~**Rotate the admin's temporary password.**~~ — enforced rather than
   remembered: every existing account now carries `must_change_password`, so the
   transcript-exposed password stops working the moment it is used once.
10. ~~**N21 is not verified in production.**~~ — **verified 2026-08-05 by the
   owner. Zero cold starts.** Vercel Observability, *Function Invocations Count*
   grouped by **Function Start Type**, Environment = Production, over a live
   single-user session:

   | Start type | Count |
   |---|---|
   | `hot` | 12 |
   | `prewarmed` | 2 |
   | `cold` | **no row — zero** |

   The churn this arc was chasing — 12 instances for one user, four of them
   serving a single request and never reused — **does not reproduce**. Instances
   are being reused, and the two `prewarmed` ones were ready before the request
   arrived, so nobody waited on them.

   **What this does and does not establish.** It establishes the outcome: a
   normal session now pays no cold-start cost. It does **not** establish that
   removing prefetching is *why* — Fluid Compute's prewarming may be doing some
   or all of the work, and the two are not separable from this measurement.
   Given three mechanisms already proposed and disproved in this arc, the
   outcome is recorded and the cause is not claimed.

   Two dead ends on the way, kept so they are not repeated: the dashboard's
   log export **omits `instanceId`**, so the originally-specified method cannot
   work; and `Function Invocations Count` grouped by *HTTP Status* measures
   volume, not instances. `Function Start Type` is the dimension that answers
   it — there is no instance dimension at all.
11. **One unpinned e2e flake — and it is NOT closed.** Two clean 176/176 runs on
   2026-08-05, then, on the escalation branch and with no code change between
   them, one run reported **4 failures** and the next **1**. The single failure
   was a real deterministic bug in a new check (a substring match — CE `4.4.3`
   is a prefix of control `4.4.3.2`, so `includes()` matched a different
   element's row); that is fixed. **The other three were never captured and
   remain unexplained** — the run was tailed rather than saved, so there is no
   record of which checks they were.
   The lesson is the cheap one: **always save the whole run, never tail it.**

   **Caught on 2026-08-05, saved this time.** A 12-run sequence went 8 clean,
   then run 9 died:

   ```
   page.goto: net::ERR_ABORTED; maybe frame was detached?
     - navigating to "http://127.0.0.1:3000/assess/controls"
   ```

   at the theme-survives-navigation step in group [14]. Two findings, and the
   second matters more than the flake:

   - **The mechanism is still unknown.** It is a main-frame navigation the
     renderer cancelled. This arc has already lost three confidently-argued
     mechanisms, so nothing is claimed beyond what the log says. `gotoStable`
     retries that one navigation **once and prints `↻ … (N21)` when it does**,
     so a retry can never quietly be the reason the suite looks green.
   - **The crash was worse than the flake.** `scripts/e2e.mjs` is top-level
     sequential code, so a throw at any of its 68 `page.goto` calls skipped the
     whole cleanup block: it left `qa.pm1`, `qa.pm2` and `qa.admin` in the
     **real database** — on the allowlist, inside the completion denominator —
     printed no summary and no failing group, and wedged the run loop. Verified
     by finding all three still there 34 minutes later. There is now a
     `teardown()` both paths share and an `uncaughtException` handler that runs
     it, names the failing step and prints a summary. It proved itself
     immediately: the next crash (a dead server) purged all three and reported
     `2 passed, 1 failed` instead of a bare Node stack.

   **Named on 2026-08-05: chromium dies. It is the harness, not the app.**
   The diagnostic added that morning fired on the next crash:

   ```
   ⚠ chromium DISCONNECTED UNEXPECTEDLY at 12:26:35 (N21)
   ✗ SUITE CRASHED — page.goto: Target page, context or browser has been closed
   ```

   The disconnect precedes the navigation failure, so **the browser process
   dying is the cause and the `goto` error is the consequence** — which also
   ties the two crash signatures together (`ERR_ABORTED; maybe frame was
   detached?` is what an in-flight navigation reports when the browser goes;
   `Target … has been closed` is what the next one reports). Nothing here
   implicates the application.

   **Unclaimed, but recorded: both sequences died on run 10.** Three sequences
   so far — one died at run 9, two at run 10 — which is more consistent with
   something accumulating across runs in the container than with chance. It is
   NOT called a cause: three data points and a plausible story is exactly the
   shape this arc has been wrong about three times. The scratchpad loop now
   records free memory, disk and process count before each run, so the next
   occurrence arrives with numbers rather than a hunch.

   **Deliberately not being fixed.** The harness already fails safely: teardown
   runs, the QA accounts are purged from the real database, and the run reports
   which step died. The only casualty is that a 12-run sequence does not finish,
   which costs confidence in the *measurement*, not correctness of the app or
   the suite. Chasing container resource limits is test-infrastructure work, and
   it ranks below N18 and the Results design. Revisit if it starts landing
   before run 9, or if it ever appears in CI.

   Best sequence to date: **9 clean runs at 186 passed, 0 failed**, then a
   browser death.

   **One caveat on "fails safely", from checking rather than assuming.** After
   the 11:55 crash the purges *did* complete — verified directly against the
   database, no `@example.test` rows left — but the final `X passed, Y failed`
   line never printed. So the database guarantee holds; the *reporting*
   guarantee is only partial, and a crashed run can end without a count. Small,
   and worth closing whenever this area is next touched: a run that dies
   silently on the count is the same shape of missing signal that let the
   original flake hide for three rounds.
12. **Separation of duties: one person can assess themselves end to end.**
   A role is a single value and the assessor-side checks never ask whose
   record it is, so one account with `admin` can assign to self, self-score,
   submit, revise and approve — no second party in the trail. The assessee
   direction IS guarded, so the hole is one-way. Owner's position: the two
   capacities must be independent; the wrinkle is that people are identified
   by email, so it cannot be solved by giving someone a second account.
   **Needs `/plan-design-review` on a written proposal before any code** —
   see pilot-feedback N25. Not blocking the pilot (nine people, one assessor),
   but it is the first question an auditor asks of a bank capability record.
7. **CE targets do not re-point by benchmark profile.** Per-control targets do
   (`targetsForProfile`), but CE targets are APM's published values for the
   Intermediate profile, taken from the workbook's Results sheet. Anything other
   than Intermediate needs published CE targets we do not have. Default is
   Intermediate, so this does not bite yet.
