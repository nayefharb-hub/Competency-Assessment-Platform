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

## PR A — assignment, admin People screen, password gate

The largest piece. Everything here ships together because the app cannot half
have an assignment model.

### Migration `0003_assignment_and_archive.sql`

```
app_user.must_change_password  boolean not null default false
assessment.assigned_at         timestamptz
assessment.assigned_by         uuid references app_user(id)
assessment.deleted_at          timestamptz          -- PR B uses these,
assessment.deleted_by          uuid references app_user(id)   -- added now so
assessment.deleted_reason      text                 -- there is one migration
```

Also, per the decision above:

- set `must_change_password = true` for **every existing** `app_user`;
- delete the owner's auto-created draft assessment (one row today; the delete is
  written to target auto-created rows — `assigned_at is null` — so it stays
  correct if more appear before it runs).

Columns for PR B are created in the same migration deliberately: two hand-pasted
migrations is two chances to apply one and forget the other.

### Code

- **`lib/db/assessment.ts`**
  - delete `getOrCreateAssessment`; `findAssessment` becomes the only read.
  - add `assignAssessment(admin, assesseeIds[], cycle)` — bulk, idempotent
    against `unique (assessee_id, cycle)`.
  - `completionStats`: denominator becomes count of assignments in the cycle.
    Delete the `Math.max(invitedCount, ...)` fudge and the `assessee_is_pm`
    filter — both existed only to compensate for assessments appearing
    unbidden (N7).
- **`lib/db/people.ts`** (new) — create an account (auth user + `app_user` row,
  the two halves `scripts/invite.mjs` writes), set `must_change_password`, reset
  a password, list people with their assignment state for the cycle.
- **`app/admin/people/page.tsx`** (new) — admin only. List, add, assign, reset
  password. One screen; N8 and N9 are the same workflow as N7.
- **`app/change-password/page.tsx`** (new) — `auth.updateUser({ password })` on
  the current session. No email involved.
- **`lib/auth.ts`** — `requireUser` sends anyone with `must_change_password` to
  `/change-password` and refuses every other route until it clears. Server-side;
  a UI nudge would be decorative.
- **`app/assess`, `app/assess/controls`, `app/page.tsx`, `app/results`** — handle
  "nothing assigned to you yet" honestly instead of manufacturing a record.
- **`scripts/invite.mjs`** — `remove` refuses when the person has assessment
  data unless `--force`. Today the destructive path is the default one, and it
  hard-deletes a live assessment through `on delete cascade` (verified).

### Tests

`scripts/e2e.mjs` currently assumes an assessment exists on first visit; N7
deletes that assumption, so the rewrite ships **with** this PR, not after.
New coverage: assign creates exactly one assessment; an unassigned user sees the
empty state and cannot score; `must_change_password` blocks every route until
cleared; the password gate cannot be bypassed by direct navigation;
`invite remove` refuses a person holding assessment data.

## PR B — archive instead of destroy

Depends on A (columns already exist).

- `archiveAssessment(admin, id, reason)` sets `deleted_at`/`deleted_by`/
  `deleted_reason`; every read path filters `deleted_at is null`.
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
| Code merges before the migration is applied → production 500s | migration is additive and applied first; PR A does not merge until confirmed |
| Owner locked out by their own `must_change_password` flag | intended — it also rotates the password exposed in a session transcript. `/change-password` is reachable while the flag is set |
| e2e rewritten at the same time as the behaviour it tests | new assertions written against the intended behaviour first, then the code; both reviewed in the same diff |
| Design consultation changes the locked palette | `DESIGN.md` updated in the same commit, with the rationale |
| Archive columns added in PR A but unused until PR B | deliberate; one hand-pasted migration rather than two |
