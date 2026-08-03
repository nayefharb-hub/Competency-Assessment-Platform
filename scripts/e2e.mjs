#!/usr/bin/env node
/**
 * End-to-end verification against a RUNNING app and the REAL database.
 *
 *   npm run build && npm start &
 *   node --env-file=.env.local scripts/e2e.mjs --write
 *
 * It drives the whole loop through the browser — sign in, self-score, submit,
 * review-and-revise, accept, approve — and then checks Postgres directly for
 * the state the UI claims to have produced. Checking the database rather than
 * the screen is the point: a page can render a number it never persisted.
 *
 * IT WRITES TO THE DATABASE IT IS POINTED AT, so it refuses to run without
 * --write, and it only ever touches the two @example.test QA accounts, which
 * it creates and deletes itself.
 *
 * Prerequisites: an assessor/admin account, passed as
 *   ADMIN_EMAIL=... ADMIN_PASSWORD=... node --env-file=.env.local scripts/e2e.mjs --write
 */
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";

const BASE = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000";
const CHROME = process.env.E2E_CHROMIUM ?? undefined;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (!process.argv.includes("--write")) {
  console.error("This test writes to the database. Re-run with --write if that is what you want.");
  process.exit(1);
}
if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.error("Set ADMIN_EMAIL and ADMIN_PASSWORD to an assessor/admin account.");
  process.exit(1);
}

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const PM = { email: "qa.pm1@example.test", name: "QA Test PM One", password: "QaTestPm1!pass" };
const OTHER = { email: "qa.pm2@example.test", name: "QA Test PM Two", password: "QaTestPm2!pass" };

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};

/* ------------------------------------------------------------- fixtures */

/** Remove a QA account and everything it produced. `keepAccount` is for the
 *  mid-run reset; the end-of-run call takes the account away too, so the
 *  allowlist and the completion denominator go back to how they were. */
async function purge(email, { keepAccount = false } = {}) {
  const { data: user } = await db.from("app_user").select("id").eq("email", email).maybeSingle();
  if (!user) return;
  const { data: rows } = await db.from("assessment").select("id").eq("assessee_id", user.id);
  for (const a of rows ?? []) {
    await db.from("target_snapshot").delete().eq("assessment_id", a.id);
    await db.from("score").delete().eq("assessment_id", a.id);
    await db.from("assessment").delete().eq("id", a.id);
  }
  if (keepAccount) return;
  await db.from("app_user").delete().eq("id", user.id);
  await db.auth.admin.deleteUser(user.id);
}

async function ensure(person) {
  await purge(person.email, { keepAccount: true });
  const { data: existing } = await db.from("app_user").select("id").eq("email", person.email).maybeSingle();
  if (existing) {
    await db.auth.admin.updateUserById(existing.id, { password: person.password, email_confirm: true });
    return;
  }
  const created = await db.auth.admin.createUser({
    email: person.email, password: person.password, email_confirm: true,
  });
  if (created.error) throw new Error(created.error.message);
  const { error } = await db.from("app_user").insert({
    id: created.data.user.id, email: person.email, full_name: person.name,
    job_title: "Project Manager", role: "assessee",
  });
  if (error) throw new Error(error.message);
}

console.log("Preparing QA accounts…");
await ensure(PM);
await ensure(OTHER);

const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
async function session(email, password) {
  const ctx = await browser.newContext({ baseURL: BASE });
  const page = await ctx.newPage();
  await page.goto("/login");
  await page.fill("#email", email);
  await page.fill("#password", password);
  await page.click('button[type="submit"]');
  await page.waitForLoadState("networkidle");
  return { ctx, page };
}
const idOf = async (email) =>
  (await db.from("app_user").select("id").eq("email", email).single()).data.id;
const assessmentOf = async (email) =>
  (await db.from("assessment").select("*").eq("assessee_id", await idOf(email)).single()).data;

const { data: activeControls } = await db
  .from("control").select("id, code, target_level").eq("active", true).order("sort_order").limit(5000);

/* ---------------------------------------------------- 1. invite-only auth */
console.log("\n[1] Invite-only auth");
{
  const ctx = await browser.newContext({ baseURL: BASE });
  const page = await ctx.newPage();
  await page.goto("/login");
  await page.fill("#email", "not.invited@example.test");
  await page.fill("#password", "whatever123");
  await page.click('button[type="submit"]');
  await page.waitForLoadState("networkidle");
  check("uninvited email is refused", page.url().includes("/login") && (await page.locator('[role="alert"]').count()) > 0);
  await page.goto("/results");
  check("no session cannot reach /results", page.url().includes("/login"));
  await ctx.close();
}

const pm = await session(PM.email, PM.password);
check("invited PM signs in", !pm.page.url().includes("/login"), pm.page.url());
const boss = await session(ADMIN_EMAIL, ADMIN_PASSWORD);
check("assessor/admin signs in", !boss.page.url().includes("/login"), boss.page.url());

/* -------------------------------------- 2. role gates and target blinding */
console.log("\n[2] Role gates and target blinding");
{
  await pm.page.goto("/review");
  check("PM cannot open the assessor review", pm.page.url().includes("denied=1"), pm.page.url());
  await pm.page.goto("/admin");
  check("PM cannot open framework admin", pm.page.url().includes("denied=1"), pm.page.url());

  await pm.page.goto("/assess?c=4.3.1.1");
  const html = await pm.page.content();
  check("self-assessment renders the control", html.includes("4.3.1.1"));
  check("target is absent from the PM's payload", !/target_level|Target level/.test(html));
  check("kib_note (which names targets) is absent", !html.includes("Senior baseline / junior target"));
  check("scale labels come from the database", html.includes("Practised") && html.includes("Proficient"));
}

/* -------------------------------------------- 3. self-scoring persistence */
console.log("\n[3] Self-scoring persists to Postgres");
{
  await pm.page.goto("/assess?c=4.3.1.1");
  await pm.page.check('input[name="level"][value="3"]');
  await pm.page.fill("#evidence", "QA evidence line");
  await pm.page.click('button[type="submit"]');
  await pm.page.waitForLoadState("networkidle");

  const a = await assessmentOf(PM.email);
  const control = activeControls.find((c) => c.code === "4.3.1.1");
  const { data: s } = await db.from("score")
    .select("self_level, evidence, assessor_level")
    .eq("assessment_id", a.id).eq("control_id", control.id).single();

  check("self_level stored", s?.self_level === 3, `got ${s?.self_level}`);
  check("evidence stored", s?.evidence === "QA evidence line");
  check("assessor_level empty before submit", s?.assessor_level === null);
  check("started_at stamped on first save", a.started_at !== null);
  check("state is draft", a.state === "draft");
  check("advanced to the next control", pm.page.url().includes("c=4.3.1.2"), pm.page.url());

  await pm.page.goto("/assess?c=4.3.1.1");
  check("saved score is re-selected on reload", await pm.page.isChecked('input[name="level"][value="3"]'));

  await pm.page.goto("/assess/controls");
  check("submit is blocked while controls are unscored",
    await pm.page.isDisabled('button:has-text("Submit for review")'));

  // The disabled button is a courtesy; the data layer is the actual gate. Force
  // the button live and post anyway, the way a stale tab or a curl would.
  await pm.page.locator('button:has-text("Submit for review")')
    .evaluate((el) => { el.disabled = false; });
  await pm.page.click('button:has-text("Submit for review")');
  await pm.page.waitForLoadState("networkidle");
  check("server refuses an incomplete submit, not just the button",
    (await pm.page.content()).includes("need a score before you can submit"),
    pm.page.url());
  check("state unchanged after the refused submit",
    (await assessmentOf(PM.email)).state === "draft");
}

/* -------------------------------------------------------------- 4. submit */
console.log("\n[4] Submit: draft -> self_submitted");
{
  const a = await assessmentOf(PM.email);
  // deterministic spread, so the rollup has real variation to report
  const rows = activeControls.map((c, i) => ({
    assessment_id: a.id, control_id: c.id, self_level: [2, 3, 3, 4, 1, 3][i % 6],
  }));
  const { error } = await db.from("score").upsert(rows, { onConflict: "assessment_id,control_id" });
  if (error) throw new Error(error.message);

  await pm.page.goto("/assess/controls");
  const text = await pm.page.locator(".progress-head").innerText();
  check("progress reads 132 / 132", text.includes("132 / 132 controls scored"), JSON.stringify(text));
  check("submit is enabled once complete",
    !(await pm.page.isDisabled('button:has-text("Submit for review")')));

  await pm.page.click('button:has-text("Submit for review")');
  await pm.page.waitForLoadState("networkidle");

  const after = await assessmentOf(PM.email);
  check("state = self_submitted", after.state === "self_submitted", after.state);
  check("completed_at stamped (the finished flag)", after.completed_at !== null);
  check("started_at preserved", after.started_at !== null);

  const { data: prefilled } = await db.from("score")
    .select("self_level, assessor_level, assessor_touched").eq("assessment_id", after.id).limit(5000);
  check("assessor_level pre-filled from self_level",
    prefilled.every((r) => r.assessor_level === r.self_level),
    `${prefilled.filter((r) => r.assessor_level !== r.self_level).length} mismatched`);
  check("assessor_touched still false everywhere", prefilled.every((r) => r.assessor_touched === false));

  await pm.page.goto("/assess?c=4.3.1.1");
  check("submitted assessment is read-only to the PM",
    await pm.page.isDisabled('input[name="level"][value="3"]'));
  await pm.page.goto("/results");
  check("PM cannot see results before approval",
    (await pm.page.content()).includes("Results are not available yet"));
}

/* ------------------------------------------ 5. assessor review-and-revise */
console.log("\n[5] Assessor review-and-revise");
const assessmentId = (await assessmentOf(PM.email)).id;
{
  await boss.page.goto("/review");
  const overview = await boss.page.content();
  check("overview lists the submitted assessment", overview.includes(PM.name));
  check("completion panel is on the assessor's first screen",
    overview.includes("Median time to complete") && overview.includes("Finished"));

  await boss.page.goto(`/review?a=${assessmentId}`);
  await boss.page.selectOption('select[name="level:4.3.1.1"]', "5");
  await boss.page.selectOption('select[name="level:4.3.1.2"]', "0");
  await boss.page.click('button:has-text("Save revisions")');
  await boss.page.waitForLoadState("networkidle");

  const ids = ["4.3.1.1", "4.3.1.2"].map((code) => activeControls.find((c) => c.code === code).id);
  const { data: revised } = await db.from("score")
    .select("self_level, assessor_level, assessor_touched")
    .eq("assessment_id", assessmentId).in("control_id", ids);
  check("override stored on assessor_level",
    revised.map((r) => r.assessor_level).sort().join(",") === "0,5",
    revised.map((r) => r.assessor_level).join(","));
  check("self_level preserved beside the override", revised.every((r) => r.self_level !== null));
  check("assessor_touched set on revised rows only", revised.every((r) => r.assessor_touched === true));

  const { count: untouched } = await db.from("score")
    .select("*", { count: "exact", head: true })
    .eq("assessment_id", assessmentId).eq("assessor_touched", false);
  check("a blanket accept does not fake review coverage", untouched === 130, `untouched=${untouched}`);
  check("review coverage is reported", (await boss.page.content()).includes("Review coverage"));

  // accept-all: clear two rows first so there is something to fill
  await db.from("score").update({ assessor_level: null }).eq("assessment_id", assessmentId).in("control_id", ids);
  await boss.page.goto(`/review?a=${assessmentId}`);
  await boss.page.click('button:has-text("Accept all remaining")');
  await boss.page.waitForLoadState("networkidle");
  const { data: filled } = await db.from("score")
    .select("self_level, assessor_level").eq("assessment_id", assessmentId).in("control_id", ids);
  check("accept-all fills gaps from the self-score",
    filled.every((r) => r.assessor_level === r.self_level), JSON.stringify(filled));
}

/* --------------------------------------------- 6. approval and snapshot */
console.log("\n[6] Approval snapshots targets and locks the record");
{
  // same shape as the submit gate: clear a score, force the button, post anyway
  const orphan = activeControls.find((c) => c.code === "4.3.1.4").id;
  const { data: keep } = await db.from("score").select("assessor_level")
    .eq("assessment_id", assessmentId).eq("control_id", orphan).single();
  await db.from("score").update({ assessor_level: null })
    .eq("assessment_id", assessmentId).eq("control_id", orphan);

  await boss.page.goto(`/review?a=${assessmentId}`);
  check("approve is blocked while a control has no assessor score",
    await boss.page.isDisabled('button:has-text("Approve assessment")'));
  await boss.page.locator('button:has-text("Approve assessment")')
    .evaluate((el) => { el.disabled = false; });
  await boss.page.click('button:has-text("Approve assessment")');
  await boss.page.waitForLoadState("networkidle");
  check("server refuses an incomplete approval, not just the button",
    (await boss.page.content()).includes("no assessor score"), boss.page.url());
  check("state unchanged after the refused approval",
    (await assessmentOf(PM.email)).state === "self_submitted");
  const { count: noSnap } = await db.from("target_snapshot")
    .select("*", { count: "exact", head: true }).eq("assessment_id", assessmentId);
  check("refused approval left no partial snapshot", noSnap === 0, `${noSnap} rows`);

  await db.from("score").update({ assessor_level: keep.assessor_level })
    .eq("assessment_id", assessmentId).eq("control_id", orphan);

  await boss.page.goto(`/review?a=${assessmentId}`);
  await boss.page.click('button:has-text("Approve assessment")');
  await boss.page.waitForLoadState("networkidle");

  const a = await assessmentOf(PM.email);
  check("state = approved", a.state === "approved", a.state);
  check("approved_at stamped", a.approved_at !== null);
  check("assessor recorded", a.assessor_id !== null);

  const { count: snap } = await db.from("target_snapshot")
    .select("*", { count: "exact", head: true }).eq("assessment_id", assessmentId);
  check("targets snapshotted for all 133 controls", snap === 133, `got ${snap}`);

  const { data: frozen } = await db.from("target_snapshot")
    .select("control_id, target_level").eq("assessment_id", assessmentId).limit(5000);
  const live = new Map(activeControls.map((c) => [c.id, c.target_level]));
  const same = frozen.filter((f) => live.has(f.control_id) && f.target_level === live.get(f.control_id)).length;
  check("snapshot equals the live Intermediate targets at approval time",
    same >= activeControls.length - 5, `${same}/${activeControls.length} identical`);

  check("approval lands on results", boss.page.url().includes("/results"), boss.page.url());
  const results = await boss.page.content();
  check("results render the gap list", results.includes("CAPABILITY BY COMPETENCE ELEMENT"));
  check("health tiers carry a label, never colour alone",
    results.includes("Role Ready") || results.includes("Minor Gap") || results.includes("Capability Deficit"));
  check("weakest control shown beside the mean", results.includes("weakest"));
  check("no percentage-of-target anywhere", !/%\s*of\s*target/i.test(results));

  await pm.page.goto("/results");
  check("PM now sees their own results", (await pm.page.content()).includes("CAPABILITY BY COMPETENCE ELEMENT"));
}

/* --------------------------------------- 7. locked record, cross-user read */
console.log("\n[7] Locked record and cross-user access");
{
  await boss.page.goto(`/review?a=${assessmentId}`);
  check("approved sheet says it is locked", (await boss.page.content()).includes("locked"));
  check("no approve button once approved",
    (await boss.page.locator('button:has-text("Approve assessment")').count()) === 0);
  check("no save button once approved",
    (await boss.page.locator('button:has-text("Save revisions")').count()) === 0);

  const other = await session(OTHER.email, OTHER.password);
  await other.page.goto(`/results?a=${assessmentId}`);
  check("another PM cannot read someone else's results via ?a=",
    !(await other.page.content()).includes(PM.name));
  await other.ctx.close();
}

/* -------------------------------------------------- 8. rollup arithmetic */
console.log("\n[8] Rollup arithmetic recomputed from the database");
{
  const { data: rows } = await db.from("score")
    .select("assessor_level, control:control_id(code, active, competence_element:ce_id(code, target_level))")
    .eq("assessment_id", assessmentId).limit(5000);

  const byCe = new Map();
  for (const r of rows) {
    const c = r.control;
    if (!c.active || r.assessor_level === null) continue;
    const g = byCe.get(c.competence_element.code) ?? { levels: [], target: c.competence_element.target_level };
    g.levels.push(r.assessor_level);
    byCe.set(c.competence_element.code, g);
  }
  check("28 competence elements roll up", byCe.size === 28, `${byCe.size}`);
  check("inactive 4.3.2.6 excluded — 4.3.2 rolls up 6 controls, not 7",
    byCe.get("4.3.2").levels.length === 6, `${byCe.get("4.3.2").levels.length}`);

  await boss.page.goto(`/results?a=${assessmentId}`);
  const shown = await boss.page.locator(".barrow").allInnerTexts();
  let matched = 0;
  for (const [code, g] of byCe) {
    const mean = (g.levels.reduce((s, n) => s + n, 0) / g.levels.length).toFixed(1);
    if (shown.some((row) => row.includes(code) && row.includes(mean))) matched++;
  }
  check("every CE mean on the page equals mean(assessor_level over active controls)",
    matched === byCe.size, `${matched}/${byCe.size}`);
}

/* ------------------------------------------------------ 9. framework admin */
console.log("\n[9] Framework admin writes the tunable layer only");
{
  const stamp = `QA note ${Date.now()}`;
  // remember the seeded values so cleanup restores them exactly
  const { data: original } = await db.from("control")
    .select("kib_note, priority, reason, active, target_level, target_source")
    .eq("code", "4.3.1.3").single();

  await boss.page.goto("/admin?c=4.3.1.3");
  const before = await boss.page.content();
  check("ICB4 source text is rendered read-only", before.includes("ICB4 — read-only"));
  check("no editable field for the indicator",
    (await boss.page.locator('input[name="indicator"], textarea[name="indicator"]').count()) === 0);

  await boss.page.fill("#kib", stamp);
  await boss.page.click('button:has-text("Save changes")');
  await boss.page.waitForLoadState("networkidle");

  const { data: c } = await db.from("control").select("kib_note, indicator").eq("code", "4.3.1.3").single();
  check("kib_note persisted", c.kib_note === stamp, c.kib_note);
  check("ICB4 indicator untouched by the save", c.indicator && !c.indicator.includes("QA note"));
  check("edit is visible after cache invalidation",
    (await boss.page.content()).includes(stamp));

  // reason is required whenever a control is not Active/High
  await boss.page.goto("/admin?c=4.3.1.3");
  await boss.page.selectOption("#priority", "Low");
  await boss.page.fill("#reason", "");
  await boss.page.click('button:has-text("Save changes")');
  await boss.page.waitForLoadState("networkidle");
  check("a reason is required when a control is not Active/High",
    (await boss.page.content()).includes("reason is required"));

  const { error } = await db.from("control").update(original).eq("code", "4.3.1.3");
  if (error) throw new Error(`Could not restore control 4.3.1.3: ${error.message}`);
  const { data: restored } = await db.from("control").select("kib_note").eq("code", "4.3.1.3").single();
  check("seeded framework restored after the admin test",
    restored.kib_note === original.kib_note, `${restored.kib_note}`);
}

/* ---------------------------------------------------------------- cleanup */
console.log("\nCleaning up QA data and accounts…");
await purge(PM.email);
await purge(OTHER.email);
const { data: leftovers } = await db.from("app_user").select("email").like("email", "%@example.test");
check("no QA accounts left on the allowlist", (leftovers ?? []).length === 0,
  (leftovers ?? []).map((u) => u.email).join(","));

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail === 0 ? 0 : 1);
