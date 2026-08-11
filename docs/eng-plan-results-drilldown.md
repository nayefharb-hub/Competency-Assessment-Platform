# Eng plan — results drill-down (workstreams 2 + 3)

Status: DRAFT for `/plan-eng-review`. Grounded against the code on
`claude/icb4-results-report-enhancements-i3fcsh` after Increment 1.

## Where this came from
Increment 1 removed the development-plan table because its auto-suggested
"Consider …" actions were noise (owner). What a PM actually needs when they see
a gap is **what "good" looks like for the control that is short** — reflective,
grounded material, not a mandate. Two backlog items cover it:

- **Item 4 — drill-down:** a competency expands to its controls with scores.
- **Item 6 — reflective guidance:** the original idea was CE-level ICB4
  definition / purpose / KSA text, sourced by "extending the extractor."

## The blocker that reshapes item 6 (surfaced during scoping)
"Extend the extractor" cannot produce CE-level ICB4 narrative, because that text
is **not in any source we hold**:

- `data/seed/extract_workbook.py` reads KIB's control-scoring workbook. Its
  Framework sheet gives each competency only a header row
  (`code name — N controls`) — no definition, purpose, or KSA.
- The source workbook is **not present in this container**
  (`/root/.claude/uploads/…/…xlsx` is gone), so the extractor cannot even be
  re-run here.
- There is **no IPMA ICB4 standard PDF** anywhere in the repo or uploads. The
  CE-level definition/purpose/KSA lives only in the IPMA ICB4 document, which
  is **IPMA copyright** — storing and displaying it is a licensing decision,
  not just an extraction task.

→ **Parked decision (owner-only), not an engineering call:** whether to source
the ICB4 standard and clear IPMA licensing to show CE-level text. Until that is
settled, item 6's *literal* form is blocked. See "Open decisions" D1.

## What IS available, and delivers the same intent
Every control already carries **measures** — the assessment criteria, "what good
looks like." 586 rows, all 133 controls covered, ~5 per control, e.g. for
`4.3.1.1` ("Align with organisational mission and vision"):

> Reflects the mission and vision of the organisation · Aligns the project goals
> with the mission, vision and strategy … · Checks whether the project is
> delivering benefits to the organisation

They are already loaded by the seam: `getFramework()` runs its single query and
exposes `measuresFor(code): Measure[]` (lib/framework.ts:405). So a drill-down
over measures adds **zero per-request network** — it satisfies the hot-path rule
by construction.

**This plan builds the measures-based drill-down (item 4 + item 6's reflective
intent). CE-level ICB4 text stays parked behind D1.**

## The change

### Data (no new queries, no schema change)
- Reuse `getFramework()` on `/results` (already called, `app/results/page.tsx`;
  memoized for the instance). No new columns, no migration, no new fetch.

**The assembly seam — the one load-bearing decision (closes the review's main
finding).** The per-control **target is snapshot-sensitive**: once approved it
comes from `assessment.snapshot_targets`, so a later benchmark change cannot move
a historic gap (rollup-spec §6). That logic already exists, module-private, in
`lib/rollup.ts`: `controlTarget(c, snapshot)` (`:155`) and `scoreMap(assessment)`,
both used inside `rollupCe`. The drill-down MUST reuse them, not re-read live
`control.target_level` — a page-level reimplementation would let an approved
historic drill-down show per-control targets that contradict the frozen CE bar
above it (the exact §6 leak the warning at `rollup.ts:140–153` describes).

- **New (arithmetic, in `rollup.ts`):** export
  `controlBreakdown(fw, assessment, ceCode): ControlScore[]`, where
  `ControlScore = { code, level, target, health, escalated }`. It iterates the CE's
  **active** controls (via `activeControlsOf`), reads the score from `scoreMap`
  and the target from `controlTarget(c, snapshot)` — the same two helpers
  `rollupCe` already uses, so the drill-down and the CE bar can never disagree.
  Worst-first ordering matches `escalated_by`.
- **Presentation (join in the page, not in rollup):** each `ControlScore` is
  joined with `control.indicator` (through the existing `tidyIndicator`) and
  `measuresFor(code)` — both already in memory, **zero** added network. Rollup
  stays arithmetic-only; presentation stays in the page.
- **Score shown as a LABEL, not a bare number** (`labelOf`) — "the PM picks a
  label, never a number" applies to display too; the number stays underneath.

**Round trips (counted, not asserted-in-name-only).** The review found there is
today **no e2e assertion pinning the `/results` GET Supabase count** — so this
work ESTABLISHES that baseline: add an assertion that the approved-`/results` GET
makes exactly N Supabase calls (measure N from the server log first, the way the
commit/nav budgets are pinned), and the drill-down must leave N unchanged. It
does — it reads only already-loaded data — but the number is now guarded, not
assumed.

### UX (server-rendered, no client JS)
- Progressive disclosure with native `<details>/<summary>` per competency row —
  no client component, `/results` stays fully server-rendered (matches the radar
  decision and the perf discipline).
- **Gap competencies (minor/deficit) render open by default**; role-ready and
  above-target render closed (nothing to action, but still inspectable).
- Expanded content, per active control (from `controlBreakdown`),
  weakest/escalating first:
  - indicator (the control name we already show, un-clamped here),
  - its score **label** vs its own target label, with the health mark,
  - its **measures** as a short list — the reflective substance.
- The inactive control (`4.3.2.6`) never appears. **Guarded invariant, not
  incidental:** `4.3.2.6` *does* carry 4 measures in the seed, so `measuresFor`
  would return them; the drill-down stays clean only because `controlBreakdown`
  iterates `activeControlsOf`. Any drift to "all controls" leaks it — the e2e
  asserts its absence.
- Redaction (D2, resolved by review): `/results` is approval-gated
  (`state !== "approved" → NotYet`) and deliberately uses the FULL framework, so
  a PM seeing their own targets post-approval is the point. Measures are already
  PM-visible during self-scoring (`/assess` calls `measuresFor` on the assessee
  framework), so showing them here leaks nothing. The per-control **target is the
  snapshot** (via `controlTarget`), which ties this straight to the §6 boundary.

### DESIGN.md
- New "Capability drill-down" entry + decision-log row (docs in the same diff).
  `<details>` styling: summary is the existing bar row; the panel is indented,
  measures as a tight list at `--fs-sm`, muted. Theme-aware, both modes.

## Tests
- **unit (shown failing first, ground rule 0) — the one that matters:**
  `controlBreakdown` on an APPROVED assessment whose `snapshot_targets` DIFFER
  from the live `control.target_level` must return the **snapshot** target. Build
  the fixture so live and snapshot disagree; a version that reads live fails,
  the snapshot-aware version passes. This is the §6 regression the review
  flagged — without it the "pure selector" test proves nothing.
- **unit:** `controlBreakdown` iterates active controls only (inactive `4.3.2.6`
  absent), worst-shortfall-first ordering, score/target as stored levels.
- **e2e (walked):** open `/results` for an approved assessment; a gap
  competency's drill-down is open and lists its weakest control's measures text;
  a role-ready one is closed; the inactive control is absent.
- **e2e (new baseline):** the approved-`/results` GET makes exactly N Supabase
  calls (N measured from the server log first) — establishing the count the
  round-trip rule needs, which the drill-down must not move.

## Open decisions
Engineering decisions are now closed (the assembly seam is named: `controlBreakdown`
in `rollup.ts`, snapshot-aware via the existing `controlTarget`/`scoreMap`). What
remains is **owner-only** (product taste / sourcing), which a plan is allowed to
carry:
- **D1 (owner):** source + IPMA licensing for CE-level ICB4 text. Until closed,
  item 6's literal form is out; the measures drill-down stands on its own.
- **D3 (owner taste, engineering-trivial):** all competencies expandable, or gaps
  only? `<details open>` is static either way. Recommend: all expandable, gaps
  auto-open.
- **D4 (owner taste, no engineering cost):** measures for a role-ready control —
  show on demand for all (recommend), only gaps auto-open so no default clutter.

Resolved by the architecture review: **D2** (redaction holds — `/results` is
approval-gated + full-framework; per-control target is the snapshot) and **D5**
(native `<details>`, server-rendered open state — no keyboard/AT e2e needed
beyond "open renders the measures").

## Verdict
Architecture review: **plan-ready** once the two fixes above are in the plan
(assembly seam named + snapshot regression test; the round-trip baseline made
real rather than assumed) — both now folded in. No open engineering decisions;
D1/D3/D4 are the owner's.

## Not in scope
- The CE-target rollup, health tiers, radar, area grouping — all shipped.
- Any framework authoring/import engine (still earned by a pilot, not before).
