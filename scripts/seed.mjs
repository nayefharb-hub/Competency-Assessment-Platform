#!/usr/bin/env node
/**
 * Seed the ICB4 framework into Supabase from the verified T0 extraction.
 *
 *   node scripts/seed.mjs            # seed (fails if the framework already exists)
 *   node scripts/seed.mjs --reset    # delete the existing framework first
 *
 * Requires (server-side only — never expose the service key to a browser):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Source of truth: data/seed/icb4-framework.json, produced and verified by
 * data/seed/extract_workbook.py. Counts are re-checked here before writing, so a
 * corrupted or partial file cannot be seeded silently.
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESET = process.argv.includes("--reset");

if (!URL || !KEY) {
  console.error(
    "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.\n" +
      "Copy .env.example to .env.local and fill them in, then:\n" +
      "  export $(grep -v '^#' .env.local | xargs) && node scripts/seed.mjs",
  );
  process.exit(1);
}

const db = createClient(URL, KEY, { auth: { persistSession: false } });
const fw = JSON.parse(readFileSync(new URL("../data/seed/icb4-framework.json", import.meta.url)));

/** Fail loudly rather than seed a half-correct framework. */
function precheck() {
  const active = fw.controls.filter((c) => c.active).length;
  const checks = [
    ["controls", fw.controls.length, 133],
    ["active controls", active, 132],
    ["competence elements", fw.competence_elements.length, 28],
    ["areas", fw.areas.length, 3],
    ["scale levels", fw.scale.levels.length, 6],
    ["CE targets", fw.ce_targets.length, 28],
  ];
  let ok = true;
  for (const [label, got, want] of checks) {
    if (got !== want) {
      console.error(`  FAIL ${label}: got ${got}, expected ${want}`);
      ok = false;
    }
  }
  if (!ok) {
    console.error("Seed aborted — the extraction file does not match expected counts.");
    process.exit(1);
  }
  console.log(`Precheck OK — ${fw.controls.length} controls (${active} active), ${fw.measures.length} measures.`);
}

async function must(promise, what) {
  const { data, error } = await promise;
  if (error) {
    console.error(`Failed: ${what}\n`, error);
    process.exit(1);
  }
  return data;
}

/** Plain-language glosses shown beside each APM label (faithful restatements). */
const GLOSS = {
  0: "I have no real awareness of this yet.",
  1: "I know it exists and understand the idea, but I haven’t really applied it.",
  2: "I can do this, but I still need guidance — mostly on straightforward projects.",
  3: "I do this on my own, on projects of limited complexity.",
  4: "I do this confidently on complex projects, and I coach others.",
  5: "I’m the person others come to; I adapt and improve how it’s done.",
};

const PROFILES = ["Entry", "Intermediate", "Advanced", "Master"];

async function main() {
  precheck();

  const [name, version] = ["IPMA ICB4", "v4.0.1"];

  const existing = await must(
    db.from("framework").select("id").eq("name", name).eq("version", version).maybeSingle(),
    "look up existing framework",
  );
  if (existing) {
    if (!RESET) {
      console.error(`${name} ${version} is already seeded. Re-run with --reset to replace it.`);
      process.exit(1);
    }
    console.log("--reset: deleting the existing framework (cascades to its children)…");
    await must(db.from("framework").delete().eq("id", existing.id), "delete framework");
  }

  // scale + levels
  const scale = await must(
    db.from("scale").insert({ name: fw.scale.name, axis: fw.scale.axis }).select("id").single(),
    "insert scale",
  );
  await must(
    db.from("scale_level").insert(
      fw.scale.levels.map((l) => ({
        scale_id: scale.id,
        level: l.level,
        label: l.label,
        knowledge: l.knowledge,
        application: l.application,
        kib_gloss: GLOSS[l.level] ?? null,
      })),
    ),
    "insert scale levels",
  );

  // framework
  const framework = await must(
    db.from("framework").insert({ name, version, scale_id: scale.id }).select("id").single(),
    "insert framework",
  );

  // areas
  const areaRows = await must(
    db
      .from("competence_area")
      .insert(fw.areas.map((a, i) => ({ framework_id: framework.id, code: a.code, name: a.name, sort_order: i })))
      .select("id, name"),
    "insert areas",
  );
  const areaId = new Map(areaRows.map((r) => [r.name, r.id]));

  // competence elements — target comes from the Results sheet, never computed
  const ceTarget = new Map(fw.ce_targets.map((t) => [t.ce_code, t.target]));
  const ceRows = await must(
    db
      .from("competence_element")
      .insert(
        fw.competence_elements.map((ce, i) => ({
          framework_id: framework.id,
          area_id: areaId.get(ce.area),
          code: ce.code,
          name: ce.name,
          target_level: ceTarget.get(ce.code) ?? null,
          sort_order: i,
        })),
      )
      .select("id, code"),
    "insert competence elements",
  );
  const ceId = new Map(ceRows.map((r) => [r.code, r.id]));

  // controls
  const controlRows = await must(
    db
      .from("control")
      .insert(
        fw.controls.map((c, i) => ({
          framework_id: framework.id,
          ce_id: ceId.get(c.ce_code),
          code: c.code,
          indicator: c.indicator,
          description: c.description,
          active: c.active,
          priority: c.priority,
          reason: c.reason,
          kib_note: c.kib_note,
          apm_competence: c.apm_competence,
          target_level: c.target_level,
          target_source: c.target_source,
          sort_order: i,
        })),
      )
      .select("id, code"),
    "insert controls",
  );
  const controlId = new Map(controlRows.map((r) => [r.code, r.id]));

  // measures (reference only — never scored)
  const measures = fw.measures
    .filter((m) => controlId.has(m.control_code) && m.text)
    .map((m) => ({ control_id: controlId.get(m.control_code), seq: m.no, text: m.text }));
  for (let i = 0; i < measures.length; i += 500) {
    await must(db.from("measure").insert(measures.slice(i, i + 500)), `insert measures ${i}`);
  }

  // benchmark profiles + targets
  for (const [i, profile] of PROFILES.entries()) {
    const p = await must(
      db
        .from("benchmark_profile")
        .insert({ framework_id: framework.id, name: profile, sort_order: i })
        .select("id")
        .single(),
      `insert profile ${profile}`,
    );
    const key = profile.toLowerCase();
    const rows = fw.benchmarks
      .map((b) => {
        const v = b[key];
        // "N/R" = APM marks the competence not relevant at this level -> null
        return { profile_id: p.id, apm_competence: b.apm_competence, level: typeof v === "number" ? v : null };
      })
      .filter((r) => r.apm_competence);
    if (rows.length) await must(db.from("benchmark_target").insert(rows), `insert targets ${profile}`);
  }

  console.log(
    `Seeded ${name} ${version}: ${fw.areas.length} areas · ${fw.competence_elements.length} elements · ` +
      `${fw.controls.length} controls · ${measures.length} measures · ${PROFILES.length} benchmark profiles.`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
