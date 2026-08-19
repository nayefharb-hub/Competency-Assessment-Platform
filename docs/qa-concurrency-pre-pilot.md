# Pre-pilot concurrency check — four PMs scoring at once, against production

**Run:** 2026-08-19 · **Target:** `https://competency-assessment-platform.vercel.app`
(**production**, not a preview) · **Database:** the real Supabase project
(`gkqydskmnexhneqsvvvt`), the one the nine PMs will use on Monday.

**Result: 4 consecutive clean runs — 136 checks each, 0 failures.** No answer
ever landed in the wrong record, no PM was shown another PM's progress or
results, and no assessment outside the run changed state.

The reason this was worth doing: the assessment loop was built and measured one
PM at a time, and everything that could mix two people's work up lives in state
that is per-INSTANCE rather than per-request — `viewerMemo` (token-keyed, 2s
TTL), the framework memo, the service client. Fluid Compute serves several
requests concurrently on one instance, so `docs/deploy.md` is right that a
module-level variable holding anything user-specific is a cross-user leak rather
than a code smell. The design argument says those keys are safe. This is the
measurement.

Harness: `scripts/concurrency.mjs` (`npm run concurrency`).

---

## What it does

Four simulated PMs and one assessor, all fixtures the run creates and deletes
itself. Every answer is **signed**: the level a PM gives is a function of who
they are, and the evidence field carries `CONC-<phase>-P<n>-<control>`. So
"whose answer is this?" is a fact readable off the row, not an inference.

| # | Phase | What it establishes |
|---|---|---|
| 0 | Fixtures + prior sittings | four assessments, seeded to **different depths** (100/104/108/112 of 132) so every progress figure in the run is unique |
| 1 | Five concurrent sign-ins | each session resolves to its own holder; no page names another PM |
| 2 | **Same control, same instant** | all four answer one control they have never opened, with four different levels, dispatched together |
| 3 | Concurrent walk, 10 controls each | 40 commits across four live sessions, each PM starting from a different place in the framework |
| 4 | Ownership | every row of every record checked against who typed it — signature, level, and that no record gained a control its PM never opened |
| 5 | Progress | three rounds of four concurrent `/assess/controls` renders; each PM must be shown their own count and no other |
| 6 | Concurrent submits | four at once; each moves only its own row, and nothing outside the run moves |
| 7 | Review and approve | the assessor opens each by id and approves |
| 8 | Results | three rounds of four concurrent `/results` renders, each checked against **28 competency means recomputed here from Postgres** — plus a round with the by-area and strengths-and-gaps views interleaved |
| 9 | Finished records | 132 answers each, all their own, targets frozen at approval |

The walk **arrives the way a PM arrives**: it answers whatever control the app
put on screen, reading the code back out of the URL rather than predicting it.
That matters because the primary button does not always go to the next control
in framework order — completing a competency raises the milestone card and
Continue goes to what is still *owed*. Each run raised 7 milestone cards
across the four PMs and pressed Continue on each. Nothing awaits the commit: the
save and the navigation leave together (D9), and a PM who waits is not a PM.

## Proving the checks can fail

A test that has never been red proves only that it agrees with the code in front
of it (CLAUDE.md ground rule 0). So `CONC_SABOTAGE=1` moves one PM's answer into
another PM's record between the walk and the ownership check, and the run must
go red. Both variants were run:

| Injection | Went red |
|---|---|
| PM 1's walked answer moved into PM 2's record | count check, signature check, level check, progress figure (×3 rounds) — **6 red** |
| PM 4's walked answer moved into PM 1's record | count check on both sides, signature check, **stray-control check**, progress figure on both PMs (×3 rounds) — **10 red** |

Between them, every ownership check in phase 4 has been shown red for a real
reason, except "no unsigned answer appeared in any record" — that one has not
been exercised and should not be leaned on.

The first sabotage attempt is itself worth recording: moving a row between
*adjacent* PMs left the stray-control check green, because PM 1's walk sits
inside PM 2's prior sitting, so the row landed on a control PM 2 legitimately
held. The injection had to move between the deepest and shallowest records
before that check could fail.

A second guard earns its place in phase 8: the four PMs' competency means must
be **pairwise distinct**, or the "PM 1 was not shown PM 4's report" comparison
cannot fail. It fired on the first full run — the level formula was
`(2n + pos) % 6`, and 2 ≡ 8 (mod 6), so PM 1 and PM 4 had given byte-identical
answers to all 132 controls. The formula is now `(n + pos) % 6`. A comparison
that cannot fail must say so rather than pass.

Phase 2 also asserts that "concurrent" is a fact about the **server**, not about
how the test was written: the wall-clock for four simultaneous commits must be
well under the sum of their individual times. Four commits taking ~1s each
complete in ~1.0–1.3s, so they overlapped rather than queued.

## Latency under four-way concurrency

Representative run, all figures from the browser, four sessions in flight:

| Step | p50 | p95 | max |
|---|---|---|---|
| Sign in (5 at once) | 3291 ms | 3465 ms | 3465 ms |
| Control render | 569 ms | 645 ms | 645 ms |
| Commit + advance | 850 ms | 1493 ms | 2062 ms |
| Progress render | 743 ms | 1032 ms | 1032 ms |
| Submit | 1986 ms | — | 1995 ms |
| Approve | 1799 ms | — | 1802 ms |
| Results render | 1022 ms | 1092 ms | 1092 ms |

40 commits across four concurrent sessions took ~9.6–9.9 s wall-clock, and the
outbox **drained 218–330 ms after the last click**. Nothing degraded with four
PMs on it; these are the same numbers the app posts for one.

Sign-in is the slow step at ~3.3 s, and it is slow for all five at once. It is a
once-per-session cost on a screen nobody is waiting on mid-assessment, so it is
recorded rather than raised.

## Containment — this ran against real staff data

The database holds 14 real accounts and 4 real assessments. The safety argument
is not "be careful", it is structural:

- only `@example.test` accounts the run creates itself are touched, with
  **per-run generated passwords** that nobody knows once the process exits;
- **the admin assign form is never opened.** That screen lists the real staff
  who are not yet assigned, and one stray click would assign them a cycle.
  Assignments are inserted directly instead, mirroring `assignAssessment`
  exactly (framework, default profile, cycle, `draft`, `assigned_at`,
  `assigned_by`). The assign path itself is covered by `scripts/e2e.mjs`;
- the assessor fixture only ever opens `/review?a=` for the four QA
  assessments, by id;
- every pre-existing assessment's state is snapshotted before the run and
  re-checked twice during it — **"no assessment outside this run changed
  state"** is an assertion, not an assumption;
- teardown runs on the success path, on a throw, on an uncaught exception and
  on Ctrl-C, and then **verifies against the database** that no QA sign-in
  account and no QA allowlist row is left behind.

That last point is not theoretical. Three runs died mid-flight during this
session — one on a harness bug (a dangling `Promise.race` loser timing out as an
unhandled rejection) and two on the stall described below — and all three purged
cleanly, with the verification passing. Afterwards the database is back to
baseline exactly: **14 accounts, 4 assessments, 276 score rows, zero
`@example.test` residue**, checked directly.

## One open observation: two clicks that did not move the screen

Twice, on two separate runs, a commit click neither navigated nor raised the
milestone card, and the PM's session sat on the control until the harness gave
up 45 s later. Both were PM 1; both were in the 4.5.8–4.5.9 range; neither has
recurred in the four runs since.

**The answer was never at risk.** The panel showed "Saved on this device — it
will send when you are back online", meaning the outbox was holding it, and the
database reconciled correctly once the run continued. What failed was the
*screen advancing*, not the record.

What the diagnostic captured at the moment of the second one:

```
onLine: true · milestone card in DOM: false · button enabled · level checked: 3
requests in flight: none
recently failed: POST /assess?c=4.5.7.5 — net::ERR_ABORTED
                 GET  /assess?c=4.5.8.1&_rsc=… — net::ERR_ABORTED
                 POST /assess?c=4.5.8.1 — net::ERR_ABORTED
                 GET  /assess?c=4.5.8.2&_rsc=… — net::ERR_ABORTED
page errors: none · console errors: none
```

**The mechanism is not established, and this note deliberately stops short of
claiming one.** Two candidates fit, and they have opposite implications:

1. **The browser transiently reported offline.** `goNext` in
   `app/assess/score-panel.tsx` commits to the outbox and then returns without
   navigating when `navigator.onLine === false` (decision D13) — which produces
   exactly this symptom: answer queued, screen still, button enabled, no card.
   That would be the app behaving as designed under a network blip.
2. **The navigation's RSC fetch was aborted**, so `router.push` never resolved
   and the URL never changed.

Both are consistent with the `ERR_ABORTED` cluster, and `ERR_ABORTED` is the
documented signature of *this container's* proxied Chromium (STATUS N21, where
it was traced to the harness rather than the app), not of the application. That
is the reason this is an observation rather than a defect.

Three things were done about it rather than none:

- the harness now records `online`/`offline` window events **as they fire**, so
  the next occurrence distinguishes candidate 1 from candidate 2 outright —
  reading `navigator.onLine` afterwards cannot, because the transition is
  transient. (The first cut of the diagnostic looked for a `.banner-offline`
  class that does not exist — the app's banner is `.banner.banner-warn` reading
  "You are offline." A selector that cannot match is not evidence, so it was
  fixed.)
- a click that does not move the screen within 8 s is **pressed again**, the way
  a PM would press it again, up to three times;
- every such nudge is **counted, diagnosed and printed in the summary**. It is
  not swallowed. Across the four clean runs the count is **zero**.

**For the pilot:** if a PM reports "I clicked and nothing happened", the answer
is safe — it is in the browser's outbox and will send. Clicking again is the
right advice. If it happens more than isolated times, `NUDGES` in the harness
output and the `netEvents` capture are where the evidence will be.

## What this does not cover

- **Instance co-residency is not observable from outside.** Four-way overlap at
  the server is demonstrated (phase 2's wall-clock assertion); whether Vercel
  served those four requests from *one* Fluid instance — the configuration in
  which a module-scope leak would actually bite — cannot be seen from the
  client. The more instances Vercel spins up, the weaker the test, which is why
  it was run repeatedly rather than once.
- **Nine PMs, not four.** The pilot is nine. This run is four, plus an assessor.
- **The assessor is single-threaded here**, which matches the pilot: one Head of
  PMO. Two assessors revising the same sheet at once is untested and out of
  scope.
- **Sustained load is not tested.** Each run is a burst of ~50 commits, not a
  two-hour sitting.
- The **`viewerMemo` 2s staleness window** is unchanged and untested by this: a
  role or `must_change_password` flip still lands within 2 s, and a sibling
  instance still answers from its own map for that long. That is the documented
  trade in `docs/deploy.md`, not a finding here.

## Re-running it

```bash
CONC_CHROMIUM=/opt/pw-browsers/chromium npm run concurrency
```

Defaults to production. `CONC_BASE_URL` retargets it; `CONC_PMS` (2–4) and
`CONC_WALK` size it; `CONC_SABOTAGE=1` with `CONC_STOP_AFTER=5` re-proves the
detector in about two minutes; `CONC_ARTIFACTS=<dir>` says where stall
screenshots go. It refuses to run without `--write`, which `npm run concurrency`
supplies.
