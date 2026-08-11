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
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";

/**
 * The one way in, read from the app's own source rather than retyped here.
 *
 * The defect these nav checks exist to prevent was several screens holding
 * their own copy of this path and drifting apart. A literal in the test would
 * be one more copy — it would keep passing against a stale route while the app
 * moved. Parsing lib/routes.ts means a rename is followed, and a deletion is a
 * loud failure rather than a silently weakened test. (e2e.mjs runs under plain
 * node with no type stripping, so this cannot be a real import.)
 */
const ASSESS_HUB = (() => {
  const src = readFileSync(new URL("../lib/routes.ts", import.meta.url), "utf8");
  const m = /export const ASSESS_HUB = "([^"]+)"/.exec(src);
  if (!m) {
    throw new Error(
      "lib/routes.ts no longer exports ASSESS_HUB as a string literal — the "
      + "navigation checks cannot verify the one-way-in rule. Fix the export "
      + "or update this parser; do not hardcode the path here.",
    );
  }
  return m[1];
})();

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

/**
 * Fixture passwords are GENERATED PER RUN, never written down here.
 *
 * They used to be literals, and this repository is public. That is only safe
 * for as long as cleanup never misses, because a fixture account that outlives
 * its run is a real, sign-in-able account on the real allowlist whose password
 * anyone can read on GitHub — and one of these fixtures is an admin. A /cso
 * pass on 2026-08-06 found exactly that shape already sitting in the database:
 * two accounts from an interrupted pace run, one of them admin, still
 * authenticating. Those came from an ad-hoc script rather than this file, which
 * is the point — the convention published here is what makes any such leftover
 * guessable.
 *
 * A per-run secret makes a leftover account inert: nobody, including us, knows
 * its password once the process exits. Cleanup still has to work (see
 * teardown), but it is no longer the only thing standing between a crashed test
 * run and an admin login on a public URL.
 */
const qaPassword = () => `Qa${randomBytes(15).toString("base64url")}1!`;

const PM = { email: "qa.pm1@example.test", name: "QA Test PM One", password: qaPassword() };
const OTHER = { email: "qa.pm2@example.test", name: "QA Test PM Two", password: qaPassword() };
/**
 * The suite brings its own admin rather than borrowing a real one. Two reasons:
 * a real account gets `must_change_password` set and would be redirected out of
 * every admin test, and — the N13 lesson — a test run should never touch the
 * data of someone who might be using the app at the time.
 */
const BOSS = {
  email: "qa.admin@example.test", name: "QA Assessor",
  password: qaPassword(), role: "admin",
};

let pass = 0, fail = 0;
/**
 * The Supabase round trips a REQUEST made, for the budget assertions.
 *
 * JWKS IS EXCLUDED, and the exclusion is defended by its own check below.
 * `getClaims()` verifies the session signature locally against a JWKS that is
 * cached module-globally, so fetching it is a once-per-INSTANCE bootstrap, not
 * per-request work. Counting it made the boundary-commit budget read 4 instead
 * of 3 on whichever run happened to warm a cold instance — measured, one red in
 * five identical runs. A load-bearing budget that goes red at random trains
 * exactly the skimming CLAUDE.md's "round trips are counted, not estimated"
 * rule exists to prevent.
 *
 * Excluding it would ALSO hide a real regression — someone making JWKS a
 * per-request fetch — so `jwksFetches()` below asserts it stays at most one for
 * the whole run. The budget and that check together say what the old single
 * count was trying to: our per-request calls are 3 or 5, and the bootstrap
 * happens once.
 */
/* Where the server log stood when this run began.
   Without it, a check that reads the whole file measures the log's LIFETIME,
   not the run's — and /tmp/next.log survives across suite runs against one
   long-lived `next start`. The first cut of the JWKS check below did exactly
   that and reported "6 fetches" for eight runs' worth of log, which looked like
   a finding and was an artefact. */
const RUN_MARK = (() => {
  const f = process.env.E2E_SERVER_LOG;
  if (!f) return 0;
  try { return readFileSync(f, "utf8").length; } catch { return 0; }
})();

const supabaseCalls = (text) =>
  text.split("\n").filter((l) => l.includes("[supabase ") && !l.includes("jwks.json"));

const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};

/**
 * A block that did NOT run, counted rather than merely mentioned.
 *
 * Twice in one evening a check quietly skipped itself and the run still said
 * "235 passed, 0 failed" — once because a security assertion was wrapped in
 * `if (fixture)` and the fixture had been withdrawn by then, once because the
 * round-trip budget is gated on E2E_SERVER_LOG and nobody had set it, so the
 * one assertion behind CLAUDE.md's "round trips are counted, not estimated"
 * had never executed. A `console.log` among 237 ticks is not a signal.
 *
 * So skips land in the final tally. "237 passed, 0 failed, 1 skipped" is a
 * different sentence from "237 passed, 0 failed", and it is the true one.
 */
const skipped = [];
const skip = (name, why) => {
  skipped.push(name);
  console.log(`  ⊘ SKIPPED: ${name} — ${why}`);
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
/**
 * EVERY page of auth.users, not just the first.
 *
 * `listUsers({ page: 1, perPage: 1000 })` was written out at three call sites,
 * and past a thousand accounts each of them failed OPEN: a stray QA account on
 * page two is not deleted by a purge, not swept by the teardown, and — worst —
 * not seen by the assertion that exists to catch precisely that. "No QA sign-in
 * accounts left behind either" would print green with a live admin fixture
 * sitting on the real project. A backstop that silently truncates is not a
 * backstop, so this pages until a short page comes back.
 */
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

/** The QA fixtures among them. One definition of "a QA account", used by both
 *  the sweep and the assertion that checks the sweep worked. */
const qaAuthAccounts = async () =>
  (await allAuthUsers()).filter((u) => u.email?.endsWith("@example.test"));

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

/*
 * RUNNING AGAINST A REAL VERCEL PREVIEW, not just localhost.
 *
 * `/qa` is a gate before merge and the thing it has to run against is the
 * PREVIEW — the only place unmerged work actually runs. Two obstacles, and only
 * one of them is the obvious one.
 *
 * DEPLOYMENT PROTECTION is the obvious one: every preview URL 302s to
 * `vercel.com/sso-api` without a Protection Bypass for Automation secret. It
 * lives in this environment as `Vercel_deployment_ByPass`, is passed BY
 * REFERENCE, and must never be printed or committed. It has to be on EVERY
 * request — assets and RSC payloads included — so it is attached by wrapping
 * `newContext` once rather than by editing thirty call sites, which is exactly
 * the kind of drift the ASSESS_HUB parser above exists to prevent.
 *
 * TLS IS THE ONE THAT COSTS A DAY. The egress proxy intercepts TLS, and its
 * handshake RESETS Chromium's TLS 1.3 — every external host, not just Vercel.
 * `curl` and node `fetch` negotiate differently and get 200, so the network
 * looks fine right up until the browser touches it. Disabling ECH, QUIC, HTTP/2
 * and post-quantum key agreement all failed; capping the version works. This
 * was diagnosed twice as something else first — "the preview is unreachable"
 * and "deployment protection blocks the browser" — and both wrong answers
 * pointed the owner at a fix they did not need, which is why the mechanism is
 * written down here rather than just the flag.
 */
const REMOTE = !BASE.startsWith("http://127.0.0.1") && !BASE.startsWith("http://localhost");
const BYPASS = process.env.Vercel_deployment_ByPass;
if (REMOTE && !BYPASS) {
  throw new Error(
    `E2E_BASE_URL is remote (${BASE}) but Vercel_deployment_ByPass is unset — every `
    + "request would 302 to vercel.com/sso-api and the run would report a fake pass. "
    + "The variable is injected at container start, so a session that predates it "
    + "needs a new session, not a new variable.",
  );
}
const browser = await chromium.launch({
  ...(CHROME ? { executablePath: CHROME } : {}),
  ...(REMOTE
    ? {
        args: ["--ssl-version-max=tls1.2"],
        ...(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY } } : {}),
      }
    : {}),
});
if (REMOTE) {
  const openContext = browser.newContext.bind(browser);
  browser.newContext = (opts = {}) => openContext({
    ...opts,
    extraHTTPHeaders: {
      ...(opts.extraHTTPHeaders ?? {}),
      "x-vercel-protection-bypass": BYPASS,
    },
  });
  console.log(`  (running against ${BASE} — preview, with protection bypass)`);
}
// `closingOnPurpose` matters: teardown's own browser.close() fires this event,
// so without the flag the diagnostic reports a disconnect on EVERY clean run —
// it did exactly that on its first outing. A signal that always fires carries
// no information, and would have made the real thing invisible.
let closingOnPurpose = false;
browser.on("disconnected", () => {
  if (closingOnPurpose) return;
  console.log(`    ⚠ chromium DISCONNECTED UNEXPECTEDLY at ${new Date().toISOString()} (N21)`);
});

/**
 * Cleanup has to run even when the suite dies mid-flight.
 *
 * This is the N21 lesson, and it cost three rounds. The suite is top-level
 * sequential code, so a throw at any one of the 68 `page.goto` calls skipped
 * the entire cleanup block at the bottom of this file: the three QA accounts
 * stayed in the REAL database — on the allowlist, inside the completion
 * denominator — and the browser stayed open. The run printed a bare Node
 * stack: no summary, no failing group, no clue which section died. A crash
 * must leave the database as clean as a pass does, and must SAY what broke.
 */
/*
 * A PROMISE, not a boolean (/review, 2026-08-06). Two holes the flag had:
 *
 * - A second Ctrl-C — or an unhandled rejection thrown by the still-running
 *   suite while cleanup is deleting its rows — re-entered here, hit the guard,
 *   returned INSTANTLY, and the caller's `.finally()` then called
 *   process.exit(1) with the first purge still mid-flight. The impatient
 *   double-Ctrl-C is the likeliest way a human ends a dragging run, so the
 *   guard was most likely to fail in exactly the case it was added for.
 * - The flag was set BEFORE any work, so an exception inside the purge loop
 *   disabled the only retry path permanently.
 *
 * Re-entry now awaits the SAME attempt instead of racing it.
 */
let teardownRun = null;
const teardown = () => (teardownRun ??= doTeardown());

async function doTeardown() {
  console.log("\nCleaning up QA data and accounts…");

  /*
   * Purge by PATTERN, not by the three names this file happens to know.
   *
   * The sweep seeds itself with the three fixtures declared at the top and then
   * adds everything matching %@example.test from BOTH app_user and Auth. The
   * three names alone do NOT cover the transient accounts created inside a test
   * block (qa.added, qa.orphan), which purge themselves at both ends of their
   * own block and are therefore stranded by a crash in the middle. Nor do they
   * cover a fixture from some OTHER script pointed at the same database.
   *
   * Both gaps were real. A /cso pass on 2026-08-06 found qa.pace.pm and
   * qa.pace.boss — an interrupted ad-hoc pace run, one of them an admin whose
   * password still authenticated against production, sitting on the allowlist
   * for hours. This teardown had already NOTICED them: the two checks below
   * were red, naming both accounts, run after run. It reported and moved on.
   *
   * A cleanup step that can see the mess and is not allowed to clear it just
   * teaches everyone to skim the red line. So sweep every @example.test
   * account, then assert. The assertions stay: they now catch a purge that
   * FAILED rather than one that was never attempted.
   */
  const { data: allQa } = await db.from("app_user").select("email").like("email", "%@example.test");
  const qaEmails = new Set([
    PM.email, OTHER.email, BOSS.email,
    ...(allQa ?? []).map((u) => u.email),
    ...(await qaAuthAccounts()).map((u) => u.email),
  ]);
  /* One failing purge must not abandon the rest, or the accounts behind it in
     the loop. Whatever survives is named by the assertions below, which is the
     signal — an exception here used to take those assertions with it. */
  for (const email of qaEmails) {
    try {
      await purge(email);
    } catch (e) {
      console.log(`  ✗ could not purge ${email} — ${e.message}`);
    }
  }

  const { data: leftovers } = await db.from("app_user").select("email").like("email", "%@example.test");
  check("no QA accounts left on the allowlist", (leftovers ?? []).length === 0,
    (leftovers ?? []).map((u) => u.email).join(","));
  const strays = await qaAuthAccounts();
  check("no QA sign-in accounts left behind either", strays.length === 0,
    strays.map((u) => u.email).join(","));
  closingOnPurpose = true;
  await browser.close().catch(() => {});
}

function crashed(label, err) {
  fail++;
  console.log(`\n  ✗ SUITE ${label} — ${String(err?.message ?? err).split("\n")[0]}`);
  const where = String(err?.stack ?? "").split("\n").find((l) => l.includes("e2e.mjs"));
  if (where) console.log(`    ${where.trim()}`);
  teardown()
    .catch((e) => console.log(`  ✗ cleanup after the crash ALSO failed — ${e.message}`))
    .finally(() => {
      console.log(`\n${pass} passed, ${fail} failed${skipped.length ? `, ${skipped.length} SKIPPED (${skipped.join("; ")})` : ""}`);
      process.exit(1);
    });
}

process.on("uncaughtException", (err) => crashed("CRASHED", err));

/*
 * The other three ways this process can die, all of which used to skip cleanup
 * and leave live accounts on the real allowlist.
 *
 * `uncaughtException` alone was never the whole set. A rejected promise nobody
 * awaited, and Ctrl-C — the ordinary way a human ends a run that is taking too
 * long — both walked straight past teardown. That is the likeliest route by
 * which the qa.pace accounts survived.
 *
 * SIGHUP and SIGQUIT are in the list too: a closed terminal window or a dropped
 * SSH session is at least as ordinary a way to end a long run as Ctrl-C, and
 * Node's default action for both is to terminate. SIGKILL and a power cut stay
 * uncoverable by construction — which is the standing argument for the per-run
 * fixture passwords being a real second layer rather than a nicety.
 */
process.on("unhandledRejection", (err) => crashed("HIT AN UNHANDLED REJECTION", err));
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"]) {
  process.on(sig, () => crashed("INTERRUPTED", new Error(`received ${sig}`)));
}

/**
 * Chromium intermittently aborts a main-frame navigation with
 * `net::ERR_ABORTED; maybe frame was detached?` — seen once in 9 runs, at the
 * theme-survives-navigation step. The mechanism is NOT known: it is a
 * navigation the renderer cancelled, and this arc has already lost three
 * confidently-argued mechanisms, so this does not pretend to be a diagnosis.
 * It retries once and SAYS SO in the output, so the retry can never quietly
 * become the reason the suite looks green.
 */
async function gotoStable(page, url) {
  try {
    return await page.goto(url);
  } catch (e) {
    if (!String(e.message).includes("ERR_ABORTED")) throw e;
    console.log(`    ↻ navigation to ${url} aborted; retrying once (N21)`);
    return await page.goto(url);
  }
}

/**
 * N21 diagnostics, not a fix.
 *
 * Two crashes, two different messages, same shape — a navigation that dies
 * abruptly: `net::ERR_ABORTED; maybe frame was detached?` on one run, and
 * `Target page, context or browser has been closed` on another, the latter
 * with the PM's context provably never closed by the suite (contexts are
 * closed 10 times against 4 opened, and `pm.ctx` is not among them). Both are
 * consistent with chromium dying underneath the run, but this arc has already
 * buried three confident mechanisms, so nothing is concluded. These listeners
 * make the next occurrence SAY whether the browser dropped or a renderer
 * crashed, with a timestamp to line up against the run log.
 */
function watchForDeath(page, label) {
  // "crash" only. A `close` listener would fire on all 10 deliberate
  // ctx.close() calls and drown the signal it is meant to carry.
  page.on("crash", () =>
    console.log(`    ⚠ renderer CRASHED on ${label} at ${new Date().toISOString()} (N21)`));
}

async function session(email, password) {
  const ctx = await browser.newContext({ baseURL: BASE });
  const page = await ctx.newPage();
  watchForDeath(page, email);
  await page.goto("/login");
  await page.fill("#email", email);
  await page.fill("#password", password);
  // Scoped to the login form on purpose: the layout carries a theme toggle
  // whose buttons are also submits, and page.click() is not strict — it would
  // silently take the first match, which is a theme button on every signed-in
  // page. That mistake cost six passing tests when the toggle landed.
  await submitAction(page, () => page.click('form button[type="submit"]:has-text("Sign in")'));
  return { ctx, page };
}
/**
 * Wait for a server action's effect, not for the network to go quiet.
 *
 * `networkidle` is 500ms of silence, which is a proxy for "the action finished"
 * and not the thing itself. It was passing here for an accidental reason: the
 * nav fired five link prefetches on every page, and that noise kept the network
 * busy long enough for the POST to land. Turning prefetching off (N21) removed
 * the noise and the add-person checks began failing about every run — the race
 * had been there all along, propped up by requests that did nothing else.
 *
 * So wait for the OUTCOME. On success this returns as soon as the effect is
 * visible; on genuine failure it times out and the checks below report what
 * actually went wrong, instead of a timeout burying them.
 *
 * Third instance of this trap in this file — see also the withdraw button in
 * section [2] and the score re-render in [14].
 */
async function actionLanded(page, text, timeout = 15_000) {
  await page
    .waitForFunction((t) => document.body.innerText.includes(t), text, { timeout })
    .catch(() => {});
}

/**
 * Submit a form and wait for the server to have actually finished.
 *
 * The generic form of the trap above. `click()` does not wait for anything, so
 * `networkidle` straight afterwards can measure silence that exists because the
 * POST has not STARTED yet — 500ms of quiet before the work, read as 500ms of
 * quiet after it. Removing the prefetch noise (N21) turned that from a rare
 * flake into a frequent one across the whole suite, which is how fourteen sites
 * that had looked fine for weeks all became suspect at once.
 *
 * Arming waitForResponse BEFORE the click is the whole point: the listener has
 * to exist before the request it is waiting for. Then networkidle is measured
 * after a POST is known to have come back, so it settles the re-render rather
 * than standing in for the action.
 *
 * `.catch(() => null)` so a submit that legitimately makes no POST — a client
 * validation that never reaches the server — falls through to the check rather
 * than dying in the helper.
 */
async function submitAction(page, click, timeout = 20_000) {
  const posted = page
    .waitForResponse((r) => r.request().method() === "POST", { timeout })
    .catch(() => null);
  await click();
  await posted;
  await page.waitForLoadState("networkidle");
}

/**
 * Score one control and confirm it — the save UX change made these two
 * separate acts, so the helper does both and waits for the answer to actually
 * reach the server.
 *
 * "Next control" navigates immediately and the write happens in the
 * background, so there is no response to await: instead this polls the outbox
 * through the DOM. The banner is the app's own statement that answers are
 * still queued, so waiting for it to disappear waits for exactly the thing the
 * user waits for.
 */
async function scoreAndNext(page, level, evidence) {
  await page.check(`input[name="level"][value="${level}"]`);
  if (evidence !== undefined) await page.fill("#evidence", evidence);
  // Wait for the COMMIT, which is the server-action POST. Waiting on the
  // failure banner instead would be worse than useless: it only appears when
  // something went wrong, so "no banner" is true the instant the click lands
  // and the assertion would race the write it is meant to wait for. That is
  // exactly how this helper was wrong the first time.
  const committed = page.waitForResponse(
    (r) => r.request().method() === "POST", { timeout: 20_000 });
  await page.click('.assess-actions button:has-text("Next control"), .assess-actions button:has-text("Review before submitting")');
  await committed;
  await page.waitForLoadState("networkidle");
}

const idOf = async (email) =>
  (await db.from("app_user").select("id").eq("email", email).single()).data.id;
/**
 * The person's LIVE assessment, or null.
 *
 * maybeSingle, not single: "no assessment" is an ordinary state — nobody has one
 * until an admin assigns it. Filtered to live rows because archiving lets one
 * person accumulate several rows per cycle, and an unfiltered maybeSingle would
 * start throwing on the second archive.
 */
const assessmentOf = async (email) =>
  (await db.from("assessment").select("*").eq("assessee_id", await idOf(email))
    .is("deleted_at", null).maybeSingle()).data;

const { data: activeControls } = await db
  /* ce_id is needed by [16] to find the largest competence element and to skip
     a control OUTSIDE the one under test. It is `ce_id` on this table — the app
     exposes `ce_code`, which lib/framework.ts maps. Selecting the wrong name
     left every value undefined, so a filter meant to pick one competency
     silently matched all 132 controls and a test meant to skip one seeded every
     one of them, and still reported green. */
  .from("control").select("id, code, ce_id, target_level")
  .eq("active", true).order("sort_order").limit(5000);

/* ---------------------------------------------------- 1. invite-only auth */
console.log("\n[1] Invite-only auth");
{
  const ctx = await browser.newContext({ baseURL: BASE });
  const page = await ctx.newPage();
  await page.goto("/login");
  await page.fill("#email", "not.invited@example.test");
  await page.fill("#password", "whatever123");
  await submitAction(page, () => page.click('button[type="submit"]'));
  check("uninvited email is refused", page.url().includes("/login") && (await page.locator('[role="alert"]').count()) > 0);
  await page.goto("/results");
  check("no session cannot reach /results", page.url().includes("/login"));
  await ctx.close();
}

/*
 * The refusal floor — the sign-in timing oracle (/cso finding 2).
 *
 * The identical error message exists to stop an outsider enumerating the
 * pilot's staff list. It was undone by the clock: the allowlist was checked
 * first and returned early, so an address that had never been invited never
 * paid for a password verification and answered ~250ms sooner than one that
 * had. Nothing asserted the fix, so restoring the early return would have gone
 * unnoticed — the two sign-in failure checks both read text, never duration.
 *
 * ASSERTED AS A ONE-SIDED FLOOR, deliberately. Comparing the two branches to
 * each other is the flaky formulation: it goes red on an unlucky sample. A
 * floor can only be exceeded — client-measured time is server floor plus
 * network plus render — so `elapsed >= floor` cannot fail on a slow day, only
 * when the padding is genuinely gone.
 *
 * The constant is READ FROM THE SOURCE for the same reason ASSESS_HUB is: a
 * copy here would keep asserting 600ms after someone tuned it.
 */
{
  const FLOOR_MS = (() => {
    const src = readFileSync(new URL("../app/login/actions.ts", import.meta.url), "utf8");
    const m = /const FAILURE_FLOOR_MS = (\d+)/.exec(src);
    if (!m) {
      throw new Error(
        "app/login/actions.ts no longer declares FAILURE_FLOOR_MS — the sign-in "
        + "timing check cannot verify anything. Fix the export or update this "
        + "parser; do not hardcode the value here.",
      );
    }
    return Number(m[1]);
  })();

  const timeRefusal = async (email, password) => {
    const ctx = await browser.newContext({ baseURL: BASE });
    const page = await ctx.newPage();
    await page.goto("/login");
    await page.fill("#email", email);
    await page.fill("#password", password);
    const t0 = Date.now();
    await submitAction(page, () => page.click('form button[type="submit"]:has-text("Sign in")'));
    await page.waitForSelector('[role="alert"]');
    const ms = Date.now() - t0;
    await ctx.close();
    return ms;
  };

  // No account at all — the branch that used to answer ~250ms sooner.
  const stranger = await timeRefusal("never.invited@example.test", "wrong-on-purpose");
  check("an address that was never invited is not refused faster than the floor",
    stranger >= FLOOR_MS, `${stranger}ms, floor ${FLOOR_MS}ms`);

  // A real, invited address with the wrong password — the branch that always paid.
  const invited = await timeRefusal(PM.email, "wrong-on-purpose");
  check("and neither is a wrong password on an invited one",
    invited >= FLOOR_MS, `${invited}ms, floor ${FLOOR_MS}ms`);
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
/*
 * N22: signing in and then pressing Back landed on /login again — with the
 * signed-in header still around it, because the session was fine and the page
 * simply never asked. It reads as "I am logged out but the nav is showing".
 * Browser Back is the reported route in, so that is what is driven here rather
 * than a bare goto.
 */
{
  // Back FIRST, before any other navigation: `session()` just signed this page
  // in through the form, so /login is genuinely the previous history entry.
  // This is the owner's exact sequence, not an approximation of it.
  await pm.page.goBack();
  const backForm = await pm.page.locator('form input#password').count();
  const backChrome = await pm.page.locator('a:has-text("Sign out")').count();
  const where = `${pm.page.url()} — password field: ${backForm}, chrome: ${backChrome}`;

  // Assert what was REPORTED — a sign-in form inside signed-in chrome — not the
  // URL. The first version of this check tested `url() !== /login` and failed
  // against a page that was already rendering correctly: after a soft back the
  // address bar still reads /login while the CONTENT is the redirect target.
  // That is cosmetic; being shown the form is not. Measured: 0 password fields.
  check("pressing Back after signing in does not show the sign-in form again",
    backForm === 0 && backChrome === 1, where);

  await pm.page.goto("/login");
  check("nor does going to /login directly while signed in",
    !pm.page.url().includes("/login"), pm.page.url());

  // The denied banner is the only explanation an un-allowlisted person gets,
  // so it must survive the redirect rather than be swallowed by it.
  await pm.page.goto("/login?denied=1");
  check("the allowlist refusal still explains itself",
    (await pm.page.locator('[role="status"]').count()) > 0, pm.page.url());
  await pm.page.goto("/");
}

/*
 * N23 — a failed sign-in keeps what was typed.
 *
 * The bug was never that the app replaced the address: it redirected to a
 * fresh page with an empty field, and the browser's autofill supplied the
 * saved one. The person then saw an address they had not typed and could not
 * see their own typo. The fix returns the typed value instead of redirecting,
 * so this asserts the value SURVIVES rather than asserting anything about
 * autofill, which the suite cannot simulate.
 */
{
  const ctx = await browser.newContext({ baseURL: BASE });
  const page = await ctx.newPage();
  await page.goto("/login");
  const typo = "qa..pm@example.test";          // doubled dot: passes type="email"
  await page.fill("#email", typo);
  await page.fill("#password", "wrong-on-purpose");
  await submitAction(page, () => page.click('form button[type="submit"]:has-text("Sign in")'));

  check("a failed sign-in still refuses", (await page.locator(".banner-error").count()) === 1);
  check("and keeps the address that was actually typed",
    (await page.inputValue("#email")) === typo, await page.inputValue("#email"));
  check("the refusal says nothing about which part was wrong",
    /not recognised, or that account has not been invited/.test(
      await page.locator(".banner-error").innerText()));
  check("and nothing is written into the URL",
    !page.url().includes("error=") && !page.url().includes("email="), page.url());
  await ctx.close();
}

/*
 * N28: form rows have vertical rhythm.
 *
 * A 0px gap is invisible to every other check in this suite — nothing
 * overflows, nothing is off screen, the form submits, the colours pass. That
 * is exactly how it survived to be the first thing the pilot noticed. So it is
 * asserted as a MEASURED gap: the rule cannot be deleted later without this
 * going red.
 */
{
  const ctx = await browser.newContext({ baseURL: BASE });
  const page = await ctx.newPage();
  await page.goto("/login");

  const pw = await page.locator("#password").boundingBox();
  const btn = await page.locator('form button[type="submit"]').boundingBox();
  const toButton = btn.y - (pw.y + pw.height);
  /* ON THE SCALE, not merely non-zero.
     `> 0` was the first draft and it passes at 7px or 20px — but the defect
     being fixed is that forms sat outside DESIGN.md's 4-8-12-16-24-32-48
     rhythm, so "some gap" is not the property. 16 is the rule's value. */
  const SCALE = [4, 8, 12, 16, 24, 32, 48];
  check("the sign-in button is not flush against the password field",
    toButton > 0, `${Math.round(toButton)}px`);
  check("and the gap is on the DESIGN.md spacing scale",
    SCALE.includes(Math.round(toButton)), `${Math.round(toButton)}px, scale ${SCALE.join("/")}`);

  const email = await page.locator("#email").boundingBox();
  const pwLabel = await page.locator('label[for="password"]').boundingBox();
  const betweenRows = pwLabel.y - (email.y + email.height);
  check("and one form row is not flush against the next",
    betweenRows > 0, `${Math.round(betweenRows)}px`);
  check("the rule itself is the 16px one, not something that happens to look right",
    (await page.locator(".field").first().evaluate(
      (el) => getComputedStyle(el).marginBottom)) === "16px",
    await page.locator(".field").first().evaluate((el) => getComputedStyle(el).marginBottom));
  await ctx.close();
}

/*
 * LANDING BY ROLE (D32) — a sign-in default, NOT a redirect on `/`.
 *
 * The distinction is the whole point and is asserted here. Redirecting an
 * assessee off `/` on every visit would also have swallowed the `denied=1`
 * banner, which is the only explanation a blocked person ever gets; the three
 * denial checks further down are what would have gone red. So this asserts
 * both halves: the PM LANDS on the hub, and `/` still works if they go there.
 */
{
  const ctx = await browser.newContext({ baseURL: BASE });
  const page = await ctx.newPage();
  await page.goto("/login");
  await page.fill("#email", PM.email);
  await page.fill("#password", PM.password);
  await submitAction(page, () => page.click('form button[type="submit"]:has-text("Sign in")'));
  await page.waitForLoadState("networkidle");
  check("an assessee lands on the hub at sign-in",
    new URL(page.url()).pathname === ASSESS_HUB, page.url());

  await page.goto("/");
  await page.waitForLoadState("networkidle");
  check("and `/` is still theirs to visit — no redirect, so no lost banner",
    new URL(page.url()).pathname === "/", page.url());
  await ctx.close();
}

/*
 * The role landing overrides ONLY the bare default. An explicit `next` is the
 * page someone was trying to reach before being asked to sign in, and it wins.
 *
 * Untested, this guard is free to disappear: drop `safe === "/" &&` and both
 * landing checks above stay green while every explicit destination in the app
 * silently becomes the hub.
 */
{
  const ctx = await browser.newContext({ baseURL: BASE });
  const page = await ctx.newPage();
  await page.goto("/login?next=%2Fanalysis");
  await page.fill("#email", PM.email);
  await page.fill("#password", PM.password);
  await submitAction(page, () => page.click('form button[type="submit"]:has-text("Sign in")'));
  await page.waitForLoadState("networkidle");
  check("an explicit next beats the role default",
    new URL(page.url()).pathname === "/analysis", page.url());
  await ctx.close();
}

/*
 * ...and a hostile `next` reaches nothing off-host, role branch or not.
 *
 * The tab case is the one that matters: the old inline regex admitted
 * "/\t/evil.com" because it only looked for a second slash, and the WHATWG URL
 * parser strips the tab before resolving — so the value passed as "an in-app
 * path" and then resolved to https://evil.com/. Tab is legal in an HTTP header
 * value, so it reached the wire in a Location header, on a page that had just
 * asked for a bank password.
 */
/* The payloads that DIFFERENTIATE the guard from the one it replaced.
   A /review pass measured the original four and found every one of them
   refused by the OLD inline regex too, so all four stayed green with the fix
   reverted — four ticks telling the next reader a property was covered when
   nothing was. "/\t/evil.test" is the input the comment in lib/routes.ts
   names, and "/..//evil.test" is the traversal that reopened the hole after
   the first fix. The fast, exhaustive version of this now lives in
   scripts/routes.test.mjs; these stay because they exercise the whole
   redirect path, header and browser included. */
for (const hostile of [
  "//evil.test", "/\\evil.test", "/\tevil.test", "https://evil.test",
  "/\t/evil.test", "/..//evil.test", "/foo/../..//evil.test",
]) {
  const ctx = await browser.newContext({ baseURL: BASE });
  const page = await ctx.newPage();
  await page.goto(`/login?next=${encodeURIComponent(hostile)}`);
  await page.fill("#email", PM.email);
  await page.fill("#password", PM.password);
  await submitAction(page, () => page.click('form button[type="submit"]:has-text("Sign in")'));
  await page.waitForLoadState("networkidle");
  /* ORIGIN, and only origin — that is the whole contract.
     A first draft of this also required the path not to contain the attacker's
     host, which fails on "/\tevil.test": the parser strips the tab and the
     value becomes the in-app path "/evil.test". That is a 404 on our own
     origin, not a hand-off to anyone, and asserting against it would be
     encoding a preference as a security property. What matters is that the
     browser never ends up somewhere else, which is exactly what the traversal
     payloads above would have broken before the fix. */
  check(`a hostile next (${JSON.stringify(hostile)}) never leaves the app`,
    new URL(page.url()).origin === new URL(BASE).origin, page.url());
  await ctx.close();
}

{
  const ctx = await browser.newContext({ baseURL: BASE });
  const page = await ctx.newPage();
  await page.goto("/login");
  await page.fill("#email", BOSS.email);
  await page.fill("#password", BOSS.password);
  await submitAction(page, () => page.click('form button[type="submit"]:has-text("Sign in")'));
  await page.waitForLoadState("networkidle");
  // The owner holds assessor AND assessee. They keep the console, because it
  // is the only screen carrying Review & approve. (N25 — whether one person
  // should hold both — stays open; this takes no position on it.)
  check("an assessor/admin still lands on the console",
    new URL(page.url()).pathname === "/", page.url());
  await ctx.close();
}

/*
 * A1 (eng-plan-save-latency): tokens are verified LOCALLY by signature, so
 * prove the signature is actually checked — a tampered token must bounce.
 * The session cookie is base64url JSON holding access_token; corrupt the
 * token's signature segment and the next request must land on /login.
 *
 * NOT tested here, stated rather than hidden: logout-then-replay. Under D5
 * (accepted 15-min window) a replayed token legitimately verifies until
 * expiry, so there is nothing observable to assert; and "unavailable is
 * never memoized" needs a failing database, which this suite — pointed at a
 * healthy one — cannot stage. That property is held by structure instead:
 * viewerMemo has exactly one set site, on the `ok` branch.
 */
{
  const ctx = await browser.newContext({ baseURL: BASE });
  const page = await ctx.newPage();
  await page.goto("/login");
  await page.fill("#email", PM.email);
  await page.fill("#password", PM.password);
  await submitAction(page, () => page.click('form button[type="submit"]:has-text("Sign in")'));

  const jar = await ctx.cookies();
  const auth = jar.find((c) => c.name.startsWith("sb-") && c.name.includes("auth-token"));
  check("found the session cookie to tamper with", !!auth, jar.map((c) => c.name).join(","));
  if (auth) {
    const prefix = "base64-";
    const decoded = JSON.parse(Buffer.from(auth.value.slice(prefix.length), "base64url").toString());
    const [h, p, sig] = decoded.access_token.split(".");
    // Flip the FIRST character of the signature, not the last.
    //
    // An ES256 signature is 64 bytes = 512 bits, written as 86 base64url
    // characters = 516 bits. The final character therefore carries only 2
    // significant bits and 4 that decode to nothing. Flipping 'A'↔'B' there
    // changes a padding bit and NOTHING ELSE: the decoded signature bytes are
    // identical and the token still verifies. This test did exactly that and
    // passed or failed depending on what the real signature happened to end
    // with — it looked like a flaky auth test and was a flaky assertion.
    // The first character is fully significant, so this always alters the key.
    const flipped = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
    decoded.access_token = [h, p, flipped].join(".");
    const value = prefix + Buffer.from(JSON.stringify(decoded)).toString("base64url");
    await ctx.addCookies([{ ...auth, value }]);

    await page.goto("/assess/controls");
    check("a signature-tampered token is refused, not trusted",
      page.url().includes("/login"), page.url());
  }
  await ctx.close();
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

  /* N28's OTHER half, which nothing else exercises.
     `.cols .field { margin-bottom: 0 }` is the load-bearing line: ten of the
     fifteen .field usages sit inside .cols, which is a grid whose gap already
     supplies the rhythm — and grid item margins do NOT collapse, so without
     this exception these rows would gain 16px on top of the gap and land off
     the DESIGN.md scale. Delete that line and, before this check existed, the
     whole suite still went green. */
  {
    const colsField = boss.page.locator(".cols .field").first();
    check("form rows inside a grid take their rhythm from the gap, not a margin",
      (await colsField.evaluate((el) => getComputedStyle(el).marginBottom)) === "0px",
      await colsField.evaluate((el) => getComputedStyle(el).marginBottom));

    // ...including below the fold, where .cols collapses to one column and
    // stacked rows would otherwise double up (gap + margin).
    await boss.page.setViewportSize({ width: 390, height: 844 });
    await boss.page.waitForLoadState("networkidle");
    check("and still so at 390px, where the grid folds to one column",
      (await colsField.evaluate((el) => getComputedStyle(el).marginBottom)) === "0px",
      await colsField.evaluate((el) => getComputedStyle(el).marginBottom));
    await boss.page.setViewportSize({ width: 1280, height: 900 });
  }
  // Untick everyone first: this suite must never assign a cycle to a real
  // colleague who happens to be on the allowlist (the N13 lesson).
  const boxes = boss.page.locator('input[name="assignee"]');
  for (let i = 0; i < (await boxes.count()); i++) await boxes.nth(i).setChecked(false);
  await boss.page.check(`input[name="assignee"][value="${pmId}"]`);
  await boss.page.check(`input[name="assignee"][value="${otherId}"]`);
  await submitAction(boss.page, () => boss.page.click('button:has-text("Assign selected")'));

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
  await scoreAndNext(pm.page, 3, "QA evidence line");

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

  /* N5 + N4 — tested HERE, not later: exactly one control is scored at this
     point, which is the only moment in the run where both filters have
     something in them. By the time the fixture is submitted everything is
     scored, and "not scored" would be trivially empty. */
  {
    const rows = () => pm.page.locator(".crow").count();
    await pm.page.goto("/assess/controls");
    check("unfiltered, every active control is listed", (await rows()) === 132, `${await rows()}`);

    await pm.page.goto("/assess/controls?show=todo");
    const todo = await rows();
    await pm.page.goto("/assess/controls?show=done");
    const done = await rows();
    check("the two filters partition the list exactly", todo + done === 132, `${todo} + ${done}`);
    check("one control is scored, so each filter holds something",
      done === 1 && todo === 131, `done=${done} todo=${todo}`);

    // A filter is a way of LOOKING at 132 controls, not a way of having fewer.
    // Progress is the number this screen exists to report; showing "1/1" under
    // a filter would be a lie about how much is left.
    const progress = await pm.page.locator(".progress-head").innerText();
    check("progress still reports the whole assessment under a filter",
      progress.includes("/ 132 controls scored"), JSON.stringify(progress));

    await pm.page.goto("/assess/controls?show=nonsense");
    check("an unknown filter falls back to all rather than showing nothing",
      (await rows()) === 132);

    // N4: the row's state must not rest on colour alone.
    await pm.page.goto("/assess/controls");
    const marks = await pm.page.evaluate(() => {
      const todoRow = document.querySelector(".crow-todo");
      const doneRow = document.querySelector(".crow-done");
      return {
        todoText: todoRow?.querySelector(".tick")?.textContent?.trim(),
        doneText: doneRow?.querySelector(".tick")?.textContent?.trim(),
        todoEdge: todoRow ? getComputedStyle(todoRow).borderLeftColor : null,
        doneEdge: doneRow ? getComputedStyle(doneRow).borderLeftColor : null,
      };
    });
    check("an unscored row says so in words, not only in colour",
      marks.todoText === "not scored", `${marks.todoText}`);
    check("a scored row names the level it holds", /^\u2713 /.test(marks.doneText ?? ""), `${marks.doneText}`);
    check("the two row states differ by more than a badge",
      marks.todoEdge !== marks.doneEdge, `${marks.todoEdge} vs ${marks.doneEdge}`);
  }

  /*
   * THE COMMIT RULE (eng-plan-save-ux, D9). Next is the only thing that
   * writes. Everything else — Previous, links, sign-out — leaves the pick
   * unconfirmed, and an unconfirmed pick must not survive: the PM was still
   * deciding, and a level that appears pre-selected on their return is an
   * answer the record claims they gave.
   *
   * Uses 4.3.1.5, deliberately NOT the control the earlier checks depend on,
   * and leaves it unscored — which is also what makes the assertion real.
   */
  {
    await pm.page.goto("/assess?c=4.3.1.5");
    await pm.page.check('input[name="level"][value="4"]');
    check("an unconfirmed pick says so",
      (await pm.page.locator('text=Not saved yet').count()) > 0);

    await pm.page.click('.assess-actions a:has-text("Previous")');
    await pm.page.waitForLoadState("networkidle");
    await pm.page.goto("/assess?c=4.3.1.5");
    check("Previous does not commit — the pick is cleared, not remembered",
      !(await pm.page.isChecked('input[name="level"][value="4"]')));

    const a = await assessmentOf(PM.email);
    const c5 = activeControls.find((c) => c.code === "4.3.1.5");
    const { data: row5 } = await db.from("score").select("self_level")
      .eq("assessment_id", a.id).eq("control_id", c5.id).maybeSingle();
    check("and nothing was written for it", !row5 || row5.self_level === null,
      JSON.stringify(row5));
  }

  /*
   * The banner is for FAILURES, not for work in progress. Every Next has a
   * commit in flight for a moment; if that showed the red banner, the one
   * signal that means "act on this" would fire on every click and stop
   * meaning anything. Reported by the owner against the first build.
   */
  {
    await pm.page.goto("/assess?c=4.3.1.2");
    await pm.page.check('input[name="level"][value="2"]');
    await pm.page.click('.assess-actions button:has-text("Next control")');
    // Watch across the whole commit: it must never appear, not merely be
    // absent once the commit is done.
    let seen = false;
    for (let i = 0; i < 25; i++) {
      if (await pm.page.locator(".outbox-banner").count()) { seen = true; break; }
      await new Promise((r) => setTimeout(r, 40));
    }
    check("a successful save shows no failure banner", !seen);
    const a0 = await assessmentOf(PM.email);
    const c2 = activeControls.find((c) => c.code === "4.3.1.2");
    await db.from("score").delete().eq("assessment_id", a0.id).eq("control_id", c2.id);
  }

  /*
   * SKIPPING (decision D11). Leaving a control unanswered is allowed — a PM
   * should be able to come back to a hard one — but never by accident: the
   * button says which of the two things the click will do.
   */
  {
    await pm.page.goto("/assess?c=4.3.1.3");
    check("with nothing picked, the button offers to skip",
      (await pm.page.locator('.assess-actions button:has-text("Skip for now")').count()) === 1);
    await pm.page.check('input[name="level"][value="1"]');
    check("once an answer is picked, it offers to advance instead",
      (await pm.page.locator('.assess-actions button:has-text("Next control")').count()) === 1);
  }

  /*
   * THE SHAPE OF THE WORK (D14, D18, D25). Areas -> competencies -> controls,
   * with the competence element as the unit of a sitting.
   */
  {
    await pm.page.goto("/assess/areas");
    await pm.page.waitForLoadState("networkidle");
    const cards = await pm.page.locator(".area-card").count();
    check("the way in shows the three ICB4 areas", cards === 3, `${cards}`);

    const head = await pm.page.locator(".progress-head").innerText();
    check("progress is counted in competencies, not 132 controls",
      /of\s+28\s+competencies/i.test(head), JSON.stringify(head));
    check("and it names what is next", /next:/i.test(head), JSON.stringify(head));

    // A duration is a property of the WORK — a cook time, not a prediction
    // about the reader (D15b). It answers "can I start this now?".
    check("each area states how long it takes",
      /about\s+\d+(–\d+)?\s*min/i.test(await pm.page.locator(".area-grid").innerText()));

    await pm.page.locator(".area-card").first().click();
    await pm.page.waitForURL(/\/assess\/area\//, { timeout: 10_000 }).catch(() => {});
    await pm.page.waitForSelector(".ce-row", { timeout: 10_000 }).catch(() => {});
    const rows = await pm.page.locator(".ce-row").count();
    check("an area opens its competencies", rows >= 5, `${rows}`);
    const firstRow = await pm.page.locator(".ce-row").first().innerText();
    check("each competency states its own size and duration",
      /\d+\s+controls\s+·\s+about/i.test(firstRow), firstRow);
    /* The NAME, not just the shape. The first version of this check asserted
       "N controls · about M min" and passed while every row read "4.3.1 4.3.1"
       — shapeOf was looking the competence element up by control code, so the
       name was always undefined and fell back to the code. A test that only
       checks the furniture cannot see the missing content. */
    check("and names the competency rather than repeating its code",
      /^\s*[\d.]+\s+[A-Za-z]/.test(firstRow.split("\n")[0]), firstRow.split("\n")[0]);

    /* THE BLINDING GUARD (D24). These screens are the first assessee-facing UI
       where a competence element appears, which makes them the natural place
       for someone to add a "helpful" target. Seeing the target anchors the
       self-score, and the failure is silent — no crash, just quietly worse
       data. So it is asserted, not trusted. */
    for (const url of ["/assess/areas", pm.page.url()]) {
      await pm.page.goto(url);
      const html = await pm.page.content();
      check(`no target reaches ${url.replace(BASE, "")}`,
        !/target_level|Target level|target level/i.test(html), url);
    }
  }

  /*
   * PACE (D21, D22, D28). How long each control took, why it is recorded, and
   * — the part with teeth — who is allowed to read it.
   */
  {
    await pm.page.goto("/assess/areas");
    await pm.page.waitForLoadState("networkidle");
    /* THE DISCLOSURE IS THE FEATURE, not a footnote to it. Pace is recorded to
       judge whether an assessment was taken seriously; a measurement used for
       that and not disclosed is a trap. If someone ever "tidies" this sentence
       away, the ethics of the feature change and nothing else would notice. */
    const areasText = await pm.page.locator(".section").innerText();
    check("the PM is told their pace is recorded, before they start",
      /time spent on each control is recorded/i.test(areasText));
    check("and is told they are not scored on speed",
      /nobody is scored on speed/i.test(areasText));

    // Time on control actually reaches the database.
    await pm.page.goto("/assess?c=4.3.1.4");
    await pm.page.waitForSelector(".optlist");
    await new Promise((r) => setTimeout(r, 1_200));      // spend visible time on it
    await scoreAndNext(pm.page, 3, "pace probe");
    const aP = await assessmentOf(PM.email);
    const c4 = activeControls.find((c) => c.code === "4.3.1.4");
    const { data: paced } = await db.from("score").select("dwell_ms")
      .eq("assessment_id", aP.id).eq("control_id", c4.id).maybeSingle();
    /* Skipped rather than failed when migration 0005 has not been applied: the
       code deliberately falls back to saving the answer without the timing, so
       "no column yet" is a known state, not a regression. It is reported so it
       cannot be mistaken for a pass. */
    /* Gate on a real READING, not on the column existing. `dwell_ms` can be
       present while `answered_at` is not (0005 applied in two goes), and in
       that state the code correctly saves the answer with no timing — so
       "column exists" reported a pass condition the schema could not meet. */
    if (typeof paced?.dwell_ms === "number") {
      check("time on control reaches the database", paced.dwell_ms >= 1_000,
        JSON.stringify(paced));

      /* CHANGING YOUR MIND MUST NOT REWRITE THE READING.
         The first build sent the current clock on every commit, so revisiting
         a control and changing the answer in four seconds replaced a genuine
         95-second reading with four — and that control would then be listed
         under "answered faster than the text can be read". A false accusation
         produced by the most ordinary thing a PM does on this screen, and
         precisely the failure D28 rejected the timestamp method for. */
      await pm.page.goto("/assess?c=4.3.1.4");
      await pm.page.waitForSelector(".optlist");
      // Level 2, NOT 5. The outage block further down re-answers this same
      // control with 5 and needs the pick to be a CHANGE — leaving it on 5
      // here made that commit a no-op, no answer queued, no failure banner,
      // and the suite timed out waiting for one. Fixtures share state; a level
      // is part of the fixture.
      await scoreAndNext(pm.page, 2);                  // revise, quickly
      const { data: revisedPace } = await db.from("score")
        .select("self_level, dwell_ms")
        .eq("assessment_id", aP.id).eq("control_id", c4.id).maybeSingle();
      check("a revision changes the answer", revisedPace?.self_level === 2,
        JSON.stringify(revisedPace));
      check("but keeps the original timing rather than the revisit's",
        revisedPace?.dwell_ms === paced.dwell_ms,
        `was ${paced.dwell_ms}, now ${revisedPace?.dwell_ms}`);
    } else {
      skip("time on control reaches the database",
        "migration 0005 not applied — the answer still saved, which is the fallback working");
    }

    /* AUTHORISATION, the check this block exists for. /analysis takes ?a=<id>,
       so a PM who edits the query string is one guess from reading a
       colleague's working. The route must resolve an assessee's assessment
       from the SESSION and ignore the parameter entirely. */
    /* Unconditional, deliberately. The first version of this check ran only
       `if (otherAssessment)` — and by this point in the suite OTHER's
       assessment has been withdrawn, so the one security assertion in the
       block skipped itself on every run and printed nothing. A test that
       quietly does not run is worse than no test: it occupies the space where
       someone would otherwise notice the gap.

       So: find SOMEONE ELSE's assessment, live or archived, and fall back to a
       well-formed id that belongs to nobody. Either way the assertion is the
       same and it is the one that matters — whatever `?a=` says, an assessee
       gets their OWN analysis, because the route resolves it from the session
       and never from the query string. */
    const pmId = await idOf(PM.email);
    const { data: notMine } = await db.from("assessment")
      .select("id, assessee_id").neq("assessee_id", pmId).limit(1);
    const foreignId = notMine?.[0]?.id ?? "00000000-0000-4000-8000-000000000000";
    await pm.page.goto(`/analysis?a=${foreignId}`);
    await pm.page.waitForLoadState("networkidle");
    const spied = await pm.page.locator(".section").innerText();
    check("a PM's analysis ignores ?a= entirely and shows their own",
      /how your assessment is going/i.test(spied), spied.slice(0, 200));
    check("and no other person's name reaches it",
      !spied.includes(OTHER.name) && !spied.includes(BOSS.name), spied.slice(0, 200));

    await pm.page.goto("/analysis");
    await pm.page.waitForLoadState("networkidle");
    const mine = await pm.page.locator(".section").innerText();
    check("a PM can see their own pace — nothing is hidden from the person it describes",
      /how your assessment is going/i.test(mine) && /typical time per control/i.test(mine),
      mine.slice(0, 160));
    check("the analysis reports how many answers it actually timed",
      /timed answer/i.test(mine), mine.slice(0, 300));
    check("no target reaches /analysis",
      !/target_level|Target level|target level/i.test(await pm.page.content()));
  }

  /*
   * RESUMING (decision D12, as revised, and D30).
   *
   * The rule is unchanged — come back to the control the PM was last on,
   * including one they went back to re-read, falling back to the first
   * unanswered control when there is no cookie. What moved is WHERE it is
   * answered: the menu now lands on the hub, and the hub's primary button
   * carries the resume target. So these read the button's href instead of the
   * crumb of a control page.
   *
   * They used to navigate to /assess and read `.crumb`. That page no longer
   * renders for an addressless request, and `.crumb` does not exist on the hub
   * — left unchanged, the locator would have hung to the action timeout and
   * aborted the whole suite rather than failing as a red check.
   */
  {
    /* count() FIRST, and that is not defensive noise.
       `locator.getAttribute()` on a zero-match locator does NOT return null —
       it blocks for the full action timeout and then throws, which aborts the
       suite mid-run instead of producing one red check. An earlier draft of
       this helper ended in `?? "(no button)"`, a fallback that can never be
       reached, and so reintroduced exactly the hang these rewritten checks
       exist to remove. */
    const resumeHref = async () => {
      const btn = pm.page.locator(".progress-head a.btn-primary");
      return (await btn.count()) ? (await btn.getAttribute("href")) ?? "(no href)" : "(no button)";
    };

    await pm.page.goto("/assess?c=4.3.2.2");
    await pm.page.waitForSelector(".optlist");
    await pm.page.goto(ASSESS_HUB);                      // as the menu link does
    await pm.page.waitForLoadState("networkidle");
    check("the hub resumes from the control the PM was last on",
      (await resumeHref()).includes("4.3.2.2"), await resumeHref());

    // Re-reading an ANSWERED control is a deliberate act, so it must be
    // remembered too — this is the case that separates this rule from
    // "first unanswered", which would send them back to the work instead.
    await pm.page.goto("/assess?c=4.3.1.1");
    await pm.page.waitForSelector(".optlist");
    await pm.page.goto(ASSESS_HUB);
    await pm.page.waitForLoadState("networkidle");
    check("even when that control is already answered",
      (await resumeHref()).includes("4.3.1.1"), await resumeHref());

    // No cookie (a new device) falls back to where the work is. This is the
    // only coverage of that fallback, and it is the case a PM's FIRST sitting
    // always takes — there is no cap.last yet.
    await pm.page.context().clearCookies({ name: "cap.last" });
    await pm.page.goto(ASSESS_HUB);
    await pm.page.waitForLoadState("networkidle");
    /* Asserted POSITIVELY — and this time actually so.
       The previous version carried this same comment above the negative form it
       says it rejected: `!/c=4\.3\.1\.1$/ && /c=/`, which any other href
       satisfies — the LAST unanswered control, a wrong area, anything with a
       `c=` in it. A /review pass caught the comment describing a fix that had
       never been applied, which is worse than the weak assertion alone: it
       tells the next reader the case is covered.
       So derive the expected code from the database and compare to it. A
       regression from first-unscored to last-unscored now goes red. */
    const pmAssessment = await assessmentOf(PM.email);
    const { data: pmScores } = await db.from("score")
      .select("control_id, self_level").eq("assessment_id", pmAssessment.id).limit(5000);
    const answered = new Set((pmScores ?? [])
      .filter((s) => s.self_level !== null).map((s) => s.control_id));
    const expectedFirst = activeControls.find((c) => !answered.has(c.id));
    const firstUnscored = await pm.page.evaluate(() =>
      document.querySelector(".progress-head a.btn-primary")?.getAttribute("href") ?? "");
    check("with no remembered position, it resumes at the first unanswered control",
      firstUnscored === `/assess?c=${expectedFirst.code}`,
      `${firstUnscored}, expected /assess?c=${expectedFirst?.code}`);

    // An addressless /assess is a question, not a screen (D30).
    const bookmarked = await pm.page.goto("/assess");
    await pm.page.waitForLoadState("networkidle");
    check("a bookmarked /assess redirects to the hub",
      new URL(pm.page.url()).pathname === ASSESS_HUB, pm.page.url());
    /* `bookmarked` is null when the navigation produced no new document, and
       `null?.request()` is undefined, and `undefined !== null` is TRUE — so the
       check passed itself whenever it had nothing to inspect. Require the
       response first. */
    check("...and it got there BY redirect, not by already being there",
      bookmarked !== null && bookmarked.request().redirectedFrom() !== null,
      bookmarked === null ? "no response object" : String(bookmarked.request().url()));

    /* The hub is terminal. This needs its OWN navigation: the first draft
       asserted the same expression twice with nothing in between, which is one
       extra green tick for zero coverage — the redirect loop it claims to
       guard was never exercised. */
    const direct = await pm.page.goto(ASSESS_HUB);
    await pm.page.waitForLoadState("networkidle");
    check("the hub itself does not redirect",
      new URL(pm.page.url()).pathname === ASSESS_HUB
      && direct?.request().redirectedFrom() === null, pm.page.url());
  }

  /*
   * ONE WAY IN (D30/D31). Every entry point resolves to the SAME path, compared
   * against the app's own constant rather than a literal. Three screens each
   * holding a copy of this path, drifting apart unnoticed, is the defect the
   * hub exists to fix; these are what make the fix hold.
   */
  {
    await pm.page.goto(ASSESS_HUB);
    await pm.page.waitForLoadState("networkidle");
    const navHref = await pm.page.locator('nav.nav a:has-text("Self-assessment")').getAttribute("href");
    check("the menu's Self-assessment points at the hub", navHref === ASSESS_HUB, navHref);

    // The console's own primary button — the third of the three that used to
    // disagree, and the one the first draft of these checks forgot.
    await pm.page.goto("/");
    await pm.page.waitForLoadState("networkidle");
    // Selected structurally, not by label: the button's text changes across
    // states ("Start…", "Continue… (n/132)", "View your assessment"), and a
    // text selector would silently match nothing in the states it does not
    // name — passing by finding no button at all.
    const consoleHref = await pm.page
      .locator(".card.pad a.btn-primary").first().getAttribute("href");
    check("the console's self-assessment button points at the hub",
      consoleHref === ASSESS_HUB, consoleHref);

    /* Asserted UNCONDITIONALLY, and this is deliberate.
       The first draft wrapped it in `if (await pickUp.count())`, which is the
       exact failure this suite already learned once (see the note on skip()
       above): a check that quietly removes itself still reports a green run.
       The PM's assessment is draft at this point in the suite, so the link is
       present; if it ever stops being present, that is a finding, not a
       reason to skip. */
    await pm.page.goto("/results");
    await pm.page.waitForLoadState("networkidle");
    const pickUpHref = await pm.page
      .locator('a:has-text("Pick up where you left off")').getAttribute("href");
    check("Results' pick-up link points at the hub", pickUpHref === ASSESS_HUB, pickUpHref);
  }

  /*
   * OFFLINE (decision D13). Measured before this was written: asking the
   * browser to navigate with no connection lands the PM on Chrome's own error
   * page, and the app — including the failure banner that would have
   * reassured them — is gone. So the click commits, and then declines to
   * navigate.
   */
  {
    await pm.page.goto("/assess?c=4.3.2.4");
    await pm.page.waitForSelector(".optlist");
    await pm.page.context().setOffline(true);
    await pm.page.check('input[name="level"][value="2"]');
    await pm.page.click('.assess-actions button:has-text("Next control")');
    await pm.page.waitForTimeout(1_500);

    check("going offline does not take the PM out of the app",
      (await pm.page.locator(".optlist").count()) > 0 && pm.page.url().includes("4.3.2.4"),
      pm.page.url());
    check("and it says so, app-wide",
      (await pm.page.locator("text=You are offline").count()) > 0);

    // EVERY navigation behaves the same way offline, not just Next. Guarding
    // one button and leaving the links to fail would give the same situation
    // two different outcomes depending on where the PM clicked.
    await pm.page.click('.assess-actions a:has-text("Previous")');
    await pm.page.waitForTimeout(1_000);
    check("Previous is held back too, rather than breaking the page",
      pm.page.url().includes("4.3.2.4") && (await pm.page.locator(".optlist").count()) > 0,
      pm.page.url());

    await pm.page.click(".assess-nav a");
    await pm.page.waitForTimeout(1_000);
    check("and so is the rest of the app's navigation",
      pm.page.url().includes("4.3.2.4"), pm.page.url());

    await pm.page.context().setOffline(false);
    await pm.page.evaluate(() => window.dispatchEvent(new Event("online")));
    await pm.page.waitForTimeout(2_000);
    check("the notice clears once the connection is back",
      (await pm.page.locator("text=You are offline").count()) === 0);
    await pm.page.click('.assess-actions a:has-text("Previous")');
    // A client-side navigation completes without a load event, so networkidle
    // can return while the router is still working — wait for the URL itself.
    await pm.page.waitForURL((u) => !u.href.includes("4.3.2.4"), { timeout: 10_000 })
      .catch(() => {});
    check("and navigation works again",
      !pm.page.url().includes("4.3.2.4"), pm.page.url());

    // Tidy: this test scored a control the later fixture assumptions do not expect.
    const aOff = await assessmentOf(PM.email);
    const c24 = activeControls.find((c) => c.code === "4.3.2.4");
    await db.from("score").delete().eq("assessment_id", aOff.id).eq("control_id", c24.id);
  }

  /*
   * CROSS-ACCOUNT WRITE (review finding, found by two independent passes).
   *
   * The queue outlives the page, and a server action posts with whatever
   * session cookie the browser holds NOW. Leave a tab with a failed save,
   * sign in as someone else on the same browser, and the stale tab's retry
   * would write one PM's answer into the other's assessment — authoritative
   * input to an assessor's sheet, from a person who never gave it.
   *
   * Driven directly against the action, because reproducing it through two
   * tabs is exactly the timing that makes it hard to see: the point is that
   * the SERVER refuses, whatever the client believes.
   */
  {
    const bossId = await idOf(BOSS.email);
    const a = await assessmentOf(PM.email);
    const target = activeControls.find((c) => c.code === "4.3.3.1");
    const before = await db.from("score").select("self_level")
      .eq("assessment_id", a.id).eq("control_id", target.id).maybeSingle();

    // Queue an entry stamped with the WRONG account, then let the outbox run.
    await pm.page.goto("/assess?c=4.3.3.1");
    await pm.page.waitForSelector(".optlist");
    // The mirror key only exists once something has been queued, so write it
    // directly: `cap.outbox.<userId>` is the documented shape.
    const pmId = await idOf(PM.email);
    await pm.page.evaluate(({ pm, bad }) => {
      localStorage.setItem(`cap.outbox.${pm}`, JSON.stringify([{
        control: "4.3.3.1", level: 5, evidence: null, tries: 0,
        queuedAt: Date.now(), userId: bad,
      }]));
    }, { pm: pmId, bad: bossId });
    await pm.page.reload();                 // configure() adopts the mirror and flushes
    await pm.page.waitForTimeout(3_000);

    const after = await db.from("score").select("self_level")
      .eq("assessment_id", a.id).eq("control_id", target.id).maybeSingle();
    check("an answer queued by another account is never written",
      (after.data?.self_level ?? null) === (before.data?.self_level ?? null),
      `before=${JSON.stringify(before.data)} after=${JSON.stringify(after.data)}`);
    check("and it is dropped rather than retried forever",
      (await pm.page.evaluate((pm) => localStorage.getItem(`cap.outbox.${pm}`), pmId)) === null);
  }

  /*
   * SUBMIT IS GATED ON THE QUEUE (eng-plan-save-ux, restored after review).
   * Submitting copies self_level into assessor_level and leaves draft. An
   * answer still queued at that moment loses either way — overwritten by the
   * prefill, or rejected forever by the draft-state check.
   */
  {
    await pm.page.goto("/assess/controls");
    await pm.page.waitForLoadState("networkidle");
    const gated = await pm.page.evaluate(() => !!document.querySelector("form .note"));
    check("with an empty queue the submit button is not gated by it", !gated);
  }

  /*
   * THE OUTAGE (eng-plan-save-ux). The point of the outbox is that a PM can
   * keep working through a network failure and lose nothing. Simulated by
   * aborting the server-action POST — indistinguishable, from the browser's
   * side, from the network being gone.
   *
   * Asserts the three properties the design exists for: the failure is
   * VISIBLE, it FOLLOWS the PM off the page that caused it, and the answer
   * still LANDS once the network returns.
   */
  {
    // Intercept POSTs to ANY path, not just /assess: a server action posts to
    // whatever URL the browser is currently on, so once the PM walks to
    // /results the retry posts to /results. A pattern scoped to /assess let
    // that retry through, the queue drained on its own, and the test then
    // clicked a button that had correctly disappeared.
    let offline = true;
    await pm.page.route("**/*", (route) => {
      if (offline && route.request().method() === "POST") return route.abort();
      return route.continue();
    });

    await pm.page.goto("/assess?c=4.3.1.4");
    await pm.page.check('input[name="level"][value="5"]');
    await pm.page.click('.assess-actions button:has-text("Next control")');

    await pm.page.waitForSelector(".outbox-banner", { timeout: 10_000 });
    check("a failed save is stated, with a count",
      /1 answer/.test(await pm.page.locator(".outbox-banner").innerText()),
      await pm.page.locator(".outbox-banner").innerText());

    // The navigation is a client-side push that runs BESIDE the failing write,
    // so it lands on its own schedule — wait for it rather than assuming it
    // beat the banner. What is being asserted is that it happens at all: a
    // failed save must not strand the PM on the control they just answered.
    await pm.page.waitForURL(/c=4\.3\.1\.5/, { timeout: 10_000 }).catch(() => {});
    check("and navigation still happened — the PM was not held up",
      pm.page.url().includes("c=4.3.1.5"), pm.page.url());

    // The failure must outlive the page that produced it: this is the whole
    // reason the outbox lives in the layout rather than the assess page.
    await pm.page.goto("/results");
    await pm.page.waitForSelector(".outbox-banner", { timeout: 10_000 });
    check("the warning follows the PM to another page",
      (await pm.page.locator(".outbox-banner").count()) === 1);

    offline = false;
    await pm.page.click('.outbox-banner button:has-text("Retry now")');
    await pm.page.waitForFunction(() => !document.querySelector(".outbox-banner"),
      null, { timeout: 20_000 });

    const a = await assessmentOf(PM.email);
    const c4 = activeControls.find((c) => c.code === "4.3.1.4");
    const { data: row4 } = await db.from("score").select("self_level")
      .eq("assessment_id", a.id).eq("control_id", c4.id).maybeSingle();
    check("the queued answer reaches the database once the outage ends",
      row4?.self_level === 5, JSON.stringify(row4));

    await pm.page.unroute("**/*");
    // Put the fixture back: the filter checks above assume exactly one scored
    // control, and this test just added a second.
    await db.from("score").delete().eq("assessment_id", a.id).eq("control_id", c4.id);
  }

  /*
   * Round-trip budget (eng-plan-save-latency + save-ux). The commit is now a
   * server action fired from the client with navigation running beside it, so
   * the budget is counted differently but still counted: a warm commit costs
   * THREE Supabase calls (app_user, find assessment, write) and the
   * navigation GET costs its own two — no write rides along with it.
   *
   * Re-commits 4.3.1.1 with identical values so the fixture state the filter
   * checks above depend on is untouched. Sleeps past the 2s viewer-memo TTL
   * first: within TTL a commit costs fewer, which is real but timing-
   * dependent; the steady state — a human takes >2s per control — is what
   * gets pinned. Requires E2E_SERVER_LOG; skips loudly when unset.
   */
  {
    const LOG = process.env.E2E_SERVER_LOG;
    if (LOG) {
      const { readFileSync } = await import("node:fs");
      await pm.page.goto("/assess?c=4.3.1.1");
      // A CHANGED value, deliberately: re-entering what is already saved is not
      // dirty and correctly commits nothing, which measures the navigation
      // alone. (That no-op behaviour is asserted on its own below.)
      await pm.page.check('input[name="level"][value="3"]');
      await pm.page.fill("#evidence", "QA evidence line, revised");
      await new Promise((r) => setTimeout(r, 2_200)); // past the viewer-memo TTL
      const mark = readFileSync(LOG, "utf8").length;
      const committed = pm.page.waitForResponse(
        (r) => r.request().method() === "POST", { timeout: 20_000 });
      await pm.page.click('.assess-actions button:has-text("Next control")');
      await committed;
      await pm.page.waitForLoadState("networkidle");
      await new Promise((r) => setTimeout(r, 500)); // let the server log flush
      const lines = supabaseCalls(readFileSync(LOG, "utf8").slice(mark));
      const writes = lines.filter((l) => l.includes("/rest/v1/score"));
      check("a warm commit + navigation costs 5 supabase round trips",
        lines.length === 5, `${lines.length}: ${lines.join(" | ")}`);
      check("exactly one of them is the write",
        writes.length === 1, `${writes.length}`);

      // Re-confirming an unchanged answer must not write. A PM paging back
      // through 132 controls to check their work would otherwise re-save
      // every one of them.
      await pm.page.goto("/assess?c=4.3.1.1");
      await new Promise((r) => setTimeout(r, 2_200));
      const mark2 = readFileSync(LOG, "utf8").length;
      await pm.page.click('.assess-actions button:has-text("Next control")');
      // No POST to await here — that IS the assertion. Wait for the navigation
      // instead, then give a write, if one wrongly fired, time to show up.
      await pm.page.waitForURL(/c=4\.3\.1\.2/, { timeout: 10_000 }).catch(() => {});
      await pm.page.waitForLoadState("networkidle");
      await new Promise((r) => setTimeout(r, 800));
      await new Promise((r) => setTimeout(r, 500));
      const after = readFileSync(LOG, "utf8").slice(mark2)
        .split("\n").filter((l) => l.includes("/rest/v1/score"));
      check("re-confirming an unchanged answer writes nothing",
        after.length === 0, `${after.length}`);
    } else {
      skip("the warm-save round-trip budget",
        "E2E_SERVER_LOG is unset — point it at the next-start log to assert it");
    }
  }

  /* N14: the answer and Save must be on screen without scrolling, at every
     width and on the longest control in ICB4. This is the guarantee the layout
     exists for — and it is invisible to every other test here, all of which
     drive the page through the DOM and never care where anything sits. */
  for (const [w, h] of [[390, 844], [1440, 900], [2048, 1152]]) {
    await pm.page.setViewportSize({ width: w, height: h });
    for (const code of ["4.3.1.1", "4.5.1.1"]) {
      await pm.page.goto(`/assess?c=${code}`);
      const onScreen = await pm.page.evaluate(() => {
        const r = document.querySelector('.assess-actions button').getBoundingClientRect();
        return r.top >= 0 && r.bottom <= window.innerHeight;
      });
      check(`Save is on screen without scrolling at ${w}x${h} (${code})`, onScreen);
    }
  }
  await pm.page.setViewportSize({ width: 1280, height: 900 });

  // The layout must not have bought that by widening sentences — the whole
  // point of the amendment is that --measure still caps the prose.
  await pm.page.goto("/assess?c=4.3.1.1");
  const prose = await pm.page.evaluate(() => {
    const p = document.querySelector(".lede");
    return { width: p.getBoundingClientRect().width, cap: parseFloat(getComputedStyle(p).maxWidth) };
  });
  check("prose is still capped at the reading measure, not the column width",
    prose.width <= prose.cap + 1, `${Math.round(prose.width)}px vs cap ${Math.round(prose.cap)}px`);

  await pm.page.goto("/assess/controls");
  check("submit is blocked while controls are unscored",
    await pm.page.isDisabled('button:has-text("Submit for review")'));

  // The disabled button is a courtesy; the data layer is the actual gate. Force
  // the button live and post anyway, the way a stale tab or a curl would.
  await pm.page.locator('button:has-text("Submit for review")')
    .evaluate((el) => { el.disabled = false; });
  await submitAction(pm.page, () => pm.page.click('button:has-text("Submit for review")'));
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

  /*
   * THE DEAD END THIS PREVENTS.
   *
   * Every control is answered and the PM's last position is MID-competency —
   * which is what happens to anyone who works out of order, or who skips a
   * control and circles back to it at the end. nextAfter()'s boundary branch
   * never fires for them, so they are never handed to the list that carries
   * Submit. Before the hub learned this state they arrived at 132 of 132 with
   * "Continue where you left off" pointing at a control they had already
   * answered, and no route to Submit at all.
   *
   * Answering all 132 IN ORDER would pass straight through the boundary branch
   * and prove nothing, which is why the position is set deliberately here.
   */
  await pm.page.goto("/assess?c=4.3.1.2");             // mid-CE: sets cap.last
  await pm.page.waitForSelector(".optlist");
  await pm.page.goto(ASSESS_HUB);
  await pm.page.waitForLoadState("networkidle");
  {
    const head = await pm.page.locator(".progress-head").innerText();
    check("everything scored: the hub offers Review and submit",
      /Review and submit/i.test(head), JSON.stringify(head));
    check("everything scored: the hub does NOT offer Continue",
      !/Continue where you left off/i.test(head), JSON.stringify(head));
    check("everything scored: the count says so and names no next competency",
      /28\s+of\s+28\s+competencies\s+scored/i.test(head) && !/next:/i.test(head),
      JSON.stringify(head));

    /* THE COUNTERFACTUAL — this is what makes the setup above mean something.
       The branch under test reads only `complete`, so merely setting cap.last
       proves nothing on its own. What proves it is showing that the place the
       OLD button pointed to is a dead end: the remembered control is already
       answered and carries no way to submit. The hub is the only exit, which
       is the entire claim. */
    await pm.page.goto("/assess?c=4.3.1.2");
    await pm.page.waitForSelector(".optlist");
    check("the remembered control is one they already answered",
      (await pm.page.locator('.optlist input:checked').count()) === 1,
      `${await pm.page.locator('.optlist input:checked').count()} checked`);
    check("and it offers no way to submit — this is the dead end",
      (await pm.page.locator('button:has-text("Submit for review")').count()) === 0);

    await pm.page.goto(ASSESS_HUB);
    await pm.page.waitForLoadState("networkidle");
    const href = await pm.page.locator(".progress-head a.btn-primary").getAttribute("href");
    await pm.page.goto(href);
    await pm.page.waitForLoadState("networkidle");
    // ENABLED, not merely present: a disabled Submit exists on this page while
    // the assessment is incomplete (asserted earlier), so count() > 0 passes
    // for a button nobody can press.
    check("and that button lands where Submit exists AND is pressable",
      (await pm.page.locator('button:has-text("Submit for review")').count()) > 0
      && !(await pm.page.isDisabled('button:has-text("Submit for review")')), href);
  }

  await pm.page.goto("/assess/controls");
  const text = await pm.page.locator(".progress-head").innerText();
  check("progress reads 132 / 132", text.includes("132 / 132 controls scored"), JSON.stringify(text));
  check("submit is enabled once complete",
    !(await pm.page.isDisabled('button:has-text("Submit for review")')));

  await submitAction(pm.page, () => pm.page.click('button:has-text("Submit for review")'));

  const after = await assessmentOf(PM.email);
  check("state = self_submitted", after.state === "self_submitted", after.state);
  check("completed_at stamped (the finished flag)", after.completed_at !== null);
  check("started_at preserved", after.started_at !== null);

  /* The hub is the only screen a PM lands on now, so it has to say the true
     thing here. cap.last is still set from the run above — that is precisely
     the state in which it used to invite someone to "continue" scoring that
     the control page would then refuse to accept. */
  {
    await pm.page.goto(ASSESS_HUB);
    await pm.page.waitForLoadState("networkidle");
    const head = await pm.page.locator(".progress-head").innerText();
    check("submitted: the hub does NOT offer Continue",
      !/Continue where you left off/i.test(head), JSON.stringify(head));
    check("submitted: the hub says so, and who has it",
      /submitted/i.test(head) && /head of pmo/i.test(head), JSON.stringify(head));
    check("submitted: the hub offers a read-only way back in",
      /View your answers/i.test(head), JSON.stringify(head));
  }

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

  /* The assessor's side of pace (D28). They may read anyone's, which is the
     whole point — but the screen has to say what the numbers are FOR, or a
     median gets read as a grade and someone acts on it. */
  await boss.page.goto("/analysis");
  await boss.page.waitForLoadState("networkidle");
  check("the assessor's analysis lists the people who have started",
    (await boss.page.locator(".section").innerText()).includes(PM.name));
  await boss.page.goto(`/analysis?a=${assessmentId}`);
  await boss.page.waitForLoadState("networkidle");
  const paceView = await boss.page.locator(".section").innerText();
  check("and opens one person's pace", paceView.includes(PM.name)
    && /typical time per control/i.test(paceView), paceView.slice(0, 160));
  check("pace is framed as where to look, never as a verdict",
    /not a verdict/i.test(paceView), paceView.slice(0, 300));
  check("and it is shown beside the two signals stalling cannot fake",
    /levels used/i.test(paceView) && /evidence written/i.test(paceView));

  await boss.page.goto(`/review?a=${assessmentId}`);
  await boss.page.selectOption('select[name="level:4.3.1.1"]', "5");
  await boss.page.selectOption('select[name="level:4.3.1.2"]', "0");
  await submitAction(boss.page, () => boss.page.click('button:has-text("Save revisions")'));

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
  await submitAction(boss.page, () => boss.page.click('button:has-text("Accept all remaining")'));
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
  await submitAction(boss.page, () => boss.page.click('button:has-text("Approve assessment")'));
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
  await submitAction(boss.page, () => boss.page.click('button:has-text("Approve assessment")'));

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
  /*
   * EXACT, not `>= length - 5`. The old slack existed because the snapshot was
   * routed through `targetsForProfile`, which could legitimately disagree with
   * the stored target for any control APM published a value for. That path is
   * gone (N53), so the snapshot is now `control.target_level` by construction
   * and every active control must match. Measured on both existing approvals:
   * 132/132, twice — the tolerance was never being used.
   *
   * It is not a free tightening, it is the point: at `>= 127` a regression that
   * corrupted five controls' frozen targets passed silently. 131/132 PASSES the
   * old predicate and FAILS this one, which is the whole difference.
   */
  check("snapshot equals the live targets at approval time, exactly",
    same === activeControls.length, `${same}/${activeControls.length} identical`);

  check("approval lands on results", boss.page.url().includes("/results"), boss.page.url());
  const results = await boss.page.content();
  check("results render the gap list", results.includes("CAPABILITY BY COMPETENCE ELEMENT"));
  check("health tiers carry a label, never colour alone",
    results.includes("Above target") || results.includes("Role Ready") ||
    results.includes("Minor Gap") || results.includes("Capability Deficit"));
  // The 4th tier (Above target, 2026-08-10) reaches the page unconditionally via
  // the legend — the arithmetic is unit-tested; this proves the label ships.
  check("the legend names the 4th tier, Above target", results.includes("Above target"));
  check("the 3-axis area radar renders",
    results.includes('class="arearadar"') || results.includes("Area radar"));
  check("per-area narrative lines render", results.includes('class="narrative"'));
  check("weakest control shown beside the mean", results.includes("weakest"));
  // The radar plots 0–5 levels, never percentages — the no-percentage rule holds.
  check("no percentage-of-target anywhere", !/%\s*of\s*target/i.test(results));

  await pm.page.goto("/results");
  check("PM now sees their own results", (await pm.page.content()).includes("CAPABILITY BY COMPETENCE ELEMENT"));

  /* The fourth and last hub state. cap.last is STILL set from the scoring run,
     so without a state check this is the third place a stale "Continue" would
     have appeared — this time to someone whose assessment is finished and
     approved. */
  {
    await pm.page.goto(ASSESS_HUB);
    await pm.page.waitForLoadState("networkidle");
    const head = await pm.page.locator(".progress-head").innerText();
    check("approved: the hub does NOT offer Continue",
      !/Continue where you left off/i.test(head), JSON.stringify(head));
    check("approved: the hub sends them to their results",
      /See your results/i.test(head), JSON.stringify(head));
  }
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
    .select("assessor_level, control:control_id(code, active, competence_element:ce_id(code, name, target_level))")
    .eq("assessment_id", assessmentId).limit(5000);

  const byCe = new Map();
  for (const r of rows) {
    const c = r.control;
    if (!c.active || r.assessor_level === null) continue;
    const g = byCe.get(c.competence_element.code)
      ?? { levels: [], name: c.competence_element.name, target: c.competence_element.target_level };
    g.levels.push(r.assessor_level);
    byCe.set(c.competence_element.code, g);
  }
  check("28 competence elements roll up", byCe.size === 28, `${byCe.size}`);
  check("inactive 4.3.3.1 excluded — 4.3.2 rolls up 6 controls, not 7",
    byCe.get("4.3.2").levels.length === 6, `${byCe.get("4.3.2").levels.length}`);

  await boss.page.goto(`/results?a=${assessmentId}`);
  // Rows now lead with the CE NAME (the code was dropped), so match the row's
  // first line to the name exactly, then assert the mean appears in that row.
  const shown = await boss.page.locator(".barrow").allInnerTexts();
  let matched = 0;
  for (const [, g] of byCe) {
    const mean = (g.levels.reduce((s, n) => s + n, 0) / g.levels.length).toFixed(1);
    if (shown.some((row) => row.split("\n")[0].trim() === g.name && row.includes(mean))) matched++;
  }
  check("every CE mean on the page equals mean(assessor_level over active controls)",
    matched === byCe.size, `${matched}/${byCe.size}`);

  /*
   * The TARGET column, recomputed from the database the same way (rollup-spec §3).
   * Nothing asserted this before the rule changed — the section checked the actual
   * mean only — so the number that decides every verdict on this page had no
   * coverage on the running app at all.
   *
   * This assessment is APPROVED by now, so the targets come from target_snapshot,
   * not from `control`. That is what makes this a §6 check as well as a §3 one.
   *
   * What it deliberately does NOT do: bump a live control target and assert the
   * page does not move. That would pass for an accidental reason — the framework
   * memo (10 min, per instance, invalidated only by an admin save) would hide a
   * direct database write regardless of whether the snapshot was honoured. The
   * snapshot-beats-live distinction is asserted in scripts/rollup.test.mjs, where
   * it can be tested honestly.
   */
  {
    const { data: snapRows } = await db.from("target_snapshot")
      .select("target_level, control:control_id(code, active, competence_element:ce_id(code, name))")
      .eq("assessment_id", assessmentId).limit(5000);
    const targetByCe = new Map();
    for (const s of snapRows ?? []) {
      const c = s.control;
      if (!c?.active || s.target_level === null) continue;
      const g = targetByCe.get(c.competence_element.code)
        ?? { levels: [], name: c.competence_element.name };
      g.levels.push(s.target_level);
      targetByCe.set(c.competence_element.code, g);
    }
    check("snapshot covers all 28 competence elements", targetByCe.size === 28, `${targetByCe.size}`);

    let tMatched = 0;
    const misses = [];
    for (const [code, g] of targetByCe) {
      const target = (g.levels.reduce((s, n) => s + n, 0) / g.levels.length).toFixed(1);
      // Match the row by its CE name (first line), then assert the target reads "/ <target>".
      const row = shown.find((t) => t.split("\n")[0].trim() === g.name);
      if (row && row.includes(`/ ${target}`)) tMatched++;
      else misses.push(`${code} (${g.name}) wanted / ${target}`);
    }
    check("every CE target on the page equals mean(SNAPSHOT target over active controls)",
      tMatched === targetByCe.size, `${tMatched}/${targetByCe.size} ${JSON.stringify(misses.slice(0, 3))}`);

    // A fraction must actually reach the screen, or the whole change is invisible:
    // 6 of 28 competencies have a mean their old published integer never equalled.
    const fractional = [...targetByCe.values()]
      .filter((g) => (g.levels.reduce((s, n) => s + n, 0) / g.levels.length) % 1 !== 0).length;
    check("at least one CE target is genuinely fractional, so one decimal is load-bearing",
      fractional > 0, `${fractional} of ${targetByCe.size}`);
  }

  /*
   * The escalation case, constructed on purpose (STATUS.md open item 3).
   *
   * A CE whose mean sits ABOVE its target can still read "Capability Deficit"
   * because one control is 2+ levels below its own target. On screen that looks
   * like the number and the verdict disagree, and until now nothing on the page
   * named the control responsible. Waiting for the seeded spread to produce this
   * shape would be a test that passes for an accidental reason — the exact trap
   * N21 caught — so it is built rather than hoped for.
   */
  const { data: ceRows } = await db.from("competence_element")
    .select("id, code, name, target_level, control(id, code, active, target_level, indicator)")
    .limit(200);
  /*
   * ceTarget is the MEAN of the active control targets, which is what the page
   * shows (rollup-spec §3). This used to read `ce.target_level`, the APM
   * published integer — and after the rule changed on 2026-08-08 that check went
   * on PASSING while comparing against a number no longer on screen, because the
   * constructed mean (~4.4) clears any target either way. A green check that has
   * quietly stopped asserting its own claim is worse than a missing one, so the
   * column is not read here at all.
   */
  const meanOf = (xs) => xs.reduce((s, n) => s + n, 0) / xs.length;
  const fat = (ceRows ?? [])
    .map((ce) => ({ ...ce, actives: (ce.control ?? []).filter((c) => c.active && c.target_level !== null) }))
    .filter((ce) => ce.actives.length >= 5)
    .map((ce) => ({ ...ce, ceTarget: meanOf(ce.actives.map((c) => c.target_level)) }))
    .sort((a, b) => b.actives.length - a.actives.length)[0];

  if (!fat) {
    check("a CE with 5+ active targeted controls exists to test escalation", false);
  } else {
    // Prefer a victim WITH an indicator, so the "names not codes" assertions
    // below have text to check; fall back to the first active if none has one.
    const victim = fat.actives.find((c) => c.indicator) ?? fat.actives[0];
    const low = Math.max(0, victim.target_level - 2);
    const restore = new Map();
    const { data: before } = await db.from("score")
      .select("control_id, assessor_level").eq("assessment_id", assessmentId)
      .in("control_id", fat.actives.map((c) => c.id));
    for (const r of before ?? []) restore.set(r.control_id, r.assessor_level);

    // everything at the ceiling except the victim, so the MEAN clears the target
    // and escalation is unambiguously the only thing producing the verdict
    await db.from("score").upsert(
      fat.actives.map((c) => ({
        assessment_id: assessmentId, control_id: c.id,
        assessor_level: c.id === victim.id ? low : 5,
      })),
      { onConflict: "assessment_id,control_id" },
    );

    const mean = (5 * (fat.actives.length - 1) + low) / fat.actives.length;
    check("constructed mean clears the CE target, so the badge looks contradictory",
      mean >= fat.ceTarget, `mean ${mean.toFixed(2)} vs target ${fat.ceTarget.toFixed(2)}`);

    await boss.page.goto(`/results?a=${assessmentId}`);
    // The competency row now leads with the CE NAME (codes are meaningless to a
    // PM), so locate it by name. Match the FIRST LINE exactly, not a substring:
    // the name is the row's first text node, and an exact match avoids the
    // prefix trap the old `${code} ·` anchor existed to dodge (one CE name being
    // a substring of another would otherwise grab the wrong row).
    const rows = await boss.page.locator(".barrow").allInnerTexts();
    const row = rows.find((t) => t.split("\n")[0].trim() === fat.name);
    const where = `ce ${fat.code} (${fat.name}) victim ${victim.code}: ${JSON.stringify(row ?? rows.slice(0, 2))}`;

    // The screen shows the indicator TIDIED (trailing OCR junk stripped) and
    // CLIPPED (long ones truncated with …). Both only ever touch the tail, so a
    // 30-char leading prefix of the raw indicator always survives to the row —
    // a robust, non-vacuous anchor that a control code could never satisfy.
    const vicPrefix = (victim.indicator ?? "").slice(0, 30);
    check("escalated CE still reads Capability Deficit",
      !!row && row.includes("Capability Deficit"), where);
    check("the page names the control that forced it, not just the verdict",
      !!row && row.includes("deficit driven by") && (!vicPrefix || row.includes(vicPrefix)), where);
    check("it names that control by its indicator text, not its opaque code",
      !!row && !!victim.indicator && !row.includes(victim.code), where);
    check("and states what that control scored against its own target",
      !!row && row.includes(`scored ${low} against target ${victim.target_level}`), where);

    /*
     * The capability list is grouped by area (Perspective · People · Practice),
     * each area its own section with a header — replacing the flat, gap-sorted
     * list and the development-plan table that used to sit below it.
     */
    const areaHeads = (await boss.page.locator(".cehead h4").allInnerTexts()).map((t) => t.trim());
    check("the capability list is grouped into exactly the three areas",
      areaHeads.length === 3 && ["Perspective", "People", "Practice"].every((a) => areaHeads.includes(a)),
      `heads: ${JSON.stringify(areaHeads)}`);
    // Each section must actually hold competency rows — a header with no bars
    // under it would mean the grouping dropped a whole area's results.
    const sectionCounts = await boss.page.locator(".cesection").evaluateAll(
      (secs) => secs.map((s) => s.querySelectorAll(".barrow").length),
    );
    check("every area section contains at least one competency row",
      sectionCounts.length === 3 && sectionCounts.every((n) => n > 0),
      `per-section barrow counts: ${JSON.stringify(sectionCounts)}`);

    // The note must never appear on a row that is not a deficit — otherwise it
    // is explaining a verdict that was never given.
    const stray = (await boss.page.locator(".barrow").allInnerTexts())
      .filter((t) => t.includes("deficit driven by") && !t.includes("Capability Deficit"));
    check("the explanation never appears without the verdict it explains",
      stray.length === 0, `${stray.length} stray`);

    /*
     * Two escalating controls, not one. The single-victim case above never
     * reaches the `and N more` branch, so that string shipped unexercised —
     * and a count that is off by one is exactly the kind of thing that reads
     * as authoritative on a results page and is wrong.
     */
    const second = fat.actives[1];
    const low2 = Math.max(0, second.target_level - 2);
    await db.from("score").upsert(
      fat.actives.map((c) => ({
        assessment_id: assessmentId, control_id: c.id,
        assessor_level: c.id === victim.id ? low : c.id === second.id ? low2 : 5,
      })),
      { onConflict: "assessment_id,control_id" },
    );

    await boss.page.goto(`/results?a=${assessmentId}`);
    const rows2 = await boss.page.locator(".barrow").allInnerTexts();
    const row2 = rows2.find((t) => t.split("\n")[0].trim() === fat.name);
    const where2 = `ce ${fat.code} (${fat.name}): ${JSON.stringify(row2 ?? rows2.slice(0, 2))}`;

    // Named + counted: one control is named, the rest are counted. With two
    // escalating it must say "and 1 more" — not "1 more" of a total of two,
    // and not "2 more" counting the one it already named.
    // 30-char leading prefix, same reasoning as above (tidy/clip touch only the tail).
    const prefixOf = (c) => (c.indicator ?? c.code).slice(0, 30);
    check("a second escalating control is counted, not silently dropped",
      !!row2 && row2.includes("and 1 more"), where2);
    check("the named control is still one of the escalating ones",
      !!row2 && (row2.includes(prefixOf(victim)) || row2.includes(prefixOf(second))),
      where2);

    await db.from("score").upsert(
      fat.actives.map((c) => ({
        assessment_id: assessmentId, control_id: c.id,
        assessor_level: restore.get(c.id) ?? null,
      })),
      { onConflict: "assessment_id,control_id" },
    );
  }
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
  await submitAction(boss.page, () => boss.page.click('button:has-text("Save changes")'));

  const { data: c } = await db.from("control").select("kib_note, indicator").eq("code", "4.3.1.3").single();
  check("kib_note persisted", c.kib_note === stamp, c.kib_note);
  check("ICB4 indicator untouched by the save", c.indicator && !c.indicator.includes("QA note"));
  check("edit is visible after cache invalidation",
    (await boss.page.content()).includes(stamp));

  // reason is required whenever a control is not Active/High
  await boss.page.goto("/admin?c=4.3.1.3");
  await boss.page.selectOption("#priority", "Low");
  await boss.page.fill("#reason", "");
  await submitAction(boss.page, () => boss.page.click('button:has-text("Save changes")'));
  check("a reason is required when a control is not Active/High",
    (await boss.page.content()).includes("reason is required"));

  const { error } = await db.from("control").update(original).eq("code", "4.3.1.3");
  if (error) throw new Error(`Could not restore control 4.3.1.3: ${error.message}`);
  const { data: restored } = await db.from("control").select("kib_note").eq("code", "4.3.1.3").single();
  check("seeded framework restored after the admin test",
    restored.kib_note === original.kib_note, `${restored.kib_note}`);
}

/* ------------------------- 10a. an unsaved edit must not ride between controls
 *
 * N54. The editor's fields are UNCONTROLLED (defaultChecked / defaultValue) and
 * Previous/Next navigate to /admin?c=<other> — the SAME route, so Next.js
 * soft-navigates and reconciles into the existing DOM. React applies the
 * defaults only at mount, so without a per-control remount key the input nodes
 * were reused and a target the admin CLICKED BUT NEVER SAVED appeared on the
 * next control, and back on the one they left — an uncommitted pick shown as if
 * it were the stored target. The fix keys the form on control.code.
 *
 * This is walked (clicks, not goto), because a page load re-mounts the form and
 * would hide exactly the bug: it lived on the soft-navigation path a real admin
 * takes. It also only shows on a PRODUCTION build — dev's Fast Refresh remounts
 * and masks it — which is why the local suite runs against `next start`.
 */
{
  const codeShown = () => boss.page.locator(".crumb b").last().innerText();
  const checkedTarget = async () =>
    Number(await boss.page.locator('input[name="target"]:checked').getAttribute("value"));

  await boss.page.goto("/admin?c=4.3.1.1");
  await boss.page.waitForLoadState("networkidle");
  const storedA = await checkedTarget();

  // Read the Next control's code from the DOM so the test doesn't hardcode the
  // neighbour order, and its own target straight from Postgres.
  const nextHref = await boss.page.locator('.assess-nav a[href*="c="]').first().getAttribute("href");
  const nextCode = new URL(nextHref, "http://x").searchParams.get("c");
  const { data: bRow } = await db.from("control").select("target_level").eq("code", nextCode).single();
  const storedB = bRow.target_level ?? 3; // the editor's own default when null

  // A level to click that differs from BOTH stored targets, so a leak is
  // unambiguous — not merely a value that happened to match.
  const unsaved = [0, 1, 2, 3, 4, 5].find((n) => n !== storedA && n !== storedB);

  await boss.page.click(`label[for="target-${unsaved}"]`);
  check("an unsaved target edit registers on 4.3.1.1", (await checkedTarget()) === unsaved);

  await boss.page.locator(`a[href*="c=${nextCode}"]`).first().click();
  await boss.page.waitForURL(`**/admin?c=${nextCode}*`, { timeout: 15_000 });
  await boss.page.waitForLoadState("networkidle");
  check("Next lands on the next control", (await codeShown()) === nextCode, await codeShown());
  check("the next control shows ITS OWN target, not the unsaved pick from the last",
    (await checkedTarget()) === storedB,
    `shown ${await checkedTarget()}, own ${storedB}, unsaved was ${unsaved}`);

  await boss.page.locator('a[href*="c=4.3.1.1"]').first().click();
  await boss.page.waitForURL("**/admin?c=4.3.1.1*", { timeout: 15_000 });
  await boss.page.waitForLoadState("networkidle");
  check("Previous returns to 4.3.1.1", (await codeShown()) === "4.3.1.1", await codeShown());
  check("the unsaved pick did not persist on the control it was made on",
    (await checkedTarget()) === storedA,
    `shown ${await checkedTarget()}, own ${storedA}, unsaved was ${unsaved}`);

  const { data: aAfter } = await db.from("control").select("target_level").eq("code", "4.3.1.1").single();
  check("and an unsaved edit reached Postgres for none of it",
    (aAfter.target_level ?? 3) === storedA, `${aAfter.target_level}`);
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
  await gated.page.click('form:has(#password) button[type="submit"]');
  await actionLanded(gated.page, "at least 10");
  check("a short password is refused", (await gated.page.content()).includes("at least 10"));

  await gated.page.goto("/change-password");
  await gated.page.fill("#password", qaPassword());
  await gated.page.fill("#confirm", qaPassword());   // a DIFFERENT one, hence the mismatch
  await gated.page.click('form:has(#password) button[type="submit"]');
  await actionLanded(gated.page, "do not match");
  check("mismatched passwords are refused", (await gated.page.content()).includes("do not match"));

  /* The happy path clears the flag and releases the app.
     Generated, not a literal: this value BECOMES qa.pm2's real password and the
     same block clears must_change_password, so a literal here is a fully
     working assessee login published in a public repository for as long as the
     account outlives the run. A /review pass found this and three more like it
     surviving the "fixture passwords are generated per run" change. */
  const NEWPASS = qaPassword();
  await gated.page.goto("/change-password");
  await gated.page.fill("#password", NEWPASS);
  await gated.page.fill("#confirm", NEWPASS);
  await gated.page.click('form:has(#password) button[type="submit"]');
  // The success path REDIRECTS off /change-password, so the URL is the signal.
  // There is no text to wait for — the page the user lands on is the evidence.
  await gated.page.waitForURL((u) => !u.pathname.includes("change-password"),
    { timeout: 15_000 }).catch(() => {});

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
  const ADDED_PW = qaPassword();   // becomes a real account's password
  await boss.page.fill("#password", ADDED_PW);
  await boss.page.click('button:has-text("Add person")');
  await actionLanded(boss.page, NEWMAIL);

  const { data: made } = await db.from("app_user")
    .select("id, role, must_change_password").eq("email", NEWMAIL).maybeSingle();
  // Report the ERROR BANNER, not the URL. addPersonAction renders failures in
  // the page rather than as a query parameter, so `boss.page.url()` was always
  // going to read "/admin/people" whatever went wrong — a diagnostic that could
  // only ever confirm the page it was already on. Second wrong guess at this
  // one check; the banner is where the action actually says what happened.
  const addError = await boss.page.locator(".banner-error").first()
    .textContent().catch(() => null);
  check("the person is on the allowlist", made !== null,
    addError?.trim() || "(no error banner shown)");
  check("created flagged to set their own password", made?.must_change_password === true);
  /* Checks the password ACTUALLY USED, not a literal. When the fixture
     passwords became per-run this assertion kept looking for "AddedByAdmin",
     a string that no longer exists anywhere — green forever, guarding nothing.
     Both encodings, since a URL is where this would land if it leaked. */
  check("the password is never echoed into the URL",
    !boss.page.url().includes(ADDED_PW) && !boss.page.url().includes(encodeURIComponent(ADDED_PW)),
    boss.page.url());
  check("a new person appears in the assign list, without an assessment",
    (await boss.page.locator(`input[name="assignee"][value="${made?.id}"]`).count()) === 1);

  // the account really works, and lands on the gate
  const fresh = await session(NEWMAIL, ADDED_PW);
  check("the added person can sign in", !fresh.page.url().includes("/login"), fresh.page.url());
  check("and is sent straight to set their own password",
    fresh.page.url().includes("/change-password"), fresh.page.url());
  await fresh.ctx.close();

  // duplicate is refused rather than silently creating a second identity
  await boss.page.goto("/admin/people");
  await boss.page.fill("#full_name", "QA Added Person");
  await boss.page.fill("#email", NEWMAIL);
  await boss.page.fill("#password", qaPassword());
  await boss.page.click('button:has-text("Add person")');
  await actionLanded(boss.page, "already on the allowlist");
  check("a duplicate email is refused", (await boss.page.content()).includes("already on the allowlist"));

  /* An ORPHAN: a sign-in account with no allowlist row.
     The owner hit this in production — "A user with this email address has
     already been registered" while the People list showed nobody by that name,
     and no way out of the UI. It is also the likeliest cause of the add-person
     tests failing about one run in four (N17): an interrupted run leaves
     exactly this state behind. Built deliberately here rather than waited for. */
  const ORPHAN = "qa.orphan@example.test";
  await purge(ORPHAN);
  const madeOrphan = await db.auth.admin.createUser({
    // Per-run, like every other fixture password: an orphan that survives a
    // crash must not be sign-in-able by anyone reading this file.
    email: ORPHAN, password: qaPassword(), email_confirm: true,
  });
  check("fixture: an orphaned sign-in account exists", !madeOrphan.error, madeOrphan.error?.message);
  const { data: noRow } = await db.from("app_user").select("id").eq("email", ORPHAN).maybeSingle();
  check("fixture: and it is not on the allowlist", noRow === null);

  await boss.page.goto("/admin/people");
  await boss.page.fill("#full_name", "QA Orphan Person");
  await boss.page.fill("#email", ORPHAN);
  await boss.page.fill("#job_title", "Project Manager");
  await boss.page.selectOption("#role", "assessee");
  const ORPHAN_NEW_PW = qaPassword();   // becomes the adopted account's password
  await boss.page.fill("#password", ORPHAN_NEW_PW);
  await boss.page.click('button:has-text("Add person")');
  await actionLanded(boss.page, ORPHAN);

  const { data: adopted } = await db.from("app_user")
    .select("id, must_change_password").eq("email", ORPHAN).maybeSingle();
  check("an orphaned sign-in account is adopted, not refused", adopted !== null, boss.page.url());
  check("adoption reuses the existing auth id rather than making a second identity",
    adopted?.id === madeOrphan.data?.user?.id);
  check("the adopted account still has to set its own password",
    adopted?.must_change_password === true);
  // The password the ADMIN just typed must be the one that works — otherwise
  // the admin hands over a credential that silently is not the account's.
  const orphanIn = await session(ORPHAN, ORPHAN_NEW_PW);
  check("the password the admin typed is the one that works",
    !orphanIn.page.url().includes("/login"), orphanIn.page.url());
  await orphanIn.ctx.close();
  await purge(ORPHAN);

  // admin reset re-arms the gate
  await db.from("app_user").update({ must_change_password: false }).eq("email", NEWMAIL);
  await boss.page.goto("/admin/people");
  const row = boss.page.locator("tr", { hasText: NEWMAIL });
  const RESET_PW = qaPassword();   // becomes a real account's password
  await row.locator('input[name="password"]').fill(RESET_PW);
  // The click is on a row locator, so the page has to be named explicitly.
  await submitAction(boss.page, () => row.locator('button:has-text("Reset")').click());
  const { data: afterReset } = await db.from("app_user")
    .select("must_change_password").eq("email", NEWMAIL).single();
  check("an admin reset re-arms the must-change flag", afterReset.must_change_password === true);
  const resetLogin = await session(NEWMAIL, RESET_PW);
  check("the reset password works and lands on the gate",
    resetLogin.page.url().includes("/change-password"), resetLogin.page.url());
  await resetLogin.ctx.close();

  await purge(NEWMAIL);
}

/* ----------------------------------------------------- 13. archive (N6) */
console.log("\n[13] Archive instead of destroy (PR B)");
{
  // PM's assessment is approved by now: scored, finished, timed. Exactly the
  // record a hard delete would silently take out of the headline figure.
  const before = await assessmentOf(PM.email);
  const stats = async () => {
    await boss.page.goto("/review");
    const txt = await boss.page.locator(".card.pad").first().innerText();
    return txt;
  };
  const beforeText = await stats();
  check("the approved assessment is counted before archiving",
    beforeText.includes("Median time to complete"));
  check("it is listed in the review overview",
    (await boss.page.content()).includes(PM.name));

  await boss.page.goto("/admin/people");
  const row = boss.page.locator("tr", { hasText: PM.name });
  check("a started assessment offers Archive, not Withdraw",
    (await row.locator('button:has-text("Archive")').count()) === 1
      && (await row.locator('button:has-text("Withdraw")').count()) === 0);

  // the reason is the audit trail, so it is required
  await row.locator('input[name="reason"]').fill("");
  await row.locator('input[name="reason"]').evaluate((el) => el.removeAttribute("required"));
  await row.locator('button:has-text("Archive")').click();
  await boss.page.waitForURL(/[?&](error|archived)=/);
  check("archiving without a reason is refused",
    (await boss.page.content()).includes("the reason is the audit trail"), boss.page.url());
  check("nothing was archived by the refused attempt",
    (await assessmentOf(PM.email))?.deleted_at == null);

  await boss.page.goto("/admin/people");
  await boss.page.locator("tr", { hasText: PM.name })
    .locator('input[name="reason"]').fill("QA archive test");
  await boss.page.locator("tr", { hasText: PM.name })
    .locator('button:has-text("Archive")').click();
  await boss.page.waitForURL(/[?&](error|archived)=/);

  const gone = (await db.from("assessment").select("*").eq("id", before.id).single()).data;
  check("deleted_at stamped", gone.deleted_at !== null);
  check("deleted_by records who archived it", gone.deleted_by === (await idOf(BOSS.email)));
  check("the reason is stored", gone.deleted_reason === "QA archive test");
  check("the scores survive the archive",
    ((await db.from("score").select("*", { count: "exact", head: true })
      .eq("assessment_id", before.id)).count ?? 0) > 0);
  check("the frozen targets survive too",
    ((await db.from("target_snapshot").select("*", { count: "exact", head: true })
      .eq("assessment_id", before.id)).count ?? 0) === 133);
  check("started_at and completed_at survive — the metric stays reconstructible",
    gone.started_at !== null && gone.completed_at !== null);

  await boss.page.goto("/review");
  const after = await boss.page.content();
  check("archived rows leave the review overview", !after.includes(PM.name));
  check("the completion panel states the exclusion rather than moving silently",
    after.includes("archived, excluded"), "no exclusion note on /review");

  // the assessee is told the truth, not "you were never assigned one"
  await pm.page.goto("/assess/controls");
  const seen = await pm.page.content();
  check("the assessee is told it was withdrawn, not that they were never assigned",
    seen.includes("was withdrawn") && !seen.includes("No assessment has been assigned"));
  check("the reason is shown to them", seen.includes("QA archive test"));

  /* THE SAME, ON THE HUB — which is now the only place the withdrawal notice
     on `/` sends them, and a fifth state this screen has to survive.
     Archived is not in AssessmentState; it arrives as `!mine`, before the
     `mine.row.state` read. If that guard is ever removed, the hub throws on
     null and the one destination the banner offers 500s — while the check
     above stays green, because it looks somewhere else. */
  await pm.page.goto(ASSESS_HUB);
  await pm.page.waitForLoadState("networkidle");
  const hubSeen = await pm.page.content();
  check("the hub tells a withdrawn PM the same truth",
    hubSeen.includes("was withdrawn") && !hubSeen.includes("No assessment has been assigned"));
  check("and shows them the reason there too", hubSeen.includes("QA archive test"));

  await pm.page.goto("/");
  await pm.page.waitForLoadState("networkidle");
  const banner = await pm.page.locator('a:has-text("See what that means")').getAttribute("href");
  check("the withdrawal notice points at the hub", banner === ASSESS_HUB, banner);
  await pm.page.goto("/results");
  check("archived results are not shown",
    !(await pm.page.content()).includes("CAPABILITY BY COMPETENCE ELEMENT"));

  // an archived record is frozen — still inspectable, never editable
  await boss.page.goto(`/review?a=${before.id}`);
  check("an admin can still open an archived record, and it says it is archived",
    (await boss.page.content()).includes("archived"));
  check("an archived record offers no save or approve",
    (await boss.page.locator('button:has-text("Save revisions")').count()) === 0
      && (await boss.page.locator('button:has-text("Approve assessment")').count()) === 0);
  await pm.page.goto("/assess?c=4.3.1.1");
  check("the assessee gets no scoring form on an archived assessment",
    (await pm.page.locator('input[name="level"]').count()) === 0);

  // Re-assignment must actually WORK, not merely be offered. 0001 declared
  // `unique (assessee_id, cycle)`, which an archived row still occupies — so
  // before migration 0004 the checkbox appears and the insert is refused. A
  // test that only counted the checkbox passed while the feature was broken.
  await boss.page.goto("/admin/people");
  const pmId = await idOf(PM.email);
  check("an archived person is offered for re-assignment",
    (await boss.page.locator(`input[name="assignee"][value="${pmId}"]`).count()) === 1);

  const boxes2 = boss.page.locator('input[name="assignee"]');
  for (let i = 0; i < (await boxes2.count()); i++) await boxes2.nth(i).setChecked(false);
  await boss.page.check(`input[name="assignee"][value="${pmId}"]`);
  await boss.page.click('button:has-text("Assign selected")');
  await boss.page.waitForURL(/[?&](error|assigned)=/);
  const reassigned = await assessmentOf(PM.email);
  const reassignWorked = reassigned !== null && reassigned.id !== before.id;
  check("re-assigning after an archive succeeds (needs migration 0004)",
    reassignWorked, decodeURIComponent(boss.page.url()));

  // Everything below depends on a replacement existing. Guarded rather than
  // left to throw: a suite that dies here skips its own cleanup and leaves QA
  // accounts on the live allowlist.
  if (reassignWorked) {
    check("the replacement is a fresh draft, not the archived record",
      reassigned.state === "draft" && reassigned.deleted_at === null);
    check("the archived record is still there beside its replacement",
      ((await db.from("assessment").select("*", { count: "exact", head: true })
        .eq("assessee_id", pmId).not("deleted_at", "is", null)).count ?? 0) === 1);

    // restoring while a live one exists would produce two; say so in a sentence
    await boss.page.goto("/admin/people");
    await boss.page.locator("tr", { hasText: PM.name })
      .locator('button:has-text("Restore")').click();
    await boss.page.waitForURL(/[?&](error|restored)=/);
    check("restore is refused while a live assessment exists",
      (await boss.page.content()).includes("already has a live assessment"), boss.page.url());

    // clear the replacement so the original can come back
    await boss.page.goto("/admin/people");
    await boss.page.locator("tr", { hasText: PM.name })
      .locator('button:has-text("Withdraw")').click();
    await boss.page.waitForURL(/[?&](error|withdrawn)=/);
  } else {
    console.log("  … 3 checks skipped: they need migration 0004 (see the failure above)");
  }

  // restore puts it back exactly as it was
  const stillArchived = (await db.from("assessment").select("id")
    .eq("id", before.id).not("deleted_at", "is", null).maybeSingle()).data;
  if (stillArchived) {
    await boss.page.goto("/admin/people");
    await boss.page.locator("tr", { hasText: PM.name })
      .locator('button:has-text("Restore")').click();
    await boss.page.waitForURL(/[?&](error|restored)=/);
  }
  const backAgain = await assessmentOf(PM.email);
  check("restore clears the archive", backAgain?.deleted_at === null);
  check("restore keeps the state it was archived in", backAgain?.state === "approved");
  await boss.page.goto("/review");
  check("a restored assessment is counted again",
    (await boss.page.content()).includes(PM.name));
}

/* --------------------------------------------- 14. the UX pass (PR C) */
console.log("\n[14] Mobile chrome and theme (N10, N12)");
{
  /* --- N10: how much of a phone screen is spent before any content --- */
  await pm.page.setViewportSize({ width: 390, height: 844 });
  await pm.page.goto("/assess/controls");
  const chrome = await pm.page.evaluate(() => ({
    top: Math.round(document.querySelector("main").getBoundingClientRect().top),
    overflows: document.documentElement.scrollWidth > window.innerWidth,
  }));
  check("header chrome is under a fifth of a phone screen",
    chrome.top < 844 * 0.2, `content starts at ${chrome.top}px of 844`);
  check("nothing overflows the page sideways at 390px", !chrome.overflows);

  /* --- N10: the People table reads as cards, not a sideways scroll --- */
  await boss.page.setViewportSize({ width: 390, height: 844 });
  await boss.page.goto("/admin/people");
  const table = await boss.page.evaluate(() => {
    const wrap = document.querySelector(".tablewrap");
    const td = document.querySelector(".grid.stacked tbody td");
    return {
      scrolls: wrap ? wrap.scrollWidth > wrap.clientWidth + 1 : null,
      // the ::before label is what replaces the hidden column header
      label: td ? getComputedStyle(td, "::before").content : null,
      headHidden: getComputedStyle(document.querySelector(".grid.stacked thead")).display,
    };
  });
  check("the People table stops scrolling sideways on a phone", table.scrolls === false);
  check("its column headers move into each cell", table.headHidden === "none"
    && table.label && table.label !== "none", `label=${table.label}`);
  await boss.page.setViewportSize({ width: 1280, height: 900 });

  /* --- N12: theme, against an OS that is actually set to dark --- */
  {
    // Emulating the OS setting is the only way to test the thing that matters:
    // "Light" has to WIN against a dark machine, which is exactly what a naive
    // implementation gets wrong — with only a prefers-color-scheme block and no
    // [data-theme="light"] rules, choosing Light does nothing at all.
    const ctx = await browser.newContext({ baseURL: BASE, colorScheme: "dark" });
    const page = await ctx.newPage();
    await page.goto("/login");
    await page.fill("#email", PM.email);
    await page.fill("#password", PM.password);
    await submitAction(page, () => page.click('form button[type="submit"]:has-text("Sign in")'));

    const state = () => page.evaluate(() => ({
      attr: document.documentElement.getAttribute("data-theme"),
      bg: getComputedStyle(document.body).backgroundColor,
    }));

    const auto = await state();
    check("Auto follows a dark OS", auto.attr === "system"
      && auto.bg === "rgb(14, 22, 33)", `${auto.attr} / ${auto.bg}`);

    // waitForFunction, not networkidle: a server action's re-render lands
    // AFTER the network goes quiet, so networkidle reads the old DOM. Same
    // trap as the withdraw button in section [2].
    // Count every request the click makes: the point of the client component is
    // that changing theme talks to no server at all. As a server action this
    // was a full re-render — measured at 3-4s in production, because the theme
    // lives on <html> and revalidatePath had to rebuild the whole tree.
    // Record WHAT, not just how many. A bare count told us a request happened
    // and nothing about which, and the first flake here cost a round of guessing.
    // THE FAVICON IS NOT THE APP TALKING TO A SERVER. Chromium re-requests
    // /icon.svg when <html> changes, which is browser housekeeping racing the
    // click, and counting it made this check fail on traffic that has nothing
    // to do with the theme. That is the N21 lesson with its sign flipped: a
    // verdict decided by unrelated requests is worthless in BOTH directions.
    // Excluded by path, narrowly, so a real regression — a document, an RSC
    // payload, a fetch — still names itself in the message.
    const seen = [];
    const count = (r) => {
      const path = new URL(r.url()).pathname;
      if (path === "/icon.svg" || path === "/favicon.ico") return;
      seen.push(`${r.resourceType()} ${path}`);
    };
    page.on("request", count);
    await page.click('.themetoggle button:has-text("Light")');
    await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
    page.off("request", count);
    check("changing theme makes no request to the server at all",
      seen.length === 0, seen.join(", "));
    const light = await state();
    check("Light overrides a dark OS rather than doing nothing",
      light.attr === "light" && light.bg === "rgb(244, 246, 249)", `${light.attr} / ${light.bg}`);
    check("the pressed state says which theme is on",
      (await page.getAttribute('.themetoggle button:has-text("Light")', "aria-pressed")) === "true");

    await gotoStable(page, "/assess/controls");
    check("the choice survives navigation",
      (await page.getAttribute("html", "data-theme")) === "light");

    await page.click('.themetoggle button:has-text("Auto")');
    await page.waitForFunction(() => document.documentElement.dataset.theme === "system");
    const back = await state();
    // The trap this catches: rendering `undefined` for system means React has
    // to REMOVE data-theme from <html>, which it does not reliably do after a
    // server action — the page stayed light until a hard reload.
    check("Auto hands control back to the OS immediately, without a reload",
      back.attr === "system" && back.bg === auto.bg, `${back.attr} / ${back.bg}`);

    // The cookie is the only reason the SERVER knows the choice — it is what
    // stops the next first paint flashing the wrong theme.
    await page.click('.themetoggle button:has-text("Dark")');
    await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
    await page.reload();
    check("the choice survives a full reload, so first paint is not a flash",
      (await page.getAttribute("html", "data-theme")) === "dark");

    await ctx.close();
  }

/* ------------------------------------------------- 15. prefetch cost (N21) */
console.log("\n[15] Prefetch does not cost what it cannot buy (N21)");
{
  /* Every route is force-dynamic and there is no loading.tsx, so Next has
     nothing it will render for a prefetch — measured in production, 98 of 101
     _rsc requests came back having made zero database calls. They are not free:
     each is a function invocation, and the nav fires five at once on every page
     while the controls index carries one per control. Six landing together makes
     Vercel cold-start instances to absorb them.

     This asserts the requests are gone, not that the app got faster — the
     cold-start link is a hypothesis (N21), the wasted invocations are a fact.
     It also guards the wrapper: importing next/link directly somewhere would
     quietly reintroduce them, and nothing else in the suite would notice. */
  const ctx = await browser.newContext({ baseURL: BASE });
  const page = await ctx.newPage();
  await page.goto("/login");
  await page.fill("#email", BOSS.email);
  await page.fill("#password", BOSS.password);
  await submitAction(page, () => page.click('form button[type="submit"]:has-text("Sign in")'));

  const prefetches = [];
  const watch = (req) => {
    const u = new URL(req.url());
    if (u.searchParams.has("_rsc")) prefetches.push(u.pathname);
  };
  page.on("request", watch);

  // The controls index is the worst case: the five nav links plus one link per
  // control, all rendered at once.
  await page.goto("/assess/controls");
  await page.waitForLoadState("networkidle");
  // Scroll the whole list — prefetch fires on viewport entry, so a link that is
  // never seen was never going to cost anything and would flatter the result.
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 400) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 30));
    }
  });
  await page.waitForLoadState("networkidle");
  page.off("request", watch);

  check("no link prefetches on the heaviest page, even scrolled to the bottom",
    prefetches.length === 0, `${prefetches.length}: ${[...new Set(prefetches)].join(", ")}`);

  // The links must still WORK — prefetch={false} changes when the payload is
  // fetched, never whether the navigation happens.
  await page.click('.nav a:has-text("Results")');
  await page.waitForURL(/\/results/);
  check("navigation still works with prefetching off", page.url().includes("/results"));

  await ctx.close();
}

}


/* CLEARING THE SCORES IS ITSELF A RACE, and it fails as a crash rather than a
   check. Every block below leaves the browser at a control whose answer left in
   the same breath as the navigation (D9) — that is the product — so a commit
   POST can still be on the wire when the context closes, and land AFTER the
   next block's delete. The next insert then hits the (assessment, control)
   unique index and the whole section dies with "duplicate key", ten checks
   short, on a run where nothing is wrong with the app.

   So the delete is confirmed rather than assumed. This is FIXTURE setup, not
   the step under test: the rule that a test must not await the commit applies
   to the control being exercised, and waiting here is how the previous
   sitting's writes are made to have finished before this one begins. */
async function clearScores(assessmentId) {
  for (let i = 0; i < 20; i++) {
    await db.from("score").delete().eq("assessment_id", assessmentId);
    const { count } = await db.from("score")
      .select("control_id", { count: "exact", head: true })
      .eq("assessment_id", assessmentId);
    if ((count ?? 0) === 0) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("could not clear scores — a writer is still landing rows");
}

/* ------------------------------------------- 16. the milestone, in place (N32) */
console.log("\n[16] The competency milestone (N32, N30, E1-E4)");
{
  /* A fresh PM with nothing scored, so the competency states are ours to set.
     4.3.1 "Strategy" is the first competency and has exactly five controls. */
  const CE = ["4.3.1.1", "4.3.1.2", "4.3.1.3", "4.3.1.4", "4.3.1.5"];
  const asmt = await assessmentOf(PM.email);
  const idFor = (code) => activeControls.find((c) => c.code === code).id;

  /* Captured BEFORE seed() mutates it, and restored at the end of the block.
     "Safe because nothing after [16] reads it" made this section permanently
     order-last by comment rather than by construction. */
  const { data: fixtureState } = await db.from("assessment")
    .select("state, submitted_at, approved_at").eq("id", asmt.id).single();

  const seed = async (codes) => {
    /* Back to DRAFT first. By this section the suite has already submitted and
       approved this assessment, and a locked panel has no radio to click — the
       first run of this block died in page.check with a 30s timeout rather
       than a useful failure. */
    await db.from("assessment")
      .update({ state: "draft", submitted_at: null, approved_at: null })
      .eq("id", asmt.id);
    await clearScores(asmt.id);
    if (codes.length === 0) return;
    /* UPSERT, not insert. `clearScores` confirms the table is empty, but the
       insert happens AFTER that confirmation — a commit POST still in flight
       from the previous block can land in between and trip the unique index,
       killing the section with a crash rather than a check. Overwriting is the
       right resolution: the seed is the fixture's statement of what the prior
       sitting left behind. */
    const { error } = await db.from("score").upsert(codes.map((code) => ({
      assessment_id: asmt.id, control_id: idFor(code), self_level: 3,
    })), { onConflict: "assessment_id,control_id" });
    if (error) throw new Error(`seeding failed: ${error.message}`);
  };

  const open = async (ctx, code) => {
    const page = await ctx.newPage();
    await page.goto(`/assess?c=${code}`);
    await page.waitForSelector(".optlist");
    return page;
  };

  /* --- E1/E4: the competency is legible, and so is the position in it --- */
  {
    await seed([]);
    const ctx = await browser.newContext({ baseURL: BASE, storageState: await pm.ctx.storageState() });
    const page = await open(ctx, "4.3.1.3");
    const ceEl = page.locator(".ce-name");
    check("E1: the competency line is on the page at all", (await ceEl.count()) === 1);
    const ceName = await ceEl.innerText();
    check("E1: the competency is named at heading weight, not buried in the crumb",
      /4\.3\.1\s+Strategy/.test(ceName), JSON.stringify(ceName));
    check("E4: and says where in it the PM is",
      /3\s+of\s+5\s+in this competency/i.test(ceName), JSON.stringify(ceName));
    const weight = await ceEl.evaluate((el) => Number(getComputedStyle(el).fontWeight));
    check("E1: at a weight that actually reads as a heading", weight >= 600, String(weight));
    await ctx.close();
  }

  /* --- FM1: a competency finished by SKIPPING must not claim to be complete --- */
  {
    await seed(CE.slice(0, 1));                    // 4.3.1.2-.4 skipped
    const ctx = await browser.newContext({ baseURL: BASE, storageState: await pm.ctx.storageState() });
    const page = await open(ctx, "4.3.1.5");
    await page.check('input[name="level"][value="3"]');
    const act = page.locator(".assess-actions button").first();
    check("FM1: there is an action button to read", (await act.count()) === 1);
    const label = await act.innerText();
    check("FM1: skipping leaves the competency open — no finish, no milestone",
      !/finish this competency/i.test(label), JSON.stringify(label));
    await page.click('.assess-actions button');
    await page.waitForLoadState("networkidle");
    check("FM1: and the click moves on rather than raising a milestone",
      (await page.locator(".milestone").count()) === 0, page.url());
    await ctx.close();
  }

  /* --- FM2 (N30): the answer ON SCREEN counts, before it is committed --- */
  {
    await seed(CE.slice(0, 4));                    // all but the last
    const ctx = await browser.newContext({ baseURL: BASE, storageState: await pm.ctx.storageState() });
    const page = await open(ctx, "4.3.1.5");

    const action = page.locator(".assess-actions button").first();
    check("N30: there is an action button to read", (await action.count()) === 1);
    const before = await action.innerText();
    check("N30: with nothing picked yet, the button does not promise a finish",
      !/finish this competency/i.test(before), JSON.stringify(before));

    await page.check('input[name="level"][value="4"]');
    const after = await action.innerText();
    /* THIS IS THE REGRESSION. Before the fix the label was computed from
       persisted scores only, so picking the fifth answer changed nothing and
       the button still read "Back to the list" — the same screen promising
       something different on a later visit. */
    check("N30: picking the fifth answer completes the competency, immediately",
      /finish this competency/i.test(after), JSON.stringify(after));

    const hintEl = page.locator('.note[role="status"]').first();
    check("N30: the commit hint is on screen", (await hintEl.count()) === 1);
    const hint = await hintEl.innerText();
    check("N30: and the hint names the button that is actually on screen",
      /finish this competency/i.test(hint), JSON.stringify(hint));

    /* --- the milestone itself --- */
    const committed = page.waitForResponse((r) => r.request().method() === "POST", { timeout: 20_000 });
    await page.click('.assess-actions button:has-text("Finish this competency")');
    await committed;
    await page.waitForSelector(".milestone", { timeout: 10_000 });

    check("N32: the milestone appears IN PLACE — no navigation",
      new URL(page.url()).pathname + new URL(page.url()).search === "/assess?c=4.3.1.5",
      page.url());
    const card = await page.locator(".milestone").innerText();
    check("the milestone names what was finished", /Strategy complete/i.test(card), JSON.stringify(card.slice(0, 80)));
    const rows = page.locator(".milestone-recap li");
    const rowCount = await rows.count();
    check("E3: it recaps every control in the competency", rowCount === 5, `${rowCount} rows`);
    const lastRow = rowCount ? await rows.last().innerText() : "";
    check("E3: including the answer just given, which the server has not seen yet",
      /Proficient/i.test(lastRow), JSON.stringify(lastRow));
    check("E3: and marks which one was just answered", /just now/i.test(lastRow), JSON.stringify(lastRow));
    check("it names what comes next", /4\.3\.2/.test(card), JSON.stringify(card.slice(0, 200)));
    check("E4: taking a break is offered beside continuing",
      (await page.locator('.milestone a:has-text("Take a break")').count()) === 1);
    check("every recap row is actionable while online",
      (await page.locator(".milestone-revise:disabled").count()) === 0);

    /* N14 still holds on the card that replaced the panel. */
    for (const [w, h] of [[1280, 900], [1024, 768], [390, 844]]) {
      await page.setViewportSize({ width: w, height: h });
      const cont = page.locator('.milestone button:has-text("Continue")');
      const btn = (await cont.count()) === 1 ? await cont.boundingBox() : null;
      /* DESIGN.md: 44px minimum below 1100px, where a thumb is committing. It
         was 41px — under the guideline and, worse, disagreeing with the recap
         rows on the same card, which were already 44. Found by /qa against the
         preview, not by a test, which is why there is now a test. */
      if (w < 1100) {
        check(`the milestone's Continue meets the 44px touch target at ${w}x${h}`,
          !!btn && btn.height >= 44, btn ? `${Math.round(btn.height)}px` : "no button");
      }
      check(`the milestone's Continue is on screen without scrolling at ${w}x${h}`,
        !!btn && btn.y + btn.height <= h, btn ? `bottom ${Math.round(btn.y + btn.height)} > ${h}` : "no button");
    }
    await page.setViewportSize({ width: 1280, height: 900 });

    /* Continue carries the run on, into the NEXT competency's first control. */
    await page.click('.milestone button:has-text("Continue")');
    await page.waitForSelector(".optlist");
    check("N32: Continue lands on the next competency's first UNANSWERED control",
      page.url().includes("c=4.3.2.1"), page.url());
    check("...and the milestone does not survive the move",
      (await page.locator(".milestone").count()) === 0);

    /* FM7: going back must show the control, not a second milestone. */
    await page.goBack();
    await page.waitForLoadState("networkidle");
    check("FM7: Back shows the control again, not a stale milestone",
      (await page.locator(".milestone").count()) === 0, page.url());
    await ctx.close();
  }

  /* --- N33: the WALKED path. Every other check in this section opens the last
     control with the earlier answers already in Postgres, which is the one
     arrival a PM never makes. Walking the competency broke it: the commit POST
     and the navigation GET leave together, so each render is taken before the
     previous answer lands, and the outbox drops that answer the moment the
     write is acknowledged. At 4.3.1.5 the answer to 4.3.1.4 was in neither
     place, the button read "Next control" and the milestone never rose.
     Reported by the owner from the preview: "sometimes it shows, most of the
     time it doesn't". --- */
  {
    await seed([]);
    const ctx = await browser.newContext({ baseURL: BASE, storageState: await pm.ctx.storageState() });
    const page = await open(ctx, CE[0]);

    let stalledAt = null;
    for (let i = 0; i < CE.length - 1; i++) {
      await page.waitForSelector(".optlist");
      await page.check('input[name="level"][value="3"]');
      await page.click(".assess-actions button");
      /* Caught, like every other wait in this block: if a regression raises the
         milestone EARLY the click never navigates, and a bare wait would take
         the suite down instead of naming the control it stopped on. */
      await page.waitForFunction(
        (want) => new URL(location.href).searchParams.get("c") === want,
        CE[i + 1], { timeout: 20_000 }).catch(() => { stalledAt ??= CE[i]; });
      if (stalledAt) break;
    }
    check("N33: the walk reaches the last control of the competency",
      stalledAt === null, stalledAt ? `stalled on ${stalledAt}` : "");
    await page.waitForSelector(".optlist");
    await page.check('input[name="level"][value="4"]');

    /* THE PREMISE, ASSERTED — otherwise this block can pass for the wrong
       reason and nobody would know.

       The defect needs the fourth answer to be invisible to BOTH the server
       render and the queue. On a fast local database that is what happens (the
       navigation GET completes before the commit POST is even issued, measured)
       but it is a race, and if it fell the other way this test would go green
       against a build with the fix reverted — passing because the server render
       happened to be complete, which is the seeded arrival the comment above
       says a PM never makes. So check the two halves of the premise directly:
       the write for 4.3.1.4 HAS landed (so the queue no longer holds it) and
       the render of 4.3.1.5 was taken before it (so the server did not send
       it). If either stops being true the run says INCONCLUSIVE rather than
       lying. */
    const landed = await db.from("score").select("self_level")
      .eq("assessment_id", asmt.id).eq("control_id", idFor("4.3.1.4")).maybeSingle();
    const stillQueued = await page.evaluate(() => {
      const k = Object.keys(localStorage).find((s) => s.startsWith("cap.outbox."));
      return k ? (JSON.parse(localStorage.getItem(k) || "[]")).some((e) => e.control === "4.3.1.4") : false;
    });
    const premise = landed.data?.self_level != null && !stillQueued;
    if (!premise) {
      console.log(`    ⊘ INCONCLUSIVE: N33's premise did not hold this run — 4.3.1.4 `
        + `${landed.data?.self_level == null ? "had not landed" : "landed"}, queue `
        + `${stillQueued ? "still holds it" : "is clear"}. The checks below cannot `
        + `distinguish the fix from a complete server render.`);
    }

    const walked = (await page.locator(".assess-actions button").first().innerText()).trim();
    check("N33: walking the competency reaches the fifth control as a finish, not a next",
      /finish this competency/i.test(walked), JSON.stringify(walked));

    await page.click(".assess-actions button");
    await page.waitForSelector(".milestone", { timeout: 20_000 }).catch(() => {});
    const raised = (await page.locator(".milestone").count()) === 1;
    check("N33: and the milestone rises on the walked path", raised, page.url());

    /* The recap has to show the answers the SERVER has not confirmed either —
       the same memory that fixed the count feeds the rows.

       GUARDED ON THE CARD EXISTING. The first cut of this check read the card
       into the literal string "(no milestone)" when it was absent and then
       asserted that string does not match /not answered/ — which is true, so
       the check reported GREEN on exactly the build it was written to fail
       against. Two review specialists found it independently. A negated regex
       over a sentinel is not an assertion. */
    const walkedCard = raised ? await page.locator(".milestone").innerText() : "";
    check("N33: the recap answers every row, including the ones still settling",
      raised && !/not answered/i.test(walkedCard), JSON.stringify(walkedCard.slice(0, 240)));
    /* And the LEVELS, not just the absence of a phrase: four answered at 3 and
       the last at 4, so a card that rendered but lost the client's memory fails
       here rather than passing on a technicality. */
    check("N33: and shows the levels the PM actually gave",
      raised && (walkedCard.match(/Competent/gi) ?? []).length === 4
        && /Proficient/i.test(walkedCard),
      JSON.stringify(walkedCard.slice(0, 240)));

    /* Drain before closing. The commit for 4.3.1.5 is still in flight (asserting
       the card without waiting for it is the point), and the next block deletes
       this assessment's scores within milliseconds — a late insert would land
       after that delete and leave a stray answer in a competency the E2 block
       believes is empty. Waiting AFTER the checks costs the suite nothing and
       does not await the commit the product exists to not await. */
    await page.waitForResponse((r) => r.request().method() === "POST", { timeout: 20_000 })
      .catch(() => {});
    await ctx.close();
  }

  /* --- N33b: the same walk, but the writes are FAILING and the PM reloads.
     This is the case the first cut of the N33 fix broke and no test covered:
     `answered` is module memory that a page load destroys, while the QUEUE is
     mirrored to localStorage and survives. Replacing the queue with the new map
     in the completeness chain — rather than adding it — meant four confirmed
     answers went invisible the moment the PM refreshed during an outage, which
     is the exact situation the mirror exists for. Found by review, not by a
     user, which is the only reason it is not an N-number. --- */
  {
    await seed([]);
    const ctx = await browser.newContext({ baseURL: BASE, storageState: await pm.ctx.storageState() });
    const page = await open(ctx, CE[0]);

    /* Writes fail, reads work — a write-path outage, not an offline tab. The
       run has to carry on, which is why this is a POST abort and not context
       .setOffline(). */
    await page.route("**/assess**", (route) =>
      route.request().method() === "POST" ? route.abort() : route.continue());

    for (let i = 0; i < CE.length - 1; i++) {
      await page.waitForSelector(".optlist");
      await page.check('input[name="level"][value="3"]');
      await page.click(".assess-actions button");
      await page.waitForFunction(
        (want) => new URL(location.href).searchParams.get("c") === want,
        CE[i + 1], { timeout: 20_000 }).catch(() => {});
    }
    const unsent = await db.from("score").select("control_id", { count: "exact", head: true })
      .eq("assessment_id", asmt.id);
    check("N33b: nothing reached the server — the four answers are queued only",
      (unsent.count ?? 0) === 0, String(unsent.count));

    // The reaction the mirror exists for.
    await page.reload();
    await page.waitForSelector(".optlist", { timeout: 20_000 });
    await page.check('input[name="level"][value="4"]');
    const afterReload = (await page.locator(".assess-actions button").first().innerText()).trim();
    check("N33b: after a reload mid-outage the queued answers still count",
      /finish this competency/i.test(afterReload), JSON.stringify(afterReload));

    await page.click(".assess-actions button");
    await page.waitForSelector(".milestone", { timeout: 20_000 }).catch(() => {});
    check("N33b: and the milestone still rises",
      (await page.locator(".milestone").count()) === 1, page.url());
    await ctx.close();
  }

  /* --- N33c: a REVISION must not be reported at its old level.
     Three review specialists found this independently, on the path the card
     itself advertises ("the last easy moment to change an answer"). The recap
     read `ceLevels` before the client's own memory, and the render it read was
     taken before the revision landed — so the row showed the PM the answer they
     had just replaced. The `??` order in effectiveLevel is the fix and this is
     what pins it. --- */
  {
    await seed(CE);                                   // all five at level 3
    const ctx = await browser.newContext({ baseURL: BASE, storageState: await pm.ctx.storageState() });
    const page = await open(ctx, "4.3.1.4");

    check("N33c: the control opens at its persisted level",
      await page.locator('input[name="level"][value="3"]').isChecked());
    await page.check('input[name="level"][value="5"]');   // Competent -> Expert
    await page.click('.assess-actions button');           // commit + navigate together
    await page.waitForFunction(
      () => new URL(location.href).searchParams.get("c") === "4.3.1.5",
      null, { timeout: 20_000 }).catch(() => {});
    await page.waitForSelector(".optlist");

    /* NOT "Finish this competency", which is what this asserted until N38/N40.
       The competency was already whole when the PM arrived — the revision at
       4.3.1.4 did not complete it, and neither does the click here. What the
       click DOES is show the competency back, which is the point of the rest of
       this block, so that is what the button says. The card still rises; only
       the promise on the button changed. */
    const label = (await page.locator(".assess-actions button").first().innerText()).trim();
    check("N33c: the fifth control names the review, not a finish, after a revision",
      /review this competency/i.test(label), JSON.stringify(label));
    await page.click(".assess-actions button");
    await page.waitForSelector(".milestone", { timeout: 20_000 }).catch(() => {});

    const row4 = page.locator('.milestone-recap li', { hasText: "4.3.1.4" });
    const row4Text = (await row4.count()) ? await row4.innerText() : "(no row)";
    check("N33c: the recap shows the REVISED level, not the one it replaced",
      /Expert/i.test(row4Text) && !/Competent/i.test(row4Text), JSON.stringify(row4Text));
    await page.waitForResponse((r) => r.request().method() === "POST", { timeout: 20_000 })
      .catch(() => {});
    await ctx.close();
  }

  /* --- E2: the keyboard drives a whole control, and evidence still types --- */
  {
    await seed([]);
    const ctx = await browser.newContext({ baseURL: BASE, storageState: await pm.ctx.storageState() });
    const page = await open(ctx, "4.3.1.1");

    await page.keyboard.press("4");
    check("E2: a number key picks the level",
      (await page.locator('input[name="level"][value="4"]').isChecked()), "4 not selected");

    /* The subtlety worth testing: the evidence field is one tab away, and a "3"
       typed into it must be a 3 in the text, not a silent re-score. */
    await page.fill("#evidence", "");
    await page.click("#evidence");
    await page.keyboard.type("led 3 projects");
    check("E2: typing digits in evidence does not re-score the control",
      (await page.locator('input[name="level"][value="4"]').isChecked())
      && (await page.locator("#evidence").inputValue()) === "led 3 projects",
      await page.locator("#evidence").inputValue());

    const committed = page.waitForResponse((r) => r.request().method() === "POST", { timeout: 20_000 });
    await page.locator("#evidence").blur();
    await page.keyboard.press("Enter");
    await committed;
    await page.waitForLoadState("networkidle");
    check("E2: Enter confirms and moves on", page.url().includes("c=4.3.1.2"), page.url());
    await ctx.close();
  }

  /* --- E3: a recap row goes to the control it names --- */
  {
    await seed(CE.slice(0, 4));
    const ctx = await browser.newContext({ baseURL: BASE, storageState: await pm.ctx.storageState() });
    const page = await open(ctx, "4.3.1.5");
    await page.check('input[name="level"][value="4"]');
    const committed = page.waitForResponse((r) => r.request().method() === "POST", { timeout: 20_000 });
    await page.click('.assess-actions button:has-text("Finish this competency")');
    await committed;
    await page.waitForSelector(".milestone");

    /* The rows had no coverage at all: one that rendered but navigated nowhere
       passed the whole suite. */
    const row2 = page.locator(".milestone-recap li:nth-child(2) .milestone-revise");
    check("E3: a recap row exists to click", (await row2.count()) === 1);
    await row2.click();
    await page.waitForSelector(".optlist", { timeout: 10_000 });
    check("E3: it goes to the control it names", page.url().includes("c=4.3.1.2"), page.url());
    check("E3: and the answer already given is shown, not a blank panel",
      await page.locator('input[name="level"][value="3"]').isChecked());
    await ctx.close();
  }

  /* --- the row for the control you are STANDING on dismisses the card ---
     It is always the last row, because the milestone only rises on the last
     control of a competency — so it is the answer just given and the one most
     likely to be revised. It used to push its own URL, which is a no-op, while
     `reached` stayed true because none of its effect's deps had changed. The
     most clickable row on the card did nothing. */
  {
    await seed(CE.slice(0, 4));
    const ctx = await browser.newContext({ baseURL: BASE, storageState: await pm.ctx.storageState() });
    const page = await open(ctx, "4.3.1.5");
    await page.check('input[name="level"][value="4"]');
    const committed = page.waitForResponse((r) => r.request().method() === "POST", { timeout: 20_000 });
    await page.click('.assess-actions button:has-text("Finish this competency")');
    await committed;
    await page.waitForSelector(".milestone");

    const last = page.locator(".milestone-recap li:last-child .milestone-revise");
    check("the row for the current control is present", (await last.count()) === 1);
    await last.click();
    await page.waitForSelector(".optlist", { timeout: 10_000 });
    check("clicking it returns to the panel rather than doing nothing",
      (await page.locator(".milestone").count()) === 0);
    check("…without leaving the control", page.url().includes("c=4.3.1.5"), page.url());
    check("…and the answer just given is still selected",
      await page.locator('input[name="level"][value="4"]').isChecked());
    await ctx.close();
  }

  /* --- FM3: answers still in the OUTBOX count toward the milestone ---
     The regression this section exists for. The outbox enqueues and navigates
     in the same breath, so the save POST races the next page's render; the
     first cut corrected the server's count by +1, for one control, and a PM
     answering at speed got no milestone at all. Reproduced deterministically by
     mirroring a queued answer into localStorage — which is exactly what the
     outbox does — while the tab is offline so it cannot drain. */
  {
    await seed(CE.slice(0, 3));                    // .4 queued, .5 on screen
    const ctx = await browser.newContext({ baseURL: BASE, storageState: await pm.ctx.storageState() });
    const page = await open(ctx, "4.3.1.4");

    /* THE RACE, REPRODUCED HONESTLY. Failing only the save POST leaves the
       answer in the outbox exactly as a slow network would, while GETs still
       work so the run can carry on — which is the situation the first cut got
       wrong. Seeding localStorage instead would have tested the mirror, not
       the race, and taking the tab offline would have stopped the navigation
       that puts the PM in front of the next control at all. */
    await page.route("**/assess**", (route) =>
      route.request().method() === "POST" ? route.abort() : route.continue());

    await page.check('input[name="level"][value="3"]');
    await page.click('.assess-actions button:has-text("Next control")');
    await page.waitForURL(/c=4\.3\.1\.5/, { timeout: 15_000 });
    await page.waitForSelector(".optlist");

    const { data: unsent } = await db.from("score").select("control_id")
      .eq("assessment_id", asmt.id).eq("control_id", idFor("4.3.1.4")).maybeSingle();
    check("FM3: the fourth answer really is unsent — the server has no row for it",
      unsent === null, JSON.stringify(unsent));

    const btn = page.locator(".assess-actions button").first();
    await page.check('input[name="level"][value="4"]');
    check("FM3: a queued answer counts — the button promises the finish",
      /finish this competency/i.test(await btn.innerText()), await btn.innerText());
    await btn.click();
    await page.waitForSelector(".milestone", { timeout: 10_000 });
    check("FM3: …and the milestone actually appears", (await page.locator(".milestone").count()) === 1);

    const recap = await page.locator(".milestone-recap").innerText();
    check("FM3: the queued answer reads as answered, not 'not answered'",
      !/not answered/i.test(recap), JSON.stringify(recap));

    /* A1, on the same card: the connection drops WHILE the milestone is up.
       This is the direction the first cut could not handle at all — `offline`
       was read once during render and closed over, so the card never learned
       the connection had gone and Continue stayed live all the way to Chrome's
       error page. Asserting the transition, not the initial state. */
    await ctx.setOffline(true);
    const cont = page.locator('.milestone button:has-text("Continue")');
    await page.waitForFunction(
      () => document.querySelector(".milestone button.btn-primary")?.disabled === true,
      null, { timeout: 10_000 },
    ).catch(() => {});
    check("A1: the milestone stays up — they did finish the competency",
      (await page.locator(".milestone").count()) === 1);
    check("A1: Continue goes disabled when the connection drops under it",
      (await cont.count()) === 1 && await cont.isDisabled());
    const revise = page.locator(".milestone-revise").first();
    check("A1: the recap rows are disabled too — they navigate the same way",
      (await revise.count()) === 1 && await revise.isDisabled());
    const brk = page.locator('.milestone button:has-text("Take a break")');
    check("A1: and taking a break says it cannot, rather than silently doing nothing",
      (await brk.count()) === 1 && await brk.isDisabled());
    check("A1: the card says why", /offline/i.test(await page.locator(".milestone").innerText()));

    /* A1 recovery — the half the card promises and nothing asserted. */
    await ctx.setOffline(false);
    await page.waitForFunction(
      () => !document.querySelector(".milestone button.btn-primary")?.disabled,
      null, { timeout: 10_000 },
    ).catch(() => {});
    check("A1: Continue comes back when the connection does",
      (await cont.count()) === 1 && await cont.isEnabled());
    await page.unroute("**/assess**");
    await ctx.close();
  }

  /* --- the assessment is not 'finished' because you stood on its last control --- */
  {
    /* Everything answered EXCEPT one control in an earlier competency. The PM
       then answers the very last control of the framework. Positionally that is
       the end; actually it is not, and the card must not say it is. */
    const last = activeControls[activeControls.length - 1];
    const lastCe = activeControls.filter((c) => c.ce_id === last.ce_id);
    const skipped = activeControls[0];
    const rest = activeControls.filter(
      (c) => c.code !== skipped.code && !lastCe.some((l) => l.code === c.code));
    await clearScores(asmt.id);
    await db.from("score").insert(
      [...rest, ...lastCe.slice(0, -1)].map((c) => ({
        assessment_id: asmt.id, control_id: c.id, self_level: 3,
      })));

    const ctx = await browser.newContext({ baseURL: BASE, storageState: await pm.ctx.storageState() });
    const page = await open(ctx, last.code);
    await page.check('input[name="level"][value="3"]');
    const committed = page.waitForResponse((r) => r.request().method() === "POST", { timeout: 20_000 });
    await page.click(".assess-actions button");
    await committed;
    await page.waitForSelector(".milestone", { timeout: 10_000 });
    const card = await page.locator(".milestone").innerText();
    check("a control skipped elsewhere means the card does NOT claim the assessment is done",
      !/every competency scored/i.test(card), JSON.stringify(card.slice(0, 120)));
    check("…and it says how many are still owed",
      /still need a score|needs a score/i.test(card), JSON.stringify(card.slice(0, 200)));
    await ctx.close();
  }

  /* --- FM6: N14 holds on the TALLEST card the framework can produce --- */
  {
    const byCe = new Map();
    for (const c of activeControls) byCe.set(c.ce_id, (byCe.get(c.ce_id) ?? 0) + 1);
    const [biggestCe, size] = [...byCe.entries()].sort((a, b) => b[1] - a[1])[0];
    const inCe = activeControls.filter((c) => c.ce_id === biggestCe);
    await clearScores(asmt.id);
    await db.from("score").insert(inCe.slice(0, -1).map((c) => ({
      assessment_id: asmt.id, control_id: c.id, self_level: 3,
    })));

    const ctx = await browser.newContext({ baseURL: BASE, storageState: await pm.ctx.storageState() });
    const page = await open(ctx, inCe[inCe.length - 1].code);
    await page.check('input[name="level"][value="3"]');
    const committed = page.waitForResponse((r) => r.request().method() === "POST", { timeout: 20_000 });
    await page.click(".assess-actions button");
    await committed;
    await page.waitForSelector(".milestone");
    check(`FM6: the tallest competency has ${size} controls`,
      size >= 5 && size <= 10, `${size} — expected the ICB4 maximum, 3-6`);
    for (const [w, h] of [[1280, 900], [1024, 768], [390, 844]]) {
      await page.setViewportSize({ width: w, height: h });
      const primary = page.locator(".milestone .assess-actions .btn").first();
      const box = (await primary.count()) === 1 ? await primary.boundingBox() : null;
      check(`FM6: the ${size}-control card keeps its action on screen at ${w}x${h}`,
        !!box && box.y + box.height <= h,
        box ? `bottom ${Math.round(box.y + box.height)} > ${h}` : "no action button");
    }
    await ctx.close();
  }

  /* --- FM5: time spent ON the milestone is not charged to the control --- */
  {
    await seed(CE.slice(0, 4));
    const ctx = await browser.newContext({ baseURL: BASE, storageState: await pm.ctx.storageState() });
    const page = await open(ctx, "4.3.1.5");
    await new Promise((r) => setTimeout(r, 1_500));          // read the control
    await page.check('input[name="level"][value="4"]');
    const committed = page.waitForResponse((r) => r.request().method() === "POST", { timeout: 20_000 });
    await page.click('.assess-actions button:has-text("Finish this competency")');
    await committed;
    await page.waitForSelector(".milestone");
    await new Promise((r) => setTimeout(r, 4_000));          // linger on the card
    await page.click('.milestone button:has-text("Continue")');
    await page.waitForSelector(".optlist", { timeout: 10_000 });

    const { data: row } = await db.from("score").select("dwell_ms")
      .eq("assessment_id", asmt.id).eq("control_id", idFor("4.3.1.5")).maybeSingle();
    /* The clock is read at commit, before the card exists, so four seconds of
       admiring it must not land on the control. Cheap to break silently — a
       later refactor that read the clock in `continueRun` would sail through
       every other assertion here. */
    check("FM5: dwell is the time on the CONTROL, not the time on the milestone",
      row?.dwell_ms != null && row.dwell_ms < 4_000,
      `dwell_ms=${row?.dwell_ms}`);
    await ctx.close();
  }

  /* --- E2: Enter continues from the card, and auto-repeat does not skip it --- */
  {
    await seed(CE.slice(0, 4));
    const ctx = await browser.newContext({ baseURL: BASE, storageState: await pm.ctx.storageState() });
    const page = await open(ctx, "4.3.1.5");
    await page.check('input[name="level"][value="4"]');
    // check() leaves focus on the radio, and the handler ignores anything
    // originating in a form control — as it must, so digits typed into the
    // evidence field are text rather than a silent re-score.
    await page.evaluate(() => document.activeElement?.blur());

    /* Hold Enter. The panel commits on the first keydown and the card mounts
       within a frame; without the card arming only after a keyup, the repeat
       lands on Continue and the milestone flashes past — defeating the feature
       via the keyboard support built to serve it. */
    const committed = page.waitForResponse((r) => r.request().method() === "POST", { timeout: 20_000 });
    await page.keyboard.down("Enter");
    await new Promise((r) => setTimeout(r, 600));            // OS auto-repeat window
    await committed;
    check("E2: a held Enter does not skip straight past the milestone",
      (await page.locator(".milestone").count()) === 1, page.url());
    await page.keyboard.up("Enter");

    await page.keyboard.press("Enter");
    await page.waitForSelector(".optlist", { timeout: 10_000 });
    check("E2: a fresh Enter continues the run", page.url().includes("c=4.3.2"), page.url());
    await ctx.close();
  }

  /* --- the boundary commit's round-trip cost, counted rather than assumed ---
     CLAUDE.md: "Round trips are counted, not estimated." This PR creates a
     SECOND commit shape — no navigation — on 28 of 132 commits, and the
     existing budget assertion runs mid-competency where `nextAfter` returns
     null, so it never touches this path. */
  {
    const LOG = process.env.E2E_SERVER_LOG;
    if (LOG) {
      const { readFileSync } = await import("node:fs");
      await seed(CE.slice(0, 4));
      const ctx = await browser.newContext({ baseURL: BASE, storageState: await pm.ctx.storageState() });
      const page = await open(ctx, "4.3.1.5");
      await page.check('input[name="level"][value="4"]');
      await new Promise((r) => setTimeout(r, 2_200));        // past the viewer-memo TTL
      const mark = readFileSync(LOG, "utf8").length;
      const committed = page.waitForResponse((r) => r.request().method() === "POST", { timeout: 20_000 });
      await page.click('.assess-actions button:has-text("Finish this competency")');
      await committed;
      await page.waitForSelector(".milestone");
      await new Promise((r) => setTimeout(r, 500));
      const commitLines = supabaseCalls(readFileSync(LOG, "utf8").slice(mark));
      check("a boundary commit costs 3 round trips — it navigates nowhere",
        commitLines.length === 3, `${commitLines.length}: ${commitLines.join(" | ")}`);

      /* Past the viewer-memo TTL before measuring, matching the warm-save
         budget above. Inside it Continue costs 1, not 2, because the auth call
         is still memoized — real and pleasant, but timing-dependent. The steady
         state is what gets pinned: a human who pauses on the milestone long
         enough to read the recap is past 2s by definition. */
      await new Promise((r) => setTimeout(r, 2_200));
      const mark2 = readFileSync(LOG, "utf8").length;
      await page.click('.milestone button:has-text("Continue")');
      await page.waitForSelector(".optlist", { timeout: 10_000 });
      await page.waitForLoadState("networkidle");
      await new Promise((r) => setTimeout(r, 500));
      const navLines = supabaseCalls(readFileSync(LOG, "utf8").slice(mark2));
      check("and Continue costs the navigation's 2 — 5 across the pair, as before",
        navLines.length === 2, `${navLines.length}: ${navLines.join(" | ")}`);
      await ctx.close();
    } else {
      skip("the boundary commit's round-trip budget",
        "E2E_SERVER_LOG is unset — point it at the next-start log to assert it");
    }
  }

  /* Leave the fixture as the rest of the suite expects it. The state reset in
     seed() is undone here rather than described in a comment, so appending a
     section after this one does not inherit a draft assessment. */
  await clearScores(asmt.id);
  await db.from("assessment").update({ state: fixtureState.state,
    submitted_at: fixtureState.submitted_at, approved_at: fixtureState.approved_at })
    .eq("id", asmt.id);
}

/* --------------------- 16b. the label says what the click COMPLETES (N38/N40) */
console.log("\n[16b] The button names what the click completes (N38, N40)");
{
  const CE = ["4.3.1.1", "4.3.1.2", "4.3.1.3", "4.3.1.4", "4.3.1.5"];
  const asmt = await assessmentOf(PM.email);
  const idFor = (code) => activeControls.find((c) => c.code === code).id;
  const { data: fixtureState } = await db.from("assessment")
    .select("state, submitted_at, approved_at").eq("id", asmt.id).single();

  const seed = async (codes) => {
    await db.from("assessment")
      .update({ state: "draft", submitted_at: null, approved_at: null }).eq("id", asmt.id);
    await clearScores(asmt.id);
    if (codes.length === 0) return;
    /* UPSERT, not insert. `clearScores` confirms the table is empty, but the
       insert happens AFTER that confirmation — a commit POST still in flight
       from the previous block can land in between and trip the unique index,
       killing the section with a crash rather than a check. Overwriting is the
       right resolution: the seed is the fixture's statement of what the prior
       sitting left behind. */
    const { error } = await db.from("score").upsert(codes.map((code) => ({
      assessment_id: asmt.id, control_id: idFor(code), self_level: 3,
    })), { onConflict: "assessment_id,control_id" });
    if (error) throw new Error(`seeding failed: ${error.message}`);
  };
  /* The arrow is decoration, and it is what made two equality assertions fail
     while the label itself was right. Strip it here rather than in each check. */
  const labelAt = async (page) =>
    (await page.locator(".assess-actions button").first().innerText())
      .trim().replace(/\s*→$/, "");

  /* --- N40: a hole in the MIDDLE of a competency, whose filling completes it.
     The old label read "Next control" here, because `milestone` was null for
     any control that was not positionally last. --- */
  {
    await seed(["4.3.1.1", "4.3.1.3", "4.3.1.4", "4.3.1.5"]);   // .2 is the hole
    const ctx = await browser.newContext({ baseURL: BASE, storageState: await pm.ctx.storageState() });
    const page = await ctx.newPage();
    await page.goto("/assess?c=4.3.1.2");
    await page.waitForSelector(".optlist");
    await page.check('input[name="level"][value="3"]');
    const label = await labelAt(page);
    check("N40: filling a mid-competency hole says it FINISHES the competency",
      /finish this competency/i.test(label), JSON.stringify(label));

    /* And the card rises there — the owner's consistency call: the same words
       must produce the same outcome wherever the PM is standing. */
    await page.click(".assess-actions button");
    await page.waitForSelector(".milestone", { timeout: 20_000 }).catch(() => {});
    check("N40: and the card rises mid-competency, not only at its last control",
      (await page.locator(".milestone").count()) === 1, page.url());

    /* THE MID CARD IS THE ONE PLACE `milestone.nextControl` IS NULL BY
       CONSTRUCTION, so it is the only place `canContinue` can be decided by
       `nextOwed` alone — i.e. the only place the card can end up with no
       primary action at all. Untested, that branch decides whether a PM who
       finishes a competency mid-run has any way onward. Enter as well as the
       click, because the keydown handler was re-keyed to `canContinue` here. */
    const midCont = page.locator('.milestone button:has-text("Continue")');
    check("N40: the mid-competency card offers somewhere to go",
      (await midCont.count()) === 1 && await midCont.isEnabled());
    /* TWICE. The card arms its Enter handler on a KEYUP, so the first press
       only arms it — that is the defence against a held Enter flashing straight
       past the milestone (E2), and a test that presses once tests the guard
       rather than the feature. */
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".optlist", { timeout: 20_000 }).catch(() => {});
    const midLanded = new URL(page.url()).searchParams.get("c");
    check("N40: and Enter takes the PM to a control that is actually unanswered",
      midLanded !== null && !["4.3.1.1", "4.3.1.2", "4.3.1.3", "4.3.1.4", "4.3.1.5"].includes(midLanded),
      String(midLanded));
    await ctx.close();
  }

  /* --- The owner's question: I complete a competency while holes remain
     ELSEWHERE. Label names what the click completes; Continue goes to the hole. --- */
  {
    // 4.3.1 all but its last; a hole left far away in another area
    await seed(["4.3.1.1", "4.3.1.2", "4.3.1.3", "4.3.1.4"]);
    const ctx = await browser.newContext({ baseURL: BASE, storageState: await pm.ctx.storageState() });
    const page = await ctx.newPage();
    await page.goto("/assess?c=4.3.1.5");
    await page.waitForSelector(".optlist");
    await page.check('input[name="level"][value="3"]');
    check("N38: completing a competency says so even with holes elsewhere",
      /finish this competency/i.test(await labelAt(page)), await labelAt(page));

    await page.click(".assess-actions button");
    await page.waitForSelector(".milestone", { timeout: 20_000 }).catch(() => {});
    const card = (await page.locator(".milestone").count()) === 1
      ? await page.locator(".milestone").innerText() : "";
    check("N38: and the card does NOT claim the assessment is finished",
      !/every competency scored/i.test(card), JSON.stringify(card.slice(0, 120)));

    const cont = page.locator('.milestone button:has-text("Continue")');
    check("N38: Continue is offered — there is still work to go to",
      (await cont.count()) === 1);
    /* Guarded: the suite is one sequential script, so an unconditional click
       after a failed check turns one red line into no result for everything
       after it. */
    if (await cont.count()) {
      await cont.click();
      await page.waitForSelector(".optlist", { timeout: 20_000 }).catch(() => {});
    }
    const landed = new URL(page.url()).searchParams.get("c");
    /* Against the SEEDED SET, not against "not the one we were on". 127 controls
       are unanswered in this fixture, so the weaker form passed on any landing
       at all — including the pre-change build's. */
    check("N38: and it lands on a control that is actually unanswered",
      landed !== null && !["4.3.1.1", "4.3.1.2", "4.3.1.3", "4.3.1.4"].includes(landed),
      String(landed));
    await ctx.close();
  }

  /* --- N38 proper: the LAST control of the framework with holes still open.
     This is what the owner saw: "Review before submitting" on an assessment
     that could not be submitted.

     THE FIRST CUT OF THIS BLOCK WAS VACUOUSLY GREEN and a review pass caught
     it. It seeded everything but the last control and 4.3.1.1, which leaves the
     LAST COMPETENCY whole — so the pre-change build took its `milestone &&
     ceComplete` branch and said "Finish this competency", which satisfied an
     assertion written as a disjunction. The defect lived in the OTHER branch:
     the fall-through that reads `nextControl ? "Next control" : "Review before
     submitting"`, reachable only when the last competency is NOT whole. So a
     second hole goes inside it, and the assertion is an equality. --- */
  {
    const last = activeControls[activeControls.length - 1];
    const lastCe = activeControls.filter((c) => c.ce_id === last.ce_id).map((c) => c.code);
    const holeInLastCe = lastCe[lastCe.length - 2];       // not the one we stand on
    await seed(activeControls.map((c) => c.code).filter(
      (c) => c !== last.code && c !== holeInLastCe && c !== "4.3.1.1"));
    const ctx = await browser.newContext({ baseURL: BASE, storageState: await pm.ctx.storageState() });
    const page = await ctx.newPage();
    await page.goto(`/assess?c=${last.code}`);
    await page.waitForSelector(".optlist");
    await page.check('input[name="level"][value="3"]');
    const label = await labelAt(page);
    check("N38: control 132 with its own competency incomplete does not offer a review",
      label === "Next unanswered control", JSON.stringify(label));

    /* WHICH hole: the first in framework order, not the nearest one behind.
       `owedAfter` walks forward and then wraps, and from the last control there
       is no forward — so the wrap starts at the beginning of the framework.
       That is the right answer (a PM mopping up works front to back) and it is
       worth pinning, because the obvious guess is the hole in this competency. */
    await page.click(".assess-actions button");
    await page.waitForFunction(() => new URL(location.href).searchParams.get("c") === "4.3.1.1",
      null, { timeout: 20_000 }).catch(() => {});
    const owedLanding = new URL(page.url()).searchParams.get("c");
    check("N38: and it goes to a hole rather than to a Submit the server refuses",
      [holeInLastCe, "4.3.1.1"].includes(owedLanding), `${owedLanding}`);
    check("N38: …the first one in framework order, because the list wraps",
      owedLanding === "4.3.1.1", `${owedLanding}`);
    await ctx.close();
  }

  /* --- The last hole ANYWHERE completes the assessment, wherever it sits. --- */
  {
    await seed(activeControls.map((c) => c.code).filter((c) => c !== "4.3.1.1"));
    const ctx = await browser.newContext({ baseURL: BASE, storageState: await pm.ctx.storageState() });
    const page = await ctx.newPage();
    await page.goto("/assess?c=4.3.1.1");
    await page.waitForSelector(".optlist");
    await page.check('input[name="level"][value="3"]');
    check("N38: the final hole says it completes the ASSESSMENT, not the competency",
      /complete the assessment/i.test(await labelAt(page)), await labelAt(page));
    await page.click(".assess-actions button");
    await page.waitForSelector(".milestone", { timeout: 20_000 }).catch(() => {});
    const card = (await page.locator(".milestone").count()) === 1
      ? await page.locator(".milestone").innerText() : "";
    check("N38: and the card says every competency is scored, from the count not the position",
      /every competency scored/i.test(card), JSON.stringify(card.slice(0, 120)));

    /* AND THE BUTTON THAT SAYS SUBMIT GOES WHERE SUBMIT IS. Two reviewers found
       this independently: "Review and submit →" is chosen from a COUNT, while
       its destination was `listHref`, which is POSITIONAL — the area page here,
       because 4.3.1.1 is mid-competency. A PM whose last hole sat mid-framework
       was congratulated and then dead-ended on a page with no Submit on it.
       `canContinue` is false in this state, so this is the ONLY action on the
       card. */
    const submit = page.locator('.milestone a:has-text("Review and submit")');
    check("N38: the completed card's only action is the review",
      (await submit.count()) === 1, String(await submit.count()));
    if (await submit.count()) {
      await submit.click();
      await page.waitForURL(/\/assess\/controls/, { timeout: 20_000 }).catch(() => {});
    }
    check("N38: and it lands on the one screen that carries Submit",
      new URL(page.url()).pathname === "/assess/controls", page.url());
    check("N38: with Submit actually on it",
      (await page.locator('button:has-text("Submit")').count()) >= 1);
    await ctx.close();
  }

  /* --- WALKED, not seeded onto. Every block above arrives by `page.goto` with
     prior answers inserted straight into Postgres, which is legitimate for a
     PRIOR SITTING but deletes the D9 lag — and the lag is the whole reason
     `nextOwed` has a filter. Three reviewers found the same defect in it and
     none of the seeded blocks could have: `known`/`queued` were built over the
     current competency's controls only, while `owed` spans the framework, so an
     answer given seconds ago in ANOTHER competency was invisible and Continue
     sent the PM back to it.

     So this walks. Two holes in different competencies; fill the first, take
     Continue to the second, fill that, and press Continue again. Nothing awaits
     the commit — a PM who waits is not a PM, and waiting is what hides this.

     AND THE WRITE IS SLOWED, WHICH IS THE PART THAT MAKES IT A TEST. The first
     cut of this block walked correctly and still passed against the broken
     build, because on a fast local database the first answer had landed before
     the PM reached the second hole — so the render was not lagging and the
     filter had nothing to do. The defect only exists while a write is STILL IN
     FLIGHT, so the block has to hold one there.

     DELAYED, NOT ABORTED. Aborting is the habit CLAUDE.md names: a queue that
     never drains never forgets, so it exercises the failure path and never the
     successful-but-still-settling one, which is where this defect lives. The
     route below lets every POST through, four seconds late. --- */
  {
    /* EXACTLY TWO HOLES IN THE WHOLE FRAMEWORK, and that is load-bearing.
       The first cut left the other 26 competencies unanswered, so the owed list
       anchored at the far hole filled up with the controls just after it and
       never wrapped round to the near one — the filter was handed nothing to
       get wrong, and the block passed on the broken build. With everything else
       answered, the wrap puts the near hole at the front of the list, which is
       the only arrangement in which a competency-scoped memory sends the PM
       backwards. */
    const ce2 = activeControls.filter((c) => c.code.startsWith("4.3.2.")).map((c) => c.code);
    const far = ce2[2] ?? ce2[ce2.length - 1];
    await seed(activeControls.map((c) => c.code)
      .filter((c) => c !== "4.3.1.2" && c !== far));

    const ctx = await browser.newContext({ baseURL: BASE, storageState: await pm.ctx.storageState() });
    const page = await ctx.newPage();
    await page.route("**/assess**", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      await new Promise((r) => setTimeout(r, 4000));   // succeeds, just later
      return route.continue();
    });
    await page.goto("/assess?c=4.3.1.2");
    await page.waitForSelector(".optlist");
    await page.check('input[name="level"][value="3"]');
    await page.click(".assess-actions button");            // NOT awaited — that is the product
    await page.waitForSelector(".milestone", { timeout: 20_000 }).catch(() => {});
    check("the near hole completes its competency and raises the card",
      (await page.locator(".milestone").count()) === 1, page.url());

    await page.click('.milestone button:has-text("Continue")');
    await page.waitForSelector(".optlist", { timeout: 20_000 }).catch(() => {});
    const first = new URL(page.url()).searchParams.get("c");
    check("Continue skips the control just answered and reaches the far hole",
      first === far, `${first} (wanted ${far})`);

    /* THE STEP THE SEEDED BLOCKS CANNOT REACH. This render was taken before
       4.3.1.2's write landed, so the server's owed list still names it. If the
       client's memory is competency-scoped, Continue here goes BACKWARDS to a
       control answered seconds ago — and if the outbox has since been
       acknowledged and dropped, it shows up blank. */
    await page.check('input[name="level"][value="3"]');
    await page.click(".assess-actions button");
    await page.waitForSelector(".milestone", { timeout: 20_000 }).catch(() => {});
    const cont2 = page.locator('.milestone button:has-text("Continue")');
    if (await cont2.count()) {
      await cont2.click();
      await page.waitForSelector(".optlist", { timeout: 20_000 }).catch(() => {});
    }
    const second = new URL(page.url()).searchParams.get("c");
    check("…and Continue never sends the PM back to a control they answered seconds ago",
      second !== "4.3.1.2", `${second} — went back to the hole it had already filled`);

    /* THE PREMISE, asserted rather than assumed. If the first answer HAS landed
       by now the check above is vacuous — it passes on a broken build, which is
       exactly what happened to the first cut of this block. Say so instead of
       reporting green. */
    const { count: landed } = await db.from("score")
      .select("control_id", { count: "exact", head: true })
      .eq("assessment_id", asmt.id)
      .eq("control_id", idFor("4.3.1.2"));
    check("…and the premise held: that answer really was still in flight",
      (landed ?? 0) === 0,
      "INCONCLUSIVE — the write landed before the second Continue, so the filter was never asked");
    await page.unroute("**/assess**");
    await ctx.close();
  }

  /* --- The other half of the rule, and the one that caught the first cut of
     this change out. "Finish this competency" must mean the click FINISHED
     something. A competency that was already whole when the PM opened it is not
     finished by re-reading it — so a middle control there moves on, exactly as
     it did before N40, and only the competency's END still raises the card
     (which is where a revision gets shown back to them, N33c).

     The first cut gated on "the competency is whole after this click" and
     therefore said "Finish this competency" on every control of a finished
     competency, raising the card instead of moving — which made walking a
     finished competency through the primary button impossible. --- */
  {
    await seed(CE);                                   // the whole competency, done
    const ctx = await browser.newContext({ baseURL: BASE, storageState: await pm.ctx.storageState() });
    const page = await ctx.newPage();
    await page.goto("/assess?c=4.3.1.2");             // a MIDDLE control of it
    await page.waitForSelector(".optlist");
    await page.check('input[name="level"][value="5"]');   // a revision, not a fill
    check("N40: re-reading a finished competency does not claim to finish it again",
      /next control/i.test(await labelAt(page)), await labelAt(page));

    await page.click(".assess-actions button");
    await page.waitForFunction(
      () => new URL(location.href).searchParams.get("c") === "4.3.1.3",
      null, { timeout: 20_000 }).catch(() => {});
    check("N40: it moves on, the way Next always has",
      new URL(page.url()).searchParams.get("c") === "4.3.1.3", page.url());
    check("N40: and no milestone rose on the way",
      (await page.locator(".milestone").count()) === 0);
    await ctx.close();
  }

  /* --- A REVISION COMPLETES NOTHING, and the label must not say it does.
     Review found this: with everything answered, re-opening the framework's
     last control read "Complete the assessment" — promising to complete
     something that had been complete for a week. The card still rises there
     (that is where the revised recap is shown back, N33c); what changes is the
     wording, which names what the click actually does. --- */
  {
    await seed(activeControls.map((c) => c.code));        // everything answered
    const last = activeControls[activeControls.length - 1].code;
    const ctx = await browser.newContext({ baseURL: BASE, storageState: await pm.ctx.storageState() });
    const page = await ctx.newPage();
    await page.goto(`/assess?c=${last}`);
    await page.waitForSelector(".optlist");
    await page.check('input[name="level"][value="5"]');    // a revision
    check("a revision on a finished assessment does not promise to complete it",
      (await labelAt(page)) === "Review before submitting", await labelAt(page));

    await page.click(".assess-actions button");
    await page.waitForSelector(".milestone", { timeout: 20_000 }).catch(() => {});
    check("…and the card still rises, so the revision is shown back",
      (await page.locator(".milestone").count()) === 1, page.url());
    const row = page.locator(".milestone-recap li", { hasText: last });
    check("…at the level just given, not the one it replaced",
      (await row.count()) === 1 && /Expert/i.test(await row.innerText()),
      (await row.count()) ? await row.innerText() : "(no row)");
    await ctx.close();
  }

  /* --- A competency finished mid-run must not be scolded with the whole
     framework's outstanding count. The sentence exists for the ONE positional
     illusion — standing on the last control — and a repair that gated it on
     `nextControl` fired it on every mid-competency card, because `ceContextAt`
     returns a null `nextControl` for all of them. --- */
  {
    await seed(["4.3.1.1", "4.3.1.3", "4.3.1.4", "4.3.1.5"]);   // .2 is the hole
    const ctx = await browser.newContext({ baseURL: BASE, storageState: await pm.ctx.storageState() });
    const page = await ctx.newPage();
    await page.goto("/assess?c=4.3.1.2");
    await page.waitForSelector(".optlist");
    await page.check('input[name="level"][value="3"]');
    await page.click(".assess-actions button");
    await page.waitForSelector(".milestone", { timeout: 20_000 }).catch(() => {});
    const card = await page.locator(".milestone").innerText();
    check("a mid-run milestone does not recite the whole framework's backlog",
      !/still need a score/i.test(card), JSON.stringify(card.slice(0, 160)));
    check("…it just says what was finished",
      /complete/i.test(card) && !/every competency scored/i.test(card),
      JSON.stringify(card.slice(0, 80)));
    await ctx.close();
  }

  await clearScores(asmt.id);
  await db.from("assessment").update({ state: fixtureState.state,
    submitted_at: fixtureState.submitted_at, approved_at: fixtureState.approved_at })
    .eq("id", asmt.id);
}

/* ------------------------------------- 17. the framework table (N44) */
console.log("\n[17] Framework admin opens on a table you can filter (N44)");
{
  const ctx = await browser.newContext({ baseURL: BASE, storageState: await boss.ctx.storageState() });
  const page = await ctx.newPage();

  /* ARRIVES THE WAY AN ADMIN ARRIVES — clicking the nav, not a typed URL. The
     defect was precisely that the nav landed on the single-control editor, and
     a test that went straight to /admin/controls could never have seen it. */
  await page.goto("/");
  await page.click('.nav a:has-text("Framework")');
  await page.waitForSelector(".grid tbody tr", { timeout: 20_000 });
  check("N44: the Framework nav lands on the table, not the editor",
    new URL(page.url()).pathname === "/admin/controls", page.url());

  const rows = () => page.locator(".grid tbody tr").count();
  const all = await rows();
  check("N44: every control is listed, including the inactive one",
    all === activeControls.length + 1, `${all} rows vs ${activeControls.length} active`);

  const heads = (await page.locator(".grid thead th").allInnerTexts())
    .slice(0, 5).map((h) => h.trim().toLowerCase());
  check("N44: the columns the framework is actually tuned by are present",
    ["control", "indicator", "target", "priority", "state"].every((h) => heads.includes(h)),
    heads.join("|"));

  /* The state filter, checked against the database rather than against itself:
     the framework ships exactly one inactive control. */
  await page.goto("/admin/controls?state=inactive");
  await page.waitForSelector(".grid tbody tr", { timeout: 20_000 });
  check("N44: the inactive filter finds the one inactive control",
    (await rows()) === 1, String(await rows()));

  /* Area AND state together — the combination is where a filter usually breaks,
     and the inactive control lives in Perspective, so Perspective's active count
     must be exactly one short of its total. */
  await page.goto("/admin/controls?area=Perspective");
  await page.waitForSelector(".grid tbody tr", { timeout: 20_000 });
  const persp = await rows();
  await page.goto("/admin/controls?area=Perspective&state=active");
  await page.waitForSelector(".grid tbody tr", { timeout: 20_000 });
  check("N44: area and state compose — Perspective loses exactly its inactive one",
    (await rows()) === persp - 1, `${await rows()} of ${persp}`);

  /* A competency narrows to one group, and the group is the right one. */
  await page.goto("/admin/controls?ce=4.5.2");
  await page.waitForSelector(".grid tbody tr", { timeout: 20_000 });
  const groups = await page.locator(".card.pad").count();
  check("N44: a competency filter leaves exactly its own group", groups === 1, String(groups));

  /* Nonsense in the query string shows everything rather than nothing — a
     stale bookmark or a hand-edited URL must not present an empty framework as
     if it were the truth. */
  await page.goto("/admin/controls?area=Nope&ce=9.9.9&state=maybe");
  await page.waitForSelector(".grid tbody tr", { timeout: 20_000 });
  check("N44: unknown filter values fall back to the whole framework",
    (await rows()) === all, String(await rows()));

  /* The round trip that makes the table useful: open a control, come back to
     where you were rather than to the top of 133 rows. */
  await page.goto("/admin/controls?ce=4.5.2");
  await page.waitForSelector(".grid tbody tr");
  await page.locator(".grid tbody tr .rcode").first().click();
  await page.waitForURL(/\/admin\?c=/, { timeout: 20_000 }).catch(() => {});
  check("N44: a row opens that control's editor",
    /\/admin\?c=4\.5\.2\.1/.test(page.url()), page.url());
  await page.locator(".assess-nav a").first().click();
  await page.waitForURL(/\/admin\/controls/, { timeout: 20_000 }).catch(() => {});
  await page.waitForSelector(".grid tbody tr", { timeout: 20_000 }).catch(() => {});
  check("N44: and the way back returns to the competency, not the top of the list",
    /ce=4\.5\.2/.test(page.url()) && (await rows()) === 3, `${page.url()} rows=${await rows()}`);

  /* A PM must not reach it — the framework carries every target, which is the
     one thing the assessment blinds them to. */
  const pmCtx = await browser.newContext({ baseURL: BASE, storageState: await pm.ctx.storageState() });
  const pmPage = await pmCtx.newPage();
  await pmPage.goto("/admin/controls");
  await pmPage.waitForLoadState("networkidle");
  check("N44: a PM is kept out of the framework table",
    !new URL(pmPage.url()).pathname.startsWith("/admin"), pmPage.url());
  const leaked = await pmPage.content();
  check("N44: and no target reaches their payload from it",
    !/target_level/.test(leaked));
  await pmCtx.close();
  await ctx.close();
}

/* --------------------------- 18. the admin can work the framework through */
console.log("\n[18] Framework admin: filter by target, walk it, and read it");
{
  const ctx = await browser.newContext({ baseURL: BASE, storageState: await boss.ctx.storageState() });
  const page = await ctx.newPage();
  const rows = () => page.locator(".grid tbody tr").count();

  /* The target filter, checked against the DATABASE rather than against the
     page's own chip count — a filter that agrees with its own label is not
     evidence. */
  const { data: t3 } = await db.from("control").select("code").eq("target_level", 3);
  await page.goto("/admin/controls?target=3");
  await page.waitForSelector(".grid tbody tr", { timeout: 20_000 });
  check("N46: the target filter shows exactly the controls at that target",
    (await rows()) === t3.length, `${await rows()} rows vs ${t3.length} in Postgres`);

  /* Target composes with the filters that already existed. */
  const { data: p3 } = await db.from("control")
    .select("code, competence_element!inner(competence_area!inner(name))")
    .eq("target_level", 3).eq("active", true);
  const perspective3 = p3.filter((c) => c.competence_element.competence_area.name === "Perspective");
  await page.goto("/admin/controls?area=Perspective&state=active&target=3");
  await page.waitForSelector(".grid tbody tr", { timeout: 20_000 });
  check("N46: target composes with area and state",
    (await rows()) === perspective3.length, `${await rows()} vs ${perspective3.length}`);

  /* A nonsense target must show everything, not nothing — N44's rule, which
     the new parameter has to obey too or a stale bookmark presents an empty
     framework as the truth. */
  await page.goto("/admin/controls?target=99");
  await page.waitForSelector(".grid tbody tr", { timeout: 20_000 });
  check("N46: an impossible target falls back to the whole framework",
    (await rows()) === activeControls.length + 1, String(await rows()));

  /* ---- N50: the chips ARE the data (Excel-style facets) ----
     Checked against Postgres, not against the page's own chips: a filter row
     that agrees with itself proves nothing. */
  const { data: allControls } = await db.from("control").select("target_level, priority");
  const levelsInUse = [...new Set(allControls.map((c) => c.target_level).filter((l) => l !== null))];
  const levelsUnused = [0, 1, 2, 3, 4, 5].filter((l) => !levelsInUse.includes(l));

  await page.goto("/admin/controls");
  await page.waitForSelector(".grid tbody tr", { timeout: 20_000 });
  const targetRow = page.locator(".filterbar").filter({ hasText: "Target" }).first();
  const targetChips = (await targetRow.locator(".filterchip").allInnerTexts()).join(" | ");
  check("N50: the Target row offers every level the framework actually uses",
    levelsInUse.every((l) => new RegExp(`\\b${l}\\b`).test(targetChips)), targetChips);
  check("N50: and offers no chip for a level nothing targets",
    levelsUnused.every((l) => !new RegExp(`(^|\\|)\\s*${l}\\s`).test(targetChips)),
    `unused ${levelsUnused.join(",")} vs ${targetChips}`);

  /* A level the SCALE defines but nothing uses has no chip — and must still
     answer honestly from a URL rather than silently widening to all 133. */
  if (levelsUnused.length) {
    await page.goto(`/admin/controls?target=${levelsUnused[0]}`);
    await page.waitForLoadState("domcontentloaded");
    const body = await page.locator("main").innerText();
    check("N50: a defined-but-unused level answers 'no controls match', not everything",
      /No controls match/.test(body), body.slice(0, 120));
  } else {
    skip("the defined-but-unused level check", "every scale level is in use");
  }

  /* A level the scale does NOT define is nonsense and falls back (N44's rule). */
  await page.goto("/admin/controls?target=98");
  await page.waitForSelector(".grid tbody tr", { timeout: 20_000 });
  check("N50: a level the scale does not define still falls back to everything",
    (await rows()) === activeControls.length + 1, String(await rows()));

  /* Priority — a column with no definition table, so the data is the only
     vocabulary there is. */
  const prioritiesInUse = [...new Set(allControls.map((c) => c.priority).filter(Boolean))];
  await page.goto("/admin/controls");
  await page.waitForSelector(".grid tbody tr", { timeout: 20_000 });
  const prioRow = page.locator(".filterbar").filter({ hasText: "Priority" }).first();
  const prioChips = (await prioRow.locator(".filterchip").allInnerTexts()).join(" | ");
  check("N50: the Priority row offers exactly the priorities in use",
    prioritiesInUse.every((p) => prioChips.includes(p)), `${prioritiesInUse.join(",")} vs ${prioChips}`);

  const firstPrio = prioritiesInUse[0];
  const prioCount = allControls.filter((c) => c.priority === firstPrio).length;
  await page.goto(`/admin/controls?priority=${encodeURIComponent(firstPrio)}`);
  await page.waitForSelector(".grid tbody tr", { timeout: 20_000 });
  check("N50: the priority filter matches the database",
    (await rows()) === prioCount, `${await rows()} vs ${prioCount} at ${firstPrio}`);

  /* THE WALK. Open the first row of a filtered view and press Next twice; the
     admin must stay inside the filtered set and never be handed a control the
     view does not contain. This is the check that fails if the editor ever
     grows its own copy of the filter. */
  await page.goto("/admin/controls?area=Perspective&target=3");
  await page.waitForSelector(".grid tbody tr", { timeout: 20_000 });
  const expected = await page.locator(".grid tbody tr .rcode").allInnerTexts();
  await page.locator(".grid tbody tr .rcode").first().click();
  await page.waitForURL(/\/admin\?c=/, { timeout: 20_000 }).catch(() => {});
  check("N46: the row opens the editor with the filter still on the URL",
    /area=Perspective/.test(page.url()) && /target=3/.test(page.url()), page.url());

  /* Scoped to the SECOND nav row — the first one holds "← back to the list",
     which also contains an arrow. A looser selector would click the way out
     and the walk would silently be testing the back button. */
  const stepper = page.locator(".assess-nav").nth(1);
  const codeNow = () => new URL(page.url()).searchParams.get("c");
  /* WAIT FOR THE CODE TO CHANGE, not for the URL to match `/admin?c=`.
     The page is ALREADY on a URL matching that pattern, so `waitForURL` with it
     resolves instantly and the assertion then reads the control we started
     from. That is how the first cut of this check reported the walk as
     4.3.1.2 → 4.3.1.2 → 4.3.1.4: two clicks, one recorded move, and a failure
     that looked like the app had skipped a row. */
  const stepTo = async (link, from) => {
    await link.click();
    await page.waitForFunction(
      (prev) => new URL(location.href).searchParams.get("c") !== prev,
      from, { timeout: 20_000 },
    ).catch(() => {});
    return codeNow();
  };

  const walked = [codeNow()];
  for (let step = 0; step < 2; step++) {
    const next = stepper.locator('a:has-text("→")');
    if (!(await next.count())) break;
    walked.push(await stepTo(next, walked[walked.length - 1]));
  }
  check("N46: Next walks the filtered view in the order the table showed it",
    walked.length > 1 && walked.every((c, i) => c === expected[i]),
    `walked ${walked.join(",")} vs table ${expected.slice(0, walked.length).join(",")}`);
  check("N46: and never leaves the filtered set",
    walked.every((c) => expected.includes(c)), walked.join(","));

  /* Previous comes back to where Next came from. */
  const before = codeNow();
  const back = await stepTo(stepper.locator('a:has-text("←")'), before);
  check("N46: Previous returns to the control Next came from",
    back === walked[walked.length - 2], `${back} after ${before}, walked ${walked.join(",")}`);

  /* THE REASON FIELD IS A TEXTAREA, and the whole reason is readable.
     The owner's report was that a two-sentence justification showed as forty
     clipped characters, so this asserts the ELEMENT, not just that a value
     round-trips — an <input> would pass a value check and still be the bug. */
  await page.goto("/admin?c=4.3.1.3");
  await page.waitForSelector("#reason", { timeout: 20_000 });
  const reasonTag = await page.locator("#reason").evaluate((el) => el.tagName);
  const kibTag = await page.locator("#kib").evaluate((el) => el.tagName);
  check("N46: the reason field is multi-line", reasonTag === "TEXTAREA", reasonTag);
  check("N46: the KIB clarification is multi-line", kibTag === "TEXTAREA", kibTag);
  const reasonBox = await page.locator("#reason").boundingBox();
  check("N46: and it is tall enough to show more than one line",
    reasonBox.height >= 60, `${Math.round(reasonBox.height)}px`);

  /* A long reason must be READABLE in the box, not just stored. */
  const long = `QA ${"long reason ".repeat(12)}`.trim();
  await page.fill("#reason", long);
  await page.selectOption("#priority", "Low");
  await submitAction(page, () => page.click('button:has-text("Save changes")'));
  const shown = await page.locator("#reason").inputValue();
  check("N46: a long reason survives the save and comes back whole",
    shown === long, `${shown.length} of ${long.length} chars`);

  /* WHAT THE LEVELS MEAN — the admin picks a target with no idea how Competent
     differs from Practised. Assert the real APM wording, not just the labels,
     because six labels with no definitions is the state being fixed. */
  /* THE PICKER IS THE SIX LEVELS, not a dropdown (owner's Design A). Assert the
     control's SHAPE, not just that a value round-trips: a <select> would pass
     any value check and still be the design that was rejected. */
  check("N46: there is no target dropdown left",
    (await page.locator('select[name="target"]').count()) === 0);
  check("N46: the target is picked from all six levels at once",
    (await page.locator('.levelseg input[name="target"]').count()) === 6);
  const segLabels = await page.locator(".levelseg label .l").allInnerTexts();
  check("N46: and every level is offered by LABEL, not only by number",
    ["Unaware", "Aware", "Practised", "Competent", "Proficient", "Expert"]
      .every((l) => segLabels.includes(l)), segLabels.join("|"));
  /* 4.3.1.3 is seeded at target 2 (Practised) — read from the database rather
     than hardcoded, so a reseed cannot make this assertion quietly wrong. */
  const { data: seededTarget } = await db.from("control")
    .select("target_level").eq("code", "4.3.1.3").single();
  check("N46: the control's own target is the one selected",
    await page.locator(`.levelseg input[value="${seededTarget.target_level}"]`).isChecked(),
    `expected ${seededTarget.target_level}`);
  const seededLabel = ["Unaware", "Aware", "Practised", "Competent", "Proficient", "Expert"][seededTarget.target_level];

  /* Only the CHOSEN level's definition is spelled out — that is what makes the
     block short. Checked as rendered visibility, because all six are in the
     DOM and CSS decides which one shows. */
  const shownDefns = await page.locator(".levelseg-defn:visible").allInnerTexts();
  check("N46: exactly one definition is shown, for the selected level",
    shownDefns.length === 1 && shownDefns[0].includes(seededLabel),
    `${shownDefns.join("|")} (want ${seededLabel})`);

  /* Picking another level moves the definition with it, with no client bundle. */
  await page.locator('.levelseg label[for="target-5"]').click();
  const afterPick = await page.locator(".levelseg-defn:visible").allInnerTexts();
  check("N46: choosing a different level shows that level's definition",
    afterPick.length === 1 && /Expert/.test(afterPick[0]), afterPick.join("|"));
  await page.locator(`.levelseg label[for="target-${seededTarget.target_level}"]`).click();

  /* The full scale is still reachable for comparison, one line per level. */
  await page.locator(".scale-help > summary").click();
  const help = await page.locator(".scale-table").innerText();
  check("N46: every level on the scale is explained",
    ["Unaware", "Aware", "Practised", "Competent", "Proficient", "Expert"]
      .every((l) => help.includes(l)), help.slice(0, 80));
  check("N46: the explanation is the APM wording, not just the label",
    /under supervision/i.test(help) && /independently/i.test(help), help.slice(0, 120));
  check("N46: and this control's own target is marked",
    (await page.locator(".scale-table tr.is-target").count()) === 1);

  /* THE HEIGHT IS THE POINT, so it is measured rather than asserted by eye.
     The rejected design was ~430px of level cards sitting between the target
     and the fields the screen exists for.

     THE THRESHOLD IS 200px AND THAT NUMBER HAS A REASON. It is under half the
     rejected design, which is what "a config control, not a reading list"
     has to mean in pixels, and a return to one card per level cannot fit
     under it — six bordered cards with padding clear 400px before any text
     wraps. It is NOT the current height plus a margin: the first cut of this
     check said 140px, which was a guess made before measuring, and the real
     picker is 151px. Tuning the number down to whatever the code does would
     have made the check agree with the code instead of with the intent. */
  const pickerBox = await page.locator(".levelseg").boundingBox();
  check("N46: the picker stays a control, not a reading list",
    pickerBox.height < 200, `${Math.round(pickerBox.height)}px, budget 200`);

  /* Restore 4.3.1.3 exactly, as section [10] does — the suite must not leave
     the real framework carrying QA text. */
  const { data: seeded } = await db.from("control")
    .select("reason, priority").eq("code", "4.3.1.3").single();
  await db.from("control").update({ reason: null, priority: "High" }).eq("code", "4.3.1.3");
  check("N46: framework restored after the admin walk",
    seeded !== null);

  await ctx.close();
}

/* ------------------------------- 19. the JWKS exclusion is not a free pass */
const JWKS_LOG = process.env.E2E_SERVER_LOG;
if (JWKS_LOG) {
  /* The budgets above exclude jwks.json because it is a once-per-instance
     bootstrap. That is only honest while it STAYS once — if getClaims() ever
     started fetching it per request, the budgets would keep reading 3 and 5
     while every save quietly paid an extra auth round trip, which is the exact
     failure mode "round trips are counted, not estimated" exists to catch.
     So the exclusion is paired with its own assertion. */
  const fetches = readFileSync(JWKS_LOG, "utf8").slice(RUN_MARK)
    .split("\n").filter((l) => l.includes("jwks.json")).length;
  /* THE BOUND IS "NOT PER-REQUEST", NOT "EXACTLY ONCE", and the difference is
     honest rather than convenient. This run makes hundreds of authenticated
     requests; a per-request fetch would show hundreds. A warm process reuses a
     JWKS cached by an earlier run and fetches none, and auth-js may legitimately
     refetch once if a key rotates. Anything in low single digits proves the
     cache is doing its job; the failure this guards against is three orders of
     magnitude away, so a tight bound would only buy flakiness. */
  check("JWKS is cached, not fetched per request",
    fetches <= 2, `${fetches} fetches during this run`);
} else {
  skip("the JWKS bootstrap check",
    "E2E_SERVER_LOG is unset — point it at the next-start log to assert it");
}

/* ---------------------------------------------------------------- cleanup */
await teardown();

console.log(`\n${pass} passed, ${fail} failed${skipped.length ? `, ${skipped.length} SKIPPED (${skipped.join("; ")})` : ""}`);
process.exit(fail === 0 ? 0 : 1);
