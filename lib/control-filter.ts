/**
 * ONE definition of "which controls is the admin looking at right now".
 *
 * The framework table (`/admin/controls`) decides which rows exist, and the
 * editor (`/admin?c=…`) walks Previous/Next through that same set. Those are
 * two screens asking the same question, and this repository has already paid
 * for the answer being written twice: three screens each held their own copy of
 * "continue the assessment" and drifted apart (D29), and `commitLabel` held two
 * copies of "what happens next" and rendered a hint naming a button that was
 * not on screen.
 *
 * So the predicate, the ORDER and the query string live here. If Next walked a
 * different list than the table rendered, the admin would press Next on the
 * last row of a filtered view and land somewhere that view does not contain —
 * with nothing red anywhere, because each screen would be self-consistent.
 *
 * The order is the one the TABLE renders: competence elements in framework
 * order, and inside each, its controls in framework order. Not `fw.controls`
 * order — that happens to agree today, and "happens to agree" is what this
 * module exists to stop relying on.
 */
import type { Control, Level } from "./types";
import type { FrameworkApi } from "./framework";

/**
 * An area name. A STRING, not a union of the three ICB4 areas.
 *
 * This was `["Perspective", "People", "Practice"] as const`, which encoded one
 * framework's vocabulary into the filter layer. The whole premise of the app is
 * that ANY framework models as area -> competency -> control, so a filter that
 * only compiles against ICB4's three area names is the drift CLAUDE.md's
 * "framework as data, not constants" rule exists to prevent. Areas now come
 * from `competence_area`, like everything else.
 */
export type AreaFilter = string;

export type StateFilter = "all" | "active" | "inactive";
/** A level, or `none` for controls carrying no target at all. */
export type TargetFilter = "all" | "none" | Level;

/**
 * THE THREE SOURCES, and they are deliberately different.
 *
 * 1. FILTER CHIPS come from the values PRESENT IN THE DATA (`valuesInUse`
 *    below). A chip for a value no control carries is a dead control that
 *    teaches you to distrust the row — the owner's call, and the reason this
 *    replaced a version that rendered every scale level dimmed.
 *
 * 2. FILTER VALIDATION comes from the DEFINITION tables. A URL naming a level
 *    the scale defines but nothing currently uses is a legitimate question with
 *    the honest answer "no controls match" — silently widening it to all 133
 *    (the old regex behaviour) would answer a different question than the one
 *    asked. Only a value the framework cannot express falls back to everything.
 *
 * 3. THE EDITOR'S PICKER comes from the scale definition, in
 *    `app/admin/page.tsx`, and must NOT be data-derived. Deriving it from
 *    values in use would mean a level nothing targets could never be chosen —
 *    so the framework could never grow a new one. That is the trap in applying
 *    "pure data-derived" everywhere.
 *
 * Consequence worth knowing: retarget a control to a level nothing used, and
 * its chip appears immediately on the instance that saved (saveControlAction
 * calls invalidateFramework), and within the framework memo's TTL elsewhere.
 */
export interface FilterFacets {
  areas: { name: string; count: number }[];
  targets: { level: Level; label: string; count: number }[];
  priorities: { name: string; count: number }[];
  untargeted: number;
}

/** Which filter values the CURRENT framework data actually contains. */
export function valuesInUse(fw: FrameworkApi): FilterFacets {
  const areaOfCe = (code: string) =>
    fw.data.competence_elements.find((e) => e.code === code)?.area ?? "";

  const areaCounts = new Map<string, number>();
  for (const c of fw.controls) {
    const a = areaOfCe(c.ce_code);
    if (a) areaCounts.set(a, (areaCounts.get(a) ?? 0) + 1);
  }
  /* Ordered by the framework's own area order, not by count or alphabet — the
     sequence the standard publishes is the one people read in. */
  const areas = fw.data.areas
    .map((a) => ({ name: a.name as string, count: areaCounts.get(a.name) ?? 0 }))
    .filter((a) => a.count > 0);

  const targets = fw.scaleLevels
    .map((s) => ({
      level: s.level,
      label: s.label,
      count: fw.controls.filter((c) => c.target_level === s.level).length,
    }))
    .filter((t) => t.count > 0);

  /* Priority has NO definition table — it is a free column, unlike the scale and
     the areas. So the values present are the only truth there is about it, which
     makes it the purest case of the Excel-autofilter shape: whatever is in the
     column is what the dropdown offers. Ordered by frequency, because with no
     published order to honour there is no reason to prefer alphabetical. */
  const priorityCounts = new Map<string, number>();
  for (const c of fw.controls) {
    if (c.priority) priorityCounts.set(c.priority, (priorityCounts.get(c.priority) ?? 0) + 1);
  }
  const priorities = [...priorityCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  return {
    areas,
    targets,
    priorities,
    untargeted: fw.controls.filter((c) => c.target_level === null).length,
  };
}

export interface ControlFilter {
  area: AreaFilter | null;
  ce: string | null;
  state: StateFilter;
  target: TargetFilter;
  priority: string | null;
}

export interface ControlFilterParams {
  area?: string;
  ce?: string;
  state?: string;
  target?: string;
  priority?: string;
}

/**
 * Read the filter out of the query string, discarding anything the framework
 * cannot honour.
 *
 * UNKNOWN VALUES FALL BACK TO "everything", never to "nothing" (N44's rule): a
 * stale bookmark or a hand-edited URL must not present an empty framework as
 * if that were the truth.
 */
export function parseControlFilter(
  params: ControlFilterParams,
  fw: FrameworkApi,
): ControlFilter {
  /* Validated against the framework's DEFINED areas, not against the ones that
     happen to hold controls. An area that exists and is empty is a real thing
     to ask about; only a name the framework does not define falls back. */
  const area = fw.data.areas.some((a) => a.name === params.area)
    ? (params.area as AreaFilter)
    : null;
  /* A competency filter only means something inside its own area, and picking
     one implies the area — so `ce` wins and the area chips reflect it. */
  const ce = fw.data.competence_elements.some((e) => e.code === params.ce) ? params.ce! : null;
  const state: StateFilter =
    params.state === "active" || params.state === "inactive" ? params.state : "all";

  let target: TargetFilter = "all";
  if (params.target === "none") {
    target = "none";
  } else if (params.target !== undefined && /^\d+$/.test(params.target)) {
    /* Matched against the SCALE, not against a hardcoded 0-5. The digits-only
       test is there because "3.5", " 3" and "3abc" all coerce to something
       under Number(); the scale decides which integers are real.

       A level the scale defines but nothing currently targets survives here on
       purpose — the chip for it is absent, but a bookmark or a hand-typed URL
       gets the honest empty state rather than being silently widened to the
       whole framework. */
    const n = Number(params.target);
    if (fw.scaleLevels.some((s) => s.level === n)) target = n as Level;
  }

  /* Validated against the values PRESENT, not against a definition — there is
     no priority table to consult. A priority nothing carries therefore falls
     back to the whole framework (N44's rule), which is a deliberate difference
     from target and area: those have definitions, so an empty-but-defined value
     is a real question and gets an honest empty answer. */
  const priority = params.priority
    && fw.controls.some((c) => c.priority === params.priority)
      ? params.priority
      : null;

  return { area, ce, state, target, priority };
}

/** Is this control in the filtered view? */
export function matchesFilter(c: Control, f: ControlFilter, areaOfCe: (ce: string) => string): boolean {
  if (f.ce ? c.ce_code !== f.ce : f.area && areaOfCe(c.ce_code) !== f.area) return false;
  if (f.state === "active" && !c.active) return false;
  if (f.state === "inactive" && c.active) return false;
  if (f.priority && c.priority !== f.priority) return false;
  if (f.target === "none" && c.target_level !== null) return false;
  /* STRICT, because level 0 is a real target. Every completeness test in this
     codebase is a strict comparison for the same reason a bare truthiness test
     would silently erase everything scored "Unaware". */
  if (typeof f.target === "number" && c.target_level !== f.target) return false;
  return true;
}

/**
 * The filtered controls, in the order the table shows them.
 *
 * Grouped by competence element first, because that is what the table renders
 * and what Previous/Next therefore has to walk.
 */
export function filteredControls(fw: FrameworkApi, f: ControlFilter): Control[] {
  const areaOfCe = (code: string) =>
    fw.data.competence_elements.find((e) => e.code === code)?.area ?? "";
  const rows = fw.controls.filter((c) => matchesFilter(c, f, areaOfCe));
  return fw.data.competence_elements.flatMap((e) => rows.filter((c) => c.ce_code === e.code));
}

/** Whether anything is narrowed at all — drives the "showing N of M" line. */
export function isFiltered(f: ControlFilter): boolean {
  return f.area !== null || f.ce !== null || f.state !== "all"
    || f.target !== "all" || f.priority !== null;
}

/**
 * The filter as a query string, with an optional override of any one field.
 *
 * `undefined` means "leave this as it is"; `null` means "clear it". Defaults
 * are omitted so an unfiltered view has a clean URL.
 */
export function filterQuery(
  f: ControlFilter,
  next: Partial<Record<keyof ControlFilter, string | number | null>> = {},
): string {
  const pick = <K extends keyof ControlFilter>(key: K) =>
    next[key] === undefined ? f[key] : next[key];

  const q = new URLSearchParams();
  const area = pick("area");
  const ce = pick("ce");
  const state = pick("state");
  const target = pick("target");
  const priority = pick("priority");

  if (area) q.set("area", String(area));
  if (ce) q.set("ce", String(ce));
  if (state && state !== "all") q.set("state", String(state));
  /* `0` is a real target and must survive the query string — a truthiness test
     here would make "show me everything targeted Unaware" indistinguishable
     from "show me everything". */
  if (target !== null && target !== undefined && target !== "all") q.set("target", String(target));
  if (priority) q.set("priority", String(priority));

  return q.toString();
}

/** `/admin/controls` with the current filter applied. */
export function controlsHref(
  f: ControlFilter,
  next: Partial<Record<keyof ControlFilter, string | number | null>> = {},
): string {
  const qs = filterQuery(f, next);
  return qs ? `/admin/controls?${qs}` : "/admin/controls";
}

/** The editor for one control, carrying the filter so Previous/Next can walk it. */
export function editorHref(code: string, f: ControlFilter): string {
  const qs = filterQuery(f);
  return `/admin?c=${encodeURIComponent(code)}${qs ? `&${qs}` : ""}`;
}

/**
 * Where Previous and Next go from `code`, within the filtered view.
 *
 * A control the filter excludes still has neighbours: the admin can arrive at
 * one by typing a URL or following a stale link, and stranding them with two
 * dead buttons would be worse than offering the filtered set's own ends.
 */
export function filteredNeighbours(
  fw: FrameworkApi,
  f: ControlFilter,
  code: string,
): { prev?: Control; next?: Control; position: number; total: number } {
  const list = filteredControls(fw, f);
  const i = list.findIndex((c) => c.code === code);
  if (i === -1) return { prev: list[0], next: undefined, position: 0, total: list.length };
  return { prev: list[i - 1], next: list[i + 1], position: i + 1, total: list.length };
}
