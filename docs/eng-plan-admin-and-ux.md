# Engineering Plan: admin control, archive, and the UX pass

Status: PLAN — for `/plan-eng-review`
Branch: `claude/cap-supabase-integration-ubitap`
Source: `docs/pilot-feedback.md` notes N4–N13, all raised while using the
deployed app.

Covers everything logged after the Supabase wiring merged (#5). Three PRs, not
one, because this is a schema change, an auth change and a visual change, and
they fail in different ways.

## Decisions already taken (do not re-litigate)

| Decision | Owner's words |
|---|---|
| Assessments are **assigned by the admin**, not created by visiting `/assess` | N7 |
| Admin sets a password on create; user **must change it on first sign-in** | N9 |
| `must_change_password` **applies to existing accounts too**, including the owner's | this plan |
| The owner's existing auto-created draft is **deleted**, not backfilled | this plan |
| Deletion keeps an **archive**, so the completion metric stays reconstructible | N6 |
| Preview/Development env scopes removed from the secret keys | N1 |
| Palette work goes through the gstack design skill, light and dark together | N11, N12 |

## Constraint that shapes everything: migrations are applied by hand

`supabase/migrations/*.sql` are pasted into the Supabase SQL Editor by a human.
No CLI, no `schema_migrations` table (N1b). Consequences:

1. **The migration must be applied BEFORE the code merges.** Vercel deploys on
   merge to `main`; code referencing a missing column fails at request time, not
   build time, so it would deploy green and then 500.
2. **The migration must be additive and safe to re-run.** New columns nullable
   or defaulted, guarded with `if not exists`. No column drops, no type changes.
3. Old code must survive the new schema (it ignores unknown columns), so the
   window between "migration applied" and "code merged" is safe in both
   directions.

## PR A1 — admin People screen and the password gate

Split from assignment after the Step 0 complexity check (14 files, 3 new
modules). N8 blocks the pilot — there is no way to add a PM without a terminal.
N7 does not: auto-create works today, it is merely dishonest about the
denominator. So the unblocking half ships first.

Adding an "Assign" button to an existing People screen later is additive, not a
rewrite, so the split costs nothing.

### Migration `0003_assignment_and_archive.sql` (ships with A1)

One migration for all three PRs. Two hand-pasted migrations is two chances to
apply one and forget the other (N1b: nothing records what has been applied).

```
app_user.must_change_password  boolean not null default false
assessment.assigned_at         timestamptz
assessment.assigned_by         uuid references app_user(id)
assessment.archived_at          timestamptz          -- PR B uses these,
assessment.archived_by          uuid references app_user(id)   -- added now so
assessment.archived_reason      text                 -- there is one migration
```

> These three were originally added as `deleted_at`/`deleted_by`/`deleted_reason`
> by migration 0003 and renamed to `archived_*` in **0006** (2026-08-12): the
> feature never deletes — it archives, keeping the row, its scores and its
> timings — so the schema was made to say so.

Also, per the decision above:

- set `must_change_password = true` for **every existing** `app_user`;
- delete the owner's auto-created draft assessment (one row today; the delete is
  written to target auto-created rows — `assigned_at is null` — so it stays
  correct if more appear before it runs).

Columns for PR B are created in the same migration deliberately: two hand-pasted
migrations is two chances to apply one and forget the other.

### Code

- **`lib/db/people.ts`** (new) — create an account (auth user + `app_user` row),
  set `must_change_password`, reset a password, list people.
- **`app/admin/people/page.tsx`** (new) — admin only: list, add, reset password.
- **`app/change-password/page.tsx`** (new) — `auth.updateUser({ password })` on
  the current session. No email involved. Reachable voluntarily too, not only
  when flagged, so "change my own password" (N9 part 1) lands here for free.
- **`lib/auth.ts`** — the gate. See the three findings below; this is the file
  where this PR is most likely to fail silently.
- **`scripts/invite.mjs`** — `remove` refuses when the person has assessment
  data unless `--force`. Today the destructive path is the default, and it
  hard-deletes a live assessment through `on delete cascade` (verified).

### Review findings folded in — these are the plan, not commentary

**F1 [P1] — the column list makes the gate fail silently.**
`lib/auth.ts:69` selects explicitly:
`.select("id, email, full_name, job_title, role")`.
Add `must_change_password` to the table but forget it here and
`user.must_change_password` is `undefined` → falsy → the gate never fires,
nobody is forced to change anything, and **nothing errors**. A security control
that is off with no signal is worse than one that was never built, because the
plan says it exists. Add the column to the select in the same commit as the
migration, and add an e2e assertion that a flagged user is actually redirected —
that test is the only thing that would catch this.

**F2 [P1] — the gate must not create a redirect loop.**
`/change-password` needs the signed-in user, so it will want `requireUser`. If
`requireUser` redirects flagged users to `/change-password`, that is infinite.
Same shape as the `/logout` bounce already at `lib/auth.ts:72`. Fix: an explicit
`requireUser({ skipPasswordGate: true })` used by exactly one page, or a
separate `currentAppUser()` for that route. Name it in the code, or someone
re-adds the loop later.

**F3 [P1] — the gate cannot live in `proxy.ts`.**
`proxy.ts:11` lists `PUBLIC_PATHS = ["/login", "/logout"]` and the file's own
header explains why role checks are not there: the proxy runs on the edge with
only the anon key and cannot read `app_user`. The password flag has the same
constraint. It belongs in `requireUser` only. Stated here because "add it to the
middleware" is the obvious-looking wrong answer.

**F4 [P2] — `lib/db/people.ts` duplicates `scripts/invite.mjs:75-98`.**
Both write the same two halves of an account. They cannot share code: the script
is plain Node ESM, the lib is TypeScript with `server-only` and `@/` aliases
that Node will not resolve. So the duplication is structural, not laziness.
Keep it small, comment each side pointing at the other, and let e2e assert both
produce a sign-in-able account with the flag set.

### Tests

No unit test framework exists — verified: no jest/vitest/playwright config and
no `npm test`. The only automated coverage is `scripts/e2e.mjs` (67 assertions
through a real browser, then checked in Postgres). For a password gate that is
the *right* level: it proves the control cannot be bypassed by navigating, which
a unit test cannot. Not introducing a unit framework for this PR.

New e2e coverage:

- a flagged user is redirected to `/change-password` from **every** route, not
  just the home page (this is the F1 regression test);
- the gate cannot be bypassed by direct navigation to `/assess`, `/results`,
  `/admin`, or by a server action posted straight to the endpoint;
- changing the password clears the flag and the user reaches the app;
- `/change-password` itself is reachable while flagged — the F2 loop test;
- an admin can add a person, and that person can sign in with the password set;
- a non-admin cannot reach `/admin/people`;
- `invite remove` refuses a person holding assessment data, and `--force`
  overrides.

## PR A2 — assignment

- **`lib/db/assessment.ts`** — delete `getOrCreateAssessment`; `findAssessment`
  becomes the only read. Add `assignAssessment(admin, assesseeIds[], cycle)`,
  bulk and idempotent against `unique (assessee_id, cycle)`.
- `completionStats` — denominator becomes count of assignments in the cycle.
  Delete the `Math.max(invitedCount, ...)` fudge, the `assessee_is_pm` filter,
  and the "not counted" banner on the review overview. All three exist only to
  compensate for assessments appearing unbidden.
- **`app/assess`, `app/assess/controls`, `app/page.tsx`, `app/results`** — an
  honest "nothing has been assigned to you yet" state instead of manufacturing
  a record.
- **`scripts/demo.mjs`** — its error string currently reads "Open /assess in the
  app once (that creates it)". After A2 that is false. Fix in the same PR: a
  message that says an admin must assign the cycle first. A help string that
  lies is worse than none.
- **`scripts/e2e.mjs`** — every current test assumes an assessment exists on
  first visit. The rewrite ships with A2, not after.

## PR B — archive instead of destroy — SHIPPED 2026-08-04

Depends on A1 (columns already exist) and reads better after A2.

**One thing this plan got wrong, found while building it:** "columns already
exist, so no migration" was true of the columns and false of the constraint.
`0001` declares `unique (assessee_id, cycle)`, which an archived row still
occupies — so archiving somebody's cycle would permanently block re-assigning
it to them. Migration `0004` replaces it with a partial unique index over live
rows. Verified against the live database, not reasoned about: the insert is
refused with `duplicate key value violates unique constraint`.

- `archiveAssessment(admin, id, reason)` sets `archived_at`/`archived_by`/
  `archived_reason`; every read path filters `archived_at is null`.
- `completionStats` states its rule on screen — "5 finished · 1 archived,
  excluded" — so the number explains itself rather than silently moving (N6).
- Hard delete stays a deliberate script run for a data-protection request.

## PR C — the UX pass

Gated on the design consultation, which must cover light **and** dark together
so they do not drift (N11, N12).

- **N11** — cap prose at ~68ch and raise line height first; measured at 131
  characters per line against a comfortable 45–75, which is the dominant cause.
  Then the palette, via the design skill, with `DESIGN.md` updated in the same
  change or it stops being the source of truth.
- **N12** — Light / Dark / Match system, persisted per user, applied as
  `data-theme` on `<html>`.
- **N10** — mobile: stack the header (currently ~200px of chrome on every
  screen), fix `.sec-head` colliding with its eyebrow, render the People table
  as cards below 560px.
- **N5** — filter the controls list by scored/not scored, via a query parameter
  rather than the app's first client component. Progress counts must keep
  reporting the whole assessment under filtering.
- **N4** — scored-state emphasis, decided **after** N5, since a filter may mean
  the badges want quietening rather than amplifying.

## Verification

Per PR, not once at the end: `/review` on the diff, `/qa` against a local server
pointed at the real database, `/design-review` for PR C, then `/ship`.

`npm run verify:db` (11 checks) and `npm run e2e` must both pass before each
merge.

**Known limit:** this environment cannot reach `*.vercel.app`, so nothing here
verifies the deployed result. Every claim is about the code and the database,
never about production. Confirming the live URL is the owner's step.

## Risks

| Risk | Handling |
|---|---|
| Code merges before the migration is applied → **everyone is signed out**, not a 500 | Verified against the live database: selecting `must_change_password` before it exists returns `column app_user.must_change_password does not exist`, so `requireUser` sees `row.error`, treats it as "not on the allowlist" and redirects to `/logout?denied=1`. It fails CLOSED, which is the right direction, but the message is misleading. Migration is additive and must be applied first; A1 does not merge until confirmed |
| Owner locked out by their own `must_change_password` flag | intended — it also rotates the password exposed in a session transcript. `/change-password` is reachable while the flag is set |
| e2e rewritten at the same time as the behaviour it tests | new assertions written against the intended behaviour first, then the code; both reviewed in the same diff |
| Design consultation changes the locked palette | `DESIGN.md` updated in the same commit, with the rationale |
| Archive columns added in PR A but unused until PR B | deliberate; one hand-pasted migration rather than two |

## Alternatives considered and rejected

**`must_change_password` in Supabase `app_metadata` instead of a column.**
It is service-role-writable only and arrives in the JWT, so it needs no
migration and no extra query — genuinely lighter. Rejected because the migration
exists anyway for assignment and archive, making the column free, and because
`app_user` already mirrors `auth.users` for exactly this kind of state.
Splitting user state across two stores to save a column that costs nothing is
the wrong trade. Recorded so it is not re-proposed as a discovery.

**A unit test framework for the password gate.** Rejected for this PR: the
control being tested is "cannot be reached by navigation", which is an
end-to-end property. Adding jest/vitest to assert a boolean would be ceremony.
Revisit when the rollup maths changes — `median()` and level parsing are what
unit tests are actually for.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 1 scope reduction accepted; 4 findings folded into the plan (3× P1, 1× P2) |
| Design Review | `/design-consultation` | PR C palette, light + dark | 0 | PENDING | gates PR C only |
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | not run (optional) |
| Outside Voice | independent challenge | 2nd opinion | 0 | — | not run; single-reviewer plan |

**Step 0 scope challenge:** complexity check triggered (14 files, 3 new
modules). PR A split into A1 (People screen + password gate, unblocks the
pilot) and A2 (assignment, metric denominator, e2e rewrite). Accepted by owner.

**Findings:**

- **F1 [P1] (9/10)** `lib/auth.ts:69` — explicit column list means a missing
  `must_change_password` leaves the gate silently off, with no error.
- **F2 [P1] (9/10)** `lib/auth.ts:62-74` — `/change-password` calling
  `requireUser` creates an infinite redirect; same shape as the existing
  `/logout` bounce at line 72.
- **F3 [P1] (8/10)** `proxy.ts:11` — the gate cannot live in the proxy, which
  runs on the edge with only the anon key and cannot read `app_user`.
- **F4 [P2] (8/10)** `scripts/invite.mjs:75-98` — unavoidable duplication with
  `lib/db/people.ts`; Node ESM cannot import the TypeScript lib.

**Test posture:** no unit framework exists; coverage is `scripts/e2e.mjs`, 67
browser-driven assertions verified against Postgres. Correct level for a
navigation-bypass control. Seven new assertions specified for A1.

**Environment limit:** this session cannot reach `*.vercel.app`. Nothing here
verifies the deployed result; every claim is about code and database.

**VERDICT:** ENG CLEARED — ready to implement A1.

NO UNRESOLVED DECISIONS
