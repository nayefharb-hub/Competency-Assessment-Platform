# Framework profiles — office hours, not a build

**Status: EXPLORING. No code. Owner's instruction, 2026-08-08: *"don't build now
I am still exploring the feature."*** This document exists to sharpen the idea
and to record two things the owner did not have when asking.

---

## What was asked

> a feature where I can import a profile against a certain framework — for
> example, lock the current target levels, weightage, active and inactive as
> **Standard Out of Box**; then if I change any item of the profile I can save it
> as **Junior PM KIB 2026**, another profile is **Senior Level PM KIB 2026**,
> another would be **IHAB PM**. For now I just want the out-of-the-box profiles
> to be there saved, so that when I change something I can go back to the
> standard framework targets.

---

## 1. The near-term ask is already satisfied — verified, not assumed

*"I just want the out-of-the-box profiles saved so I can go back."*

**You can go back today.** Measured on 2026-08-08 against the live database: all
133 controls' `target_level` values match `supabase/seed.sql` **exactly — zero
drift.** The seeded baseline is intact and is checked into the repository, so
any edit you make while exploring is reversible.

What is missing is not the data. It is a **button**. Restoring today means
someone runs SQL; it is not something you can do from the admin screen.

So the honest framing of the near-term ask:

| | |
|---|---|
| Is the standard baseline saved? | **Yes** — `supabase/seed.sql`, verified zero drift |
| Can you restore it? | Yes, by running the seed's control values back |
| Can you restore it *yourself, from the app*? | **No** |
| Do you need the profile feature to be safe while exploring? | **No** |

**Explore freely.** Change targets, priorities, active flags. The baseline is
recoverable exactly. If that stops being true — if the seed and the database
diverge — that is a separate, smaller problem than the feature, and it is worth
fixing on its own terms.

---

## 2. The feature is roughly half built, and the half that exists is the hard half

This is the part worth knowing before designing anything.

`benchmark_profile` **already exists** and is wired end to end:

| Piece | State | Where |
|---|---|---|
| `benchmark_profile` table | **4 rows**: Entry, Intermediate, Advanced, Master | seeded |
| `benchmark_target` rows | **116** | seeded |
| Per-assessment profile | `assessment.profile_id`, a real column | `lib/db/assessment.ts:140` |
| Targets re-point by profile | `targetsForProfile(name)` returns a per-control map | `lib/framework.ts:429` |
| Snapshot at approval uses it | approval freezes the profile's targets | `lib/db/assessment.ts:899` |
| Profile shown to humans | on `/review` and `/results` | `app/review/page.tsx:52` |
| **Anyone can CHOOSE a profile** | **NO — it is hardcoded to Intermediate** | `lib/db/assessment.ts:121` |

So the read path — *a person's assessment names a profile, and that profile
decides their targets, and approval freezes them* — is finished and tested. The
missing pieces are authoring and selection, which is the opposite of what one
usually expects to already have.

### Four gaps, in the order they would bite

1. **Nothing selects a profile.** `assignAssessment` picks `DEFAULT_PROFILE`
   ("Intermediate") and never asks. Junior vs Senior PM is a dropdown away from
   working *for targets*, which is the single highest-value gap.
2. **A profile carries only `target_level`, not the whole tunable layer.** The
   ask names *"target levels, weightage, active and inactive"*. Today a profile
   maps `apm_competence → level`. Priority and active are columns on `control`,
   global to the framework, and no profile can vary them.
3. **31 of 133 controls ignore profiles entirely.** Those carry
   `target_source = 'Derived (priority rule)'` — KIB's own derivation, with no
   APM competence to look up — so `targetsForProfile` keeps their stored value
   whatever profile is chosen. A KIB-authored profile would have to cover them,
   which the APM-keyed model cannot express.
4. **Competency-level targets do not re-point at all.** Already logged as open
   item 7 in `docs/STATUS.md`: CE targets are APM's published Intermediate
   values. Any profile other than Intermediate would show per-control targets
   from one profile against competency targets from another.

Gap 3 is the interesting one. It says the current profile model is *APM's*, not
*KIB's* — keyed by APM competence, not by control. What is being asked for is a
KIB-authored layer, and it does not fit the existing table without a change of
key.

---

## 3. The word "profile" already means something here

`benchmark_profile` means **an APM published role level** (Entry → Master). The
proposal uses "profile" to mean **a named snapshot of KIB's tunable layer**
(Junior PM KIB 2026, IHAB PM).

Those are different objects. One is published by a standards body and is the
same for every organisation; the other is KIB's local judgement and is the thing
a second customer would replace entirely.

This repository has already paid for one noun meaning two things — three screens
each holding their own idea of "continue the assessment" (D29), and `commitLabel`
holding two ideas of "what happens next". **Whatever gets built, these two
concepts need different names.** Candidate split: `benchmark_profile` stays as
the standard's role levels; the new thing is a **framework variant** or
**target set**.

---

## 4. Premise challenge

**Two different problems are bundled in the ask, and they have very different
costs.**

**Problem A — undo.** *"So that when I change something I can go back to the
standard framework targets."* This is version control over one table. It does
not need profiles, does not need selection, and does not touch the rollup.

**Problem B — differentiation.** *Junior PM and Senior PM are held to different
targets.* This is the real product feature. It touches assignment, the rollup,
the snapshot, and the results screen.

Solving B gives you A for free, which is why they feel like one thing. But A
alone is perhaps a day and B is not, and **A is the only one you have said you
need now.**

**Questions that should be answered before B is built:**

1. **Does KIB actually assess PMs against different targets?** Nine people, one
   assessor, first cycle. If every PM is held to the same bar this year, a
   profile switcher has no user until next year. *(The prototype's whole
   discipline is shipping the narrow thing first — CLAUDE.md.)*
2. **What does "weightage" mean?** It appears in the ask and does not exist in
   the data model. Priority (High/Medium/Low) is currently a *label*, not a
   weight — the rollup is an unweighted mean of assessor scores across active
   controls (`docs/rollup-spec.md`). If profiles are meant to carry weights, that
   is a change to the rollup arithmetic, which is a much larger claim than
   changing targets and would invalidate cross-cycle comparison.
3. **Is a profile per PERSON or per ASSESSMENT?** The schema says per assessment
   today. Per person sounds natural and is wrong: someone promoted mid-year
   should keep last cycle's record at last cycle's bar.
4. **What happens to an approved assessment when its profile is edited?**
   Answered already, and correctly: targets snapshot at approval
   (`docs/rollup-spec.md` §6), so history is immune. Any profile design must
   preserve that, and it is a good reason to make profiles immutable-once-used
   rather than editable in place.
5. **Does "import" mean import?** The ask says *"import a profile against a
   certain framework."* Importing implies a file format and a mapping — which is
   the multi-framework authoring engine that CLAUDE.md explicitly defers until a
   pilot earns it. If import means "duplicate an existing profile and edit it",
   that is a different and much smaller feature.

---

## 5. Alternatives

**A. Do nothing now.** The baseline is in `seed.sql` with zero drift. Explore;
restore via SQL if needed.
*Cost: none. Risk: a restore needs someone who can run SQL.*

**B. A restore path, no profiles.** One admin action: "reset the framework's
tunable layer to the shipped baseline", plus a snapshot of the current values
taken before any reset so it is not a one-way door.
*Cost: small — one table or one seeded row set, one button, one confirmation.
Solves Problem A completely. Does not touch the rollup or assignment.*

**C. Extend the existing `benchmark_profile` to be KIB-authorable.** Re-key
`benchmark_target` from `apm_competence` to `control_code` (closing gap 3), add
priority and active, add a profile picker at assignment.
*Cost: medium. Reuses `assessment.profile_id`, the snapshot, and the results
display — all already built and tested. Needs a migration and a decision on CE
targets (gap 4).*

**D. A new `framework_variant` concept alongside `benchmark_profile`.** Cleanest
conceptually — the standard's profiles and KIB's variants stay separate objects.
*Cost: largest. Two profile-shaped things in the schema, and every read path has
to know which one governs.*

---

## 6. Recommendation

**Now: A.** Nothing to build. You are safe to explore, and that is verified
rather than assumed.

**If exploring turns into editing you care about keeping: B.** It is small, it
is the thing you actually asked for, and it is useful whether or not the profile
feature ever gets built.

**Build C only when question 1 has a real answer** — when there is a second
target set that a named person is genuinely assessed against. Until then it is a
switcher with one position. C is the right shape when that day comes, because it
reuses the half that already exists rather than building a parallel one.

**Do not build D unless C proves too cramped.** Two profile-shaped tables is a
cost paid on every read forever.

**Do not touch "weightage" without a separate conversation.** It would change
the rollup arithmetic, which is the one contract this app has that other people's
decisions depend on.

---

## 7. ANSWERED — question 1, by the owner (2026-08-08)

> we have different roles, however I would consider this year as benchmarking —
> every role gets the same baseline, which is the minimum. Their scoring would
> determine next year's baseline.

**This settles the gating question, and it settles it in favour of building
nothing.** One baseline for every role in cycle 2026 is *already the app's
behaviour*: `assignAssessment` sets `DEFAULT_PROFILE` ("Intermediate") on every
assessment and nothing ever asks (`lib/db/assessment.ts:121`). The profile
feature has no user until cycle 2027 at the earliest.

**Two things already built are what make the plan safe**, and they should not be
traded away:

- `target_snapshot` freezes each assessment's targets at approval
  (`rollup-spec.md` §6). Re-baselining in 2027 therefore cannot rewrite 2026.
  Without this, benchmarking would be self-erasing.
- `assessment.cycle` with `unique (assessee_id, cycle)` — multi-year is a real
  key, not a convention.

### "The minimum" is an unmade decision worth a full level

The current baseline is **Intermediate**, which is a role profile, not a
minimum. Measured 2026-08-08:

| Profile | Competences with a target | Mean target |
|---|---|---|
| Entry | 26 | **1.42** |
| **Intermediate** (in use) | 29 | **2.48** |
| Advanced | **0** | — |
| Master | **0** | — |

Choosing Entry instead would drop the bar a full level and move most people from
Minor Gap into Role Ready. Choosing Intermediate changes nothing. Either is
defensible; inheriting one by accident is not.

**Advanced and Master hold no targets at all.** So the constraint on cycle 2027
is not the profile feature — it is that the published values for a senior bar do
not exist and would have to be *authored*. Same root as open item 7 in
`docs/STATUS.md`.

### The risk in deriving next year's baseline from this year's scores

It is **descriptive, not normative**: it sets the standard from where the team
is, rather than from what the role requires. A team collectively weak in one
competency lowers that competency's bar next year, the gap closes on paper, and
capability has not moved. On a record a bank may be audited against, that is the
failure mode that matters.

The mitigation is not to abandon the idea. It is to keep APM as the anchor and
let the observed data adjust *within* it. *"Our PMs cluster at 2 against an APM
target of 3"* is a finding. *"So the target is now 2"* is a much weaker claim
wearing the same evidence.

Two smaller cautions:

- **n = 9, one assessor.** Enough to see clustering and outliers; not enough to
  move a published standard's numbers, and it carries one rater's calibration.
- **The health tiers still say "Capability Deficit"** against a bar the owner has
  described as provisional — on a screen people read personally, in the cycle
  where the bar is least earned. Worth an explicit decision on year-one language.

### What this plan actually creates demand for

**Trends, not profiles.** T10 in `docs/STATUS.md` — "not started, schema-ready".
Benchmarking only pays off when 2027 can be placed beside 2026. That is the next
feature this decision argues for; profiles are the one after it, and only if the
2027 bar really does differ by role.

---

## 8. What would change my advice

- **KIB confirms Junior and Senior PMs have different published targets this
  cycle** → C moves from "later" to "next", because the pilot itself needs it.
- **A second organisation appears** → the naming split in §3 stops being tidiness
  and becomes structural, and D gets more attractive.
- **"Import" turns out to mean a real file format** → this is no longer a profile
  feature at all; it is the multi-framework import engine, which is its own
  design conversation and is explicitly out of scope until a pilot earns it.
- **The seed and the database diverge** → B stops being optional, because the
  baseline would no longer be recoverable.
