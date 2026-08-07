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
- **Scale:** display 28/680 · h2 20/650 · h3 16–17/650 · body 15/400 · small 13–14 ·
  label 12 uppercase, letter-spacing .06em.
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
  - Role Ready `#15803D` on `#E7F6EC`
  - Minor Gap `#B45309` on `#FBEED6`
  - Capability Deficit `#B91C1C` on `#FBE7E7`
  - (Deliberately echo the workbook's green/amber legend for continuity.)
- **Target mark:** ink at 62% opacity.
- **Dark mode (designed, not inverted):** bg `#0E1621` · surface `#14202E` · border
  `#26374C` · ink `#E8EEF5` · muted `#9DACBF` · navy surfaces deepen to `#12283F` ·
  accent lightens to `#5B93F5` · status lightened/desaturated (ready `#4ADE80`,
  minor `#FBBF24`, deficit `#F87171`). Theme via `prefers-color-scheme` + a
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
  - Implemented as `--measure: 52ch`, **not** `68ch`. The CSS `ch` unit is the
    width of the "0" glyph, and Geist's digits run about 1.3× its average
    letter, so `ch` overshoots: `68ch` measured 89 real characters, `52ch`
    lands at 68. Re-derive this if the body typeface ever changes.
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
  values. **No radar chart. Numbers, not percentages.**
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
| 2026-08-03 | Palette left unchanged after a readability complaint | Light ink-on-surface measures 16.4:1 vs dark mode's 14.1:1 — light is the harsher of the two. But measure was the dominant fatigue driver, so it is fixed first and the palette re-judged after. If still tiring, soften the reading **surface** toward dark's ~14:1 rather than lightening the ink: ink `#16202E` carries the "serious, trustworthy" anchor, and lifting it compresses the ink/muted hierarchy |
