/**
 * THE SEAM.
 *
 * Everything that reads the competency framework goes through this module, and
 * this module is the only thing that knows where the framework lives. It used
 * to read data/seed/icb4-framework.json; it now queries Supabase. The screens
 * and the rollup engine did not change shape — that was the point of the seam,
 * and it is what keeps a second framework (or a second tenant) reachable later
 * without a rewrite.
 *
 * Two entry points, and the difference between them is a security boundary:
 *
 *   getFramework()         full framework — assessor and admin views
 *   getAssesseeFramework() target, priority, reason and kib_note REDACTED
 *
 * The PM must not see targets while self-scoring (anti-anchoring, per the eng
 * plan's state machine). Redaction happens HERE, in the data layer, not by
 * omitting a field in JSX — so a PM cannot reach a target through any page,
 * server action or serialized prop.
 */
import "server-only";
import { unstable_cache, updateTag } from "next/cache";
import { phase } from "./perf";
import { db, unwrap } from "./supabase/server";
import type {
  Area, AreaName, Benchmark, CeTarget, CompetenceElement, Control, Framework,
  Level, Measure, Priority, Scale, ScaleLevel,
} from "./types";

const FRAMEWORK_NAME = "IPMA ICB4";
const FRAMEWORK_VERSION = "v4.0.1";
/** APM benchmark profile applied when an assessment does not name one. */
export const DEFAULT_PROFILE = "Intermediate";

export interface BenchmarkProfile {
  id: string;
  name: string;
  sort_order: number;
}

export interface FrameworkApi {
  data: Framework;
  scale: Scale;
  scaleLevels: ScaleLevel[];
  controls: Control[];
  activeControls: Control[];
  profiles: BenchmarkProfile[];
  counts: {
    total: number;
    active: number;
    inactive: number;
    ces: number;
    measures: number;
  };
  labelOf(level: Level | null): string;
  /** plain-language restatement of the APM wording, shown while self-scoring */
  glossOf(level: Level): string;
  controlByCode(code: string): Control | undefined;
  /** database id for a control code — needed to write scores */
  controlIdByCode(code: string): string | undefined;
  measuresFor(code: string): Measure[];
  ceOf(code: string): CompetenceElement | undefined;
  /** 1-based position of a control within the ordered active controls */
  controlPosition(code: string): number;
  neighbours(code: string): { prev?: Control; next?: Control };
  /**
   * Per-control target level for a benchmark profile. Selecting a profile
   * re-points every control that maps to an APM competence; controls whose
   * target was derived from priority rather than published by APM keep their
   * stored value.
   */
  targetsForProfile(profileName: string): Map<string, Level | null>;
}

/* ------------------------------------------------------------------ rows */

interface ControlRow {
  id: string; ce_id: string; code: string; indicator: string;
  description: string | null; active: boolean; priority: string | null;
  reason: string | null; kib_note: string | null; apm_competence: string | null;
  target_level: number | null; target_source: string | null; sort_order: number;
}
interface CeRow {
  id: string; area_id: string; code: string; name: string;
  target_level: number | null; sort_order: number;
}
interface AreaRow { id: string; code: string; name: string; sort_order: number }
interface MeasureRow { control_id: string; seq: number; text: string }
interface ScaleLevelRow {
  level: number; label: string; knowledge: string | null;
  application: string | null; kib_gloss: string | null;
}
interface TargetRow { profile_id: string; apm_competence: string; level: number | null }

const asLevel = (n: number | null | undefined): Level | null =>
  n === null || n === undefined ? null : (n as Level);

/* ------------------------------------------------------------------ load */

/**
 * TWO caches, doing two different jobs.
 *
 * The ROWS come from Next's data cache (`unstable_cache`, tagged). That is the
 * one that matters in production: a module-level cache lives and dies with one
 * serverless instance, so on Vercel a low-traffic app pays the full nine-query
 * framework load on almost every navigation. Measured against the running app:
 * one cold render made ~18 Supabase round trips, nine of them this. At
 * Vercel↔Supabase latency that is most of a second before anything else starts.
 *
 * The assembled API is then memoised per instance, because turning 133 controls
 * and 586 measures into the domain shape is pure CPU and worth not repeating.
 *
 * Writes call invalidateFramework(), which clears both. The TTL on the module
 * memo is the backstop for the multi-instance case; the tag handles the data
 * cache properly. Scores are never cached here.
 */
const TTL_MS = 60_000;
const FRAMEWORK_TAG = "framework";
let cache: { at: number; api: FrameworkApi } | null = null;
let inFlight: Promise<FrameworkApi> | null = null;

export function invalidateFramework(): void {
  cache = null;
  inFlight = null;
  // The row cache is shared across instances, so clearing the local memo alone
  // would leave every OTHER instance serving the pre-edit framework.
  // updateTag rather than revalidateTag: this is only ever called from the
  // admin's save action, and read-your-own-writes is exactly what that needs —
  // the admin must see their own edit on the very next render, not eventually.
  updateTag(FRAMEWORK_TAG);
}

export async function getFramework(): Promise<FrameworkApi> {
  // A hit on the in-memory memo is free and is NOT logged; only the expensive
  // path is, so a quiet log means the memo is doing its job.
  if (cache && Date.now() - cache.at < TTL_MS) return cache.api;
  return phase("framework: data cache + assemble 133 controls, 586 measures", getFrameworkUncached);
}

async function getFrameworkUncached(): Promise<FrameworkApi> {
  if (!inFlight) {
    inFlight = loadFramework()
      .then((api) => {
        cache = { at: Date.now(), api };
        return api;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

/**
 * Every row the framework is built from, as plain JSON so it can live in the
 * data cache. Nothing here is per-user: it is identical for everyone, and only
 * an admin edit changes it.
 */
const fetchFrameworkRows = unstable_cache(
  async () => {
    const sb = db();

    const fw = unwrap(
    "framework",
    await sb
      .from("framework")
      .select("id, name, version, scale_id")
      .eq("name", FRAMEWORK_NAME)
      .eq("version", FRAMEWORK_VERSION)
      .maybeSingle(),
    ) as { id: string; name: string; version: string; scale_id: string };

    const [scaleRow, levelRows, areaRows, ceRows, controlRows, profileRows] = await Promise.all([
    sb.from("scale").select("name, axis").eq("id", fw.scale_id).maybeSingle()
      .then((r) => unwrap("scale", r) as { name: string; axis: string }),
    sb.from("scale_level").select("level, label, knowledge, application, kib_gloss")
      .eq("scale_id", fw.scale_id).order("level")
      .then((r) => unwrap("scale_level", r) as ScaleLevelRow[]),
    sb.from("competence_area").select("id, code, name, sort_order")
      .eq("framework_id", fw.id).order("sort_order")
      .then((r) => unwrap("competence_area", r) as AreaRow[]),
    sb.from("competence_element").select("id, area_id, code, name, target_level, sort_order")
      .eq("framework_id", fw.id).order("sort_order")
      .then((r) => unwrap("competence_element", r) as CeRow[]),
    sb.from("control")
      .select("id, ce_id, code, indicator, description, active, priority, reason, kib_note, apm_competence, target_level, target_source, sort_order")
      .eq("framework_id", fw.id).order("sort_order").limit(5000)
      .then((r) => unwrap("control", r) as ControlRow[]),
    sb.from("benchmark_profile").select("id, name, sort_order")
      .eq("framework_id", fw.id).order("sort_order")
      .then((r) => unwrap("benchmark_profile", r) as BenchmarkProfile[]),
  ]);

    const controlIds = controlRows.map((c) => c.id);
    const [measureRows, targetRows] = await Promise.all([
    sb.from("measure").select("control_id, seq, text")
      .in("control_id", controlIds).order("seq").limit(5000)
      .then((r) => unwrap("measure", r) as MeasureRow[]),
    sb.from("benchmark_target").select("profile_id, apm_competence, level")
      .in("profile_id", profileRows.map((p) => p.id)).limit(5000)
      .then((r) => unwrap("benchmark_target", r) as TargetRow[]),
    ]);

    return {
      fw, scaleRow, levelRows, areaRows, ceRows, controlRows, profileRows,
      measureRows, targetRows,
    };
  },
  ["icb4-framework-rows"],
  { tags: [FRAMEWORK_TAG], revalidate: 3600 },
);

async function loadFramework(): Promise<FrameworkApi> {
  const {
    fw, scaleRow, levelRows, areaRows, ceRows, controlRows, profileRows,
    measureRows, targetRows,
  } = await fetchFrameworkRows();

  /* ---- assemble the domain shape the screens already expect ---- */

  const areaById = new Map(areaRows.map((a) => [a.id, a.name as AreaName]));
  const ceById = new Map(ceRows.map((c) => [c.id, c]));

  const levels: ScaleLevel[] = levelRows.map((l) => ({
    level: l.level as Level,
    label: l.label,
    knowledge: l.knowledge ?? "",
    application: l.application ?? "",
  }));
  const glosses = new Map<number, string>(
    levelRows.map((l) => [l.level, l.kib_gloss ?? l.application ?? ""]),
  );
  const scale: Scale = { name: scaleRow.name, axis: scaleRow.axis, levels };
  const labelByLevel = new Map(levels.map((l) => [l.level, l.label]));

  const controls: Control[] = controlRows.map((c) => {
    const ce = ceById.get(c.ce_id);
    const target = asLevel(c.target_level);
    return {
      id: c.id,
      code: c.code,
      ce_code: ce?.code ?? "",
      area: (ce ? areaById.get(ce.area_id) : undefined) ?? "Practice",
      indicator: c.indicator,
      description: c.description,
      active: c.active,
      priority: (c.priority as Priority | null) ?? null,
      reason: c.reason,
      kib_note: c.kib_note,
      apm_competence: c.apm_competence,
      target_level: target,
      target_label: target === null ? null : labelByLevel.get(target) ?? null,
      target_source: c.target_source,
    };
  });

  const controlById = new Map(controlRows.map((c) => [c.id, c]));
  const measures: Measure[] = measureRows.map((m) => {
    const c = controlById.get(m.control_id);
    const ce = c ? ceById.get(c.ce_id) : undefined;
    return {
      control_code: c?.code ?? "",
      ce_name: ce?.name ?? null,
      no: m.seq,
      text: m.text,
    };
  });

  const activeByCe = new Map<string, number>();
  for (const c of controls) {
    if (c.active) activeByCe.set(c.ce_code, (activeByCe.get(c.ce_code) ?? 0) + 1);
  }

  const competenceElements: CompetenceElement[] = ceRows.map((ce) => ({
    id: ce.id,
    code: ce.code,
    name: ce.name,
    area: areaById.get(ce.area_id) ?? "Practice",
    declared_controls: activeByCe.get(ce.code) ?? 0,
  }));

  const areas: Area[] = areaRows.map((a) => ({ code: a.code, name: a.name as AreaName }));

  // CE targets are APM PUBLISHED values, stored per element. Never computed.
  const ceTargets: CeTarget[] = ceRows.map((ce) => ({
    area: areaById.get(ce.area_id) ?? "Practice",
    ce_code: ce.code,
    ce_name: ce.name,
    active_controls: activeByCe.get(ce.code) ?? 0,
    target: asLevel(ce.target_level),
  }));

  // benchmark grid, one row per APM competence across the four profiles
  const profileNameById = new Map(profileRows.map((p) => [p.id, p.name]));
  const grid = new Map<string, Record<string, number | null>>();
  for (const t of targetRows) {
    const row = grid.get(t.apm_competence) ?? {};
    row[profileNameById.get(t.profile_id) ?? "?"] = t.level;
    grid.set(t.apm_competence, row);
  }
  const benchmarks: Benchmark[] = [...grid.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([apm, row], i) => ({
      no: i + 1,
      apm_competence: apm,
      // null in the database means APM marks this competence not relevant here
      entry: row.Entry ?? null,
      intermediate: row.Intermediate ?? null,
      advanced: row.Advanced ?? null,
      master: row.Master ?? null,
    }));

  const data: Framework = {
    source_file: `supabase://${FRAMEWORK_NAME} ${FRAMEWORK_VERSION}`,
    framework: `${fw.name} ${fw.version}`,
    scale,
    areas,
    competence_elements: competenceElements,
    controls,
    measures,
    benchmarks,
    ce_targets: ceTargets,
  };

  // targets by profile, so approval can snapshot the values actually applied
  const targetsByProfile = new Map<string, Map<string, Level | null>>();
  for (const p of profileRows) {
    const byCompetence = new Map<string, Level | null>();
    for (const t of targetRows) {
      if (t.profile_id === p.id) byCompetence.set(t.apm_competence, asLevel(t.level));
    }
    const byControl = new Map<string, Level | null>();
    for (const c of controls) {
      const published = c.apm_competence ? byCompetence.get(c.apm_competence) : undefined;
      // published wins; a control whose target was derived from priority
      // (target_source 'Derived (priority rule)') keeps its stored value
      byControl.set(c.code, published !== undefined ? published : c.target_level);
    }
    targetsByProfile.set(p.name, byControl);
  }

  return buildApi(data, {
    profiles: profileRows,
    glosses,
    targetsByProfile,
    controlIds: new Map(controls.map((c) => [c.code, c.id as string])),
  });
}

/* ------------------------------------------------------------- the api */

function buildApi(
  data: Framework,
  extra: {
    profiles: BenchmarkProfile[];
    glosses: Map<number, string>;
    targetsByProfile: Map<string, Map<string, Level | null>>;
    controlIds: Map<string, string>;
  },
): FrameworkApi {
  const activeControls = data.controls.filter((c) => c.active);
  const byCode = new Map(data.controls.map((c) => [c.code, c]));
  const positions = new Map(activeControls.map((c, i) => [c.code, i + 1]));
  const measuresByControl = new Map<string, Measure[]>();
  for (const m of data.measures) {
    const list = measuresByControl.get(m.control_code);
    if (list) list.push(m);
    else measuresByControl.set(m.control_code, [m]);
  }
  for (const list of measuresByControl.values()) {
    list.sort((a, b) => (a.no ?? 0) - (b.no ?? 0));
  }
  const ceByCode = new Map(data.competence_elements.map((c) => [c.code, c]));
  const labels = new Map(data.scale.levels.map((l) => [l.level, l.label]));

  return {
    data,
    scale: data.scale,
    scaleLevels: data.scale.levels,
    controls: data.controls,
    activeControls,
    profiles: extra.profiles,
    counts: {
      total: data.controls.length,
      active: activeControls.length,
      inactive: data.controls.length - activeControls.length,
      ces: data.competence_elements.length,
      measures: data.measures.length,
    },
    labelOf: (level) => (level === null ? "—" : labels.get(level) ?? String(level)),
    glossOf: (level) => extra.glosses.get(level) ?? "",
    controlByCode: (code) => byCode.get(code),
    controlIdByCode: (code) => extra.controlIds.get(code),
    measuresFor: (code) => measuresByControl.get(code) ?? [],
    ceOf: (code) => ceByCode.get(code),
    controlPosition: (code) => positions.get(code) ?? 0,
    neighbours: (code) => {
      const i = positions.get(code);
      if (i === undefined) return {};
      return { prev: activeControls[i - 2], next: activeControls[i] };
    },
    targetsForProfile: (name) =>
      extra.targetsByProfile.get(name) ??
      extra.targetsByProfile.get(DEFAULT_PROFILE) ??
      new Map(data.controls.map((c) => [c.code, c.target_level])),
  };
}

/* --------------------------------------------------------- redaction */

/**
 * The framework as an assessee may see it: no targets (they would anchor the
 * self-score), and none of the admin tuning layer — priority, reason and
 * kib_note all carry target provenance ("Senior baseline / junior target").
 *
 * This is the security boundary the eng plan calls critical: it lives in the
 * data layer so no page, action or serialized prop can leak past it.
 */
export async function getAssesseeFramework(): Promise<FrameworkApi> {
  const full = await getFramework();
  const redacted: Framework = {
    ...full.data,
    controls: full.data.controls.map((c) => ({
      ...c,
      priority: null,
      reason: null,
      kib_note: null,
      target_level: null,
      target_label: null,
      target_source: null,
    })),
    ce_targets: full.data.ce_targets.map((t) => ({ ...t, target: null })),
    benchmarks: [],
  };
  return buildApi(redacted, {
    profiles: full.profiles,
    glosses: new Map(full.scaleLevels.map((l) => [l.level, full.glossOf(l.level)])),
    targetsByProfile: new Map(),
    controlIds: new Map(
      full.data.controls.map((c) => [c.code, full.controlIdByCode(c.code) as string]),
    ),
  });
}
