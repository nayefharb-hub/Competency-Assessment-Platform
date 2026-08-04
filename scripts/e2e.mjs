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
 * No credentials needed beyond the Supabase keys: the suite creates its own QA
 * admin and PMs, and deletes them afterwards.
 */
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";

const BASE = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000";
const CHROME = process.env.E2E_CHROMIUM ?? undefined;

if (!process.argv.includes("--write")) {
  console.error("This test writes to the database. Re-run with --write if that is what you want.");
  process.exit(1);
}
// No real admin credentials needed: the suite creates its own QA admin.

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const PM = { email: "qa.pm1@example.test", name: "QA Test PM One", password: "QaTestPm1!pass" };
const OTHER = { email: "qa.pm2@example.test", name: "QA Test PM Two", password: "QaTestPm2!pass" };
/**
 * The suite brings its own admin rather than borrowing a real one. Two reasons:
 * a real account gets `must_change_password` set and would be redirected out of
 * every admin test, and — the N13 lesson — a test run should never touch the
 * data of someone who might be using the app at the time.
 */
const BOSS = {
  email: "qa.admin@example.test", name: "QA Assessor",
  password: "QaAdmin1!passw", role: "admin",
};

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};

/* ------------------------------------------------------------- fixtures */

/** Remove a QA account and everything it produced. `keepAccount` is for the
 *  mid-run reset; the end-of-run call takes the account away too, so the
 *  allowlist and the completion denominator go back to how they were. */
/**
 * Delete the sign-in half of an account by EMAIL.
 *
 * A run that dies mid-flight leaves an `auth.users` row with no `app_user` row —
 * invisible to every app_user query, and enough to make the next "add person"
 * fail with "email already registered". Cleaning up by id only cannot reach it.
 */
async function deleteAuthUser(email) {
  const { data } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const found = (data?.users ?? []).find((u) => u.email === email);
  if (found) await db.auth.admin.deleteUser(found.id);
}

async function purge(email, { keepAccount = false } = {}) {
  const { data: user } = await db.from("app_user").select("id").eq("email", email).maybeSingle();
  if (user) {
    const { data: rows } = await db.from("assessment").select("id").eq("assessee_id", user.id);
    for (const a of rows ?? []) {
      await db.from("target_snapshot").delete().eq("assessment_id", a.id);
      await db.from("score").delete().eq("assessment_id", a.id);
      await db.from("assessment").delete().eq("id", a.id);
    }
  }
  if (keepAccount) return;
  if (user) await db.from("app_user").delete().eq("id", user.id);
  await deleteAuthUser(email);
}

async function ensure(person) {
  await purge(person.email, { keepAccount: true });
  const { data: existing } = await db.from("app_user").select("id").eq("email", person.email).maybeSingle();
  // No allowlist row, but there may still be an orphaned sign-in account from an
  // interrupted run; createUser would refuse the email.
  if (!existing) await deleteAuthUser(person.email);
  if (existing) {
    await db.auth.admin.updateUserById(existing.id, { password: person.password, email_confirm: true });
    // Fixtures start unflagged; the password-gate tests set the flag themselves.
    await db.from("app_user").update({ must_change_password: false }).eq("id", existing.id);
    return;
  }
  const created = await db.auth.admin.createUser({
    email: person.email, password: person.password, email_confirm: true,
  });
  if (created.error) throw new Error(created.error.message);
  const { error } = await db.from("app_user").insert({
    id: created.data.user.id, email: person.email, full_name: person.name,
    job_title: person.role === "admin" ? "Head of PMO" : "Project Manager",
    role: person.role ?? "assessee",
    must_change_password: false,
  });
  if (error) throw new Error(error.message);
}

const flag = async (email, value) => {
  const { data } = await db.from("app_user").select("id").eq("email", email).single();
  await db.from("app_user").update({ must_change_password: value }).eq("id", data.id);
  return data.id;
};

console.log("Preparing QA accounts…");
await ensure(PM);
await ensure(OTHER);
await ensure(BOSS);

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
/** maybeSingle, not single: "no assessment" is now an ordinary state — nobody
 *  has one until an admin assigns it — and the tests assert on exactly that. */
const assessmentOf = async (email) =>
  (await db.from("assessment").select("*").eq("assessee_id", await idOf(email)).maybeSingle()).data;

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

// @supabase/ssr defaults to httpOnly: false so a browser-side client can read
// the session. This app has no browser-side client, so the token has no
// business being reachable from page JavaScript — assert the override took,
// because nothing fails loudly if it silently stops applying.
{
  const authCookies = (await pm.ctx.cookies()).filter((c) => c.name.startsWith("sb-"));
  check("the session cookie exists", authCookies.length > 0);
  check("the session cookie is httpOnly", authCookies.every((c) => c.httpOnly),
    authCookies.filter((c) => !c.httpOnly).map((c) => c.name).join(","));
  const visible = await pm.page.evaluate(() =>
    document.cookie.split("; ").filter((c) => c.startsWith("sb-")));
  check("page JavaScript cannot read the session", visible.length === 0, visible.join(","));
}
const boss = await session(BOSS.email, BOSS.password);
check("assessor/admin signs in", !boss.page.url().includes("/login"), boss.page.url());

/* ------------------------------------------------------- 2. assignment */
console.log("\n[2] Assignment — an assessment exists only when an admin assigns it (A2)");
{
  check("signing in does not create an assessment", (await assessmentOf(PM.email)) === null);

  await pm.page.goto("/assess/controls");
  check("the PM is told nothing has been assigned",
    (await pm.page.content()).includes("No assessment has been assigned"));
  await pm.page.goto("/assess?c=4.3.1.1");
  check("there is nothing to score before assignment",
    (await pm.page.locator('input[name="level"]').count()) === 0);
  check("and looking at those pages still created nothing",
    (await assessmentOf(PM.email)) === null);

  const pmId = await idOf(PM.email);
  const otherId = await idOf(OTHER.email);
  const bossId = await idOf(BOSS.email);

  await boss.page.goto("/admin/people");
  check("the assign list offers the unassigned PM",
    (await boss.page.locator(`input[name="assignee"][value="${pmId}"]`).count()) === 1);
  // Untick everyone first: this suite must never assign a cycle to a real
  // colleague who happens to be on the allowlist (the N13 lesson).
  const boxes = boss.page.locator('input[name="assignee"]');
  for (let i = 0; i < (await boxes.count()); i++) await boxes.nth(i).setChecked(false);
  await boss.page.check(`input[name="assignee"][value="${pmId}"]`);
  await boss.page.check(`input[name="assignee"][value="${otherId}"]`);
  await boss.page.click('button:has-text("Assign selected")');
  await boss.page.waitForLoadState("networkidle");

  const a = await assessmentOf(PM.email);
  check("assigning creates the assessment", a !== null);
  check("state starts at draft", a?.state === "draft", a?.state);
  check("assigned_at stamped", a?.assigned_at !== null);
  check("assigned_by records who asked", a?.assigned_by === bossId, a?.assigned_by);
  check("assignment does NOT stamp started_at — nobody has started yet",
    a?.started_at === null, a?.started_at);
  check("no scores are pre-created",
    ((await db.from("score").select("*", { count: "exact", head: true })
      .eq("assessment_id", a.id)).count ?? 0) === 0);

  // Idempotence rests on the unique constraint, so assert the constraint itself
  // rather than the code that leans on it.
  const dup = await db.from("assessment").insert({
    framework_id: a.framework_id, profile_id: a.profile_id,
    assessee_id: pmId, cycle: a.cycle, state: "draft",
  });
  check("the database refuses a second assessment for the same person and cycle",
    dup.error !== null, dup.error?.message);

  await boss.page.goto("/admin/people");
  check("an assigned person drops off the assign list",
    (await boss.page.locator(`input[name="assignee"][value="${pmId}"]`).count()) === 0);

  await pm.page.goto("/assess/controls");
  check("the PM can now start", (await pm.page.content()).includes("controls scored"));

  /* withdraw: allowed while untouched, refused the moment anything is scored */
  const otherA = await assessmentOf(OTHER.email);
  const otherRow = boss.page.locator("tr", { hasText: OTHER.name });
  check("an unstarted assignment offers Withdraw",
    (await otherRow.locator('button:has-text("Withdraw")').count()) === 1);

  // Score it behind the page's back — exactly the stale tab the guard exists
  // for. The button is still in this DOM; the server has to say no.
  await db.from("score").insert({
    assessment_id: otherA.id, control_id: activeControls[0].id, self_level: 3,
  });
  await otherRow.locator('button:has-text("Withdraw")').click();
  // waitForURL, not networkidle: the redirect from a server action lands after
  // the network has already gone quiet, so networkidle reads the stale page.
  await boss.page.waitForURL(/[?&](error|withdrawn)=/);
  check("withdrawing a started assessment is refused by the server",
    (await boss.page.content()).includes("would destroy them"), boss.page.url());
  check("the started assessment survived the refused withdraw",
    (await assessmentOf(OTHER.email)) !== null);

  await db.from("score").delete().eq("assessment_id", otherA.id);
  await boss.page.goto("/admin/people");
  await boss.page.locator("tr", { hasText: OTHER.name })
    .locator('button:has-text("Withdraw")').click();
  await boss.page.waitForURL(/[?&](error|withdrawn)=/);
  check("withdrawing an unstarted assignment removes it",
    (await assessmentOf(OTHER.email)) === null);
}

/* -------------------------------------- 3. role gates and target blinding */
console.log("\n[3] Role gates and target blinding");
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

/* -------------------------------------------- 4. self-scoring persistence */
console.log("\n[4] Self-scoring persists to Postgres");
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

/* -------------------------------------------------------------- 5. submit */
console.log("\n[5] Submit: draft -> self_submitted");
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

/* ------------------------------------------ 6. assessor review-and-revise */
console.log("\n[6] Assessor review-and-revise");
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

/* --------------------------------------------- 7. approval and snapshot */
console.log("\n[7] Approval snapshots targets and locks the record");
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

/* --------------------------------------- 8. locked record, cross-user read */
console.log("\n[8] Locked record and cross-user access");
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

/* -------------------------------------------------- 9. rollup arithmetic */
console.log("\n[9] Rollup arithmetic recomputed from the database");
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

/* ------------------------------------------------------ 10. framework admin */
console.log("\n[10] Framework admin writes the tunable layer only");
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


/* ------------------------------- 11. password gate and the People screen */
console.log("\n[11] Password gate (A1)");
{
  // F1 regression: if must_change_password is missing from the column list in
  // lib/auth.ts it reads back undefined, therefore falsy, therefore the gate
  // silently never fires. Only a test that flags a user and walks the app can
  // catch that — nothing throws.
  await flag(OTHER.email, true);
  const gated = await session(OTHER.email, OTHER.password);

  for (const route of ["/", "/assess", "/assess/controls", "/results", "/review", "/admin"]) {
    await gated.page.goto(route);
    check(`flagged user is pushed off ${route}`,
      gated.page.url().includes("/change-password"), gated.page.url());
  }

  // F2 regression: /change-password itself must be reachable while flagged, or
  // requireUser bounces it to itself forever.
  await gated.page.goto("/change-password");
  check("/change-password is reachable while flagged (no redirect loop)",
    gated.page.url().includes("/change-password")
      && (await gated.page.locator("#password").count()) === 1);
  check("the forced version explains why",
    (await gated.page.content()).includes("someone else chose"));

  // the gate is server-side, so posting the action directly is refused too
  await gated.page.goto("/assess?c=4.3.1.1");
  check("cannot score while flagged",
    gated.page.url().includes("/change-password"));

  // too-short and mismatched passwords are rejected
  await gated.page.goto("/change-password");
  await gated.page.fill("#password", "short");
  await gated.page.fill("#confirm", "short");
  await gated.page.evaluate(() => {
    document.querySelectorAll("input").forEach((i) => i.removeAttribute("minLength"));
  });
  await gated.page.click('button[type="submit"]');
  await gated.page.waitForLoadState("networkidle");
  check("a short password is refused", (await gated.page.content()).includes("at least 10"));

  await gated.page.goto("/change-password");
  await gated.page.fill("#password", "LongEnough1!aa");
  await gated.page.fill("#confirm", "DifferentOne1!a");
  await gated.page.click('button[type="submit"]');
  await gated.page.waitForLoadState("networkidle");
  check("mismatched passwords are refused", (await gated.page.content()).includes("do not match"));

  // the happy path clears the flag and releases the app
  const NEWPASS = "QaChanged1!pass";
  await gated.page.goto("/change-password");
  await gated.page.fill("#password", NEWPASS);
  await gated.page.fill("#confirm", NEWPASS);
  await gated.page.click('button[type="submit"]');
  await gated.page.waitForLoadState("networkidle");

  const { data: after } = await db.from("app_user")
    .select("must_change_password").eq("email", OTHER.email).single();
  check("changing the password clears the flag", after.must_change_password === false);
  await gated.page.goto("/assess/controls");
  check("the app is reachable once the flag clears",
    !gated.page.url().includes("/change-password"), gated.page.url());

  // and the new password is the one that works
  await gated.ctx.close();
  const relogin = await session(OTHER.email, NEWPASS);
  check("the new password signs in", !relogin.page.url().includes("/login"));
  await relogin.ctx.close();
  OTHER.password = NEWPASS;
}

console.log("\n[12] People screen (A1)");
{
  await pm.page.goto("/admin/people");
  check("a PM cannot reach the People screen", pm.page.url().includes("denied=1"), pm.page.url());

  await boss.page.goto("/admin/people");
  check("an admin can", boss.page.url().includes("/admin/people"));
  check("the allowlist is listed", (await boss.page.content()).includes(PM.email));

  const NEWMAIL = "qa.added@example.test";
  await purge(NEWMAIL);
  await boss.page.fill("#full_name", "QA Added Person");
  await boss.page.fill("#email", NEWMAIL);
  await boss.page.fill("#job_title", "Project Manager");
  await boss.page.selectOption("#role", "assessee");
  await boss.page.fill("#password", "AddedByAdmin1!");
  await boss.page.click('button:has-text("Add person")');
  await boss.page.waitForLoadState("networkidle");

  const { data: made } = await db.from("app_user")
    .select("id, role, must_change_password").eq("email", NEWMAIL).maybeSingle();
  check("the person is on the allowlist", made !== null);
  check("created flagged to set their own password", made?.must_change_password === true);
  check("the password is never echoed into the URL", !boss.page.url().includes("AddedByAdmin"));
  check("a new person appears in the assign list, without an assessment",
    (await boss.page.locator(`input[name="assignee"][value="${made?.id}"]`).count()) === 1);

  // the account really works, and lands on the gate
  const fresh = await session(NEWMAIL, "AddedByAdmin1!");
  check("the added person can sign in", !fresh.page.url().includes("/login"), fresh.page.url());
  check("and is sent straight to set their own password",
    fresh.page.url().includes("/change-password"), fresh.page.url());
  await fresh.ctx.close();

  // duplicate is refused rather than silently creating a second identity
  await boss.page.goto("/admin/people");
  await boss.page.fill("#full_name", "QA Added Person");
  await boss.page.fill("#email", NEWMAIL);
  await boss.page.fill("#password", "AnotherOne1!aa");
  await boss.page.click('button:has-text("Add person")');
  await boss.page.waitForLoadState("networkidle");
  check("a duplicate email is refused", (await boss.page.content()).includes("already on the allowlist"));

  // admin reset re-arms the gate
  await db.from("app_user").update({ must_change_password: false }).eq("email", NEWMAIL);
  await boss.page.goto("/admin/people");
  const row = boss.page.locator("tr", { hasText: NEWMAIL });
  await row.locator('input[name="password"]').fill("ResetByAdmin1!");
  await row.locator('button:has-text("Reset")').click();
  await boss.page.waitForLoadState("networkidle");
  const { data: afterReset } = await db.from("app_user")
    .select("must_change_password").eq("email", NEWMAIL).single();
  check("an admin reset re-arms the must-change flag", afterReset.must_change_password === true);
  const resetLogin = await session(NEWMAIL, "ResetByAdmin1!");
  check("the reset password works and lands on the gate",
    resetLogin.page.url().includes("/change-password"), resetLogin.page.url());
  await resetLogin.ctx.close();

  await purge(NEWMAIL);
}

/* ---------------------------------------------------------------- cleanup */
console.log("\nCleaning up QA data and accounts…");
await purge(PM.email);
await purge(OTHER.email);
await purge(BOSS.email);
const { data: leftovers } = await db.from("app_user").select("email").like("email", "%@example.test");
check("no QA accounts left on the allowlist", (leftovers ?? []).length === 0,
  (leftovers ?? []).map((u) => u.email).join(","));
const { data: authLeft } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
const strays = (authLeft?.users ?? []).filter((u) => u.email?.endsWith("@example.test"));
check("no QA sign-in accounts left behind either", strays.length === 0,
  strays.map((u) => u.email).join(","));

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail === 0 ? 0 : 1);
