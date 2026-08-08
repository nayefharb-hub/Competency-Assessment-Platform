#!/usr/bin/env node
/**
 * Capture and compare the framework's TUNABLE LAYER.
 *
 *   node --env-file=.env.local scripts/framework-baseline.mjs --export
 *   node --env-file=.env.local scripts/framework-baseline.mjs --diff
 *
 * WHY THIS EXISTS, and what it deliberately is not.
 *
 * The owner is about to set KIB's 2026 baseline by hand across 133 controls.
 * Until that starts, `supabase/seed.sql` IS the record of the shipped values —
 * verified 2026-08-08 at zero drift. The moment editing begins, that stops being
 * true, and there is no other copy of "what it was before I started".
 *
 * So this is a SAFETY NET, not the profiles feature (docs/design-framework-
 * profiles.md, deliberately unbuilt). It writes one JSON file and reads it back.
 * It does not add a table, a screen, or a concept.
 *
 * READ-ONLY AGAINST THE DATABASE, ON PURPOSE. There is no --restore. Restoring
 * means writing 133 rows, which is a destructive operation that deserves its own
 * review rather than riding along in a convenience script. The export is enough
 * to drive a restore when one is actually wanted.
 *
 * The TUNABLE layer only — target, priority, active, reason, kib_note and the
 * provenance. ICB4 source text is never edited and so is never captured; if it
 * ever differs, that is a seeding bug, not a baseline change.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const FILE = "data/baseline/framework-tunable.json";

const mode = process.argv.includes("--export") ? "export"
  : process.argv.includes("--diff") ? "diff"
  : null;
if (!mode) {
  console.error("Usage: framework-baseline.mjs --export | --diff");
  process.exit(1);
}

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const { data: controls, error } = await db
  .from("control")
  .select("code, target_level, priority, active, reason, kib_note, target_source")
  .order("code");
if (error) throw new Error(`Reading controls failed: ${error.message}`);

/* Competency targets travel with the baseline even though nothing reads them any
   more: since 2026-08-08 the rollup computes a CE's target as the mean of its
   active control targets (rollup-spec §3), and this column is only the recoverable
   APM anchor. That is exactly why capturing it matters — it is now the ONLY live
   record of the published bar, and capturing it costs nothing. */
const { data: ces, error: ceErr } = await db
  .from("competence_element")
  .select("code, target_level")
  .order("sort_order");
if (ceErr) throw new Error(`Reading competence elements failed: ${ceErr.message}`);

const snapshot = { controls, competence_elements: ces };

if (mode === "export") {
  if (existsSync(FILE)) {
    console.log(`${FILE} already exists.`);
    console.log("Refusing to overwrite: the whole point is that it records the state");
    console.log("BEFORE editing. Delete it deliberately if you mean to re-baseline.");
    process.exit(1);
  }
  mkdirSync("data/baseline", { recursive: true });
  writeFileSync(FILE, JSON.stringify(snapshot, null, 2) + "\n");
  console.log(`Captured ${controls.length} controls and ${ces.length} competencies to ${FILE}`);
  process.exit(0);
}

/* ---- diff ---- */
if (!existsSync(FILE)) {
  console.error(`No baseline at ${FILE}. Run --export first.`);
  process.exit(1);
}
const base = JSON.parse(readFileSync(FILE, "utf8"));
const baseByCode = new Map(base.controls.map((c) => [c.code, c]));
const FIELDS = ["target_level", "priority", "active", "reason", "kib_note"];

let changed = 0;
for (const now of controls) {
  const was = baseByCode.get(now.code);
  if (!was) { console.log(`+ ${now.code} is new since the baseline`); changed++; continue; }
  const diffs = FIELDS.filter((f) => JSON.stringify(was[f]) !== JSON.stringify(now[f]));
  if (!diffs.length) continue;
  changed++;
  console.log(`~ ${now.code}`);
  for (const f of diffs) {
    console.log(`    ${f}: ${JSON.stringify(was[f])} -> ${JSON.stringify(now[f])}`);
  }
}

const baseCe = new Map(base.competence_elements.map((e) => [e.code, e.target_level]));
for (const e of ces) {
  if (baseCe.get(e.code) !== e.target_level) {
    changed++;
    console.log(`~ competency ${e.code} target: ${baseCe.get(e.code)} -> ${e.target_level}`);
  }
}

console.log(changed === 0
  ? `\nNo change from the baseline (${controls.length} controls checked).`
  : `\n${changed} row(s) differ from the baseline.`);
