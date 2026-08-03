#!/usr/bin/env node
/**
 * Invite a user. There is no public signup: this script is the invitation.
 *
 *   node --env-file=.env.local scripts/invite.mjs list
 *   node --env-file=.env.local scripts/invite.mjs add <email> <"Full Name"> [role] [--title "..."] [--password "..."]
 *   node --env-file=.env.local scripts/invite.mjs remove <email>
 *
 * role is assessee (default) | assessor | admin.
 *
 * It writes both halves of an account — the auth.users row and the public
 * app_user row — because app_user IS the allowlist: an auth account with no
 * app_user row is refused at sign-in. Without --password a random one is
 * generated and printed once; hand it over out of band and have the person
 * change it.
 *
 * Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (server-side only).
 */
import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) {
  console.error(
    "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.\n" +
      "  node --env-file=.env.local scripts/invite.mjs list",
  );
  process.exit(1);
}

const db = createClient(URL, KEY, { auth: { persistSession: false } });
const ROLES = ["assessee", "assessor", "admin"];

function flag(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1] ?? null;
}

function die(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

async function list() {
  const { data, error } = await db
    .from("app_user")
    .select("email, full_name, job_title, role")
    .order("role")
    .order("email");
  if (error) die(error.message);
  if (data.length === 0) {
    console.log("No users invited yet.");
    return;
  }
  console.log(`${data.length} invited:\n`);
  for (const u of data) {
    console.log(`  ${u.role.padEnd(9)} ${u.email.padEnd(32)} ${u.full_name}${u.job_title ? ` — ${u.job_title}` : ""}`);
  }
}

async function add() {
  const email = (process.argv[3] ?? "").trim().toLowerCase();
  const fullName = process.argv[4] ?? "";
  const role = process.argv[5] && !process.argv[5].startsWith("--") ? process.argv[5] : "assessee";
  const jobTitle = flag("title");
  const password = flag("password") ?? randomBytes(9).toString("base64url");

  if (!email.includes("@")) die("A valid email is required.");
  if (!fullName) die("A full name is required.");
  if (!ROLES.includes(role)) die(`role must be one of: ${ROLES.join(", ")}`);

  // Reuse the auth account if this person was invited before.
  let userId = null;
  const created = await db.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  });
  if (created.error) {
    const { data: page, error } = await db.auth.admin.listUsers({ perPage: 1000 });
    if (error) die(`${created.error.message} (and listing users failed: ${error.message})`);
    const existing = page.users.find((u) => u.email?.toLowerCase() === email);
    if (!existing) die(created.error.message);
    userId = existing.id;
    const reset = await db.auth.admin.updateUserById(userId, { password, email_confirm: true });
    if (reset.error) die(reset.error.message);
    console.log("• auth account already existed — password reset");
  } else {
    userId = created.data.user.id;
  }

  const { error } = await db.from("app_user").upsert(
    { id: userId, email, full_name: fullName, job_title: jobTitle, role },
    { onConflict: "id" },
  );
  if (error) die(`app_user write failed: ${error.message}`);

  console.log(`✓ invited ${email} as ${role}`);
  console.log(`  temporary password: ${password}`);
  console.log("  Send it out of band and have them change it.");
}

async function remove() {
  const email = (process.argv[3] ?? "").trim().toLowerCase();
  const force = process.argv.includes("--force");
  if (!email) die("Which email?");
  const { data, error } = await db.from("app_user").select("id").eq("email", email).maybeSingle();
  if (error) die(error.message);
  if (!data) die(`${email} is not on the allowlist.`);

  // `assessment.assessee_id` is `on delete cascade` from `app_user`, and
  // `score` and `target_snapshot` cascade from `assessment`. So deleting this
  // one row silently destroys their entire assessment — verified against a live
  // database: an approved record with 132 scores and 50 frozen targets vanished
  // in full. That is a reasonable thing to want, and a terrible default for a
  // command whose name suggests it only manages sign-in.
  const { count } = await db
    .from("assessment")
    .select("*", { count: "exact", head: true })
    .eq("assessee_id", data.id);

  if ((count ?? 0) > 0 && !force) {
    die(
      `${email} holds ${count} assessment${count === 1 ? "" : "s"}.\n` +
        `  Removing them DELETES it, along with every score and the targets frozen\n` +
        `  at approval. That also changes the completion figures for the cycle,\n` +
        `  with nothing left to show it happened.\n\n` +
        `  If that is genuinely what you want:  npm run invite remove ${email} --force`,
    );
  }

  const gone = await db.from("app_user").delete().eq("id", data.id);
  if (gone.error) die(gone.error.message);
  const authGone = await db.auth.admin.deleteUser(data.id);
  if (authGone.error) console.warn(`! app_user removed; auth account not deleted: ${authGone.error.message}`);
  console.log(`✓ ${email} removed from the allowlist`);
  if ((count ?? 0) > 0) console.log(`  ${count} assessment(s) deleted with them.`);
}

const command = process.argv[2] ?? "list";
const commands = { list, add, remove };
if (!commands[command]) die(`Unknown command "${command}". Use list | add | remove.`);
await commands[command]();
