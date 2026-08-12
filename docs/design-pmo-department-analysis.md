# PMO department analysis — design

Status: **shaped** (office-hours, owner, 2026-08-12). Decisions below are locked.
Next gate: `/plan-eng-review` (architecture) and `/design-consultation` (visual)
before any build. Source design doc; change this before the code.

## Problem

The Head of PMO can see one PM's result at a time (`/results`), and the cycle
overview (`/review`) shows completion, not capability. There is no view that
answers the question a Head of PMO actually asks at cycle end: **"where is my
department collectively strong and weak against ICB4, and who is my resource
vs. who needs development, per area?"**

This is on the wedge, not off it — the wedge is "collecting, reconciling,
**rolling up**", and this is the top of the rollup. It serves both horizons:
for the pilot it is the artifact that shows the Head of Strategy the tool's
value; for the product, "team capability against a framework" is core
buyer-facing value a subscription sells.

## Locked decisions (office-hours, 2026-08-12)

1. **Rollup method = average of each person's rollup ("method A").** The
   department number at every level (control, competency, area) is the mean,
   over the included people, of *that person's own rolled-up number* — each PM
   judged against their **own snapshot targets**. NOT the roll-up of
   team-averaged control scores ("method B"). Method A is what "the average of
   my individuals" means, and it is the only method that survives the product
   case where people sit on **different role profiles with different targets**.
   Method B silently assumes one shared profile. (Getting this wrong is the
   CE-target drift of 2026-08 in a new place — see `docs/rollup-spec.md` §3.)

2. **Show distribution, not a bare mean.** At n≈9 an average hides whether a
   competency is everyone-similar or experts-carrying-novices. Every competency
   shows **mean + spread + count below target** ("3 of 8 below target"). This is
   the single most useful analytical addition and it is cheap.

3. **Approved assessments only feed the rollup.** The result uses
   `assessor_level` (authoritative), which exists only after approval. The
   status board shows everyone; the department result states its denominator
   ("averaged over 6 of 9 assigned"). Mixing un-reviewed self-scores would
   corrupt the authoritative number.

4. **Landing + drill.** Landing = status board + department rollup +
   include/exclude + per-person summary table. Click a person → their existing
   `/results` detail. Single-screen would cram 9 people × 3 areas × 28
   competencies.

## Design principle (non-negotiable)

The tool **supports a decision, never gates one** — no rankings of "performers",
no pass/fail. Strongest/weakest is framed as **"where each person is a resource
for the team vs. where development would help."** Same as the rest of the app.

## The screen

### Landing — `/department` (working name; final route TBD in eng plan)

Head-of-PMO / admin + assessor only (`requireRole`).

1. **Status board.** Every assigned PM and their state, in the owner's three
   buckets: **not started** (assigned, nothing scored) · **in progress** (draft
   with scores) · **completed** (submitted) — with **approved** marked as the
   sub-state that makes them count in the rollup. Reuses `listAssessments` /
   `completionStats`. States map from the existing machine: draft→(not started
   or in progress by score count), self_submitted→completed, approved→approved.

2. **Department capability.** Method A over the included (approved) set:
   - **Area radar + tiles** — department area actual vs target (mean over
     included people of each person's area number). Reuses the `/results` radar.
   - **Competency table** — every CE: department mean, **spread** (min–max
     across people), **N below target**, health tier. Sorted by gap (biggest
     department gap first), reusing `sortByGap`.
   - **Escalation is a per-person concept** and is NOT applied to the department
     mean. Where it matters, report it as a **count**: "2 people escalate on
     <control>". Department health uses the ordinary mean-vs-target tiers.
   - Denominator stated on screen: "averaged over N of M assigned · K excluded".

3. **Include / exclude.** Default = all approved included. Per-person toggle to
   exclude (a leaver, a new joiner who skews the mean, or the Head of PMO's own
   self-assessment). **Stateless via URL param** (`?exclude=<id>,<id>`) — no new
   storage, shareable, consistent with the server-rendered ethos. Every number
   on the page recomputes from the included set.

4. **Per-person summary table.** One row per approved PM: their three **area
   scores**, their **strongest** competency (best clear of its own target) and
   **weakest** (biggest gap / any escalation), framed as resource vs.
   development. Row links to that person's `/results`.

### Drill — reuse `/results?a=<assessmentId>`

The per-person area/competency/control view already exists (radar, area headers,
control drill-down). "Click a person" opens it. No new per-person screen.

## What is actually new (build is small; risk is concentrated)

- **`lib/rollup.ts` — department aggregation** (method A + spread + N-below).
  This is the one place that needs the most test coverage; it is where the
  methodology lives and where a mistake reproduces the CE-target defect.
- **Data layer** — `approvedAssessments(cycle)` (list + full scores for the
  approved set). `listAssessments` already batches people + scores; extend or
  reuse.
- **The `/department` page** — status board, department sections, include/exclude
  param, per-person summary. Server-rendered, `force-dynamic`, no client JS
  beyond what `/results` already uses.

Reused unchanged: `rollupAll`, `rollupAreas`, `sortByGap`, `healthOf`,
`HEALTH_LABEL`, the radar, the area-header styling, `/results` for the drill.

## Access & security

`requireRole("admin", "assessor")`. Reads authoritative scores across all
people — appropriate for the Head of PMO, and no different in kind from
`/review`, which already lists everyone. No new storage, no auth/session/
allowlist change, so not itself a `/cso` trigger — but the eng plan should note
that this is the first screen to read *everyone's* authoritative scores in
aggregate, and confirm the role gate is the only door.

## Timing / validation

The screen is **empty until approvals exist** (pilot invites Monday; first
approvals weeks later). Build the method and views now (designed, reviewed,
reusable), but **validate the numbers against the first 2–3 real approvals**
before trusting them — method A at small n can only be sanity-checked against
real data. Do not ship it to a department of zero and assume it is right.

## Open for the eng plan

- Final route name (`/department` vs `/analysis/team`; note `/analysis` already
  hosts pace).
- Exact `approvedAssessments` data-layer shape and round-trip count (the app
  counts round trips — see CLAUDE.md).
- Spread representation: min–max range vs a small distribution strip.
- Whether the per-person summary's "strongest/weakest" reuses `sortByGap` or
  needs an "above-target" sort for strength.
- Test plan: unit tests for method A (including the small-n and missing-score
  cases) shown failing first, per ground rule 0.
