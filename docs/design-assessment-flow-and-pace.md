# Design: the shape of the work, and how long it takes

Status: DESIGNED — `/office-hours` with the owner, 2026-08-05. Decisions D14–D22
are settled. **Not yet engineering-reviewed**; `/plan-eng-review` is the next
step and no code should be written before it.

## The premise, and why three enhancements are one

The owner asked for three things: a sense of progress across sessions, a way to
see who has stalled, and a way to jump to a competence element instead of
scrolling 132 rows.

They are the same problem. **132 controls is not a long form — it is a project
with no work-breakdown.** No progress across sessions because there is nothing
to be partway *through*; no stall visible because there is no unit to stall
*in*; nowhere to jump because there is nothing to jump *to*.

The framework already contains the missing unit. Measured:

| Area | Competence elements | Controls |
|---|---|---|
| Perspective | 5 | 23 |
| People | 10 | 49 |
| Practice | 13 | 60 |

**28 competence elements, 3–6 controls each.** A CE is a sitting. "Score
*Strategy*" is something a person can decide to do on a Tuesday; "score 132
controls" is something they postpone.

## How long it actually takes — measured, then challenged

Derived from the text itself rather than a guessed constant: word count ÷
reading rate + a judgement allowance per control. It recomputes if the ICB4
text or the control set ever changes.

| | |
|---|---|
| Core text (indicator + description) | **18,040 words** — measured |
| Reference text (measures) | **5,134 words** — measured |
| Reading rate | 200 wpm — **assumption** |
| Judgement per control | 20 seconds — **assumption** |

→ **134–160 minutes for the whole assessment**, and **~5–6 minutes per
competence element**, consistently across all 28.

The word counts are facts; the two rates are choices that carry the whole
result. At 250 wpm / 10s it is 1h 55m; at 150 wpm / 30s it is 3h 40m. The
honest statement is *"between two and three and a half hours, and we do not
know where."*

**This is the finding that outranks the feature.** The owner's instinct put
People at 15–20 minutes; measured, it is 46–55. Either PMs will not read
carefully — in which case the assessment measures something shallower than
intended — or they will, and nine busy people are being asked for ~2½ hours
each, which is a strong candidate for why a spreadsheet never got finished.

## Decisions

**D14 — Areas → competencies → controls, with the CE as the unit.**
"Continue assessment" opens the shape of the work, not one control out of 132.
Three area badges; each opens its competence elements with per-CE progress;
picking a CE runs its 3–6 controls end to end and returns with
*"Strategy complete — next: Governance"*.

**D15 — Progress is a count of competencies, plus what is next.**
*"6 of 28 competencies · Perspective complete · next: People — Self-reflection."*
Explicitly NOT a personal time prediction: *"40 minutes left at your pace"* is a
promise about the person that the person falsifies. A count is a fact.

**D15b — Typical duration as a property of the WORK (owner's amendment,
better than the reviewer's objection).** *"People takes about 15–20 minutes"* is
a label on the task, like a cook time on a recipe — if a PM takes longer,
nothing lied to them. It also answers the question that actually gets someone
started: not *"when will I be done?"* but **"can I start this now?"**

**D18 — Both levels carry it.** Area badge sizes the chunk; the competency row
answers "can I do one right now", which is the decision that begins a sitting.

**D16 — Stall detection: last activity plus a quiet flag.** The People screen
gains "last scored" per person; anyone untouched for 7+ days while incomplete
is marked. No email, no nagging — the Head of PMO decides what to do. Uses
timestamps already stored.

**D19/D20 — Measure real PMs rather than calibrate on the owner.** The owner
declined to self-calibrate, correctly: they read fast and know the framework,
so they are a floor rather than an average. Instead the app measures each PM's
pace per control, which does three jobs — replaces the two assumptions with
observations, exposes the learning curve (pace should rise as the scale becomes
familiar; if it does not, the scale is unclear), and detects rushing.

**The data is largely already there.** Every score carries `updated_at`, and
under the save-UX model that is stamped when the PM leaves the control — so the
gap between consecutive saves *is* time-on-control. What is needed is
session-boundary trimming, so someone who breaks for lunch does not register a
40-minute control.

**Rushed-answer detection is arithmetic, not judgement.** Each control's word
count gives the minimum time in which it could physically have been read. A
200-word control answered in 8 seconds was not read. This matters because a
rushed self-assessment does not merely waste time — it feeds the assessor's
pre-filled sheet and the capability dashboard with numbers nobody thought
about.

**D21 — An analysis screen, eventually admin-only.** The owner wants pace
analysis on its own screen behind an admin role *that does not exist in a
usable form yet* — which is the same role-model gap as N25 (separation of
duties). Until that is designed: **the assessor sees it, and each PM sees their
own.** Nothing is secret from the person it describes, which is what keeps this
a quality instrument rather than a monitoring one.

**D22 — Record rushing, surface nothing yet.** Collect the signal through the
pilot and look at it afterwards. No flag, no nudge, no accusation on data that
has never been validated — and the pilot answers whether the phenomenon is even
real before anyone designs a response to it.

**D28 — Measure dwell in the browser, not gaps between timestamps.** BUILT
2026-08-05. The cheap option was to derive pace from consecutive
`score.updated_at` values, which needs no migration and works on scores already
collected. Rejected against what it has to detect:

| Hole in the timestamp method | Why it matters here |
|---|---|
| The **first control of every sitting** has no predecessor | "Sat down, answered one, left" is the shape being looked for |
| **Out-of-order scoring** attributes the gap to the wrong control | The area/competency navigation actively encourages jumping |
| **Re-scoring** silently corrupts a neighbouring gap | Changing your mind is normal and must not create a false reading |
| A gap **cannot tell thinking from lunch** | The signal is only as good as its worst measurement |

So `score.dwell_ms` (migration 0005): the browser knows the control was
rendered at T and Next was pressed at T+n. Time with the tab hidden does not
count, and a reading over ten minutes is stored as NULL rather than clamped —
a clamped value sits in a median looking exactly like a real measurement.

**D28a — Pace is a flag; the content signals are the finding.** The owner
raised the objection that decides the shape of this: *if PMs are told their
pace is recorded, one could stall deliberately to look diligent.* True — and
self-defeating, because padding costs them the entire two hours that rushing
was meant to save, and it does not improve the answers. Someone who stalls
without thinking still produces a flat sheet.

**A review pass corrected that argument, and the correction matters.** "Padding
costs them two hours" is true of a person clicking the UI, and false of anyone
willing to POST the server action directly — the timing is a number the browser
sends, so a script can claim a three-minute median in about a second. The build
answers this as far as it can be answered: the server clamps any claimed dwell
to the time since the assessment's `started_at` (free — the row is already in
hand), which puts a forger back to having to keep the thing open for as long as
they want to claim. It does **not** detect a plausible lie, and nothing can.

Which is the real reason the screen never shows pace alone:

| Signal | Catches | Fakeable by stalling? |
|---|---|---|
| Median time per control | Clicking through | Yes — at full time cost |
| **Spread of levels used** | Straight-lining | **No** — needs real judgement |
| **Evidence fill rate** | Absent effort | **No** — needs writing |

*Fast* is a flag. *Fast **and** flat **and** empty* is a finding. The only way
to clear all three is to have done the work, which is the objective — and note
that the two content signals are also the two a forged `dwell_ms` cannot touch,
which is what keeps the screen useful against a determined client and not only
against a hurried one. The screen
therefore never shows pace alone and states in its own words that it is where
to look and not a verdict — consistent with the standing rule that the tool
supports a decision and never gates one.

**D28b — The disclosure is load-bearing, not a footnote.** Because the purpose
is to judge whether an assessment was taken seriously, PMs are told before they
start (on `/assess/areas`) that time per control is recorded and why, and can
read their own figures on `/analysis`. Both facts are asserted by e2e. A
measurement used for this and not disclosed is a trap rather than an
instrument, and the distinction is one sentence away from being lost.

## What this does not settle

- **Where the analysis screen lives** once an admin role exists — blocked on
  N25's role-model design review.
- **Whether 132 controls is the right scope for a first cycle.** The owner was
  asked and did not take the scope option; recorded here because the 2½-hour
  measurement is new information that predates no decision.
- **The exact stall threshold** (7 days is a starting number, not a studied
  one) and what happens to someone on leave.
- The visual design of the badges, rings and analysis screen: `DESIGN.md`
  governs, and `/design-consultation` or `/plan-design-review` should see this
  before it is built.

## Next step

`/plan-eng-review` on an engineering plan derived from this document. Nothing
above is a build instruction yet.
