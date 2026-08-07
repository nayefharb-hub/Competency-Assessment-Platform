"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { authClient, forgetViewer, requireUser } from "@/lib/auth";
import { db } from "@/lib/supabase/server";

/** Long enough to matter, short enough that nobody writes it on a sticky note. */
const MIN_LENGTH = 10;

function fail(message: string): never {
  redirect(`/change-password?error=${encodeURIComponent(message)}`);
}

/**
 * Sets the signed-in user's own password and clears the must-change flag.
 *
 * Uses the CURRENT SESSION (`auth.updateUser`), not the admin API — so this
 * works with no email, no SMTP, and no way for anyone else to learn the value.
 * That is the whole reason the interim scheme is admin-sets-then-user-replaces
 * rather than emailed links.
 */
export async function changePasswordAction(formData: FormData): Promise<void> {
  // skipPasswordGate: this page is the one route a flagged user may reach.
  const user = await requireUser({ skipPasswordGate: true });

  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  if (password.length < MIN_LENGTH) {
    fail(`Use at least ${MIN_LENGTH} characters.`);
  }
  if (password !== confirm) {
    fail("The two passwords do not match.");
  }

  const auth = await authClient();
  const { error } = await auth.auth.updateUser({ password });
  if (error) {
    // Supabase rejects a password identical to the current one, which is the
    // likely case here: someone re-typing the one the admin gave them.
    fail(
      error.message.toLowerCase().includes("different")
        ? "Pick a password different from the one you were given."
        : error.message,
    );
  }

  const cleared = await db()
    .from("app_user")
    .update({ must_change_password: false })
    .eq("id", user.id)
    .select("id");
  if (cleared.error) fail(`Password changed, but clearing the prompt failed: ${cleared.error.message}`);

  /* N45. The flag is now false in Postgres, but this request has already cached
     a viewer that says otherwise: `requireUser` above populated `viewerMemo` on
     the way in, keyed by access token, with a 2s life. The redirect below
     renders as a second pass of this same request — comfortably inside that
     window — so without this it answers from the memo, still sees the flag, and
     sends the PM straight back to the screen they just finished. First thing
     they ever do in this app, no explanation offered.

     AFTER the write, deliberately: evicting before it would reopen the same
     race in a smaller box. `signOut()` has always done this; the password
     change was the one credential change that did not. */
  await forgetViewer();

  revalidatePath("/", "layout");
  redirect("/?password_changed=1");
}
