"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";
import { addPerson, resetPassword } from "@/lib/db/people";
import { assignAssessment, unassignAssessment } from "@/lib/db/assessment";
import type { UserRole } from "@/lib/types";

const ROLES: UserRole[] = ["assessee", "assessor", "admin"];

function back(params: Record<string, string>): never {
  redirect(`/admin/people?${new URLSearchParams(params)}`);
}

export async function addPersonAction(formData: FormData): Promise<void> {
  await requireRole("admin");

  const role = String(formData.get("role") ?? "assessee") as UserRole;
  if (!ROLES.includes(role)) back({ error: "Pick a valid role." });

  const result = await addPerson({
    email: String(formData.get("email") ?? ""),
    full_name: String(formData.get("full_name") ?? ""),
    job_title: String(formData.get("job_title") ?? "") || null,
    role,
    password: String(formData.get("password") ?? ""),
  });

  if (!result.ok) back({ error: result.error });

  revalidatePath("/admin/people");
  // The password is deliberately NOT echoed back in the URL — it would land in
  // browser history and server logs. The admin typed it; they have it.
  back({ added: String(formData.get("email") ?? "").trim().toLowerCase() });
}

/**
 * Assign the cycle. This is the act that brings an assessment into existence —
 * before it, a PM signing in has nothing to fill in, which is the point: the
 * completion denominator is now "people we asked", a fact somebody recorded,
 * rather than "people who happen to hold a login" (N7).
 */
export async function assignAction(formData: FormData): Promise<void> {
  const admin = await requireRole("admin");
  const ids = formData.getAll("assignee").map(String).filter(Boolean);
  if (ids.length === 0) back({ error: "Tick at least one person to assign." });

  // redirect() throws, so it must sit outside the try or the catch would treat
  // a successful assignment as a failure.
  let assigned = 0;
  try {
    ({ assigned } = await assignAssessment(admin, ids));
  } catch (e) {
    back({ error: e instanceof Error ? e.message : "Assigning failed." });
  }

  revalidatePath("/admin/people");
  revalidatePath("/review");
  back({ assigned: String(assigned) });
}

/** Withdraw an assignment nobody has started. */
export async function unassignAction(formData: FormData): Promise<void> {
  await requireRole("admin");
  const id = String(formData.get("assessment_id") ?? "");
  try {
    await unassignAssessment(id);
  } catch (e) {
    back({ error: e instanceof Error ? e.message : "Withdrawing failed." });
  }

  revalidatePath("/admin/people");
  revalidatePath("/review");
  back({ withdrawn: "1" });
}

export async function resetPasswordAction(formData: FormData): Promise<void> {
  const admin = await requireRole("admin");
  const userId = String(formData.get("user_id") ?? "");
  const password = String(formData.get("password") ?? "");

  if (userId === admin.id) {
    // Not a security rule, a usability one: an admin resetting their own
    // password here would be immediately bounced to /change-password to set it
    // again. That screen is the right place for it.
    back({ error: "Use Change password for your own account." });
  }

  const result = await resetPassword(userId, password);
  if (!result.ok) back({ error: result.error });

  revalidatePath("/admin/people");
  back({ reset: "1" });
}
