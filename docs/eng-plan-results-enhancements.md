# Eng plan — results-report enhancements (task #5)

Four owner-approved additions to `/results`, built to the approved decisions
below. This is the `/plan-eng-review` record: it ends with **no unresolved
decisions**. The contract (`rollup-spec.md`, `DESIGN.md`) was changed *before*
this plan's code, per the iron rule at the top of `lib/rollup.ts`.

## What was approved, and by whom

Owner decisions, 2026-08-10, in this session:

1. **Per-dimension narrative lines** — yes. Deterministic templates filled from
   the rollup numbers (no LLM, no invented prose, no runtime network). Granularity:
   **per area (3) + one line per gap competency**.
2. **Development-plan table** — yes, **with** auto-suggested actions seeded from the
   weakest-control / escalation text.
3. **3-axis area radar** — yes. Build: **hand-rolled inline SVG** (not Recharts).
4. **"Above target" 4th health tier** — yes. Threshold: **actual ≥ target + 1.0**
   (a full level clear). Colour: **indigo**.

Two of these reverse locked lines and were recorded as reversals in the same diff:
`rollup-spec.md` §4 (3-tier → 4-tier) and §7 + `DESIGN.md` (no-radar → 3-axis area
radar). `CLAUDE.md`'s Health domain rule and DESIGN.md's decision log are synced in
the same diff.

## Why these, in one line

`/results` shows numbers and bars but not the two things the professional
individual reports (Provek PMA, Comaea) lead on — an interpretive sentence per
dimension and a development table — and it could not recognise strength, only
adequacy and shortfall. These close that gap without adding a pass/fail verdict:
the tool still *supports* a decision, never gates one.

## The engine change (small, and bounded by the type system)

`Health` gains a member; `healthOf` gains one branch; `HEALTH_LABEL` gains one
entry. `Record<Health, string>` makes the compiler force every consumer to handle
the new member, and there is exactly one health-rendering page (`app/results`).

```
Health = "above" | "ready" | "minor" | "deficit"

healthOf(actual, target, severe):
  if actual == null || target == null: null
  if severe: "deficit"                      // escalation outranks every tier
  gap = target - actual
  if gap <= -FULL_LEVEL: "above"            // FULL_LEVEL = 1 - 1e-9
  if gap <= 0: "ready"
  if gap <= HALF_LEVEL: "minor"
  "deficit"
```

- **`FULL_LEVEL = 1 - 1e-9`** mirrors `HALF_LEVEL`: both gap sides are means, so an
  actual exactly one level above target can render a hair under 1.0 and must still
  count as Above. It is a comparison tolerance, never rounding, and does **not**
  touch the exact `gap <= 0` Role Ready floor — same discipline as the existing
  `HALF_LEVEL` comment.
- **No existing `healthOf` test changes meaning.** Every current assertion has
  `actual - target < 1.0`, so all stay in their old tier; the full-level threshold
  is strictly additive. New red-first tests cover the "above" branch and its
  boundary (exact 1.0, just under, just over, escalation-outranks-above).
- **Round-trip budgets are unmoved.** No new fetch, no new query — the tier is
  derived in memory from data already loaded. The e2e budget assertions (warm
  commit 5 / boundary commit 3) do not touch `/results`.

## The presentation (all in `app/results` + `globals.css`)

`app/results/page.tsx` is the only health consumer, and it is fully server-rendered
SVG/CSS with zero client JS. Everything below keeps that property.

1. **4th tier plumbing** — `pill-above` / `.actual.above` / area-tile `var(--above)`
   / a legend row. `HealthPill` and the `Bar` fill are already generic over
   `health`, so they pick up "above" once the label + CSS token exist.
2. **Colour tokens** — `--above` / `--above-bg` in all four `globals.css` blocks
   (light, dark-auto, dark-override, light-override). Indigo `#5B21B6` on `#EDE9FE`
   (light) / `#A78BFA` on `#241A3D` (dark).
3. **Narrative lines** — a new pure module `lib/narrative.ts`:
   - `areaNarrative(area, cesInArea)` → one sentence per area, naming the area's
     largest gap (or reporting all-at-or-above). Rendered as 3 lines under the tiles.
   - `ceNarrative(r)` → one sentence per **gap** competency (minor/deficit), naming
     the driver (escalating control, else weakest control). Rendered in the
     development-plan table's focus column so the per-competency narrative and the
     table are one surface, not two overlapping ones.
   Both are deterministic string assembly over `CeResult` / `AreaResult`; unit-tested
   in `scripts/narrative.test.mjs`.
4. **Development-plan table** — gap competencies (minor/deficit) only, gap-sorted
   (reusing `sortByGap`), columns: Competency (name · code) · Current · Target · Gap ·
   Focus (the `ceNarrative` sentence) · Suggested action. Above-target and Role Ready
   rows are omitted — nothing to action. "Suggested action" is phrased as a
   suggestion ("Consider …"), never a mandate, to hold the no-gating rule.
5. **Area radar** — a server component `app/results/area-radar.tsx`, hand-rolled
   inline SVG: an equilateral triangle over Perspective (top) / People / Practice,
   faint 0–5 grid rings, a dashed ink-muted **target** polygon and an azure
   **actual** polygon with vertex dots, values printed at each vertex, `role="img"`
   with an aria-label summarising the six numbers. Guards the all-null case.

## Tests

- **Unit (red-first for the tier):** new `healthOf`/`rollupCe` cases for "above"
  and its boundary, each shown failing on the pre-change engine before the branch
  is added (ground rule 0). New `scripts/narrative.test.mjs` for the templates.
  Both added to `test:unit`.
- **E2E (`scripts/e2e.mjs` section [7]):** extend the tier-label check to accept
  "Above target"; assert the radar renders (svg with the three area labels), the
  narrative block renders the 3 area lines, and the development-plan table renders
  with its columns. The "no percentage-of-target" check still holds — the radar
  plots 0–5, not percentages. Run as the `/qa` gate against the Vercel preview.

## Gates

`/review` on the diff · `/design-review` against DESIGN.md (new radar + indigo
badge, light and dark) · `/qa` on the preview · then `/ship` (CHANGELOG) and
`/document-generate` into `docs/user-guide.md`. **No `/cso`** — nothing touches
auth, sessions, storage or the allowlist.

## No unresolved decisions

Threshold (full level), colour (indigo), radar build (hand-rolled SVG), narrative
source (deterministic templates) and granularity (area + gap competency), and
table row selection (gaps only) are all settled above. Proceed to build.
