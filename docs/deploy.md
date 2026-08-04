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

## Notes

- **Preview deployments.** Once connected, every pushed branch gets its own URL,
  so changes can be looked at before they reach the production one.
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
