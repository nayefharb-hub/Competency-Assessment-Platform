# Rollup Specification — ported from the KIB ICB4 workbook

The authority for these rules is `KIB_PM_Competency_Framework_ICB4_v1_1.xlsx`
(sheets `Results`, `Scale`, `Framework`) and Handover Brief v2 §7–8. This file is
the implementation contract: the app must reproduce these numbers exactly.

## Inputs

| Input | Source | Notes |
|---|---|---|
| `assessor_level` per control | the assessment | authoritative score; shows in results |
| `self_level` per control | the assessment | kept as record, not used in the rollup |
| `active` per control | framework seed | **inactive controls contribute nothing** |
| control `target_level` | framework seed | 0–5, inherited from the APM benchmark profile |
| CE `target` | **computed** | mean of its ACTIVE controls' `target_level` (see §3) |

## Rules

### 1. Actual score per competence element
```
actual(CE) = mean( assessor_level of every ACTIVE control in that CE )
```
- Inactive controls are excluded **regardless of whether a score exists**.
- No weighting. (Weighting is deliberately parked — 112 of 132 controls sit at
  High, so priority cannot discriminate yet.)
- If no active control in the CE has a score, `actual` is undefined — render "—",
  never 0.

### 2. Weakest control
Alongside the mean, show the CE's **lowest-scoring active control** (code + level).
The mean is a fair headline; the minimum stops one serious weakness disappearing
into an average. Ties: pick the lowest control code.

### 3. CE target is the mean of its active control targets

```
target(CE) = mean(target_level over ACTIVE controls that have a target)
```

Rounded for display only (§7); never rounded before the gap is computed.

**CHANGED 2026-08-08, owner's decision, for the pilot.** This section previously
read *"Targets are not rolled up — CE targets are APM's published values, never
averaged from control targets (an earlier attempt to derive them that way was
circular and was dropped)."*

**Why the circularity objection no longer applies — measured, not assumed.** It
was true of the workbook, where control targets were filled down from the CE
target, so averaging them back up returned the number you started with. It is not
true of this data model. Control targets come from `benchmark_target` keyed by
`apm_competence` (101 controls, `target_source = 'APM (published)'`) or from
KIB's priority rule (31, `'Derived (priority rule)'`). **Neither reads the CE
target.** The proof: **123 of 133** controls happen to equal their CE target — if
they were derived from it, that number would be 133. The ten that differ are what
independence looks like.

**Why it changed.** The two numbers were seeded from separate sources and drifted:
4 of 28 competencies gave **Minor Gap to a PM who hit every single control
target**. A person can do exactly what was asked of them on every control in a
competency and be told they fall short of it — an artefact of averaging a
fractional actual against an unrelated integer, decided by nobody.

**What is given up, stated plainly.** A scoping decision can now move the
competency bar: lower one control because a KIB PM lacks the authority and the
competency's target follows it down. The claim *"measured against APM's published
bar"* is therefore no longer strictly true at competency level. That is accepted
for the pilot, whose baseline is KIB's own by design (`docs/design-framework-
profiles.md` §9). **Use `active`, not a low target, for a control that is not the
role's job at all** — an inactive control leaves the rollup entirely rather than
sitting in the mean dragging it down. That distinction is what keeps the mean
honest.

`competence_element.target_level` is **retained but no longer read by the rollup**.
It stays as the APM published reference, so the anchor is recoverable if this
decision is ever revisited.

### 4. Health status (3-tier)
Let `gap = target(CE) - actual(CE)`. **Both sides are fractional** since §3 —
the actual has always been a mean, and the target is now one too. Compare before
rounding; rounding first would move a boundary case across a tier.

| Status | Condition |
|---|---|
| **Role Ready** | `actual >= target` |
| **Minor Gap** | `0 < gap <= 0.5` |
| **Capability Deficit** | `gap > 0.5` **OR** any single active control scores **2+ levels below its own target** |

The single-control escalation is deliberate: one severe gap makes the CE a
deficit even when the mean looks acceptable.

**Escalation must be explained where it changed the verdict.** "Even when the
mean looks acceptable" is the whole point of the rule, and it is also what makes
it read as a bug on screen — a CE showing `3.0 / 3` beside a Capability Deficit
badge looks like the page contradicting itself, and the reader has no way to
reach the control responsible. So the engine records **which** controls escalated
(`escalated_by`) and **whether escalation alone produced the verdict**
(`escalation_drove_health`), and the results row names the offending control.

Two constraints on that, both load-bearing:
- Explain **only** when escalation changed the outcome. Where the mean is also
  more than half a level short the badge needs no defence, and explaining it
  anyway trains people to skim the line in the case that matters.
- This is **presentation, not arithmetic**. `health` is unchanged, and both new
  fields are derived by asking `healthOf` the same question twice — once with
  escalation and once without — so the thresholds above stay defined in exactly
  one place.

This does not soften the verdict. Per §7 the tool supports a decision and never
gates one; naming the control makes the deficit *actionable* rather than
arguable.

### 5. Area rollup
Area (Perspective / People / Practice) shows the mean of its CEs' actuals against
the mean of its CEs' targets, for the three summary tiles only. Areas have no
health status of their own — status lives at CE level.

### 6. Snapshot on approval
When an assessment is approved, freeze the per-control target levels into
`target_snapshot`. Historic gaps must not shift retrospectively if the benchmark
profile is later changed.

**The CE target needs no snapshot of its own, and this is a consequence worth
noticing.** Since §3 it is computed from the control targets, and those are
already frozen here — so an approved assessment's competency targets are
automatically historical, by construction rather than by a second mechanism that
could drift from the first. Compute it from the SNAPSHOT for approved
assessments, never from the live framework.

**One limit on "by construction", stated rather than implied.** The snapshot
freezes each control's `target_level`; it does not freeze `active`. So
deactivating a control after an assessment is approved moves that assessment's
CE target — and has always moved its `actual` the same way. This is pre-existing
and unchanged, not a consequence of §3, and it is out of scope for the pilot:
the fix is to snapshot the active flag alongside the target, which is a schema
change and deserves its own review.

### 7. Presentation rules
- Numbers on results charts use the **0–5 scale — never percentages**. Converting a
  6-point label scale to a percentage implies equal intervals that don't exist.
- The scoring interface uses **labels**; results charts show numbers.
- **No radar chart** — a gap-sorted bar list answers "where are the gaps" better
  than 28 axes.
- Target provenance (APM-published vs KIB-derived) is **not** shown in results; it
  lives on the framework data only.
- **CE targets display to one decimal** (`2.6`), because since §3 they are means
  and a whole number would imply a precision the figure does not have. The actual
  has always been shown this way; the two now match. Display only — the gap is
  computed on the unrounded value.
- The tool **supports a decision, never gates one** — no pass/fail verdicts.

## Verified extraction facts (T0)

Reconciled against Handover Brief v2 — all independently confirmed:

| Fact | Value |
|---|---|
| Controls | **133** total · **132 active** · **1 inactive** |
| Competence elements | **28** (Perspective 5 · People 10 · Practice 13) |
| Controls per area | Perspective 24 · People 49 · Practice 60 |
| Inactive control | **4.3.2.6** — align with HR processes (HR owns this at KIB) |
| Priority (active) | High **112** · Medium **17** · Low **3** |
| Target provenance | APM published **101** · derived from priority **31** |
| Measures | **586** rows, all referencing known controls |
| Scale | APM 0–5: Unaware · Aware · Practised · Competent · Proficient · Expert |
| Benchmark profiles | 29 APM competences × Entry/Intermediate/Advanced/Master |

**Gotchas found during extraction (documented so they aren't re-discovered):**
1. Each CE header row declares its count of **active** controls, not total rows —
   4.3.2 reads "6 controls" for 7 rows because 4.3.2.6 is inactive.
2. `Framework` column **N** holds the numeric target (0–5); column **O** holds its
   label. They are easy to transpose.
3. Empty `Reason` / `Notes` cells contain the literal string `"None"`, not a blank.

## Seed artifacts

`data/seed/` — produced and verified by the T0 extractor:
- `icb4-framework.json` — the complete bundle (scale, areas, CEs, controls, measures, benchmarks, CE targets)
- `controls.csv`, `measures.csv` — flat views for inspection
- `EXTRACTION-REPORT.txt` — the verification run
- `extract_workbook.py` — the extractor (re-runnable if the workbook changes)
