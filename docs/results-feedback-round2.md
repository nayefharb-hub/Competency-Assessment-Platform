# Results screen — owner feedback round 2 (logged + assessed)

Owner feedback after seeing the PR #27 results enhancements (4th tier, area radar,
narratives, dev-plan table) on the preview, plus a prototype of the radar/section
changes. Six items. This doc **logs and assesses** them and records the **skill
route** for each. Nothing here is built yet.

Data-model facts that gate feasibility (from `lib/types.ts`):
- `CompetenceElement` holds **only `name`** — no definition / purpose / description /
  KSA. ICB4 has that text; our extractor never pulled it.
- `Control` holds `indicator` + `description`; `Measure` holds `text`. **Indicator-level
  content exists in the data.**
- `ScaleLevel` holds `knowledge` + `application` prose per 0–5 level.

---

## 1. Area radar — bigger, centered, more vivid edges; values beneath
**Assessment:** Visual only. Prototyped (bigger, centered, thick vivid edge; values in
a row beneath). Owner's hunch confirmed — beneath reads better once the triangle is
large; beside leaves dead space. Cheap.
**Route:** build to prototype → `/design-review`. (No scope question.)

## 2. "CAPABILITY BY COMPETENCE ELEMENT" sectioned by area
**Assessment:** Prototyped — three sections (Perspective / People / Practice), each
sorted by gap within the area. Tradeoff: the framework-wide worst gaps are no longer
all collected at the top; each area's gaps sit under its header. Owner accepts area
grouping. Cheap.
**Route:** build to prototype → `/design-review`.

## 3. Competency name as a header; row = name · metadata · bar · value
**Assessment:** Area name is the section header (done in prototype). Each row leads with
the **competency name** as a header, then metadata, then bar, then `actual / target`.
Interacts with item 5 — the metadata must use **names, not codes**. Cheap once 5 is
decided.
**Route:** build with item 5 → `/design-review`.

## 4. Click a competency → see its control-level scores (dropdown or page)
**Assessment:** New feature. Data supports it (controls per CE, each with a score). UI
options: expandable `<details>` rows (server-friendly, no client JS) or a
`/results/[ce]` detail page. Needs design + a route/interaction decision. Medium.
**Route:** `/office-hours` (scope: inline expand vs page) → `/design-consultation` →
`/plan-design-review` → `/plan-eng-review` → build → `/design-review` + `/qa`.

## 5. The codes ("4.4.10 · weakest 4.4.10.1 …") mean nothing to the reviewer
**Assessment:** Real usability defect. We show codes where humans need **names**. We
already have the CE name (it's the row title) and each control's `indicator` text. Fix:
drop the redundant CE code, and render the weakest/escalating control by its **indicator
text**, not its code (code optional, secondary). Design question: indicator text is long
→ truncate / tooltip / show on expand (ties to item 4). Medium.
**Route:** `/design-consultation` (how much text, where) → build with items 3/4 →
`/design-review`.

## 6. Development-plan suggestions are useless → want reflective, framework-grounded guidance
**Owner:** "Consider prioritising 4.4.10.1 …" only says a control should be higher —
which the results already show, and the code is meaningless. Wants, instead:
- **Competency level** (from the overall CE result): the competency's **Definition,
  purpose, description, and Knowledge / Skills / Abilities**.
- **Indicator level** (per control): its **Description and measures**.
- Framed as a **reflective note / guidelines** the PM reflects on — not a mandate.

**Assessment — this rejects the PR #27 dev-plan table and needs new data.**
- **Indicator-level** content (description + measures) **exists** → buildable now.
- **Competency-level** content (definition / purpose / description / KSA) is **NOT in the
  data** → requires extending the T0 framework extractor + schema + seed to pull it from
  the ICB4 source. This is the big piece: a data-model + extraction change, then a design
  for how the reflective content surfaces (likely inside the item-4 drill-down).
- **Decision it forces on PR #27:** the dev-plan table PR #27 adds is the thing being
  rejected. Either (a) drop the dev-plan table from PR #27 before merge and rebuild as
  reflective guidance, or (b) merge PR #27 as-is and replace the table in a v2. Owner call.
**Route:** `/office-hours` (scope + is the framework-data extension worth it for the
pilot) → `/plan-eng-review` (extractor + schema) → `/design-consultation` →
`/plan-design-review` → build → `/review` + `/design-review` + `/qa`.

---

## Cross-cutting decisions for the owner
1. **PR #27 dev-plan table:** drop before merge (rebuild as reflective guidance), or merge
   and replace later?
2. **Pilot vs product:** items 1–3 and 5 are pilot-worthy and cheap. Items 4 and 6
   (esp. the competency-level framework extension) are larger — pilot or product phase?
3. **Framework-data extension (item 6 competency-level):** worth pulling ICB4
   definition/purpose/KSA into the data now, or defer and ship indicator-level reflection
   only?

## Recommended sequence
Ship the cheap visual set (1, 2, 3, 5) as a first increment behind `/design-review`.
Route 4 and 6 through `/office-hours` together (they converge — the drill-down is where
the reflective content lives), then design + eng plan, then build.
