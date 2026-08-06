/**
 * In-app routes that more than one screen has to agree on.
 *
 * ASSESS_HUB exists because the disagreement was the bug. Three screens each
 * claimed to "continue the assessment" and pointed at three different paths;
 * `/assess/areas` was built as the way in and then left with one inbound link,
 * so nothing went red when the others drifted. Typing the path into five call
 * sites again would rebuild exactly that. One export makes "there is exactly
 * one way in" greppable, and the e2e asserts against this constant rather than
 * a literal so a rename cannot leave a test agreeing with a stale copy.
 */
export const ASSESS_HUB = "/assess/areas";

/**
 * Normalise a `?next=` destination to an in-app path, or `/`.
 *
 * The old guard was `/^\/(?![/\\])/` written out at two call sites, and it let
 * a control character through. Measured:
 *
 *     "/\t/evil.com"  passes the regex
 *     new URL("/\t/evil.com", "https://app")  ->  https://evil.com/
 *
 * The WHATWG URL parser strips tab, CR and LF from a URL before resolving it,
 * so the value survives the check as "an in-app path" and then resolves
 * cross-origin at the browser. Tab is a legal HTTP header-value character, so
 * it reaches the wire in a `Location:` header. On a page that has just asked
 * for a bank password, a redirect chain starting at the real origin is a
 * credible hand-off to a phishing site.
 *
 * Parsing beats pattern-matching here: resolve against an opaque base and
 * require the origin to come back unchanged. Anything that escapes — protocol
 * relative, backslash, embedded control character, absolute URL — changes the
 * origin and is refused. Kept in one place because the two copies are exactly
 * how the control character survived being noticed.
 *
 * BOTH CHECKS, AND WHY NEITHER IS ENOUGH ALONE (/review, 2026-08-06). The first
 * version of this function did the parse and stopped there, which reopened the
 * hole it had just closed, one input over. Measured:
 *
 *     safeNext("/..//evil.com")  ->  "//evil.com"
 *     new URL("//evil.com", "https://app")  ->  https://evil.com/
 *
 * `..` pops the leading segment, so a path that RESOLVED same-origin against
 * the opaque base comes back starting with `//` — and that value is then handed
 * to redirect(), where the browser reads it as protocol-relative and leaves.
 * The origin check passed honestly; it was asked about the input, and the
 * danger is in the output.
 *
 * So the shape check is re-applied to the string actually returned. Parsing
 * removes the control-character bypass, the pattern removes the `//host`
 * bypass, and the order matters: pattern-then-parse would still hand back a
 * normalised value nobody re-examined.
 */
export function safeNext(next: string | null | undefined): string {
  if (!next) return "/";
  const BASE = "https://in-app.invalid";
  try {
    const u = new URL(next, BASE);
    if (u.origin !== BASE) return "/";
    const path = u.pathname + u.search + u.hash;
    // The returned value, not the input, is what a browser will resolve.
    return /^\/(?![/\\])/.test(path) ? path : "/";
  } catch {
    return "/";
  }
}
