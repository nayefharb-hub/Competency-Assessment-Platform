# Eng plan: one front door, and form rows that are not touching

Status: **NOT BUILT — READY TO BUILD.** Derived from
`docs/design-assessment-navigation.md` (decisions D29–D32, settled with the
owner in `/office-hours`) and N28 in `docs/pilot-feedback.md`.

**`/plan-eng-review` ran 2026-08-06, found 7 issues, and all 7 are now
resolved. The owner answered the 3 open decisions the same day.**

| # | Finding | Severity | Resolution |
|---|---|---|---|
| 1 | Hub has no notion of a submitted assessment | P1 | Part 1b — state-aware hub |
| 2 | Hub URL hardcoded in 5 places | P2 | Part 1c — `ASSESS_HUB` |
| 3 | Submit becomes effectively unreachable | **P1, highest** | Part 1bb — **option A**, draft-complete state |
| 4 | `denied=1` banner swallowed; 3 e2e checks redden | P1 | Part 2 — **option B**, login `next` default |
| 5 | Part 3's N14 risk analysis aimed at the wrong screen | P2 | Corrected in place; `.field` scoped out of `.cols` |
| 6 | Bundling rationale for Part 3 is factually false | P2 | **Split** — Part 3 ships as its own PR |
| 7 | Three D12 checks, not two; they throw, not fail | P2 | Corrected in place |

Findings 3, 4 and 5 came from an adversarial pass and were verified against the
code before being written down. Finding 5 corrects an error made by this plan's
own first review pass.

**Build order, now that finding 6 is settled:**

1. **PR one — Parts 1, 1b, 1bb, 1c and 2.** The routing change.
2. **PR two — Part 3.** One CSS rule plus one assertion. Independent; can go
   first or second, but not in the same diff.

## What is being built, in one line

Make every "start / continue the assessment" route land on the same hub, land
people by role at sign-in, and give form rows the vertical spacing they have
never had.

## Why these two together — SUPERSEDED by finding 6, kept as record

**Do not act on this section.** The argument below was shown to be false and
the owner has agreed to split the two parts into separate PRs. It is retained
so the next reader can see the reasoning that was rejected and why, rather than
rediscovering it.

Both are first-impression defects on the screens all nine PMs meet on day one,
and the pilot has not started. The completion metric the prototype exists to
produce is measured from those first sittings; a confusing journey and a
sign-in form whose button sits on the password field both contaminate it in
ways that look, in the data, exactly like people being slow.

They also share a review lens: N28's fix is one CSS rule that lands on the
scoring panel, which is the same hot path Part 1 touches.

## What already exists (so this is smaller than it looks)

- `/assess/areas` is built, styled and covered by e2e — it just has no inbound
  links. `shapeOf`, `nextAfter`, `estimateLabel` and the per-area progress all
  work today.
- `cap.last` already records position and is already read server-side with no
  extra round trip.
- `NotAssigned` already handles "never assigned" and "yours was withdrawn", and
  `/assess/areas` already renders it.

No new data layer, no migration, no new query.

## Part 1 — one hub, one front door (D29, D30, D31)

**`/assess/areas` stays the canonical hub URL.** It is built and tested;
moving it to `/assess` would churn a working screen for a cosmetic URL gain and
risk the orphaning coming back on the other side.

| File | Change |
|---|---|
| `app/layout.tsx:54` | nav "Self-assessment" → `/assess/areas` |
| `app/assess/page.tsx` | with no `?c=`, `redirect("/assess/areas")` |
| `app/page.tsx:62` | "Continue self-assessment" → `/assess/areas` |
| `app/page.tsx:50` | "See what that means" (withdrawn) → `/assess/areas` |
| `app/results/page.tsx:233` | "Pick up where you left off" → `/assess/areas` |

**The redirect must happen BEFORE the data fetch.** `/assess` currently
resolves the framework, the assessment and `cap.last` and only then decides
where to go. With no `?c=` none of that is used any more, so the redirect goes
immediately after `requireUser()`. This makes the no-param path *cheaper* than
today, which matters because `/assess` is the hottest route in the app and two
PRs were spent on it.

**`cap.last` is not retired.** It keeps being written by the score panel and
keeps driving the hub's "Continue where you left off". Only the redirect
consuming it goes away.

**`/assess/controls` keeps its links FROM the hub** ("Prefer the full list?")
and from the controls page itself. It stops being a destination for anything
that says "continue".

## Part 1b — the hub must know the assessment is closed (review finding 1)

**Added by review.** `app/assess/areas/page.tsx` has **no state check at all** —
it asks `if (!mine)` and nothing else. The console it replaces does better
(`app/page.tsx:63`: `mine.row.state === "draft" ? … : "View your assessment"`).
Once D32 makes the hub a PM's only screen, a PM who has submitted is greeted by
"Continue where you left off", which continues nothing — the control page locks
itself at `app/assess/page.tsx:87`.

That would replace the ambiguity this plan removes with a sharper one, at the
moment a PM feels finished.

The hub renders three states. No new query: `findAssessmentWithScores` already
returns `row.state`, `row.submitted_at` and `row.approved_at`.

```
DRAFT      Your self-assessment
           2 of 28 competencies · next: Perspective
           [Continue where you left off]

SUBMITTED  Your self-assessment
           Submitted 6 Aug · with the Head of PMO for review
           28 of 28 competencies · [View your answers]

APPROVED   Your self-assessment
           Approved 12 Aug · [See your results]
```

Archived stays as it is — `NotAssigned` already distinguishes "never assigned"
from "withdrawn", and remains the hub's answer for both.

## Part 1bb — RESOLVED (finding 3): Submit becomes effectively unreachable

**The most severe finding, and it is not the same as 1b.** 1b fixes a wrong
*label*; this is a **dead end at the terminal step** of the workflow whose
wall-clock is the pilot's headline metric.

`SubmitButton` lives on exactly one screen — `app/assess/controls/page.tsx:101`,
the flat list. This plan demotes that screen to "a finder", deletes both
prominent links to it (`app/page.tsx:62`, `app/results/page.tsx:233`), and D32
stops assessees seeing `/` at all. After the change the routes to Submit are:

1. the tertiary footnote `Prefer the full list? All 132 controls`
   (`app/assess/areas/page.tsx:101`), and
2. `nextAfter()`'s terminal branch (`lib/shape.ts:168`) — which fires **only**
   when the PM's last click is the last control of the last CE of Practice
   (`isLastInCe`, `lib/shape.ts:130`).

Failing scenario: a PM works Practice first, or skips 4.3.2.3 and returns to it
at the end. Their final commit is mid-CE, `nextAfter` returns `null`, the panel
pushes `/assess?c=<next>`. Progress is 132/132. The hub says "28 of 28", offers
no `next:`, and — because `cap.last` is set — shows **"Continue where you left
off"** pointing at an already-answered control. No Submit, no "you're done".
Today `/` rescues them with "Continue self-assessment (132/132)". That rescue is
what this plan deletes.

**Owner chose A (2026-08-06).** Add a fourth hub state, *draft-complete*: every
active control answered, not yet submitted. The primary action becomes
**"Review and submit"** pointing at `/assess/controls`, where `SubmitButton`
already lives. Nothing is duplicated and the outbox-drain gate stays in one
place.

Rejected: putting `SubmitButton` on the hub (duplicates the gate); changing
`nextAfter`'s terminal branch (fixes the common path only, still strands a PM
who navigates away mid-flow); leaving the footnote as the route.

So the hub renders **four** states, not three:

```
DRAFT, incomplete    2 of 28 competencies · next: Perspective
                     [Continue where you left off]

DRAFT, complete      28 of 28 competencies scored
                     [Review and submit →]

SUBMITTED            Submitted 6 Aug · with the Head of PMO for review
                     [View your answers]

APPROVED             Approved 12 Aug
                     [See your results]
```

Completeness is counted over **active** controls only — 132, not 133 — per the
standing rule that an inactive control contributes nothing to any rollup. The
hub already has what it needs: `shapeOf` returns per-area progress, and the
existing `complete` flag on `/assess/controls` (`app/assess/controls/page.tsx:101`)
is the same predicate. Reuse it rather than recomputing, so the hub and the
list can never disagree about whether a PM is done.

## Part 1c — one route constant (review finding 2)

**Added by review.** The plan as written typed `/assess/areas` into five call
sites. That is the same setup that produced the orphaning: several copies of
one fact, and nothing that fails when they drift.

`lib/routes.ts` exports `ASSESS_HUB`. Every call site and the e2e assertions
use it, so "there is exactly one way in" becomes greppable rather than a
convention someone has to remember.

## Part 2 — land by role at sign-in (D32)

**REVISED by finding 4 — this is a sign-in default, not a redirect on `/`.**

The first draft redirected an assessee-only user off `app/page.tsx` on *every*
visit, for the whole session. That is a different rule from the one the header
describes, and it broke the denial banner (below). What lands instead:

`app/login/form.tsx:28` — the post-sign-in `next` default becomes `ASSESS_HUB`
for an **assessee-only** user. Anyone holding `assessor` or `admin` — including
the owner, who holds both — keeps the console as their landing.

`/` stays reachable for everyone. A PM who navigates there deliberately, or who
is bounced there by `requireRole`, still gets the console and still gets the
banner.

This takes no position on whether one person should hold both roles. That is
N25 and it stays open.

### RESOLVED (finding 4) — the first draft swallowed the `denied=1` banner

`requireRole` redirects a blocked user to `/?denied=1` (`lib/auth.ts:223`), and
`app/page.tsx:31` renders **the only explanation a PM ever gets** for being
turned away. Redirecting assessees off `/` with no exemption deletes it: a PM
who clicks a `/review` link from a colleague lands on the hub with no idea why.

The codebase already learned exactly this. `app/login/page.tsx:30` carries a
comment explaining why `denied=1` is exempt from *its* signed-in redirect. This
plan reintroduces the same bug one route over.

Breaking now, and absent from both the test plan and the regression surface:

| Line | Check |
|---|---|
| `scripts/e2e.mjs:583` | PM cannot open the assessor review |
| `scripts/e2e.mjs:585` | PM cannot open framework admin |
| `scripts/e2e.mjs:1625` | a PM cannot reach the People screen |

All three assert `url().includes("denied=1")`.

**Owner chose the second fix (2026-08-06):** move the role landing to the
`next` default in `app/login/form.tsx:28`, as written at the top of Part 2.

This is preferred over exempting `denied` in `app/page.tsx` because it removes
the mechanism rather than patching around it. There is no redirect on `/` left
to leak through, so the three checks above keep passing **unmodified** — they
are regression surface, not tests to rewrite. Nothing new is needed to protect
the banner; it simply never stops rendering.

## Part 3 — N28, form rows have no spacing at all

Measured on `/login` at 1280×900:

| Gap | Now |
|---|---|
| Email input → "Password" label | **0px** |
| "Password" label → password input | 6px |
| Password input → Sign in button | **0px** |

There is no `.field` rule in `app/globals.css`, only `.field label`. `DESIGN.md`
specifies a 4px base and a 4·8·12·16·24·32·48 scale; forms sit outside it.

**The fix is one rule** — `.field { margin-bottom: 16px }` — and the whole risk
is where else `.field` lands. It is used in **15 places across 5 files**:
`/admin` (5), `/admin/people` (5), `/change-password` (2), `/login` (2), and
**`app/assess/score-panel.tsx:198`**, the evidence input on the scoring screen.

### CORRECTED BY REVIEW (finding 5) — the risk above was aimed at the wrong screen

The paragraph this replaces named the score panel as "the constraint" and
390×844 as "the tightest case". Both are wrong, and the review verified it:

- **390×844 cannot break.** At ≤1099px `.assess-actions` is
  `position: fixed; bottom: 0; margin: 0` (`app/globals.css:303-309`, with a
  comment recording that sticky was measured and rejected). N14 reads
  `getBoundingClientRect()` on that button (`scripts/e2e.mjs:1166`). A
  viewport-fixed bar cannot be pushed off screen by a margin. Only 1440×900
  and 2048×1152 use the sticky mechanism at `globals.css:291`.
- **On the score panel the delta is 0px.** `.card`/`.pad` are plain blocks
  (`globals.css:191`), so `.field`'s new `margin-bottom: 16px` collapses with
  `.assess-actions { margin-top: 16px }` (`globals.css:294`) into 16px —
  unchanged. The only non-zero case is the dirty-state note
  (`score-panel.tsx:214`), and the N14 checks navigate fresh, never dirty.
- **The real regression is on the screens this plan waved through.** 10 of the
  15 `.field` usages sit inside `.cols`, which is `display: grid; gap: 16px`
  (`globals.css:446`) — **grid item margins do not collapse**.
  `app/admin/people/page.tsx:150` and `app/admin/page.tsx:92` stack `.cols`
  blocks separated by an inline `marginTop: 14`, giving 16 + 14 = **30px**;
  below 760px `.cols` becomes one column and stacked fields reach
  16 + 16 = **32px**. 30px is not on DESIGN.md's 4·8·12·16·24·32·48 scale.

**So the fix is scoped, not global.** Apply the margin to `.field` but not to
`.field` inside `.cols` (the grid `gap` already provides that rhythm). The
three-step measure-and-ladder procedure is retired — it was spending the
budget on a null risk.

The six N14 checks still re-run, as the regression surface. The e2e must also
assert the `/login` gap is non-zero, so the rule cannot be deleted later
without a test going red — a 0px gap is invisible to every existing check.

### RESOLVED (finding 6) — Part 3 ships as its own PR

"Why these two together" claims both defects contaminate the completion metric.
They do not: `started_at` is stamped on the **first save**
(`lib/db/assessment.ts:634`), and time-to-complete is `completed_at −
started_at`. Everything before a PM's first answer — the login form, the
sign-in landing, the first navigation hunt — is outside the metric by
construction.

That matters because the bundling drags a **global CSS change** onto the same
diff as a **routing change on the hottest route**, mixing two unrelated blast
radii into one `/review` and one bisect. Part 3 alone is ~1 rule plus 1
assertion.

**Owner agreed (2026-08-06): Part 3 ships as its own PR.** The two are
independent and can land in either order. "Why these two together" at the top
of this document is retained only as the record of a rejected rationale — it is
not a reason to bundle them.

## Test plan

**Rewrite, do not delete — there are THREE, not two** (review finding 7; the
earlier draft of this line named `:897` and `:916` and described the checks at
`:897` and `:908`):

| Line | Check | Navigates |
|---|---|---|
| `:897` | the menu returns to the control the PM was last on | `:895` |
| `:908` | even when that control is already answered | `:906` |
| `:916` | with no remembered position, it opens the first unanswered control | `:914` |

All three call `goto("/assess")`. Under Part 1 all three land on the hub, which
has no `.crumb` — so `locator(".crumb").innerText()` **hangs to the action
timeout and throws, aborting the suite mid-run** rather than producing a red
check. That is a worse failure than a failing assertion and must not be
discovered at run time.

`:916` matters most: it is the only coverage of the "no cookie → first
unanswered" fallback, and the hub's own `resume`
(`app/assess/areas/page.tsx:44`) is a near-copy of that logic. It becomes the
only fallback that matters, because a PM's first sitting has no `cap.last`.
Port it to the hub rather than dropping it.

The resume *behaviour* still exists — it moved to the hub's button — so the
checks become: the nav lands on the hub, and the hub's Continue goes to the
remembered control including one already answered.

**New — 15 gaps from the coverage audit** (13 from the first pass, plus 2 that
the owner's answers to findings 3 and 4 introduced). PR one carries 1–14; PR
two carries 15.

| # | Assertion | Why |
|---|---|---|
| 1 | assessee-only **sign-in** lands on the hub | D32, via the login `next` default |
| 2 | assessor/admin sign-in lands on the console | D32 |
| 3 | dual-role sign-in lands on the console | D32, the owner's own case |
| 4 | **`/` still renders the console for an assessee who navigates there** | finding 4 — the mechanism is a sign-in default, not a redirect |
| 5 | nav "Self-assessment" resolves to `ASSESS_HUB` | D30 |
| 6 | landing "Continue" resolves to `ASSESS_HUB` | D31 |
| 7 | Results "Pick up where you left off" resolves to `ASSESS_HUB` | D31 |
| 8 | **all 132 answered → hub offers "Review and submit", NOT "Continue"** | finding 3 — CRITICAL, this is the dead end |
| 9 | that button reaches a page carrying `SubmitButton` | finding 3 — the whole point is Submit stays reachable |
| 10 | **a submitted assessment shows NO Continue button** | finding 1 — CRITICAL |
| 11 | a submitted assessment names its submitted date and offers "View your answers" | finding 1 |
| 12 | an approved assessment offers Results | finding 1 |
| 13 | the hub itself returns 200 and does not redirect | loop guard |
| 14 | hub renders `NotAssigned` for never-assigned **and** for withdrawn + reason | it is now the only route to those messages |
| 15 | `/login` password-input → button gap is **> 0px** | N28; a 0px gap is invisible to every existing check |

Assertions 5–7 compare against the exported `ASSESS_HUB`, not a literal, so a
rename cannot leave a test agreeing with a stale copy of the route.

**Assertion 8 is the one to write first.** It is the check that would have
caught finding 3, and the scenario it must reproduce is a PM finishing *out of
order* — answer the last control of Practice early, then complete a mid-CE
control last. A test that simply answers all 132 in order passes through
`nextAfter`'s terminal branch and proves nothing.

**Re-point, do not rewrite:** the archive e2e checks ("the assessee is told it
was withdrawn", "the reason is shown to them") currently navigate to `/assess`.
That now redirects to the hub, which renders the same `NotAssigned`. They
should pass unchanged — confirm rather than assume, and re-point the
navigation if they do not.

**Now regression surface, not new work (finding 4, option B):** the three
`denied=1` checks at `scripts/e2e.mjs:583`, `:585` and `:1625`. Because the
role landing moved to the login `next` default, `/` is never redirected away
from and the banner never stops rendering — so these keep passing untouched.
They are listed here because the first draft of this plan would have reddened
all three, and their staying green is the proof that option B did what it
claimed.

**Unmodified regression surface:** the six N14 checks, the warm-save
round-trip budget (5 round trips, one write), the blinding guards, and the
pace checks. If any of those move, the change is wrong.

Run with `E2E_SERVER_LOG` set — the round-trip budget is skipped without it,
and skips now show in the tally.

## Risks

1. **A PM-only account may never see `/` again.** The brand mark is not a link,
   so under D32 the console becomes assessor-only in practice. Anything a PM
   needs from it must exist on the hub; the "not assigned" and "withdrawn"
   states are the ones that matter and are covered above.
2. **Redirect loops.** `/` → `/assess/areas` for assessees, and `/assess` →
   `/assess/areas` for everyone. `/assess/areas` must never redirect back.
3. **The one extra click on every return** (D30) is accepted, not mitigated.
   Recorded so it is not rediscovered as a bug.

## NOT in scope

- N25 (separation of duties) and D26 (targets on `/review`).
- Trimming the console now that PM-only accounts will not see it — worth asking
  once this is live and there is something to look at.
- Any change to scoring, the scale, submit/review/approve, the rollup, or pace.
- Moving the hub to `/assess`.
