# Competency Assessment Platform

**Two horizons — hold both.**

**Now (the prototype):** an internal web tool for KIB's PMO. Project managers
self-assess against the IPMA ICB4 framework, the Head of PMO reviews and
approves, and a dashboard shows capability against APM role-profile targets.
Requested by the Head of Strategy as a committed item in this year's business
plan. ~9 people; the Head of PMO is the sole assessor.

**Long term (the product):** an open platform where *any* organisation defines
or imports its own competency framework — domain → competency → indicator, with
a scoring mechanism at each level — and assesses its staff against it, offered
by subscription. KIB is the first customer and design partner, not the whole
market.

**The discipline that connects them:** ship the narrow thing first. The pain is
in the *assessment loop* (collecting, reconciling, rolling up), not in framework
authoring — so the prototype does ICB4 only and there is **no multi-framework
authoring/import engine** until a pilot earns it. Generality is the last thing
added, not the first.

That is why the architecture looks the way it does, and these are load-bearing:
the framework is stored as **data, not constants**; the rating scale is a
**swappable module**; and `lib/framework.ts` is a **single clean seam** for the
data source. Do not "simplify" these away — they are the cheap options that keep
the platform reachable without building it now.

## Start here
`docs/STATUS.md` — current state, next step, and decisions that must not be
re-litigated. Read it before anything else.

## Source of truth
- `docs/design-competency-assessment-platform.md` — approved product design doc
  (problem, wedge, scale strategy, results design).
- `docs/eng-plan-competency-assessment-platform.md` — engineering build plan
  (stack, data model, state machine, task order T0–T10).
- `DESIGN.md` — the visual design system.

## Design System
Always read DESIGN.md before making any visual or UI decisions.
All font choices, colors, spacing, and aesthetic direction are defined there.
Do not deviate without explicit user approval.
In QA mode, flag any code that doesn't match DESIGN.md.

## Stack
Next.js (App Router, TypeScript) · Supabase (Postgres + Auth) · Vercel · Recharts.
All database access goes through server-side code (service key server-side only);
the client never holds a table-capable key.

## Architecture rules that must not drift

Each was learned by measurement — most during the 2026-08 performance arc, the
last from a defect that reached the owner — and each has a cost that was paid
once already. None of them is a preference.

- **No synchronous network dependency in the per-request hot path unless it
  fetches the data being served.** Auth is verified locally by signature
  (`getClaims`, ES256) — never reintroduce a per-request call to an auth
  service "to be safe"; the allowlist select in `lib/auth.ts` is the
  per-request revocation check, and it is already paid for. This one habit
  cost ~290ms on every save until it was measured.
- **Round trips are counted, not estimated.** A warm commit + navigation is
  exactly 5 Supabase calls — 3 for the commit (app_user, find assessment,
  write) and 2 for the navigation GET — asserted by e2e from the server's own
  log. Any change that adds a per-request call must move that number knowingly,
  in the same PR. (This rule said "a warm save is exactly 4" until 2026-08-06.
  That figure was true of PR #19 and was superseded by PR #20, which made the
  commit a server action with the navigation beside it; the e2e assertion moved
  and this line did not. A review pass caught the two disagreeing. The number
  to trust is the one in `scripts/e2e.mjs`, because it is the one that runs.)

  **There are two commit shapes since N32, and both are asserted.** A commit
  that COMPLETES a competency raises the milestone in place and navigates
  nowhere: 3 calls, then Continue costs the navigation's 2 — still 5 across the
  pair. Any other commit is the ordinary 5-call navigate. Measured past the 2s
  viewer-memo TTL; inside it Continue costs 1, which is real but
  timing-dependent, so the steady state is what is pinned. This was written
  down because the budget assertion runs at `4.3.1.1`, which completes nothing,
  so it never touched the other path — a change that made the milestone fetch
  anything would have been invisible.

  **The trigger is completion, not position, since N40** — this paragraph said
  "at a competency boundary … on 28 of the 132 commits" and that was true only
  while the card could rise nowhere else. A hole filled anywhere now takes the
  3-call shape too, so the count is 28 plus however many holes the PM left
  behind. Same numbers, wider distribution; both remain asserted in
  `scripts/e2e.mjs`, which is the copy to trust.
- **Performance claims come from `npm run perf:save` (or the phase logs),
  never from reasoning about where time "must" be going.** Four asserted
  mechanisms in a row were wrong before measurement; the rule exists because
  arithmetic filler in a table reads exactly like evidence.
- **Per-user state at module scope needs an argued exception in
  `docs/deploy.md`** (Fluid Compute: instances serve interleaved requests).
  One exists — `viewerMemo`, token-keyed, 2s TTL. Retire it if Next ever
  provides a request store spanning a server action and its redirect render.
- **A test must arrive the way the PM arrives, and must never await the commit
  the product exists to not await.** The save and the navigation leave together
  (D9), so every server render in a run lags one answer; that lag IS the
  product. Three habits each engineered it away and each cost a defect that
  reached the owner: `page.goto` onto the control under test with the earlier
  answers seeded straight into Postgres (a page load postdates every write);
  `await committed` before the next step (a PM who waits is not a PM); and
  aborting the save POST to simulate a queue (a queue that never drains never
  forgets, so it tests the failure path and not the successful one, which is
  where N33 lived). Seeding is for PRIOR SITTINGS. The step under test is
  walked. **Anything the app made asynchronous is tested in its
  successful-but-still-settling state, not only its failed state** — success is
  what deletes the evidence. Cost: six green milestone tests, one of them
  written for this exact failure mode (FM3), against a build where the feature
  did not work at all on the only path a PM takes.

## Domain rules that must not drift
- Framework: IPMA ICB4 v4.0.1 — 3 areas, 28 competence elements, **133 controls
  (132 active, 1 inactive)**. Inactive controls contribute nothing to any rollup.
- Scale: APM 0–5 Application axis — Unaware · Aware · Practised · Competent ·
  Proficient · Expert. The PM picks a **label**, never a number; numbers are stored
  underneath. Build the scale as a swappable module (a PDCF variant may be added later).
- Scores: `self_level` (PM) and `assessor_level` (authoritative, shows in results).
  The assessor reviews and revises — accept as-is or override specific controls.
- Targets come from the selected APM benchmark profile (default Intermediate).
  Targets are **not** rolled up or averaged; they are published values.
- Rollup per competence element: **mean of assessor scores across active controls**,
  with the **weakest control** shown alongside.
- Health: Role Ready (at/above target) · Minor Gap (within half a level below) ·
  Capability Deficit (more than half a level below, or any single control 2+ levels
  below its own target).
- ICB4 source text is **never edited**. KIB clarifications are added in their own
  field alongside it.
- The tool **supports a decision, never gates one** — no pass/fail verdicts.
- **The primary button names what the click COMPLETES if it completes
  something, and otherwise names where it GOES** (owner, N38/N39/N40).
  Completion is a fact about ANSWERS and is asked of answers; position decides
  only where you go, and the two must never share an expression — that shared
  expression was N30, N33, N38 and N40, four times. "Completes something" is
  narrower than "is now whole": re-opening a competency that was already
  finished completes nothing, and the button must not claim otherwise.
- Language: never use "interest" in the financial sense (Sharia-compliant bank);
  use "profit rate" / "rate of return" / "return".

## Skill routing (gstack)

gstack is installed automatically by the SessionStart hook. When a request
matches a skill, invoke it via the Skill tool rather than answering ad hoc —
the skills carry checklists and quality gates. When in doubt, invoke the skill.

### The loop (owner's, 2026-08-07)

The order things happen in. Not every stage fires for every change — the
trigger column says when.

| # | Stage | Skill | Fires when |
|---|---|---|---|
| 1 | Is it worth building | `/office-hours` | a new idea or a scope question |
| 2 | Scope and ambition | `/plan-ceo-review` | anything larger than a fix |
| 3 | How it should feel | `/design-consultation`, then `/plan-design-review` | the change is visible to a PM |
| 4 | Architecture | `/plan-eng-review` | **gate** — the plan must end with no unresolved decisions |
| 5 | Backlog item | `/spec` | the work is being handed off or deferred |
| 6 | **Build** | — | to the approved plan, not around it |
| 7 | Diff review | `/review` | **gate — before merge** |
| 7b | Security | `/cso` | **only** a diff touching auth, sessions, storage, or the allowlist |
| 8 | Does it actually work | `/qa` | **gate — before merge**, against the preview build |
| 9 | Ship | `/ship`, then `/land-and-deploy` | |
| 10 | Production | — | **the owner's own pass, by hand** |
| 11 | Release notes | **`/ship` writes the `CHANGELOG.md` entry**, `/document-release` polishes it and syncs the rest | a user-visible change shipped |
| 12 | Product documentation | `/document-generate`, **consolidated into `docs/user-guide.md`** | **every feature** — the manual is kept current, not appended to |
| 13 | Compound | `/retro`, `/learn` | weekly |
| ⚡ | Something is broken | `/investigate` | **an interrupt, at any point** — never a scheduled stage |

**Ground rules, each paid for once.**

1. **A gate that has never run is not a gate.** `/qa` sat unrun for three days
   on a branch carrying the hottest screen in the product. That is how N33
   reached the owner.
2. **A review round that produces non-trivial fixes gets reviewed.** Measured
   here: `/review` on the N33 fix found two defects *in the fix*, one of them a
   fresh regression. Repair-then-merge is how a fix ships a new bug.
3. **Every finding gets a written answer — fixed, or why it is a false
   positive.** Same rule the SonarCloud section already states, for the same
   reason: an un-triaged list trains the next reader to skim.
4. **Conditional gates stay conditional.** `/cso` on auth and storage diffs,
   `/design-review` on visual ones. Firing everything every time is the
   banner-on-every-save failure.
5. **Docs are part of the diff, not a follow-up.** Three doc claims went stale
   inside one day and a review pass had to catch them.
6. **No fix without a root cause** — `/investigate`'s own iron law, and what
   turned "sometimes it works" into a one-line mechanism.
7. **The product documentation is a manual, not a changelog.** `docs/user-guide.md`
   describes the product as it is today. History belongs in
   `docs/pilot-feedback.md` and the release notes; a manual that accretes
   "and then we added…" stops being usable at about the third feature.

**Which skill owns which document — checked against the skills, not assumed.**

| Document | Written by | Notes |
|---|---|---|
| `docs/user-guide.md` | `/document-generate` | Left alone it emits a Diátaxis *set* (`docs/reference-*.md`, `docs/explanation-*.md`, separate how-tos). **Point it at the single manual**, or it scatters files. |
| `CHANGELOG.md` | **`/ship`** (its Step 13, from the diff) | Does not exist yet; `/ship` creates the first entry on the first real release. |
| Changelog polish, README / ARCHITECTURE / CONTRIBUTING / CLAUDE.md sync, TODOS, diagram drift | `/document-release` | It is a post-ship docs SYNC, not a release-notes author. Its own rule: *"Never clobber CHANGELOG. Polish wording only."* |
| `docs/pilot-feedback.md` | `/investigate` | One entry per defect, with the mechanism. |
| `docs/STATUS.md` | whoever ships the change | Current state and open decisions, in the same diff as the code. |

| Situation | Skill |
|---|---|
| Bug, error, "why is this broken" | `/investigate` |
| Review the diff before landing | `/review` |
| Does the running app actually work | `/qa` (or `/browse` to drive it) |
| UI drifted from DESIGN.md | `/design-review` |
| Ship / deploy / open a PR | `/ship` or `/land-and-deploy` |
| Architecture of a new plan | `/plan-eng-review` |
| Security / OWASP pass | `/cso` |
| New product idea or scope question | `/office-hours` |
| Save or resume working context | `/context-save`, `/context-restore` |

### Gates that are not optional

Standing rule, set by the owner on 2026-08-05 after two code PRs merged the
same day having been checked only by their author and their tests. Four
defects reached the owner's preview that a review pass exists to catch.
`/review` is the staff-engineer pass — adversarial subagent, cross-model
challenge, doc-staleness check — and it is not the same thing as having
written tests.

| Before this | Run |
|---|---|
| **Merging anything containing code** | `/review` on the diff |
| A diff touching **auth, sessions, storage, or the allowlist** | `/cso` as well |
| A **user-visible** change reaching a **preview someone is about to use** | `/qa` against that preview, before the merge |
| **Any push containing code** | Read the **SonarCloud** findings for it |

**`/qa` runs ONCE, on the preview. Production is the owner's own pass** (owner's
call, 2026-08-06). There used to be a second row here — `/qa` after it deploys —
and it was removed deliberately, so do not restore it: the owner is the second
level of QA on production and does it by hand. Two automated passes over the
same build would be the banner-that-fires-on-every-save failure, and the later
one lands after the nine PMs already have it.

That places the whole weight on the preview run, which is exactly where it
belongs and also where it is easiest to skip. **N33 is why.** The milestone
never rose on the path a PM walks; it was invisible to 336 green tests and to a
full `/review` (five specialists, a red team, an adversarial pass), because a
diff-reading pass can only check that the code does what the diff says. It
cannot notice that every test describes a user who does not exist. It took
ninety seconds of clicking to find, and the owner found it — on a branch that
had carried three days of user-visible work with `/qa` never once run.

**`/qa` CAN drive the real Vercel preview from this container. Solved
2026-08-07, and the two earlier versions of this paragraph were both wrong** —
recorded because each wrong version pointed at a fix the owner would have had to
make, and neither was needed.

- Wrong once: "the preview is unreachable". It is reachable.
- Wrong twice: "deployment protection blocks it; a bypass token would unlock the
  browser". The token was never the browser's problem, and no Vercel setting or
  environment network policy needed changing.

**The actual cause: the egress proxy's TLS interception resets Chromium's
TLS 1.3 handshake.** `curl` and node `fetch` negotiate differently and get
`200`. Chromium got `ERR_CONNECTION_RESET` on *every* external host until the
handshake was capped. Disabling ECH, QUIC, HTTP/2 and post-quantum key agreement
all failed; `--ssl-version-max=tls1.2` works.

The recipe, verified against `/login`, `/assess`, `/results` and `/review` with
assets loading, redirects correct and no page errors:

```js
chromium.launch({
  executablePath: "/opt/pw-browsers/chromium",
  args: ["--ssl-version-max=tls1.2"],        // the proxy resets TLS 1.3
  proxy: { server: process.env.HTTPS_PROXY },
})
// and on the context, so every request carries it — assets and RSC included:
{ extraHTTPHeaders: { "x-vercel-protection-bypass": process.env.Vercel_deployment_ByPass } }
```

The bypass secret lives in this environment as `Vercel_deployment_ByPass`. It is
a secret: pass it by env reference, never print it, never commit it.

**So `/qa` runs against the real preview URL, and the report says so.** If a run
ever falls back to a local production build — a proxy change, a missing secret —
that is a different target and the report must name it, so nobody reads
"preview: clean" and believes Vercel was tested.

**SonarCloud.** The project is analysed at sonarcloud.io. Every finding gets
one of two answers, and the answer is written down: *fix it*, or *why it is a
false positive here*. A finding left un-triaged is the same as an unread
warning — it trains the next reader to skip the list.

**Access, re-measured 2026-08-06 — the previous entry here was wrong.**
`sonarcloud.io` **is** reachable from this environment, and the project is
public, so findings can be read with no `SONAR_TOKEN` at all:

    curl -s "https://sonarcloud.io/api/issues/search?componentKeys=nayefharb-hub_Competency-Assessment-Platform&resolved=false&ps=100"

So triage no longer waits on the owner pasting a list. What DOES still gate it:
**the last analysis was 2026-08-04**, before PRs #19–#24, and SonarCloud only
applies exclusions on the next run. Until Automatic Analysis is switched on (or
a CI scanner is wired up), the API returns a stale list and reading it would be
worse than not reading it — it describes a codebase four PRs ago.

Re-measure rather than trusting this paragraph; it has been wrong once.

Deliberately **not** "before every push". Most pushes here are documentation,
and a full adversarial pass on a `STATUS.md` edit teaches everyone to skim the
output — the same failure mode as a banner that fires on every save. The
trigger is the **merge**, not the push, and only when code is in it.

**Most relevant next:** once the app is wired to Supabase, run `/review` on the
diff, `/qa` against the running app, and `/design-review` to check the built UI
against `DESIGN.md` — then `/ship`.

Note: in Claude Code on the web only the top-level `gstack` router is registered
as a slash command; the sub-skills are invoked by name or in plain language
("run office hours on…", "review this diff"), not as `/qa`-style commands.
