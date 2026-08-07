# Project status & handoff

Last updated: 2026-08-07 (PR #26 — the continuous assessment run, plus the owner's walk-through items N44 and N38/N39/N40; reviewed, tested, NOT yet merged). Read this first — it says where the build is and what the next step is.
Everything referenced here is committed.

**Live.** Deployed on Vercel from `main`. Migrations `0003`, `0004` and
`0005` are applied (`0005` on 2026-08-05, by the owner, in the SQL Editor).
Access-token lifetime was cut 60 min → 15 min the same day, and measured at
900s rather than taken on trust. Pilot feedback from using it is logged in
`docs/pilot-feedback.md` (N1–N29, triaged); the plan for the rest is
`docs/eng-plan-admin-and-ux.md`.

Security posture was audited on 2026-08-06 (`/cso`, full pass) and the report is
in `.gstack/security-reports/` — local only, gitignored, since it names live
findings. Two were found and both are fixed; see the navigation-and-security arc
below. Nothing outstanding above the reporting bar.

---

## Picking this up in a new session — read this first

**1. Recreate `.env.local` before anything else.** It is gitignored and the
session container is ephemeral, so a fresh session has no credentials and every
script fails with "Missing SUPABASE_URL". Copy `.env.example` and fill in the
four values from Supabase → Project Settings → API. Nothing else works until
this exists.

**2. Network access — RE-MEASURED 2026-08-06, and the old claim was wrong.**
`*.supabase.co` must be in the environment's Network access allowlist (Custom +
"include default package managers"), or the session cannot reach the database
at all.

`*.vercel.app` **is now reachable** — production `/login` answers 200 with the
real sign-in page. This file previously said it was not reachable "and probably
cannot be"; that is retired. `sonarcloud.io` is reachable too (public project
reads work with no token), which closes the access gap CLAUDE.md describes.

Two things still limit what an agent can verify against the deployed site, and
they are not network problems:

- **Preview deployments are behind Vercel Deployment Protection.** Any preview
  URL 302s to `vercel.com/sso-api` without a Protection Bypass for Automation
  token — which belongs in an environment variable, never pasted into chat.
  **This is solved as of 2026-08-07:** `E2E_BASE_URL=<preview> npm run e2e` runs
  the WHOLE suite against the preview. It caps TLS to 1.2 (the egress proxy
  resets Chromium's TLS 1.3 — see CLAUDE.md; curl and node fetch negotiate
  differently and get 200, so the network looks fine until a browser touches
  it), routes through `HTTPS_PROXY`, and attaches the bypass header to every
  context. It refuses to run remote without the secret rather than reporting a
  pass earned from redirects. First run on PR #26's preview: **382 passed, 1
  failed** — the `viewerMemo` flake below, and nothing else.
- **Production runs `main`,** so it only ever shows merged work.

**Reaching a PREVIEW deployment.** The owner created a Vercel *Protection
Bypass for Automation* secret (named "claude QA testing") and added it to this
Claude Code environment as **`Vercel_deployment_ByPass`** on 2026-08-06. Send it
as a header on any preview URL:

```bash
curl -H "x-vercel-protection-bypass: $Vercel_deployment_ByPass" <preview-url>/login
# Playwright: extraHTTPHeaders: { "x-vercel-protection-bypass": process.env.Vercel_deployment_ByPass }
```

**It only appears in a session whose container started AFTER the variable was
added** — environment variables are injected at container start, so the session
that requests one never sees it. Check with `printenv Vercel_deployment_ByPass`;
if it is empty, the fix is a new session, not a new variable.

Designating it a *System Environment Variable* in Vercel does NOT help an agent:
that injects it into the deployment's own runtime, for the app to read. The
caller needs the raw value locally, which is why it lives here too.

Re-measure rather than trusting this paragraph: `curl -s -o /dev/null -w '%{http_code}' https://competency-assessment-platform.vercel.app/login`.

Note one good property found while probing: the middleware redirects EVERY
unauthenticated path to `/login`, including routes that do not exist, so an
outsider cannot fingerprint which build is live by probing for new routes.

**3. The password gate is live.** Every account carries
`must_change_password = true` until its owner replaces the password. On first
sign-in you land on `/change-password` and cannot leave it. This is expected, not
a bug. `scripts/e2e.mjs` is unaffected — it creates and deletes its own QA
accounts and needs no real credentials.

**4. Prove the environment before building anything:**

```bash
npm install
npm run verify:db          # expect 11/11
npm run build
npm start > /tmp/next.log 2>&1 &
E2E_SERVER_LOG=/tmp/next.log npm run e2e   # writes, then cleans up after itself
npm run test:unit                          # expect 103/103 — pure logic, no database
npm run perf:save                          # 10 real saves, split by where the time goes
```

If `verify:db` fails, stop: it is credentials or network, not code.

**Read the tally, not just the ✗ count.** The suite reports skips: *"388 passed,
0 failed, 2 SKIPPED (…)"*. A skip is not a pass. `E2E_SERVER_LOG` in particular
gates the **two round-trip budgets** — a warm commit + navigation at 5 calls, a
commit that COMPLETES a competency at 3 (completion, not position, since N40),
the assertions behind CLAUDE.md's "round trips are counted, not estimated" — and without it those checks silently do not run. It was found un-run on 2026-08-05 after several green runs had
been reported, which is why skips are now counted rather than mentioned.

**If `e2e` dies with "Executable doesn't exist at /opt/pw-browsers/…":** the
cloud sandbox ships a pinned Chromium build that will not match whatever
`playwright@^1.62.1` floats to. Do **not** run `npx playwright install` — it is
blocked and unnecessary. Point the suite at the preinstalled browser instead:

```bash
E2E_CHROMIUM=/opt/pw-browsers/chromium npm run e2e
```

`scripts/e2e.mjs:24` already reads that variable; nothing needs changing.

**If a section dies at `page.check` with a 30s timeout and no server error,
suspect the SERVER, not the code.** Cost an hour on 2026-08-07. The page had
`id="__next_error__"` and the browser console said `ChunkLoadError: Failed to
load chunk` — two `next start` processes were alive at once, so port 3000 was
answering from a build whose chunk hashes no longer existed on disk. Rebuilding
under a running server does the same thing.

Two traps make this hard to see. `pgrep -f next-server` matches the grep's own
command line, so it looks like a server survives every kill; check
`ss -tlnp | grep 3000` instead. And a Next error page still embeds the RSC
payload, so any check written as `page.content().includes(…)` passes on it —
section 3 reported four green checks against a page that had crashed. The
recipe:

```bash
pgrep -f next-server | xargs -r kill -9   # then confirm port 3000 is free
rm -rf .next && npm run build
npm start > /tmp/next.log 2>&1 &
```

**5. Where things are.**

| Want | Read |
|---|---|
| What the owner asked for and what happened to it | `docs/pilot-feedback.md` (N1–N21) |
| What to build next and in what order | `docs/eng-plan-admin-and-ux.md` |
| Visual rules — locked, do not deviate | `DESIGN.md` |
| Rollup arithmetic contract | `docs/rollup-spec.md` |

**6. PR A2 — assignment (N7) is DONE.** `getOrCreateAssessment` is gone; an
assessment exists only because an admin assigned it, from `/admin/people`. The
completion denominator is now a count of assignments, and both crutches — the
`Math.max(invitedCount, …)` fudge and the `assessee_is_pm` filter — are deleted
rather than left to disagree quietly with it. `CompletionStats.invited` is
renamed `assigned`, because that is what it counts. Withdrawing an assignment is
allowed only while nothing has been scored. No migration was needed: `0003`
already added `assigned_at` / `assigned_by`.

**PR B — archive (N6) is DONE and migration `0004` is APPLIED** (2026-08-04). It
replaced `unique (assessee_id, cycle)` with a partial unique index over live
rows, so an archived record no longer holds the slot. Verified both directions
against the live database: re-assigning after an archive succeeds, and two live
assessments for one person and cycle are still refused.

**N14 is DONE** — the owner approved the DESIGN.md amendment, which is applied
(§Layout gains the interactive-panel exception; two rows in the decisions log).
The self-assessment is prose-left / scoring-right and pinned above 1100px, one
column with a fixed action bar below it. Save is on screen on load at every width
tested, on the longest control in ICB4 as well as the shortest.

**PR C is DONE** — N10 mobile (header chrome 204px → 122px on a phone; tables
as cards below 560px), N12 Light/Dark/Auto in a cookie with no client component,
N5 controls filter as a query parameter, N4 scored-state emphasis decided after
N5 as planned. `DESIGN.md` gains three decision-log rows.

**The feature backlog is empty; a performance arc followed it.** PRs #9–#13 are
merged (N16–N21) — see "The performance arc" below. The next step is still to
run the cycle: add the nine PMs on **People**, assign them, and let the
completion figure collect. Most of what is still open is the owner's call — see
item 7 — with two exceptions carried in the open items list: the N21
verification and one unpinned e2e flake.

**7. Everything still open is blocked on the owner, not on code.**
- **N1 / N1b** — untick Preview and Development on the two secret-bearing Vercel
  env vars, and decide whether a staging Supabase project is wanted.
- **N15 session bounds** — an inactivity window and an absolute cap. The code
  side is one constant; the rest is a Supabase dashboard setting.
- **The reading measure** — prose renders at 72–73 characters against the 60–70
  DESIGN.md asks for. `48ch` would land in range; left alone because it moves
  every page and belongs with the palette judgement.
- **SMTP** — gates emailed invite links and self-service password reset. Needs
  an IT/policy answer on whether a third-party sender is acceptable for a bank.
- **Palette** — approved but deliberately deferred until the fixed reading
  measure has been judged. See the `DESIGN.md` decisions log for the reasoning
  and the recommended direction if it is still wanted.

**8. Do not use the owner's account for testing.** Use a disposable
`@example.test` account, as `scripts/e2e.mjs` does. Filling and then emptying
the owner's live assessment mid-session is a mistake that has already been made
once — see N13.

---

## Why this exists (don't lose this framing)

**Prototype:** assess KIB's ~9 PMs against IPMA ICB4 this cycle. The Head of
Strategy asked for it; it's a committed line in this year's business plan. The
Head of PMO (the builder) is the sole assessor.

**Long term:** an open, multi-tenant platform — any organisation defines or
imports its own framework (domain → competency → indicator + scoring) and
assesses its people against it, sold by subscription. KIB is the first customer
and design partner; commercial demand elsewhere is a thesis, not evidence, and
does **not** drive prototype scope.

**The wedge:** the pains are all in the *assessment loop* — collection,
self/assessor reconciliation, rollup, trends — not in framework authoring. So
the prototype ships ICB4 only, with **no multi-framework authoring/import
engine**. Admin editing of *this* framework is in scope; a framework *builder*
is not.

**What the prototype is really testing:** whether PMs actually finish the
assessment online when they might not finish a spreadsheet, and whether the
rollup changes real training and staffing decisions. The existing Excel workbook
already satisfies the business-plan commitment, which de-risks the app — it can
be an honest product test rather than a must-ship dependency.

Consequences that are load-bearing in the code: framework stored as **data, not
constants**; rating scale as a **swappable module** (PDCF variant later);
`lib/framework.ts` as a **single seam** for the data source. These are cheap now
and keep the platform reachable — don't remove them as "unused generality."

## Where we are

| Task | State |
|---|---|
| Design doc (`/office-hours`) | **APPROVED** — `docs/design-competency-assessment-platform.md` |
| Eng plan (`/plan-eng-review`) | **CLEARED** — `docs/eng-plan-competency-assessment-platform.md` |
| Design system (`/design-consultation`) | **LOCKED** — `DESIGN.md` |
| T0 — extract & verify workbook | **DONE** — `data/seed/`, `docs/rollup-spec.md` |
| T1 — app scaffold, four screens | **DONE** |
| T2 — database + server data layer | **DONE** — schema applied, seeded, verified |
| T3 — seed ICB4 | **DONE** — 11/11 checks against the live database |
| T4 — assessment loop (PM) | **DONE** — scores persist; draft → self_submitted |
| T5 — assessor review-and-revise | **DONE** — override, accept-all, approve + snapshot |
| T6 — rollup engine | **DONE** — reads real scores; snapshot targets after approval |
| T7 — results + assessor overview | **DONE** |
| T8 — admin editor | **DONE** — tunable layer only, ICB4 source read-only |
| T9 — completion instrumentation | **DONE** — finished flag + median time-to-complete |
| T10 — trends across cycles | not started (P3, schema-ready) |

**The app now runs on Postgres, not the JSON seed.** `lib/framework.ts` is still
the single seam; it queries Supabase instead of `data/seed/icb4-framework.json`.
The seed JSON stays in the repo as the source `supabase/seed.sql` was generated
from — it is no longer read at runtime.

Verified 2026-08-06 against the live database:
- `npm run verify:db` — 11/11 (133 controls, 132 active, 4.3.2.6 inactive, 28
  elements, 3 areas, 586 measures, 6 scale levels, 4 profiles, 116 targets,
  and the per-area splits 24/49/60).
- `npm run test:unit` — **60/60** (TTL map, shape, pace, and the `safeNext`
  redirect guard).
- `npm run e2e` — **279 passed, 0 failed, 0 skipped** through a real browser against the running app,
  then checked in Postgres directly. Covers auth, assignment, role gates, target
  blinding, score persistence, submit, review, accept-all, approve + snapshot,
  locking, cross-user access, rollup arithmetic, the admin editor, the password
  gate, the People screen, session-cookie flags, archive/restore, the
  area/competency navigation, the pace disclosure and `/analysis`
  authorisation, and the N14 layout guarantee (Save on screen without scrolling at three viewports on both
  the shortest and longest controls, with the prose still capped at the reading
  measure).

## What was built

- **`lib/supabase/server.ts`** — service-role client behind `import "server-only"`,
  so a client component importing it is a build error. The browser only ever
  holds the anon key, which reads nothing (RLS on, zero policies).
- **`lib/framework.ts`** — the seam, now querying Postgres. Two entry points, and
  the difference is a security boundary: `getFramework()` (assessor/admin) and
  `getAssesseeFramework()`, which strips target, priority, reason and kib_note.
  Redaction is in the data layer, not in JSX, so no page or action can leak past
  it. (`kib_note` carries target provenance — "Senior baseline / junior target" —
  which is why the PM does not see it. Per the eng plan's state machine.)
- **Auth** — invite-only. `app_user` IS the allowlist: a valid Supabase session
  with no `app_user` row gets nothing. `scripts/invite.mjs` creates both halves
  of an account. Password login; SSO still deferred.
- **Persistence** — self-scores, assessor overrides, accept-all, approval with
  the target snapshot (`docs/rollup-spec.md` §6). Every transition is guarded in
  the WHERE clause AND checked for a matched row, because a PostgREST update
  that matches nothing is not an error and would otherwise report success.
- **Completion instrumentation** — `started_at` on first save, `completed_at` on
  submit; the assessor's first screen leads with finished-count and median
  time-to-complete. The denominator is the number of people an admin **assigned**
  this cycle — a recorded fact, not an inference from who holds a login.

## The performance arc (PRs #9–#13, N16–N21)

The app was slow in production. Five PRs, and the useful output is as much about
*how the investigation went wrong* as about what got faster.

| PR | What it found | Result |
|---|---|---|
| #9 | 18 Supabase calls per page; wrong function region | 18 → 4 calls; region pinned `fra1` |
| #10 | Supabase charges ~31ms **per REST call** before the query runs, so round-trip *count* is the multiplier | framework 9 queries → 1; median DB time per page 1300ms → 222ms |
| #11 | Bracketed the save action; killed the author's own `revalidatePath` theory (measured 0–1ms) | ~50% of a save is Next/Vercel machinery *outside* our code |
| #12 | **N19** a failed `app_user` query and "not on the allowlist" shared a branch — a transient DB error signed the admin out, silently. **N20** an orphan `auth.users` row held an email hostage with no route out | both fixed; N20 was also the N17 flake, now deterministic |
| #13 | 98 of 101 prefetches rendered nothing — and deleting them exposed 14 tests passing on unrelated network noise | prefetching off via `app/link.tsx`; `click`-then-`networkidle` eliminated |

**Three things worth not re-learning:**

1. **"I could not find out" and "the answer is no" are different answers.**
   Collapsing them (N19) turned an availability blip into a security-shaped lie
   told to a legitimate user.
2. **A test that passes because of unrelated traffic is indistinguishable from a
   test that passes** — until the traffic changes. The suite had that property
   for weeks (N21).
3. **On this platform, measure first and explain second.** Three mechanisms were
   proposed and disproved: `unstable_cache`, the function region, and — after
   the owner confirmed Fluid Compute was on all along — the concurrency model
   itself. See the correction at the end of N21.

**Fluid Compute is ON** and was on throughout. That imposes a rule on all future
server code: **no per-user state at module scope**, because instances now serve
requests concurrently. The audit that certifies the current code, and the one
known race, are in `docs/deploy.md` → "Runtime: Fluid Compute".

**The arc is closed. Verified in production 2026-08-05: zero cold starts** on a
live single-user session (`hot` 12, `prewarmed` 2, `cold` none). The churn that
started this — 12 instances for one user — does not reproduce. Consistent with
the rule above, the *outcome* is recorded and the *cause* is not claimed:
Fluid's prewarming and the prefetch removal cannot be separated by this
measurement. Full numbers and the two dead ends in `docs/pilot-feedback.md` →
"Resolution (2026-08-05)".

## The navigation-and-security arc (PR #25, D29–D32, N28)

**One front door.** Three screens each claimed to "continue the assessment" and
pointed at three different paths. `/assess/areas` was built as the way in and
then left with a single inbound link, so nothing went red when the others
drifted. Every entry point now resolves to `ASSESS_HUB` in `lib/routes.ts`, and
the e2e reads that constant out of the app's own source rather than retyping the
path — a literal in the test would have been one more copy to drift.

The hub also grew from one state to four. It used to ask "is there an
assessment?" and nothing else, which made it accidentally right for a draft and
wrong for everything after. The draft-complete branch is the one that matters:
Submit lives on a single screen, and the automatic hand-off at the end of scoring
only fires when the last answer happens to land at the end of the final
competency. Anyone finishing out of order reached 132 of 132 with a Continue
button pointing at a question they had already answered and **no route to submit
at all**.

**Two security passes, and the second one mattered more.**

`/cso` found a leftover QA fixture holding **admin on the production allowlist**,
password still working, from an interrupted measurement run. It also found the
identical sign-in error message undone by the clock: the allowlist was checked
first and returned early, so an address that had never been invited answered
~250ms sooner than one that had — the staff roster, one address at a time, no
password guessed.

`/review` then found that **the fixes for those were themselves broken.** Read
this part, because it is the reusable lesson:

- The open-redirect guard had been rewritten from a regex to URL parsing. That
  closed the control-character bypass and reopened the hole one input over:
  `/..//evil.com` → `//evil.com` → `https://evil.com/`. The origin check passed
  honestly — it was asked about the *input*, and the escape happens in the
  *output*. **Both checks are needed; neither is sufficient alone.**
- Its test could not fail. Four hostile payloads driven through a real browser,
  every one of them refused by the regex being replaced. The comment named the
  escaping input and the test used a different one.
- The new allowlist check collapsed "the query failed" with "no such row" and
  called `signOut()`, which defaults to `scope: 'global'`. One slow moment on the
  database would have told a legitimate user they were never invited and revoked
  every session on every device. **That is N19, rebuilt on the sign-in path with
  a wider blast radius** — see `lib/auth.ts`, which already carries the lesson.
- "Fixture passwords are generated per run" was not true: six literals remained,
  one of which overwrote a generated password and cleared the must-change flag.

**What to take from it:** a fix for a security defect deserves the same
adversarial pass as the original code, and a security test that has never been
run against the vulnerable version is not evidence. Both fixes here were
confirmed end to end by reading the actual redirect header before and after —
not by reasoning about what the code should do. The first two attempts at that
confirmation hit a **stale server** (`pkill -f "next start"` kills the parent,
not the `next-server` child holding the port) and would have supported the
opposite conclusion.

## The continuous assessment run (PR #26, N30–N32, E1–E4) — ON THE BRANCH, NOT MERGED

Three pilot-feedback items from the owner using the tool as first pilot user.
**N30**: the last control of a competency promised "Back to the list" on the
visit where the fifth answer was still uncommitted and "Finish this competency"
on a later visit — the same screen, two different promises. **N31**: the
competency was the least visible thing on the screen, though it is the unit the
rollup aggregates into. **N32**: finishing a competency ejected the PM to a
list, 28 times per assessment, one every five answers.

Reviewed by `/plan-ceo-review` then `/plan-eng-review`; the approved design is
`docs/design-continuous-assessment-run.md`, which ends `NO UNRESOLVED
DECISIONS`. What shipped: the milestone happens **in place**, Continue carries
the run into the next competency's first *unscored* control, the card recaps the
competency with every row clickable to revise, the competency name leads the
screen at heading weight with "3 of 5 in this competency" beside it, and 0–5 +
Enter drive a whole control from the keyboard.

**The review pass on that build found ten critical defects and is why this is
worth reading.** Three root causes, all in one seam — what the client is allowed
to assert that the server has not seen:

1. **The milestone fired on a race.** `ceComplete` corrected the server's count
   by exactly **+1**, for the control on screen, but the outbox enqueues and
   navigates in the same breath (D9), so several answers are routinely in
   flight. Answer five controls quickly and the fifth arrives with three landed:
   `3 + 1 >= 5` is false and the milestone silently does not happen. Faster
   connection, it does. **The approved design doc named this in advance (FM3)
   and the test was never written.**
2. **"Every competency scored" was decided by position.** The build deleted
   `const areaComplete = area.scored === area.controls` and replaced it with a
   check scoped to the last competency, so a PM who skipped one control in week
   one and then worked through the other 131 in order was told the assessment
   was finished and sent to a Submit the server refuses.
3. **Offline was a render-time snapshot.** Nothing subscribed to anything, so a
   connection lost while the card was up left Continue live (the D13 hard
   navigation to Chrome's error page) and a connection regained left it dead
   beside copy promising the PM they could carry on.

**The contract that came out of it, which must not drift:** `nextAfter` reports
`scored`/`total` at competency, area and assessment scope and **never** decides
completeness. `done` is positional. The client adds the answers it holds —
server, then **this browser's own memory of what it confirmed**, then the screen
— by asking each control for its answer rather than by arithmetic, so the count
and the recap agree by construction. Any claim wider than the current competency
can only ever **understate**, because the client cannot see answers given
elsewhere. Understating is a quieter card; overstating is a lie.

**N33 corrected the middle term, and it is the part to hold on to.** That memory
used to be the OUTBOX, and the outbox answers a different question: "is this
still unsent". The commit POST and the navigation GET leave together, and the
GET is the shorter request — measured, the next control's render lands before
the POST is even issued — so the server never has the previous answer; then the
queue drops it the moment the write is acknowledged; then the effect keyed on
the control overwrote the one map that still held it. Walking a competency, the
milestone therefore never rose and the button read "Next control". `lib/outbox.ts`
now keeps `answered`, exported as `answeredLevel()`; the panel keeps `queued`
(in flight, for the offline hint) and `known` (confirmed here, for completeness)
as separate maps. **Do not collapse them again.**

The invariant, stated exactly, because the first draft of it was wrong in the
same commit that added two ways to break it: **acknowledgement never removes an
entry** — that is the whole difference from the queue. A user change and a
server refusal do, and both mean the answer is no longer the screen's to count.
`answered` is keyed by ASSESSMENT as well as control, because a control code is
not unique across time: an archived assessment can be replaced by a fresh
assignment and a cycle rolls over, both while a tab stays open and neither
re-running `configure`.

**The review pass on the N33 fix found two more defects in it, and both were
real.** (1) The fix REPLACED the queue in the completeness chain rather than
adding to it — but `answered` is module memory that a page load destroys, while
the queue is mirrored to localStorage and survives, so a PM who answered four
controls during a write-path outage and then refreshed had four confirmed
answers the screen could no longer see. N33 again, on the one path the mirror
exists for. The chain is now `known → queued → ceLevels`. (2) The server value
won that chain, so a REVISION was displayed at its pre-revision level: change a
control, press Next, and the recap on the card that advertises itself as "the
last easy moment to change an answer" showed the answer you had just replaced.
Three specialists found (2) independently. Both now have walked tests.

388 e2e / 0 failed / 2 skipped without `E2E_SERVER_LOG`, 103 unit — the unit count includes a new
`scripts/outbox.test.mjs`, because three of the paths that make `answered` safe
(the clear on a user change, the delete on a refusal, the assessment scoping)
cannot be reached from a browser test without a second account, a second
assessment, or a server that refuses a write. Every new regression test was run
against the pre-fix build first and failed there.

**A walked test is not the same test as a seeded one, and neither is a failed
one.** The six milestone checks in place before N33 each removed the state the
defect lived in, in one of two ways: five arrived by `page.goto` with prior
answers inserted straight into Postgres, and FM3 — the check written for this
exact failure mode — aborted the save POST to simulate the queue, so it covered
the failure path and never the successful one. A queue that never drains never
forgets; success is what deletes the evidence. All six passed against a build
where the feature did not work at all on the walked path. The suite now walks
it, with the premise asserted so a run where the race falls the other way says
INCONCLUSIVE instead of green.

**FIXED 2026-08-07 (N45), with `/cso --diff --scope auth`, and verified over
five consecutive runs rather than one.** `lib/auth.ts` gains `forgetViewer()`
and `app/change-password/actions.ts` calls it after the write. The
password-gate section was green in all five runs; before the fix the same suite
produced 1, 1, 4 and 3 failures across four.

**And it holds on the PREVIEW, which is the run that counts.** This check failed
on both earlier preview runs and passes now: **405 passed, 0 failed, 3 SKIPPED**
against `cf7b2cf`. That matters more than the local runs because Fluid Compute
and real latency exist only there, and they are the conditions the residual
lives in. The three skips are the two round-trip budgets and the new JWKS check
— all three read the server's own log, which cannot be reached remotely, and all
three were green locally (411 passed, twice). A skip is not a pass.

The residual is unchanged and documented: under Fluid Compute a sibling instance
keeps its own copy for up to 2s, so this narrows the window rather than closing
it. Nothing observed it in practice on the preview, which is evidence the window
is small, not evidence it is closed. Original entry below,
kept because the diagnosis is the reusable part.

**The original report — and calling it a flake understated it.** "the app is reachable once the flag clears" fails intermittently
locally and failed on BOTH runs against the Vercel preview. The mechanism was
right all along: `viewerMemo` (`lib/auth.ts:111`) caches the viewer for 2s
keyed by access token, and `app/change-password/actions.ts` clears
`must_change_password` in Postgres and redirects WITHOUT evicting the memo — so
the redirect's render can answer from a cached viewer that still says the flag
is set, and the gate at `lib/auth.ts:213` bounces the PM back to the screen
they just completed.

What was wrong was the conclusion, not the diagnosis. This was filed as "the
documented staleness bound behaving as designed", which is true and beside the
point: **the path it lands on is the first thing all nine PMs will do.** Sign
in with the password the Head of PMO gave you, set your own, and be returned to
"set your own password" with no explanation. It clears within 2s and a reload
gets them in, so it is not a blocker — but it is a bad first thirty seconds, on
the one screen with no prior context to fall back on, and it is now measured on
the deployment they will actually use.

The fix mirrors what sign-out already does one function over — `signOut()`
deletes the entry for the current token at `lib/auth.ts:239`, for exactly this
reason, and the password change never got the same treatment:

```ts
const { data } = await auth.auth.getSession();
if (data.session?.access_token) viewerMemo.delete(data.session.access_token);
```

**Not done in PR #26.** It touches auth, so per CLAUDE.md it needs `/cso` and
its own diff. Under Fluid Compute a sibling instance keeps its own copy for up
to 2s regardless, so eviction narrows the window rather than closing it; whether
that is enough is the question the security pass should answer.

## The owner's walk-through (N34–N44) — same branch, PR #26

The owner walked the whole assessment on 2026-08-07 and logged eleven items;
they are in `docs/pilot-feedback.md`, and what shipped is recorded at the end of
that file. Four of the eleven are done — N44, and N38/N39/N40 as one change.

**N44 — the framework screen opens on a table.** `/admin/controls` is a
filterable table (Control · Indicator · Target · Priority · State), grouped by
competency inside area, filtered through the QUERY STRING rather than client
state so a filtered view is addressable and survives a reload (the N5
precedent). The Framework nav points at it; a row opens the single-control
editor and the way back returns to the filtered view. Unknown filter values
fall back to the whole framework — a stale bookmark must not present an empty
framework as the truth — and the header counts always report the whole
framework, never the filtered subset.

**N38 · N39 · N40 — the button names what the click completes.** All three were
one defect: `commitLabel` answered "what does this click complete?" using three
POSITIONAL inputs, so control 132 with holes open read "Review before
submitting", a hole filled mid-competency read "Next control" even when it
finished the competency, and Continue had nowhere to go but the next competency.

**The rule, and it is the owner's:** the button names what the click COMPLETES
if it completes something, and otherwise names where it GOES. Completion is a
fact about ANSWERS and is now asked of answers; position still decides where
you go, and the two no longer share an expression. `lib/shape.ts` gained
`ceContextAt` (the competency context at EVERY control — `done: "mid"` when the
control is not a positional boundary) and `owedAfter` (unanswered controls,
forward then wrapping). `nextAfter` is deliberately unchanged and still
positional. Both derivations are in-memory over data already fetched: **the
round-trip budgets are unmoved and both are asserted from the server's own log
— a warm commit + navigation is 5, a boundary commit is 3.**

**"Completes something" is narrower than "is now complete", and the e2e caught
the first cut of this.** Gating on *the competency is whole after this click*
meant a PM re-opening a competency they had already finished — which the
milestone card's own recap rows invite them to do — was told "Finish this
competency" on every control in it and got the card instead of moving on, so
walking a finished competency through the primary button became impossible. The
completion is news in exactly two cases: this click caused it (a hole filled,
anywhere), or the PM reached the competency's END with it whole (which is where
a revision is shown back to them, N33c). Neither, and it moves on.

The suite also caught the second-order one: giving the card somewhere to
continue TO silently deleted the "N controls elsewhere still need a score"
sentence, which had been gated on "there is nowhere to continue". That was the
same test as "there is no competency ahead" until N38 made them different; it is
now gated on `nextControl` directly.

**And `clearScores()` replaced the raw delete in the [16]/[16b] fixtures.** The
section died mid-run with a duplicate-key crash: every block leaves the browser
at a control whose answer left with the navigation (D9), so a commit POST can
land AFTER the next block's delete. The delete is now confirmed rather than
assumed. Fixture setup, not the step under test — the rule against awaiting the
commit applies to the control being exercised.

Still open from that walk-through: N34 (right-pane height jump), N35 (evidence
field is single-line), N36 (the offline message appears on every Next while
online), N37 (competency as a section header), N41 (a PM cannot see their own
results before approval), N42 (the assessor's Review & revise screen), N43 (the
results screen needs its own session).

## Making the framework admin workable (N46) — same branch, PR #26

Six items from the owner editing the framework on a 27" display. Five shipped;
one is held behind a design call (N47 below).

The framework admin was built as a place to change one field, and the job is to
review 133 controls. So: **a target filter on the table, and Previous/Next in
the editor that walks the filtered view**

**The target picker shipped twice.** The first cut borrowed the PM's vertical
level list — ~430px of definitions between the target and the fields the screen
exists for — and the owner rejected it. The PM reads all six to place
themselves; an admin is setting a value they already know. Four designs were
prototyped and the owner chose a **segmented picker**: the six levels ARE the
input, the dropdown is gone, one click instead of two, labels visible (a level
is picked by label, never by number), and only the chosen definition spelled
out. 151px against 430px, asserted at a 200px budget in the e2e — a number
chosen because six cards clear 400px, not because it is what the code does. No
client component: the definition follows the checked radio through `:has()`.
 — narrow to "targeted Competent", then
walk those 41 rather than making 41 round trips to the list. Reason and KIB
context became textareas (they run to two or three sentences and existed to be
read), and the APM scale is now explained on the screen where the target is
picked, with this control's own target marked.

**The seam is the point.** The table decides which rows exist and the editor's
Next walks that same set — two screens answering one question, which is exactly
D29's shape and `commitLabel`'s. The predicate, the ORDER and the query string
live in `lib/control-filter.ts` and nowhere else. A second copy would let Next
land on a control the view does not contain with nothing red anywhere, because
each screen would be self-consistent.

**Two invariants were proved by breaking them**, per the ground rule that a test
which has never been red is a decoration. A truthiness test on the target
dropped `target=0` from the query string (level 0 is a real target — the
`answeredBefore` trap again); returning the filtered array instead of the
competency-grouped order made Next walk a different sequence than the table
rendered. Each break turned checks red; reverting turned them green.

**The e2e caught a defect in its own first cut, and it is worth not repeating.**
`page.waitForURL(/\/admin\?c=/)` matches the URL the page is ALREADY on, so it
resolved instantly and the assertion read the control the walk started from —
reporting 4.3.1.2 → 4.3.1.2 → 4.3.1.4 and looking like the app had skipped a
row. The walk now waits for the `c` parameter to CHANGE. Same family as the
lesson in the milestone tests: a wait that cannot wait is not a wait.

**The posted filter is re-parsed, never passed through** — it is a hidden field
reaching a redirect target, which is `safeNext()`'s shape, and that one has been
broken twice by trusting the input rather than the output.

## The type scale is set for a laptop and read on a 27" (N47) — NOT BUILT

Raised as "text is not taking the full space of the pane" and answered wrongly
first, which is the part to keep. The prose was said to be capped at 68
characters by `--measure`. Measured on the running build, `.ro p` renders **79**
and `.measures li` 72 — both ABOVE the 60–70 `DESIGN.md` asks for. The line was
already too long; the empty pane beside it is a container problem. The open item
further down this file had recorded 72–73 all along.

The scale is fixed `px` and does not respond to viewport, so 2560×1440,
1440×900 and 390×844 all render identically. 13.5px subtends 19.7 arcminutes on
a laptop at ~50cm and **15.5** on a 27" at ~70cm, against a 20–22′ comfort
target: the laptop case set the size and the 27" inherited it.

**Found while measuring:** every `.input` is 14px, and iOS Safari zooms the page
when a field under 16px takes focus — so a PM tapping the evidence field on an
iPhone gets the page jumping, on each of 132 controls.

Proposed: root 16px stepping to 17px above 1600px, the scale in `rem`, inputs at
16px minimum, `--measure` 52ch → 44ch. **Not built** — it moves every screen, so
it gets its own diff and its own `/design-review`. A mockup is with the owner,
and the two-column admin layout (N46 item 4) is held behind the same call.

## Next step

**Invite the nine PMs, assign them the cycle, and run it.** Deployment is done
(`docs/deploy.md`); neither adding people nor assigning needs a terminal — sign
in as an admin and use **People** in the nav. Adding someone does not start
anything; assigning does, and that assignment is what the completion figure
counts.

Then:

1. Confirm the completion baseline desk check (open item 1 below) — the median
   time-to-complete number means little without it.
2. Work through the remaining pilot-feedback items in the order set out in
   `docs/eng-plan-admin-and-ux.md`: **A2** (assignment — makes the completion
   denominator a fact rather than a guess), **B** (archive), then **C** (the
   rest of the UX pass: mobile, theme toggle, controls filter).

## Supabase

Project ref `gkqydskmnexhneqsvvvt`. Applied via the SQL Editor, in this order:
`supabase/migrations/0001_init.sql` → `0002_rls.sql` → `supabase/seed.sql`,
then `0003_assignment_and_archive.sql` (applied 2026-08-03),
`0004_archive_frees_the_cycle.sql`, and `0005_pace.sql` (applied 2026-08-05).
All three returned success; `seed.sql` self-verifies and rolls back on any
count mismatch. See `supabase/README.md`.

**Credentials are NOT in the repo.** Copy `.env.example` to `.env.local` and
fill in URL + publishable key + secret key from Settings → API. `.env.local` is
gitignored.

**Rotate the secret key when the pilot is done** — it was pasted into a session
transcript on 2026-08-03.

### Network access (important for cloud sessions)

`*.supabase.co` is **not** in the default Trusted allowlist, so a cloud session
cannot reach the database unless the environment's **Network access** is set to
**Custom** with `*.supabase.co` added (and "Also include default list of common
package managers" checked, or npm/GitHub break). Changing this only affects
sessions started afterwards.

If the current session cannot reach Supabase, verify the database by running SQL
in the Supabase SQL Editor instead — that path always works.

## Verify the database quickly

From the repo (uses the app's own credentials, so it also proves the service key
reaches every table the app needs):

```bash
npm run verify:db            # 11 schema/seed checks, exits non-zero on mismatch
npm run e2e                  # full loop through a browser; needs the app running.
                             # Self-contained: it creates and deletes its own QA
                             # accounts, and needs no real credentials.
```

`e2e` writes to whatever database it is pointed at. It refuses to run without
`--write`, touches only two `@example.test` accounts it creates, and deletes them
plus their assessments afterwards. It also restores control 4.3.1.3 to its seeded
values after exercising the admin editor.

Or in the Supabase SQL Editor:

```sql
select 'controls' as item, count(*)::text as value from public.control
union all select 'controls active',      count(*)::text from public.control where active
union all select 'competence elements',  count(*)::text from public.competence_element
union all select 'areas',                count(*)::text from public.competence_area
union all select 'measures',             count(*)::text from public.measure
union all select 'scale levels',         count(*)::text from public.scale_level
union all select 'benchmark profiles',   count(*)::text from public.benchmark_profile
union all select 'benchmark targets',    count(*)::text from public.benchmark_target
union all select 'tables with RLS on',   count(*)::text from pg_tables  where schemaname='public' and rowsecurity
union all select 'RLS policies (want 0)',count(*)::text from pg_policies where schemaname='public'
union all select 'inactive control',     string_agg(code,',')          from public.control where not active
order by item;
```

Expected: areas 3 · benchmark profiles 4 · benchmark targets 116 · competence
elements 28 · controls 133 · controls active 132 · inactive control 4.3.2.6 ·
measures 586 · RLS policies 0 · scale levels 6 · tables with RLS on 13.

## Decisions that must not be re-litigated

Full rationale is in the design doc and `CLAUDE.md`; the short version:

- **Single framework (ICB4) only.** No multi-framework authoring/import engine
  until a pilot earns it. Admin editing of *this* framework is in scope.
- **ICB4 source text is never edited.** KIB clarifications go in `kib_note`,
  alongside.
- **Scale is APM 0–5**, built as a swappable module; PDCF is a later variant
  tested on real scores, not a rebuild now. Level 0 is **"Unaware"** — there is
  no "N/A" option.
- **Two scores:** `self_level` and the authoritative `assessor_level`. The
  assessor reviews and revises (accept as-is or override), rather than
  re-scoring from scratch.
- **Access control lives in the server data layer**, not RLS. Postgres RLS
  cannot hide columns by row-state. RLS is deny-by-default defence in depth.
- **Auth is an invite-only allowlist** for the pilot; SSO/AD deferred.
- **The tool supports a decision, never gates one.** No pass/fail verdicts.
- **The PM does not see `kib_note` either.** It carries target provenance
  ("Senior baseline / junior target"), so showing it would defeat the
  anti-anchoring rule. It belongs to the admin layer, alongside priority and
  reason. Redacted in `getAssesseeFramework()`, not in the JSX.
- **Targets snapshot at approval, never before.** Editing a target in the admin
  screen changes future rollups only; approved assessments keep their frozen
  values.
- **There is exactly one way into the assessment** (D29/D30, 2026-08-06):
  `ASSESS_HUB` in `lib/routes.ts`. An addressless `/assess` redirects there; the
  menu points there; `/assess/controls` is a finder, not a front door. Do not add
  a second entry point — three of them disagreeing is the defect this closed.
- **`cap.last` powers the hub's Continue button, not a redirect** (D30). This
  reversed the earlier D12, which resumed the menu straight into the remembered
  control. The extra click is accepted, not a regression to fix.
- **Landing by role happens at sign-in, not as a redirect on `/`** (D32).
  Redirecting an assessee off the console on every visit would swallow the one
  explanation a blocked person gets — `requireRole` bounces to `/?denied=1` and
  the console renders that banner. Both doors (the sign-in action and the
  already-signed-in `/login` visit) apply the same rule, deliberately.
- **Fixture accounts get per-run passwords and are swept by pattern**
  (2026-08-06). Never reintroduce a literal password for an `@example.test`
  account: this repository is public, and a fixture that outlives its run is a
  real login on the real allowlist. Cleanup must survive an unhandled rejection,
  Ctrl-C, a dropped terminal and a second interrupt arriving mid-purge.
- **`safeNext()` applies BOTH a parse and a shape check, to the OUTPUT.**
  Removing either one reopens an open redirect on the page that has just asked
  for a password. `scripts/routes.test.mjs` is the guard; it must keep at least
  one payload that the *previous* implementation let through.
- **Preview deployments reuse the production Supabase project, and are safe only
  because Vercel Authentication guards them** (2026-08-05). Environment variables
  are scoped to `Preview` as well as `Production` so preview URLs actually work —
  before this, a change could only be seen by merging it, which is how #14 and
  #15 came to be reviewed after landing. The service-role key on a shareable URL
  is defensible *only* while *Deployment Protection → Vercel Authentication* is
  on (Standard Protection). **Turn that off and the preview scoping must come off
  too.** A separate preview Supabase project is the alternative if isolation is
  ever needed; rationale and trigger conditions in `docs/deploy.md`.

## Use gstack for the next phase

The SessionStart hook installs gstack. Use `/investigate` for bugs rather than
ad-hoc debugging, `/review` before landing, `/qa` against the running app,
`/design-review` against `DESIGN.md`, then `/ship`. See the routing table in
`CLAUDE.md`.

## Open items

1. **Completion baseline** — has this team had completion/lateness problems
   before? Needed to judge whether the online form actually helps (design doc's
   assignment). Five-minute desk check, no PM time. The app now measures the
   "after"; this is the "before" it gets compared against.
2. **What decision the rollup drives** (training budget? staffing?) — confirm
   before polishing the dashboard.
3. ~~**Escalation reads oddly in the UI**~~ — done (2026-08-05). A CE at 3.0/3
   showing "Capability Deficit" now names the control that forced it: *"deficit
   driven by 4.3.1.2, scored 1 against target 3"*. Shown **only** where
   escalation actually changed the verdict — where the mean is also short the
   badge needs no defence, and explaining it anyway would train people to skim
   the line in the case that matters. No new visual element: it reuses the
   existing `<small>` row that already carries *"weakest …"*, so `DESIGN.md`
   is untouched. The wording and placement are still the owner's to approve.
   Engine change is presentation-only — `health` arithmetic is unchanged, and
   `rollup-spec.md` §4 records why.
4. ~~**Vercel deploy**~~ — done. See `docs/deploy.md`.
8. **Migration tracking.** Nothing records which migrations have been applied to
   which database. Survivable with one database, guesswork with two — close it
   before standing up staging (pilot-feedback N1b).
9. **SMTP.** Blocks emailed invite links and self-service password reset. Needs
   an IT answer on whether a third-party sender is acceptable, not just code.
5. **General Sans is not in the repo.** `DESIGN.md` specifies it for headings;
   Fontshare is unreachable from the build environment, so headings currently
   fall back to Geist (which IS self-hosted, per spec, for body/UI/data). One
   file drop finishes it — see the Typography section of `DESIGN.md`.
6. ~~**Rotate the admin's temporary password.**~~ — enforced rather than
   remembered: every existing account now carries `must_change_password`, so the
   transcript-exposed password stops working the moment it is used once.
10. ~~**N21 is not verified in production.**~~ — **verified 2026-08-05 by the
   owner. Zero cold starts.** Vercel Observability, *Function Invocations Count*
   grouped by **Function Start Type**, Environment = Production, over a live
   single-user session:

   | Start type | Count |
   |---|---|
   | `hot` | 12 |
   | `prewarmed` | 2 |
   | `cold` | **no row — zero** |

   The churn this arc was chasing — 12 instances for one user, four of them
   serving a single request and never reused — **does not reproduce**. Instances
   are being reused, and the two `prewarmed` ones were ready before the request
   arrived, so nobody waited on them.

   **What this does and does not establish.** It establishes the outcome: a
   normal session now pays no cold-start cost. It does **not** establish that
   removing prefetching is *why* — Fluid Compute's prewarming may be doing some
   or all of the work, and the two are not separable from this measurement.
   Given three mechanisms already proposed and disproved in this arc, the
   outcome is recorded and the cause is not claimed.

   Two dead ends on the way, kept so they are not repeated: the dashboard's
   log export **omits `instanceId`**, so the originally-specified method cannot
   work; and `Function Invocations Count` grouped by *HTTP Status* measures
   volume, not instances. `Function Start Type` is the dimension that answers
   it — there is no instance dimension at all.
11. **One unpinned e2e flake — and it is NOT closed.** Two clean 176/176 runs on
   2026-08-05, then, on the escalation branch and with no code change between
   them, one run reported **4 failures** and the next **1**. The single failure
   was a real deterministic bug in a new check (a substring match — CE `4.4.3`
   is a prefix of control `4.4.3.2`, so `includes()` matched a different
   element's row); that is fixed. **The other three were never captured and
   remain unexplained** — the run was tailed rather than saved, so there is no
   record of which checks they were.
   The lesson is the cheap one: **always save the whole run, never tail it.**

   **Caught on 2026-08-05, saved this time.** A 12-run sequence went 8 clean,
   then run 9 died:

   ```
   page.goto: net::ERR_ABORTED; maybe frame was detached?
     - navigating to "http://127.0.0.1:3000/assess/controls"
   ```

   at the theme-survives-navigation step in group [14]. Two findings, and the
   second matters more than the flake:

   - **The mechanism is still unknown.** It is a main-frame navigation the
     renderer cancelled. This arc has already lost three confidently-argued
     mechanisms, so nothing is claimed beyond what the log says. `gotoStable`
     retries that one navigation **once and prints `↻ … (N21)` when it does**,
     so a retry can never quietly be the reason the suite looks green.
   - **The crash was worse than the flake.** `scripts/e2e.mjs` is top-level
     sequential code, so a throw at any of its 68 `page.goto` calls skipped the
     whole cleanup block: it left `qa.pm1`, `qa.pm2` and `qa.admin` in the
     **real database** — on the allowlist, inside the completion denominator —
     printed no summary and no failing group, and wedged the run loop. Verified
     by finding all three still there 34 minutes later. There is now a
     `teardown()` both paths share and an `uncaughtException` handler that runs
     it, names the failing step and prints a summary. It proved itself
     immediately: the next crash (a dead server) purged all three and reported
     `2 passed, 1 failed` instead of a bare Node stack.

   **Named on 2026-08-05: chromium dies. It is the harness, not the app.**
   The diagnostic added that morning fired on the next crash:

   ```
   ⚠ chromium DISCONNECTED UNEXPECTEDLY at 12:26:35 (N21)
   ✗ SUITE CRASHED — page.goto: Target page, context or browser has been closed
   ```

   The disconnect precedes the navigation failure, so **the browser process
   dying is the cause and the `goto` error is the consequence** — which also
   ties the two crash signatures together (`ERR_ABORTED; maybe frame was
   detached?` is what an in-flight navigation reports when the browser goes;
   `Target … has been closed` is what the next one reports). Nothing here
   implicates the application.

   **Unclaimed, but recorded: both sequences died on run 10.** Three sequences
   so far — one died at run 9, two at run 10 — which is more consistent with
   something accumulating across runs in the container than with chance. It is
   NOT called a cause: three data points and a plausible story is exactly the
   shape this arc has been wrong about three times. The scratchpad loop now
   records free memory, disk and process count before each run, so the next
   occurrence arrives with numbers rather than a hunch.

   **Deliberately not being fixed.** The harness already fails safely: teardown
   runs, the QA accounts are purged from the real database, and the run reports
   which step died. The only casualty is that a 12-run sequence does not finish,
   which costs confidence in the *measurement*, not correctness of the app or
   the suite. Chasing container resource limits is test-infrastructure work, and
   it ranks below N18 and the Results design. Revisit if it starts landing
   before run 9, or if it ever appears in CI.

   Best sequence to date: **9 clean runs at 186 passed, 0 failed**, then a
   browser death.

   **One caveat on "fails safely", from checking rather than assuming.** After
   the 11:55 crash the purges *did* complete — verified directly against the
   database, no `@example.test` rows left — but the final `X passed, Y failed`
   line never printed. So the database guarantee holds; the *reporting*
   guarantee is only partial, and a crashed run can end without a count. Small,
   and worth closing whenever this area is next touched: a run that dies
   silently on the count is the same shape of missing signal that let the
   original flake hide for three rounds.
12. **Separation of duties: one person can assess themselves end to end.**
   A role is a single value and the assessor-side checks never ask whose
   record it is, so one account with `admin` can assign to self, self-score,
   submit, revise and approve — no second party in the trail. The assessee
   direction IS guarded, so the hole is one-way. Owner's position: the two
   capacities must be independent; the wrinkle is that people are identified
   by email, so it cannot be solved by giving someone a second account.
   **Needs `/plan-design-review` on a written proposal before any code** —
   see pilot-feedback N25. Not blocking the pilot (nine people, one assessor),
   but it is the first question an auditor asks of a bank capability record.
7. **CE targets do not re-point by benchmark profile.** Per-control targets do
   (`targetsForProfile`), but CE targets are APM's published values for the
   Intermediate profile, taken from the workbook's Results sheet. Anything other
   than Intermediate needs published CE targets we do not have. Default is
   Intermediate, so this does not bite yet.
