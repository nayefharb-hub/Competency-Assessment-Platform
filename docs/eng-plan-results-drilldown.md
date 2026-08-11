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
- Reuse `getFramework()` on `/results` (already called). For each competency,
  its active controls come from `fw.data.controls`; each control's score from
  the assessment (`assessor_level`), its target from the snapshot, its measures
  from `measuresFor(control.code)`, its name from `control.indicator`
  (run through the existing `tidyIndicator`).
- No new columns, no migration, no new fetch. The round-trip count for the
  `/results` GET is **unchanged** — asserted in e2e.

### UX (server-rendered, no client JS)
- Progressive disclosure with native `<details>/<summary>` per competency row —
  no client component, `/results` stays fully server-rendered (matches the radar
  decision and the perf discipline).
- **Gap competencies (minor/deficit) render open by default**; role-ready and
  above-target render closed (nothing to action, but still inspectable).
- Expanded content, per active control, weakest/escalating first:
  - indicator (the control name we already show, un-clamped here),
  - score vs its own target with the health mark,
  - its **measures** as a short list — the reflective substance.
- The inactive control (`4.3.2.6`) never appears (rollup rule holds).
- Targets: the PM sees this only post-approval, where targets are already
  visible; the assessor view is full. No new redaction surface — but confirm
  `getAssesseeFramework` redaction still holds for any pre-approval path (D2).

### DESIGN.md
- New "Capability drill-down" entry + decision-log row (docs in the same diff).
  `<details>` styling: summary is the existing bar row; the panel is indented,
  measures as a tight list at `--fs-sm`, muted. Theme-aware, both modes.

## Tests
- **e2e (walked, shown failing first):** open `/results` for an approved
  assessment; a gap competency's drill-down is open and lists its weakest
  control's measures text; a role-ready one is closed; the inactive control is
  absent; the `/results` GET round-trip count is unchanged.
- **unit:** any pure selector that assembles (control → indicator, score,
  target, measures) for a competency — deterministic, node-testable.

## Open decisions for `/plan-eng-review`
- **D1 (owner):** source + IPMA licensing for CE-level ICB4 text. Until closed,
  item 6's literal form is out; the measures drill-down stands on its own.
- **D2:** confirm no path shows measures/targets to a PM pre-approval
  (redaction boundary in the data layer, not JSX).
- **D3:** all competencies expandable, or gaps only? (Recommend: all
  expandable, gaps auto-open.)
- **D4:** measures for a role-ready control — show, or only for gaps? (Recommend:
  show on demand for all; only gaps auto-open, so no clutter by default.)
- **D5:** does `<details>` interaction need any e2e beyond "open renders the
  measures" — e.g. keyboard/AT? (Native element, so likely no, but confirm
  against the a11y bar.)

## Not in scope
- The CE-target rollup, health tiers, radar, area grouping — all shipped.
- Any framework authoring/import engine (still earned by a pilot, not before).
