# Engineering plan — the competency target becomes the mean of its control targets

**Status:** plan, for `/plan-eng-review`.
**Contract already amended:** `docs/rollup-spec.md` §3, §4, §6, §7 (commit `6a4be6c`).
**Owner's decision (2026-08-08):** *"always have the competency be an average of the
target scores, for the pilot."*
**Branch:** `claude/cap-supabase-integration-ubitap` · PR #26 (draft).

This plan covers the code change only. The product decision was made in
`/office-hours` and written into the spec; nothing here re-opens it.

---

## 1. What changes, in one line

`target(CE)` stops being `competence_element.target_level` (an integer seeded
from APM) and becomes `mean(target_level over ACTIVE controls in that CE that
have a target)` — a fraction.

## 2. Why (recorded, not re-argued)

Two independently seeded numbers drifted. On today's data:

| | |
|---|---|
| CEs where the published target ≠ the mean of its control targets | **6 of 28** |
| …of those, CEs that give **Minor Gap to a PM who hit every single control target** | **4** — 4.3.1 (3 vs 2.60), 4.3.2 (3 vs 2.67), 4.3.3 (3 vs 2.83), 4.5.8 (3 vs 2.60) |
| …and CEs where the mean sits *above* the published bar (silent slack) | **2** — 4.5.1 (2 vs 2.20), 4.5.13 (2 vs 2.50) |
| Controls whose target already equals their CE's published target | **123 of 133** — the proof the two are independently sourced, not derived |

Recomputed from `data/seed/icb4-framework.json` while writing this plan; the
same figures are in the spec.

## 3. Where the formula lives — **one function, two callers**

The formula is needed in two places and that is the main architectural risk in
this change:

| Caller | Which control targets it must use |
|---|---|
| `rollupCe()` — the results/health engine | the **snapshot** for approved assessments, the live framework before that (`controlTarget()`, already exists) |
| `lib/framework.ts` — builds `Framework.ce_targets`, read by the review screen and the admin table | the live framework |

Two copies of one mean is exactly how the CE target and the control targets
drifted apart in the first place. So:

```ts
// lib/rollup.ts — exported, pure, no server-only import
/**
 * CE target = mean of ACTIVE control targets (rollup-spec §3).
 * Takes EVERY control in the CE and filters `active` itself, so "inactive
 * contributes nothing" is stated once rather than at each call site.
 */
export function ceTargetOf(
  controls: Control[],
  targetOf: (c: Control) => Level | null,
): number | null
```

- `rollupCe` calls it with `controlTarget(c, snapshot)`.
- `lib/framework.ts` calls it with `c.target_level` when assembling `ce_targets`.

`lib/framework.ts` importing `lib/rollup.ts` introduces no cycle: `rollup.ts`
imports `./types` only, and type-only at that.

**Rejected alternative:** compute it in `framework.ts` only and have `rollupCe`
read `fw.ce_targets`. That is fewer lines and it is wrong — `fw.ce_targets`
knows nothing about `target_snapshot`, so an approved assessment's competency
target would silently follow a later benchmark change. Spec §6 requires the
opposite.

**Rejected alternative:** compute it in SQL (a view, or a generated column).
It would have to be computed twice anyway — once over `control`, once over
`target_snapshot` — and it would put a domain rule outside the seam that exists
to keep the framework swappable.

## 4. The diff

### 4.1 `lib/rollup.ts`
- Header comment line 6: `target(CE) = the APM published value (NEVER computed or averaged)` → the new rule, pointing at spec §3.
- Add `ceTargetOf()` as above.
- `healthOf(actual, target: Level | null, …)` → `target: number | null`. No body change: the comparison was always arithmetic on numbers.
- Line 109 `const target = ceTarget?.target ?? null;` → `ceTargetOf(controlsOfCe, (c) => controlTarget(c, snapshot))`, where `controlsOfCe` is every control in the CE (active or not) — `activeControlsOf()` stays where it is for the `actual` mean and the `active_controls` count.
- `rollupAreas` unchanged; it already sums `r.target as number`.

### 4.2 `lib/types.ts`
- `CeTarget.target: Level | null` → `number | null`, and the doc comment *"taken from the workbook's Results sheet. Never computed."* is now false — rewrite it.
- `CeResult.target: Level | null` → `number | null`.
- `AreaResult.target` is already `number | null`.
- `CeResult.escalated_by[].target` stays `Level` — that is a **control** target and remains an integer. The single-control escalation rule is unchanged by this plan.

### 4.3 `lib/framework.ts`
- `ce_targets` assembly (line ~312): `target: asLevel(ce.target_level)` → `ceTargetOf(controlsByCe.get(ce.code) ?? [], (c) => c.target_level)`. The `controls` array is already built above it; group it once rather than filtering per CE.
- The comment *"CE targets are APM PUBLISHED values, stored per element. Never computed."* is replaced.
- **Redaction is unaffected and must stay that way.** `getAssesseeFramework()` nulls `ce_targets[].target` explicitly, and it also nulls every `control.target_level` — so even if the explicit line were dropped, recomputing over the redacted controls yields `null`. Belt and braces; keep the explicit line, and keep the existing e2e redaction assertion.

### 4.4 Displays — one decimal everywhere (spec §7)
| File | Now | After |
|---|---|---|
| `app/results/page.tsx:63` | `/ {r.target ?? "—"}` | `/ {fmtLevel(r.target)}` |
| `app/results/page.tsx:56` | `pct(r.target)` tick | unchanged — already takes a number |
| `app/review/page.tsx:111` | `…?.target ?? "—"` | `fmtLevel(…?.target ?? null)` |
| `app/admin/controls/page.tsx:194` | `` ` · competency target ${t}` `` | `` ` · competency target ${fmtLevel(t)}` `` |

`fmtLevel` already returns `n.toFixed(1)` and `"—"` for null, so all three
become the same call and the em-dash fallbacks disappear. `app/review` and
`app/admin/controls` do not currently import it; they will.

`app/results/page.tsx:41` (`against target ${first.target}`) is a **control**
target inside the escalation note — integer, unchanged.

### 4.5 `docs/rollup-spec.md` — one honest addition to §6
§6 now claims approved assessments are historical "by construction". That is
true of the target values and **not** of `active`: the snapshot freezes
`target_level` per control but not the active flag, so deactivating a control
after approval moves an approved CE's target — and always moved its `actual`
too. Pre-existing, unchanged by this diff, and now stated rather than implied.

## 5. What deliberately does not change

| | Why |
|---|---|
| `competence_element.target_level` (the column) | Retained as the recoverable APM anchor (spec §3). Still written by `scripts/seed.mjs`, still captured by `scripts/framework-baseline.mjs`. Read by the rollup: **no**. |
| No new `CeTarget.published` field | The admin screen is where control targets are *edited*; a second competency number beside the first re-creates the "which one applies?" question this change exists to delete. The anchor lives in the database and in `data/baseline/framework-tunable.json`. |
| Round-trip budgets (5 warm commit + navigation, 3 on completion) | The change is in-memory arithmetic over rows already fetched. No new query. `scripts/e2e.mjs` assertions unchanged, and that is itself the check. |
| Profile-awareness before approval | `controlTarget()` falls back to `c.target_level` (the stored value), not `targetsForProfile(assessment.profile)`, so a pre-approval assessment on a non-default profile already judges against stored targets. Pre-existing; the CE target now simply inherits the same behaviour consistently. **Out of scope**, recorded here so it is not discovered as new. |
| Weighting | Parked; 112 of 132 controls are High. |
| `docs/design-framework-profiles.md` (N52) | Explicitly not being built. |

## 6. Tests

**The engine has no unit tests today.** `npm run test:unit` covers ttl-map,
shape, pace, routes, outbox, commit-label and control-filter — not rollup. This
change is the moment that stops being acceptable, because it moves the
definition of the number the whole product reports.

New `scripts/rollup.test.mjs`, added to the `test:unit` script:

1. **The regression, and it must be shown RED first** (ground rule 0): a CE with
   active control targets `[3, 3, 2]` and a published CE target of `3`; the PM
   scores exactly the control target on every control. Today: `target 3`,
   `actual 2.667`, **Minor Gap**. After: `target 2.667`, gap `0`, **Role Ready**.
   This is 4.3.2 in miniature. It fails on `HEAD` and passes after.
2. Inactive controls contribute to neither the mean nor the target — a CE where
   the inactive control carries an outlier target.
3. A CE where no active control has a target → `target` null → `health` null →
   `fmtLevel` renders `—`, never `0.0`.
4. **Snapshot wins over the live framework** (spec §6): approve-time targets in
   `snapshot_targets` differ from `control.target_level`; the CE target follows
   the snapshot. This is the assertion that catches a future "simplification"
   back to reading `fw.ce_targets`.
5. Compare before rounding (spec §4): `target 2.6` vs `actual 2.1` is a gap of
   `0.5` → **Minor Gap**. Rounding the target to `3` first would make it a
   Capability Deficit. Boundary, on purpose.
6. Single-control escalation still fires and still reports an **integer**
   control target — the escalation path must not pick up the fractional CE
   number.
7. `rollupAreas` over fractional CE targets.

`node --experimental-strip-types` already lets the `.mjs` tests import `.ts`
directly (`scripts/control-filter.test.mjs` does), and `lib/rollup.ts` has no
`server-only` import, so no test-only seam is needed.

**e2e:** the existing approve-and-snapshot section (`scripts/e2e.mjs` ~1952)
already asserts the snapshot is written; add an assertion that an approved
assessment's rendered CE target is the mean of its *snapshotted* control
targets, so §6 is covered on the running app and not only in a unit test.

## 7. Order of work

1. Write `scripts/rollup.test.mjs`; run it on `HEAD`; **paste the red output**.
2. `lib/rollup.ts` + `lib/types.ts`.
3. `lib/framework.ts`.
4. The three displays.
5. `docs/rollup-spec.md` §6 sentence; `docs/STATUS.md`.
6. `npm run test:unit`, `npm run e2e` local, then e2e against the Vercel preview.
7. `/review` on the diff (gate), `/qa` against the preview (gate). Not `/cso` —
   this diff touches no auth, session, storage or allowlist code.

## 8. Risks

| Risk | Handling |
|---|---|
| Two copies of the mean drift apart | One exported `ceTargetOf`; test 4 fails if `rollupCe` ever goes back to reading `fw.ce_targets`. |
| A fractional target leaks into a place expecting an integer | The type change `Level → number` makes `tsc` find them; the four sites in §4.4 are the complete list (`grep` for `ce_targets` and `.target` across `app/`). |
| An approved assessment's historic numbers move | They move **once**, deliberately, because the rule changed — and there are no approved assessments yet (the pilot has not started). Checked before merge; if one exists by then, it is called out in the PR rather than migrated silently. |
| The owner's 2026 baseline editing session lands mid-change | `data/baseline/framework-tunable.json` already captures the pre-edit state, and this change reads control targets rather than writing them. No interaction. |

---

## Decisions

All resolved in this document:

1. Formula location → one exported `ceTargetOf()` in `lib/rollup.ts`, called by `rollupCe` and by `lib/framework.ts` (§3).
2. Snapshot behaviour → CE target computed from `target_snapshot` for approved assessments (§3, test 4).
3. Rounding → store and compare unrounded; display via `fmtLevel` at one decimal (§4.4).
4. Null → no active control with a target ⇒ `target` null ⇒ `health` null ⇒ `—` (test 3).
5. Types → `CeTarget.target` and `CeResult.target` become `number | null`; `escalated_by[].target` stays `Level` (§4.2).
6. `competence_element.target_level` → retained, unread by the rollup, no new exposed field (§5).
7. Post-approval deactivation → pre-existing, out of scope, stated in spec §6 (§4.5).
8. Pre-approval profile-awareness → pre-existing, out of scope (§5).
9. Round-trip budget → unchanged at 5 and 3; no new query (§5).
10. Tests → new `scripts/rollup.test.mjs`, seven cases, the regression shown failing first (§6).

All ten of the plan's own decisions are resolved. `/plan-eng-review` then opened five
more, and the owner took the recommendation on all five on 2026-08-08 (*"for
decisions, go ahead with your recommendations for all"*):

| # | Decision | Landed as |
|---|---|---|
| D1 | **A** — rewrite the `CLAUDE.md` domain rule in this diff | control targets and competency targets split into two bullets; the reversal marked *do not restore* |
| D2 | **A** — correct all eight editable stale claims now | `CLAUDE.md`, `docs/user-guide.md` (×2), `docs/eng-plan-*.md`, `docs/design-competency-*.md`, `docs/STATUS.md`, `supabase/seed.sql`, `scripts/framework-baseline.mjs`, plus `docs/design-framework-profiles.md` — nine sites, the ninth found on the re-grep |
| D3 | **A** — leave the applied migration | `0001_init.sql:58` untouched; `seed.sql` states why and points at it |
| D4 | **A** — repoint the e2e checks and add the §6 assertion | `scripts/e2e.mjs` no longer reads `competence_element.target_level`; three new checks on the running app |
| D5 | **A** — epsilon on the half-level threshold | `HALF_LEVEL = 0.5 + 1e-9` in `lib/rollup.ts`, with the enumeration in the comment and a size-6 boundary unit test |

Two of the plan's own numbers were corrected while building, both upward:

- **§6 said seven test cases; sixteen shipped.** The engine had no unit tests at all,
  so the file also had to cover `healthOf`'s three tiers, the escalation invariants,
  the snapshot fallback for a control the snapshot omits, and `fmtLevel`.
- **D2 said eight editable files; nine.** `docs/design-framework-profiles.md:376`
  described the old rule in the present tense and asked for a competency-target
  editor this change makes unnecessary. Found by re-grepping after the edits rather
  than trusting the first list.

Two of the sixteen tests were wrong on their first run and were fixed rather than
accommodated: one asserted that `ceTargetOf` handed only inactive controls returns
their mean (it returns `null` — the point is that the filter is inside), and one used
a fixture whose published value equalled the computed mean, so it passed against the
old rule for a coincidental reason.

---

## Review findings (`/plan-eng-review`, 2026-08-08, against `6a4be6c`)

Recorded here because the plan is what the build follows; the report table below is
the status line.

**1 — [P1] (10/10) `CLAUDE.md:122`.** The "Domain rules that must not drift" entry
reads *"Targets are **not** rolled up or averaged; they are published values."* The
plan amends `docs/rollup-spec.md` and never mentions `CLAUDE.md` — the one file a
future session reads first, and which would instruct it to revert this change.

**2 — [P1] (10/10) the doc surface is nine files, not three.** `CLAUDE.md:122`;
`docs/user-guide.md:213-214` and `:345`;
`docs/eng-plan-competency-assessment-platform.md:106`;
`docs/design-competency-assessment-platform.md:273`; `docs/STATUS.md:1005`;
`supabase/seed.sql:39`; `scripts/framework-baseline.mjs:52`;
`supabase/migrations/0001_init.sql:58`. `user-guide.md` is the manual the nine PMs
read and would describe a judging rule the app no longer uses.

**3 — [P2] (9/10) `supabase/migrations/0001_init.sql:58`** carries the same false
comment, but the migration is applied history. Recommended: leave it, correct
`supabase/seed.sql:39`, let the spec carry the correction.

**4 — [P1] (10/10) `scripts/e2e.mjs:2065` and `:2091`.** The escalation section
selects and asserts against `competence_element.target_level`
(`mean >= fat.target_level`). After the change that is no longer the number on
screen — and the check still PASSES, because the constructed mean is ~4.4. It stops
asserting what it claims to assert, silently. Same shape as the round-trip-budget
line that disagreed with `scripts/e2e.mjs` until a review pass caught it.

**5 — [P1 by consequence, low likelihood] (9/10) `lib/rollup.ts:38`,
`if (gap <= 0.5) return "minor";`.** With `target` an integer, every reachable
exact-½ boundary is safe (15 cases enumerated, 0 misclassified). With **both** sides
means, 972 enumerated multiset pairs across CE sizes 3-8 give a gap of exactly ½ in
exact arithmetic and `>0.5` in IEEE754 — Minor Gap rendered as Capability Deficit.
Reachability today is narrow and clean: CE sizes are 3(×3), 4(×5), 5(×17), 6(×3);
sizes 3 and 5 cannot produce an exact ½ at all, size 4 divides exactly in binary,
so only the three 6-control CEs are exposed and **all three are currently safe (0 of
8 reachable boundary cases misclassify)**. The owner re-baselines all 133 targets
this week, which changes every one of those sums.

*Verified good:* the headline case — a PM who hits every control target — yields a
gap of exactly `0` in every enumerated case. The change delivers what it promises
regardless of finding 5.

**Also raised, folded into the plan rather than left open:**
- A rejected alternative the plan should record: re-seed `competence_element.target_level`
  to the rounded mean and change no code. One `UPDATE`, zero risk, and it goes stale
  the moment a control target is edited — which is the drift this change exists to end.
- Group controls by CE **once** in `lib/framework.ts` (the `activeByCe` loop is
  already there) rather than `filter`-ing 28 times over 133 rows.

**Verified clean:** no import cycle (`rollup.ts` is type-only on `./types`); redaction
intact (`getAssesseeFramework` nulls both `control.target_level` and
`ce_targets[].target`); `/results` uses the full framework for everyone but is gated on
`state === "approved"`, so the change leaks nothing new; round-trip budgets unaffected.

**Test coverage measured: 1 of 17 paths (6%).** The rollup engine has no unit tests
today. Three failure modes have no test, no error handling and would be silent —
approved-run-reads-live-framework (plan test 4), the float boundary (finding 5), and
post-approval deactivation (pre-existing, documented caveat).

**Outside voice: not run.** Codex is not installed in this container and the Claude
subagent fallback was not dispatched in this session. Recorded rather than reported
as a pass that was not earned.

## What shipped, and how it was verified

| Evidence | Result |
|---|---|
| `scripts/rollup.test.mjs` on `6a4be6c`, engine unchanged | **9 of 16 RED**, headline: `CE target is the mean of its control targets: expected ~2.6666666666666665, got 3` |
| Same file after the engine change | 16 / 16 green |
| `npm run test:unit` | **146 passed / 0 failed** (was 130) |
| `npx tsc --noEmit` | clean — the `Level → number` widening surfaced no missed call site |
| `npm run e2e` local, clean production build, fresh server log | **420 passed / 0 failed** (was 417) |
| Round-trip budgets | 5 warm commit + navigation, 3 on completion — both still asserted, both green |
| The defect itself, recomputed from the **live database** | the 4 competencies named in §2 now read Role Ready for a PM who hit every control target: 4.3.1 (3 → 2.6), 4.3.2 (3 → 2.7), 4.3.3 (3 → 2.8), 4.5.8 (3 → 2.6). 6 of 28 targets are genuinely fractional, so the one-decimal display is load-bearing rather than cosmetic. |

The red baseline is the part that counts. Ground rule 0 exists because a test written
first that has never failed proves only that it agrees with the code in front of it —
and the first run here failed on a missing export, which is a broken file and not a red
test. The pure helper was added on its own first (a change that alters no behaviour),
which is what let the nine failures be about arithmetic.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN) | 5 issues, all folded; 3 critical gaps, 2 closed by test + 1 documented |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**VERDICT:** ENG CLEARED — architecture and performance sound, all five findings
answered with the owner's approval, 146 unit + 420 e2e green.

Two gates remain before merge and neither is claimed here: `/review` on the diff, and
`/qa` against the Vercel preview. `/cso` does not apply — no auth, session, storage or
allowlist code is touched. The **outside voice did not run** (Codex absent from this
container, subagent fallback not dispatched); that is a missing second opinion, not a
passed one.

NO UNRESOLVED DECISIONS
