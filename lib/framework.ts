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
import { phase } from "./perf";
import { ceTargetOf } from "./rollup";
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

/**
 * The single nested response, as PostgREST returns it: the same rows as before,
 * arranged by the foreign keys rather than fetched one table at a time.
 */
interface NestedFramework {
  id: string; name: string; version: string; scale_id: string;
  scale: { name: string; axis: string; scale_level: ScaleLevelRow[] | null };
  competence_area: AreaRow[] | null;
  competence_element: CeRow[] | null;
  control: (ControlRow & { measure: MeasureRow[] | null })[] | null;
  benchmark_profile: (BenchmarkProfile & { benchmark_target: TargetRow[] | null })[] | null;
}

const asLevel = (n: number | null | undefined): Level | null =>
  n === null || n === undefined ? null : (n as Level);

/* ------------------------------------------------------------------ load */

/**
 * ONE cache: an in-process memo, held for the life of the serverless instance.
 *
 * It was briefly TWO — the rows also went through Next's `unstable_cache` — on
 * the reasoning that a module-level cache dies with its instance and a
 * low-traffic app would pay the framework load constantly. The Vercel logs say
 * that reasoning was wrong on the fact it rested on: instances are reused
 * heavily, serving 23 to 31 requests each, and the framework loaded exactly once
 * per instance. So the memo amortises well on its own, and `unstable_cache` was
 * adding a NETWORK fetch of roughly a megabyte to the hot path in exchange for
 * saving a load that rarely happened.
 *
 * That is invisible locally, which is why it survived two rounds of
 * investigation: on disk the same cache reads in 2ms.
 *
 * The TTL is now long. An instance loads the framework once and keeps it, which
 * is the right shape for data that changes only when an admin edits it.
 *
 * THE TRADE, stated plainly: an admin edit is visible immediately on the
 * instance that made it (invalidateFramework clears the memo), and within
 * TTL_MS elsewhere. Ten minutes of a stale kib_note on another instance is
 * acceptable; a megabyte over the network on every render is not.
 */
const TTL_MS = 10 * 60_000;
let cache: { at: number; api: FrameworkApi } | null = null;
let inFlight: Promise<FrameworkApi> | null = null;

export function invalidateFramework(): void {
  cache = null;
  inFlight = null;
}

export async function getFramework(): Promise<FrameworkApi> {
  // A hit on the in-memory memo is free and is NOT logged; only the expensive
  // path is, so a quiet log means the memo is doing its job.
  if (cache && Date.now() - cache.at < TTL_MS) return cache.api;
  return phase("framework: 1 query + assemble 133 controls, 586 measures", getFrameworkUncached);
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
 * Every row the framework is built from — in ONE request.
 *
 * This was nine queries in three dependent waves, and the waves were the point:
 * measures needed control ids, targets needed profile ids. Measured against the
 * live database, that cost 600-730ms on every new serverless instance.
 *
 * The reason is not query time. Supabase charges a fixed ~31ms of gateway and
 * PostgREST overhead per REST call BEFORE the query is considered — returning a
 * single row costs the same as returning all 133 controls (183kB), which is how
 * we know it is per-request cost and not data volume. Nine calls therefore cost
 * nine floors, and firing six of them at once at a two-core instance makes each
 * one worse: individually they inflated from ~60ms to 180-360ms.
 *
 * PostgREST resolves the whole graph in one request through the foreign keys
 * that already exist, so the waves disappear along with eight of the floors.
 * Measured: 88ms server-side for the same 276kB.
 *
 * The rows are flattened back to the exact shapes loadFramework() already
 * expects, so the assembly below — and the API the screens use — is untouched.
 * This is a transport change and nothing else, which is what the seam is for.
 */
async function fetchFrameworkRows() {
  const nested = unwrap(
    "framework",
    await db()
      .from("framework")
      .select(
        [
          "id, name, version, scale_id",
          "scale:scale_id(name, axis, scale_level(level, label, knowledge, application, kib_gloss))",
          "competence_area(id, code, name, sort_order)",
          "competence_element(id, area_id, code, name, target_level, sort_order)",
          "control(id, ce_id, code, indicator, description, active, priority, reason," +
            " kib_note, apm_competence, target_level, target_source, sort_order," +
            " measure(control_id, seq, text))",
          "benchmark_profile(id, name, sort_order," +
            " benchmark_target(profile_id, apm_competence, level))",
        ].join(","),
      )
      .eq("name", FRAMEWORK_NAME)
      .eq("version", FRAMEWORK_VERSION)
      .maybeSingle(),
  ) as NestedFramework;

  // Ordering moves from the database to here. PostgREST can order embedded
  // resources, but the syntax is per-path and gets brittle three levels deep;
  // sorting arrays we are already walking is free by comparison. The orders
  // themselves are unchanged: sort_order everywhere, seq for measures, level
  // for the scale.
  const by = <T,>(rows: T[], key: (r: T) => number) => [...rows].sort((a, b) => key(a) - key(b));

  const controlRows: ControlRow[] = by(
    (nested.control ?? []).map(({ measure: _measure, ...c }) => c),
    (c) => c.sort_order,
  );

  return {
    fw: {
      id: nested.id, name: nested.name, version: nested.version, scale_id: nested.scale_id,
    },
    scaleRow: { name: nested.scale.name, axis: nested.scale.axis },
    levelRows: by(nested.scale.scale_level ?? [], (l) => l.level),
    areaRows: by(nested.competence_area ?? [], (a) => a.sort_order),
    ceRows: by(nested.competence_element ?? [], (c) => c.sort_order),
    controlRows,
    profileRows: by(nested.benchmark_profile ?? [], (p) => p.sort_order),
    measureRows: by(
      (nested.control ?? []).flatMap((c) => c.measure ?? []),
      (m) => m.seq,
    ),
    targetRows: (nested.benchmark_profile ?? []).flatMap((p) => p.benchmark_target ?? []),
  };
}

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

  // Grouped ONCE. The CE target needs every control of an element (ceTargetOf
  // applies the active rule itself), and filtering fw.controls per element would
  // walk all 133 rows 28 times for a number that is computed on every load.
  const activeByCe = new Map<string, number>();
  const controlsByCe = new Map<string, Control[]>();
  for (const c of controls) {
    if (c.active) activeByCe.set(c.ce_code, (activeByCe.get(c.ce_code) ?? 0) + 1);
    const list = controlsByCe.get(c.ce_code);
    if (list) list.push(c);
    else controlsByCe.set(c.ce_code, [c]);
  }

  const competenceElements: CompetenceElement[] = ceRows.map((ce) => ({
    id: ce.id,
    code: ce.code,
    name: ce.name,
    area: areaById.get(ce.area_id) ?? "Practice",
    declared_controls: activeByCe.get(ce.code) ?? 0,
  }));

  const areas: Area[] = areaRows.map((a) => ({ code: a.code, name: a.name as AreaName }));

  /*
   * CE targets are COMPUTED — the mean of the element's active control targets
   * (rollup-spec §3). This used to read `competence_element.target_level`, the
   * APM published value; that column is retained as the recoverable anchor and is
   * no longer read by anything.
   *
   * Same `ceTargetOf` the rollup engine uses, on purpose. These are the LIVE
   * values, which is what the framework screens should show; the results engine
   * calls it again with the approval snapshot, which is a question only it can
   * answer. One formula, two sets of inputs.
   */
  const ceTargets: CeTarget[] = ceRows.map((ce) => ({
    area: areaById.get(ce.area_id) ?? "Practice",
    ce_code: ce.code,
    ce_name: ce.name,
    active_controls: activeByCe.get(ce.code) ?? 0,
    target: ceTargetOf(controlsByCe.get(ce.code) ?? [], (c) => c.target_level),
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
 *
 * ONE THING IT DOES NOT COVER, since the CE target became computed (2026-08-08):
 * the ROLLUP no longer reads `ce_targets[].target`, so nulling it here does not
 * stop `rollupCe` deriving a CE target — and for an approved assessment it
 * derives one from `target_snapshot`, which lives on the assessment and is not
 * redacted by anything in this module. Redacting the framework is therefore not
 * sufficient to hide targets from a rollup. Nothing leaks today because the only
 * screen that rolls up is `/results`, which uses the full framework deliberately
 * and only after approval. See the note on `controlTarget` in lib/rollup.ts.
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
