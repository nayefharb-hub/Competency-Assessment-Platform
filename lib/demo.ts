/**
 * Demo assessment for the prototype walkthrough.
 *
 * Deterministic sample scores so the results and review screens render with the
 * real 132-control framework. Replaced by real data once Supabase is wired.
 */
import { activeControls } from "./framework";
import type { Assessment, Level, Score } from "./types";

/** Deterministic pseudo-random so every render/build shows the same profile. */
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Scores cluster around each control's target, with a few deliberate gaps. */
function sampleLevel(code: string, target: Level | null): Level {
  const base = target ?? 2;
  const r = hash(code) % 10;
  let lv = base;
  if (r < 2) lv = base - 2;      // occasional severe gap
  else if (r < 5) lv = base - 1; // common minor gap
  else if (r > 8) lv = base + 1; // occasional above target
  return Math.max(0, Math.min(5, lv)) as Level;
}

const scores: Score[] = activeControls.map((c) => {
  const self = sampleLevel(c.code, c.target_level);
  // the assessor accepted most scores and revised a few
  const revise = hash(c.code + "x") % 7 === 0;
  const assessor = revise
    ? (Math.max(0, Math.min(5, self + ((hash(c.code) % 2) ? 1 : -1))) as Level)
    : self;
  return {
    control_code: c.code,
    self_level: self,
    assessor_level: assessor,
    assessor_touched: revise,
    evidence: null,
  };
});

export const demoAssessment: Assessment = {
  id: "demo-2026",
  assessee_name: "Reem Al-Sabah",
  assessee_role: "Senior Project Manager",
  cycle: "2026",
  profile: "Intermediate",
  state: "approved",
  scores,
};

export const reviewCoverage = {
  touched: scores.filter((s) => s.assessor_touched).length,
  total: scores.length,
};
