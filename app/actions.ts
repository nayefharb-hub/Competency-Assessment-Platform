"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireRole, requireUser } from "@/lib/auth";
import { getFramework, invalidateFramework } from "@/lib/framework";
import { db } from "@/lib/supabase/server";
import {
  acceptAllRemaining, approveAssessment, getOrCreateAssessment, saveSelfScore,
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
 *  else's sheet. */
export async function saveSelfScoreAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const assessment = await getOrCreateAssessment(user.id);
  const code = String(formData.get("control") ?? "");
  const level = levelOf(formData.get("level"));
  const evidence = String(formData.get("evidence") ?? "").trim() || null;
  const next = String(formData.get("next") ?? "");

  if (level === null) fail(`/assess?c=${code}`, "Pick a level before moving on.");

  try {
    await saveSelfScore(user, assessment.id, code, level, evidence);
  } catch (e) {
    fail(`/assess?c=${code}`, e instanceof Error ? e.message : "Saving failed.");
  }

  revalidatePath("/assess");
  redirect(next ? `/assess?c=${next}` : "/assess/controls?saved=1");
}

export async function submitAssessmentAction(): Promise<void> {
  const user = await requireUser();
  const assessment = await getOrCreateAssessment(user.id);
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
