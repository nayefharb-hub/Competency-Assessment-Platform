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

No action taken — this is a judgement call about a real database, so it is
recorded rather than decided unilaterally.

## Triage summary

| Open | Fixed | Deferred | Won't do |
|---:|---:|---:|---:|
| 1 | 0 | 0 | 0 |
