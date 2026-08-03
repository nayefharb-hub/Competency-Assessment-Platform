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
- **Scale:** display 28/680 · h2 20/650 · h3 16–17/650 · body 15/400 · small 13–14 ·
  label 12 uppercase, letter-spacing .06em.

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
- **Max content width:** ~1080px for reading; full-width for the dashboard.
- **Border radius:** inputs/buttons 6px · cards 10px · pills 999px.

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
