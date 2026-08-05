# Eng plan: how saving should feel — async saves vs. decoupled Save

Status: REVIEWED — SOUND (report at bottom). Sections "Approach 1/2" below
are the original proposals kept as history; the binding design is
"The settled design (D7–D10)" — note that D9 replaced approach 1's
save-on-pick trigger with a Next-only commit. Build after PR #19 merges,
as its own PR. Written after PR #19: server work per
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

## The settled design (D7–D10, decided with the owner on the drawing board)

Approach 1 won (D7), then three rounds of owner pushback made it sharper
than the first draft. The final model:

### Commit model — Next is the sole point of truth (D9)

- **Picking a level or typing evidence is local selection only.** Nothing
  leaves the page; change your mind freely; intermediate picks are never
  written.
- **Clicking Next is the commit.** The answer — level + evidence, one
  atomic record — enters the outbox and flushes asynchronously. Navigation
  happens instantly; nothing waits on the write.
- **Previous, logout, or navigating anywhere else does NOT commit.** An
  unconfirmed pick is abandoned, and returning to that control shows only
  what the server holds — an abandoned pick is cleared, never silently
  committed (owner's rule: no default selection committed by mistake).
- Legibility without dialogs: while a pick is unconfirmed the status line
  reads *"Selection not confirmed — Next confirms it."*
- The last control's Next leads to the controls list (as today), so
  finishing normally commits the final answer.

### The outbox is an app-level service, not a page widget (from the owner's
2-minute-outage scenario)

- Lives in the app shell, mounted once above all routes. Queue, retry
  timers, and the failure strip **survive navigation anywhere in the app**;
  during a failure the strip is a slim app-wide banner — a PM on Results
  still sees "4 answers not saved".
- **Retry policy:** immediate attempt on commit; on failure 2s → 4s → 8s →
  16s → then every 30s, indefinitely. No give-up state — these are
  committed answers, and discarding them is never right. Instant flush on
  three events regardless of countdown: the browser regaining connection,
  any new commit (each Next retries the whole queue), and **Retry now**.
- **Retry now ships (D10)** — inside the failure strip only, named for what
  it does. Rationale: collapses the backoff wait (today ≤30s, and the owner
  wants headroom to lengthen the ceiling later), covers browser-thinks-
  it's-online cases, gives an anxious user agency.
- **localStorage mirror ships (D8, decided by implication of the outage
  scenario and confirmed):** hard exits (refresh, crash, closed tab) kill
  JS memory, so surviving them requires the mirror. Namespaced per
  user + assessment; restored and retried on next visit from any page;
  cleared entry-by-entry as the server confirms. Flagged for a bank:
  committed draft answers transiently cached on the PM's own machine.
- **Sign-out with a non-empty outbox:** attempt a final flush; if it fails,
  tell the user plainly and let them choose — stay, or leave with the
  mirror kept for next sign-in. No silent loss, no silent lingering.

### Why not approach 2, recorded

Approach 2's only unique advantage — fewer round trips — stops mattering
once the write is off the click path; its unique risk is losing a PM's
work to browser custody. The final design keeps server custody of every
*committed* answer and browser custody only of the failure buffer.

## Scope

- `app/assess/page.tsx` — score panel becomes a client component; Next
  commits + navigates; Prev/other navigation abandons.
- App shell — the outbox service (~100 lines: queue, backoff, online
  listener, localStorage sync, subscribe) + the global failure banner.
  Plain module-scope client store; no state library (boring tech).
- `app/actions.ts` — non-redirecting save variant returning ok/error.
- Status surfaces per DESIGN.md: unconfirmed line, saved tick, failure
  strip/banner with count + Retry now.
- Submit stays blocked while the outbox is non-empty (server re-validates
  completeness regardless).
- The 4-round-trip save from PR #19 becomes the background cost; the save
  RPC follow-up loses its urgency entirely.

## Tests (traced per codepath)

- e2e: Next commits and persists; **Previous does not commit**; an
  abandoned pick is cleared on return; simulated outage (route abort) →
  strip appears, count grows, answers queue; outage + navigate to Results →
  banner persists app-wide; outage + reload → queue restored from mirror
  and retried; recovery → auto-flush, banner clears; Retry now flushes
  immediately; Submit blocked while queue non-empty; round-trip budget
  re-asserted (navigation GET carries no write; commit = 1 write).
- Unit: backoff schedule; mirror namespacing; entry cleared only on ack.

## NOT in scope

- Any change to scoring semantics, the scale module, submit/review flow, or
  the assessor side.
- Offline editing as a feature. The app remains online-first; the outbox is
  a failure buffer, not an offline mode.

## GSTACK REVIEW REPORT

| Run | Section | Status | Findings |
|---|---|---|---|
| 1 | Scope (Step 0) | PASS | Approach 1 touches ~6 files + one ~100-line client service; under thresholds. Approach 2 would have tripped the complexity gate (app-wide client state layer) — recorded as evidence, decided at D7. |
| 2 | Architecture | 4 decisions | D7 approach 1 (owner); D9 **Next-only commit** — owner overturned the reviewer's save-on-pick twice, correctly: a pick is provisional, intermediate writes are wrong, abandoned picks must clear; D10 Retry now ships with the stated backoff policy; outbox promoted to an **app-level service** by the owner's 2-min-outage scenario, which also decided D8 (localStorage mirror) by implication. |
| 3 | Code quality | PASS | No state library; one shared client store; DESIGN.md governs all surfaces; sign-out edge specified (flush → tell → choose). |
| 4 | Tests | PASS (additions) | Full path trace in "Tests" — including the two behaviours unique to this model: Previous does not commit, and abandoned picks clear. |
| 5 | Performance | PASS | Commit chatter *drops* vs today (no intermediate saves, one atomic write per control); navigation is a pure ~300ms GET; PR #19's 4-trip save becomes background cost. |
| 6 | Outside voice | SKIPPED | codex unavailable in this environment; the owner served as the adversarial reviewer and materially changed the design three times — recorded rather than pretended. |

VERDICT: SOUND — the design is the owner's commit model implemented with
server custody of committed answers and a bounded, argued failure buffer.
An interactive mock of every state was built to DESIGN.md and reviewed by
the owner before this report; their corrections (commit trigger, Retry
now semantics, outbox survival) are folded into the body above.

Build ordering: implement AFTER PR #19 merges, as its own PR. /cso pass
on the implementation should look at the localStorage mirror (draft
answers at rest on the PM's machine) and the sign-out flush path.

NO UNRESOLVED DECISIONS
