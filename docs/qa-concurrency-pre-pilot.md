# Pre-pilot concurrency check — the whole pilot scoring at once, against production

**Run:** 2026-08-19 · **Target:** `https://competency-assessment-platform.vercel.app`
(**production**, not a preview) · **Database:** the real Supabase project
(`gkqydskmnexhneqsvvvt`), the one the nine PMs will use on Monday.

**Result at nine PMs: 308 checks, 307 pass, 1 fail.** Every correctness and
containment check is green — no answer landed in the wrong record, no PM saw
another's progress or results, nothing outside the run moved. The single failure
is the stall gate, and it is a real finding rather than a flake: see
[Clicks that do not move the screen](#clicks-that-do-not-move-the-screen).

Harness: `scripts/concurrency.mjs` (`npm run concurrency`).

## Why this exists

The assessment loop was built and measured **one PM at a time**. Everything that
could mix two people's work up lives in state that is per-INSTANCE rather than
per-request — `viewerMemo` (token-keyed, 2s TTL), the framework memo, the
service client — and Fluid Compute serves several requests concurrently on one
instance, so `docs/deploy.md` is right that a module-level variable holding
anything user-specific is a cross-user leak rather than a code smell. The design
argument says those keys are safe. This measures it.

---

## What it does

Nine simulated PMs and one assessor, all fixtures the run creates and deletes
itself. Every answer is **signed**: the level is a function of who gave it, and
the evidence field carries `CONC-<phase>-P<n>-<control>`. "Whose answer is this?"
is a fact readable off the row, not an inference.

| # | Phase | What it establishes |
|---|---|---|
| 0 | Fixtures + prior sittings | nine assessments, seeded to **different depths** (100–116 of 132) so every progress figure in the run is unique |
| 1 | Ten concurrent sign-ins | each session resolves to its own holder |
| 2 | **Same control, same instant** | all nine armed first, then only the clicks raced, so the POSTs actually collide |
| 3 | Concurrent walk, 10 controls each | 90 commits across nine live sessions, each starting from a different place in the framework |
| 4 | Ownership | every row of every record checked against who typed it — signature, level, strays, unsigned |
| 5 | Progress | three rounds of nine concurrent renders; each PM must see their own count and no other |
| 6 | Concurrent submits | nine at once; each moves only its own row |
| 7 | Review and approve | the assessor opens each by id; the review screen must carry no other PM's record |
| 8 | Results | three rounds of nine concurrent renders, each checked against **28 competency means recomputed from Postgres and paired with their competency name** |
| 9 | Finished records | 132 answers each, all their own; targets frozen at approval, all 133 |

The walk **arrives the way a PM arrives**: it answers whatever control the app
put on screen, reading the code out of the URL rather than predicting it,
because completing a competency raises the milestone card and Continue goes to
whatever is still *owed*. Nothing awaits the commit — the save and the
navigation leave together (D9), and a PM who waits is not a PM.

## Measured, not assumed: the requests really did overlap

**The first version of this check could not fail, and that is the most important
thing this document records.** It compared the burst's wall-clock against the
*sum* of the measured durations. But all the promises start together, so under a
perfectly serialising server their measured durations are cumulative and the sum
is always far larger than the elapsed time. Simulated at N=2, 3 and 4: **passes
under strict serialisation every time.** It was evidence of nothing, and it was
the sole support for the claim that made every other result meaningful.

It now measures when each POST was actually on the wire and asks how many
*different* PMs had one outstanding at the same instant. Verified to return 1 for
a strictly serial server, 4 for a fully overlapped one, and 2 for a partial
overlap — it discriminates.

The first honest reading was **2 of 9**. The harness was arming the radio and
typing evidence inside the raced section, so the POSTs went out staggered.
Arming everyone first and racing only the clicks took it to **6 of 9**, on both
the burst and the walk. Six concurrent requests on one deployment is a real test
of instance sharing; nine would be better and is a harness-precision problem, not
a product one, so the assertion's floor is 2 and **the peak is always printed**.

## Proving the checks can fail

A test that has never been red proves only that it agrees with the code in front
of it (ground rule 0). `CONC_SABOTAGE=1` injects two real defects between the
walk and the ownership check: it moves one PM's answer into another's record, and
strips the signature off a third row.

At nine PMs the sabotage run reports **81 passed, 14 failed**. Every ownership
check in phase 4 now goes red for a real reason — including *"no unsigned answer
appeared in any record"*, which had never been exercised through two earlier
sabotage runs and was therefore worth nothing until now.

Two guards exist because the harness itself failed them:

- **Pairwise-distinct competency means.** If two PMs' numbers are identical, "PM 1
  was not shown PM 4's report" cannot fail. It fired twice. First on
  `(2n + pos) % 6` — 2 ≡ 8 (mod 6), so PM 1 and PM 4 gave byte-identical answers
  to all 132 controls. Then again at nine PMs on `(n + pos) % 6`, because **any
  affine function of `n` mod 6 repeats every six PMs**. Five arithmetic
  candidates were swept against the real 28-competency structure at N=9 and all
  five collided; the formula is now an FNV-1a hash of `n:pos`, verified to give
  distinct answer vectors and distinct 28-mean sets at N=4 and N=9, with all six
  levels evenly used.
- **Competency means are compared paired with their competency**, not as a sorted
  multiset. The multiset form would pass on all 28 correct numbers attached to
  the wrong 28 names.

## Latency at nine-way concurrency

| Step | p50 | p95 | max |
|---|---|---|---|
| Sign in (10 at once) | 4565 ms | 5301 ms | 5301 ms |
| Control render | 1051 ms | 1231 ms | 1231 ms |
| Commit + advance | 981 ms | 1787 ms | 9382 ms |
| Progress render | 1091 ms | 1396 ms | 1460 ms |
| Submit | 3121 ms | 3222 ms | 3222 ms |
| Approve | 1760 ms | 2257 ms | 2257 ms |
| Results render | 1639 ms | 1847 ms | 1943 ms |

Commit p50 holds under a second with nine PMs on it. The 9382 ms max is a stalled
click plus its repeat, not a slow save. Against the earlier four-PM runs
(commit p50 850 ms, results 1022 ms) the cost of going from four to nine is
visible but not alarming: roughly +15% on a commit and +60% on the heavier
results render.

## Containment — this runs against real staff data

The database holds 14 real accounts and 4 real assessments. The safety argument
is structural, and several parts of it were **added after review found them
missing**:

- only `qa.conc*@example.test` accounts the run creates itself, with per-run
  generated passwords nobody knows once the process exits;
- **the admin assign form is never opened.** That screen lists the real staff who
  are not yet assigned, and one stray click would assign them a cycle.
  Assignments are inserted directly, mirroring `assignAssessment`'s write (not
  its whole body: the real one falls back to `fw.profiles[0]` if the default
  profile is missing, where this throws);
- the assessor fixture only opens `/review?a=` for the run's own assessments;
- **teardown purges the database FIRST and closes the browser LAST**, on a 10s
  timer. It used to close the browser first, unbounded — putting the component
  most likely to hang in front of the one step that must not be skipped, in the
  container documented to reset Chromium's TLS;
- **it covers SIGHUP and SIGQUIT** as well as SIGINT/SIGTERM. A closed terminal
  or dropped SSH session is as ordinary a way to end a long run as Ctrl-C, and
  Node terminates on both by default;
- **it sweeps by fixture prefix**, not by the list one invocation happens to
  hold, so a run at `CONC_PMS=4` cleans up after an interrupted run at 9 —
  scoped to `qa.conc` so it cannot delete `e2e.mjs`'s fixtures;
- every destructive call **checks its error** and the purge **retries**.
  `assessment.assigned_by` references `app_user(id)` with no ON DELETE, so a
  failed assessee purge makes the admin delete fail with an FK violation — which
  was previously discarded;
- **it refuses to start** if fixtures from an earlier run are present, so it can
  neither collide with a concurrent run (which would fabricate a
  cross-contamination result) nor silently adopt a leaked admin;
- `CONC_CLEAN=1 npm run concurrency` clears fixtures without running anything.

**What is checked, not assumed.** Every pre-existing assessment is fingerprinted
across nine columns before the run and re-checked twice during it, **including
detecting outright deletion** — the first version compared only rows that still
existed, so a vanished record was invisible to the check written to catch exactly
that. Separately, every pre-existing assessment's **score rows** are counted and
checksummed, because the canonical failure — a commit resolving the wrong
`assessment_id` — leaves the assessment row untouched and would otherwise
deposit a `CONC-…` answer in a real employee's sheet permanently, since teardown
only deletes by fixture id.

After the nine-PM run the database is back to baseline exactly: **14 accounts, 4
assessments, 276 score rows, zero `qa.conc` residue.**

**One caveat with no fix.** While a run is in flight, the fixtures are real rows:
the app has no `@example.test` filter (`grep -rn "example.test" app lib` returns
nothing), so for the few minutes a run takes, the PMO department rollup,
`/admin/people` and the review queue all include nine "QA Concurrency PM"s and a
second Head of PMO. A screenshot taken during a run would be wrong. Run it when
nobody is looking at the dashboard.

## Clicks that do not move the screen

**This is the open finding, and at nine PMs it is no longer rare.** Four clicks
out of 90 neither navigated nor raised the milestone card, leaving the PM sitting
on the control. Three of the four were on **the same control** (`4.5.9.1`) in
three different sessions; the fourth was `4.5.12.1`. Both are the first control
of a competency — where a milestone Continue lands.

**The answer is never at risk.** The panel showed "Saved on this device", the
outbox held it, and every one of those records reconciled to 132 correct answers.
What fails is the screen advancing, not the record.

**What the instrumentation now rules out.** Every stall reported `onLine: true`
and an **empty** `netEvents` array — no offline transition ever fired. That
eliminates the leading hypothesis: `goNext` in `app/assess/score-panel.tsx`
commits and returns *without navigating* when the browser reports offline
(decision D13), which would have produced exactly this symptom. It did not
happen.

**What survives.** Every stall shows the destination's RSC navigation fetch
aborted:

```
GET  /assess?c=<next>&_rsc=… — net::ERR_ABORTED
POST /assess?c=<current>     — net::ERR_ABORTED
onLine: true · netEvents: [] · milestone card in DOM: false · button enabled
```

So `router.push` fired and its RSC fetch died, leaving the URL unchanged. Whether
that is the egress proxy (ERR_ABORTED is the documented signature of this
container's proxied Chromium — STATUS N21) or the app under nine-way load is
**not established here**, and this note does not guess. Two things argue against
pure proxy noise: the clustering on first-controls-of-a-competency, and that four
clean four-PM runs produced zero.

**This wants `/investigate`** — it is a defect-shaped question with an iron law
about root causes, and it should not be settled by a QA report.

**For the pilot, today:** if a PM says "I clicked and nothing happened", the
answer is safe and clicking again works. The harness now repeats the click up to
three times, counts every repeat, and **fails the run** on any of them — printing
`NUDGES` with the per-stall aborted-request delta and a screenshot.

## What this does not cover

- **Instance co-residency is not observable from outside.** Overlap at the
  server is now measured (peak 6 of 9); whether Vercel served those from *one*
  Fluid instance — the configuration where a module-scope leak would bite —
  cannot be seen from the client.
- **Only 11 of each PM's 132 answers are written through the app** (one burst +
  ten walked = 99 across the run). The rest are seeded directly as prior
  sittings so that Submit has a complete sheet. Phase 9's "132 answers, all
  their own" is therefore mostly the harness verifying its own service-role
  upserts. Raise `CONC_WALK` to widen it.
- **One assessor**, matching the pilot. Two assessors revising one sheet at once
  is untested.
- **Sustained load is not tested** — each run is a burst of ~100 commits, not a
  two-hour sitting.
- The **`viewerMemo` 2s staleness window** is unchanged and untested by this:
  that is the documented trade in `docs/deploy.md`, not a finding here.

## Re-running it

```bash
CONC_CHROMIUM=/opt/pw-browsers/chromium npm run concurrency   # nine PMs, production
CONC_CLEAN=1 npm run concurrency                              # remove fixtures, run nothing
```

`CONC_BASE_URL` retargets it (it probes the target before writing anything);
`CONC_PMS` (2–9) and `CONC_WALK` size it; `CONC_SABOTAGE=1` with
`CONC_STOP_AFTER=5` re-proves the detector in a couple of minutes;
`CONC_ARTIFACTS=<dir>` says where stall screenshots go.
