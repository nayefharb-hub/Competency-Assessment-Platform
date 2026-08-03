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

Then: sign in → **Start self-assessment** → open one control. That first visit is
what creates your assessment record for the cycle.

## 5. Inviting the PMs

One row per person, from a machine with the repo checked out:

    npm run invite add someone@kib.com.kw "Full Name" assessee --title "Project Manager"

Each prints a temporary password once. Hand them over out of band. There is no
change-password screen yet — re-running `invite add` with `--password` resets an
existing account rather than creating a second one.

Give the Head of PMO `admin` (which carries assessor rights). Only `assessee`
accounts count toward the completion metric, so the assessor's own trial run
cannot distort the number the pilot exists to measure.

## Notes

- **Preview deployments.** Once connected, every pushed branch gets its own URL,
  so changes can be looked at before they reach the production one.
- **Data residency.** This puts KIB employee data on external cloud
  infrastructure. That was accepted for the pilot in the design doc — worth
  re-reading now that it is real rather than hypothetical, and worth the
  informal IT sign-off that document suggests.
- **Rotate the secret key when the pilot ends** (`docs/STATUS.md` open items).
