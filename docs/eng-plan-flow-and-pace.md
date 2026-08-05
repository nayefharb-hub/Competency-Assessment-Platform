# Eng plan: the shape of the work, and pace

Status: REVIEWED — see the report at the bottom. **Scope reduced during review
(D23): Parts 1–3 ship first, Part 4 (pace) follows as its own PR.** One
question was deliberately deferred rather than answered (D26, targets) and it
gates one decision inside Part 1. Derived from
`docs/design-assessment-flow-and-pace.md` (decisions D14–D22, settled with the
owner in `/office-hours`). Do not build from this until the review report at
the bottom says so.

## What is being built, in one line

Replace "132 controls in a flat list" with **areas → competence elements →
controls**, where the competence element is the unit of a sitting; state how
long the work takes; show the assessor who has stalled; and record how fast
each PM actually goes.

## What already exists (so this is smaller than it looks)

- `Framework` already carries `areas`, `competence_elements`, `controls` and
  `measures` (`lib/types.ts:90`), assembled in one query and memoized
  (`lib/framework.ts`). **No new database reads for the navigation.**
- `fw.ceOf(code)`, `fw.controlPosition(code)`, `fw.neighbours(code)`,
  `fw.activeControls` all exist.
- `findAssessmentWithScores` returns the row and every score in one request —
  enough to compute per-CE progress with no extra query.
- `score.updated_at` is stamped per control; under the save-UX model that is
  *when the PM left the control*, so consecutive gaps are time-on-control.
  **The pace data is already being collected.**
- `assessment.started_at` and `completed_at` exist. The People screen already
  renders per-person rows.

So the work is presentation plus two derivations, not a schema change —
**with one exception**, below.

## The target question, deferred (D26) — read before building Part 1

The owner reframed the blinding rule during review, and the new rule is better
than the one in the code:

> *"Target scores have no place during the assessment. It should not be
> mentioned. It should impact the results page only, as the results page is
> where the targets are useful."*

The existing rule is **role-based** — assessees get targets redacted. The
owner's is **context-based** — targets belong to results, not to assessment.
That is a cleaner principle with no role exception to re-explain.

**What the code does today**, measured rather than assumed:

- `getAssesseeFramework()` (targets nulled) is used by exactly two screens:
  `/assess` and `/assess/controls`.
- `getFramework()` (full) is used by `/`, `/results`, `/review`, `/admin`,
  `/admin/controls` and `app/actions.ts`.
- One e2e check guards one screen: `/assess?c=…` must contain no
  `target_level` / `Target level` and no `kib_note` wording.
- `/results` holds full targets but returns `NotYet` unless the assessment is
  `approved` — correct, that is what results are for.
- **`/` holds unredacted targets today.** It does not leak, because it renders
  only `fw.activeControls.length` — safe by what it happens to render, not by
  what it is allowed to touch.
- **`/review` displays targets while the assessor revises** — per CE
  (`app/review/page.tsx:110`) and per control (`:129`).

**Why `/review` is the hard case.** The anchoring argument is *stronger* there
than on the PM's screen: the assessor's level is the authoritative one, the one
that reaches results and drives training decisions. Against that, the assessor
is calibrating nine people rather than self-reporting, and the standard may be
how they stay consistent.

**Deferred by the owner to its own session**, with the review screen in front
of them. It is a methodology decision that outlives this feature.

**What Part 1 does in the meantime:** the new area and competency screens use
`getAssesseeFramework()` and show **no targets** — true under either outcome,
so nothing is blocked. The e2e guard is extended to cover them. `/` and
`/review` are left exactly as they are, pending D26.

## Part 1 — navigation (D14, D18)

**New:** `/assess/areas` (or `/assess` with no control named) renders three
area cards: name, competence-element count, controls, progress ring, and the
typical duration. Clicking one lists its competence elements — code, name,
`n` controls, per-CE progress, duration — each linking to its first unscored
control.

**Changed:** `app/assess/page.tsx` — the "next" at the end of a CE returns to
that CE's list with *"Strategy complete — next: Governance"* rather than
walking blindly into the next CE's first control (D25). At the end of the last
CE in an area it steps **up** to the area screen with *"People complete"*, so
the larger boundary is a moment too. `fw.neighbours()` is control-level and
stays; the CE and area boundaries are computed from `ceOf()`.

**Kept:** the flat 132-row list at `/assess/controls`, with its filters and
Submit. It is how someone finds one specific control, and the review pass
found nothing wrong with it. The new screens are a way *in*, not a
replacement.

**Resume (already built, unchanged):** `cap.last` still returns the PM to the
control they were on. The area screen is what they see when they have no
position yet, or when they click "Self-assessment" having finished one.

## Part 2 — duration (D15b, D17, D18)

`lib/duration.ts`, pure and unit-tested:

```
minutes(controls) = words(core) / RATE + controls.length * DECIDE / 60
```

- `RATE = 200` wpm, `DECIDE = 20` s — **named constants with the derivation in
  a comment**, because they carry the whole result and a future reader must be
  able to see that they are assumptions rather than measurements.
- Word counts come from the framework already in memory. Displayed as a range
  (core-only → core-plus-measures), which is honest about skimming.
- Measured today: **~5–6 min per CE**, 24–29 / 46–55 / 65–76 min per area,
  134–160 min total.

**Copy is a design decision, not a developer one.** *"about 5 minutes"* on a
CE row; *"about 15–20 minutes"* on an area card. `DESIGN.md` governs and has
no component for this yet.

## Part 3 — stall detection (D16)

`/admin/people` gains a **last scored** column: `max(score.updated_at)` per
assessment. A person with an incomplete assessment and no activity for **7+
days** gets a quiet marker.

- One aggregate query, not N.
- 7 days is a starting number, not a studied one — it lives in a named
  constant with that admission in the comment.
- No email, no nagging: the Head of PMO decides what to do. (SMTP does not
  exist anyway.)
- Says nothing about someone on leave. Accepted; the flag is an invitation to
  look, not a verdict.

## Part 4 — pace (D19, D21, D22)

**The one honest schema question.** Time-on-control is derived from gaps
between consecutive `score.updated_at` values, which works while a PM scores
in order and degrades when they jump around — the gap is then "time since I
last saved anything", not "time on this control". Two options, and the review
should pick:

- **(a) Derive from existing timestamps.** No migration. Trim gaps > 10 min as
  "walked away" and gaps where the control order is non-consecutive. Cheap,
  approximate, available for scores already collected.
- **(b) Record `seconds_on_control` at commit time.** The client already knows
  when the control was rendered; the outbox entry can carry it. One nullable
  column, exact, and it distinguishes "thought for 4 minutes" from "left the
  tab open". Costs a migration and touches the commit path that two review
  passes just went over.

Recommendation: **(b)**, because (a) cannot tell thinking from lunch, and the
rushing signal in D22 is only as good as its worst measurement — but the
review should challenge whether the pilot needs the precision.

**Screens.** A pace view showing median seconds per control, the trend across
the assessment (does it speed up as the scale becomes familiar), and
per-control outliers. The assessor sees it per assessment; each PM sees their
own on their own results screen. Nothing is hidden from the person it
describes (D21). It belongs behind an admin role that does not usefully exist
yet — **blocked on N25's role-model review**, and recorded as such rather than
pre-empted here.

**Rushing (D22): computed, stored, surfaced to nobody.** `expectedSeconds` per
control comes from the same word count as Part 2. A control answered in less
is recorded. No flag, no nudge, no colour. The pilot decides whether the
phenomenon is real before anyone designs a response.

## Test plan

- Unit: `lib/duration.ts` — a known control set gives a known range; empty and
  single-control cases; the range is ordered.
- Unit: pace trimming — a 4-hour gap is excluded; a non-consecutive jump is
  excluded; a 30-second answer is kept.
- e2e: the area screen lists 3 areas with 5/10/13 CEs; a CE opens its first
  unscored control; finishing a CE returns to its list and names the next; the
  flat list and Submit still behave exactly as today (they are the regression
  surface); a stalled fixture shows the marker and a fresh one does not.
- The existing 213 checks stay green unmodified — they are the contract for
  scoring, submitting, review and approval, none of which this touches.

## NOT in scope

- Any change to scoring, the scale, submit/review/approve, or the rollup.
- The admin role and where the analysis screen finally lives (N25).
- Trimming the 132-control scope — the 2½-hour measurement is new information,
  and the owner has not been asked to act on it.
- Emailing anyone about anything.

## GSTACK REVIEW REPORT

| Run | Section | Status | Findings |
|---|---|---|---|
| 1 | Scope (Step 0) | **REDUCED** | Four parts, ~10 files, one migration. **D23: split.** Parts 1–3 are presentation over data already in memory — no migration, and they do not touch the commit path that the last two review passes went over. Part 4 (pace) ships second, once there is a CE structure to measure against. |
| 2 | Architecture | 3 findings | **D24/D26** — the blinding rule was found to be enforced at 2 of 8 call sites by convention, guarded by 1 test on 1 screen, with `/` already holding unredacted targets it happens not to render. The owner reframed the rule (targets are results-time, not assessment-time) and **deferred the line to its own session**; Part 1 proceeds because "no targets on the new screens" is true under either outcome. **D25** — end-of-CE returns to the competency list, end-of-area steps up. |
| 3 | Code quality | PASS | No new data layer: `Framework` already carries areas, CEs, controls and measures in one memoized query, and `findAssessmentWithScores` already returns every score. `lib/duration.ts` is pure and unit-testable. Constants `RATE`/`DECIDE`/`STALL_DAYS` carry comments admitting they are assumptions, not measurements. |
| 4 | Tests | PASS (additions) | Full plan in the body. The 213 existing checks are the regression surface and stay unmodified — the flat list, Submit, review and approve are untouched by design. New: the blinding guard extended to the new screens. |
| 5 | Performance | PASS | Per-CE progress is derived in memory from data already fetched — no new round trips on the assessment path, which is the path two PRs were just spent making fast. The stall column is one aggregate query, explicitly not N. |
| 6 | Outside voice | SKIPPED | codex unavailable in this environment. The owner served as the adversarial reviewer and changed the design three times — the scope split, the end-of-area step-up, and the target reframing, which is the most consequential and is now its own open question. |

VERDICT: SOUND for Parts 1–3. The design rests on a measured fact (28
competence elements, 3–6 controls, ~5–6 minutes each) rather than a preference,
and the estimate is derived from the framework's own text with its assumptions
named. Part 4 is deferred by scope, not by doubt.

Build order: Parts 1–3 as one PR. Then D26 in its own session. Then Part 4,
with `/cso` on the commit-path change and the pace data.

NO UNRESOLVED DECISIONS
