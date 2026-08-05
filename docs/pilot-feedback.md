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

**Status:** FIXED (2026-08-04, PR C)

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

**Status:** FIXED (2026-08-04, PR C)

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

**Status:** FIXED (2026-08-04, PR B) — migration `0004` applied

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

Superseded in part by N7 — see below. The archive is still worth having, but for
a narrower reason than "defend the metric".

### N7 — an assessment is *assigned* by the admin, not created by logging in

**Status:** FIXED (2026-08-04, PR A2) — supersedes the metric argument in N6

> "invite does not mean assessment start flag is on, we can add a control for
> the admin to trigger a certain assessment for a user, meaning logging in does
> not automatically show him an assessment is pending unless the admin triggers
> an assessment cycle for the users, so 80% would mean i have started an
> assessment for him but he hasn't completed it"

This is a better answer than anything proposed in N6, and it dissolves that
objection rather than mitigating it.

**Why the current model produced the ambiguity.** `getOrCreateAssessment`
creates a row the first time somebody opens `/assess`, so an assessment exists
because the *assessee* showed up, not because the PMO asked for one. Nothing in
the system records who was asked. `completionStats` therefore has to guess a
denominator — `invited: Math.max(count of assessee users, number of
assessments)` — and that guess is what made deletion ambiguous: removing the
login changed the denominator, removing only the assessment did not.

**Under N7 the denominator is a fact, not an inference.** The admin triggers a
cycle for named people; the assignments are the denominator. 80% means five
assigned and four finished. Deleting an assignment drops the denominator
*correctly*, because withdrawing the ask is a deliberate act with an obvious
meaning — quite unlike "the login was also deleted".

It also matches the domain. An assessment cycle is something a PMO **runs**,
with a start and a named population. It is not something that materialises
because somebody browsed to a page.

**What it changes:**

- **Assignment becomes explicit.** New columns on `assessment` (`assigned_at`,
  `assigned_by`), or the row's existence alone means assigned. Needs a decision
  on whether a distinct `assigned` state earns its place over reusing `draft`.
- **`getOrCreateAssessment` stops creating on visit.** Assessments exist only
  when assigned. `/assess` and `/assess/controls` need an honest "nothing has
  been assigned to you yet" state instead of silently manufacturing one.
- **An admin screen to run a cycle:** pick people, start cycle 2026, see who has
  been assigned. Bulk by nature — the whole point is triggering it for a group.
- **`completionStats` simplifies.** `invited` becomes `assigned` = count of
  assessments in the cycle. The `Math.max` fudge is deleted outright.
- **It removes an existing workaround.** The `assessee_is_pm` filter exists only
  because the Head of PMO opening `/assess` created a stray row that polluted
  the completion figures. With assignment, no assignment means no row, and that
  class of problem disappears. N7 should delete that filter rather than build on
  top of it.

**What the archive is still for, post-N7:** recording that an assignment was
*withdrawn mid-cycle* rather than never made. The metric is defensible either
way now; the archive just keeps the history legible.

**Size:** this is the largest item in the log — a schema change, a new admin
screen, a changed entry path for every assessee, and edits to the completion
maths. Bigger than N4 and N5 combined. Worth sequencing deliberately rather than
folding into the same pass.

### N8 — no way to invite anyone from inside the app

**Status:** **Fixed** in PR A1 — `/admin/people`. Add a person with name, email,
job title, role and a starting password, no terminal. Removal is deliberately
not on the screen: deleting an `app_user` row cascades and destroys their
assessment, so it stays a guarded CLI action.

> "how can i invite a user for the assessment"

Hit while trying to do the most basic administrative task there is. Today the
only route is `npm run invite add …`, which needs a local clone, Node, and
`.env.local` — precisely the toolchain this setup deliberately avoided. So the
Head of PMO cannot add one of their own PMs without either a terminal or someone
else running a command for them.

That is a genuine hole in the product, not just an inconvenience. An assessment
tool whose administrator cannot add a person is not administrable.

**This belongs with N7, not beside it.** Inviting and assigning are one
workflow, not two — the real task is "add these nine people and start their 2026
assessment". Building an admin People screen for N7 and a separate invite path
would be building the same screen twice. N7's scope should absorb this:

- **People** screen, admin only: who is on the allowlist, their role, whether
  they have an assessment this cycle.
- **Add person**: email, full name, job title, role. Creates the auth account
  and the `app_user` row, the same two halves `scripts/invite.mjs` writes today.
- **Assign** (N7): trigger the cycle for selected people from that same screen.
- **Remove**: subject to the `invite remove` hazard already logged — must refuse,
  or archive, when the person has assessment data.

**The password problem this exposes.** `invite.mjs` generates a temporary
password and prints it once to a terminal. A web screen cannot "print once to a
terminal" safely — showing a colleague's password on screen for the admin to
copy is workable but poor, and it is the reason there is still no
change-password flow. Worth deciding at the same time whether the pilot moves to
emailed magic links or invite links, which removes password handling entirely.
That was deferred during the wiring work because Supabase's default mail is
rate-limited and undeliverable to non-team addresses without SMTP — so it needs
an SMTP decision, not just a code change.

**Interim:** accounts can be created by whoever has the repo and `.env.local`,
or from an agent session with database access. Neither is a substitute for the
screen.

### N9 — password reset, for admins and for users

**Status:** **Two of three fixed** in PR A1 — change-your-own (`/change-password`)
and admin reset (on `/admin/people`), both with the forced-change-on-first-use
contract. Forgot-password stays blocked on the SMTP decision.

> "Also for admin, and for normal user we need a feature to reset passwords as
> well might as well do it"

Three distinct features get called "password reset". They have very different
costs, and separating them matters because one is blocked and two are not.

| | Needs email? | Buildable today |
|---|---|---|
| **Change my own password** (signed in) | no | **yes** — `auth.updateUser({ password })` on the current session |
| **Admin resets someone's password** | no | **yes** — `auth.admin.updateUserById`, same call `invite.mjs` makes |
| **Forgot my password** (signed out) | **yes** | **no** — needs SMTP |

"Forgot password" cannot work without outbound mail: the whole mechanism is a
link sent to an address the user proved they control. Supabase's built-in mail
is rate-limited and does not deliver to non-team addresses, which is exactly why
password sign-in was chosen during the wiring rather than magic links.

**The SMTP decision now blocks a cluster, not one feature.** It gates emailed
invite links (N8), self-service password reset here, and the awkward
hand-the-password-over step in both. Configuring it once unblocks all of them
and removes the need to ever display a colleague's password on screen. Worth
deciding deliberately rather than per-feature.

For a bank there is a further question that is not technical: whether auth email
may go through a third-party sender (Resend, Postmark, SendGrid) or must use
KIB's own mail infrastructure. That is an IT/policy answer, not a code one, and
it should be asked before any of this is built.

**An integrity problem specific to this product, worth naming.** If an admin can
set a user's password and see it, the admin can sign in *as* that user. In this
tool the admin is also the assessor, so that means the assessor could enter or
alter someone's **self**-assessment. The entire design rests on `self_level` and
`assessor_level` being two independent judgements; a reset flow that hands the
assessor a working password quietly undermines that distinction.

This is not a suggestion anyone would do it — it is that the pilot's central
comparison should not depend on trust when it does not have to. Mitigations,
cheapest first:

1. **Emailed reset links** — the admin triggers a reset but never sees the
   password. Removes the problem rather than managing it. Needs SMTP.
2. **Force a password change on first sign-in**, so an admin-set password is
   valid only until the real user uses it once.
3. **Record resets** (`who`, `whom`, `when`) so the action is at least visible.

Option 1 is the real answer, and it is the same SMTP decision as above.

#### Decision (owner): option 2 as the interim

> "for now until i get an smtp let's do a default password for new users and
> force them to change it upon login, the user password will be set in the admin
> panel when i add the user, until we have an smtp server that will email a new
> password"

Adopted. The admin sets a password when adding the person; that password is
valid for exactly one sign-in, after which the user must set their own.

This does more than unblock the pilot — it **answers the integrity concern
above** rather than accepting it. An admin-set password stops working the moment
the real user signs in, so an assessor who used it first would lock the assessee
out and make the fact obvious. The window in which someone else's self-scores
could be entered closes on first use, and closes noisily.

What it needs:

- `must_change_password boolean not null default false` on `app_user`, set true
  by the admin create path (and by an admin reset).
- A `/change-password` screen using `auth.updateUser({ password })` — the current
  session is enough, no email involved.
- A gate in `requireUser` (or `proxy.ts`) sending anyone with the flag set to
  that screen and refusing every other route until it is cleared. It must be a
  server-side gate, not a UI nudge, or it is decorative.
- Clear the flag on success.

**One thing to settle when building: "default password" has two readings.** A
single shared value for everyone (`ChangeMe123`) is weak — anyone who learns it
can sign in as any user who has not yet logged in, and with nine people that
window may be days. The wording here ("set in the admin panel when i add the
user") reads as per-user, which is the right shape: the admin types or generates
one for that person, and it is shown once. Recommend per-user; flagging it only
because "default password" could be read the other way.

When SMTP arrives this becomes the fallback rather than the mechanism: emailed
invite and reset links take over, `must_change_password` stays useful for
admin-initiated resets.

### N10 — make the whole app mobile friendly

**Status:** FIXED (2026-08-04, PR C)

> "also can you make the whole app mobile friendly"

Audited every screen at 390px (iPhone-class width) against the running app.
Starting point is better than expected: **no page overflows the viewport
horizontally**, and the results bar chart already stacks correctly (fixed during
the design review). The `.grid` table is wider than the screen but scrolls inside
its own `.tablewrap`, which is the right pattern rather than a defect.

So this is not a rebuild. Three concrete problems:

**1. The header, and it is the worst of them — it is on every screen.** At 390px
the brand block and the nav sit side by side, so "Competency Assessment" wraps
across two lines, the subtitle across two more, and the nav crams into a narrow
right-hand column. Roughly 200px of vertical space — a quarter of the viewport —
is spent on chrome before any content appears, on every single page.

Fix: below ~560px stack the header, drop the subtitle, and lay the nav out as a
horizontal scrolling row (or a compact menu) beneath the brand. Target is
something like 90px, not 200px.

**2. `.sec-head` collides with its eyebrow.** "Assessment cycle 2026" and
"132 ACTIVE CONTROLS PER PERSON" fight for the same line: the rule between them
collapses to nothing and the eyebrow runs to the right edge. Affects every
screen using the pattern.

Fix: stack below ~560px, or drop the eyebrow to its own line under the heading.

**3. The People table is the wrong shape for a phone.** It scrolls horizontally,
so nothing breaks, but Finished, Hours and the Review/Results links are all off
screen — the columns that make the row worth reading. Horizontal scrolling to
find an action is a poor pattern on touch.

Fix: below ~560px render each person as a stacked card (name and state on top,
the numbers as labelled pairs, actions as full-width links) rather than a table
row. The `.tablewrap` fallback stays for tablet widths.

**What already works and should not be touched:** the scoring screen. Large tap
targets, one control per screen, the selected level clearly marked, evidence
field and primary action reachable without a stretch. That page is arguably
better on a phone than on a desktop, which matters — a PM filling in 132
controls in odd moments is exactly the behaviour the pilot is trying to produce.

Worth pairing with N4 and N5, since all three touch the controls list.

### N11 — body text is tiring to read

**Status:** **Measure and leading fixed** (131 → 68 characters, line-height 1.6,
reading pages in a 780px container; DESIGN.md updated, since the cause was its
own "1080px for reading" line). Palette approved but deliberately not touched
yet — re-judge against the fixed measure first.

> "i find the text is hard to read, perhaps the white background with the
> current font combination needs enhancements it is eye draining"

Measured on the running app rather than judged by eye. The instinct is right;
the cause is mostly not the one named.

| Measured | Value | Comfortable range |
|---|---|---|
| **Characters per line** (indicator description) | **131** | 45–75, ideal ~66 |
| Font size | 15px | fine |
| Line height | 22.5px (1.50) | 1.6–1.7 for prose at length |
| Ink on card | `#16202e` on `#ffffff` | — |
| **Contrast ratio** | **≈16.4 : 1** | WCAG AAA needs 7:1 |

**The dominant cause is line length, not colour.** At 131 characters the eye has
to travel nearly twice the comfortable distance and then hunt for the start of
the next line. That return sweep is what produces the specific feeling of
draining, and it gets worse the longer the text — which is why the ICB4
description paragraphs and the measures list are where it bites hardest. This is
a layout property; it is independent of typeface and palette.

**Contrast is a genuine but secondary factor.** 16.4:1 is more than double the
strictest accessibility threshold. Maximum-contrast dark-on-pure-white is
comfortable in short bursts and harsh over sustained reading, which is exactly
the workload here: 132 controls, each with a paragraph and up to six measures.

Fixes, in order of effect per unit of change:

1. **Cap the reading measure at ~68ch** on prose blocks (indicator description,
   measures, notes). Biggest single improvement, and it touches **no** colour or
   type token — purely layout, so it is compatible with `DESIGN.md` as locked.
   Worth trying alone first before changing anything else.
2. **Raise line height to ~1.6** on those same prose blocks. Cheap, additive.
3. **Soften the surface and ink** — a slightly off-white card and marginally
   lighter ink, landing nearer 12–13:1. Still far above AA. **This changes the
   locked palette** and needs explicit sign-off plus a `DESIGN.md` update.
4. **Consider 16px** for the long description text specifically, leaving UI
   chrome at 15px.

**Process note.** `CLAUDE.md` states that `DESIGN.md` is the source of truth for
all colour and type, and that deviation needs explicit approval. Items 1 and 2
are layout and sit inside that. Items 3 and 4 do not — if they are wanted,
`DESIGN.md` must be updated in the same change, or the design system stops being
the source of truth and starts being a document nobody trusts.

Recommendation: do 1 and 2, look at it again, and only then decide whether the
palette actually needs touching. It may not.

**Owner response — palette work approved anyway:**

> "i still think text color + white background needs some enhancements, worth
> running later by gstack design ux ui skill"

Reaffirmed after the measurements, so items 3 and 4 are in scope, not just 1 and
2. Approach: still do the measure and line-height first, since they are free and
change what the palette question even looks like — then take the result to
`/design-consultation` (or `/design-review` against the built UI) rather than
hand-tuning hex values here. That keeps `DESIGN.md` the source of truth and
gives the change a rationale to record in it.

Dark mode must be reviewed in the same pass — see N12. Softening the light
palette while leaving the dark one untouched is how the two drift apart.

### N12 — dark theme exists but there is no way to choose it

**Status:** FIXED (2026-08-04, PR C)

> "also I believe there was a dark theme option which I cannot see anymore"

There is a full dark palette in `app/globals.css`, and it works — but it is
driven entirely by `@media (prefers-color-scheme: dark)`, which follows the
operating system or browser setting. There has never been a control inside the
app, so there is nothing that could have disappeared.

To see it today: switch the OS (macOS System Settings → Appearance, Windows
Settings → Personalisation → Colours) or the browser's own appearance override.

**Worth building a real toggle**, because "follows the OS" is the wrong default
for this workload: someone filling in 132 controls may want the dim version at
21:00 without flipping their whole machine to dark. Shape:

- three-state control — Light / Dark / Match system — with system as default;
- persisted per user (a column on `app_user`, or a cookie read server-side);
- applied as `data-theme` on `<html>` so the existing custom properties switch
  wholesale, with the `prefers-color-scheme` block kept as the "match system"
  branch.

Note it interacts with **N11**: if the light palette is softened, the dark one
should be reviewed in the same pass rather than drifting apart.

### N13 — my own error: your live assessment was filled and emptied mid-session

**Status:** Fixed (behaviour changed) · not an application defect

> "i just saw the full assessment for my user done and scored but not submitted,
> i clicked somewhere again and it seems that my assessment is untouched, i
> cannot reproduce it now, check for that"

Not a bug, and not reproducible, because the application did not do it. During
the N10 mobile audit I ran `scripts/demo.mjs fill` against the **owner's own
account** so the screens would render with data, captured screenshots, then
deleted the scores to restore the prior state. The observation falls exactly in
that window: 132/132 scored and unsubmitted, then untouched again minutes later.

Verified afterwards: `draft`, 0 scores, `started_at` null — the state it was in
before the audit.

**The mistake was the account, not the fill.** Every other exercise this session
used disposable `@example.test` accounts created and deleted by the script.
Using the live account being actively browsed was a shortcut, and it produced
exactly the failure it deserved: the owner watched their own data change under
them and reasonably filed it as a defect.

Changed: any future fill, audit or screenshot run uses a dedicated throwaway
account, never the owner's. `scripts/e2e.mjs` already works this way; the ad-hoc
runs should have matched it.

Recorded here rather than quietly corrected, because "the tool showed me
something that then vanished" is precisely the class of report that destroys
trust in an assessment system, and the answer needs to be findable.

### N14 — the self-assessment does not fit a screen, and wastes a big one

**Status:** FIXED (2026-08-04) — amendment approved by the owner and applied

> "i have a 27 inch screen and the save & next control is not on the screen, i
> have to scroll vertically for seeing it and doing it for every control is
> tiring, all the screen content should fit without scrolling… also the content
> size is narrower now not sure if it is because of mobile friendliness, but it
> should not impact the pc screen or bigger sized screens"

Both halves are the same bug, and it is one I introduced: the N11 readability
fix (PR #6) capped `.reading` at 780px, and `/assess` uses that as its **page**
container — so the scoring controls are squeezed into a prose column instead of
using the width a large screen has.

Measured against the running app (`4.3.1.1`, a mid-length control, and
`4.5.1.1`, the longest at 2596 characters):

| viewport | 4.3.1.1 | 4.5.1.1 |
|---|---|---|
| 1440×900 laptop | 615px scroll · Save off-screen | 1285px scroll |
| 2560×1440 @100% | 75px scroll | 745px scroll |
| 2560×1440 @125% | 363px scroll · Save off-screen | 1033px scroll |

The page is **1515px tall at every one of those widths** — height does not
respond to width at all, because the card never exceeds 780px. On a 2560px
screen that strands 1780px. The vertical budget is roughly: measures 262–308px,
six level options 441px, and the description growing to ~900px on the longest
controls.

**"Everything fits without scrolling" is not achievable for every control, and
promising it would be dishonest.** ICB4's longest indicator is 2596 characters
of source text that must not be cut (domain rule: ICB4 text is never edited). At
1152px of usable height, that text alone fills the screen. What *is* achievable
is the thing actually being asked for — never having to scroll to reach the
answer and the Save button:

1. **Two columns above ~1200px.** Left: breadcrumb, indicator, description,
   measures — prose, still capped at `--measure`, which is what the readability
   fix was for. Right: the six level options, evidence and the actions. This is
   what turns 1780px of waste into roughly half the height.
2. **The scoring column sticks.** Pin it so the options and *Save & next* stay
   in view while the left column scrolls under a long indicator. This is the
   guarantee that holds even on the worst control — and on a laptop and a phone,
   where two columns do not fit, the action bar alone sticks to the bottom.
3. **Tighten the options.** 441px for six rows is generous; ~60px is available
   in padding and gloss size without touching the tap target.

Ordered deliberately: (2) is what removes the tiring part, so it ships even if
(1) is cut. (1) is what answers "it should not impact bigger screens".

**This needs a DESIGN.md decision, which is why it is not already done.**
DESIGN.md §Layout names three container widths and puts self-assessment in
"reading pages 780px", warning that a reading page in a wider container "strands
its prose in the left half while its controls span the full width". That warning
is right about prose and wrong about a page whose second half is not prose at
all. The amendment: a reading page may use a wider container **when it carries
an interactive panel beside the prose** — the cap that matters is `--measure` on
the sentences, not the container on the page. Same principle the file already
states; this extends it rather than reversing it.

### N15 — session lifetime is unbounded

**Status:** Logged, deferred by the owner ("log session timeout for now")

Raised by the owner noticing they were still signed in on a fresh browser visit.
The session survives because `@supabase/ssr` writes a persistent cookie with a
400-day max-age and `proxy.ts` refreshes it on every request, so a session in
regular use renews indefinitely. Nothing is wrong with it; nothing bounds it
either.

Two knobs, both unset, documented in `docs/deploy.md`:
- **Supabase → Authentication → Sessions** — inactivity timeout and absolute
  time-box. Dashboard-only; the owner has to set these.
- `SESSION_COOKIE.maxAge` in `lib/supabase/cookies.ts` — the browser-side bound.

For a bank's internal tool both should probably be bounded rather than left at a
library default, but the tradeoff against convenience is a policy call.

Fixed at the same time, and not deferred, because it was a genuine defect rather
than a policy gap: the session cookie was **not** `httpOnly`. `@supabase/ssr`
defaults it to `false` so a browser-side Supabase client can read the token; this
app has none, so that bought nothing and exposed the session to any script on
the page. Now `httpOnly` and `Secure`, asserted in `scripts/e2e.mjs`.

### N16 — every Supabase call costs ~31ms before the query runs

**Status:** Root cause established and measured. Round-trip reduction shipped.
Two follow-ups logged below, both deliberately not done yet.

Raised by the owner: "the performance is slow… loading the second control takes
4 seconds." Three rounds of investigation blamed the wrong thing twice — first
the number of calls, then the function region — before measuring the calls
themselves.

**The finding.** Supabase's own gateway reports its service time in the
`x-envoy-upstream-service-time` header, which is measured inside their
infrastructure and so is independent of where the client sits. Against the live
project:

| query | payload | Supabase server time |
|---|---|---|
| `score` `limit=1` | 0kB | 31–49ms |
| `app_user` `limit=1` | 0kB | 31ms |
| `control`, all 133 | **183kB** | 35–41ms |
| `measure`, all 586 | 104kB | 34–35ms |

**Returning one row costs the same as returning 183kB.** That is not query
execution — it is a fixed per-request cost charged before the query is
considered. The database is a `t3a.nano`: 0.5GB RAM and two burstable vCPUs,
shared between Postgres, PostgREST and the gateway.

It reconciles every number in the Vercel logs: the 38ms best case, the ~100ms
median across 101 calls, and the framework load where nine parallel queries
saturated two cores and each one inflated from ~60ms to 180–360ms. Under load
the floor triples — measured at 102ms median with 20 concurrent requests.

**What this means for scale, since the question was asked.** Data volume is
*not* the risk: the size-independence above proves the project is nowhere near
it, the framework tables are fixed at 133 controls and 586 measures forever, and
`score` grows at 132 rows per person per cycle (a thousand people would be
132,000 rows). **Request concurrency is the risk**, and round-trip count is the
multiplier on it. Which is why fewer calls is the structural fix and not a
workaround — it reduces a cost that no amount of query tuning can touch.

**Shipped:** 12 calls on a cold instance → 2, and 4 → 2 warm. See the commit.

**Not done, and why.**

1. **Compute upgrade — the owner's call, and a measurement as much as a fix.**
   Nano → Micro is a few dollars a month and reversible. If the idle floor drops
   it was CPU; if it does not, the floor is Supabase's REST stack on every tier,
   which is decisive evidence for (2). The owner asked to re-test the round-trip
   work first so only one variable moves at a time.

2. **Talk to Postgres directly instead of through PostgREST.** Every 31ms trip
   goes TLS → Cloudflare → Envoy → PostgREST → parse and plan → Postgres, and
   back. The wire protocol through Supabase's Supavisor pooler skips the first
   four; same-region that is typically 1–3ms rather than 31ms, and it does not
   degrade the same way under concurrency because there is no HTTP stack per
   query. It fits behind the existing seam — `db()` in `lib/supabase/server.ts`
   and `lib/framework.ts` are exactly the swap points — and being strictly
   server-side it strengthens the "client never holds a table-capable key" rule
   rather than weakening it.

   **Deferred on purpose.** It needs a driver, pooler configuration and SQL
   where the query builder is today. Nine people on a pilot will not tell us
   whether the right thing was built, and this repo's rule is that generality
   comes last. Revisit with real usage to measure against — or sooner if (1)
   comes back showing the floor is not the instance.

### N17 — the add-person tests fail about one run in four

**Status:** Cause found and fixed. It was never only a test problem — the owner
hit the same defect in production. See N20, which is the same bug.

**Update.** The cause is an ORPHAN: a row in `auth.users` with no matching
`app_user` row. `addPerson` checks the allowlist, finds nobody, calls
`createUser`, and is told the address is already registered — a dead end with no
route out of the UI. An interrupted test run leaves exactly that state behind,
which is why the suite hit it about one run in four.

It is now reproduced **deterministically** rather than waited for: the suite
builds an orphan on purpose and asserts the account is adopted, that adoption
reuses the existing auth id instead of forking a second identity, that the gate
is still armed, and that the password the admin typed is the one that works.

Four consecutive clean runs since. Worth being honest about that number: for a
one-in-four failure, four clean runs is only about 68% likely to be luck-free,
so the run count alone would not settle it. The reason to believe it is fixed is
the mechanism — proven by a deterministic test — not the streak.

**Original entry, kept because the reasoning it records was wrong in an
instructive way:**

Five checks in the `[13] People` block fail intermittently — the allowlist row,
the password flag, the assign list, and both sign-in checks — because the account
is never created. **Confirmed pre-existing:** stashing the N16 work and running
the suite four times on the unchanged code failed twice, at the same rate and in
the same block.

What is known: the page lands on `/admin/people` with **no** `error=` parameter,
so the action did not report a failure; yet no `app_user` row exists, and a fresh
sign-in seconds later is refused. So it is not a read race on the assertion — the
account genuinely is not there.

The likely area is `purge()` → `deleteAuthUser()` → `addPerson()`'s
`createUser`: `deleteAuthUser` lists users, deletes if found, and never verifies
the delete took effect, so a GoTrue delete that has not yet propagated would make
the next `createUser` refuse the address. That is a hypothesis, not a diagnosis —
it does not explain an empty `error=` parameter, and it should not be "fixed" on
a guess.

The failing check now reports the page URL, which is what makes the next
occurrence diagnosable rather than mysterious. Worth an `/investigate` pass on
its own; not folded into a performance change.

### N18 — a save costs two server round trips, and 253–986ms of one is unexplained

**Status:** N16 shipped and measured. Ordinary pages are fixed. The save path is
not, and this entry is instrumentation, not a fix.

**N16 worked.** Measured in production against the same pages:

| | before | after |
|---|---|---|
| framework load | 600–730ms | **20–201ms** (1 query) |
| median per-call cost | 103ms | **66ms** |
| median database time per page | ~1,300ms | **222ms** |
| median page that touches the database | 900–2,300ms | **445ms** |

The per-call drop was not predicted: fewer simultaneous calls means less
contention on two burstable cores, which is the concurrency effect measured in
N16 running in reverse. The owner reports the app feels about a second faster.

**What is left, and where.** Ordinary page loads are now essentially pure
database time — `/` at 1531ms carried 1485ms of queries, `/assess/controls` at
422ms carried 392ms. But a **save** is two request cycles, and the POST half
carries time that is neither:

| POST | database | unexplained | then GET | database |
|---|---|---|---|---|
| 1422ms | 436ms | **986ms** | 220ms | 202ms |
| 1221ms | 413ms | **808ms** | 577ms | 407ms |
| 1057ms | 397ms | **660ms** | 237ms | 223ms |
| 468ms | 215ms | **253ms** | 172ms | 148ms |

The POST returns a 303, so no page is rendered in it. The time is not queries
and not rendering.

**A hypothesis, killed before it shipped.** `revalidatePath` looked like the
`unstable_cache` trap again — free on a laptop, a network hop on Vercel, and
called by every action. Timed: **0ms**. It is also not dead weight despite every
route being `force-dynamic`; there is no server cache to invalidate, but it does
clear the client's router cache, without which a client-side navigation back to
a scored control could show the pre-save payload. Kept.

Locally the action fully accounts for itself (915ms total: 195ms find, 363ms
write, 0ms revalidate, the rest auth), which points at the remaining production
time being **outside** the action — in Vercel's server-action machinery rather
than in this code. The timers added here bracket the action precisely so that
the next reading either confirms that or refutes it.

**The bigger observation, raised by the owner and worth more than the fix.**
Scoring 132 controls means 132 saves, each a POST plus a redirect plus a GET —
about **264 server round trips to fill in one form**. At 1.5s a save that is
over three minutes of a PM waiting, arriving immediately after every decision
they make.

That is not only irritating. `docs/STATUS.md` says this prototype exists to
answer one question: *will PMs finish online when they would not finish a
spreadsheet?* A spreadsheet has no latency between cells. Run the pilot with a
second and a half after every answer and a "no" may be about the wait rather
than about the tool — which would corrupt the answer the pilot is for.

The current design is not wrong: server-first, simple, and every score is
durably committed before the PM moves on, which for an assessment record is a
real virtue. But it multiplies per-request cost by 264, and no query tuning
touches that multiplier.

**So the ordering changes.** Shaving milliseconds off a round trip matters less
than deciding whether to keep taking it 264 times. The compute bump (N16) and
the move to direct Postgres (N16) both drop below:

1. Finish this diagnosis — deploy these timers, one test.
2. Local JWT verification: ~65ms off every trip, ≈17 seconds across a full
   assessment. One afternoon.
3. **The design question, properly:** does scoring stay one navigation per
   control, or become one screen that saves in the background? That is a product
   decision about how the assessment feels, not a performance fix — it belongs
   in `/office-hours`, before the pilot rather than after it.

#### Step 1 done (2026-08-05): the unexplained time is gone

The timers were deployed and the owner ran the test — sign in, score controls,
export the runtime logs. Two saves, in production:

```
POST /assess -> 303
    [phase] 145ms  auth: validate token + load app_user
    [phase]  59ms  action: find assessment
    [phase]  71ms  action: write the score
    [phase]   0ms  action: revalidatePath
    [phase] 276ms  action: save score (whole action)
```

145 + 59 + 71 + 0 ≈ **276**. The second save: 229ms total against 110 + 63 + 56.
**The action fully accounts for itself.** The 253–986ms that was neither queries
nor rendering is not present. `revalidatePath` remains 0ms, confirming it dead
as a suspect rather than merely unproven.

**What the owner feels — 1–1.5s to move between controls — is now structural.**

| | |
|---|---|
| POST server work | ~276ms |
| GET server work | ~130–210ms |
| Kuwait → Frankfurt, **twice** | ~500ms |
| browser render | the remainder |

No query tuning touches the two-round-trips-per-control multiplier, which is
exactly what this entry predicted. **Step 3 is now the only large lever.**

**Step 2 is confirmed worth its afternoon.** `auth: validate token + load
app_user` costs **83–174ms on every request** — the largest single server-side
item in the export. Removing the `/auth/v1/user` round trip takes ~20–70ms off
each of ~264 trips, which is the ≈17 seconds this entry estimated.

**A correction, because it sent the owner on an errand.** Reviewing an earlier
export, the author flagged Supabase calls at 107–136ms as anomalous against an
expected ~35ms (Supabase's 31ms overhead plus co-located network) and asked for
the project region to be re-checked — which `docs/regions.md` had already
settled as `eu-central-1`. The full export shows why the flag was wrong:

- **First call on a fresh instance costs 105–306ms** — connection setup, paid
  once per instance.
- **Steady state is 55–90ms**, which matches the median per-call cost of **66ms**
  this very entry records. The ~35ms figure was an ideal the project has never
  measured, so there was no discrepancy to explain.

Region was confirmed correct incidentally: every function ran in `fra1`. The
`cdg1` and `sfo1` rows are edge middleware and a redirect, which run near the
user by design and are not the function.

**One incidental finding, logged not fixed.** `/results` issues **7 sequential
Supabase calls totalling ~753ms** (56, 62, 89, 92, 131, 137, 148ms, plus auth) —
`app/results/page.tsx` uses sequential `await`s with no `Promise.all`. It is
nobody's bottleneck today because the page is viewed once rather than 132 times,
but several of those are independent and could overlap.

### N19 — a slow database logged the admin out and said they were never invited

**Status:** Fixed.

Raised by the owner refreshing the page after a deployment: signed in as the
admin, demonstrably on the allowlist, and shown *"That account is not on the
assessment allowlist. Ask the Head of PMO to invite you."* The session was gone.

One line in `lib/auth.ts`:

```ts
if (row.error || !row.data) return { status: "uninvited" };
```

A **failed query** and **genuinely not on the allowlist** were the same branch,
and "uninvited" redirects to `/logout?denied=1`, which clears the session. So any
transient failure reading `app_user` did not merely error — it signed a
legitimate user out and told them something false about why.

On a `t3a.nano` measured at a 31ms floor that triples under concurrency, and
right after a deployment when every instance is cold, a transient failure is an
ordinary event rather than an exotic one. This is N16's finding arriving as a
correctness bug rather than a slow page.

It was also **silent** — no log line, which is why the exported logs showed
nothing at all and the only evidence was a screenshot.

Fixed by splitting the two states. `unavailable` now carries the database's own
message, is logged with `console.error`, and **throws instead of redirecting** —
every redirect target either signs the user out or is itself a page that must
resolve the viewer, so redirecting on a failure would either destroy a good
session or loop. The session survives and a refresh recovers.

The general lesson, worth more than the fix: **"I could not find out" and "the
answer is no" are different answers, and collapsing them into one branch is how
an availability problem turns into a security-shaped lie.**

### N20 — "already registered", but nobody by that name in the People list

**Status:** Fixed. Same root cause as N17.

The owner tried to add a person and got *"A user with this email address has
already been registered"*, while the People list showed one person and no such
address. No way forward from the UI, and no way to see what was wrong.

The account had come apart: a row in `auth.users` with no `app_user` row. Since
`app_user` IS the allowlist, such an account can sign in and reach nothing — it
is inert, invisible to every screen, and still holds the email address against
any future attempt to use it.

`addPerson` now **adopts** an orphan instead of refusing it: it finds the
existing auth id, sets the password the admin just typed, and writes the
allowlist row against that same id.

Why adoption is safe rather than a hijack route: the function has already
refused any address that HAS an `app_user` row ("already on the allowlist"), so
adoption can only ever reach an account with no access to anything. Writing the
row and setting a password is precisely what "add this person" was asking for.
Only an admin can reach it.

Two details that are load-bearing rather than tidy:
- The rollback path only deletes the sign-in account when **we** created it.
  Deleting one we merely adopted would destroy something that predated the
  request; leaving it costs nothing, because the next attempt adopts it again.
- The lookup pages through `listUsers` rather than taking one large page. "The
  address is taken but I cannot find it" is the exact dead end this removes, and
  a silent truncation would rebuild it in a form that only appears once the
  organisation is big.

### N23 — a typo'd email is thrown away, and the browser refills the old one

**Status:** Logged 2026-08-05, not yet fixed. Reported by the owner.

Signing in as `nayef..harb@gmail.com` (a doubled dot) gives the generic refusal,
and the email field then shows `nayef.a.harb@gmail.com` — the address the owner
had used before. It reads as though the app silently replaced what was typed.

**It does not.** `signIn` redirects to `/login?error=…` on failure, which is a
fresh render with an empty `<input>`; the browser's own autofill then puts the
saved address in. The app never writes that value. The distinction decides the
fix: nothing needs *stopping*, the typed address needs *keeping*.

The cost is small but lands on every mistyped sign-in: the person cannot see what
they actually typed, so they cannot see their own typo. With `autoComplete
="username"` on the field, autofill is guaranteed to be the thing that fills the
gap, which makes the wrong value look authoritative.

**What the fix may NOT do.** The message is deliberately identical for "wrong
password", "no such account" and "not invited" (see the note in
`app/login/page.tsx`) — distinguishing them would let an outsider enumerate the
pilot's staff list. Any improvement here must keep all three indistinguishable.
Rejecting a *malformed* address is safe on that count, because it is decidable
from the string alone and reveals nothing about who exists — but `nayef..harb@`
passes the HTML5 `type="email"` check, so the browser will not catch it either.

Two ways to keep the typed value, both keeping the message generic:

1. **Round-trip it in the query** — `/login?error=…&email=…`, rendered as the
   input's `defaultValue`. Three lines. It also puts a real staff email address
   into browser history and every server access log, which is the wrong default
   for a bank's internal tool.
2. **Return the error as form state instead of redirecting** — `useActionState`,
   making the form a client component. The typed value survives naturally, no
   redirect, and `?error=` leaves the URL entirely. It is the better shape and it
   touches the auth path, so it wants a deliberate decision rather than a drive-by.

Recommended: (2). Awaiting the owner's go-ahead — it is the sign-in path, and
this is not urgent enough to justify changing it unannounced.

### N22 — "I am not logged in and the whole nav bar is showing"

**Status:** Fixed. Reported 2026-08-05, with the repro supplied by the owner.

The owner signed in, pressed the browser's **Back** button, and landed on the
sign-in form with the full signed-in header around it — nav, name, role, Sign
out — and found the nav still worked.

**The report was right about the symptom and inverted about the cause, and the
inversion is the interesting part.** Read as stated it looks alarming: a signed
-out visitor holding signed-in chrome, which would be a session leak. It was the
exact opposite. The session was valid the entire time; the header was telling the
truth. The thing that had no business being on screen was **the form**.

`app/login/page.tsx` never asked who was looking. It rendered the sign-in form to
anyone, authenticated or not, so Back re-rendered it with a live session and the
layout dressed it in the signed-in header. Nothing was stale and nothing leaked.

Two details that decided this rather than the first theory:

- The second screenshot — the owner navigating to Results and getting *their own*
  in-progress state — proved the session was live. A stale-cache or bfcache
  restore would have carried signed-**out** chrome, since that is what the page
  looked like before signing in. Signed-in chrome ruled that whole family out.
- Prefetching was the tempting culprit, given N21. It is **off** (`app/link.tsx`),
  so it could not have been. Checking that before theorising cost one grep.

The fix is a guard: signed in, `/login` redirects to `next` (validated as an
in-app path, same rule as the sign-in action) or `/`.

`?denied=1` is deliberately exempt. That parameter arrives from `/logout` after
an allowlist refusal and its banner is the only explanation the person ever gets;
redirecting it would bounce them to a page they cannot use and swallow the
reason. It is only reachable while signed out, so the exemption cannot loop.

`/login` is also served `Cache-Control: no-store` (in `next.config.ts`, scoped to
that one route) so the form is never restored from the browser's back/forward
cache.

Covered in `[1] Invite-only auth` by driving **Back** specifically — the reported
route in — plus the direct visit and the `denied` banner.

**Two corrections earned during the fix, both worth keeping:**

- The first version of the Back test asserted `url() !== "/login"` and **failed
  against a page that was already correct**. After a soft back the address bar
  still reads `/login` while the content is the redirect target: 0 password
  fields, signed-in chrome present. The form — the thing reported — was gone.
  The test now asserts that, and the lingering URL is recorded as cosmetic
  rather than chased. This is the same mistake as the `4.4.3` substring check
  in N21: asserting on a proxy instead of on the symptom.
- `no-store` was added on the theory that Back was an HTTP request. It is not —
  a server-action redirect makes `/login → /` a client-side push, so Back is a
  soft navigation served from Next's router cache, and no header can reach it.
  The header is kept because it is correct for hard reloads and costs nothing on
  one route, but it is **not** what fixed this. The page guard is.

### N21 — 98 of 101 prefetches render nothing, and may be causing the cold starts

**Status:** Fixed. Prefetching is off, asserted by a permanent test. The
production benefit (fewer instances) is **not yet verified** — that needs a
click-through and a fresh log export.

**How it was fixed.** Not `prefetch={false}` on five links, which was the
original plan: `app/assess/controls/page.tsx` renders one `<Link>` per control,
so the real count is closer to 140 call sites than five. Instead `app/link.tsx`
wraps `next/link` with the default flipped, and every file imports that. The
reasoning for the default — and the two conditions that should reverse it — live
in that one file, so re-enabling is one edit rather than an archaeology exercise.

Verified directly rather than assumed: on the heaviest page, scrolled to the
bottom so every link enters the viewport, **zero** `_rsc` requests. Before the
change the same page produced twelve. The suite asserts both that and that
navigation still works, which also guards against someone importing `next/link`
directly and quietly reinstating the cost.

### What this broke, which was the more useful finding

Removing the prefetches made **fourteen tests start failing intermittently**,
across add-person, change-password, submit, approve and admin — areas with no
connection to prefetching.

They had all been passing for an accidental reason. The pattern was:

```js
await page.click(submit);
await page.waitForLoadState("networkidle");
```

`networkidle` is 500ms of network silence, which is a *proxy* for "the server
action finished" and not the thing itself. `click()` waits for nothing, so that
500ms could elapse **before the POST had even started** — silence measured ahead
of the work and read as silence after it. The prefetch requests were incidental
noise that kept the network busy just long enough to paper over it.

So the suite was not testing what it appeared to test, and deleting a pointless
optimisation is what revealed it. Fixed with two helpers: `submitAction`, which
arms `waitForResponse` **before** the click and only then measures idleness, and
`actionLanded`, which waits for the specific outcome about to be asserted.
Fourteen sites converted; zero `click`-then-`networkidle` pairs remain.

**Worth generalising:** a test that passes because of unrelated traffic is
indistinguishable from a test that passes, right up until the traffic changes.
This suite had that property for weeks.

**Still honest about:** an occasional single-check flake remains across long run
sequences, not yet pinned to one cause. The add-person check now reports the
error **banner** rather than the URL — twice the wrong diagnostic was chosen
there, because `addPersonAction` renders failures in the page and the URL could
only ever echo the page it was already on.

The header renders five nav links on every signed-in page, all visible
immediately, so every page load fires five or six `<Link>` prefetches at once.
From one session's export:

| route | `_rsc` requests | rendered nothing |
|---|---|---|
| `/assess/controls` | 17 | **16** |
| `/assess` | 16 | **16** |
| `/results` | 16 | **16** |
| `/review` | 16 | **16** |
| `/admin/people` | 16 | **16** |
| `/admin` | 16 | **16** |
| **total** | **101** | **98** |

**Why they come back empty.** Every route is `force-dynamic`. Next will not
render a dynamic page for a prefetch — it fetches down to the nearest
`loading.tsx` boundary and stops. There are no `loading.tsx` files in this app.
So there is nothing for a prefetch to return, and the zero-database-call count
is that fact measured rather than inferred.

**Why empty still costs.** Each is a real function invocation. Six arriving
together means Vercel wants six instances at that instant; it has one warm and
cold-starts the rest. The same session shows **12 instances for a single user**,
four of which served exactly one request and were never used again. The
prefetches do not slow the request they belong to — they degrade the *next* one,
because cold is where 421–779ms of server-action overhead lives against 210ms
warm (N18).

**The fix as originally scoped:** `prefetch={false}` on the five nav links in
`app/layout.tsx`. That is not what shipped — see "How it was fixed" above: the
controls page alone is ~132 call sites, so it became a wrapper (`app/link.tsx`)
rather than a per-link flag. Left here because the gap between the plan and the
shipped change is the useful part.

**The condition for putting it back, which is the part worth not losing.**
Nothing measurable is given up today *because the prefetches are not delivering
anything*. That is a statement about the app's current shape, not about
prefetching. It stops being true the moment either of these changes:

- **`loading.tsx` boundaries are added.** Then a prefetch has something real to
  fetch and render instantly on click, and it earns its invocation.
- **Any route stops being `force-dynamic`.** A static or partially-static route
  prefetches its full payload, which is the case prefetching exists for.

So this is not "prefetching is bad" — it is "prefetching is unpaid-for here,
today." Whoever changes either condition should turn it back on and re-measure,
and this note exists so that decision is made rather than inherited.

**Honest caveat.** The 98 empty requests are a fact. The causal chain from
prefetch burst → instance churn → cold start on the next click is a
**hypothesis**: strongly consistent with six simultaneous requests, 12 instances
and four singletons, but not proven. Two earlier rounds of this investigation
went wrong by reasoning from mechanism (`unstable_cache`, then the function
region), so it is recorded as a hypothesis with a cheap test rather than a
conclusion.

**How to verify:** make the change, re-run the same click-through, count distinct
`instanceId` values in the log export. If instance count drops, the theory held.
If it does not, 98 pointless invocations are still gone and the next place to
look is elsewhere.

### Correction (2026-08-05): Fluid Compute was on the whole time

The owner confirmed that Vercel **Fluid Compute is enabled, and was enabled
during these measurements**. That breaks the mechanism this note leaned on.

The reasoning above assumes classic serverless, where an instance serves **one
request at a time** — so six simultaneous prefetches must become six instances.
Under Fluid an instance serves several requests **concurrently**, reusing itself
across I/O waits. Six simultaneous requests do not, on their own, require six
instances.

So the numbers are unchanged and still damning — 98 of 101 empty, 12 instances
for one user, four of them serving a single request — but **the explanation for
the churn is now unknown**, not merely unproven. Candidates worth *measuring*
rather than believing: a new instance may ramp its concurrency before accepting
a full load; scale-out may key on CPU or region rather than in-flight count; a
deployment mid-session mints fresh instances regardless.

This is the third time this investigation has been wrong by reasoning from
mechanism (`unstable_cache`, then the function region, now the concurrency
model). The pattern is consistent enough to state as a rule: **on this platform,
measure first and explain second.** The click-through and log export decide it;
nothing above should be treated as the reason until they do.

What does *not* change: the prefetches bought nothing (that is measured), and
removing them removed real invocations (also measured). The fix stands on its
own regardless of what the instance count turns out to do.

One thing this correction improves rather than damages: `inFlight` in
`lib/framework.ts` is a single-flight guard that, under classic serverless,
could never fire — one request per instance means there is no second caller to
dedupe against. Under Fluid it does the job it was written for. The concurrency
audit that goes with this is in `docs/deploy.md`.

### Resolution (2026-08-05): measured in production, and the churn is gone

The measurement the correction above demanded, taken by the owner on a live
single-user session — Vercel Observability, *Function Invocations Count* grouped
by **Function Start Type**, Environment = Production:

| Start type | Count |
|---|---|
| `hot` | 12 |
| `prewarmed` | 2 |
| `cold` | **no row — zero** |

**Zero cold starts.** The churn — 12 instances for one user, four serving a
single request and never reused — does not reproduce. Instances are being
reused, and the two `prewarmed` ones were ready before the request arrived, so
nobody waited.

**Held to the rule this note set.** The outcome is measured; the cause is not
claimed. Fluid's prewarming may be doing some or all of the work, and this
measurement cannot separate it from the prefetch removal. After three mechanisms
proposed and disproved, "cold starts are zero" is what is known — "because we
removed prefetching" is not.

Two dead ends, recorded so the next person skips them:
- **The dashboard's log export omits `instanceId`.** The method originally
  written into the open item — "count distinct `instanceId` values" — cannot be
  carried out. There is no instance dimension in Observability either.
- **`Function Invocations Count` grouped by *HTTP Status* answers a different
  question** (volume and error rate: 57 invocations, zero 4xx/5xx — healthy, and
  beside the point).

`Function Start Type` is the dimension that answers it. It is arguably the
better measure anyway: cold starts are what instance churn actually *costs*,
and counting them skips the inference from instance count to user-visible delay.

## Where this stands (end of 2026-08-04)

Shipped in PR #6: N2, N8, N9 (the two parts that need no email), N11 measure and
leading, N13. Migration `0003` applied to the pilot database.

Shipped in PR A2: **N7**. Assignment is live. `getOrCreateAssessment` is gone, so
an assessment exists only because an admin assigned it from `/admin/people`; the
completion denominator counts assignments, and the two crutches that existed to
paper over rows appearing unbidden — the `Math.max(invitedCount, …)` fudge and
the `assessee_is_pm` filter — were deleted, not left in place to disagree
quietly with the new number. `CompletionStats.invited` is now `assigned`.
Withdrawing an assignment is allowed only while nothing has been scored, and the
e2e suite proves the server refuses a withdraw posted from a tab that went stale
after the person started. 112/112 against the live database.

Shipped in PR B: **N6**. Archive, not delete. Scores, frozen targets and the
completion timestamps all survive, so a figure already reported upward stays
reconcilable; the review panel states "N archived, excluded" rather than letting
the headline number move with nothing on screen to explain it. Archiving is
reversible, the reason is required, and an archived record stays openable but
never editable.

**Migration `0004` was required and is applied.** `0001` declared
`unique (assessee_id, cycle)`; an archived row still occupied that slot, so
archiving somebody's cycle would permanently have prevented re-assigning it to
them. `0004` replaces the constraint with a partial unique index over live rows.
Verified both directions against the live database after applying: re-assigning
after an archive succeeds, and two live assessments for one person and cycle are
still refused. `npm run e2e` is **149/149**.

Applying it also exposed a gap the pre-migration suite could not reach. Once a
person was re-assigned, their archived record disappeared from the People screen
entirely — so **Restore was unreachable**, and the "already has a live
assessment" guard could never fire through the UI. An archived record that
vanishes the moment somebody is re-assigned is a delete with extra steps, not
history. The archived line now renders beside the live one.

Shipped with the amendment approved: **N14**. Prose left, scoring panel right and
pinned above 1100px; one column with the actions fixed to the viewport below it.
Measured before → after: 2048×1152 went from 363px of scroll to fitting outright,
2560×1440 from 75px to fitting, and the 1440×900 laptop from 615px to 61px with
Save on screen on load. The longest control still scrolls its prose and always
will — ICB4 source text is never edited — but Save is on screen on load at every
width tested, including 390×844. Prose still renders at exactly the 52ch cap, so
the container widened and the measure did not.

Two things measurement caught that looking would not have. `position: sticky`
cannot pin the mobile action bar: the scoring panel sits below a long indicator,
so on load its whole box is off-screen, and sticky only holds an element inside
its parent's visible range — `fixed` was needed. And an inline `style` on the
actions row would have silently beaten the mobile media query, the same trap as
the `flex: 1` one in the earlier mobile audit.

**One measurement worth a decision, not fixed here.** The prose now measures
**72–73 characters per line**, against the 60–70 that DESIGN.md §Layout asks for.
That is not a regression from this change — the cap governs identically before
and after — it means the original `52ch` calibration was optimistic; it was
derived as "≈68" by a rougher method than the widest-line measurement used here.
Tightening `--measure` to about `48ch` would land inside the range. Left alone
deliberately: it changes reading width on every page, and N11 says the palette
and readability are to be re-judged by the owner now the layout is fixed, so this
belongs in that judgement rather than ahead of it.

Shipped in PR C: **N10, N12, N5, N4**. Header chrome on a phone went from 204px
to 122px (24% of the screen to 14%), and the People table from 699px inside a
300px wrapper to 316px with no sideways scroll — tables are one card per row
below 560px now, each cell labelled by the header it lost. Light / Dark / Auto
lives in a cookie with no client component. The controls filter is a query
parameter, and progress keeps reporting the whole assessment under it.

**One N10 item did not exist.** "`.sec-head` collides with its eyebrow" was
logged from reading the CSS; measured, `overlap: false` at both 390px and 360px
— it is cramped, not colliding. The eyebrow now wraps to its own line, which is
worth doing, but the note was wrong.

**N4 was decided after N5, as planned, and the filter changed the answer.** With
"Not scored" one click away, shouting at every unscored row is noise. The row
carries its state quietly — a left edge, and a slight recession once scored —
and the badge stays as the accessible label, so colour is never the only signal.

Still open, in build order — the reasoning for each is in its note above:
3. **N1** preview/database scoping and **N1b** staging — owner's call, plus the
   migration-tracking gap that should close before a second database exists.
4. **N11 palette**, **N15 session bounds** and **SMTP** — all waiting on the
   owner, not on code.

## Triage summary

| Open | Fixed | Superseded | Deferred | Won't do |
|---:|---:|---:|---:|---:|
| 2 | 8 | 1 | 2 | 0 |

Nothing buildable is left. What remains is the owner's: **N1** (untick
Preview/Development on the two secret-bearing Vercel env vars) and **N1b**
(a staging project), plus the standing decisions — **N11** palette and the
72–73 character measure, **N15** session bounds, and **SMTP**.

Open items, in the order they should probably be built:

**Blocked on a decision, not on code:** emailed invite links (N8) and
self-service password reset (N9) both need outbound mail. One SMTP decision
unblocks both, and needs an IT/policy answer about whether a third-party sender
is acceptable for a bank.

Plus one hazard worth fixing independently of all of the above: `invite remove`
hard-deletes a live assessment today, silently, via `on delete cascade` from
`app_user`. Verified against the live database.
