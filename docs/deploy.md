# Deploying to Vercel

Ten minutes, all through the web UI. No terminal, no Node install.

## 0. Decide which code Vercel serves

Vercel deploys your repo's **default branch** (`main`) to the production URL.
The Supabase work lives on `claude/cap-supabase-integration-ubitap`, so deploying
`main` as it stands would serve the older seed-file version of the app.

Pick one:

- **Merge the pull request** (recommended). On the PR page: *Ready for review* →
  *Merge pull request*. `main` then holds the wired-up app and everything below
  just works.
- **Or keep it unmerged** and point Vercel at the branch: finish the import
  below, then *Settings* → *Git* → *Production Branch* → type
  `claude/cap-supabase-integration-ubitap` → *Save* → *Deployments* → *Redeploy*.

## 1. Connect the repo

1. Go to **vercel.com** and *Continue with GitHub*.
2. Dashboard → **Add New…** → **Project**.
3. Find **Competency-Assessment-Platform** in the *Import Git Repository* list
   and click **Import**.
   - Not listed? Click *Adjust GitHub App Permissions*, grant Vercel access to
     this repository, come back.

## 2. Set the environment variables

On the *Configure Project* screen, expand **Environment Variables** and add four
rows. Values come from Supabase → *Project Settings* → *API*.

| Key | What it is |
|---|---|
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_URL` | the same URL again |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | publishable key — safe in the browser, reads nothing |
| `SUPABASE_SERVICE_ROLE_KEY` | secret key — **full database access** |

Leave *Framework Preset* as **Next.js** and *Root Directory* as `./`; both are
detected correctly.

Only the two `NEXT_PUBLIC_` values are ever sent to the browser. That naming is
load-bearing: Next.js inlines any `NEXT_PUBLIC_*` variable into client
JavaScript, so **never rename the service role key to start with it.**

**Tick `Preview` as well as `Production` on all four.** Vercel scopes variables
per environment, and a variable set for Production only does not exist in a
preview deployment. The failure is confusing rather than obvious: `/login`
renders fine, because it touches no database, and then sign-in dies with a bare
*"A server error occurred"* — the sign-in action is the first code that calls
`db()`. The Runtime Logs for that deployment name the missing variable outright,
because `required()` in `lib/supabase/server.ts` says which one it wanted.

**These are TEAM-level (shared) variables, not project-level ones.** That is why
the environment picker on the project's own Environment Variables screen is
greyed out and will not open: a shared variable overrides the project one, so the
project row is read-only by design. Nothing is broken and nothing needs
unlocking — edit them at **Team Settings → Environment Variables** instead.

Two consequences of them being shared, both worth checking before ticking
`Preview`:
- A shared variable applies to **every project linked to it**, so the grant is
  not scoped to this app.
- **Deployment Protection is per-project.** The service-role key on a preview URL
  is only defensible because Vercel Authentication guards *this* project (see
  Notes). Another project sharing the same variable without that protection would
  be an unguarded URL holding RLS-bypassing access to real employee data.

Changing a variable does **not** affect existing deployments. Redeploy after
editing (Deployments → `⋯` → Redeploy), the same way Fluid Compute needs one.

Worth setting while you are there: mark `SUPABASE_SERVICE_ROLE_KEY` **Sensitive**.
It stops the value being read back out through the API or CLI by anyone with
project access, and has no effect on how the app reads it.

## 3. Deploy

Click **Deploy** and wait ~2 minutes. You get a URL like
`competency-assessment-platform.vercel.app`.

**No Supabase configuration is needed.** Sign-in uses email and password, not
magic links, so there are no redirect URLs to allowlist — a step people usually
expect and it genuinely does not apply here.

## 4. First sign-in

Only invited accounts can get in; there is no public signup. If nobody has been
invited yet, run `npm run invite add …` from a machine with the repo and
`.env.local` (see `supabase/README.md`), or ask whoever set the project up.

Then: sign in. Your first stop is **/change-password** — every account is
created with a password somebody else chose, and the app refuses every other
route until you replace it. That is the gate working, not a fault.

After that, nothing is waiting for you until an admin **assigns** you the cycle
from **People**. Signing in creates nothing.

## 5. Inviting the PMs

Do it in the app: sign in as an admin → **People** → *Add someone*. You set a
starting password per person and hand it over out of band; they are made to
replace it on first sign-in, so it is only ever valid once. Use a different one
per person — a shared value lets anyone who learns it sign in as any colleague
who has not logged in yet.

The terminal path still exists for a machine with the repo checked out:

    npm run invite add someone@kib.com.kw "Full Name" assessee --title "Project Manager"

Give the Head of PMO `admin` (which carries assessor rights).

## 6. Assigning the cycle

Adding somebody does not start anything. On the same **People** screen, tick who
should take this cycle and press *Assign selected*. Only then does an assessment
exist for them, and the completion figure counts assignments — so the
denominator is the number of people you actually asked, not the number who hold
a login. An assignment nobody has started can be withdrawn; once anything is
scored it cannot, because that would destroy the scores.

## Runtime: Fluid Compute is ON, and it constrains how we write server code

**State:** enabled (Project → Settings → Functions), confirmed by the owner on
2026-08-05, and **already enabled during the N16–N21 performance work**. This is
a dashboard toggle with no trace in the repo, which is exactly why it is written
down here — a rebuild that silently lost it would change the app's concurrency
model without changing a line of code.

**What it changes.** Classic serverless gives one instance one request at a
time: while our code waits ~200ms for Supabase, that instance is pinned and
unavailable to anyone else. Fluid lets a single instance serve **several
requests concurrently**, reusing it across I/O waits. For this app — roughly 95%
of a request is spent waiting on Postgres (N16, N18) — that is the right shape,
and the billing model that goes with it charges for CPU actually burned rather
than wall-clock spent waiting.

**The rule it imposes, which is the part to not lose.** With concurrency inside
an instance, **module-level mutable state is shared between simultaneous
requests**. Under the old model a module-level variable was sloppy but
survivable, because requests could not interleave. Under Fluid, one holding
anything user-specific is a cross-user data leak, not a code-smell.

So: **no per-user state at module scope, ever.** Request-scoped data belongs in
React's `cache()` (which is scoped per request, not per instance) or is passed
down the call chain.

**Audit as of `aed70e3`.** Method, so it can be re-run rather than trusted:
swept `app/`, `lib/` and `proxy.ts` for module-scope `let`/`var`, for `const`
bound to a mutable container (`{}`, `[]`, `new Map`/`Set`/`WeakMap`), and for
`globalThis` assignment. The last two categories are empty; `proxy.ts` holds
only an immutable `PUBLIC_PATHS`. That leaves three, all safe:

| Where | What | Why it is safe under concurrency |
|---|---|---|
| `lib/supabase/server.ts:61` | `serviceClient` singleton | Stateless: `persistSession: false`, `autoRefreshToken: false`. Holds no user. |
| `lib/framework.ts:136` | `cache` — the framework memo | Same data for every viewer; sharing it is the point. |
| `lib/framework.ts:137` | `inFlight` — single-flight dedupe | **Improves** under concurrency: it stops two simultaneous loads both hitting the database, which it could never do when an instance served one request at a time. |

Viewer resolution (`lib/auth.ts`) uses React's `cache()` — request-scoped, and
therefore correct when requests interleave. **No user-specific state at module
scope.**

**One known race, small and pre-existing.** In `getFrameworkUncached`, if
`invalidateFramework()` runs while a load is in flight, that load's `.then()`
still writes its now-stale result into `cache`. This exists independently of
Fluid — an invalidation during an `await` does the same thing — and concurrency
makes it *more likely*, not newly possible. Worst case is a stale `kib_note` for
up to `TTL_MS` (10 minutes), which is the trade already stated and accepted at
`lib/framework.ts:130`. Recorded rather than fixed, because the fix (a
generation counter checked before the write) costs more than the symptom.

**What this means for the N21 hypothesis.** The 12-instances-for-one-user
measurement was taken **with Fluid already on**. So "six simultaneous prefetches
force six instances because an instance can only serve one request" is *not* the
explanation — under Fluid an instance can absorb them. The observation stands;
the mechanism behind it does not, and N21's cold-start chain is weaker than it
appeared. See N21 for how that changes the verification.

## Notes

- **Preview deployments, and why they share the production database.** Every
  pushed branch gets its own URL, so a change can be looked at before it reaches
  production — but only once the environment variables are scoped to `Preview`
  as well as `Production` (see section 2). Until they are, the preview URL serves
  a sign-in page that cannot sign anyone in, and the only way to see a change is
  to merge it first. That happened twice: PR #14 and #15 were both reviewed after
  landing rather than before.

  **The decision (2026-08-05): reuse the production Supabase project for
  previews, guarded by Vercel Authentication.** Preview URLs are shareable and
  not secret, so putting the service-role key — full, RLS-bypassing access to
  real KIB employee data — behind one would be indefensible on its own. What
  makes it acceptable is *Project Settings → Deployment Protection → Vercel
  Authentication*, set to **Standard Protection**: a visitor must be logged in to
  Vercel and a member of the team before the deployment answers at all. **If that
  is ever switched off, the preview scoping must come off with it.**

  The consequence to keep in mind while using a preview: it is pointed at the
  **live pilot database**. Approving an assessment or editing a person there is a
  real change to real records, not a sandbox. `scripts/demo.mjs reset <email>`
  undoes a self-assessment; nothing undoes an approval.

  **If that stops being comfortable**, the alternative is a second Supabase
  project for preview with its own keys and seeded fake people. It is proper
  isolation, and it costs a seed script that has to be kept in step with the
  migrations. Not worth it for a nine-person pilot; worth revisiting the moment
  anyone outside the PMO gets a preview link, or the data stops being KIB's own.
- **Data residency.** This puts KIB employee data on external cloud
  infrastructure. That was accepted for the pilot in the design doc — worth
  re-reading now that it is real rather than hypothetical, and worth the
  informal IT sign-off that document suggests.
- **Rotate the secret key when the pilot ends** (`docs/STATUS.md` open items).
- **Session lifetime is long, deliberately unbounded, and worth a decision.**
  The session cookie is a *persistent* one: `@supabase/ssr` sets a 400-day
  max-age, so closing the browser does not sign you out, and the proxy refreshes
  it on every request. Two knobs, neither of them set today:
  - **Supabase → Authentication → Sessions** — "time-box user sessions" (an
    absolute cap) and "inactivity timeout". Both are unset, so a session in
    regular use renews indefinitely.
  - `SESSION_COOKIE.maxAge` in `lib/supabase/cookies.ts` — a browser-side bound,
    independent of the server setting.

  For a bank's internal tool this should probably be bounded rather than left at
  the library default. It is a policy call, not a code one, which is why it is
  written down here instead of guessed at.

  What *is* set in code: the session cookie is `httpOnly` and `Secure` in
  production. `@supabase/ssr` defaults `httpOnly` to `false` so a browser-side
  Supabase client can read the token — this app has none, so that default bought
  nothing and exposed the session to any script on the page. `scripts/e2e.mjs`
  asserts both flags and that page JavaScript cannot see the cookie.
