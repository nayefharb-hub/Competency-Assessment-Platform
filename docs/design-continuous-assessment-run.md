# Design: the assessment as one continuous run

Status: **APPROVED TO BUILD.** Output of `/plan-ceo-review` and
`/plan-eng-review`, both run on 2026-08-06 at the owner's request against N32.
Not built. See the review report at the end for the three engineering decisions
and the fixed build order.

Supersedes the navigation half of **D25** (see "What this reverses").

## The problem, measured

The owner, after using the deployed app: *"the user has no way for continuous
assessment without his journey being interrupted to go and select an area or
another competency."*

The framework is 132 active controls across **28 competence elements**, median
**5** controls per CE (min 3, max 6). `nextAfter()` (`lib/shape.ts:154`) stops
the PM at the last control of every CE:

| Boundary | Count | Where the PM is sent |
|---|---|---|
| Last control of a CE, more CEs in the area | 25 | `/assess/area/<name>` |
| Last CE of an area, another area follows | 2 | the hub |
| Last control of the assessment | 1 | `/assess/controls?saved=1` |

**28 forced navigations per complete pass**, one roughly every five answers,
each requiring the PM to find and click their next competency.

Nine people are about to do this. The metric this tool exists to move is
completion, and 28 interruptions is a completion tax.

## What this reverses, and what it keeps

D25 decided that a competence element is the sitting: *"finishing is a moment,
and continuing is a choice."* That bought something real — 132 questions with no
structure is exhausting, and a milestone every five answers is what makes the
thing finishable. **That reasoning is not being discarded.**

What is being reversed is the *implementation*: the milestone was built as a
**route change**, so the PM is ejected from the flow and made to navigate. A
milestone can be a moment without being an exit. Those are separable, and
separating them is the whole design.

## Approach: the milestone happens in place

```
  BEFORE                              AFTER
  ┌─────────────────────┐             ┌─────────────────────┐
  │ Control 4.4.1.5     │             │ Control 4.4.1.5     │
  │ [Back to the list →]│             │ [Finish competency →]│
  └──────────┬──────────┘             └──────────┬──────────┘
             │ route change                      │ panel swaps in place
             ▼                                   ▼
  ┌─────────────────────┐             ┌─────────────────────┐
  │ /assess/area/People │             │ ✓ 4.4.1 complete    │
  │  PM must find and   │             │   what you answered │
  │  click the next CE  │             │   Next: 4.4.2 …     │
  └──────────┬──────────┘             │ [Continue] [Break]  │
             │                        └──────────┬──────────┘
             ▼                                   ▼
  ┌─────────────────────┐             ┌─────────────────────┐
  │ Control 4.4.2.1     │             │ Control 4.4.2.1     │
  └─────────────────────┘             └─────────────────────┘
       28 times                            0 times
```

**Precision on "no route change".** Continue still pushes `/assess?c=<next>` —
the same navigation that already happens between ordinary controls, and it must,
or deep links and the back button break. What is removed is the **28 extra
list-page renders**, not navigation itself.

## Scope

Chosen in the review. Baseline plus four expansions, each an explicit decision.

### Baseline — the continuous run

`nextAfter()` returns the next control's **code** and a structured milestone
descriptor rather than an href to a list. `score-panel.tsx` renders a milestone
state in place of the panel; Continue advances to the next control.

### E1 — the competency becomes legible (this is N31)

The competency name gets real visual weight on the scoring screen, and the
milestone card names it at completion. Today it appears only in a `.note`-weight
breadcrumb above the largest text on the page — the unit the rollup aggregates
into is the least visible thing on screen.

### E2 — keyboard scoring

Keys `0`–`5` select a level, Enter confirms and advances. A PM answers 132
questions; reaching for the mouse on each is the bulk of the physical effort.
Additive — the mouse path is unchanged. Also an accessibility gain.

### E3 — the milestone recaps what was just answered

The card lists the controls just completed with the level chosen for each, and a
way back into any of them before moving on. Turns the milestone from a
congratulation into a checkpoint.

### E4 — progress within the competency, and an honest exit

Alongside "28 of 132", the PM sees "3 of 5 in this competency", so the nearest
natural stopping point is always visible. "Take a break" sits beside Continue on
the milestone card, so leaving is a choice rather than an abandonment.

**Why E4 matters more than it reads:** N30, N31 and N32 are three symptoms of
one cause — the PM has no persistent sense of place. A PM who can see the end of
the current stretch does not need to be ejected in order to feel one.

## Failure modes — these are the plan, not an appendix

1. **A false milestone is the worst possible outcome.** If the PM skipped
   controls, the competency is NOT complete and no milestone may appear.
   Otherwise we tell someone they finished something they did not, and point
   them at a Submit the server will refuse. `nextAfter()`'s existing comment
   (`lib/shape.ts:165`) records this exact trap being hit once already.

2. **Optimistic count, not persisted count.** The milestone must count the
   answer the PM is looking at, which is not yet committed when the label is
   chosen. This is the same defect as **N30** — and fixing it here subsumes N30
   rather than leaving it as separate work. It must NOT be fixed by relaxing the
   server's submit precondition, which is what protects failure mode 1.

3. **Offline.** The outbox holds the commit and the PM must not be blocked, so
   the milestone advances on optimistic state. A queued-but-unsent answer still
   counts toward the milestone; the outbox banner remains the truth about
   delivery.

4. **Refresh on the milestone.** It is client state. A reload lands on the same
   control with the answer saved and no milestone. Acceptable — recorded as a
   decision rather than left as an accident.

5. **Pace measurement (D28) must stay honest.** Dwell is captured per control
   before the milestone renders, so thinking time on the milestone card does not
   contaminate it. Cheap to break silently; assert it.

6. **The N14 layout guarantee.** Answer and primary action on screen without
   scrolling, three viewports, longest control in ICB4. E1 and E4's counter land
   on the scoring screen and must be re-measured. E3's recap and E4's break
   button live on the milestone card, which REPLACES the panel — they have their
   own layout and do not compete with the scoring screen's budget. The milestone
   card needs its own measurement at the largest competency (6 controls).

7. **Navigate-away mid-milestone.** Back button from the next control returns to
   a control whose milestone has been consumed. It must render as an ordinary
   completed control, not a second milestone.

## Test plan

Every failure mode above gets an assertion. Specifically:

- A skipped control in the CE produces **no** milestone (guards FM1).
- The milestone appears on the last control of a CE when the other four are
  scored and the fifth is selected but uncommitted (guards FM2 — this is the
  N30 regression, and it must fail against today's code).
- Round trips: the boundary currently costs a full page render. Count them
  before and after; the number must go DOWN, and the change declared per
  CLAUDE.md's round-trip rule.
- The N14 layout checks re-run at three viewports, plus a new one for the
  milestone card at a 6-control competency.
- Keyboard: `0`–`5` and Enter drive a full competency with no pointer events.
- Pace: `dwell_ms` for the last control of a CE is unaffected by time spent on
  the milestone card.

## Decisions from `/plan-eng-review` (2026-08-06)

**A1 — the milestone renders offline, with Continue disabled.** `goNext()`
returns at `score-panel.tsx:164` when `navigator.onLine === false`, *before* any
navigation — correct today, because the boundary is a navigation. But the
milestone's Continue is a navigation too, so an offline PM finishing a
competency would have got a card whose primary action was dead.

They genuinely completed the competency and the outbox genuinely holds their
answers, so hiding the milestone would be the less honest option. The card
renders, Continue is disabled and says why (answers saved, will send when the
connection returns), and "take a break" stays live because leaving costs
nothing. Consistent with D13 and with the reason the outbox exists.

**C1 — extract `MilestoneCard` before building it.** `score-panel.tsx` is
already 256 lines carrying the dwell clock, the position cookie, outbox seeding,
dirty tracking and the commit path. The four items land it near 450. Two
commits: a pure refactor with no behaviour change, proved by the existing tests,
then the feature. `ScorePanel` keeps the timing and commit machinery;
`MilestoneCard` owns completion, recap and Continue. The dwell-clock comments in
`ScorePanel` are load-bearing documentation and a 450-line file buries them.

**T1 — unit-test the boundary logic, keep e2e thin.** `nextAfter()` is a pure
function, so every failure mode that matters is decidable without a browser:
the false milestone on a skipped control, all four boundary shapes, the empty
competency, the last control of the assessment. Those go in
`scripts/shape.test.mjs` (currently 324ms). The e2e asserts only what unit tests
cannot see — the card renders, Continue advances, Continue is disabled offline,
and the layout holds at three viewports.

Precedent: `scripts/routes.test.mjs` was created for exactly this reason after a
review pass found the browser tests guarding `safeNext` had no power to fail.

**Correction to this document:** it previously offered "defer to TODOS.md" as an
option. There is no `TODOS.md` in this repository — the intake is
`docs/pilot-feedback.md`. Deferred items go there.

**Round trips.** This change DELETES 28 full page renders per assessment, each
costing `requireUser` plus the framework plus `findAssessmentWithScores`. Per
CLAUDE.md the number must move knowingly: the plan asserts it goes DOWN.
Verified during review that none of the four expansions adds a query —
`findAssessmentWithScores` (`lib/db/assessment.ts:402`) already returns every
score for the assessment in one embedded select, and `shapeOf` already computes
per-competency counts, so the recap and the counter are free.

## NOT in scope

- Any change to scoring, the scale, submit/review/approve, the rollup, or the
  target-blinding rules.
- Reordering or flattening the framework tree. The hub, area and controls
  screens keep working exactly as they do; this changes what happens at a
  boundary, not the taxonomy.
- Resuming into the middle of a competency across days as a new mechanism —
  `cap.last` already stores the control and the milestone flow must simply not
  lose it. Covered as a constraint, not a feature.

## The seam that matters long term

`nextAfter()` returning a structured milestone descriptor instead of an href is
what makes this work for any framework shape — two levels or four. The platform
ambition in CLAUDE.md is that any organisation brings its own tree; keeping this
logic in `lib/shape.ts` and framework-shaped rather than ICB4-shaped is the
cheap option that keeps that reachable without building it now.

## Next step

`/plan-eng-review` against this document, then build. The review should pay
particular attention to failure modes 1, 2 and 6 — the first two because they
have already bitten this codebase once each, the third because it is a
guarantee that was expensive to establish and is easy to break by accident.

## GSTACK REVIEW REPORT

| Run | Status | Findings |
|---|---|---|
| `/plan-ceo-review` (2026-08-06) | COMPLETE | Approach B chosen over A and C; selective expansion; 4 expansions accepted (E1–E4); 7 failure modes recorded |
| `/plan-eng-review` (2026-08-06) | COMPLETE | 3 findings raised, 3 decided; Step 0 complexity check did not trigger (6 files, 0 new services) |

**Findings, by section**

| # | Sev | Conf | Location | Finding | Outcome |
|---|---|---|---|---|---|
| A1 | P1 | 9/10 | `app/assess/score-panel.tsx:164` | The offline guard returns before any navigation, and the milestone's Continue is a navigation — an offline PM would get a dead primary action | Milestone renders offline, Continue disabled with the reason, break stays live |
| C1 | P2 | 8/10 | `app/assess/score-panel.tsx` | 256-line component with three effects and two refs grows to ~450 with the four accepted items | Extract `MilestoneCard` in a separate no-behaviour-change commit first |
| T1 | P2 | 9/10 | `lib/shape.ts` | Boundary logic is pure and fully decidable without a browser; e2e is a 6-minute loop with a track record of assertions passing for the wrong reason | Exhaustive unit tests on `nextAfter`, thin e2e for rendered behaviour only |

**Section 4 (Performance): no issues found.** The change removes 28 page renders
per assessment and adds no queries — verified against `lib/db/assessment.ts:402`
and `shapeOf`.

**VERDICT: APPROVED TO BUILD.** Scope is 6 files, zero new classes or services,
net-negative on round trips. Build order is fixed by C1: refactor commit first,
feature commit second. The two failure modes with historical precedent in this
codebase — the false milestone (FM1) and the persisted-vs-optimistic count (FM2,
which is N30) — must have their tests written to fail against today's code
before the fix lands, or they are not tests.

NO UNRESOLVED DECISIONS
