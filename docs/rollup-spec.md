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
| CE `target` | `Results` sheet | APM published value — **never computed** |

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

### 3. Targets are not rolled up
CE targets are APM's published values, taken from the `Results` sheet — never
averaged from control targets (an earlier attempt to derive them that way was
circular and was dropped). Where a CE spans two APM competences with different
values, the CE row shows the **dominant** value.

### 4. Health status (3-tier)
Let `gap = target(CE) - actual(CE)`.

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

### 7. Presentation rules
- Numbers on results charts use the **0–5 scale — never percentages**. Converting a
  6-point label scale to a percentage implies equal intervals that don't exist.
- The scoring interface uses **labels**; results charts show numbers.
- **No radar chart** — a gap-sorted bar list answers "where are the gaps" better
  than 28 axes.
- Target provenance (APM-published vs KIB-derived) is **not** shown in results; it
  lives on the framework data only.
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
