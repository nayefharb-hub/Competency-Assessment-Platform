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
  /** database row id; absent when the framework came from the JSON seed */
  id?: string;
  /** e.g. "4.3.1" */
  code: string;
  name: string;
  area: AreaName;
  /** count of ACTIVE controls, as declared by the workbook's CE header row */
  declared_controls: number;
}

export type Priority = "High" | "Medium" | "Low";

export interface Control {
  /** database row id; absent when the framework came from the JSON seed */
  id?: string;
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

/**
 * Per-CE target. COMPUTED — the mean of the element's active control targets
 * (rollup-spec §3), so it is fractional and is displayed to one decimal.
 *
 * It used to be the APM published value read from the workbook's Results sheet.
 * That column (`competence_element.target_level`) still exists as the recoverable
 * anchor but nothing reads it any more.
 */
export interface CeTarget {
  area: AreaName;
  ce_code: string;
  ce_name: string;
  active_controls: number | null;
  target: number | null;
}

export interface Framework {
  source_file: string;
  framework: string;
  scale: Scale;
  areas: Area[];
  competence_elements: CompetenceElement[];
  controls: Control[];
  measures: Measure[];
  ce_targets: CeTarget[];
}

/* ---------- people ---------- */

export type UserRole = "assessee" | "assessor" | "admin";

export interface AppUser {
  id: string;
  email: string;
  full_name: string;
  job_title: string | null;
  role: UserRole;
  /**
   * Set when an admin creates the account or resets the password; cleared when
   * the user sets their own. Enforced in requireUser(), which refuses every
   * route except /change-password while it is true.
   */
  must_change_password: boolean;
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
  assessee_id?: string;
  assessee_name: string;
  assessee_role: string;
  cycle: string;
  /**
   * The profile row this assessment was stamped with. Kept because the column
   * is NOT NULL; no screen reads it and no rollup depends on it (N53).
   */
  profile_id?: string;
  state: AssessmentState;
  scores: Score[];
  /* completion instrumentation (T9) — the prototype's central metric */
  started_at?: string | null;
  submitted_at?: string | null;
  approved_at?: string | null;
  completed_at?: string | null;
  /** per-control targets frozen at approval; empty until approved */
  snapshot_targets?: Record<string, Level | null>;
  /** archived (N6): out of the cycle, excluded from every rollup and figure */
  deleted_at?: string | null;
  deleted_reason?: string | null;
}

/** Completion instrumentation — the prototype's whole thesis (T9). */
export interface CompletionStats {
  cycle: string;
  /**
   * People an admin actually assigned this cycle — one row per assignment, not
   * per login. Called `invited` until assignment existed, when it had to be
   * guessed from who held an account (N7).
   */
  assigned: number;
  started: number;
  /** self-assessment submitted — the "finished" flag */
  finished: number;
  approved: number;
  /** median hours from started_at to completed_at, over finished assessments */
  median_hours: number | null;
  /**
   * Archived this cycle — excluded from every figure above, and stated on
   * screen alongside them. Hiding an archive would let the headline number move
   * with nothing on record to explain it, which is the whole reason archiving
   * exists instead of deletion (N6).
   */
  archived: number;
  /** of those archived, how many had been finished — the ones that moved the median */
  archived_finished: number;
  rows: {
    assessment_id: string;
    assessee_name: string;
    state: AssessmentState;
    scored: number;
    active_controls: number;
    finished: boolean;
    hours: number | null;
  }[];
}

/* ---------- rollup output ---------- */

export type Health = "above" | "ready" | "minor" | "deficit";

export interface CeResult {
  ce_code: string;
  ce_name: string;
  area: AreaName;
  /**
   * mean of ACTIVE control targets — fractional since 2026-08-08, and taken from
   * `target_snapshot` once the assessment is approved (rollup-spec §3, §6)
   */
  target: number | null;
  /** mean of assessor scores across ACTIVE controls; null when nothing is scored */
  actual: number | null;
  gap: number | null;
  health: Health | null;
  weakest: { control_code: string; level: Level } | null;
  /**
   * Active controls sitting 2+ levels below their OWN target — the single-control
   * escalation rule. Recorded so the UI can say WHICH control forced a verdict,
   * rather than showing a label the numbers beside it appear to contradict.
   * Empty when nothing escalates. Worst shortfall first, ties by control code.
   */
  escalated_by: { control_code: string; level: Level; target: Level }[];
  /**
   * True when escalation is the ONLY reason health is "deficit" — i.e. the CE
   * mean would have read Role Ready or Minor Gap on its own. This is the case
   * that reads as a contradiction on screen (a CE at 3.0 against a target of 3
   * labelled Capability Deficit), so it is the case that needs explaining.
   * When the mean is ALSO more than half a level short, the label needs no
   * defence and the explanation would be noise.
   */
  escalation_drove_health: boolean;
  scored_controls: number;
  active_controls: number;
}

export interface AreaResult {
  area: AreaName;
  target: number | null;
  actual: number | null;
  ce_count: number;
}
