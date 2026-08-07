/**
 * Unit tests for the admin framework filter — the one definition of "which
 * controls is the admin looking at", shared by the table and the editor's
 * Previous/Next. Run with `npm run test:unit`.
 *
 * Two of these exist because of specific ways this could break silently:
 *
 *   - LEVEL 0 IS A REAL TARGET. Every `if (target)` in the query-string path
 *     would drop `target=0` on the floor and show the admin all 133 controls
 *     while the chip still read as selected. Same trap as `answeredBefore` in
 *     commit-label, which the codebase already documents.
 *   - THE ORDER IS THE TABLE'S, NOT THE ARRAY'S. Previous/Next has to walk the
 *     rows in the order they are rendered — grouped by competence element —
 *     and `fw.controls` order only *happens* to agree today. The fixture below
 *     deliberately interleaves competencies so the two orders differ, which is
 *     the only way this test can fail when the grouping is dropped.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseControlFilter, matchesFilter, filteredControls, filteredNeighbours,
  filterQuery, controlsHref, editorHref, isFiltered,
} from "../lib/control-filter.ts";

/* Shaped like the real thing: competence_elements carry code/area/name, and
   controls carry code/ce_code/active/target_level. A stub more forgiving than
   lib/framework.ts would agree with a bug rather than catch it. */
const CES = [
  { code: "4.3.1", name: "Strategy", area: "Perspective" },
  { code: "4.3.2", name: "Governance", area: "Perspective" },
  { code: "4.4.1", name: "Self-reflection", area: "People" },
];

const ctl = (code, ce, { active = true, target = 3 } = {}) => ({
  code, ce_code: ce, active, target_level: target,
});

/* INTERLEAVED ON PURPOSE. Array order is 4.3.1.1, 4.3.2.1, 4.3.1.2, 4.4.1.1,
   4.3.2.2 — which is NOT competency-grouped order. Anything that walks
   `fw.controls` directly will disagree with the table, and these tests say so. */
const CONTROLS = [
  ctl("4.3.1.1", "4.3.1", { target: 3 }),
  ctl("4.3.2.1", "4.3.2", { target: 2 }),
  ctl("4.3.1.2", "4.3.1", { target: 0 }),
  ctl("4.4.1.1", "4.4.1", { target: 3, active: false }),
  ctl("4.3.2.2", "4.3.2", { target: null }),
];

const fw = {
  controls: CONTROLS,
  data: { competence_elements: CES },
};

const codes = (list) => list.map((c) => c.code);
const parse = (params) => parseControlFilter(params, fw);

/* ------------------------------------------------------------------ parsing */

test("unknown filter values fall back to the whole framework, never to nothing", () => {
  const f = parse({ area: "Nope", ce: "9.9.9", state: "maybe", target: "9" });
  assert.deepEqual(f, { area: null, ce: null, state: "all", target: "all" });
  assert.equal(filteredControls(fw, f).length, CONTROLS.length);
  assert.equal(isFiltered(f), false);
});

test("a target of 0 parses as the level, not as absent", () => {
  const f = parse({ target: "0" });
  assert.equal(f.target, 0);
  assert.equal(isFiltered(f), true);
  assert.deepEqual(codes(filteredControls(fw, f)), ["4.3.1.2"]);
});

test("a target is parsed strictly — no coercion of 3.5, ' 3' or '3abc'", () => {
  for (const bad of ["3.5", " 3", "3abc", "", "-1", "6"]) {
    assert.equal(parse({ target: bad }).target, "all", `"${bad}" should not parse as a level`);
  }
});

test("'none' selects only the controls carrying no target at all", () => {
  assert.deepEqual(codes(filteredControls(fw, parse({ target: "none" }))), ["4.3.2.2"]);
});

test("a competency wins over an area, because picking one implies the other", () => {
  const f = parse({ area: "People", ce: "4.3.1" });
  assert.equal(f.ce, "4.3.1");
  assert.deepEqual(codes(filteredControls(fw, f)), ["4.3.1.1", "4.3.1.2"]);
});

/* ---------------------------------------------------------------- composing */

test("area, state and target compose", () => {
  const f = parse({ area: "Perspective", state: "active", target: "2" });
  assert.deepEqual(codes(filteredControls(fw, f)), ["4.3.2.1"]);
});

test("the inactive filter finds only inactive controls", () => {
  assert.deepEqual(codes(filteredControls(fw, parse({ state: "inactive" }))), ["4.4.1.1"]);
});

test("matchesFilter agrees with filteredControls on every control", () => {
  const f = parse({ area: "Perspective" });
  const areaOfCe = (code) => CES.find((e) => e.code === code)?.area ?? "";
  const byPredicate = CONTROLS.filter((c) => matchesFilter(c, f, areaOfCe)).map((c) => c.code);
  assert.deepEqual(byPredicate.sort(), codes(filteredControls(fw, f)).sort());
});

/* ------------------------------------------------------------------ ordering */

test("the order is the table's — grouped by competency, not array order", () => {
  const all = codes(filteredControls(fw, parse({})));
  assert.deepEqual(all, ["4.3.1.1", "4.3.1.2", "4.3.2.1", "4.3.2.2", "4.4.1.1"]);
  // and that really is different from the raw array, or this proves nothing
  assert.notDeepEqual(all, codes(CONTROLS));
});

/* ---------------------------------------------------------------- neighbours */

test("Previous and Next walk the FILTERED set, skipping what the filter hides", () => {
  // Perspective only: 4.3.1.1, 4.3.1.2, 4.3.2.1, 4.3.2.2 — 4.4.1.1 is excluded.
  const f = parse({ area: "Perspective" });
  const at = filteredNeighbours(fw, f, "4.3.1.2");
  assert.equal(at.prev.code, "4.3.1.1");
  assert.equal(at.next.code, "4.3.2.1");
  assert.equal(at.position, 2);
  assert.equal(at.total, 4);
});

test("the ends of the filtered view have no neighbour beyond them", () => {
  const f = parse({ area: "Perspective" });
  const first = filteredNeighbours(fw, f, "4.3.1.1");
  assert.equal(first.prev, undefined);
  assert.equal(first.next.code, "4.3.1.2");

  const last = filteredNeighbours(fw, f, "4.3.2.2");
  assert.equal(last.prev.code, "4.3.2.1");
  assert.equal(last.next, undefined);
});

test("a control the filter excludes does not strand the admin with two dead ends", () => {
  // 4.4.1.1 is inactive, so an 'active' filter excludes it — but an admin can
  // still arrive by typing the URL, and must have a way back into the view.
  const f = parse({ state: "active" });
  const at = filteredNeighbours(fw, f, "4.4.1.1");
  assert.equal(at.position, 0);
  assert.ok(at.prev, "there must be somewhere to go from an excluded control");
});

test("a one-control view has no Previous and no Next", () => {
  const at = filteredNeighbours(fw, parse({ target: "0" }), "4.3.1.2");
  assert.equal(at.prev, undefined);
  assert.equal(at.next, undefined);
  assert.equal(at.total, 1);
});

/* --------------------------------------------------------------- query strings */

test("target=0 survives the round trip through the query string", () => {
  const f = parse({ target: "0" });
  const qs = filterQuery(f);
  assert.match(qs, /(^|&)target=0(&|$)/);
  // and comes back as the same filter, which is what makes Save keep the view
  assert.deepEqual(parse(Object.fromEntries(new URLSearchParams(qs))), f);
});

test("defaults are omitted, so an unfiltered view has a clean URL", () => {
  assert.equal(filterQuery(parse({})), "");
  assert.equal(controlsHref(parse({})), "/admin/controls");
});

test("an override of null clears one field and leaves the rest", () => {
  const f = parse({ area: "Perspective", state: "active", target: "2" });
  const cleared = new URLSearchParams(filterQuery(f, { target: null }));
  assert.equal(cleared.get("target"), null);
  assert.equal(cleared.get("area"), "Perspective");
  assert.equal(cleared.get("state"), "active");
});

test("the editor link carries the filter and encodes the control code", () => {
  const f = parse({ area: "Perspective", target: "0" });
  const href = editorHref("4.3.1.2", f);
  assert.match(href, /^\/admin\?c=4\.3\.1\.2&/);
  const q = new URLSearchParams(href.split("?")[1]);
  assert.equal(q.get("area"), "Perspective");
  assert.equal(q.get("target"), "0");
});

test("an unfiltered editor link carries no stray separator", () => {
  assert.equal(editorHref("4.3.1.1", parse({})), "/admin?c=4.3.1.1");
});
