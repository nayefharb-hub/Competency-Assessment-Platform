# Competency Assessment Platform

**Two horizons — hold both.**

**Now (the prototype):** an internal web tool for KIB's PMO. Project managers
self-assess against the IPMA ICB4 framework, the Head of PMO reviews and
approves, and a dashboard shows capability against APM role-profile targets.
Requested by the Head of Strategy as a committed item in this year's business
plan. ~9 people; the Head of PMO is the sole assessor.

**Long term (the product):** an open platform where *any* organisation defines
or imports its own competency framework — domain → competency → indicator, with
a scoring mechanism at each level — and assesses its staff against it, offered
by subscription. KIB is the first customer and design partner, not the whole
market.

**The discipline that connects them:** ship the narrow thing first. The pain is
in the *assessment loop* (collecting, reconciling, rolling up), not in framework
authoring — so the prototype does ICB4 only and there is **no multi-framework
authoring/import engine** until a pilot earns it. Generality is the last thing
added, not the first.

That is why the architecture looks the way it does, and these are load-bearing:
the framework is stored as **data, not constants**; the rating scale is a
**swappable module**; and `lib/framework.ts` is a **single clean seam** for the
data source. Do not "simplify" these away — they are the cheap options that keep
the platform reachable without building it now.

## Start here
`docs/STATUS.md` — current state, next step, and decisions that must not be
re-litigated. Read it before anything else.

## Source of truth
- `docs/design-competency-assessment-platform.md` — approved product design doc
  (problem, wedge, scale strategy, results design).
- `docs/eng-plan-competency-assessment-platform.md` — engineering build plan
  (stack, data model, state machine, task order T0–T10).
- `DESIGN.md` — the visual design system.

## Design System
Always read DESIGN.md before making any visual or UI decisions.
All font choices, colors, spacing, and aesthetic direction are defined there.
Do not deviate without explicit user approval.
In QA mode, flag any code that doesn't match DESIGN.md.

## Stack
Next.js (App Router, TypeScript) · Supabase (Postgres + Auth) · Vercel · Recharts.
All database access goes through server-side code (service key server-side only);
the client never holds a table-capable key.

## Domain rules that must not drift
- Framework: IPMA ICB4 v4.0.1 — 3 areas, 28 competence elements, **133 controls
  (132 active, 1 inactive)**. Inactive controls contribute nothing to any rollup.
- Scale: APM 0–5 Application axis — Unaware · Aware · Practised · Competent ·
  Proficient · Expert. The PM picks a **label**, never a number; numbers are stored
  underneath. Build the scale as a swappable module (a PDCF variant may be added later).
- Scores: `self_level` (PM) and `assessor_level` (authoritative, shows in results).
  The assessor reviews and revises — accept as-is or override specific controls.
- Targets come from the selected APM benchmark profile (default Intermediate).
  Targets are **not** rolled up or averaged; they are published values.
- Rollup per competence element: **mean of assessor scores across active controls**,
  with the **weakest control** shown alongside.
- Health: Role Ready (at/above target) · Minor Gap (within half a level below) ·
  Capability Deficit (more than half a level below, or any single control 2+ levels
  below its own target).
- ICB4 source text is **never edited**. KIB clarifications are added in their own
  field alongside it.
- The tool **supports a decision, never gates one** — no pass/fail verdicts.
- Language: never use "interest" in the financial sense (Sharia-compliant bank);
  use "profit rate" / "rate of return" / "return".
