# Email for user registration — options, and why the pilot defers it

**Status: exploration, not decided.** The pilot ships on **Option A (out-of-band, no
email)**. This note captures the alternatives so the decision is ready when the
product phase forces it. Turning on email reverses a recorded design decision
(`lib/auth.ts`, `app/change-password/actions.ts`), so it goes through
`/office-hours` → `/plan-eng-review` → build → `/cso` when the time comes.

## Where we are today

There is **no email in the system, by design.** `scripts/invite.mjs` creates both
halves of an account — the `auth.users` row and the `public.app_user` row (which
**is** the allowlist) — sets a temp password printed once, and you hand it over
out of band. First login hits the `must_change_password` gate and the PM sets
their own password via their **own session** (`auth.updateUser`), which is why it
needs no SMTP. Public signup is off. No email dependency in `package.json`.

## The three shapes

- **A — Out-of-band (current).** Temp password, changed on first login. Zero infra,
  ships today. Genuinely fine for a 9-person single-tenant pilot.
- **B — Supabase invite/recovery emails + a custom SMTP provider.**
  `admin.inviteUserByEmail` / `admin.generateLink` / `resetPasswordForEmail`.
  Supabase's built-in mailer is rate-limited/test-only, so a real SMTP provider is
  required even for 9 sends. `invite.mjs` switches from `createUser` + temp password
  to `inviteUserByEmail` (still writes the `app_user` allowlist row — the invite API
  creates `auth.users` but not the allowlist). Add a set-password landing page.
  Small, contained. **Touches auth → `/cso`.**
- **C — Send the emails yourself via a provider SDK.** `generateLink` + e.g. Resend's
  SDK from a server action. Full branding, and it stands up the transactional
  channel we'll want anyway (assignment notifications, the 7-day stall nudge the
  People screen already computes but can't deliver). More code. **`/cso`.**

## Provider options (free / low cost)

| Provider | Free tier | Notes |
|---|---|---|
| **Brevo** (ex-Sendinblue) | ~300 emails/day (~9k/mo) | Real SMTP relay; free-tier emails carry a "Sent with Brevo" footer; it's a marketing suite, transactional is the hook |
| **Resend** | ~3,000/mo, 100/day | Best DX, SMTP or API; requires domain verification; one domain / limited seats on free |
| **MailerSend** | ~3,000/mo | Similar to Resend |
| **Amazon SES** | ~$0.10 per 1,000 (≈ free at our scale) | Cheapest at volume; heavier setup (domain verify + sandbox exit) |
| **Gmail App Password** | ~500/day | Already available; pilot-only hack, no custom domain, ToS-marginal for app relay |

**How "free" works:** freemium as customer acquisition. A few hundred emails/day
costs the provider almost nothing, so it's given away to win you before you scale.
They monetize volume, dedicated sending IPs, branding removal, marketing features
(Brevo), and team seats (Resend). Free tiers send over **shared IP pools**, so
deliverability depends on SPF/DKIM on your own domain. Provider lock-in is low —
SMTP is standard, swapping is a config change.

## What does **not** work (checked)

- **Google One** — cloud storage + perks, not email infrastructure. Upgrading it
  unlocks no SMTP. Only **Google Workspace** (paid, per-user, custom domain) gives a
  real relay (`smtp-relay.gmail.com`); a plain Gmail can relay via App Password but
  is capped (~500/day), can't send from a custom domain, and is ToS-marginal for an
  app.
- **Proton Pass** — password manager, unrelated to sending. Proton **Mail** exposes
  SMTP only through **Proton Mail Bridge**, which needs a **paid** Mail plan and runs
  as a **local desktop app** (localhost SMTP) — it cannot be a hosted relay for
  Supabase/Vercel.

## The real gate (bank context)

KIB is a bank; registration emails carry **staff data** (names, addresses, "you
have been assessed"). A third-party email processor typically needs **IT/security
sign-off** and possibly a data-processing agreement. For an internal PMO tool that
compliance step, not the price, is the deciding factor — and **Option A avoids it
entirely** (no processor, no domain setup, no sign-off).

## Recommendation

- **Pilot:** stay on **A**.
- **Product phase:** **Brevo or Resend free tier → Supabase SMTP**, on a KIB-owned
  domain with SPF/DKIM, after IT/security sign-off. Reserve **C** for transactional
  mail beyond registration.
- Cost is effectively **$0** at pilot and early-product scale; what you trade is a
  branding footer (Brevo), a domain-verification step, shared-IP deliverability, and
  a third party touching staff data.
