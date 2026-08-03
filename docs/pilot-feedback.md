# Pilot feedback log

Notes taken while using the app, before they turn into changes. Raw intake, not
a plan: things get written down here as they are observed, then triaged.

Kept in the repo rather than in a chat transcript so it survives the session and
so the reasoning behind a later change is still findable.

## How this is used

Each note gets an ID, what was observed, and a status. Nothing is silently
dropped — an item that will not be actioned gets **Won't do** and a reason, so
the decision is recorded rather than forgotten.

| Status | Meaning |
|---|---|
| **Open** | logged, not yet triaged |
| **Fixed** | changed and verified; commit referenced |
| **Won't do** | deliberate, with the reason |
| **Deferred** | real, but out of scope for the pilot |

Anything that blocks testing gets fixed immediately rather than queued — those
are marked **Fixed** with a note that they were blocking.

Sort order is intake order. Severity lives in the note, not the position.

## Notes

### N1 — preview deployments share the pilot database

**Status:** Open · raised during setup, not from using the app

Environment variables were added to Vercel for Production, Preview and
Development. Vercel builds a preview deployment for every pushed branch, so
each one gets its own URL wired to the **same Supabase project as production** —
the real pilot data, not a copy.

Consequences worth deciding on before the nine PMs are invited:

- A branch that is still being worked on can read and write real assessment
  data, including through `scripts/e2e.mjs` if it is ever pointed at a preview.
- Preview URLs are unlisted but not secret. Sign-in still gates everything, and
  RLS denies the anon key, so the exposure is the login page rather than the
  data — but it is one more door.

Options, cheapest first:

1. Untick **Preview** and **Development** for the two secret-bearing variables,
   so only Production can reach the database. Preview builds still deploy; they
   just error on any page that needs data, which is honest.
2. Create a second Supabase project for previews and point the Preview scope at
   it. Costs a second seed run, gives a genuine staging environment.
3. Accept it for a nine-person internal pilot and revisit if the tool goes wider.

**Decision (owner):** option 1 now, option 2 later. Untick Preview and
Development on the two secret-bearing variables so only Production can reach the
database, and stand up a separate Supabase project for staging when there is
reason to. Recorded as N1b.

The Vercel change is in the project's own settings, not in this repo, so it
cannot be made from here — the clicks were handed over instead.

### N1b — separate Supabase project for staging

**Status:** Deferred — wanted, not yet needed

> "yes need a staging setup later"

A second Supabase project, seeded from `supabase/seed.sql` the same way, with
Vercel's Preview scope pointed at it. That turns preview deployments from a
liability into the thing they should be: somewhere to try a change against
fake people before it touches real ones.

What it costs: a second project, one seed run, and a second set of environment
variables scoped to Preview. `scripts/e2e.mjs` should then be pointed at staging
rather than production — it writes, and today the only thing keeping it safe is
that it creates and deletes its own `@example.test` accounts.

Not blocking the pilot. Worth doing before anyone other than the Head of PMO is
making changes, because the value is protecting real data from work in progress.

#### How database changes flow once staging exists

> "what happens when we change the database, we change in staging first test
> then update production?"

Yes — but only for one of the two things that get called a database change.

**Schema changes** (new column, new table, changed constraint) are code: numbered
files in `supabase/migrations/`. Write the migration, run it on staging, point
the app at staging and confirm it works, then run **the same file** on
production. One file, applied twice, in that order.

**Framework content** (a target level, a priority, a `kib_note`, marking a
control inactive) does **not** flow that way. It is edited live in production
through the admin screen, which is the entire reason the framework is stored as
data rather than constants. There is no migration for "change 4.3.1.3's target
to 4", and there should not be.

**The consequence to plan for: the two databases drift, deliberately.** Staging
is seeded once from `supabase/seed.sql`; production then accumulates admin edits
nobody replays into staging. So staging is a good rehearsal for "does this
schema change break the app" and a poor one for "does this work against our
actual framework". Do not treat a green staging run as proof for anything that
depends on edited content — and do not "fix" the drift by syncing production
data down, which would put real assessment records somewhere with weaker access
control.

**Gap to close before two environments exist.** Nothing currently records which
migrations have been applied to which database — they are pasted into the
Supabase SQL Editor by hand, and `0001`/`0002` are tracked only by being in the
repo. With one database that is survivable; with two it becomes guesswork, and
guessing wrong against production is how a column ends up missing in one place.

The cheap fix, worth doing as part of N1b rather than after:

- a `schema_migrations` table (`filename`, `applied_at`);
- every migration inserts its own filename as its last statement;
- every migration written to be safely re-runnable (`if not exists`, guarded
  `alter`), so applying one twice is a no-op rather than an error.

That gives a one-query answer to "what has this database had?" in both places,
which is the only thing that makes a two-environment setup honest.

##### Why git does not already cover this

> "isn't this the role of github, or we will still need the fix as a backup so
> we do not only depend on github"

Neither — it is not git's job, and the table is not a backup of git. They hold
two different facts and neither can answer the other's question.

| Question | Answered by |
|---|---|
| What migrations exist, what do they contain, who wrote them, when? | git |
| Which of them have actually been run against **this** database? | only that database |

The files are byte-identical whether or not anyone has run them, and identical
between staging and production. The difference lives in the databases. So no
amount of looking at GitHub can tell you whether `0003` was applied to
production — you would have to open Supabase, inspect the schema, and reason
backwards ("there is a `notes` column, so `0003` probably ran"). That inference
is the guesswork, and it gets worse with every migration added.

This is not a bespoke invention: a table recording applied migrations is exactly
what Rails, Django, Flyway, Alembic and the Supabase CLI all maintain under the
hood. Hand-applying SQL through the dashboard is the one workflow that skips it.

**The alternative worth weighing:** adopt the Supabase CLI (`supabase db push`),
which keeps this table itself and applies migrations in order. That removes the
hand-paste step entirely and is the better long-term answer. It costs a terminal
and a local toolchain, which is exactly what the current setup has deliberately
avoided. Decide that at the same time as N1b — if the CLI is adopted, the
hand-rolled table is unnecessary.


### N2 — sign-in box suggested a `@kib.com` domain

**Status:** Fixed

> "on login, default mentions enter your email and the next is @kib.com, i don't
> want a default email domain to be put, any domain would work for now"

The field's placeholder read `you@kib.com.kw`. It was only a placeholder — there
is no domain check anywhere: `signIn` lowercases the address and looks it up in
`app_user`, and `invite.mjs` requires nothing but an `@`. So any domain already
worked, but the hint implied a rule that did not exist, which matters for a
product meant to be sold to organisations other than KIB.

Now reads "Your email address". The allowlist is the `app_user` table, not an
email suffix, and the field no longer says otherwise.

### N3 — why is every control on one page?

**Status:** Superseded by N4 — the "is it an admin view?" question is answered
(no), but the visual judgement was overridden

> "after i login and click start assessment why do i see all controls in one
> page, it is because I am an admin? ... unless it is a navigation for the PM
> then that's fine but it should show whether a control has been scored or not yet"

Not an admin view. `/assess/controls` is the same for every role: it is the PM's
navigation and progress screen, which is the case the note calls fine. Scoring
itself is one control at a time on `/assess`.

It already shows scored state at three levels: a progress bar and `N / 132
controls scored` at the top, `0/5 scored` per competence element, and a badge on
every control that turns from "not scored" to a green tick with the chosen level.

Was left alone on the argument that the badges would read differently once an
assessment is part-scored. That argument was put to the owner and rejected —
see N4.

### N4 — scored/not-scored state is too quiet

**Status:** Open — to fix

> "it still feels flat make it louder"

Direct override of the reasoning in N3. The proposal was to wait and judge the
badges against a part-scored list; the answer is to make them louder now.

Context to keep in mind when fixing, because it changes what "louder" should
mean: this was judged on a list where **every** control is unscored, so the page
is 132 identical grey pills with no contrast anywhere. Two different problems
could be causing the flat feeling, and they pull in opposite directions:

1. The scored state is not emphatic enough — fix by making a scored row
   obviously different (weight, colour, a filled marker), not just a small pill.
2. The unscored state is too loud — 132 repetitions of "not scored" is noise
   that says nothing, and the eye has nothing to land on. Fix by making
   unscored quiet or implicit, so that scored rows are the only thing marked.

Option 2 is probably the stronger design: mark the exception, not the rule. But
it should be checked against a part-scored list before committing to it, since
that is the state a PM actually lives in.

Do not fix in isolation — the owner asked for all notes to be collected first.

### N5 — filter the controls list by scored / not scored

**Status:** Open — to fix

> "need a filter on the controls so that the user can filter by the one scored,
> not scored"

Three views on `/assess/controls`: all, not scored, scored.

Notes for the implementation:

- **Do it with a query parameter** (`?show=unscored`), not client state. Every
  page in this app is a server component and there is not a single client
  component yet; a filter is not a good reason to introduce the first one. Links
  keep it shareable, back-button friendly and free of hydration.
- **Keep the counts honest under filtering.** The progress bar and the `N / 132`
  headline must keep reporting the whole assessment, not the filtered subset,
  or the filter quietly becomes a way to misread your own progress. Same for the
  per-element `0/5 scored` labels.
- **Empty states matter here.** "Not scored" on a finished assessment should say
  so plainly rather than render an empty page.

**Related to N4, and possibly the better answer to it.** N4 is "I cannot see
what is left"; a filter answers that directly, where louder badges only make the
scanning easier. Decide them together: if the filter lands well, the badges may
only need quietening (option 2 in N4) rather than amplifying, since the filtered
list makes every visible row mean the same thing anyway.

Worth checking whether this makes the existing "Continue — control N" button
redundant; it already jumps to the first unscored control, which is the same
need answered a different way.

### N6 — can an admin delete an assessment?

**Status:** Open — question answered, design decision outstanding

> "can and admin delete a certain assessment?"

**Today: no.** There is no delete anywhere in `app/` or `lib/` — the app has
never removed an assessment. The only deletion paths are command-line scripts
(`npm run demo reset <email>`, and the cleanup inside `scripts/e2e.mjs`).

Before building one, it is worth separating two needs that look alike:

1. **Undo a wrong transition.** Someone submits before they meant to, or gets
   approved too early. This is the common case and it is not a delete — it is
   moving the record back a state. Scores survive, which is what the person
   actually wants.
2. **Destroy a record.** A test run, a duplicate, someone who left. Rare, and
   genuinely destructive.

Reasons to be careful with (2), beyond the obvious:

- Deleting an assessment deletes its `started_at` / `completed_at`, which are
  the completion instrumentation. Removing one finished assessment **silently
  moves the median time-to-complete** — the number the entire pilot exists to
  produce. A delete that quietly edits the headline metric is the kind of thing
  that discredits a result later.
- An approved assessment is the cycle's record, with targets frozen into
  `target_snapshot`. Deleting it destroys the evidence for a decision that may
  already have been taken on the back of it.

Suggested shape, for discussion rather than as a decision:

- **Reopen** (approved → self_submitted, self_submitted → draft), admin only,
  as the everyday tool. Cheap, reversible, keeps the scores.
- **Delete** restricted to `draft` assessments, so a live record cannot be
  removed by accident. Anything beyond that stays a deliberate script run.

Needs a decision on what the real need is before either is built.

#### Impact of allowing an admin to delete a live assessment

Walked through on request. "Live" here means `self_submitted` or `approved`, not
a draft.

**The cascade is total, and it is already reachable today.** Verified against the
live database with a throwaway account: an approved assessment with 132 scores
and 50 `target_snapshot` rows was destroyed in full by deleting *the user*, not
the assessment. `assessment.assessee_id` is `on delete cascade` from `app_user`,
and `score` / `target_snapshot` cascade from `assessment`.

That means **`npm run invite remove <email>` already hard-deletes a live
assessment** — silently, from a command whose name suggests it only manages
sign-in. This is a pre-existing landmine independent of whether a delete button
is ever built, and it should be fixed regardless.

What is lost, in order of how much it would hurt:

1. **The pilot's headline number changes, silently.** `completionStats` derives
   `finished` from `completed_at` and the median from `completed_at -
   started_at`. Delete a finished assessment and the count drops while `invited`
   does **not** (it counts `assessee`-role users, who still exist), so the person
   reads as "never finished". The median recomputes over one fewer duration —
   deleting a fast finisher raises it, a slow one lowers it. This is the number
   the entire prototype exists to produce, and nothing on screen would say it
   had been altered.
2. **There is no audit trail at all.** Afterwards nothing records that an
   assessment existed. Worse, `unique (assessee_id, cycle)` means the next time
   that person opens `/assess` a fresh empty draft is created, indistinguishable
   from someone who merely started late. An approved record silently becomes an
   empty draft.
3. **The frozen targets go with it.** `target_snapshot` is the record of what was
   measured against what. If a training or staffing decision was taken off a
   results page, deleting removes the ability to reconstruct the basis for it.
4. **The self-vs-assessor delta is destroyed.** The design doc treats that gap as
   signal in its own right — evidence about how PM self-perception compares with
   assessor judgement. It only exists inside the assessment.
5. **Year-over-year trends (T10) get a hole** that reads as non-participation
   rather than as a deletion.
6. **No undo.** There is no soft delete and no in-app recovery. Restoring would
   mean a Supabase point-in-time restore, which returns the *whole database* to a
   moment — everyone's data — not one row. Whether the project's plan even has
   PITR has not been checked.

**Governance, worth naming plainly.** `admin` today is the Head of PMO, who is
also the sole assessor and the person whose completion figures are being
reported upward. The same account would be able to delete records that shape
that figure. This is not a suggestion that anyone would; it is the
separation-of-duties observation an auditor makes, on an HR-adjacent record, in
a bank.

**The counter-argument is real.** Legitimate deletions exist: a leaver, a
duplicate, a data-protection request. "Never delete" is not a defensible answer
either.

Recommended shape if deletion is wanted:

- **Fix the landmine first.** `invite remove` should refuse when the person has
  assessment data, and require an explicit second flag to proceed. Right now the
  destructive case is the default one.
- **Keep the deletion, but make it leave a mark.** Either a soft delete
  (`deleted_at`, excluded from lists and rollups) or a hard delete that first
  writes an audit row: who deleted it, when, why, and the facts the metric needs
  (`state`, `started_at`, `completed_at`). Then the completion number can still
  be reconstructed and the deletion is visible rather than inferred.
- **Reopen stays the everyday tool.** Most of what looks like "delete this" is
  really "this was submitted too early".

#### Owner response, and what survives it

Points 3, 4 and 5 above were pushed back on and the pushback is right: deleting
an assessment *should* take its scores and snapshot with it — that is the
purpose of deleting, not a side effect. The missing audit trail is fixable. The
governance point is a prototype-stage concern with role-based access control
planned for the full build. Those are all recorded as answered, not as risks.

Only one objection survives, and it is narrower than it was first put.

**Worked example, run through the real code against the live database** (five
seeded PMs, since removed). Times to complete: 1.2, 1.8, 2.2, 3.0, 9.5 hours.

| State | Finished | Median |
|---|---|---|
| A — all five finished | 5 / 5 (100%) | 2.2 hours |
| B — Ethan's **assessment** deleted, user still invited | 4 / 5 (80%) | 2.0 hours |
| C — Ethan removed via `npm run invite remove` | 4 / 4 (100%) | 2.0 hours |

One real-world event ("Ethan left, remove his record"), two routes, and the
headline completion rate is **either 80% or 100%** depending on which was used.
B and C differ only in whether the login was also removed — which nobody would
expect to move a completion figure. `invited` is
`max(count of assessee users, number of assessments)`, so deleting the user
shrinks the denominator too.

The issue is not that deletion loses data. It is that **the number reported
upward changes and nothing records why.** "100% completion, median 2.0 hours"
cannot later be reconciled against anything, because the deleted record left no
trace — which is a problem when the figure is the deliverable.

**Agreed direction: archive, per the owner's suggestion.** It is a better answer
than either option first proposed, because an archived assessment keeps
`started_at` and `completed_at`, so the metric stays reconstructible while the
record still disappears from day-to-day use.

- `deleted_at`, `deleted_by`, `deleted_reason` on `assessment`
- archived rows excluded from the review list, results and rollups
- the completion tile states its rule on screen, e.g. "5 finished · 1 archived,
  excluded", so the number explains itself
- genuine hard delete (a data-protection request) stays a deliberate script run
- `invite remove` refuses when the person has assessment data, since today the
  destructive path is the default one

Awaiting go-ahead to build.

## Triage summary

| Open | Fixed | Superseded | Deferred | Won't do |
|---:|---:|---:|---:|---:|
| 4 | 1 | 1 | 1 | 0 |
