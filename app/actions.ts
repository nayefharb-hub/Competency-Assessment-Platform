"use server";

import { redirect, unstable_rethrow } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireRole, requireUser } from "@/lib/auth";
import { sanitiseDwell } from "@/lib/dwell";
import { getFramework, invalidateFramework } from "@/lib/framework";
import { phase, phaseSync } from "@/lib/perf";
import { db } from "@/lib/supabase/server";
import {
  acceptAllRemaining, approveAssessment, findAssessment, saveSelfScore,
  setAssessorLevels, submitSelfAssessment,
} from "@/lib/db/assessment";
import type { Level } from "@/lib/types";

function levelOf(raw: FormDataEntryValue | number | null): Level | null {
  if (raw === null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 5) return null;
  return n as Level;
}

function fail(path: string, message: string): never {
  redirect(`${path}${path.includes("?") ? "&" : "?"}error=${encodeURIComponent(message)}`);
}

/* ---------------------------------------------------------------- assessee */

/**
 * Save one control's self-score. The assessment is derived from the SESSION,
 * never from the client — a posted id would be a way to score someone else's
 * sheet.
 *
 * Returns `{ ok }` rather than redirecting, because the outbox needs to know
 * whether the write landed: drop the entry, or keep it and retry. (The former
 * form-based action that ended in `redirect()` was removed with the save-UX
 * change — nothing posts a form here any more, and its instrumentation
 * described a measurement two rounds out of date.)
 *
 * No `revalidatePath`: the PM has already navigated by the time this runs, and
 * the destination fetched its own data. Invalidating here would refetch a page
 * nobody is looking at.
 */
export async function commitSelfScoreAction(
  control: string,
  level: number,
  evidence: string | null,
  /** The account that CONFIRMED this answer — see below. */
  committedBy: string,
  /**
   * Milliseconds the control was on screen (D28). Client-supplied and
   * therefore not trusted: `sanitiseDwell` drops anything out of range, and a
   * missing or unbelievable value is stored as NULL. It never affects whether
   * the score itself is saved — the answer is the thing that matters, and a
   * broken clock must not cost a PM their answer.
   */
  dwellMs?: number | null,
): Promise<{ ok: true } | { ok: false; error: string; reject?: boolean }> {
  try {
    const user = await requireUser();

    // The queue outlives the page, and a server action posts with whatever
    // session cookie the browser holds NOW. Those are not always the same
    // person: leave a tab open with a failed save, let a colleague sign in on
    // the same machine, and the stale tab's retry timer would write one PM's
    // answer into the other's assessment — authoritative input to an
    // assessor's sheet, from someone who never gave it.
    //
    // `reject` rather than a retry: the mismatch cannot resolve itself, and
    // retrying it every 30 seconds only widens the window. The answer stays
    // in its owner's own mirror, under their own key, for when they return.
    if (user.id !== committedBy) {
      console.warn(`[commit] refused ${control}: queued by ${committedBy}, session is ${user.id}`);
      return { ok: false, reject: true, error: "That answer belongs to a different account." };
    }
    const assessment = await findAssessment(user.id);
    if (!assessment) return { ok: false, error: "No assessment is assigned to you." };
    const lvl = levelOf(level);
    if (lvl === null) return { ok: false, error: "That is not a valid level." };
    await saveSelfScore(user, assessment, control, lvl, evidence, sanitiseDwell(dwellMs));
    return { ok: true };
  } catch (e) {
    // requireUser() answers "not signed in", "not on the allowlist" and "must
    // change password" by CALLING redirect(), which works by throwing. Catching
    // that turns a navigation into a permanent, silent failure: the outbox
    // would keep an expired session's answers queued and retry them every 30
    // seconds forever, showing a count and never saying "sign in again".
    // unstable_rethrow puts framework control-flow back where it belongs; it
    // is Next's own supported way to do this inside a catch.
    unstable_rethrow(e);

    // Anything reaching here is a genuine failure. The detail goes to the
    // server log, not to the browser: messages like "Supabase assessment
    // lookup failed: <constraint>" describe our schema to whoever is looking.
    console.error(`[commit] ${control}: ${e instanceof Error ? e.message : String(e)}`);
    return { ok: false, error: "Saving failed. It will be retried." };
  }
}

export async function submitAssessmentAction(): Promise<void> {
  const user = await requireUser();
  const assessment = await findAssessment(user.id);
  if (!assessment) fail("/assess/controls", "No assessment has been assigned to you for this cycle.");
  try {
    await submitSelfAssessment(user, assessment.id);
  } catch (e) {
    fail("/assess/controls", e instanceof Error ? e.message : "Submitting failed.");
  }
  revalidatePath("/", "layout");
  redirect("/assess/controls?submitted=1");
}

/* ---------------------------------------------------------------- assessor */

/** Saves every level the assessor actually changed, in one round trip. */
export async function saveRevisionsAction(formData: FormData): Promise<void> {
  await requireRole("assessor", "admin");
  const id = String(formData.get("assessment") ?? "");
  const changes: { control_code: string; level: Level }[] = [];

  for (const [key, value] of formData.entries()) {
    if (!key.startsWith("level:")) continue;
    const code = key.slice("level:".length);
    const level = levelOf(value);
    const before = levelOf(formData.get(`was:${code}`));
    if (level !== null && level !== before) changes.push({ control_code: code, level });
  }

  try {
    await setAssessorLevels(id, changes);
  } catch (e) {
    fail(`/review?a=${id}`, e instanceof Error ? e.message : "Saving failed.");
  }
  revalidatePath("/review");
  redirect(`/review?a=${id}&revised=${changes.length}`);
}

export async function acceptAllAction(formData: FormData): Promise<void> {
  await requireRole("assessor", "admin");
  const id = String(formData.get("assessment") ?? "");
  let filled = 0;
  try {
    filled = await acceptAllRemaining(id);
  } catch (e) {
    fail(`/review?a=${id}`, e instanceof Error ? e.message : "Accepting failed.");
  }
  revalidatePath("/review");
  redirect(`/review?a=${id}&accepted=${filled}`);
}

export async function approveAction(formData: FormData): Promise<void> {
  const user = await requireRole("assessor", "admin");
  const id = String(formData.get("assessment") ?? "");
  try {
    await approveAssessment(user, id);
  } catch (e) {
    fail(`/review?a=${id}`, e instanceof Error ? e.message : "Approving failed.");
  }
  revalidatePath("/", "layout");
  redirect(`/results?a=${id}&approved=1`);
}

/* ------------------------------------------------------------------- admin */

/**
 * Framework admin over the tunable layer only. `indicator` and `description`
 * are ICB4 source text and are not accepted here at any price — that is what
 * keeps year-over-year comparison meaningful.
 */
export async function saveControlAction(formData: FormData): Promise<void> {
  await requireRole("admin");
  const code = String(formData.get("control") ?? "");
  const fw = await getFramework();
  const control = fw.controlByCode(code);
  if (!control?.id) fail("/admin", `Unknown control ${code}`);

  const active = String(formData.get("active") ?? "yes") === "yes";
  const priority = String(formData.get("priority") ?? "High");
  const reason = String(formData.get("reason") ?? "").trim() || null;
  const kibNote = String(formData.get("kib_note") ?? "").trim() || null;
  const target = levelOf(formData.get("target"));

  if ((!active || priority !== "High") && !reason) {
    fail(`/admin?c=${code}`, "A reason is required whenever a control is not Active/High.");
  }
  if (!["High", "Medium", "Low"].includes(priority)) {
    fail(`/admin?c=${code}`, "Priority must be High, Medium or Low.");
  }

  const write = await db()
    .from("control")
    .update({
      active,
      priority,
      reason,
      kib_note: kibNote,
      target_level: target,
      // Editing the target by hand detaches it from the published APM value;
      // say so rather than leaving a stale provenance label.
      target_source:
        target === control.target_level ? control.target_source : "KIB (admin edit)",
    })
    .eq("id", control.id);
  if (write.error) fail(`/admin?c=${code}`, `Saving failed: ${write.error.message}`);

  invalidateFramework();
  revalidatePath("/", "layout");
  redirect(`/admin?c=${code}&saved=1`);
}
