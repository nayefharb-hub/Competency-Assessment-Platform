"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireRole, requireUser } from "@/lib/auth";
import { getFramework, invalidateFramework } from "@/lib/framework";
import { phase, phaseSync } from "@/lib/perf";
import { db } from "@/lib/supabase/server";
import {
  acceptAllRemaining, approveAssessment, findAssessment, saveSelfScore,
  setAssessorLevels, submitSelfAssessment,
} from "@/lib/db/assessment";
import type { Level } from "@/lib/types";

function levelOf(raw: FormDataEntryValue | null): Level | null {
  if (raw === null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 5) return null;
  return n as Level;
}

function fail(path: string, message: string): never {
  redirect(`${path}${path.includes("?") ? "&" : "?"}error=${encodeURIComponent(message)}`);
}

/* ---------------------------------------------------------------- assessee */

/** Save one control's self-score and move on. Assessment is derived from the
 *  session, never from the form — a posted id would be a way to score someone
 *  else's sheet.
 *
 *  INSTRUMENTED (N18). This POST carries 253-986ms that is neither database nor
 *  rendering: the queries account for 190-436ms of it, and the response is a 303
 *  redirect, so no page is built here. The timers below split the remainder into
 *  the three things it can be — the reads, the write, and revalidatePath — so
 *  the next change is aimed rather than guessed. Remove them once it is. */
export async function saveSelfScoreAction(formData: FormData): Promise<void> {
  return phase("action: save score (whole action)", async () => {
    const user = await requireUser();
    const assessment = await phase("action: find assessment", () => findAssessment(user.id));
    if (!assessment) fail("/assess", "No assessment has been assigned to you for this cycle.");
    const code = String(formData.get("control") ?? "");
    const level = levelOf(formData.get("level"));
    const evidence = String(formData.get("evidence") ?? "").trim() || null;
    const next = String(formData.get("next") ?? "");

    if (level === null) fail(`/assess?c=${code}`, "Pick a level before moving on.");

    try {
      await phase("action: write the score", () =>
        saveSelfScore(user, assessment, code, level, evidence));
    } catch (e) {
      fail(`/assess?c=${code}`, e instanceof Error ? e.message : "Saving failed.");
    }

    // Kept, not removed. On a force-dynamic route there is no server cache to
    // invalidate, which is what made this look like dead weight — but it also
    // clears the CLIENT's router cache, and without that a client-side
    // navigation back to a scored control could show the pre-save payload.
    // So: measure it before touching it.
    phaseSync("action: revalidatePath", () => revalidatePath("/assess"));
    redirect(next ? `/assess?c=${next}` : "/assess/controls?saved=1");
  });
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
