#!/usr/bin/env node
/**
 * PRE-PILOT CONCURRENCY CHECK — the whole pilot scoring at the same time.
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
 *   - requests from different PMs were genuinely OVERLAPPING at the server,
 *     measured from when each POST was on the wire — not inferred from the fact
 *     that the test dispatched them together;
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
 *   - teardown runs on the success path, on a throw, on an uncaught exception
 *     and on SIGINT/SIGTERM/SIGHUP/SIGQUIT; it purges the database BEFORE
 *     closing the browser, sweeps by fixture PREFIX rather than by this
 *     invocation's list, retries, and the run FAILS if anything is left behind;
 *   - it refuses to start if fixtures from an earlier run are still present,
 *     so it can neither collide with a concurrent run nor silently adopt a leak.
 *     `CONC_CLEAN=1` clears them without running anything.
 *
 * It refuses to run without --write.
 */
import { randomBytes } from "node:crypto";
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";

const BASE = (process.env.CONC_BASE_URL ?? "https://competency-assessment-platform.vercel.app")
  .replace(/\/$/, "");
const CHROME = process.env.CONC_CHROMIUM ?? process.env.E2E_CHROMIUM ?? undefined;
const PMS = Number(process.env.CONC_PMS ?? 9);
const WALK = Number(process.env.CONC_WALK ?? 10);
/** Where each PM's prior sitting stops. Deliberately DIFFERENT per PM: it makes
 *  every progress figure in the run unique, so "PM 2 was shown PM 3's page" is
 *  a failing assertion rather than a coincidence nobody can rule out. */
const SEEDS = [100, 102, 104, 106, 108, 110, 112, 114, 116];
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
/* Every walk must finish before the burst control, or a PM would answer it
   twice and the two phases would stop being independent. */
if (Math.max(...SEEDS.slice(0, PMS)) + WALK >= BURST_POS) {
  console.error(`CONC_WALK=${WALK} runs past the burst control at ${BURST_POS}.`);
  process.exit(1);
}

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

/* Per-run passwords, never written down — the e2e suite's rule and for its
   reason: this repository is public, and a fixture that outlives its run must
   not be sign-in-able by anyone who can read the convention. */
const qaPassword = () => `Qa${randomBytes(15).toString("base64url")}1!`;

/**
 * Every fixture this harness can create shares this prefix, and the teardown
 * sweeps by it rather than by the list one invocation happens to hold. Narrower
 * than `@example.test` on purpose: `scripts/e2e.mjs` owns `qa.pm*`/`qa.admin`,
 * and a sweep that took those would delete a concurrent e2e run's fixtures.
 */
const FIXTURE_PREFIX = "qa.conc";

const FIXTURES = Array.from({ length: PMS }, (_, i) => ({
  n: i + 1,
  email: `${FIXTURE_PREFIX}${i + 1}@example.test`,
  name: `QA Concurrency PM ${i + 1}`,
  password: qaPassword(),
  seed: SEEDS[i],
}));
const BOSS = {
  email: `${FIXTURE_PREFIX}.admin@example.test`, name: "QA Concurrency Assessor",
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
async function deleteAuthUser(email) {
  const found = (await allAuthUsers()).find((u) => u.email === email);
  if (!found) return;
  const { error } = await db.auth.admin.deleteUser(found.id);
  if (error) throw new Error(`delete auth user ${email}: ${error.message}`);
}

/**
 * Remove one fixture and everything hanging off it.
 *
 * EVERY WRITE'S ERROR IS CHECKED. The first cut discarded all of them, which
 * mattered more than it looks: `assessment.assigned_by` references
 * `app_user(id)` with no ON DELETE (migration 0003), so a failed assessee purge
 * makes the later BOSS delete raise an FK violation — and a discarded error
 * there means the admin silently survives on both the allowlist and the auth
 * table, with the caller none the wiser.
 */
async function purge(email, { keepAccount = false } = {}) {
  const found = await db.from("app_user").select("id").eq("email", email).maybeSingle();
  if (found.error) throw new Error(`purge lookup ${email}: ${found.error.message}`);
  const user = found.data;
  if (user) {
    const rows = await db.from("assessment").select("id").eq("assessee_id", user.id);
    if (rows.error) throw new Error(`purge assessment list ${email}: ${rows.error.message}`);
    for (const a of rows.data ?? []) {
      for (const [table, column] of [
        ["target_snapshot", "assessment_id"], ["score", "assessment_id"], ["assessment", "id"],
      ]) {
        const gone = await db.from(table).delete().eq(column, a.id);
        if (gone.error) throw new Error(`purge ${table} for ${email}: ${gone.error.message}`);
      }
    }
  }
  if (keepAccount) return;
  if (user) {
    const gone = await db.from("app_user").delete().eq("id", user.id);
    if (gone.error) throw new Error(`purge app_user ${email}: ${gone.error.message}`);
  }
  await deleteAuthUser(email);
}

async function ensure(person) {
  await purge(person.email, { keepAccount: true });
  const { data: existing } = await db.from("app_user").select("id").eq("email", person.email).maybeSingle();
  /* An auth account with no allowlist row: a prior run that died between
     `createUser` and the `app_user` insert. `createUser` would refuse the email
     otherwise, so this is what makes the harness recoverable from that death. */
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

  /*
   * THE DATABASE FIRST, THE BROWSER LAST — and the browser on a timer.
   *
   * The first cut of this closed the browser before touching a single fixture,
   * with an unbounded `await browser.close()`. That ordering makes the one
   * component most likely to hang the gate in front of the one thing that must
   * not be skipped. It is not a hypothetical hang either: this container's
   * egress proxy resets Chromium's TLS (CLAUDE.md, 2026-08-07) and this
   * harness's own open observation is a cluster of ERR_ABORTED from exactly
   * that. A Chromium wedged behind a half-dead proxy connection would have left
   * a live admin fixture on the production allowlist with no purge attempted.
   * The `catch` that was there protected against a throw, never against a hang.
   */
  await purgeEverything();
  try {
    if (browser) {
      closingOnPurpose = true;
      await Promise.race([
        browser.close().catch(() => {}),
        new Promise((r) => setTimeout(r, 10_000)),
      ]);
    }
  } catch { /* a dead browser is still a closed one */ }
}

/**
 * Remove every fixture this run could be responsible for, then PROVE it.
 *
 * Two departures from the first cut, both mirroring `scripts/e2e.mjs`, which
 * earned each of them from a real incident (/cso, 2026-08-06: two leftover
 * fixtures, one an admin whose password still authenticated against
 * production).
 *
 * PURGE BY PATTERN, not by the list this invocation happens to know. `FIXTURES`
 * is sized by CONC_PMS, so a run at CONC_PMS=2 following an interrupted run at
 * 4 would neither remove nor even NOTICE the surviving qa.conc3/qa.conc4 rows —
 * and would print "no QA allowlist rows left behind" while they sat there. The
 * sweep is scoped to the `qa.conc` prefix rather than all of `@example.test` so
 * that it cannot delete `e2e.mjs`'s own fixtures out from under a concurrent
 * run of that suite.
 *
 * RETRY, because the assertion is not the remedy. `assessment.assigned_by`
 * references `app_user(id)` with no ON DELETE (migration 0003), and the BOSS
 * fixture is `assigned_by` on all four assessments — so a transient failure on
 * one assessee purge makes the BOSS delete fail with an FK violation, and the
 * admin survives. Ordering BOSS last is necessary and was already true; it is
 * not sufficient.
 */
async function purgeEverything({ attempts = 3 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let emails;
    try {
      emails = await fixtureEmails();
    } catch (e) {
      console.log(`  ⚠ could not list fixtures (attempt ${attempt}): ${e.message}`);
      continue;
    }
    for (const email of emails) {
      // One failing purge must not abandon the rest, or the accounts behind it.
      try { await purge(email); }
      catch (e) { console.log(`  ⚠ could not purge ${email} — ${e.message}`); }
    }
    const left = await remainingFixtures().catch(() => null);
    if (left && left.allowlist.length === 0 && left.auth.length === 0) {
      check("no QA allowlist rows left behind", true);
      check("no QA sign-in accounts left behind", true);
      return;
    }
    if (attempt < attempts) {
      console.log(`  ↻ fixtures still present after attempt ${attempt}; retrying`);
      await new Promise((r) => setTimeout(r, 1_000 * attempt));
    }
  }
  const left = await remainingFixtures().catch(() => null);
  if (!left) {
    cannotRun("cleanup verified against the database", "could not re-read after purging");
    return;
  }
  check("no QA allowlist rows left behind", left.allowlist.length === 0, left.allowlist.join(", "));
  check("no QA sign-in accounts left behind", left.auth.length === 0, left.auth.join(", "));
}

/** This run's fixtures, plus any left by an earlier one. BOSS last: it is
 *  `assigned_by` on the others, and the FK has no ON DELETE. */
async function fixtureEmails() {
  const { data: rows, error } = await db
    .from("app_user").select("email").like("email", `${FIXTURE_PREFIX}%@example.test`);
  if (error) throw new Error(`fixture lookup failed: ${error.message}`);
  const found = new Set([
    ...FIXTURES.map((f) => f.email),
    ...(rows ?? []).map((r) => r.email),
    ...(await strayAuthAccounts()).map((u) => u.email),
  ]);
  found.delete(BOSS.email);
  return [...found, BOSS.email];
}

/** Auth accounts matching the fixture prefix — the pattern, not this run's list. */
const strayAuthAccounts = async () =>
  (await allAuthUsers()).filter((u) => u.email?.startsWith(FIXTURE_PREFIX)
    && u.email?.endsWith("@example.test"));

async function remainingFixtures() {
  const { data, error } = await db
    .from("app_user").select("email").like("email", `${FIXTURE_PREFIX}%@example.test`);
  if (error) throw new Error(`leftover lookup failed: ${error.message}`);
  return {
    allowlist: (data ?? []).map((r) => r.email),
    auth: (await strayAuthAccounts()).map((u) => u.email),
  };
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
   exits immediately and runs no cleanup.

   SIGHUP AND SIGQUIT ARE IN THE LIST FOR THE SAME REASON, and leaving them out
   was a regression against `scripts/e2e.mjs`, which carries them with the
   argument written out: a closed terminal window or a dropped SSH session is at
   least as ordinary a way to end a long run as Ctrl-C, and Node terminates on
   both by default. This run takes minutes against production and holds an admin
   fixture, so an uncovered signal is the exact shape of the incident STATUS.md
   records. SIGKILL and a power cut stay uncoverable by construction — which is
   why the per-run fixture passwords are a real second layer, not a nicety. */
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"]) {
  process.on(sig, () => {
    console.log(`\n(${sig} — tearing down before exit)`);
    teardown().then(summarise).then(() => process.exit(130), () => process.exit(130));
  });
}

let summarised = false;
function summarise() {
  /* A crash landing during teardown reaches here twice — once from `crashed`,
     once from the main path — and printed two reports with different counts,
     leaving a reader to guess which one set the exit code. */
  if (summarised) return;
  summarised = true;
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
        + `offline seen: ${n.offlineSeen}, aborted requests since the last stall: ${n.aborted}`);
    }
  }
  if (failures.length) {
    console.log("\nFAILURES:");
    for (const f of failures) console.log(`  ✗ ${f}`);
  }
  console.log(`\n${pass} passed, ${fail} failed${skipped ? ` (${skipped} could not run)` : ""}`
    + `  ·  target ${BASE}`);
}

/**
 * `CONC_CLEAN=1` — remove fixtures and exit, touching nothing else.
 *
 * Without this the ONLY way to clear a leaked admin was to run the whole
 * production harness again, which is a strange thing to have to do to clean up
 * after a run that failed. Placed before any fixture is created so it can never
 * make the mess it is clearing.
 */
if (process.env.CONC_CLEAN === "1") {
  console.log(`Removing ${FIXTURE_PREFIX}* fixtures from ${new URL(process.env.SUPABASE_URL).host}…`);
  await purgeEverything();
  summarise();
  process.exit(fail === 0 ? 0 : 1);
}

/**
 * REFUSE TO START ON TOP OF SOMEONE ELSE'S RUN.
 *
 * The fixture identities are fixed constants, so two runs at once — two
 * terminals, or a schedule firing beside a person — would destroy each other:
 * run B's `ensure()` purges run A's live assessments mid-walk, and A then
 * reports missing rows and wrong counts. That is a FABRICATED
 * cross-contamination result, on production, and nobody reading it would know
 * to discount it.
 *
 * The same check catches the other case: fixtures that a killed run left
 * behind. `ensure()` would otherwise adopt a leaked admin silently, re-password
 * it and report a clean run — so a leak would leave no trace anywhere.
 */
{
  const left = await remainingFixtures();
  const present = [...new Set([...left.allowlist, ...left.auth])];
  if (present.length > 0) {
    console.error(
      `\nRefusing to start: ${present.length} fixture(s) from an earlier run are still present`
      + `\n  ${present.join("\n  ")}`
      + "\n\nEither another run is in progress — do not run two at once against one database —"
      + "\nor a previous run was killed before it could clean up."
      + "\nClear them with:  CONC_CLEAN=1 npm run concurrency\n");
    process.exit(1);
  }
}

/* --------------------------------------------------------- the framework */

const { data: activeControls, error: ctlErr } = await db
  .from("control").select("id, code, ce_id, sort_order")
  .eq("active", true).order("sort_order").limit(5000);
if (ctlErr) throw new Error(`control fetch failed: ${ctlErr.message}`);
const TOTAL = activeControls.length;
/* Approval freezes one target row per control WITH AN ID — every control, not
   only the active ones (lib/db/assessment.ts, approveAssessment). The count is
   read from the database rather than assumed, so the assertion stays true if
   the framework ever gains or loses a control. */
const { count: ALL_CONTROLS } = await db
  .from("control").select("*", { count: "exact", head: true });
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
const PRIOR_COLUMNS =
  "id, state, submitted_at, approved_at, archived_at, started_at, completed_at, assessor_id, profile_id";
const fingerprintOf = (r) => PRIOR_COLUMNS.split(", ").slice(1)
  .map((c) => r[c]).join("|");

const { data: priorRows, error: priorErr } = await db
  .from("assessment").select(PRIOR_COLUMNS).limit(5000);
if (priorErr) throw new Error(`prior assessment snapshot failed: ${priorErr.message}`);
const PRIOR = new Map((priorRows ?? []).map((r) => [r.id, fingerprintOf(r)]));

/**
 * How many answers each pre-existing assessment holds, and their sum.
 *
 * THE ASSESSMENT ROW IS NOT THE WHOLE RECORD. The canonical failure this
 * harness hunts is a commit resolving the wrong `assessment_id` — and if one
 * ever resolved to a REAL employee's assessment, the assessment row itself
 * would not change at all. A `CONC-WALK-P1-…` row would simply appear in their
 * sheet, permanently: `purge()` only deletes by fixture `assessee_id`, so
 * teardown would not remove it, and every check would stay green.
 *
 * A count plus a checksum of the levels catches an inserted row, a deleted row
 * and a changed level, for one query.
 */
const priorScoreShape = async () => {
  const shape = new Map();
  for (const id of PRIOR.keys()) {
    const { data, error } = await db.from("score")
      .select("self_level, assessor_level").eq("assessment_id", id).limit(5000);
    if (error) throw new Error(`prior score snapshot failed: ${error.message}`);
    const sum = (data ?? []).reduce(
      (a, r) => a + (r.self_level ?? 0) * 7 + (r.assessor_level ?? 0) * 13, 0);
    shape.set(id, `${(data ?? []).length}:${sum}`);
  }
  return shape;
};
const PRIOR_SCORES = await priorScoreShape();

const { data: ces } = await db.from("competence_element").select("id, code, name").order("sort_order");
const ceById = new Map((ces ?? []).map((c) => [c.id, c]));

/* ------------------------------------------------------------- the answers */

/**
 * Every answer in this run is SIGNED, and the signature is what turns "no
 * cross-contamination" from a claim into a measurement. The level a PM gives
 * is a function of who they are, so two PMs never give the same answer to the
 * same control; the evidence names them outright.
 *
 * The level formula below has now collided TWICE — see its own note — and both
 * times the pairwise-distinctness guard in [8] is what caught it. That guard is
 * the whole point: a comparison that cannot fail must say so rather than pass.
 */
/**
 * A per-PM answer pattern, mixed rather than offset.
 *
 * ANY AFFINE FUNCTION OF `n` MOD 6 REPEATS EVERY SIX PMs, so `(n + pos) % 6`
 * gave PM 1 and PM 7 byte-identical answers to all 132 controls the moment this
 * grew past six people — the same collision `(2n + pos) % 6` produced at PM 1
 * and PM 4, caught then by the pairwise-distinctness guard in [8]. Swept five
 * arithmetic candidates against the real 28-competency structure at N=9 and
 * every one of them collided. A mixing hash does not: verified distinct answer
 * vectors AND distinct 28-mean sets at both N=4 and N=9, with the six levels
 * evenly used (so the run exercises the whole scale rather than a slice of it).
 *
 * Deterministic and reproducible — FNV-1a over `${n}:${pos}`, no clock, no
 * Math.random, same answers on every run.
 */
const fnv1a = (str) => {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
};
const levelFor = (pm, pos) => fnv1a(`${pm.n}:${pos}`) % 6;
const evidenceFor = (pm, phase, code) => `CONC-${phase}-P${pm.n}-${code}`;
/**
 * Everyone whose name must NOT appear on this PM's screen — INCLUDING THE
 * ADMIN.
 *
 * BOSS sits outside `FIXTURES`, so the first cut of every foreign-identity
 * check silently excluded the one leak that would matter most: an admin's
 * memoised viewer served into a PM's request hands a project manager the admin
 * navigation and everyone else's data. Nothing asserted against it. `/results`
 * and `/assess/controls` never legitimately render the assessor's name (checked:
 * the results page says only "revised by the assessor"), so including BOSS here
 * costs nothing and closes the worst case.
 *
 * The old third clause — `page.includes(\`-P${o.n}-\`)`, hunting another PM's
 * evidence tag — is gone. Evidence is never rendered on either page (0 hits
 * across capability-report, strengths-gaps and the results page), so it could
 * not fire and was coverage this check did not actually provide.
 */
const others = (pm) => [...FIXTURES, BOSS].filter((o) => o.email !== pm.email);

/** Whose answer is this, read back off the row. `null` = unsigned. */
const ownerOf = (evidence) => {
  const m = /^CONC-[A-Z]+-P(\d+)-/.exec(evidence ?? "");
  return m ? Number(m[1]) : null;
};

/** Score rows in batches Postgres will accept in one statement. */
async function upsertScores(rows, label) {
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await db.from("score")
      .upsert(rows.slice(i, i + 200), { onConflict: "assessment_id,control_id" });
    if (error) throw new Error(`${label} failed: ${error.message}`);
  }
}

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
  await upsertScores(rows, "seed");
  return rows.length;
}

/* ------------------------------------------------------------- the browser */

/**
 * Reach the target BEFORE creating anything.
 *
 * The failure this prevents is not silent — phase [1] catches a login wall — but
 * it catches it after five fixtures and four assessments are already on the
 * production database, and it reads like an app defect rather than a
 * misconfiguration. A retargeted `CONC_BASE_URL` pointing at a protected
 * preview without `Vercel_deployment_ByPass` is the ordinary way to hit it.
 * (Production itself is NOT protection-gated — measured, `/login` answers 200
 * with no bypass header — so the secret is not required here the way it is for
 * scripts/e2e.mjs against a preview.)
 */
{
  const probe = await fetch(`${BASE}/login`, { redirect: "manual" })
    .catch((e) => ({ ok: false, status: 0, headers: new Headers(), error: e.message }));
  const location = probe.headers?.get?.("location") ?? "";
  if (probe.status !== 200 || location.includes("vercel.com")) {
    console.error(
      `\nRefusing to start: ${BASE}/login answered ${probe.status || "no response"}`
      + `${location ? ` → ${location}` : ""}${probe.error ? ` (${probe.error})` : ""}.`
      + "\nNothing has been written. If this is a protected preview, set"
      + " Vercel_deployment_ByPass.\n");
    process.exit(1);
  }
}

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

/**
 * Click something that posts, and wait for the server to have finished.
 *
 * Hand-copied four times before this existed. `scripts/e2e.mjs` extracted the
 * same helper for a documented reason (N21): `click()` waits for nothing, so a
 * `networkidle` straight afterwards can measure quiet that exists because the
 * POST has not STARTED. Arming the listener BEFORE the click is the whole
 * point. `.catch(() => null)` so a click that legitimately posts nothing falls
 * through to the assertion rather than dying here.
 */
async function submitAction(page, click, timeout = 30_000) {
  const posted = page.waitForResponse((r) => r.request().method() === "POST", { timeout })
    .catch(() => null);
  await click();
  await posted;
  await page.waitForLoadState("networkidle");
}

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
  /*
   * THE OVERLAP EVIDENCE. `timed()` measures how long a PROMISE took, and four
   * promises started together always look concurrent — see `overlapAcross`.
   * What actually settles the question is when each POST was on the wire, so
   * every request's send and finish instants are recorded here and the sweep
   * below asks how many DIFFERENT PMs had one outstanding at the same moment.
   */
  person.posts = [];
  page.on("request", (r) => person.pending.set(r, Date.now()));
  page.on("requestfinished", (r) => {
    const started = person.pending.get(r);
    person.pending.delete(r);
    if (started !== undefined && r.method() === "POST") {
      person.posts.push({ start: started, end: Date.now() });
    }
  });
  page.on("requestfailed", (r) => {
    person.pending.delete(r);
    person.failedRequests.push(`${r.method()} ${r.url().slice(0, 140)} — ${r.failure()?.errorText}`);
  });
  await page.goto("/login");
  await page.fill("#email", person.email);
  await page.fill("#password", person.password);
  await submitAction(page, () => page.click('form button[type="submit"]:has-text("Sign in")'));
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
  await armAnswer(pm, level, evidence, timeout);
  await fireCommit(pm, code, timeout);
}

/**
 * Pick the level and type the evidence — everything BEFORE the click.
 *
 * Split out because bundling it with the click made "simultaneous" a fiction.
 * `Promise.all` starts the nine walkers together, but each then has to settle a
 * radio and fill a text field first, and those finish at different times — so
 * the POSTs went out staggered and only 2 of 9 were ever outstanding at once.
 * Measured; the vacuous check this replaced reported that as a clean pass.
 * Arming everyone first and racing only the clicks is what actually puts nine
 * requests on one instance at one moment.
 */
async function armAnswer(pm, level, evidence, timeout = 45_000) {
  await pm.page.check(`input[name="level"][value="${level}"]`, { timeout });
  await pm.page.fill("#evidence", evidence, { timeout });
}

/** The click, and then waiting for the SCREEN — never for the write. */
async function fireCommit(pm, code, timeout = 45_000) {
  const before = pm.page.url();
  await pm.page.click(".assess-actions button.btn-primary", { timeout });
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
  /* The DELTA for this stall, not the run's running total — the lifetime figure
     cannot distinguish "the proxy dropped requests around this click" from
     "the proxy has dropped requests all afternoon", which is the exact
     distinction this number is quoted to make. */
  const abortedNow = pm.failedRequests.filter((f) => f.includes("ERR_ABORTED")).length;
  entry.aborted = abortedNow - (pm.abortedAtLastStall ?? 0);
  pm.abortedAtLastStall = abortedNow;
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
      /* RE-CHECK AFTER THE DIAGNOSTIC. `dumpStall` performs several awaits — an
         evaluate and a screenshot — and if the navigation lands inside that
         window the click below would hit the NEXT control's button with no
         level chosen, committing an answer nobody gave and surfacing later as a
         phase-4 mismatch that looks exactly like cross-contamination. */
      if (pm.page.url() !== before) return;
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

/**
 * How many DIFFERENT PMs had a POST outstanding at the same instant.
 *
 * THE CHECK THIS REPLACES COULD NOT FAIL, and that is worth writing down
 * because it is the exact defect class this harness exists to catch, shipped in
 * the one assertion carrying its headline claim. It compared the wall-clock of
 * the whole burst against the SUM of the four measured durations
 * (`elapsed < serial * 0.75`). But all four promises start together, so under a
 * perfectly serialising server their measured durations are cumulative —
 * W/4, 2W/4, 3W/4, W — summing to 2.5W, and `W < 1.875W` is true. Simulated at
 * N=2, 3 and 4: passes under strict serialisation every time. It was evidence
 * of nothing.
 *
 * A request is outstanding between the instant it goes on the wire and the
 * instant its response completes. If two PMs' intervals intersect, the server
 * genuinely held both at once — which is the precondition for a module-scope
 * leak, and therefore the precondition for this whole run meaning anything.
 */
function overlapAcross(people, since = 0) {
  const intervals = people.flatMap((p) =>
    (p.posts ?? []).filter((iv) => iv.end >= since).map((iv) => ({ ...iv, who: p.n ?? "boss" })));
  let best = 0;
  for (const edge of intervals.map((iv) => iv.start)) {
    /* Half-open [start, end): a request that finished at exactly the instant
       another started did NOT overlap it. With inclusive bounds a strictly
       serial server scores 2 rather than 1 — verified — which would have left
       the replacement almost as weak as the assertion it replaced. */
    const who = new Set(
      intervals.filter((iv) => iv.start <= edge && iv.end > edge).map((iv) => iv.who));
    best = Math.max(best, who.size);
  }
  return best;
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
    /* `===`, not `>=`. A contaminating row inflates the count, so `>=` would
       report the queue drained while the PM's own answer was still in flight —
       and the drain figure this run publishes would be measured against the
       wrong moment. */
    if (counts.every((c, i) => c === expected(FIXTURES[i]))) return { ok: true, counts, ms: Date.now() - t0 };
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
  const { data, error } = await db.from("assessment").select(PRIOR_COLUMNS).limit(5000);
  if (error) throw new Error(`assessment re-read failed: ${error.message}`);
  const now = data ?? [];
  const changed = now
    .filter((r) => PRIOR.has(r.id))
    .filter((r) => PRIOR.get(r.id) !== fingerprintOf(r))
    .map((r) => `${r.id} (fields)`);
  /* A DELETED ROW CANNOT BE COMPARED. The first cut filtered to `PRIOR.has(r.id)`
     over the re-read, so an assessment that vanished between the snapshot and
     now was simply absent and never examined — meaning the one check standing
     behind "nothing outside this run was touched" was blind to the worst
     outcome it could ever have to report. */
  const present = new Set(now.map((r) => r.id));
  const vanished = [...PRIOR.keys()].filter((id) => !present.has(id)).map((id) => `${id} (DELETED)`);
  return [...changed, ...vanished];
}

/** Pre-existing assessments whose ANSWERS changed — a stray write into someone
 *  else's sheet leaves the assessment row untouched, so this is the only thing
 *  that would see it. */
async function scoresThatMoved() {
  const nowShape = await priorScoreShape();
  return [...PRIOR_SCORES.entries()]
    .filter(([id, shape]) => nowShape.get(id) !== shape)
    .map(([id]) => `${id} (${PRIOR_SCORES.get(id)} → ${nowShape.get(id) ?? "gone"})`);
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

  // Mirrors assignAssessment's WRITE — same framework, default profile, cycle,
  // draft state and assignment stamps. Not the whole function: the real one
  // falls back to `fw.profiles[0]` if the default profile is missing, where this
  // throws. Identical today; they would diverge only if "Intermediate" were
  // renamed while another profile existed.
  //
  // Done here rather than through the admin screen ON PURPOSE: that form lists
  // the real staff who are not yet assigned, and this run must not be able to
  // assign a cycle to one of them by a stray click. The assign path itself is
  // covered by scripts/e2e.mjs.
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

console.log(`\n[1] All ${PMS} PMs and the assessor sign in at the same moment`);
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
    const foreign = others(pm).filter((o) => html.includes(o.name) || html.includes(o.email));
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
  // Everyone armed FIRST, so the only thing left to race is the click itself.
  await Promise.all(FIXTURES.map((pm) =>
    armAnswer(pm, levelFor(pm, BURST_POS), evidenceFor(pm, "BURST", code))));
  const t0 = Date.now();
  const burstFrom = t0;
  await Promise.all(FIXTURES.map((pm) =>
    timed("burst commit (concurrent)", () => fireCommit(pm, code))));
  const elapsed = Date.now() - t0;
  console.log(`    ${PMS} simultaneous commits dispatched in ${elapsed}ms`);

  /* "Concurrent" has to be a fact about the SERVER, not about how the test was
     written — measured from when each POST was actually on the wire. Anything
     less than every PM overlapping means the burst did not exercise the sharing
     this run exists to check, and every result below it is worth less. */
  const overlapped = overlapAcross(FIXTURES, burstFrom);
  console.log(`    peak overlap: ${overlapped} of ${PMS} PMs had a POST outstanding at once`);
  /* THE FLOOR IS 2, NOT ${PMS}, and the difference is the difference between an
     assertion about the APP and one about the harness's dispatch precision.
     Two requests overlapping is the precondition for everything below — it is
     what makes one instance serve two people at once, and therefore what puts
     `viewerMemo` and the framework memo under test at all. Demanding all nine
     would be asserting that Playwright can land nine clicks inside one
     request's flight time, which flaps for reasons that say nothing about the
     product. The peak is printed either way, so a run that only ever managed
     two is visible rather than buried. */
  check(`commits from different PMs overlapped at the server (peak ${overlapped} of ${PMS})`,
    overlapped >= 2,
    `no two requests were ever in flight together (wall-clock ${elapsed}ms)`);

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
  /* The walk is the phase the pilot actually looks like, so it needs the same
     evidence the burst does — measured, not assumed from Promise.all. */
  const walkOverlap = overlapAcross(FIXTURES, t0);
  console.log(`    peak overlap during the walk: ${walkOverlap} of ${PMS}`);
  check(`the walk had PMs outstanding at the server together (peak ${walkOverlap} of ${PMS})`,
    walkOverlap >= 2, "no two requests were ever in flight together");
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
  /* A SECOND INJECTION, because the first cannot reach every check. The
     "no unsigned answer appeared in any record" assertion had never been red
     through two sabotage runs — it passed only because it agreed with the code,
     which ground rule 0 says is worth nothing. An answer with no signature is
     what a write from outside this harness would look like. */
  const unsignedPos = beneficiary.seed - 1;
  await db.from("score").upsert({
    assessment_id: beneficiary.assessmentId, control_id: at(unsignedPos).id,
    self_level: 4, evidence: null,
  }, { onConflict: "assessment_id,control_id" });
  console.log(`  ⚠ SABOTAGE: stripped the signature from ${at(unsignedPos).code} in PM ${beneficiary.n}'s record.`);
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

console.log(`\n[5] Progress — ${PMS} concurrent renders of the one screen whose job is to report it`);
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
    const foreign = others(pm).filter((o) => page.includes(o.name) || page.includes(o.email));
    check(`PM ${pm.n}'s progress page contains nothing belonging to another PM`,
      foreign.length === 0, foreign.map((o) => `PM ${o.n}`).join(", "));
  }
}

await stopIfAsked(5);

/* ══════════════════════════════════════════════ 6. finish, then submit together */

console.log(`\n[6] ${PMS} concurrent submits`);
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
    await upsertScores(rows, "fill");
  }));

  await Promise.all(FIXTURES.map((pm) =>
    timed("progress render (concurrent)", () => pm.page.goto("/assess/controls"))));
  const t0 = Date.now();
  await Promise.all(FIXTURES.map(async (pm) => {
    /* The exact label. `:has-text()` is a case-insensitive SUBSTRING match, so
       the previous `"Submit", "submit for review"` pair was one selector and its
       own prefix. */
    await timed("submit (concurrent)", () =>
      submitAction(pm.page, () => pm.page.click('button:has-text("Submit for review")'), 60_000));
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
  const strayScores = await scoresThatMoved();
  check("no answer was written into anyone else's record",
    strayScores.length === 0, strayScores.join(", "));
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
    /* The assessor is the ONE session that legitimately sees several people, so
       this is the screen where a wrong-record render is hardest to notice — and
       it was the least asserted. BOSS is excluded from the foreign set here for
       the obvious reason; the other PMs are not. */
    const foreignHere = FIXTURES.filter((o) => o.n !== pm.n).filter((o) => text.includes(o.name));
    check(`the review screen for PM ${pm.n} carries no other PM's record`,
      foreignHere.length === 0, foreignHere.map((o) => `PM ${o.n}`).join(", "));

    const pending = BOSS.page.locator('button:has-text("Accept all remaining")');
    const pendingShown = await pending.count();
    /* Say which branch ran. Skipping silently would let a locator that stopped
       matching look identical to a sheet that needed no accepting. */
    check(`the accept-all control resolved for PM ${pm.n}`, pendingShown > 0,
      "button never rendered");
    if (pendingShown > 0 && !/Accept all remaining \(0\)/.test(text)) {
      await timed("accept all", () =>
        submitAction(BOSS.page, () => pending.first().click(), 60_000));
    }
    await timed("approve", () =>
      submitAction(BOSS.page, () => BOSS.page.click('button:has-text("Approve assessment")'), 60_000));
    const { data: r } = await db.from("assessment").select("state, approved_at, assessor_id")
      .eq("id", pm.assessmentId).maybeSingle();
    check(`PM ${pm.n}'s assessment is approved`, r?.state === "approved" && !!r?.approved_at, r?.state);
    check(`PM ${pm.n}'s approval names the assessor`, r?.assessor_id === BOSS.id);
  }
}

await stopIfAsked(7);

/* ═══════════════════════════════════ 8. four results pages, rendered at once */

console.log(`\n[8] Results — ${PMS} concurrent renders, each checked against its own arithmetic`);
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

  /**
   * Each competency's mean PAIRED WITH THE COMPETENCY, not a bare multiset.
   *
   * The first cut sorted both sides and compared the numbers alone, which threw
   * away the one thing that makes a mean meaningful — which competency it
   * belongs to. A rollup keyed by the wrong CE would show all 28 correct
   * numbers against the wrong 28 names and pass. Anchored to the `val` cell so
   * the 132 drill-down rows above it (which carry `<b class="tnum">` too, with
   * scale LABELS rather than numbers) cannot be swept in.
   */
  const pairsOnPage = (html) =>
    [...html.matchAll(/<div class="name">([^<]*)<[\s\S]*?<div class="val"><b class="tnum">([\d.—]+)<\/b>/g)]
      .map((m) => `${m[1].trim()}=${m[2]}`).sort();
  const pairsExpected = (rows) =>
    rows.map((r) => `${r.ce}=${r.actual.toFixed(1)}`).sort();

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
      const shown = pairsOnPage(page);
      const mine = pairsExpected(expected.get(pm.n));
      if (shown.length !== mine.length) {
        cannotRun(`round ${round}: PM ${pm.n}'s competency means compared against the page`,
          `page carried ${shown.length} competency rows, arithmetic produced ${mine.length}`);
      } else {
        const a = shown.join(","), b = mine.join(",");
        check(`round ${round}: PM ${pm.n}'s results show PM ${pm.n}'s own ${mine.length} competency means`,
          a === b, a === b ? "" : `page ${a}\n            db   ${b}`);
        // And not somebody else's: the one that would look right on its own.
        const impostor = FIXTURES.find((o) => o.n !== pm.n
          && pairsExpected(expected.get(o.n)).join(",") === a);
        check(`round ${round}: PM ${pm.n} was not shown another PM's report`,
          !impostor, impostor ? `matched PM ${impostor.n}` : "");
      }
      check(`round ${round}: PM ${pm.n}'s report names PM ${pm.n}`, page.includes(pm.name));
      const foreign = others(pm).filter((o) => page.includes(o.name) || page.includes(o.email));
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
    const foreign = others(pm).filter((o) => page.includes(o.name) || page.includes(o.email));
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
    /* `=== ALL_CONTROLS`, not `> 0`. A freeze that wrote one row of 133 would
       have passed the old form — and a partial snapshot is worse than none:
       rollup falls back to LIVE targets for whatever is missing (rollup-spec
       §6), so the report silently answers a different question. */
    check(`PM ${pm.n}'s targets were frozen at approval, all ${ALL_CONTROLS}`,
      count === ALL_CONTROLS, `${count} of ${ALL_CONTROLS}`);
  }
  /* PRINTED IS NOT ASSERTED. Both of these were collected and rendered in the
     summary but never handed to `check()`, so a run in which four-way
     concurrency made the app fail to advance — the exact question this harness
     exists to answer — printed a paragraph and exited 0. */
  check("no click had to be repeated to move the screen",
    NUDGES.length === 0,
    NUDGES.map((n) => `PM ${n.pm} ${n.code} (attempt ${n.attempt})`).join(", "));
  const clientErrors = [...FIXTURES, BOSS].flatMap((p) =>
    (p.pageErrors ?? []).map((e) => `PM ${p.n ?? "boss"}: ${e}`));
  check("no uncaught client-side error on any session", clientErrors.length === 0,
    clientErrors.slice(0, 3).join(" | "));

  const moved = await assessmentsThatMoved();
  check("still no assessment outside this run has changed", moved.length === 0, moved.join(", "));
  const strayScores = await scoresThatMoved();
  check("still no answer has been written into anyone else's record",
    strayScores.length === 0, strayScores.join(", "));
}

await teardown();
summarise();
process.exit(fail === 0 ? 0 : 1);
