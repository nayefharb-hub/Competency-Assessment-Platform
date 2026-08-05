# Eng plan: how saving should feel — async saves vs. decoupled Save

Status: DRAFT — under /plan-eng-review. Written after PR #19: server work per
save is measured at ~280ms, the felt time at ~0.7–0.8s, and the owner's
verdict on the preview was "couldn't feel it much". The remaining cost is
structural — two Kuwait→Frankfurt round trips and a full page navigation per
control, 132 times — which no server tuning touches.

## The problem, precisely

Save and "next control" are the same button, so **every navigation carries a
write in front of it**, and the PM waits on both before seeing the next
question. The owner named two ways to break that coupling:

1. **Async save** — picking a level saves in the background; moving between
   controls becomes pure navigation. The Save button disappears (or becomes a
   status indicator).
2. **Decoupled Save** — Next/Prev navigate without writing; selections
   accumulate and are written when the PM explicitly clicks Save
   ("save your progress", results stored on demand).

Both remove the wait from the click path. They differ in **where unsaved
truth lives** — and that is the entire decision.

## Approach 1 — async save (auto-save per selection)

```
pick level ──► UI marks it instantly (optimistic)
   │                             │
   │ background server action    │ PM reads on, clicks Next
   ▼                             ▼
score upsert (server, ~280ms)   pure navigation GET (prefetchable)
   │
   ├─ success → quiet "saved ✓" tick
   └─ failure → control flagged "not saved", global counter, retry button
```

- The score panel becomes a **client component** (the app's first stateful
  one — deliberate and narrow). Level selection fires the existing
  `saveSelfScore` server action, minus the redirect, via `useTransition`.
- Next/Prev become plain `<Link>`s — prefetchable, so navigation can start
  before the save even returns. The write and the next read run in parallel
  instead of in series.
- **Durability is unchanged:** every decision is committed to Postgres the
  moment it's made — the property N18 called a real virtue for an assessment
  record. The server render remains the source of truth; an optimistic tick
  that failed reconciles to "not saved" on the next render.
- Failure surfacing is the design work: a per-control "not saved" state and
  a persistent count ("2 answers not saved — retry") that blocks Submit
  until clear. Submit already validates completeness server-side today.
- Progress (the assessor's completion %) stays live, because writes happen
  as the PM works.

## Approach 2 — decoupled, on-demand Save (batch)

```
pick level ──► held in BROWSER state (context + localStorage)
click Next ──► pure navigation, nothing written
...132 controls...
click "Save progress" ──► one batched write of everything dirty
```

- Fastest possible loop (nothing but navigation between controls) and the
  batch write is genuinely efficient — one round trip for many scores.
- **But unsaved truth now lives in the browser.** Everything between Saves
  is exposed to tab close, browser crash, machine sleep + session expiry
  (15-min access token; refresh flow must survive an hour of unsaved
  editing), a second tab, and "I thought it saved". localStorage narrows
  the loss window but adds cross-device staleness and its own reconciliation.
- The assessor's progress view goes stale — the Head of PMO sees 0/132 until
  the PM remembers to Save. `started_at` (half the time-to-complete metric
  the pilot exists to measure) stops meaning "started".
- Needs: dirty-state indicators, leave-page warnings, merge rules for
  stale-tab writes, and a batch action + validation. This is a client state
  layer for the whole assessment — the largest architecture change proposed
  since the prototype began, for a loop the pilot needs to *trust*.

## What the pilot is actually testing (the constraint that decides this)

`docs/STATUS.md`: the prototype answers one question — *will PMs finish
online when they would not finish a spreadsheet?* The spreadsheet's failure
modes were losing work and not finishing. A save model that can silently
lose an afternoon of scoring to a closed tab reintroduces the exact failure
the tool exists to beat, in exchange for a speed win that approach 1 gets
without the custody transfer.

## Recommendation

**Approach 1.** It removes the felt wait (navigation decouples from the
write and becomes prefetchable), keeps every decision durably committed,
keeps progress live for the assessor, and confines the new complexity to one
client component plus failure surfacing. Approach 2's only unique advantage
— fewer round trips — stops mattering once the write is off the click path;
its unique risk is losing a PM's work.

Explicitly NOT proposed: keeping a manual "Save" button alongside async
saves as a comfort control. A button that does nothing the system isn't
already doing trains users to distrust the auto-save; status ("saved ✓ /
2 not saved") communicates more honestly than a button.

## Scope of approach 1

- `app/assess/page.tsx` — extract the score panel into a client component;
  Next/Prev become links.
- `app/actions.ts` — a non-redirecting variant of the save action returning
  success/failure.
- The status surface (per-control + global unsaved counter) per DESIGN.md.
- e2e: async save persists; failed save is visible and retryable; Submit
  blocked while unsaved answers exist; round-trip budget re-asserted
  (navigation GET carries no write).
- The 4-round-trip save from PR #19 stays as-is underneath — it becomes the
  *background* cost, and the save RPC follow-up loses its urgency entirely.

## NOT in scope

- Any change to scoring semantics, the scale module, submit/review flow, or
  the assessor side.
- Offline editing. The app remains online-first; a failed save says so.
