#!/usr/bin/env node
/**
 * Verify the live database against the framework's known-good facts.
 *
 *   node --env-file=.env.local scripts/verify-db.mjs
 *
 * This is the SQL check in docs/STATUS.md, run from the app's own credentials
 * so it also proves the service key reaches the tables the app needs. Exits
 * non-zero on any mismatch, so it is safe to wire into CI.
 */
import { createClient } from "@supabase/supabase-js";

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}
const db = createClient(URL, KEY, { auth: { persistSession: false } });

async function count(table, filter = (q) => q) {
  const { count: n, error } = await filter(db.from(table).select("*", { count: "exact", head: true }));
  if (error) throw new Error(`${table}: ${error.message}`);
  return n ?? 0;
}

const checks = [
  ["controls", () => count("control"), 133],
  ["controls active", () => count("control", (q) => q.eq("active", true)), 132],
  ["competence elements", () => count("competence_element"), 28],
  ["areas", () => count("competence_area"), 3],
  ["measures", () => count("measure"), 586],
  ["scale levels", () => count("scale_level"), 6],
  ["benchmark profiles", () => count("benchmark_profile"), 4],
  ["benchmark targets", () => count("benchmark_target"), 116],
  [
    "inactive control",
    async () => {
      const { data, error } = await db.from("control").select("code").eq("active", false);
      if (error) throw new Error(error.message);
      return data.map((c) => c.code).sort().join(",");
    },
    "4.3.2.6",
  ],
  [
    "CEs per area",
    async () => {
      const { data, error } = await db.from("competence_area").select("name, competence_element(count)");
      if (error) throw new Error(error.message);
      return data
        .map((a) => `${a.name} ${a.competence_element[0]?.count ?? 0}`)
        .sort()
        .join(" · ");
    },
    "People 10 · Perspective 5 · Practice 13",
  ],
  [
    "controls per area",
    async () => {
      const { data, error } = await db
        .from("control")
        .select("competence_element!inner(competence_area!inner(name))")
        .limit(5000);
      if (error) throw new Error(error.message);
      const tally = {};
      for (const row of data) {
        const name = row.competence_element.competence_area.name;
        tally[name] = (tally[name] ?? 0) + 1;
      }
      return Object.entries(tally).map(([k, v]) => `${k} ${v}`)
        .sort((a, b) => a.localeCompare(b)).join(" · ");
    },
    "People 49 · Perspective 24 · Practice 60",
  ],
];

let failed = 0;
for (const [name, run, expected] of checks) {
  let actual;
  try {
    actual = await run();
  } catch (e) {
    actual = `ERROR ${e.message}`;
  }
  const ok = String(actual) === String(expected);
  if (!ok) failed++;
  console.log(`${ok ? "✓" : "✗"} ${name.padEnd(22)} ${String(actual).padEnd(34)} ${ok ? "" : `expected ${expected}`}`);
}

console.log(failed === 0 ? `\n${checks.length}/${checks.length} checks passed.` : `\n${failed} check(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
