#!/usr/bin/env node
/**
 * Fill your OWN draft assessment with plausible scores, so you can reach the
 * review and results screens without clicking through 132 controls first.
 *
 *   node --env-file=.env.local scripts/demo.mjs fill  you@kib.com.kw
 *   node --env-file=.env.local scripts/demo.mjs fill  you@kib.com.kw --partial 40
 *   node --env-file=.env.local scripts/demo.mjs reset you@kib.com.kw
 *
 * It writes self-scores only, and leaves the assessment in DRAFT — you still
 * click Submit, review and Approve yourself, so what you are testing is the
 * real flow rather than a state this script invented.
 *
 * Guards: it refuses to touch an assessment that is not in draft (so it can
 * never overwrite a real submitted or approved record), and it only ever
 * touches the one account you name.
 *
 * `reset` deletes that account's assessment entirely — scores, snapshot and
 * all — putting you back to "never started" so you can walk the loop again.
 */
import { createClient } from "@supabase/supabase-js";

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}
const db = createClient(URL, KEY, { auth: { persistSession: false } });

const die = (m) => { console.error(`✗ ${m}`); process.exit(1); };
const command = process.argv[2] ?? "";
const email = (process.argv[3] ?? "").trim().toLowerCase();
const partialIdx = process.argv.indexOf("--partial");
const partial = partialIdx === -1 ? null : Number(process.argv[partialIdx + 1]);

if (!email) die("Which account? e.g. scripts/demo.mjs fill you@kib.com.kw");

const { data: user, error: userErr } = await db
  .from("app_user").select("id, full_name, role").eq("email", email).maybeSingle();
if (userErr) die(userErr.message);
if (!user) die(`${email} is not on the allowlist — invite them first (npm run invite).`);

const cycle = String(new Date().getUTCFullYear());

async function assessmentOf() {
  const { data, error } = await db
    .from("assessment").select("id, state")
    .eq("assessee_id", user.id).eq("cycle", cycle).maybeSingle();
  if (error) die(error.message);
  return data;
}

/** Deterministic, so the same account always produces the same profile. */
function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Cluster around each control's own target, with a few deliberate gaps, so the
 *  results page shows a realistic mix of the three health tiers instead of a
 *  flat wall of one colour. */
function level(code, target) {
  const base = target ?? 3;
  const r = hash(code) % 10;
  const shift = r < 2 ? -2 : r < 5 ? -1 : r > 8 ? 1 : 0;
  return Math.max(0, Math.min(5, base + shift));
}

async function fill() {
  const a = await assessmentOf();
  if (!a) {
    die(
      `${email} has no assessment for this cycle. An admin assigns one from ` +
      `/admin/people — visiting /assess no longer creates it. Assign, then re-run this.`,
    );
  }
  if (a.state !== "draft") {
    die(
      `That assessment is "${a.state}", not draft — refusing to overwrite it. ` +
      `Use "reset ${email}" if you want to start over.`,
    );
  }

  const { data: controls, error } = await db
    .from("control").select("id, code, target_level")
    .eq("active", true).order("sort_order").limit(5000);
  if (error) die(error.message);

  const take = partial && partial > 0 ? controls.slice(0, partial) : controls;
  const rows = take.map((c) => ({
    assessment_id: a.id,
    control_id: c.id,
    self_level: level(c.code, c.target_level),
  }));

  const write = await db.from("score").upsert(rows, { onConflict: "assessment_id,control_id" });
  if (write.error) die(write.error.message);

  await db.from("assessment")
    .update({ started_at: new Date().toISOString() })
    .eq("id", a.id).is("started_at", null);

  console.log(`✓ scored ${rows.length} of ${controls.length} controls for ${user.full_name}`);
  console.log(`  Still in draft — open /assess/controls and click "Submit for review".`);
  if (partial) console.log(`  Partial fill: the progress bar will show ${rows.length}/${controls.length}.`);
}

async function reset() {
  const a = await assessmentOf();
  if (!a) {
    console.log(`Nothing to reset — ${email} has no assessment this cycle.`);
    return;
  }
  for (const [table, column] of [["target_snapshot", "assessment_id"], ["score", "assessment_id"]]) {
    const gone = await db.from(table).delete().eq(column, a.id);
    if (gone.error) die(`${table}: ${gone.error.message}`);
  }
  const gone = await db.from("assessment").delete().eq("id", a.id);
  if (gone.error) die(gone.error.message);
  console.log(`✓ reset ${email} — back to "never started" for cycle ${cycle}`);
}

const commands = { fill, reset };
if (!commands[command]) die(`Unknown command "${command}". Use fill | reset.`);
await commands[command]();
