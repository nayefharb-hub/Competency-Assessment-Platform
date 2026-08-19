#!/usr/bin/env node
/**
 * PRE-PILOT CONCURRENCY CHECK — four PMs scoring at the same time.
 *
 *   CONC_CHROMIUM=/opt/pw-browsers/chromium \
 *   CONC_BASE_URL=https://competency-assessment-platform.vercel.app \
 *   node --env-file=.env.local scripts/concurrency.mjs --write
 *
 * The pilot puts nine people on this app in the same week, and the assessment
 * loop was built and measured one PM at a time. Everything that could mix two
 * people's work up lives in state that is per-INSTANCE rather than per-request
 * — `viewerMemo` (token-keyed, 2s), the framework memo, the service client —
 * and Fluid Compute serves interleaved requests on one instance. Reasoning says
 * those are keyed safely. This measures it.
 *
 * WHAT IT ASSERTS, in one line each:
 *   - four PMs signing in at the same moment each get their own session;
 *   - four commits fired in the SAME INSTANT land in four different records,
 *     each with the level and the evidence its own PM typed;
 *   - a walk of ten controls each, run concurrently, never crosses over;
 *   - the progress figure each PM is shown is their own (the four counts are
 *     deliberately different, so a swap is visible rather than plausible);
 *   - four concurrent submits each move only their own row;
 *   - four concurrent /results renders each carry that PM's own 28 competency
 *     means, recomputed here from Postgres rather than trusted from the page.
 *
 * IT WRITES TO THE DATABASE IT IS POINTED AT, and the one it is pointed at is
 * the REAL one, with real staff on it. Containment is the whole safety
 * argument:
 *   - it touches only accounts it created itself, all `@example.test`;
 *   - it never opens the admin assign form, so no real person can be assigned
 *     a cycle by a mis-click. Assignments are inserted directly, mirroring
 *     `assignAssessment` exactly (framework, default profile, cycle, draft);
 *   - the assessor fixture only ever opens `/review?a=` for the four QA
 *     assessments, by id;
 *   - teardown runs on the success path, on a throw and on an uncaught
 *     exception, and the run FAILS if anything is left behind.
 *
 * It refuses to run without --write.
 */
import { randomBytes } from "node:crypto";
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";

const BASE = (process.env.CONC_BASE_URL ?? "https://competency-assessment-platform.vercel.app")
  .replace(/\/$/, "");
const CHROME = process.env.CONC_CHROMIUM ?? process.env.E2E_CHROMIUM ?? undefined;
const PMS = Number(process.env.CONC_PMS ?? 4);
const WALK = Number(process.env.CONC_WALK ?? 10);
/** Where each PM's prior sitting stops. Deliberately DIFFERENT per PM: it makes
 *  every progress figure in the run unique, so "PM 2 was shown PM 3's page" is
 *  a failing assertion rather than a coincidence nobody can rule out. */
const SEEDS = [100, 104, 108, 112];
/** The control all four answer in the same instant, chosen past every seed and
 *  every walk range so nobody has touched it before the burst. */
const BURST_POS = 130;
/**
 * Stop after phase N and tear down. Only for proving the checks below can fail.
 */
const STOP_AFTER = Number(process.env.CONC_STOP_AFTER ?? 99);
/**
 * DELIBERATE CROSS-CONTAMINATION, to prove the detector detects.
 *
 * CLAUDE.md ground rule 0: a regression test that has never been red proves
 * only that it agrees with the code in front of it. Everything below asserts
 * that one PM's answer never lands in another's record — which is exactly the
 * shape of assertion that passes for free if it is subtly wrong. With this set,
 * one of PM 1's walked answers is MOVED into PM 2's record between the walk and
 * the ownership check. Phase [4] and phase [5] must both go red. If they do
 * not, the green run that follows means nothing.
 */
const SABOTAGE = process.env.CONC_SABOTAGE === "1";
/** How long a click gets to move the screen before the PM presses it again. */
const NUDGE_AFTER_MS = Number(process.env.CONC_NUDGE_AFTER_MS ?? 8_000);
const MAX_NUDGES = Number(process.env.CONC_MAX_NUDGES ?? 3);
/** One entry per click that did not move the screen. Reported, never swallowed. */
const NUDGES = [];

if (!process.argv.includes("--write")) {
  console.error("This test writes to the database. Re-run with --write if that is what you want.");
  process.exit(1);
}
if (PMS < 2 || PMS > SEEDS.length) {
  console.error(`CONC_PMS must be between 2 and ${SEEDS.length}.`);
  process.exit(1);
}

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

/* Per-run passwords, never written down — the e2e suite's rule and for its
   reason: this repository is public, and a fixture that outlives its run must
   not be sign-in-able by anyone who can read the convention. */
const qaPassword = () => `Qa${randomBytes(15).toString("base64url")}1!`;

const FIXTURES = Array.from({ length: PMS }, (_, i) => ({
  n: i + 1,
  email: `qa.conc${i + 1}@example.test`,
  name: `QA Concurrency PM ${i + 1}`,
  password: qaPassword(),
  seed: SEEDS[i],
}));
const BOSS = {
  email: "qa.conc.admin@example.test", name: "QA Concurrency Assessor",
  password: qaPassword(), role: "admin",
};
const ALL_EMAILS = [...FIXTURES.map((f) => f.email), BOSS.email];

/* ------------------------------------------------------------ reporting */

let pass = 0, fail = 0, skipped = 0;
const failures = [];
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else {
    fail++; failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
};
/** A check that could not run counts as a failure, never as silence. */
const cannotRun = (name, why) => {
  skipped++; fail++; failures.push(`${name} — COULD NOT RUN: ${why}`);
  console.log(`  ✗ ${name} — COULD NOT RUN: ${why}`);
};

const timings = new Map();
const record = (label, ms) => {
  if (!timings.has(label)) timings.set(label, []);
  timings.get(label).push(ms);
};
/**
 * How many of these were genuinely in flight at once.
 *
 * Without it "concurrent" is a claim about how the test was WRITTEN — four
 * Promises — rather than about what the server saw. Four requests issued
 * together but served one after another would exercise nothing, and would look
 * identical in the pass/fail column. This counts overlap: `max` is the most
 * that were simultaneously outstanding, and a max of 1 would mean the whole run
 * proved nothing about concurrency.
 */
const inflight = new Map();
async function timed(label, fn) {
  const t0 = Date.now();
  const now = (inflight.get(label)?.now ?? 0) + 1;
  const max = Math.max(now, inflight.get(label)?.max ?? 0);
  inflight.set(label, { now, max });
  try { return await fn(); }
  finally {
    record(label, Date.now() - t0);
    const s = inflight.get(label);
    inflight.set(label, { now: s.now - 1, max: s.max });
  }
}
const pctl = (xs, p) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

/* ------------------------------------------------- fixtures & teardown */

async function allAuthUsers() {
  const out = [];
  for (let page = 1; page <= 100; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`listUsers page ${page} failed: ${error.message}`);
    const users = data?.users ?? [];
    out.push(...users);
    if (users.length < 1000) return out;
  }
  throw new Error("listUsers did not terminate within 100 pages");
}
const qaAuthAccounts = async () =>
  (await allAuthUsers()).filter((u) => ALL_EMAILS.includes(u.email ?? ""));

async function deleteAuthUser(email) {
  const found = (await allAuthUsers()).find((u) => u.email === email);
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
  if (!existing) await deleteAuthUser(person.email);
  if (existing) {
    await db.auth.admin.updateUserById(existing.id, { password: person.password, email_confirm: true });
    await db.from("app_user").update({ must_change_password: false }).eq("id", existing.id);
    person.id = existing.id;
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
  person.id = created.data.user.id;
}

let browser = null;
let teardownRun = null;
const teardown = () => (teardownRun ??= doTeardown());

async function doTeardown() {
  console.log("\nCleaning up…");
  try {
    if (browser) { closingOnPurpose = true; await browser.close(); }
  } catch { /* a dead browser is still a closed one */ }
  for (const email of ALL_EMAILS) {
    try { await purge(email); }
    catch (e) { console.log(`  ⚠ purge ${email} failed: ${e.message}`); }
  }
  // The guarantee, checked rather than assumed: nothing of this run is left on
  // the real allowlist, and no assessment of its making is left in the
  // completion denominator.
  try {
    const left = await qaAuthAccounts();
    check("no QA sign-in accounts left behind", left.length === 0,
      left.map((u) => u.email).join(", "));
    const { data: rows } = await db.from("app_user").select("email").in("email", ALL_EMAILS);
    check("no QA allowlist rows left behind", (rows ?? []).length === 0,
      (rows ?? []).map((r) => r.email).join(", "));
  } catch (e) {
    cannotRun("cleanup verified against the database", e.message);
  }
}

/** Honour CONC_STOP_AFTER. Tears down and reports, exactly as a full run does. */
async function stopIfAsked(phase) {
  if (phase < STOP_AFTER) return;
  console.log(`\n(stopping after phase ${phase} — CONC_STOP_AFTER=${STOP_AFTER})`);
  await teardown();
  summarise();
  process.exit(fail === 0 ? 0 : 1);
}

let closingOnPurpose = false;
function crashed(label, err) {
  console.log(`\n✗ RUN CRASHED at ${label} — ${err?.message ?? err}`);
  fail++; failures.push(`CRASHED at ${label}: ${err?.message ?? err}`);
  teardown().then(summarise).then(() => process.exit(1), () => process.exit(1));
}
process.on("uncaughtException", (e) => crashed("uncaughtException", e));
process.on("unhandledRejection", (e) => crashed("unhandledRejection", e));
/* Ctrl-C is the third way a run ends, and without these it is the ONLY one that
   leaves fixtures behind — an admin account on the real allowlist, and four
   assessments inside the completion denominator. Node's default SIGINT handler
   exits immediately and runs no cleanup. */
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log(`\n(${sig} — tearing down before exit)`);
    teardown().then(summarise).then(() => process.exit(130), () => process.exit(130));
  });
}

function summarise() {
  console.log("\n──────────────────────────────────────────────");
  for (const [label, xs] of timings) {
    console.log(`  ${label.padEnd(34)} n=${String(xs.length).padStart(4)}  `
      + `p50 ${String(pctl(xs, 50)).padStart(5)}ms  p95 ${String(pctl(xs, 95)).padStart(5)}ms  `
      + `max ${String(Math.max(...xs)).padStart(5)}ms  `
      + `≤${inflight.get(label)?.max ?? 1} in flight`);
  }
  console.log("──────────────────────────────────────────────");
  if (NUDGES.length) {
    console.log(`\n  ${NUDGES.length} click${NUDGES.length === 1 ? "" : "s"} did not move the screen `
      + "and had to be repeated (the answer was queued each time):");
    for (const n of NUDGES) {
      console.log(`    PM ${n.pm} ${n.code} attempt ${n.attempt} — `
        + `offline seen: ${n.offlineSeen}, aborted requests so far: ${n.aborted}`);
    }
  }
  if (failures.length) {
    console.log("\nFAILURES:");
    for (const f of failures) console.log(`  ✗ ${f}`);
  }
  console.log(`\n${pass} passed, ${fail} failed${skipped ? ` (${skipped} could not run)` : ""}`
    + `  ·  target ${BASE}`);
}

/* --------------------------------------------------------- the framework */

const { data: activeControls, error: ctlErr } = await db
  .from("control").select("id, code, ce_id, sort_order")
  .eq("active", true).order("sort_order").limit(5000);
if (ctlErr) throw new Error(`control fetch failed: ${ctlErr.message}`);
const TOTAL = activeControls.length;
const at = (pos1) => activeControls[pos1 - 1];
const POS_OF = new Map(activeControls.map((c, i) => [c.code, i + 1]));
const posOf = (code) => POS_OF.get(code);

/**
 * Every assessment that existed BEFORE this run, and the state it was in.
 *
 * The real staff records are on this database. Nothing here should move them,
 * and "should not" is not a measurement — this is the before-picture that
 * makes "nothing outside this run changed" an assertion.
 */
const { data: priorRows, error: priorErr } = await db
  .from("assessment").select("id, state, submitted_at, approved_at, archived_at").limit(5000);
if (priorErr) throw new Error(`prior assessment snapshot failed: ${priorErr.message}`);
const PRIOR = new Map((priorRows ?? []).map((r) =>
  [r.id, `${r.state}|${r.submitted_at}|${r.approved_at}|${r.archived_at}`]));

const { data: ces } = await db.from("competence_element").select("id, code, name").order("sort_order");
const ceById = new Map((ces ?? []).map((c) => [c.id, c]));

/* ------------------------------------------------------------- the answers */

/**
 * Every answer in this run is SIGNED, and the signature is what turns "no
 * cross-contamination" from a claim into a measurement. The level a PM gives
 * is a function of who they are, so two PMs never give the same answer to the
 * same control; the evidence names them outright.
 *
 * THE OFFSET IS `pm.n`, NOT `pm.n * 2`, AND THAT COST A RUN. With `* 2` the
 * offsets are 2, 4, 6, 8 — and 6 ≡ 0, 8 ≡ 2 (mod 6), so PM 1 and PM 4 gave
 * byte-identical answers to all 132 controls. Their results pages were then
 * indistinguishable, and the check in [8] that PM 1 was not handed PM 4's
 * report could not have failed for a real reason. Caught by the pairwise
 * distinctness guard in [8], which is the whole purpose of that guard: a
 * comparison that cannot fail must say so rather than pass.
 */
const levelFor = (pm, pos) => (pm.n + pos) % 6;
const evidenceFor = (pm, phase, code) => `CONC-${phase}-P${pm.n}-${code}`;
/** Whose answer is this, read back off the row. `null` = unsigned. */
const ownerOf = (evidence) => {
  const m = /^CONC-[A-Z]+-P(\d+)-/.exec(evidence ?? "");
  return m ? Number(m[1]) : null;
};

/** A prior sitting, written straight to Postgres. Seeding is for PRIOR
 *  SITTINGS only — every step under test below is walked in the browser. */
async function seedPriorSitting(pm, fromPos, toPos, phase) {
  const rows = [];
  for (let p = fromPos; p <= toPos; p++) {
    rows.push({
      assessment_id: pm.assessmentId,
      control_id: at(p).id,
      self_level: levelFor(pm, p),
      evidence: evidenceFor(pm, phase, at(p).code),
    });
  }
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await db.from("score")
      .upsert(rows.slice(i, i + 200), { onConflict: "assessment_id,control_id" });
    if (error) throw new Error(`seed failed: ${error.message}`);
  }
  return rows.length;
}

/* ------------------------------------------------------------- the browser */

const REMOTE = !BASE.startsWith("http://127.0.0.1") && !BASE.startsWith("http://localhost");
const BYPASS = process.env.Vercel_deployment_ByPass;
browser = await chromium.launch({
  ...(CHROME ? { executablePath: CHROME } : {}),
  ...(REMOTE
    ? {
        // The egress proxy's TLS interception resets Chromium's TLS 1.3 on
        // every external host. curl and node fetch negotiate differently and
        // get 200, so the network looks fine right up until the browser
        // touches it. Capping the version is the fix (CLAUDE.md, 2026-08-07).
        args: ["--ssl-version-max=tls1.2"],
        ...(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY } } : {}),
      }
    : {}),
});
if (REMOTE && BYPASS) {
  const openContext = browser.newContext.bind(browser);
  browser.newContext = (opts = {}) => openContext({
    ...opts,
    extraHTTPHeaders: { ...(opts.extraHTTPHeaders ?? {}), "x-vercel-protection-bypass": BYPASS },
  });
}
browser.on("disconnected", () => {
  if (!closingOnPurpose) console.log(`    ⚠ chromium DISCONNECTED UNEXPECTEDLY at ${new Date().toISOString()}`);
});

async function signIn(person) {
  const ctx = await browser.newContext({ baseURL: BASE });
  const page = await ctx.newPage();
  page.on("crash", () => console.log(`    ⚠ renderer CRASHED for ${person.email}`));
  /* Diagnostics, armed before the first navigation. A click that neither
     navigates nor raises the milestone card has three candidate causes in
     score-panel.tsx — the browser believing it is offline (goNext returns at
     the `navigator.onLine` guard), a client exception, or a router.push whose
     RSC fetch never came back. None of them can be told apart after the fact,
     so the evidence is collected as it happens rather than reconstructed. */
  /* THE DECISIVE ONE. score-panel's goNext commits and then RETURNS WITHOUT
     NAVIGATING when the browser says it is offline (decision D13) — which
     produces exactly the symptom a stall shows: answer queued, screen still,
     button enabled, no card. `navigator.onLine` read afterwards is useless
     because the transition is transient; the events have to be recorded as
     they fire. */
  await ctx.addInitScript(() => {
    window.__netEvents = [];
    const stamp = (kind) => window.__netEvents.push(`${kind}@${new Date().toISOString()}`);
    window.addEventListener("offline", () => stamp("offline"));
    window.addEventListener("online", () => stamp("online"));
  });
  person.consoleErrors = [];
  person.pageErrors = [];
  person.failedRequests = [];
  person.pending = new Map();
  page.on("console", (m) => {
    if (m.type() === "error") person.consoleErrors.push(m.text().slice(0, 300));
  });
  page.on("pageerror", (e) => person.pageErrors.push(String(e.message).slice(0, 300)));
  page.on("request", (r) => person.pending.set(r, Date.now()));
  page.on("requestfinished", (r) => person.pending.delete(r));
  page.on("requestfailed", (r) => {
    person.pending.delete(r);
    person.failedRequests.push(`${r.method()} ${r.url().slice(0, 140)} — ${r.failure()?.errorText}`);
  });
  await page.goto("/login");
  await page.fill("#email", person.email);
  await page.fill("#password", person.password);
  const posted = page.waitForResponse((r) => r.request().method() === "POST", { timeout: 30_000 })
    .catch(() => null);
  await page.click('form button[type="submit"]:has-text("Sign in")');
  await posted;
  await page.waitForLoadState("networkidle");
  person.ctx = ctx; person.page = page;
  return person;
}

/**
 * Score one control and move on — the way a PM does it.
 *
 * The click hands the answer to the outbox and navigates in the same breath
 * (D9). This helper therefore waits for THE SCREEN, never for the write: an
 * `await` on the commit POST here would test a PM who waits, and no PM waits.
 * Whether the answers landed is settled afterwards, against Postgres.
 *
 * Two things the click can do — go to the next control, or raise the milestone
 * card and go nowhere (a completed competency). Both are handled, because a
 * walk that only knew about one of them would stall on 28 of the 132 controls.
 */
async function scoreAndAdvance(pm, code, level, evidence, timeout = 45_000) {
  const page = pm.page;
  await page.check(`input[name="level"][value="${level}"]`, { timeout });
  await page.fill("#evidence", evidence, { timeout });
  const before = page.url();
  await page.click(".assess-actions button.btn-primary", { timeout });
  await settleAfterCommit(pm, before, code, timeout);
}

/** Everything that could explain a click that went nowhere, captured at the
 *  moment it went nowhere. */
async function dumpStall(pm, code, before, attempt = 1) {
  const dir = process.env.CONC_ARTIFACTS ?? ".";
  const entry = { pm: pm.n, code, attempt, offlineSeen: null, aborted: 0 };
  NUDGES.push(entry);
  console.log(`\n  ── SCREEN DID NOT MOVE — PM ${pm.n} on ${code} (attempt ${attempt}) ──`);
  console.log(`     url still: ${before}`);
  try {
    const state = await pm.page.evaluate(() => ({
      onLine: navigator.onLine,
      hasMilestoneInDom: !!document.querySelector(".milestone"),
      /* The app's own offline banner is `.banner.banner-warn` whose text starts
         "You are offline." — there is no `.banner-offline` class, and the first
         cut of this looked for one, so it reported false for a banner that may
         well have been on screen. A selector that cannot match is not evidence. */
      offlineBanner: [...document.querySelectorAll(".banner")]
        .some((b) => b.textContent.includes("You are offline")),
      netEvents: (window.__netEvents ?? []).slice(-8),
      bodyHas: {
        offlineWord: /you are offline|back online|offline/i.test(document.body.innerText),
        notSavedYet: document.body.innerText.includes("Not saved yet"),
        savedOnDevice: document.body.innerText.includes("Saved on this device"),
      },
      actions: document.querySelector(".assess-actions")?.innerText ?? "(no .assess-actions)",
      buttonDisabled: document.querySelector(".assess-actions button")?.disabled ?? null,
      checkedLevel: document.querySelector('input[name="level"]:checked')?.value ?? null,
    }));
    console.log(`     ${JSON.stringify(state)}`);
    entry.offlineSeen = state.offlineBanner || (state.netEvents ?? []).some((e) => e.startsWith("offline"));
  } catch (e) { console.log(`     (could not read the page: ${e.message})`); }
  const inflightNow = [...pm.pending.entries()]
    .map(([r, t]) => `${r.method()} ${r.url().slice(0, 120)} (${Date.now() - t}ms in flight)`);
  console.log(`     requests still in flight: ${inflightNow.length ? "\n       " + inflightNow.join("\n       ") : "none"}`);
  entry.aborted = pm.failedRequests.filter((f) => f.includes("ERR_ABORTED")).length;
  console.log(`     failed requests: ${pm.failedRequests.slice(-5).join(" | ") || "none"}`);
  console.log(`     page errors: ${pm.pageErrors.slice(-5).join(" | ") || "none"}`);
  console.log(`     console errors: ${pm.consoleErrors.slice(-5).join(" | ") || "none"}`);
  try {
    const shot = `${dir}/stall-pm${pm.n}-${code.replace(/\./g, "_")}.png`;
    await pm.page.screenshot({ path: shot, fullPage: false });
    console.log(`     screenshot: ${shot}`);
  } catch { /* a screenshot is a nicety, not the evidence */ }
  console.log("  ────────────────────────────────────────\n");
}

/**
 * Wait for whichever of the two things the click does, WITHOUT leaving a
 * dangling wait behind.
 *
 * The first cut of this raced `waitForFunction(url changed)` against
 * `locator('.milestone').waitFor()`. Whichever lost kept running, timed out 45
 * seconds later with nobody holding it, and arrived as an unhandledRejection —
 * which the crash handler correctly treated as a dead run. It killed a full
 * pass mid-walk. Polling both conditions in one loop has no loser to leak.
 */
async function settleAfterCommit(pm, before, code, timeout) {
  const deadline = Date.now() + timeout;
  let sawCard = false, nudges = 0, lastAction = Date.now();
  for (;;) {
    if (pm.page.url() !== before) return;
    if (!sawCard && await isVisible(pm, ".milestone")) {
      // A completed competency: the card replaces the panel and the click goes
      // nowhere. Continue is what a PM presses next.
      sawCard = true;
      pm.cards = (pm.cards ?? 0) + 1;
      await pm.page.click('.milestone .assess-actions button:has-text("Continue")', { timeout: 15_000 });
      lastAction = Date.now();
      continue;
    }
    /*
     * THE SCREEN DID NOT MOVE. A PM presses the button again — so this does
     * too, rather than declaring a dead run on the first one.
     *
     * That is a judgement call and it is recorded rather than buried: every
     * nudge is counted, diagnosed and reported at the end. If these turn out to
     * be the app failing to advance under load, the count is the finding; if
     * they are the container's proxied Chromium dropping requests, the count is
     * the noise floor. Silently retrying would have destroyed the distinction,
     * and dying on the first one would have thrown away a run over it.
     */
    if (Date.now() - lastAction > NUDGE_AFTER_MS && nudges < MAX_NUDGES) {
      nudges++;
      await dumpStall(pm, code, before, nudges);
      await pm.page
        .click(sawCard
          ? '.milestone .assess-actions button:has-text("Continue")'
          : ".assess-actions button.btn-primary", { timeout: 10_000 })
        .catch(() => {});
      lastAction = Date.now();
      continue;
    }
    if (Date.now() > deadline) {
      await dumpStall(pm, code, before, nudges + 1);
      throw new Error(`PM ${pm.n} stalled on ${code}: no navigation and no milestone card `
        + `${timeout}ms and ${nudges} nudges after the commit (still at ${before})`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Bounded visibility probe — never blocks the poll loop it is inside. */
const isVisible = (pm, sel) =>
  pm.page.evaluate((s) => {
    const el = document.querySelector(s);
    return !!el && !!el.getClientRects().length;
  }, sel).catch(() => false);

/** Wait for the queue to drain, by asking Postgres rather than the page. */
async function settle(expected, timeoutMs = 120_000) {
  const t0 = Date.now();
  for (;;) {
    const counts = await Promise.all(FIXTURES.map(async (pm) => {
      const { count } = await db.from("score").select("*", { count: "exact", head: true })
        .eq("assessment_id", pm.assessmentId).not("self_level", "is", null);
      return count ?? 0;
    }));
    if (counts.every((c, i) => c >= expected(FIXTURES[i]))) return { ok: true, counts, ms: Date.now() - t0 };
    if (Date.now() - t0 > timeoutMs) return { ok: false, counts, ms: Date.now() - t0 };
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Every score row a PM holds, keyed by control code. */
async function scoresOf(pm) {
  const { data, error } = await db.from("score")
    .select("control_id, self_level, assessor_level, evidence")
    .eq("assessment_id", pm.assessmentId).limit(5000);
  if (error) throw new Error(`score read failed: ${error.message}`);
  const byId = new Map(activeControls.map((c) => [c.id, c]));
  return (data ?? []).map((r) => ({ ...r, code: byId.get(r.control_id)?.code ?? r.control_id }));
}

/** Assessments that existed before this run and are no longer as they were. */
async function assessmentsThatMoved() {
  const { data, error } = await db
    .from("assessment").select("id, state, submitted_at, approved_at, archived_at").limit(5000);
  if (error) throw new Error(`assessment re-read failed: ${error.message}`);
  return (data ?? [])
    .filter((r) => PRIOR.has(r.id))
    .filter((r) => PRIOR.get(r.id) !== `${r.state}|${r.submitted_at}|${r.approved_at}|${r.archived_at}`)
    .map((r) => r.id);
}

/* ═══════════════════════════════════════════════════ 0. fixtures & assignment */

console.log(`\nTarget: ${BASE}`);
console.log(`Database: ${new URL(process.env.SUPABASE_URL).host}`);
console.log(`${PMS} simulated PMs · ${TOTAL} active controls · walk of ${WALK} each\n`);

console.log("[0] Fixtures — QA accounts and their assignments");
{
  await Promise.all([...FIXTURES, BOSS].map(ensure));
  check("all QA fixtures exist", [...FIXTURES, BOSS].every((p) => !!p.id));

  const { data: fwRow } = await db.from("framework").select("id")
    .eq("name", "IPMA ICB4").eq("version", "v4.0.1").maybeSingle();
  const { data: profRow } = await db.from("benchmark_profile").select("id").eq("name", "Intermediate").maybeSingle();
  if (!fwRow || !profRow) throw new Error("framework or default profile missing — is the database seeded?");
  const cycle = String(new Date().getUTCFullYear());

  // Mirrors assignAssessment exactly. Done here rather than through the admin
  // screen ON PURPOSE: that form lists the real staff who are not yet assigned,
  // and this run must not be able to assign a cycle to one of them by a stray
  // click. The assign path itself is covered by scripts/e2e.mjs.
  const now = new Date().toISOString();
  const ins = await db.from("assessment").insert(FIXTURES.map((pm) => ({
    framework_id: fwRow.id, profile_id: profRow.id, assessee_id: pm.id,
    cycle, state: "draft", assigned_at: now, assigned_by: BOSS.id,
  }))).select("id, assessee_id");
  if (ins.error) throw new Error(`assigning the QA fixtures failed: ${ins.error.message}`);
  for (const pm of FIXTURES) pm.assessmentId = ins.data.find((r) => r.assessee_id === pm.id)?.id;
  check("every QA PM has their own assessment",
    FIXTURES.every((pm) => !!pm.assessmentId)
    && new Set(FIXTURES.map((pm) => pm.assessmentId)).size === PMS);

  // The prior sittings. Deliberately different lengths — see SEEDS.
  const seeded = await Promise.all(FIXTURES.map((pm) => seedPriorSitting(pm, 1, pm.seed, "SEED")));
  check("prior sittings seeded to different depths",
    seeded.join(",") === FIXTURES.map((f) => f.seed).join(","), seeded.join(","));
  await db.from("assessment").update({ started_at: now })
    .in("id", FIXTURES.map((pm) => pm.assessmentId));
}

await stopIfAsked(0);

/* ═══════════════════════════════════════════════════════ 1. four sign-ins at once */

console.log("\n[1] Four PMs and the assessor sign in at the same moment");
{
  const t0 = Date.now();
  await Promise.all([...FIXTURES, BOSS].map((p) => timed("sign-in (concurrent)", () => signIn(p))));
  console.log(`    all ${PMS + 1} sessions established in ${Date.now() - t0}ms`);

  for (const pm of FIXTURES) {
    const url = pm.page.url();
    check(`PM ${pm.n} landed inside the app, not at a login wall`,
      !url.includes("/login") && !url.includes("vercel.com"), url);
  }
  // Each session must name its OWN holder. The header carries the signed-in
  // person; a shared instance handing back a memoised viewer would show here.
  const headers = await Promise.all(FIXTURES.map((pm) => pm.page.content()));
  for (const [i, html] of headers.entries()) {
    const pm = FIXTURES[i];
    const foreign = FIXTURES.filter((o) => o.n !== pm.n)
      .filter((o) => html.includes(o.name) || html.includes(o.email));
    check(`PM ${pm.n}'s first page names only PM ${pm.n}`,
      html.includes(pm.name) && foreign.length === 0,
      foreign.map((o) => o.name).join(", "));
  }
}

await stopIfAsked(1);

/* ══════════════════════════════════════ 2. the same control, in the same instant */

console.log(`\n[2] All ${PMS} answer control ${at(BURST_POS).code} in the same instant, with different levels`);
{
  const code = at(BURST_POS).code;
  await Promise.all(FIXTURES.map((pm) =>
    timed("control render (concurrent)", () => pm.page.goto(`/assess?c=${code}`))));
  // Every PM is now sitting on the same control with the panel loaded. The
  // commits go out together — this is the tightest interleaving the app will
  // ever see from four people, and the one where a request-scoped mix-up would
  // put one PM's level in another's record.
  const t0 = Date.now();
  await Promise.all(FIXTURES.map((pm) => timed("burst commit (concurrent)", () =>
    scoreAndAdvance(pm, code, levelFor(pm, BURST_POS), evidenceFor(pm, "BURST", code)))));
  const elapsed = Date.now() - t0;
  console.log(`    ${PMS} simultaneous commits dispatched in ${elapsed}ms`);

  /* "Concurrent" has to be a fact about the SERVER, not about how the test was
     written. Four commits issued together but served one after another would
     exercise none of the sharing this run exists to check, and would look
     identical in the pass/fail column. If the wall-clock for all four is well
     under the sum of their individual times, they overlapped. */
  const each = timings.get("burst commit (concurrent)") ?? [];
  const serial = each.reduce((a, b) => a + b, 0);
  check(`the ${PMS} commits were served concurrently, not queued`,
    elapsed < serial * 0.75,
    `${elapsed}ms wall-clock against ${serial}ms if served one at a time (${each.join("+")})`);

  const settled = await settle((pm) => pm.seed + 1);
  check("every simultaneous answer reached the database",
    settled.ok, `counts ${settled.counts.join("/")} after ${settled.ms}ms`);

  for (const pm of FIXTURES) {
    const rows = await scoresOf(pm);
    const mine = rows.find((r) => r.code === code);
    check(`PM ${pm.n}'s row for ${code} holds PM ${pm.n}'s own level`,
      mine?.self_level === levelFor(pm, BURST_POS),
      `expected ${levelFor(pm, BURST_POS)}, found ${mine?.self_level}`);
    check(`PM ${pm.n}'s row for ${code} holds PM ${pm.n}'s own evidence`,
      ownerOf(mine?.evidence) === pm.n, mine?.evidence ?? "(none)");
  }
}

await stopIfAsked(2);

/* ═══════════════════════════════════════════ 3. a concurrent walk, ten controls each */

console.log(`\n[3] All ${PMS} walk ${WALK} controls concurrently, from different places in the framework`);
{
  const t0 = Date.now();
  await Promise.all(FIXTURES.map(async (pm) => {
    await timed("control render (concurrent)", () =>
      pm.page.goto(`/assess?c=${at(pm.seed + 1).code}`));
    pm.walked = [];
    for (let k = 0; k < WALK; k++) {
      /* WHICHEVER CONTROL THE APP PUT US ON, not the one the loop counter
         predicts. The primary button does not always go to the next control in
         framework order — completing a competency raises the card and Continue
         goes to what is still OWED, which can be anywhere. A loop that assumed
         position would then type PM 1's answer for control 103 into whatever
         screen it was actually looking at, and the ownership check downstream
         would report a defect that the harness had manufactured. Reading the
         URL is also simply what a PM does: they answer the control in front of
         them. */
      const code = new URL(pm.page.url()).searchParams.get("c");
      if (!code || posOf(code) === undefined) {
        throw new Error(`PM ${pm.n} is not on a control page after ${k} commits: ${pm.page.url()}`);
      }
      await timed("commit + advance (concurrent)", () =>
        scoreAndAdvance(pm, code, levelFor(pm, posOf(code)), evidenceFor(pm, "WALK", code)));
      pm.walked.push(code);
    }
  }));
  console.log(`    ${PMS * WALK} commits across ${PMS} concurrent sessions in ${Date.now() - t0}ms`);
  for (const pm of FIXTURES) {
    const expected = new Map();
    for (let p = 1; p <= pm.seed; p++) expected.set(at(p).code, levelFor(pm, p));
    expected.set(at(BURST_POS).code, levelFor(pm, BURST_POS));
    for (const code of pm.walked) expected.set(code, levelFor(pm, posOf(code)));
    pm.expected = expected;
    console.log(`    PM ${pm.n} walked ${pm.walked.join(" → ")}`
      + (pm.cards ? ` (${pm.cards} milestone card${pm.cards === 1 ? "" : "s"})` : ""));
  }

  const settled = await settle((pm) => pm.expected.size);
  check("every walked answer reached the database",
    settled.ok, `counts ${settled.counts.join("/")} after ${settled.ms}ms`);
  console.log(`    queue drained ${settled.ms}ms after the last click`);
}

await stopIfAsked(3);

/* ═══════════════════════════════════════ 4. whose answers are in whose record */

if (SABOTAGE) {
  /* Move one of PM 1's walked answers into PM 2's record — a control PM 2 has
     never opened. This is precisely the failure the whole run exists to rule
     out, injected by hand so the next phase has something real to catch. */
  /* From the DEEPEST walker into the SHALLOWEST record, so the moved control is
     one the beneficiary has genuinely never opened. Moving between adjacent PMs
     is not enough: PM 1's walk sits inside PM 2's prior sitting, so the row
     would land on a control PM 2 legitimately holds and the stray-control check
     would never be exercised. Found by running this. */
  const victim = FIXTURES[FIXTURES.length - 1], beneficiary = FIXTURES[0];
  const pos = victim.seed + 1;
  const { data: row } = await db.from("score")
    .select("self_level, evidence").eq("assessment_id", victim.assessmentId)
    .eq("control_id", at(pos).id).maybeSingle();
  await db.from("score").delete()
    .eq("assessment_id", victim.assessmentId).eq("control_id", at(pos).id);
  await db.from("score").upsert({
    assessment_id: beneficiary.assessmentId, control_id: at(pos).id,
    self_level: row?.self_level ?? 3, evidence: row?.evidence ?? null,
  }, { onConflict: "assessment_id,control_id" });
  console.log(`\n  ⚠ SABOTAGE: moved ${at(pos).code} from PM ${victim.n} into PM ${beneficiary.n}'s record.`);
  console.log("    Phases [4] and [5] MUST go red. A green run here would mean the checks are decoration.");
}

console.log("\n[4] Ownership — every row in every record, checked against who typed it");
{
  let crossed = 0, wrongLevel = 0, unsigned = 0, strays = 0;
  for (const pm of FIXTURES) {
    const rows = await scoresOf(pm);
    const expected = pm.expected;

    for (const r of rows) {
      const owner = ownerOf(r.evidence);
      if (owner === null) unsigned++;
      else if (owner !== pm.n) { crossed++; console.log(`      ! PM ${pm.n} holds an answer signed by PM ${owner} on ${r.code}`); }
      if (!expected.has(r.code)) { strays++; console.log(`      ! PM ${pm.n} holds ${r.code}, which PM ${pm.n} never answered`); }
      else if (r.self_level !== expected.get(r.code)) {
        wrongLevel++;
        console.log(`      ! PM ${pm.n} ${r.code}: expected ${expected.get(r.code)}, found ${r.self_level}`);
      }
    }
    check(`PM ${pm.n} holds exactly the ${expected.size} answers PM ${pm.n} gave`,
      rows.length === expected.size, `found ${rows.length}`);
  }
  check("no answer is signed by a different PM than the record it sits in", crossed === 0, `${crossed} crossed`);
  check("no answer carries a level its PM did not choose", wrongLevel === 0, `${wrongLevel} wrong`);
  check("no unsigned answer appeared in any record", unsigned === 0, `${unsigned} unsigned`);
  check("no record gained a control its PM never opened", strays === 0, `${strays} strays`);
}

await stopIfAsked(4);

/* ══════════════════════════════════════════ 5. the progress each PM is shown */

console.log("\n[5] Progress — four concurrent renders of the one screen whose job is to report it");
{
  const expectedDone = new Map(FIXTURES.map((pm) => [pm.n, pm.expected.size]));
  check("the four PMs are at four different points, so a swap would be visible",
    new Set(expectedDone.values()).size === PMS,
    [...expectedDone.values()].join("/"));

  // Three rounds: one render can be right by luck, and the memo this is aimed
  // at lives for two seconds.
  for (let round = 1; round <= 3; round++) {
    const pages = await Promise.all(FIXTURES.map(async (pm) => {
      await timed("progress render (concurrent)", () => pm.page.goto("/assess/controls"));
      return pm.page.locator("body").innerText();
    }));
    for (const [i, text] of pages.entries()) {
      const pm = FIXTURES[i];
      const want = `${expectedDone.get(pm.n)} / ${TOTAL} controls scored`;
      const others = [...expectedDone.entries()].filter(([n]) => n !== pm.n)
        .map(([, d]) => `${d} / ${TOTAL} controls scored`)
        .filter((s) => text.includes(s));
      check(`round ${round}: PM ${pm.n} is shown their own progress (${want})`,
        text.includes(want) && others.length === 0,
        others.length ? `also showed ${others.join(" & ")}` : text.match(/\d+ \/ \d+ controls scored/)?.[0] ?? "no figure found");
    }
  }

  // The identity check, on a page dense with the PM's own data.
  const html = await Promise.all(FIXTURES.map((pm) => pm.page.content()));
  for (const [i, page] of html.entries()) {
    const pm = FIXTURES[i];
    const foreign = FIXTURES.filter((o) => o.n !== pm.n)
      .filter((o) => page.includes(o.name) || page.includes(o.email)
        || page.includes(`-P${o.n}-`));
    check(`PM ${pm.n}'s progress page contains nothing belonging to another PM`,
      foreign.length === 0, foreign.map((o) => `PM ${o.n}`).join(", "));
  }
}

await stopIfAsked(5);

/* ══════════════════════════════════════════════ 6. finish, then submit together */

console.log("\n[6] Four concurrent submits");
{
  // The rest of each sheet, as prior sittings. The walked step is done; what is
  // under test now is Submit, and Submit needs a complete sheet.
  await Promise.all(FIXTURES.map(async (pm) => {
    const have = new Set(pm.expected.keys());
    const rows = [];
    for (let p = 1; p <= TOTAL; p++) {
      if (have.has(at(p).code)) continue;
      rows.push({
        assessment_id: pm.assessmentId, control_id: at(p).id,
        self_level: levelFor(pm, p), evidence: evidenceFor(pm, "FILL", at(p).code),
      });
      pm.expected.set(at(p).code, levelFor(pm, p));
    }
    for (let i = 0; i < rows.length; i += 200) {
      const { error } = await db.from("score")
        .upsert(rows.slice(i, i + 200), { onConflict: "assessment_id,control_id" });
      if (error) throw new Error(`fill failed: ${error.message}`);
    }
  }));

  await Promise.all(FIXTURES.map((pm) =>
    timed("progress render (concurrent)", () => pm.page.goto("/assess/controls"))));
  const t0 = Date.now();
  await Promise.all(FIXTURES.map(async (pm) => {
    await timed("submit (concurrent)", async () => {
      const posted = pm.page.waitForResponse((r) => r.request().method() === "POST", { timeout: 60_000 })
        .catch(() => null);
      await pm.page.click('button:has-text("Submit"), button:has-text("submit for review")');
      await posted;
      await pm.page.waitForLoadState("networkidle");
    });
  }));
  console.log(`    ${PMS} simultaneous submits in ${Date.now() - t0}ms`);

  const { data: rows } = await db.from("assessment")
    .select("id, assessee_id, state, submitted_at")
    .in("id", FIXTURES.map((pm) => pm.assessmentId));
  for (const pm of FIXTURES) {
    const r = (rows ?? []).find((x) => x.id === pm.assessmentId);
    check(`PM ${pm.n}'s assessment moved to self_submitted`, r?.state === "self_submitted", r?.state);
    check(`PM ${pm.n}'s submission is stamped on PM ${pm.n}'s own row`,
      r?.assessee_id === pm.id && !!r?.submitted_at);
  }
  // Nobody else's record moved. The real staff records are the ones that matter
  // here, and "nothing outside this run changed state" is the assertion.
  const moved = await assessmentsThatMoved();
  check("no assessment outside this run changed state while it ran",
    moved.length === 0, moved.join(", "));
}

await stopIfAsked(6);

/* ═════════════════════════════════════════════════════════ 7. the assessor approves */

console.log("\n[7] The assessor reviews and approves each of them");
{
  for (const pm of FIXTURES) {
    await timed("review render", () => BOSS.page.goto(`/review?a=${pm.assessmentId}`));
    const text = await BOSS.page.locator("body").innerText();
    check(`the review screen for PM ${pm.n} is PM ${pm.n}'s`, text.includes(pm.name),
      text.slice(0, 160).replace(/\s+/g, " "));
    const pending = BOSS.page.locator('button:has-text("Accept all remaining")');
    if (await pending.count() > 0 && !/Accept all remaining \(0\)/.test(text)) {
      await timed("accept all", async () => {
        const posted = BOSS.page.waitForResponse((r) => r.request().method() === "POST", { timeout: 60_000 })
          .catch(() => null);
        await pending.first().click();
        await posted;
        await BOSS.page.waitForLoadState("networkidle");
      });
    }
    await timed("approve", async () => {
      const posted = BOSS.page.waitForResponse((r) => r.request().method() === "POST", { timeout: 60_000 })
        .catch(() => null);
      await BOSS.page.click('button:has-text("Approve assessment")');
      await posted;
      await BOSS.page.waitForLoadState("networkidle");
    });
    const { data: r } = await db.from("assessment").select("state, approved_at, assessor_id")
      .eq("id", pm.assessmentId).maybeSingle();
    check(`PM ${pm.n}'s assessment is approved`, r?.state === "approved" && !!r?.approved_at, r?.state);
    check(`PM ${pm.n}'s approval names the assessor`, r?.assessor_id === BOSS.id);
  }
}

await stopIfAsked(7);

/* ═══════════════════════════════════ 8. four results pages, rendered at once */

console.log("\n[8] Results — four concurrent renders, each checked against its own arithmetic");
{
  /* What each PM's 28 competency means MUST be, recomputed here from the rows
     in Postgres. `assessor_level` is what results show; submit copied every
     self_level into it and the assessor accepted, so this is the authoritative
     figure — and it is derived, never read off the page it is checking. */
  const byCe = new Map();
  for (const c of activeControls) {
    if (!byCe.has(c.ce_id)) byCe.set(c.ce_id, []);
    byCe.get(c.ce_id).push(c);
  }
  const expectedFor = async (pm) => {
    const rows = await scoresOf(pm);
    const lvl = new Map(rows.map((r) => [r.code, r.assessor_level]));
    const out = [];
    for (const [ceId, controls] of byCe) {
      const xs = controls.map((c) => lvl.get(c.code)).filter((v) => v !== null && v !== undefined);
      if (xs.length === 0) continue;
      out.push({ ce: ceById.get(ceId)?.name ?? ceId, actual: xs.reduce((a, b) => a + b, 0) / xs.length });
    }
    return out;
  };
  const expected = new Map();
  for (const pm of FIXTURES) expected.set(pm.n, await expectedFor(pm));

  // The check can only discriminate if the four PMs' numbers actually differ.
  // Say so rather than passing on a comparison that could not have failed.
  const fingerprints = FIXTURES.map((pm) =>
    expected.get(pm.n).map((r) => r.actual.toFixed(1)).sort().join(","));
  check("the four PMs' competency means are pairwise distinct, so a swap would fail this",
    new Set(fingerprints).size === PMS);

  for (let round = 1; round <= 3; round++) {
    const html = await Promise.all(FIXTURES.map(async (pm) => {
      await timed("results render (concurrent)", () => pm.page.goto("/results"));
      return pm.page.content();
    }));
    for (const [i, page] of html.entries()) {
      const pm = FIXTURES[i];
      const shown = [...page.matchAll(/<b class="tnum">([\d.—]+)<\/b>/g)].map((m) => m[1]);
      const mine = expected.get(pm.n).map((r) => r.actual.toFixed(1));
      if (shown.length !== mine.length) {
        cannotRun(`round ${round}: PM ${pm.n}'s competency means compared against the page`,
          `page carried ${shown.length} competency figures, arithmetic produced ${mine.length}`);
      } else {
        const a = [...shown].sort().join(","), b = [...mine].sort().join(",");
        check(`round ${round}: PM ${pm.n}'s results show PM ${pm.n}'s own ${mine.length} competency means`,
          a === b, a === b ? "" : `page ${a}\n            db   ${b}`);
        // And not somebody else's: the one that would look right on its own.
        const impostor = FIXTURES.find((o) => o.n !== pm.n
          && [...expected.get(o.n).map((r) => r.actual.toFixed(1))].sort().join(",") === a);
        check(`round ${round}: PM ${pm.n} was not shown another PM's report`,
          !impostor, impostor ? `matched PM ${impostor.n}` : "");
      }
      check(`round ${round}: PM ${pm.n}'s report names PM ${pm.n}`, page.includes(pm.name));
      const foreign = FIXTURES.filter((o) => o.n !== pm.n)
        .filter((o) => page.includes(o.name) || page.includes(o.email) || page.includes(`-P${o.n}-`));
      check(`round ${round}: PM ${pm.n}'s report carries nothing of another PM's`,
        foreign.length === 0, foreign.map((o) => `PM ${o.n}`).join(", "));
    }
  }

  // One more time with the two views interleaved — the toggle re-renders the
  // whole body, which is a second server pass per PM inside the same seconds.
  const mixed = await Promise.all(FIXTURES.map(async (pm, i) => {
    const view = i % 2 === 0 ? "/results?view=gaps" : "/results";
    await timed("results render (concurrent)", () => pm.page.goto(view));
    return pm.page.content();
  }));
  for (const [i, page] of mixed.entries()) {
    const pm = FIXTURES[i];
    const foreign = FIXTURES.filter((o) => o.n !== pm.n)
      .filter((o) => page.includes(o.name) || page.includes(o.email) || page.includes(`-P${o.n}-`));
    check(`PM ${pm.n}'s report is still theirs with the two views interleaved`,
      page.includes(pm.name) && foreign.length === 0, foreign.map((o) => `PM ${o.n}`).join(", "));
  }
}

await stopIfAsked(8);

/* ═══════════════════════════════════════════════ 9. the record, end to end */

console.log("\n[9] The finished records");
{
  for (const pm of FIXTURES) {
    const rows = await scoresOf(pm);
    const crossed = rows.filter((r) => ownerOf(r.evidence) !== pm.n);
    check(`PM ${pm.n}'s finished record is ${TOTAL} answers, all PM ${pm.n}'s own`,
      rows.length === TOTAL && crossed.length === 0,
      `${rows.length} rows, ${crossed.length} signed by someone else`);
    const wrong = rows.filter((r) => r.assessor_level !== pm.expected.get(r.code));
    check(`PM ${pm.n}'s authoritative scores are PM ${pm.n}'s own answers`,
      wrong.length === 0, wrong.slice(0, 3).map((r) => `${r.code}=${r.assessor_level}`).join(", "));
    const { count } = await db.from("target_snapshot").select("*", { count: "exact", head: true })
      .eq("assessment_id", pm.assessmentId);
    check(`PM ${pm.n}'s targets were frozen at approval`, (count ?? 0) > 0, String(count));
  }
  const moved = await assessmentsThatMoved();
  check("still no assessment outside this run has changed", moved.length === 0, moved.join(", "));
}

await teardown();
summarise();
process.exit(fail === 0 ? 0 : 1);
