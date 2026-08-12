# PMO department analysis — engineering plan

Source design: `docs/design-pmo-department-analysis.md` (decisions locked in
office-hours, 2026-08-12). This plan turns it into a build with no unresolved
architecture decisions. Route through `/review` + `/qa` before merge; `lib/rollup`
gets the heaviest test coverage.

## Step 0 — scope & reuse (the build is small)

Almost everything exists. The genuinely new code is the **department
aggregation** and **one page**; the per-person view is `/results`, unchanged.

| Sub-problem | Already exists | New |
|---|---|---|
| Per-person rollup (CE/area/control, snapshot-aware) | `rollupAll`, `rollupAreas`, `sortByGap`, `healthOf` | — |
| Capability rollup (radar, drill-down) | `/results` components + `rollupAll` | — |
| Pace panel (how they worked) | `/analysis` `Headline` + `summarise`/`summariseByCe` | — |
| Unified per-person view | both of the above | compose them in `/analysis?a=` staff branch |
| Status board data (everyone + states + scores) | `listAssessments(cycle)` | — |
| Department aggregate (method A + spread + N-below) | — | `departmentRollup()` in `lib/rollup.ts` |
| Approved set **with frozen snapshots** | `assembleAssessment` (single only) | `departmentData()` in `lib/db/assessment.ts` |
| The page | `app/analysis/page.tsx` (extend) | department overview + unified drill |

Files touched: `lib/rollup.ts`, `lib/types.ts`, `lib/db/assessment.ts`,
`app/analysis/page.tsx` (extend: department overview + compose the capability
section into the staff `?a=` drill), `scripts/department.test.mjs` (new),
`scripts/e2e.mjs` (assertions), docs. No new classes/services and no new route —
pure functions + composition into the existing analysis page. Under the
complexity smell; no scope reduction needed.

## The architecture trap this plan exists to avoid

`listAssessments` builds `Assessment` objects **without `snapshot_targets`** —
only `assembleAssessment` (the single-record path, `lib/db/assessment.ts:331`)
fetches `target_snapshot`. Nothing rolls up a list-derived assessment today, so
this has never mattered. The department view is the **first** to roll up the
list path, and `rollupCe` falls back to **live** `control.target_level` when
`snapshot_targets` is absent (`controlTarget`, `lib/rollup.ts:159`). Result if
missed: approved people silently judged against today's targets, not the ones
frozen at their approval — a rollup-spec §6 violation with no crash and no
failing test. **`departmentData` MUST attach each approved assessment's
snapshot**, and a unit test asserts a snapshot target overrides the live one.

## D1 — Route: `/analysis` becomes the analytical hub (owner, 2026-08-12)

Resolved by the owner: this is "the analysis screen", and the per-person drill is
a **unified results + pace** view. So `/analysis` becomes the analytical home
rather than a new `/department` route:

- **`/analysis` (staff, no `?a=`)** → the **department overview**: status board +
  department capability rollup + include/exclude + per-person summary table. This
  REPLACES the current staff pace-picker (`Picker`), which only listed people to
  drill into — the department overview lists the same people plus the aggregate.
- **`/analysis?a=<id>` (staff)** → the **unified per-person view**: capability
  (`/results` rollup, composed) + how they worked (the existing pace panel).
  Today this route shows pace only; it gains the capability section above it.
- **`/analysis` (assessee)** → unchanged in spirit: their own pace (D21), and
  their own capability only if approved. Redaction boundary preserved; the merge
  never widens what a PM sees.

Nav: the existing "Analysis" link is kept (no new link). `/results` stays as the
PM's own results destination from the assess flow; the staff unified view
composes the same rollup, so there is no duplicate logic.

Blast radius (named, accepted): this touches the live `/analysis` staff branch
right before the pilot. Mitigated by composition — the department overview and
the capability section reuse `departmentRollup`, `rollupAll` and the `/results`
components unchanged; the risky part is only the `/analysis` page wiring, covered
by the e2e render + PM-denied + budget assertions.

## D2 — Data layer: `departmentData(cycle)` — 4 Supabase calls, team-size-independent

```
departmentData(cycle) ->
  1. assessment list (cycle)                         [call 1]
     Promise.all:
  2. app_user names .in(assesseeIds)                 [call 2]
  3. score .in(assessmentIds)                        [call 3]   (all, for status board counts)
  4. target_snapshot .in(APPROVED assessmentIds)     [call 4]   (only approved need it)
  -> { everyone: Assessment[],            // status board (all states, no snapshots needed)
       approved: Assessment[] }           // rollup input, WITH snapshot_targets attached
```

This mirrors `listAssessments`'s existing 3-call batch (list + app_user + score)
and adds **one** batched `target_snapshot` fetch for the approved subset. **Total
= 4 calls regardless of team size**, the number pinned and asserted in
`scripts/e2e.mjs` per the round-trip rule (CLAUDE.md). Kept OUT of
`listAssessments`/`completionStats` so the hot completion path adds no call.
`snapshot_targets` is attached the same way `assembleAssessment` does it
(`codeById` map over `target_snapshot` rows).

## D3 — Aggregation: `departmentRollup(fw, approved)` in `lib/rollup.ts`

Method A, uniformly: **the department number at each level is the mean, over
included people, of that person's own rolled-up number.** Pure; no DB.

```
for each person p in approved:  ceById[p] = rollupAll(fw, p)   // snapshot-aware, reused
for each CE:
    actuals = [ceById[p][CE].actual for p if not null]
    dept.actual  = mean(actuals)                       // method A (NOT mean of raw control scores)
    dept.target  = mean(ceById[p][CE].target)          // = common target when profiles shared
    dept.spread  = { min, max } of actuals
    dept.below   = count(p where ceById[p][CE].health in {minor, deficit})   // below their OWN target
    dept.health  = healthOf(dept.actual, dept.target, false)   // escalation NOT applied to a mean
    dept.n       = actuals.length
areas: dept area = mean over people of rollupAreas(ceById[p])[area].actual   // method A at area level
escalation: per control, count people whose ceById[p][*].escalated_by includes it -> top-N with counts
perPerson[p] = { area actuals, strongest CE, weakest CE }
    weakest  = sortByGap(ceById[p])[0]                 // biggest gap first (reused)
    strongest = min gap / best health above target     // new tiny helper `bestOf`, mirror of sortByGap
```

New types in `lib/types.ts`: `DepartmentCeResult` (code, name, area, actual,
target, health, spread{min,max}, below, n), `DepartmentAreaResult`,
`PersonSummary` (assessment_id, name, area actuals, strongest, weakest),
`DepartmentResult` (areas, ces sorted by `sortByGap`, perPerson, escalations,
included_n, assigned_n, excluded_n).

Escalation stays a **per-person** concept reported as a **count** ("2 people
escalate on <control>"), never folded into the department mean's health — a
department average is not a single control.

## D4 — Include / exclude: URL param, no storage

`?exclude=<id>,<id>` (assessment ids). Page filters `approved` before
`departmentRollup`. Ignore ids not in the approved set. All-excluded → empty
state ("no one included — clear the exclusions"). Every number recomputes from
the included set; the denominator line states "averaged over N of M assigned · K
excluded". Toggle links are `<Link>`s that add/remove an id from the param
(server-rendered, no client JS), matching the app's ethos.

## D5 — Tests (ground rule 0: shown RED first, before the impl)

`scripts/department.test.mjs` (node:test, imports `lib/rollup.ts`). Each written
and shown failing against a stub `departmentRollup` before the real one lands:

1. **Method A, and it is NOT method B.** Two people; one is missing a control in
   a CE. Hand-compute the mean-of-per-person-actuals and the mean-of-raw-control
   -scores — they differ — and assert the result equals the former. This is the
   test that proves the methodology.
2. **Snapshot honored.** A person whose `snapshot_targets` sets a control target
   different from the live framework → department target reflects the snapshot.
   Guards the `listAssessments` gap above.
3. **Spread + N-below.** Three people, mixed levels → assert `{min,max}` and the
   below-target count against its own target.
4. **Escalation is a count, not a department deficit.** Two people escalate on a
   control while the department mean sits at/above target → escalation list shows
   count 2, department health is NOT deficit.
5. **Empty / all-excluded.** Zero included → empty result, no throw.
6. **Per-person strongest/weakest** picks the right CEs by gap.

Plus `scripts/e2e.mjs`: `/department` renders for the boss, is **denied to a
PM**, the include/exclude toggle changes the denominator, and the **4-call**
round-trip budget is asserted from the server log (the existing e2e pattern).

## D6 — Access

`requireRole("assessor", "admin")` for the department overview and the staff
unified drill (the `/analysis` staff branch already distinguishes staff from
assessee — the department overview is staff-only, the assessee branch is
untouched). Reads everyone's authoritative scores in aggregate —
the first screen to do so — but that is the Head of PMO's job and no different in
kind from `/review`. No new storage, no auth/session/allowlist change, so no
`/cso` trigger; the role gate is the only door and the e2e denial test is the
proof.

## D7 — Spread on screen

Mean with the range beside it ("**3.1** · 2.0–4.0") and "**3 of 8** below
target", per competency. A range + a count is the actionable part; a
distribution strip is deferred (not worth the pixels at n≈9).

## Build order

1. Types + `departmentRollup` stub + `scripts/department.test.mjs` (RED).
2. Implement `departmentRollup` → tests green.
3. `departmentData` data layer (+ snapshot attach).
4. `/analysis` staff landing → department overview (status board · department
   capability · per-person summary · include/exclude), replacing `Picker`.
5. `/analysis?a=` staff drill → compose the `/results` capability section above
   the existing pace panel (the unified per-person view). Assessee branch and
   redaction unchanged.
6. e2e assertions (department overview renders for boss, PM-denied, toggle
   changes denominator, unified drill shows both sections, 4-call budget).
7. `/review` + `/qa` (preview) + `/design-review` (built UI vs DESIGN.md), then `/ship`.

## Timing

Build now (reusable, on the wedge). It is **empty until the first approvals**
(weeks out). Validate the numbers against the first 2-3 real approvals before
trusting them — method A at small n is only checkable against real data.

## GSTACK REVIEW REPORT

Runs: architecture self-review (Claude), grounded in `lib/rollup.ts`,
`lib/db/assessment.ts`, `app/analysis`, `app/results`.

| Area | Status | Finding |
|---|---|---|
| Architecture | ✓ | Reuses the rollup engine + `/results`; new surface is one page + pure aggregation. Method A stated uniformly at every level. |
| Correctness | ⚠→resolved | `listAssessments` omits `snapshot_targets`; department rollup would use live targets. Resolved: `departmentData` attaches snapshots; test #2 guards it. |
| Round trips | ✓ | 4 calls, team-size-independent; asserted in e2e per CLAUDE.md. |
| Tests | ✓ | Method-A-not-B test shown RED first (ground rule 0); snapshot, spread, escalation, empty covered. |
| Security | ✓ | `requireRole` gate; PM-denied e2e; no new storage. |
| Scope | ✓ | Extends `/analysis` + `lib/rollup` + one data-layer fn; no new route, no new services; under the complexity smell. |
| IA | ✓ | Owner resolved: `/analysis` is the analytical hub; per-person drill is a unified capability + pace view, composed from existing engines. |

VERDICT: plan is buildable as written.

NO UNRESOLVED DECISIONS
