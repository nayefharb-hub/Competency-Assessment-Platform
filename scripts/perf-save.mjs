/**
 * Where does a control save actually spend its time? (N18 remainder)
 *
 * Drives 10 real saves against LOCALHOST, where network is ~0ms, and splits
 * each save into: POST duration, follow-up GET duration, and wall time from
 * click to the next control being on screen. wall - POST - GET = client work
 * (render, RSC apply, browser). Production adds only network on top of this.
 *
 * Uses a disposable QA account (qa.perf@example.test), inserts the assessment
 * row directly (state draft), and deletes everything afterwards.
 */
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";

const BASE = "http://127.0.0.1:3000";
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const PM = { email: "qa.perf@example.test", name: "QA Perf PM", password: "QaPerf1!pass" };

async function purge() {
  const { data: u } = await db.from("app_user").select("id").eq("email", PM.email).maybeSingle();
  if (u) {
    const { data: as } = await db.from("assessment").select("id").eq("assessee_id", u.id);
    for (const a of as ?? []) {
      await db.from("score").delete().eq("assessment_id", a.id);
      await db.from("assessment").delete().eq("id", a.id);
    }
    await db.from("app_user").delete().eq("id", u.id);
  }
  const { data: au } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const stray = (au?.users ?? []).find((x) => x.email === PM.email);
  if (stray) await db.auth.admin.deleteUser(stray.id);
}

await purge();

// account
const created = await db.auth.admin.createUser({ email: PM.email, password: PM.password, email_confirm: true });
if (created.error) throw new Error(created.error.message);
const uid = created.data.user.id;
const ins = await db.from("app_user").insert({
  id: uid, email: PM.email, full_name: PM.name, job_title: "Project Manager",
  role: "assessee", must_change_password: false,
});
if (ins.error) throw new Error(ins.error.message);

// assessment row, mirroring assignAssessment's insert
const { data: fw } = await db.from("framework").select("id").limit(1).single();
const { data: prof } = await db.from("benchmark_profile").select("id, name").eq("name", "Intermediate").maybeSingle()
  ?? {};
let profileId = prof?.id;
if (!profileId) {
  const { data: anyProf } = await db.from("benchmark_profile").select("id").limit(1).single();
  profileId = anyProf.id;
}
const cycle = String(new Date().getUTCFullYear());
const now = new Date().toISOString();
const a = await db.from("assessment").insert({
  framework_id: fw.id, profile_id: profileId, assessee_id: uid, cycle,
  state: "draft", assigned_at: now, assigned_by: uid,
}).select("id").single();
if (a.error) throw new Error(a.error.message);

/*
 * Ten saves that each step to the NEXT CONTROL — which is no longer the same
 * as "the first eleven controls".
 *
 * PR #23 made a competence element the unit of a sitting (D25): the last
 * control in a CE sends the PM UP to the competency list instead of onward, so
 * a naive walk down the ordered list stalls there waiting for a crumb that
 * will never appear. That is correct product behaviour and wrong for this
 * script, which exists to time the ordinary control→control save.
 *
 * So: take pairs that are adjacent AND inside the same CE, and skip the
 * boundaries. Enough controls are fetched that ten such pairs exist.
 */
const { data: controls } = await db.from("control")
  .select("code, active, competence_element:ce_id(code)")
  .eq("active", true).order("sort_order").limit(40);

const pairs = [];
for (let i = 0; i < controls.length - 1 && pairs.length < 10; i++) {
  const here = controls[i], next = controls[i + 1];
  if (here.competence_element?.code !== next.competence_element?.code) continue;
  pairs.push([here.code, next.code]);
}
if (pairs.length < 10) throw new Error(`only ${pairs.length} in-CE pairs found`);

const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM || undefined });
const ctx = await browser.newContext({ baseURL: BASE });
const page = await ctx.newPage();

// request timing capture
const reqs = [];
page.on("requestfinished", async (r) => {
  const t = r.timing();
  reqs.push({
    method: r.method(), url: r.url().replace(BASE, ""),
    ms: t.responseEnd > 0 ? Math.round(t.responseEnd) : null,
    at: Date.now(),
  });
});

await page.goto("/login");
await page.fill("#email", PM.email);
await page.fill("#password", PM.password);
await page.click('form button[type="submit"]:has-text("Sign in")');
await page.waitForFunction(() => !location.pathname.startsWith("/login"));

const rows = [];
for (let i = 0; i < 10; i++) {
  const [here, next] = pairs[i];
  // Navigate explicitly: the pairs are not one continuous walk any more, since
  // the CE boundaries between them are skipped.
  await page.goto(`/assess?c=${here}`);
  await page.waitForSelector(".optlist");
  await page.check('input[name="level"][value="3"]');
  reqs.length = 0;
  const t0 = Date.now();
  // `type="button"`, NOT submit. The save-UX change (PR #20) replaced the form
  // post with a commit-and-navigate click, and this selector was left behind —
  // so the one tool CLAUDE.md says performance claims must come from had been
  // timing out for two PRs. A measurement script that cannot run is worse than
  // none: the rule kept pointing at it and nobody noticed it was silent.
  await page.click('.assess-actions button:has-text("Next control"), '
    + '.assess-actions button:has-text("Finish this competency"), '
    + '.assess-actions button:has-text("Back to the list")');
  // next control visibly on screen = what the user experiences as "done"
  await page.waitForFunction(
    (code) => document.querySelector(".crumb")?.textContent?.includes(code),
    next, { timeout: 30_000 },
  );
  const wall = Date.now() - t0;
  const post = reqs.find((r) => r.method === "POST");
  const gets = reqs.filter((r) => r.method === "GET" && r.url.startsWith("/assess"));
  const postMs = post?.ms ?? 0;
  const getMs = gets.reduce((s, g) => s + (g.ms ?? 0), 0);
  rows.push({ save: `${here}→${next}`, wall, post: postMs, gets: getMs, other: reqs.length - 1 - gets.length, gap: wall - postMs - getMs });
}

console.table(rows);
const med = (k) => { const v = rows.map((r) => r[k]).sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };
console.log(`\nMEDIANS  wall=${med("wall")}ms  post=${med("post")}ms  gets=${med("gets")}ms  gap(client)=${med("gap")}ms`);

await browser.close();
await purge();
console.log("cleaned up");
