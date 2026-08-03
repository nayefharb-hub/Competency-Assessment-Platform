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

## Triage summary

| Open | Fixed | Superseded | Deferred | Won't do |
|---:|---:|---:|---:|---:|
| 4 | 1 | 1 | 1 | 0 |
