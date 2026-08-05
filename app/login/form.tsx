"use client";

import { useActionState } from "react";
import { signIn, type SignInState } from "./actions";

/**
 * The sign-in form.
 *
 * A client component for one reason (N23): when sign-in fails, the address the
 * person typed has to survive. A server round trip through `/login?error=…`
 * renders an empty field, and the browser's autofill fills it with the saved
 * address — so the person is shown a value they did not type and cannot see
 * their own typo. `useActionState` returns the typed value in the response
 * instead, which also keeps every attempt out of the URL, browser history and
 * the access log.
 */
export default function SignInForm({ next }: { next?: string }) {
  const [state, action, pending] = useActionState<SignInState, FormData>(signIn, {});

  return (
    <>
      {state.error && (
        <div className="banner banner-error" role="alert">
          {state.error}
        </div>
      )}

      <form action={action}>
        <input type="hidden" name="next" value={next ?? "/"} />

        <div className="field">
          <label htmlFor="email">Work email</label>
          <input
            className="input"
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            required
            // Put back exactly what they typed. `key` forces React to accept
            // the new default after a failed attempt — without it the input
            // keeps whatever the browser had already placed there.
            key={state.email ?? ""}
            defaultValue={state.email ?? ""}
            // No domain hint: there is no domain restriction anywhere in the
            // code, and suggesting one implied a rule that does not exist.
            // The allowlist is the app_user table, not an email suffix.
            placeholder="Your email address"
          />
        </div>

        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            className="input"
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            placeholder="Your password"
          />
        </div>

        <button className="btn btn-primary" type="submit" disabled={pending} style={{ width: "100%" }}>
          {pending ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </>
  );
}
