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
