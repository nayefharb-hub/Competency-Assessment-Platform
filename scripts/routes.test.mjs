/**
 * safeNext — the in-app-path guard on `?next=`.
 *
 * WHY THIS FILE EXISTS AT ALL. The guard had end-to-end coverage already: four
 * hostile values driven through a real browser. A /review pass measured what
 * those four actually prove and the answer was nothing — every one of them is
 * refused by the OLD regex too, so all four stayed green with the fix reverted.
 * The comment in lib/routes.ts even names the input that escapes ("/\t/evil.com")
 * and the test used "/\tevil.test", one character different and harmless.
 *
 * A security test that cannot fail is worse than no test: it is four green ticks
 * telling the next reader the property is covered.
 *
 * So the payloads live here, in milliseconds, against the real exported function
 * rather than a copy — the two copies of the original inline regex are exactly
 * how the control-character bypass survived being noticed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { safeNext } from "../lib/routes.ts";

/** Where the browser would actually end up, given what safeNext returned. */
const APP = "https://app.invalid";
const lands = (next) => new URL(safeNext(next), APP).href;

test("a control character cannot smuggle an origin past the guard", () => {
  /* The WHATWG parser strips tab, CR and LF before resolving, so these survive
     a shape-only check as "an in-app path" and then resolve cross-origin. Tab
     is legal in an HTTP header value, so it reaches the wire in Location:. */
  for (const evil of ["/\t/evil.test", "/\r/evil.test", "/\n/evil.test"]) {
    assert.equal(safeNext(evil), "/", JSON.stringify(evil));
  }
});

test("traversal cannot pop the leading segment into a protocol-relative path", () => {
  /* The regression a /review pass caught: parsing alone returned "//evil.test"
     here, which the origin check passed honestly — it was asked about the
     INPUT — and the browser then read as protocol-relative. */
  for (const evil of [
    "/..//evil.test",
    "/./..//evil.test",
    "/foo/../..//evil.test",
    "/a/b/../../..//evil.test",
    "https://app.invalid//evil.test",
  ]) {
    assert.equal(safeNext(evil), "/", JSON.stringify(evil));
    assert.ok(lands(evil).startsWith(APP), `${JSON.stringify(evil)} left the origin`);
  }
});

test("the classic escapes are still refused", () => {
  for (const evil of [
    "//evil.test", "///evil.test", "/\\evil.test", "\\\\evil.test",
    "https://evil.test", "http://evil.test", "//user:pass@evil.test",
    "javascript:alert(1)", "data:text/html,x",
  ]) {
    assert.equal(safeNext(evil), "/", JSON.stringify(evil));
  }
});

test("nothing hostile reaches another origin, whatever it returns", () => {
  /* The property that actually matters, asserted on the resolved URL rather
     than on the returned string — a future rewrite that returns something
     other than "/" for these still has to keep them on this origin. */
  for (const evil of [
    "//evil.test", "/\t/evil.test", "/..//evil.test", "https://evil.test",
    "/..//evil.test?x=1#y", "//\tevil.test", "/..\\/evil.test",
  ]) {
    assert.ok(lands(evil).startsWith(APP + "/") || lands(evil) === APP + "/",
      `${JSON.stringify(evil)} -> ${lands(evil)}`);
  }
});

test("a legitimate in-app destination survives intact, query and hash included", () => {
  /* A guard that sends everyone to "/" is secure and useless: `?next=` exists
     so that being asked to sign in does not cost you the page you wanted. */
  for (const ok of ["/assess?c=4.3.1.1", "/review?a=1#top", "/admin/people", "/results?a=2&x=3"]) {
    assert.equal(safeNext(ok), ok);
  }
});

test("absent, empty and unparseable all land on the root", () => {
  for (const nothing of [null, undefined, "", "http://["]) {
    assert.equal(safeNext(nothing), "/", JSON.stringify(nothing));
  }
});

test("an odd but harmless path stays in the app rather than being thrown away", () => {
  /* "%" is not malformed to the URL parser — it is a one-character relative
     path — so it comes back as "/%" rather than "/". That is the right answer:
     the contract is "never leaves this origin", not "must look tidy". Asserted
     so nobody later tightens this into rejecting valid in-app destinations. */
  assert.equal(safeNext("%"), "/%");
  assert.ok(lands("%").startsWith(APP + "/"));
});
