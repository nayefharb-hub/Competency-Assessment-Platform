/**
 * Loads the verified ICB4 seed data (data/seed/icb4-framework.json, produced and
 * checked by the T0 extractor) and provides lookup helpers.
 *
 * This is the temporary data source for the prototype. When Supabase is wired up,
 * only this module changes — screens and the rollup engine read through it.
 */
import raw from "@/data/seed/icb4-framework.json";
import type {
  Control, Framework, Level, Measure, ScaleLevel,
} from "./types";

export const framework = raw as unknown as Framework;

export const scaleLevels: ScaleLevel[] = framework.scale.levels;

/** Plain-language glosses shown beside each APM label while self-scoring.
 *  Faithful restatements of the APM Application wording — never a redefinition. */
export const LEVEL_GLOSS: Record<number, string> = {
  0: "I have no real awareness of this yet.",
  1: "I know it exists and understand the idea, but I haven’t really applied it.",
  2: "I can do this, but I still need guidance — mostly on straightforward projects.",
  3: "I do this on my own, on projects of limited complexity.",
  4: "I do this confidently on complex projects, and I coach others.",
  5: "I’m the person others come to; I adapt and improve how it’s done.",
};

export function labelOf(level: Level | null): string {
  if (level === null) return "—";
  return scaleLevels.find((s) => s.level === level)?.label ?? String(level);
}

export const activeControls: Control[] = framework.controls.filter((c) => c.active);

export function controlByCode(code: string): Control | undefined {
  return framework.controls.find((c) => c.code === code);
}

export function measuresFor(code: string): Measure[] {
  return framework.measures
    .filter((m) => m.control_code === code)
    .sort((a, b) => (a.no ?? 0) - (b.no ?? 0));
}

export function ceOf(code: string) {
  return framework.competence_elements.find((c) => c.code === code);
}

/** Position of a control within the ordered list of active controls (1-based). */
export function controlPosition(code: string): number {
  return activeControls.findIndex((c) => c.code === code) + 1;
}

export function neighbours(code: string): { prev?: Control; next?: Control } {
  const i = activeControls.findIndex((c) => c.code === code);
  return {
    prev: i > 0 ? activeControls[i - 1] : undefined,
    next: i >= 0 && i < activeControls.length - 1 ? activeControls[i + 1] : undefined,
  };
}

export const counts = {
  total: framework.controls.length,
  active: activeControls.length,
  inactive: framework.controls.length - activeControls.length,
  ces: framework.competence_elements.length,
  measures: framework.measures.length,
};
