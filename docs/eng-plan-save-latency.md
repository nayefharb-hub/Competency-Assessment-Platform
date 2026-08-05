# Eng plan: cut the save round trips (N18 step 2, measured)

Status: REVIEWED — /plan-eng-review passed 2026-08-05 (report at bottom).
Awaiting the owner's A/B/C decision (D1) before any code is written.

## Problem, measured

Saving one control feels like 1–1.5s. Measured on 2026-08-05 (ten real saves
against localhost, network ≈ 0, method in `docs/pilot-feedback.md` → N18):

| | median |
|---|---|
| wall, click → next control on screen | 1327ms |
| the POST (action + render of next control, one response) | 1250ms |
| client work | ~55ms |

The POST decomposes into **seven sequential Supabase round trips**:

```
ACTION PASS                              RENDER PASS (same POST)
auth getUser()            ~145ms   ◄──── auth getUser()            ~145ms
app_user select           ~180ms   ◄──── app_user select           ~180ms
assessment select         ~185ms   ◄──── assessment select         ~180ms
score upsert              ~180ms
```

The two passes do not share React's `cache()` scope, so `viewer()` runs twice
per save. Every call pays the regional RTT in series. A PM saves 132 controls
per cycle; this is the dominant felt cost in the product's core loop.

Constraint carried from the Fluid Compute audit (`docs/deploy.md`): **no
per-user state at module scope.** Anything here that caches per-user data
across requests is an explicit, argued exception or it does not ship.

Constraint carried from N19 (`lib/auth.ts`): the three-state viewer —
anon / uninvited / **unavailable** — is load-bearing. "Could not read the
allowlist" must never collapse into "not invited". No change here may
reintroduce that collapse.

## What already solves part of this

- `viewer()` is already `cache()`d **within** a pass — the layout + page double
  lookup was fixed in PR #9. The remaining duplication is across passes.
- `proxy.ts` already skips network validation by design (cookie presence only);
  there is nothing to remove there.
- `lib/framework.ts` already memoizes the framework in-process — the render
  pass pays no framework round trips. The pattern for an argued module-scope
  cache exists there.

## Option A — local JWT verification + cross-pass dedupe (recommended)

Two independent steps; each is worth shipping alone, together they take the
save POST from 7 round trips to 3.

### A1. Verify the session token locally

Replace the `auth.getUser()` network call in `viewer()` with local JWT
signature verification via `auth.getClaims()`.

- **Precondition (owner, dashboard):** the Supabase project must use
  asymmetric JWT signing keys (RS256/ES256). Supabase → Project Settings →
  JWT keys → migrate. With the legacy HS256 shared secret, `getClaims()`
  falls back to a network call and A1 buys nothing. The migration is
  Supabase-supported and reversible; existing sessions survive it.
- supabase-js fetches the JWKS once and caches it in-process; verification
  after that is CPU-only (~0ms vs ~145ms).
- **Failure mode:** JWKS unreachable on a cold instance → `getClaims()`
  rejects → treated exactly as an invalid token today (anon → /login). The
  session cookie is intact, so a retry recovers. Same shape as today's
  network-failure behaviour, not a new one.
- **Hardening (from /cso):** after `getClaims()`, assert
  `claims.role === "authenticated"` and `claims.sub` present before the
  `app_user` lookup. The allowlist already backstops this — a non-session
  token has no `app_user` row — but the assert makes the intent explicit and
  costs one line. Verified in auth-js source: every verification failure path
  (`alg:none`, HS downgrade, unknown `kid`, missing WebCrypto) falls back to
  server-side `getUser()`, never to trust.
- **Revocation window, stated honestly:** `getUser()` asks Supabase "does this
  session still exist", so a deleted/banned user dies on the next request.
  Local verification accepts any *unexpired, signed* access token — a deleted
  user's token stays good until expiry (project default: 1 hour). For this
  app the practical gate is the allowlist: deleting someone from `app_user`
  (the actual off-boarding action, People → archive) still locks them out on
  the very next request, because the `app_user` select remains. Only
  deletion at the *Supabase auth layer* gains the ≤1h window, and that is not
  an operation the product exposes. Recorded in deploy.md either way.

### A2. Dedupe viewer + assessment across the two passes of one save

A module-scope, token-keyed micro-memo:

```ts
// lib/auth.ts — EXPLICIT exception to the "no per-user state at module
// scope" rule; argued in docs/deploy.md → Fluid Compute. Keyed by the full
// access token: two users can never share an entry. TTL 2s: long enough to
// span action→render inside ONE request, far too short to serve a second
// human interaction. LRU-capped at 200 entries.
const viewerMemo = new TTLMap<string, Viewer>(2_000, 200);
```

- `viewer()` consults it keyed by the raw access token before doing work;
  only `status: "ok"` results are memoized (never `unavailable` — a transient
  DB failure must not be replayed for 2s, that would widen the N19 blast
  radius, and never `anon`/`uninvited` — cheap to recompute, dangerous to
  cache).
- **`signOut()` purges the token's memo entry** (review D3). Without this,
  a captured token would skip even the allowlist check for up to 2s after
  logout. One line; removes the window entirely; e2e gains a
  logout-then-replay check.
- Token strings are memo keys: they are **never logged** and the map is
  bounded, so an instance holds at most 200 tokens for at most 2s — no worse
  than the in-flight requests themselves.
- `TTLMap` is a ~15-line shared utility in `lib/` with its own unit test,
  used by both the viewer memo and the assessment memo — one implementation,
  not two.
- `findAssessment(userId, cycle)` gets the same treatment in the save path
  only (the assessment row's id/state for a draft does not change between the
  action and its own render).
- The write path (`score upsert`) is never cached.
- **Why not AsyncLocalStorage:** Next gives us no request entry point we own
  to seed a store that both the action pass and render pass would read; the
  token-keyed TTL memo achieves the same dedupe with a bounded, argued risk.
- **Fluid audit consequence:** deploy.md's audit section gains this entry with
  the key/TTL/size reasoning, and the rule's wording changes from "none
  exists" to "one argued exception exists, here is why it cannot leak".

### Net effect (per save POST)

Corrected in review (D4): the first version of this table claimed
~180–250ms prod for A1+A2, which three sequential DB calls at the measured
~107–136ms each cannot hit. Estimates below use measured per-call costs.

| | round trips | est. local | est. prod server |
|---|---|---|---|
| today | 7 | ~1250ms | ~500ms |
| A1 only | 5 | ~950ms | ~380–450ms |
| A1+A2 | 3 (app_user, assessment, write) | ~550–700ms | ~320–400ms |

Production adds the user's ~200–260ms network on top: felt save lands around
**550–650ms**, from 1000–1500ms today. Good, not "instant".

**Named follow-up, deliberately deferred (D4): the save RPC.** The only way
below 3 round trips is a small Postgres function that finds the assessment
and upserts the score in **one** call (`.rpc("save_self_score", …)`),
taking the action to ~2 calls ≈ ~250ms prod server. It adds SQL surface and
migration + e2e coverage, so it waits until A1+A2 is measured — if the felt
number is already acceptable, it never ships. It is recorded here so the
option is a decision, not a rediscovery.

## Option B — dedupe only (A2 without A1)

Same memo, `getUser()` stays a network call. 7 → 5 round trips. Roughly a
third of the win, none of the JWT surface, still needs the same Fluid
exception argued. Kept as the fallback if the JWT-key migration is unwanted.

## NOT in scope

- **Step 3 (the design change — fewer, batched saves).** Stays parked until
  this lands and is re-measured; it may no longer be needed.
- Embedding role/allowlist in JWT claims (invite-time custom claims). Bigger
  blast radius (invite flow, claim staleness on role change) for marginal
  gain over A2. Revisit only if A1+A2 measures short.
- Any change to `proxy.ts`, the password gate, or the three-state viewer
  semantics.
- N23 (typo'd email UX) — separate decision, separate PR.

## Test plan

- e2e: all 186 existing checks must stay green unmodified — they are the
  behavioural contract for auth, gates, and saves.
- e2e additions:
  - a save with a cookie-tampered token is rejected (signature actually
    checked locally);
  - **logout-then-replay (D3): after /logout, a request replaying the old
    access token is refused immediately — proves the memo purge**;
  - archive-while-signed-in: archived user's next request is refused (the
    allowlist gate survives A2's 2s window — test sleeps past TTL);
  - `unavailable` is never memoized: simulated failing app_user read twice in
    a row produces two reads, not a cached failure;
  - **round-trip-count assertion: one warm save emits exactly the expected
    number of `[supabase` log lines — the 7→3 claim is asserted, not
    estimated, and a regression that quietly re-adds a call fails the suite.**
- unit: `TTLMap` (expiry, LRU cap, delete).
- `scripts/perf-save.mjs` (the measurement script) is promoted into the repo
  and run before/after; the numbers go into the PR body. The claim "3 round
  trips" is asserted by counting `[supabase` log lines per save in the
  before/after runs, not estimated.

## Rollout

1. A2 first (no dashboard dependency), measure, ship.
2. Owner flips the JWT signing keys in Supabase dashboard.
3. A1, measure, ship.
4. Re-measure production Function Start Type + save timings; update N18 with
   the closing numbers; decide whether step 3 is still worth designing.

## GSTACK REVIEW REPORT

| Run | Section | Status | Findings |
|---|---|---|---|
| 1 | Scope (Step 0) | PASS | 5 files touched, 1 tiny new utility — under every complexity threshold. Framework built-in check verified against source: `auth-js@2.112.0` JWKS cache is module-global (`GoTrueClient.js:56`), HS256 falls back to network (quoted) — A1's precondition and caching claims hold. |
| 2 | Architecture | 1 finding | [P2] (8/10) sign-out did not purge the A2 viewer memo → **D3: purge on signOut**, accepted; logout-replay e2e added. |
| 3 | Code quality | PASS | Refinements folded in: TTLMap as one shared `lib/` utility with unit test; token keys never logged; only `ok` memoized. |
| 4 | Tests | PASS (additions) | Coverage traced per path; round-trip-count assertion added so 7→3 is asserted, not estimated; 186 existing checks are the behavioural contract and stay unmodified. |
| 5 | Performance | 1 finding | [P2] (7/10) A1+A2 prod estimate was optimistic (~180–250ms vs what 3×~120ms calls can hit) → **D4: table corrected to ~320–400ms; save RPC named as deferred follow-up**, accepted. |
| 6 | Outside voice | SKIPPED | codex unavailable in this environment — single-model review, noted rather than hidden. |

VERDICT: SOUND — both options are buildable as specified; A (A1+A2) remains the
recommendation. The plan honours the N19 three-state viewer, argues its single
Fluid-rule exception explicitly, and its numbers are now measured-or-derived,
not asserted. Decisions D3 and D4 are resolved and folded into the body above.
The remaining decision is the owner's original D1 (A / B / C), which this
review deliberately does not pre-empt.

NO UNRESOLVED DECISIONS

## CSO AUDIT (2026-08-05, --scope auth)

Six attack scenarios traced against the plan, with the failure paths verified
in `@supabase/auth-js@2.112.0` source rather than assumed: algorithm
confusion, kid injection, deleted-user token replay, cross-instance memo
replay after logout, cross-user memo bleed, cached-failure amplification.
**Findings at the 8/10 gate: none.** One hardening note (the role/sub claim
assert) folded into A1 above. The decisive property: every getClaims failure
path degrades to server-side validation, never to trust, and both options
preserve the allowlist select — the gate that actually governs access.
