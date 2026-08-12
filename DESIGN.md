# Design System — Competency Assessment Platform

Locked by `/design-consultation` on 2026-08-03. Read this before any visual or UI
decision; do not deviate without explicit approval.

## Product Context
- **What this is:** an internal web tool for KIB's PMO to assess project managers
  against the IPMA ICB4 framework — PMs self-assess, the Head of PMO reviews and
  approves, and a dashboard shows capability vs targets.
- **Who it's for:** KIB project managers (assessees) and the Head of PMO
  (assessor + admin). Eventual goal: a sellable product for other organizations.
- **Space/industry:** enterprise / internal competency assessment, Sharia-compliant bank.
- **Project type:** data-heavy web app (assessment forms + results dashboard + admin editor).

## Aesthetic Direction
- **Direction:** Quiet enterprise — modern-professional, data-first. Confidence
  through clarity and hierarchy, not decoration.
- **Decoration level:** minimal-to-intentional (hairline borders, soft elevation; no gradients, no blobs).
- **Mood / memorable thing:** *a serious, trustworthy tool that feels current — it
  makes a dense 132-control assessment feel calm and legible.* KIB navy is the trust
  anchor; a cleaner azure keeps it from feeling dated.

## Typography
- **Display / headings:** General Sans (SemiBold) — confident, modern titles.
- **Body / UI:** Geist — clean, neutral, legible at small sizes.
- **Data / tables:** Geist with `font-variant-numeric: tabular-nums` — aligned scores.
- **Not Calibri:** KIB's Office font stays for exported Office documents only, not the web UI.
- **Loading:** self-host woff2 (Fontshare General Sans, Geist) — no runtime CDN.
- **Implementation status:** Geist ships self-hosted via `next/font` (the `geist`
  package) and drives body, UI and data. **General Sans is not in the repo yet** —
  Fontshare is unreachable from the build environment, so headings fall back to
  Geist. To finish: drop `GeneralSans-Semibold.woff2` into `app/fonts/`, load it
  with `next/font/local` exposing `--font-general-sans`; `--font-display` in
  `globals.css` already picks it up, no other change needed.
- **Scale (amended 2026-08-07, N47 — owner approved):** expressed in `rem` from a
  root of `100%`, so it follows the reader's own browser font size rather than
  overriding it, and steps to `106.25%` above 1600px. One knob, `html`.

  | Role | Token | ≤1600px | ≥1600px |
  |---|---|---|---|
  | display | `--fs-display` | 28 | 29.75 |
  | h2 | `--fs-h2` | 20 | 21.25 |
  | h3 | `--fs-h3` | 17 | 18 |
  | **prose and every input** | `--fs-prose` | **16** | **17** |
  | scanned rows, table cells | `--fs-ui` | 15 | 16 |
  | secondary, glosses, helper | `--fs-sm` | 14 | 15 |
  | uppercase label, pills | `--fs-label` | 12 | 12.75 |

  **Why it moved.** The old scale was fixed `px` and did not respond to viewport
  at all: 2560×1440, 1440×900 and 390×844 rendered identically. Legibility is
  *angular* — size over viewing distance — so 13.5px measured 19.7 arcminutes on
  a laptop at ~50cm and only **15.5′** on a 27" at ~70cm, against a 20–22′
  comfort target. The laptop case set the size and the 27" inherited it.

  **16px is a hard floor on inputs, not a preference.** iOS Safari zooms the page
  when a field under 16px takes focus. At 14px a PM tapping the evidence box on
  an iPhone got the page jumping on each of 132 controls.
- **Line height:** prose 1.6 · UI and dense data 1.5 · headings 1.25. Prose means
  anything read in sentences — ICB4 indicator descriptions, measures, notes,
  banners. UI means labels, table cells, pills, buttons.

## Color
- **Approach:** balanced — navy brand + azure interactive + reserved status colors.
- **Primary (KIB navy):** `#1F4E78` — brand, headers, primary buttons (hover `#163A5A`).
- **Accent (azure):** `#2E6BE6` — links, focus rings, active/selected.
- **Ink:** `#16202E` · **Muted:** `#5B6675`.
- **Neutrals:** canvas `#F4F6F9` · surface `#FFFFFF` · surface-2 `#F9FAFC` · border `#E3E8EF`.
- **Semantic — health tiers (reserved; always shipped with a label, never color-alone):**
  - Above target `#5B21B6` on `#EDE9FE`
  - Role Ready `#15803D` on `#E7F6EC`
  - Minor Gap `#B45309` on `#FBEED6`
  - Capability Deficit `#B91C1C` on `#FBE7E7`
  - (Role Ready / Minor Gap / Deficit deliberately echo the workbook's green/amber
    legend for continuity. **Above target** — a full level clear of target,
    rollup-spec §4 — is indigo: a distinct hue that reads as beyond-target while
    staying clearly apart from the Role Ready green and the azure interactive color.)
- **Target mark:** ink at 62% opacity.
- **Dark mode (designed, not inverted):** bg `#0E1621` · surface `#14202E` · border
  `#26374C` · ink `#E8EEF5` · muted `#9DACBF` · navy surfaces deepen to `#12283F` ·
  accent lightens to `#5B93F5` · status lightened/desaturated (above `#A78BFA` on
  `#241A3D`, ready `#4ADE80`, minor `#FBBF24`, deficit `#F87171`). Theme via
  `prefers-color-scheme` + a
  `data-theme` override on `:root` in both directions.

## Spacing
- **Base unit:** 4px. **Density:** comfortable (data-dense but breathable).
- **Scale:** 4 · 8 · 12 · 16 · 24 · 32 · 48.

## Layout
- **Approach:** grid-disciplined app shell — navy sidebar/top bar + content area.
- **Container max-width:** three cases, and they are not interchangeable —
  **reading pages 780px** (one control at a time: self-assessment, admin editor)
  · **app shell 1080px** (lists, review, results) · **full-width** for the
  dashboard. A reading page in a 1080px container strands its prose in the left
  half while its controls span the full width.
- **Exception — a reading page with an interactive panel beside it.** Such a page
  may use a wider container (up to 1000px), because its second column is not
  prose: it is a control group. The cap that matters is `--measure` on the
  sentences, not the container on the page — prose never widens to fill the extra
  space, which is spent putting the controls *beside* the text rather than below
  it. This is the same container/measure distinction as above, applied the other
  way round; it is not a licence to stretch paragraphs.
  - Below the two-column breakpoint the page returns to the 780px reading width
    and only the action bar stays pinned, so the guarantee — the answer and the
    primary action never leave the screen — holds at every width.
- **Reading measure:** **60–70 characters** on any block read in sentences.
  This is NOT the same as container width, and conflating the two is what
  produced 131-character lines in the first build — a container is how wide the
  page may get, a measure is how wide a *sentence* may get.
  - Implemented as `--measure: 44ch` (was `52ch` until 2026-08-07). The CSS `ch`
    unit is the width of the "0" glyph, and Geist's digits run wider than its
    average letter, so `ch` **understates** the character count.
  - **The 52ch figure was wrong and said so for months.** This file claimed
    "52ch lands at 68". Measured on the running build with `getComputedStyle`,
    52ch rendered **79** characters in `.ro p` and 72 in `.measures li` — both
    *above* the 60–70 band, not below it. `docs/STATUS.md` had recorded 72–73 the
    whole time and the two were never reconciled. 44ch measures ~66.
  - **Re-derive by MEASURING, never by reasoning about `ch`.** Both previous
    values were arrived at by arithmetic and both were wrong; counting the
    characters that actually render is the only thing that has ever settled it.
- **Border radius:** inputs/buttons 6px · cards 10px · pills 999px.
- **Touch targets: 44px minimum below 1100px.** Anything a finger commits with —
  the pinned action bar, the milestone's Continue and Take a break, the recap
  rows. Above 1100px a pointer is doing the work and the padding scale governs
  instead; WCAG 2.5.8's 24px floor is the hard minimum there, not the goal.
  This was an unwritten rule enforced twice in CSS comments before it was ever
  stated here, which is how the action bar ended up at 41px while the recap rows
  beside it were at 44px.

## Motion
- **Approach:** minimal-functional. 150ms transitions on hover/focus/state; no
  choreography. Honor `prefers-reduced-motion`.

## Product-specific components
- **Level picker:** a **vertical option list** (radio rows) — one APM level per row,
  **Unaware → Aware → Practised → Competent → Proficient → Expert** — each with a
  plain-language gloss, APM canonical wording reachable. **No "N/A" option.** The
  **target is hidden** while the PM self-scores.
- **Bar-on-bar mark (signature):** neutral 0–5 track, an ink **target tick**, and an
  **actual** bar filled by health tier; rounded ends, 2px surface ring, tabular-nums
  values. **Numbers, not percentages.**
- **Area radar (3 axes):** a hand-drawn inline-SVG triangle over People · Practice ·
  Perspective, actual (azure/accent fill+stroke, figures in **blue**) against a
  dashed **green** target polygon (figures in **green**),
  faint 0–5 grid rings, the **area name at each vertex** and the **actual/target
  figures read beneath the chart**. It is the centrepiece of the results screen —
  large and centred in its panel, not a side-panel thumbnail. Server-rendered, no
  charting dependency, themed through the same tokens as everything else. **A
  28-competency radar is still excluded** (an unreadable hairball, per the decision
  log); three axes are legible and give the summary a shape at a glance (rollup-spec §7).
- **Capability list (results):** grouped into the three areas, each a section under
  a **navy header bar** (white area name + actual/target); within a section, most
  serious first.
  Each competency row leads with its **name**, and any control it references (the
  weakest, or the control that escalated a deficit) is named by its **ICB4 indicator
  text**, never by an opaque code like `4.4.10.1`.
- **Capability drill-down (results, Phase 1):** each competency row expands
  (native `<details>`, so the screen stays server-rendered) to its **active**
  controls — indicator + a compact score bar + score/target label, weakest first.
  **Collapsed by default** (every competency, even gaps) — the summary rows are
  the scannable report; a PM opens one to see its controls. Colour is
  **exceptions-only**: on/above-target control
  bars are neutral (ink at low opacity), colour and a state dot appear **only** on
  controls below their own target — the eye lands on what needs work. No
  per-control health pill (the competency row owns the verdict). Measures and the
  full control text are **Phase 2** (a control page), not shown here.
- **Status pills:** dot + label, health-tier colored.
- **Read-only source block:** ICB4 indicator text + measures shown for context; the
  editable **KIB clarification** field sits alongside; ICB4 source text is locked.
- **Assessment nav:** "back to controls" + position (control N of 132).

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-08-03 | Initial design system created | `/design-consultation` — KIB navy anchor + modern clean |
| 2026-08-03 | Level 0 label is "Unaware" — no "N/A" option | Use the real APM level-0 label (user decision) |
| 2026-08-03 | Fonts General Sans + Geist, not Calibri | Modern web product; Calibri kept for Office exports only |
| 2026-08-03 | Bar-on-bar as the results mark, no radar | Legibility over 28-axis radar (per handover brief §8) |
| 2026-08-03 | Reading measure split from container width; `68ch` cap | Measured 131 chars/line against a comfortable 45–75. "~1080px for reading" was read as a measure and stretched sentences to fill the card. The system's own aim — "makes a dense 132-control assessment feel calm and legible" — was being defeated by its own layout line |
| 2026-08-03 | Line height added to the scale (prose 1.6 / UI 1.5 / headings 1.25) | The scale specified size and weight but no leading, so 1.5 was inherited everywhere including long prose |
| 2026-08-04 | Selection colour becomes a token (`--selected`), not a pair of dark-mode overrides | Navy on a dark surface is nearly the surface itself. Two component-level `prefers-color-scheme` blocks existed only to swap navy→azure; as a token it is one line and the theme override needs no third copy |
| 2026-08-04 | Theme is Light / Dark / **Auto**, stored in a cookie, always stamped on `<html>` | Per-device rather than per-user: it has to work on /login where there is no user, and the same person wants different answers on a phone at night and a desktop at work. Always stamping `data-theme` (including `"system"`) avoids asking React to REMOVE an attribute from `<html>` after a server action, which it does not reliably do — measured: the page stayed on the old theme until a full reload |
| 2026-08-04 | Scored-state emphasis is quiet (left edge + recession), decided after the filter | N4 was deliberately sequenced after N5, and the filter changed the answer: with "Not scored" one click away, shouting at every unscored row is noise. The badge stays as the accessible label — colour is never the only signal |
| 2026-08-04 | Reading pages may widen to 1000px **when a control panel sits beside the prose**; measure unchanged | Self-assessment was 1515px tall at 1440px, 2048px and 2560px wide alike — height did not respond to width at all, because the card never exceeded 780px. Save & next landed 481px below the fold on a laptop, on every one of 132 controls. Stacking prose above a six-row radio group is what made it tall; the fix is to put them side by side, not to widen sentences (N14) |
| 2026-08-04 | The scoring panel is sticky; below 1100px the action bar is | ICB4's longest indicator is 2,596 characters of text that is never edited, so "everything fits without scrolling" cannot be promised. What can be: the answer and Save never leave the screen |
| 2026-08-07 | Type scale becomes `rem` from a `100%` root, stepping to `106.25%` above 1600px; prose and inputs to 16/17 | Fixed `px` did not respond to viewport, so the laptop set the size and the 27" inherited it: 13.5px measures 19.7 arcminutes at ~50cm but 15.5′ at ~70cm, against a 20–22′ target. Percentage rather than a px root so the reader's own browser font-size setting still governs. Inputs at 16px minimum because iOS Safari zooms the page on focus below that — a defect on every one of 132 controls (N47) |
| 2026-08-07 | `--measure` 52ch → 44ch, and the old rationale retired as wrong | The file claimed 52ch = 68 characters. Measured, it rendered 79 in `.ro p` and 72 in `.measures li` — above the band this rule exists to hold, not below it. The line was already too long; the empty pane beside it was a container problem, which is a different fix (N47) |
| 2026-08-07 | Option rows tighten only under `max-height: 950px`, not everywhere | The bigger type put Save 32px below the fold at 1440×900 — the exact defect N14 exists to prevent, caught by the e2e rather than the owner. It is a HEIGHT constraint, so it takes a height query: paying for a laptop's short viewport with a worse control on every other screen would be the wrong trade. Rows stay 55px, above the 44px touch minimum |
| 2026-08-03 | Palette left unchanged after a readability complaint | Light ink-on-surface measures 16.4:1 vs dark mode's 14.1:1 — light is the harsher of the two. But measure was the dominant fatigue driver, so it is fixed first and the palette re-judged after. If still tiring, soften the reading **surface** toward dark's ~14:1 rather than lightening the ink: ink `#16202E` carries the "serious, trustworthy" anchor, and lifting it compresses the ink/muted hierarchy |
| 2026-08-10 | 4th health tier **Above target** (actual ≥ target + 1.0), coloured **indigo** | The 3-tier model collapsed *at target* and *comfortably past it* into one "Role Ready" verdict, so the report could recognise adequacy and shortfall but never strength — unlike the Provek/Comaea reports it was measured against. A full-level margin (not a half) makes "Above" a real distinction rather than routine. Indigo chosen over teal and a deeper green: distinct from the Role Ready green and the azure accent, and the two-greens pair was the hardest to separate at a glance (owner reviewed all three in a prototype). rollup-spec §4 |
| 2026-08-10 | 3-axis **area radar** added; 28-competency radar still excluded | Reversal of the 2026-08-03 "no radar" decision, scoped to three axes only. The original objection was legibility over a 28-axis radar and it stands unchanged for competencies; three axes (People/Practice/Perspective) are legible and give the summary a shape. Built hand-rolled inline SVG rather than a charting library — a triangle needs no dependency, keeps /results fully server-rendered with zero client JS, and fits the perf discipline. Recharts (the aspirational stack line) earns its place only when 28-CE views are actually specced. rollup-spec §7 |
| 2026-08-11 | Results Increment 1: radar **enlarged + centred** with figures beneath it; capability list **grouped by area**; controls named by **indicator text**, not code; development-plan table **removed** | Owner walkthrough of the built screen. The radar reads as the centrepiece rather than a side-panel thumbnail, so it is enlarged and centred with the per-area figures beneath. The flat gap-sorted list is grouped into the three areas so the shape the radar shows has a matching structure below it. Control codes (`4.4.10.1`) are meaningless to a PM, so weakest/escalation references now show the ICB4 indicator text. The dev-plan table's auto-suggested "Consider …" actions were rejected as noise; a reflective, ICB4-grounded replacement is a separate workstream, so the table is removed rather than kept as filler. |
| 2026-08-12 | Results polish: radar **actual=blue / target=green** (values + dashed target line); area headers become **navy section bars** (white text); drill-down **collapsed by default** (even gaps); control-row value column widened so the score label clears its bar | Owner feedback on the built preview. Blue/green splits actual-vs-target at a glance and matches the two radar polygons. Navy header bars (the KIB anchor colour) read as real section dividers rather than a thin rule. Collapsing every competency by default keeps the summary list scannable — the drill-down is opt-in per competency, not a wall of controls. The value column was overlapping the score bar for the longer scale labels ("Proficient / Competent"); widened it. |
| 2026-08-12 | Results drill-down **Phase 1**: competency expands to its controls (indicator + score bar + result); **exceptions-only** colour; **no measures** (Phase 2) | Owner picked "Quiet 2" from two prototypes. The first pass coloured every control and stacked a health pill on each — a wall of red under a gap competency, a wall of green under a healthy one. Exceptions-only makes colour a signal: on-target controls go neutral, colour appears only where a control is below its own target, so the PM's eye goes to what needs work. Measures were pulled out of the drill-down entirely — they belong on a per-control page (Phase 2, logged) where there is room for them, keeping the results screen scannable. Native `<details>` keeps `/results` fully server-rendered. |
