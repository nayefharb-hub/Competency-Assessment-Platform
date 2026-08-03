/**
 * Domain types for the ICB4 competency assessment.
 * Mirrors data/seed/icb4-framework.json (produced by the T0 extractor).
 */

/** APM Competence Framework 3rd Edition, Application axis. */
export type Level = 0 | 1 | 2 | 3 | 4 | 5;

export interface ScaleLevel {
  level: Level;
  /** Unaware · Aware · Practised · Competent · Proficient · Expert */
  label: string;
  knowledge: string;
  application: string;
}

export interface Scale {
  name: string;
  axis: string;
  levels: ScaleLevel[];
}

export type AreaName = "Perspective" | "People" | "Practice";

export interface Area {
  code: string;
  name: AreaName;
}

export interface CompetenceElement {
  /** e.g. "4.3.1" */
  code: string;
  name: string;
  area: AreaName;
  /** count of ACTIVE controls, as declared by the workbook's CE header row */
  declared_controls: number;
}

export type Priority = "High" | "Medium" | "Low";

export interface Control {
  /** e.g. "4.3.1.1" */
  code: string;
  ce_code: string;
  area: AreaName;
  indicator: string | null;
  description: string | null;
  /** Inactive controls contribute nothing to any rollup, gap or result. */
  active: boolean;
  priority: Priority | null;
  reason: string | null;
  /** KIB context/clarification — sits alongside the ICB4 text, never replaces it. */
  kib_note: string | null;
  apm_competence: string | null;
  target_level: Level | null;
  target_label: string | null;
  /** "APM (published)" | "Derived (priority rule)" */
  target_source: string | null;
}

export interface Measure {
  control_code: string;
  ce_name: string | null;
  no: number | null;
  text: string | null;
}

export interface Benchmark {
  no: number;
  apm_competence: string;
  entry: number | "N/R" | null;
  intermediate: number | "N/R" | null;
  advanced: number | "N/R" | null;
  master: number | "N/R" | null;
}

/** Per-CE target, taken from the workbook's Results sheet. Never computed. */
export interface CeTarget {
  area: AreaName;
  ce_code: string;
  ce_name: string;
  active_controls: number | null;
  target: Level | null;
}

export interface Framework {
  source_file: string;
  framework: string;
  scale: Scale;
  areas: Area[];
  competence_elements: CompetenceElement[];
  controls: Control[];
  measures: Measure[];
  benchmarks: Benchmark[];
  ce_targets: CeTarget[];
}

/* ---------- assessment ---------- */

export type AssessmentState = "draft" | "self_submitted" | "approved";

export interface Score {
  control_code: string;
  /** the PM's own score */
  self_level: Level | null;
  /** authoritative score — what results show. Defaults to self_level. */
  assessor_level: Level | null;
  /** true once the assessor has actually opened/changed this control */
  assessor_touched: boolean;
  evidence: string | null;
}

export interface Assessment {
  id: string;
  assessee_name: string;
  assessee_role: string;
  cycle: string;
  /** benchmark profile applied, e.g. "Intermediate" */
  profile: string;
  state: AssessmentState;
  scores: Score[];
}

/* ---------- rollup output ---------- */

export type Health = "ready" | "minor" | "deficit";

export interface CeResult {
  ce_code: string;
  ce_name: string;
  area: AreaName;
  target: Level | null;
  /** mean of assessor scores across ACTIVE controls; null when nothing is scored */
  actual: number | null;
  gap: number | null;
  health: Health | null;
  weakest: { control_code: string; level: Level } | null;
  scored_controls: number;
  active_controls: number;
}

export interface AreaResult {
  area: AreaName;
  target: number | null;
  actual: number | null;
  ce_count: number;
}
