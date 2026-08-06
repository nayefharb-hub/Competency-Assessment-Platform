# Design: one way in, and one meaning for "continue"

Settled with the owner in `/office-hours`, 2026-08-06, after they used the
deployed app and reported the journey as confusing. Decisions **D29–D32**.
Supersedes **D12**.

Nothing here is a build instruction. `/plan-eng-review` next.

## The problem is not the screens, it is that there are two products

Each screen is fine on its own. What is broken is that **two definitions of
"the assessment" are live at the same time**, and each entry point picks one
arbitrarily:

| | Model A (before PR #23) | Model B (PR #23) |
|---|---|---|
| The assessment is | 132 controls | 28 competencies across 3 areas |
| The unit of work | one control | one competency — a ~5 minute sitting |
| "Continue" means | the next unanswered control | choose a competency |

PR #23 introduced Model B and **never retired Model A**. That is the defect,
and it is mine: I built the hub and never wired the front door to it.

## Measured, not eyeballed

`/assess/areas` — the screen PR #23 built as "the way in" — has **one inbound
link in the entire application**: the `← All areas` back button on
`app/assess/area/[name]/page.tsx:50`. Nothing in the nav, nothing on the
landing page, nothing from Results. A PM can only reach the hub by already
being inside it, or by finishing an entire area.

Meanwhile there are **three** "start/continue" entry points, going to three
different places:

| Entry point | Destination | Model |
|---|---|---|
| Nav "Self-assessment" (`layout.tsx:54`) | `/assess` → the last control | B's data, A's destination |
| Landing "Continue self-assessment (18/132)" (`page.tsx:62`) | `/assess/controls` (flat 132 list) | A |
| Results "Pick up where you left off" (`results/page.tsx:233`) | `/assess/controls` | A |

The owner's own report matches this exactly: the journey reads differently
depending on which door you came through.

## Why it matters more than it looks

Nine PMs, ~2.5 hours each, spread over several sittings. Ambiguity in
"continue" is not paid once — it is paid at the start of **every sitting**, and
resumability across sittings is the entire reason PR #23 exists. A hub nobody
can find is a feature that shipped in the code and not in the product.

## Decisions

**D29 — Model B wins; the competence element is the unit, everywhere.** The
app commits to areas → competencies → controls. Every screen obeys it. This is
the decision the other three follow from.

**D30 — The hub is the destination of "Self-assessment". D12 is REVERSED.**

D12 said *"the menu returns to the control the PM was last on"*, and it was set
for a good reason: opening control 1 every time forced a PM sixty controls in
to find their own place. That reason is now served better by the hub, which
carries **"Continue where you left off"** as its primary action *and* says
where you are ("2 of 28 competencies complete · next: Perspective") — which is
what somebody returning after four days actually needs.

The cost is honest: **one extra click on every return.** Accepted, because the
click buys orientation and removes the ambiguity that made the journey
confusing in the first place.

`cap.last` is **not** retired. It still records the position; it now powers the
hub's Continue button rather than a redirect.

**D31 — `/assess/controls` is a finder, not an entry point.** The flat 132-row
list stays: it is how someone finds one specific control, it holds the filters,
and it holds Submit. But nothing routes a PM there to *start* or *continue*.
The landing and Results buttons move to the hub.

**D32 — Login lands by role, and deliberately does not pre-empt N25.**

- assessee only → the hub
- assessor / admin (including dual-role) → the console at `/`, which keeps a
  prominent "Continue self-assessment" pointing at the hub

The owner holds both roles, which is exactly the ambiguity N25 (separation of
duties) exists to settle. This rule is decidable today and leaves N25 fully
open — it takes no position on whether one person *should* hold both.

## What a PM sees afterwards

```
sign in ─► the hub  "Your self-assessment · 2 of 28 competencies · next: Perspective"
             ├─ Continue where you left off ──► the control they were last on
             ├─ Perspective ─► its 5 competencies ─► first unscored control
             ├─ People      ─► its 10 competencies
             ├─ Practice    ─► its 13 competencies
             └─ All 132 controls (find one specific thing)

nav "Self-assessment"  ──► the same hub
Results "Pick up…"     ──► the same hub
```

One door. One meaning for "continue".

## Consequences to check when this is planned

Not decisions — things the eng plan must not discover late.

1. **A PM-only account may never see `/` again.** The brand mark is not a link,
   so under D32 the landing page becomes the assessor console in practice.
   Anything a PM still needs from it has to exist on the hub — in particular
   the **"no assessment assigned"** and **"yours was withdrawn"** states, which
   the hub already handles via `NotAssigned`, and which must stay covered.
2. **Two e2e checks assert D12** (`scripts/e2e.mjs`, "the menu returns to the
   control the PM was last on" and "even when that control is already
   answered"). They are not wrong; they encode the old decision. They must be
   rewritten to assert D30, not deleted — the resume *behaviour* still exists,
   it just moved to the hub's button.
3. **One canonical hub URL.** `/assess` and `/assess/areas` must not both
   render a hub. Pick one and redirect the other, or the orphaning problem
   comes back wearing a different hat.
4. **`/assess` is the hottest path in the app.** Two PRs were spent making the
   save loop fast. Whatever `/assess` does with no `?c=` must not add a round
   trip to the control render.

## What this does not settle

- **N25 — separation of duties.** Untouched by design. D32 is a landing rule,
  not a role model.
- **N28 — form row spacing.** Unrelated, already logged.
- **D26 — targets on the assessor's `/review` screen.** Unrelated, still the
  owner's to decide in its own session.
- **Whether the console at `/` should be trimmed** now that PM-only accounts
  will not see it. Worth asking once the change is live and there is something
  to look at.

## Next step

`/plan-eng-review` on an engineering plan derived from this document.
