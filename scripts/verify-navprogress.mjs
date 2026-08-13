/**
 * One-off verification for the top navigation progress bar (NOT part of the e2e
 * suite — it is timing-based and would be a flake there). Seeds a disposable
 * @example.test admin, signs in, delays the next in-app navigation so it stays
 * pending well past the 150ms threshold, and asserts `.navprogress.on` appears
 * during the wait and clears after. Screenshots the pending state as evidence.
 *
 * Run: node --env-file=.env.local scripts/verify-navprogress.mjs
 */
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";

const BASE = "http://127.0.0.1:3000";
const CHROME = process.env.E2E_CHROMIUM ?? "/opt/pw-browsers/chromium";
const ACCT = { email: "qa.navprogress@example.test", name: "QA NavProgress", password: "Navprogress-" + Math.random().toString(36).slice(2, 10) };

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function purge() {
  const { data: u } = await db.from("app_user").select("id").eq("email", ACCT.email).maybeSingle();
  if (u) await db.from("app_user").delete().eq("id", u.id);
  const { data: list } = await db.auth.admin.listUsers();
  const found = list.users.find((x) => x.email === ACCT.email);
  if (found) await db.auth.admin.deleteUser(found.id);
}

async function seed() {
  await purge();
  const created = await db.auth.admin.createUser({ email: ACCT.email, password: ACCT.password, email_confirm: true });
  if (created.error) throw created.error;
  const { error } = await db.from("app_user").insert({
    id: created.data.user.id, email: ACCT.email, full_name: ACCT.name,
    job_title: "Head of PMO", role: "admin", must_change_password: false,
  });
  if (error) throw error;
}

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "  ✓" : "  ✗ FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); ok ? pass++ : fail++; };

await seed();
const browser = await chromium.launch({ executablePath: CHROME });
try {
  const ctx = await browser.newContext({ baseURL: BASE });
  const page = await ctx.newPage();
  await page.goto("/login");
  await page.fill("#email", ACCT.email);
  await page.fill("#password", ACCT.password);
  await page.click('form button[type="submit"]:has-text("Sign in")');
  await page.waitForURL((u) => !u.pathname.endsWith("/login"), { timeout: 15000 });
  check("signed in", !page.url().includes("/login"), page.url());

  // Not visible at rest.
  const atRest = await page.locator(".navprogress.on").count();
  check("bar is hidden when idle", atRest === 0);

  // Hold the NEXT navigation open: delay any RSC/document fetch by ~700ms so the
  // pending window comfortably clears the 150ms show threshold.
  let delaying = true;
  await page.route("**/*", async (route) => {
    const req = route.request();
    const isNav = req.resourceType() === "document" || req.url().includes("_rsc");
    if (isNav && delaying) { await new Promise((r) => setTimeout(r, 700)); }
    route.continue().catch(() => {}); // may lose the race with unroute; harmless
  });

  // Click a nav link and, WITHOUT awaiting the navigation, watch for the bar.
  await page.getByRole("link", { name: "Analysis" }).click({ noWaitAfter: true });
  let appeared = false;
  for (let i = 0; i < 40; i++) {
    if (await page.locator(".navprogress.on").count()) { appeared = true; break; }
    await page.waitForTimeout(25);
  }
  check("progress bar appears during a pending navigation", appeared);
  if (appeared) await page.screenshot({ path: "/tmp/claude-0/-home-user-Competency-Assessment-Platform/1559fa03-b4bd-5e5c-b0ed-741ef2c39603/scratchpad/navprogress-pending.png" });

  await page.waitForURL((u) => u.pathname.includes("/analysis"), { timeout: 15000 });
  delaying = false;
  // After it lands, the bar clears.
  let cleared = false;
  for (let i = 0; i < 40; i++) {
    if ((await page.locator(".navprogress.on").count()) === 0) { cleared = true; break; }
    await page.waitForTimeout(25);
  }
  check("progress bar clears once the page has loaded", cleared);

  await ctx.close();
} finally {
  await browser.close();
  await purge();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
