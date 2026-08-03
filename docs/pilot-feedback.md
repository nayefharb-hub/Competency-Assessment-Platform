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

Superseded in part by N7 — see below. The archive is still worth having, but for
a narrower reason than "defend the metric".

### N7 — an assessment is *assigned* by the admin, not created by logging in

**Status:** Open — accepted design, supersedes the metric argument in N6

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

**Status:** Open — audited, specific defects below

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

**Status:** Open — question answered, toggle not built

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

## Where this stands (end of 2026-08-03)

Shipped in PR #6: N2, N8, N9 (the two parts that need no email), N11 measure and
leading, N13. Migration `0003` applied to the pilot database.

Still open, in build order — the reasoning for each is in its note above:

1. **N7** assignment — largest, and the one that makes the completion figure a
   fact rather than an inference. Specified and reviewed; columns already exist.
2. **N6** archive — columns already exist too.
3. **N10** mobile · **N12** theme toggle · **N5** controls filter · **N4**
   scored-state emphasis. Decide N5 before N4: a filter may mean the badges want
   quietening rather than amplifying.
4. **N1** preview/database scoping and **N1b** staging — owner's call, plus the
   migration-tracking gap that should close before a second database exists.
5. **N11 palette** and **SMTP** — both waiting on the owner, not on code.

## Triage summary

| Open | Fixed | Superseded | Deferred | Won't do |
|---:|---:|---:|---:|---:|
| 8 | 1 | 1 | 1 | 0 |

Open items, in the order they should probably be built:

1. **N7 + N8 + N9** — the admin People screen: add a person, assign them a
   cycle, reset a password. One screen, one workflow. Largest item; also changes
   the entry path for every assessee and the completion metric's denominator.
   The "change my own password" half of N9 is independent and can ship first.
2. **N6** — archive, cleaner to design once N7 exists
3. **N10** — mobile: header, section headings, People table
4. **N5** — filter the controls list
5. **N4** — scored-state emphasis, decided together with N5

**Blocked on a decision, not on code:** emailed invite links (N8) and
self-service password reset (N9) both need outbound mail. One SMTP decision
unblocks both, and needs an IT/policy answer about whether a third-party sender
is acceptable for a bank.

Plus one hazard worth fixing independently of all of the above: `invite remove`
hard-deletes a live assessment today, silently, via `on delete cascade` from
`app_user`. Verified against the live database.
