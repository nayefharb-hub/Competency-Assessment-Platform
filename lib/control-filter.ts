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

export const AREAS = ["Perspective", "People", "Practice"] as const;
export type AreaFilter = (typeof AREAS)[number];

export type StateFilter = "all" | "active" | "inactive";
/** A level, or `none` for controls carrying no target at all. */
export type TargetFilter = "all" | "none" | Level;

export interface ControlFilter {
  area: AreaFilter | null;
  ce: string | null;
  state: StateFilter;
  target: TargetFilter;
}

export interface ControlFilterParams {
  area?: string;
  ce?: string;
  state?: string;
  target?: string;
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
  const area = AREAS.includes(params.area as AreaFilter) ? (params.area as AreaFilter) : null;
  /* A competency filter only means something inside its own area, and picking
     one implies the area — so `ce` wins and the area chips reflect it. */
  const ce = fw.data.competence_elements.some((e) => e.code === params.ce) ? params.ce! : null;
  const state: StateFilter =
    params.state === "active" || params.state === "inactive" ? params.state : "all";

  let target: TargetFilter = "all";
  if (params.target === "none") {
    target = "none";
  } else if (params.target !== undefined && /^[0-5]$/.test(params.target)) {
    /* Parsed strictly rather than with Number(): "3.5", " 3" and "3abc" all
       coerce to something, and a target is one of six discrete levels. */
    target = Number(params.target) as Level;
  }

  return { area, ce, state, target };
}

/** Is this control in the filtered view? */
export function matchesFilter(c: Control, f: ControlFilter, areaOfCe: (ce: string) => string): boolean {
  if (f.ce ? c.ce_code !== f.ce : f.area && areaOfCe(c.ce_code) !== f.area) return false;
  if (f.state === "active" && !c.active) return false;
  if (f.state === "inactive" && c.active) return false;
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
  return f.area !== null || f.ce !== null || f.state !== "all" || f.target !== "all";
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

  if (area) q.set("area", String(area));
  if (ce) q.set("ce", String(ce));
  if (state && state !== "all") q.set("state", String(state));
  /* `0` is a real target and must survive the query string — a truthiness test
     here would make "show me everything targeted Unaware" indistinguishable
     from "show me everything". */
  if (target !== null && target !== undefined && target !== "all") q.set("target", String(target));

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
