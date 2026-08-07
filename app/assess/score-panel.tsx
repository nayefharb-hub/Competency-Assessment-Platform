"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "@/app/link";
import { answeredLevel, commit, pendingFor } from "@/lib/outbox";
import { createDwellClock, type DwellClock } from "@/lib/dwell";
import { decideCommit } from "@/lib/commit-label";
import type { Milestone } from "@/lib/shape";
import MilestoneCard from "./milestone-card";

interface Level {
  level: number;
  label: string;
  gloss: string;
}

/**
 * The answer panel — the one client component in the assessment.
 *
 * THE COMMIT RULE (docs/eng-plan-save-ux.md, decision D9). Picking a level or
 * typing evidence changes nothing but this component's state. "Next control"
 * is the only thing that commits, and it hands the answer to the outbox and
 * navigates in the same breath — the PM never waits for a write.
 *
 * Everything else — Previous, Back to controls, the header links, signing out —
 * deliberately does NOT commit. A pick the PM did not confirm is a pick they
 * were still thinking about, and returning to the control shows what the SERVER
 * holds, not what they nearly chose. Committing on the way out would put an
 * answer in the record that nobody agreed to.
 */
export default function ScorePanel({
  control,
  assessmentId,
  nextControl,
  prevControl,
  levels,
  savedLevel,
  savedEvidence,
  locked,
  milestone,
  ceLevels,
  owed,
}: {
  control: string;
  /** Which record this screen is about. Scopes the client's memory of what it
   *  confirmed, so a re-assignment, a cycle rollover, or a session that moved
   *  to another PM cannot let yesterday's answers speak for today's record. */
  assessmentId: string;
  nextControl: string | null;
  prevControl: string | null;
  levels: Level[];
  savedLevel: number | null;
  savedEvidence: string;
  locked: boolean;
  /** The competency this control sits in — at every control, not only at its
   *  last one (N38/N40). `done` says whether this is also a positional boundary. */
  milestone?: Milestone | null;
  /** Persisted levels for the competency this control belongs to — the recap. */
  ceLevels?: Record<string, number | null>;
  /** Controls still unanswered, in framework order, wrapping past the end.
   *  Several, because the first may be this control or one still in flight. */
  owed?: string[];
}) {
  const router = useRouter();
  const [level, setLevel] = useState<number | null>(savedLevel);
  const [evidence, setEvidence] = useState(savedEvidence);
  /* The milestone is shown INSTEAD of the panel, after the answer is committed
     and without navigating. Keyed off the control below so that arriving at a
     new control — including via Back — never lands on a stale milestone (FM7). */
  const [reached, setReached] = useState(false);
  /* Answers for this competency still IN FLIGHT — what the offline hint talks
     about. Not the same set as `known` below, and the difference is N33. */
  const [queued, setQueued] = useState<Record<string, number>>({});
  /* Answers for this competency the PM has confirmed on this device, sent or
     not. This is what decides whether the competency is finished. */
  const [known, setKnown] = useState<Record<string, number>>({});
  /* A navigation from the milestone is in flight. Without this, a held Enter or
     a second click pushes the same URL twice and Back appears to do nothing. */
  const [navigating, startNavigating] = useTransition();

  // Re-mounting is not guaranteed between controls (React reuses the tree when
  // only the query string changes), so the fields are re-seeded from the server
  // whenever the control does. This is also what makes an ABANDONED pick clear
  // itself: nothing was written, so the server's value is the truth.
  useEffect(() => {
    // The OUTBOX holds newer truth than the server render while an answer is
    // still queued. Without this the page would show the server's older value,
    // the PM could look at it, accept it, and change nothing — and then the
    // queued answer would land on top of the choice they just made, with
    // nothing ever telling them. Seed from the queue when it has something.
    const queuedHere = pendingFor(control);
    setLevel(queuedHere ? queuedHere.level : savedLevel);
    setEvidence(queuedHere ? (queuedHere.evidence ?? "") : savedEvidence);

    /* THE WHOLE COMPETENCY, not just this control.
     *
     * The outbox enqueues and navigates in the same breath (D9), so the save
     * POST races the next page's RSC GET. A PM answering five controls at speed
     * arrives at the fifth with only the first three landed — and the first cut
     * of N32 corrected the server's count by exactly +1, for this control only.
     * `3 + 1 >= 5` is false, so the milestone silently did not happen. Same PM,
     * faster connection, it did. The design doc named this in advance (FM3, "a
     * queued-but-unsent answer still counts toward the milestone") and the e2e
     * missed it because it seeds prior scores straight into Postgres.
     *
     * N33 IS WHY THERE ARE NOW TWO MAPS. Reading the QUEUE for completeness
     * left a hole the previous fix could not see: the navigation GET is taken
     * before the write lands, and the queue drops the entry the moment the
     * write is acknowledged, so the answer the PM gave one control ago is in
     * neither source by the time this effect runs. Worse, this effect REPLACED
     * the map that did still hold it. Measured on the walked path: at 4.3.1.5
     * the server render had .1-.3, the queue had nothing, and .4 — answered
     * fifteen seconds earlier — had vanished. Acknowledgement never removes
     * anything from `answered`, so `known` cannot be wiped at the wrong moment.
     *
     * BOTH MAPS ARE LOAD-BEARING, and the first cut of this fix got that wrong
     * by REPLACING `queued` with `known` in `effectiveLevel` rather than adding
     * it. `answered` is module memory and a full page load destroys it; the
     * QUEUE is mirrored to localStorage and survives. So during a write-path
     * outage — the exact situation the mirror exists for — a PM who answers
     * four controls and then reloads has four confirmed answers that `known`
     * has forgotten and only `queued` still holds. Dropping the queue from the
     * chain reintroduced N33 on that path, and a review pass caught it before
     * it shipped. Ask both, in this order: this device's memory, then what is
     * still unsent, then the server.
     *
     * Read in an EFFECT rather than during render: the outbox is client-only,
     * so consulting it while rendering would make the server's HTML and the
     * first client render disagree about the button's label. */
    const q: Record<string, number> = {};
    const k: Record<string, number> = {};
    /* THIS COMPETENCY **AND** EVERY CODE THE OWED FILTER WILL TEST.
     *
     * The maps used to cover only `milestone.controls`, which was right while
     * they were read only for completeness — that question is competency-scoped
     * by definition. Since N38/N39 `nextOwed` tests framework-wide codes against
     * the same maps, and for anything outside this competency both lookups came
     * back `undefined`, so the filter passed it through unconditionally. Three
     * reviewers found it independently:
     *
     *   two holes left, 4.3.1.2 and 4.5.9.3. Fill the first; the card rises;
     *   Continue lands on the second. That render was taken before the first
     *   write landed (D9), so the server's owed list is still [4.3.1.2,
     *   4.5.9.3]. Answer 4.5.9.3, and Continue sends the PM back to 4.3.1.2 —
     *   a control they answered twenty seconds ago. If the outbox had by then
     *   been acknowledged and dropped, the panel shows it BLANK.
     *
     * So ask the outbox about every code the filter will see. `answeredLevel`
     * and `pendingFor` take any control code; nothing about them was
     * competency-scoped except this loop. */
    const relevant = new Set([...(milestone?.controls ?? []).map((c) => c.code), ...(owed ?? [])]);
    for (const code of relevant) {
      const p = pendingFor(code);
      if (p && p.level !== null) q[code] = p.level;
      const confirmed = answeredLevel(assessmentId, code);
      if (confirmed !== null) k[code] = confirmed;
    }
    if (queuedHere && queuedHere.level !== null) q[control] = queuedHere.level;
    setQueued(q);
    setKnown(k);

    // A milestone belongs to the answer that produced it. Landing on any
    // control — forwards, or backwards with the browser button — starts from
    // the panel, never from a milestone someone already passed through.
    setReached(false);
    // `owed` joins the deps because the loop above now reads it. Both it and
    // `milestone` are fresh arrays from the server render, so this effect runs
    // on every navigation — which is what it wants: each control re-asks the
    // outbox what it is holding.
  }, [control, savedLevel, savedEvidence, milestone, owed]);

  /* Connectivity is STATE, not a value read once while rendering.
   *
   * The first cut read `navigator.onLine` in the render body and closed over
   * it. Nothing in this component subscribes to anything, and once the
   * milestone card is up there are no state updates at all, so the value froze
   * at whatever it was when the card mounted: go offline and Continue stayed
   * enabled (the exact D13 hard-navigation failure the card's own comments are
   * organised around); come back online and it stayed disabled forever, beside
   * copy promising the PM they could carry on. Mirrors app/offline-banner.tsx,
   * which had this right already. */
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    const sync = () => setOffline(navigator.onLine === false);
    sync();
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    window.addEventListener("pageshow", sync);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
      window.removeEventListener("pageshow", sync);
    };
  }, []);

  // Remember where they are, so "Self-assessment" in the menu comes back HERE
  // (decision D12). A cookie rather than a database column: it is a per-device
  // convenience, not part of the assessment record, and the same reasoning
  // DESIGN.md gives for storing the theme per device applies — the server can
  // read it during the render, so there is no flash and no extra round trip.
  useEffect(() => {
    // Secure is safe here and worth having: browsers treat localhost as a
    // trustworthy origin, so this still works in development, and in
    // production the position never travels over plain HTTP.
    const secure = location.protocol === "https:" ? "; Secure" : "";
    document.cookie =
      `cap.last=${encodeURIComponent(control)}; path=/; max-age=${60 * 60 * 24 * 120}; SameSite=Lax${secure}`;
  }, [control]);

  /*
   * How long this control was actually on screen (D28).
   *
   * Restarted whenever the CONTROL changes rather than on mount, because
   * client-side navigation reuses this component — mounting once and timing
   * from there would report the whole sitting as the last control's dwell.
   *
   * STARTED IN THE RENDER BODY, NOT IN AN EFFECT. A passive effect runs after
   * hydration, and on any full page load — a bookmarked /assess?c=…, a reload,
   * a link in from the hub or the control list, the first control of every
   * sitting — the
   * server-rendered text is on screen and readable well before the bundle
   * hydrates. Starting the clock there discarded that reading time, and the
   * error ran in the accusing direction: it makes an answer look faster than
   * it was, on the one screen where "too fast" is the finding.
   *
   * `performance.now()`, not `Date.now()`. It is monotonic, so an NTP step or
   * a suspend/resume cannot make the clock run backwards — which a review pass
   * found would otherwise have produced a 0ms reading, i.e. the most severe
   * possible statement about a person, from a hardware event.
   *
   * Paused while the tab is hidden, so a meeting in the middle of a control
   * does not read as four minutes of careful thought.
   */
  const clock = useRef<DwellClock | null>(null);
  const clockFor = useRef<string | null>(null);
  if (typeof window !== "undefined" && clockFor.current !== control) {
    clockFor.current = control;
    clock.current = createDwellClock(
      performance.now(), document.visibilityState === "visible");
  }
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") clock.current?.pause(performance.now());
      else clock.current?.resume(performance.now());
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  const dirty = level !== savedLevel || evidence !== savedEvidence;

  /*
   * WHAT THE PM HAS ACTUALLY ANSWERED — this screen, then this device, then
   * what is still unsent, then the server. NEWEST FIRST, and the order is the
   * point.
   *
   * This is N30. The server render is always one answer behind at exactly the
   * moment it matters (the last control of a competency), so the client has to
   * add what it holds. The mistake worth not repeating is doing that with
   * arithmetic: `scored + 1` can only ever correct for ONE control, and the
   * outbox routinely holds several. Asking each control what its answer is
   * makes the count and the recap agree by construction rather than by two
   * expressions that happen to match.
   *
   * THE SERVER USED TO WIN THIS `??` CHAIN, which was wrong for a reason three
   * independent review passes each found on the REVISE path: change 4.3.1.4
   * from Practised to Expert, press Next, and the render of 4.3.1.5 was taken
   * before that write landed — so `ceLevels` held Practised, short-circuited
   * before `known`'s Expert was ever consulted, and the recap showed the PM the
   * answer they had just replaced. On the card documented as "the last easy
   * moment to change an answer". For `self_level` this device is never older
   * than a render it raced: `answered` is cleared on a user change and scoped
   * to the assessment, so the only thing it can hold is what this PM confirmed,
   * for this record, in this session.
   *
   * `submitSelfAssessment` still counts for itself server-side. This decides
   * what the screen SAYS, never what the record holds.
   */
  const effectiveLevel = (code: string): number | null =>
    code === control ? level : (known[code] ?? queued[code] ?? ceLevels?.[code] ?? null);

  const ceComplete = milestone
    ? milestone.controls.every((c) => effectiveLevel(c.code) !== null)
    : false;

  /* IS THE COMPETENCY'S COMPLETION THIS CLICK'S NEWS?
   *
   * `ceComplete` alone is not enough, and the e2e found it: a PM who opens a
   * competency they already finished — which is exactly what the milestone
   * card's own recap rows invite them to do — would have been told "Finish this
   * competency" on every control in it, and the card would have risen instead
   * of taking them to the next control. Walking a finished competency would
   * have become impossible through the primary button.
   *
   * The completion is news in two cases and no others:
   *
   *   - THIS CLICK CAUSED IT. The control had no answer before now, and with it
   *     the competency is whole. That is N40 — a hole filled anywhere, not only
   *     at a positional boundary — and it is the case the old code could not
   *     see at all.
   *   - THE PM ARRIVED AT THE COMPETENCY'S END with it whole. That is the
   *     original milestone, and it has to survive a REVISION: change the last
   *     control's answer and the card is where the revised recap is shown back
   *     (N33c).
   *
   * A revision in the MIDDLE of a finished competency is neither, so it moves
   * on — which is what a PM re-reading their own answers means by Next.
   *
   * `priorHere` deliberately does not read `level`: that is the pick on screen,
   * which is the thing whose effect is being asked about. */
  const priorHere = known[control] ?? queued[control] ?? ceLevels?.[control] ?? savedLevel;
  const atCeEnd = !!milestone && milestone.done !== "mid";

  /* WHERE "I HAVE FINISHED SOMETHING, TAKE ME ON" GOES (N38/N39/N40).
   *
   * The server's owed list is one answer behind by construction, so the first
   * entry is routinely this very control — the one being answered — or one
   * answered seconds ago that has not landed. Skip anything this device knows
   * it has answered. Null means nothing is owed anywhere, which is the only
   * state in which "review and submit" is a true thing to offer. */
  const nextOwed = (owed ?? []).find(
    (code) => code !== control && known[code] === undefined && queued[code] === undefined,
  ) ?? null;

  /* ONE EXPRESSION FOR "WHERE DOES CONTINUE GO", because there were three —
     `leaveMilestone`'s cookie write, `continueRun`'s navigation, and the
     `canContinue` prop that decides whether the button is rendered at all.
     Three copies of a rule agree by coincidence, and this one governs whether a
     control is offered and where it leads: if the prop and the handler ever
     disagreed, the card would show a Continue that went nowhere, or hide one
     while work remained. It is the same argument `commitLabel` below already
     makes for the label and the hint. */
  const continueTarget = milestone?.nextControl ?? nextOwed;

  /* Answers this client holds that the server has not counted. Only this
     competency's are knowable here, which is why the wider claims can only
     ever UNDERSTATE — see the Milestone docstring in lib/shape.ts. */
  const ceNewlyAnswered = milestone
    ? milestone.controls.filter(
        (c) => (ceLevels?.[c.code] ?? null) === null && effectiveLevel(c.code) !== null,
      ).length
    : 0;
  const areaRemaining = milestone
    ? Math.max(0, milestone.area.total - milestone.area.scored - ceNewlyAnswered)
    : 0;
  const assessmentRemaining = milestone
    ? Math.max(0, milestone.assessment.total - milestone.assessment.scored - ceNewlyAnswered)
    : 0;

  function goNext() {
    if (level !== null && dirty) {
      /*
       * DWELL MEANS TIME TO THE **FIRST** ANSWER, and only the first.
       *
       * A review pass found the original — send the current clock every time —
       * reintroducing precisely the defect D28 rejected the timestamp method
       * for. Read a 200-word control for 95 seconds and answer it; come back
       * two days later, change your mind in 4 seconds, and the 95 became 4.
       * The screen would then have listed that control under "answered faster
       * than the text can be read" — a false accusation produced by the most
       * normal thing a PM does here.
       *
       * The offline branch below has the same shape without any intent to
       * revise: it commits without navigating, so a second click on the same
       * control would otherwise overwrite a good reading with one that
       * includes all the waiting.
       *
       * So: measure only when nothing is recorded for this control yet. A
       * revision keeps the original reading (the server omits the column when
       * this is null, and the outbox carries the earlier value forward).
       */
      const firstAnswer = savedLevel === null && pendingFor(control)?.dwellMs == null;
      commit({
        control,
        level,
        evidence: evidence.trim() || null,
        dwellMs: firstAnswer ? clock.current?.read(performance.now()) ?? null : null,
      }, assessmentId);
      // The queue is now newer than the server for this control. Record it here
      // rather than re-reading the outbox during render, which would make the
      // server's HTML and the first client render disagree.
      setQueued((q) => ({ ...q, [control]: level }));
    }
    /* Finishing a competency raises the milestone IN PLACE — no navigation, so
       this happens whether or not the browser is online. The card disables
       every action while offline and says why (review decision A1); withholding
       the milestone would deny the PM the one moment that makes 132 controls
       feel finishable, precisely when the app is already frustrating them.

       WHEREVER THE COMPETENCY IS FINISHED, not only at its last control — the
       owner's call on N40, and the reason is consistency: the button says
       "Finish this competency" exactly when the click completes one, and the
       same words have to produce the same outcome every time. Raising the card
       only at the positional boundary would have made the label mean two
       different things depending on where the PM happened to be standing, which
       is the defect one level up. Mopping up five holes across five
       competencies does mean five cards; Enter dismisses each, and each is
       telling the truth.

       THE CONDITION IS `raisesCard`, NOT `ceComplete`. A competency that was
       already whole before this click has no news to announce, and gating on
       `ceComplete` here would have trapped a PM re-reading a finished
       competency on its first control. `lib/commit-label.ts` owns the
       distinction, so the button and this branch cannot drift apart — they are
       two fields of one answer. (Declared below: `goNext` only runs on a click,
       long after the const is initialised.) */
    if (milestone && raisesCard) { setReached(true); return; }

    // Never ask the browser to navigate when it has told us it cannot
    // (decision D13). Measured: router.push falls back to a hard navigation,
    // which lands on Chrome's own error page — the app disappears, taking the
    // failure banner with it, and the PM has no way to know their answer was
    // kept. The answer is already in the outbox by this line, so staying put
    // costs nothing and keeps them inside the app.
    // The app-wide OfflineBanner explains this; app/link.tsx does the same for
    // every other navigation, so all of them behave alike when offline.
    // Re-read rather than trusting the render-time value: the click can be
    // arbitrarily long after the render that produced it.
    if (offline || navigator.onLine === false) return;
    /* Walking forward, the next control is the next control — that is what a PM
       working through the framework means by it, and jumping them past controls
       they answered out of order would be the surprise. Only when there is
       nothing after this one does "what do I still owe" take over, which is the
       case that used to offer a Submit the server would refuse (N38), and is
       also the answer to "getting back to the skipped ones is cumbersome"
       (N39). */
    const target = nextControl ?? nextOwed;
    router.push(target ? `/assess?c=${encodeURIComponent(target)}` : "/assess/controls?saved=1");
  }

  /** Every navigation out of the milestone. Offline, none of them may run. */
  function leaveMilestone(href: string) {
    if (offline || navigator.onLine === false || navigating) return;
    /* Carry the resume cookie forward. It is written by the effect above from
       `control`, which at a milestone is the competency the PM just FINISHED —
       so without this, taking a break and coming back via the menu lands on
       that last control, whose competency is now complete, whose only forward
       action is "Finish this competency", and whose milestone therefore rises
       again for work done days ago. The design doc lists honouring `cap.last`
       as an explicit constraint of this flow. */
    const target = continueTarget;
    if (target) {
      const secure = location.protocol === "https:" ? "; Secure" : "";
      document.cookie =
        `cap.last=${encodeURIComponent(target)}; path=/; max-age=${60 * 60 * 24 * 120}; SameSite=Lax${secure}`;
    }
    startNavigating(() => router.push(href));
  }

  /**
   * Continue, from the milestone.
   *
   * `nextControl` is the next competency's first unscored control — the right
   * answer when the PM is walking the framework in order. `nextOwed` is the
   * fallback for a competency finished in the middle of the run, or one
   * finished last with holes left behind: there is no "next competency" to
   * carry into, and the honest place to go is whatever is still owed.
   */
  function continueRun() {
    /* No fallback branch. `onContinue` is reachable only from the card's button
       and its Enter handler, both gated on the same `continueTarget` — so a null
       here cannot happen, and a dead branch that looks live is what the next
       refactor preserves. */
    leaveMilestone(`/assess?c=${encodeURIComponent(continueTarget!)}`);
  }

  /**
   * Revise a control from the recap.
   *
   * THE ROW FOR THE CONTROL YOU ARE STANDING ON IS THE COMMON CASE, and it was
   * the one that did not work. It is the answer just given and the most likely
   * one to want back — the last recap row when the card came from a positional
   * boundary, any row at all since N40 let the card rise wherever a competency
   * is completed. Pushing its own URL is a no-op, and `reached` is cleared only
   * by the effect keyed on
   * [control, savedLevel, savedEvidence], none of which change while the write
   * is still in flight. So the button did nothing, precisely during the window
   * where changing your mind matters.
   */
  function reviseControl(code: string) {
    if (code === control) { setReached(false); return; }
    leaveMilestone(`/assess?c=${encodeURIComponent(code)}`);
  }

  /*
   * KEYBOARD SCORING (E2). 0-5 pick a level, Enter confirms and moves on.
   *
   * A PM answers 132 questions; reaching for the mouse on every one of them is
   * the bulk of the physical effort in a sitting. Additive — nothing about the
   * pointer path changes — and it is the same accessibility win.
   *
   * GUARDED ON THE EVENT TARGET, which is the whole subtlety: the evidence
   * field is one tab away, and typing "3" in it must write a 3, not silently
   * re-score the control. Anything originating in a form field or a button is
   * left entirely alone.
   */
  /* NO DEPENDENCY ARRAY, DELIBERATELY. `onKey` reads `level` and calls
     `goNext`, which reads `evidence` and `dirty` — all of which change every
     render. Any partial array (`[level]`, `[locked, reached]`) would leave a
     stale closure that commits the wrong evidence text, and no test would
     necessarily catch it. The cost is one listener swap per render, against a
     page whose floor is a ~31ms database call. Do not "tidy" this to `[]`. */
  useEffect(() => {
    if (locked || reached) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && /^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(el.tagName)) return;
      if (el?.isContentEditable) return;

      if (/^[0-5]$/.test(e.key)) {
        const n = Number(e.key);
        if (levels.some((l) => l.level === n)) {
          e.preventDefault();
          setLevel(n);
        }
        return;
      }
      if (e.key === "Enter" && level !== null) {
        e.preventDefault();
        goNext();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  /*
   * ONE label, used by both the button and the hint above it — and now decided
   * in `lib/commit-label.ts` rather than here.
   *
   * They used to be computed separately — the hint from `nextControl`, the
   * button from the boundary — so at a competency boundary the hint said
   * "Next control saves it" above a button reading "Back to the list". It named
   * a button that was not on screen. Two notions of "what happens next",
   * rendered side by side; deriving both from one call removes the possibility
   * rather than fixing the symptom.
   *
   * WHY IT MOVED OUT. Six defects have lived in this decision (N30, N33, N38,
   * N40, and two more found by review inside the N38/N40 fix). Every one was a
   * row in a table nobody could read, because the table was a nested ternary
   * inside a component whose other inputs are an outbox, a router and a race.
   * As a pure function it is 64 combinations and `scripts/commit-label.test.mjs`
   * walks all of them in milliseconds. This file now supplies the facts and
   * renders the answer; it no longer holds the rule.
   *
   * The facts are all client-side for the same reason as `ceComplete`: the
   * server render is one answer behind at exactly the moment the label matters.
   */
  const { label: commitLabel, raisesCard } = decideCommit({
    ceComplete,
    atCeEnd,
    /* STRICT, because level 0 is a real answer. "Unaware" is the bottom of the
       APM scale, not the absence of a score, and `priorHere` is `number | null`
       — so this is the exact negation of the old `priorHere === null`, at 0 as
       everywhere else. Every `??` on the path is nullish and every completeness
       test is a strict comparison for the same reason; a single `||` or a bare
       truthiness test anywhere here would silently erase every PM who answered
       "Unaware". */
    answeredBefore: priorHere !== null,
    assessmentRemaining,
    /* ALSO STRICT, where the old ternary used bare truthiness. Review flagged
       the difference: they diverge only if a control code were ever the empty
       string, which the framework cannot produce. Kept strict deliberately
       rather than restored to `!!` — `goNext` navigates to `nextControl ??
       nextOwed`, which is nullish, so the strict form is the one that AGREES
       with where the click actually goes. The old pair could in principle have
       said "Next unanswered control" and then navigated to the next control. */
    hasNextControl: nextControl !== null,
    hasNextOwed: nextOwed !== null,
  });

  if (reached && milestone) {
    return (
      <MilestoneCard
        milestone={milestone}
        levels={levels}
        /* One function for the recap and for `ceComplete` above, so the card's
           rows and its heading cannot disagree about the same answer. */
        levelFor={effectiveLevel}
        currentControl={control}
        offline={offline}
        busy={navigating}
        areaRemaining={areaRemaining}
        assessmentRemaining={assessmentRemaining}
        canContinue={!!continueTarget}
        onContinue={continueRun}
        onRevise={reviseControl}
      />
    );
  }

  return (
    <div className="card pad">
      <div className="mh" style={{ color: "var(--ink)", marginTop: 0 }}>
        Your level{" "}
        <span className="muted" style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>
          🔒 target hidden while you self-score
        </span>
      </div>

      <div className="optlist" role="radiogroup" aria-label="Proficiency level">
        {levels.map((s) => (
          <label className="opt" key={s.level}>
            <input
              type="radio"
              name="level"
              value={s.level}
              checked={level === s.level}
              onChange={() => setLevel(s.level)}
              disabled={locked}
            />
            <span>
              <b>{s.label}</b>
              <span className="gloss">{s.gloss}</span>
            </span>
          </label>
        ))}
      </div>

      <div className="field" style={{ marginTop: 14 }}>
        <label htmlFor="evidence">Evidence or example (optional, not scored)</label>
        <input
          className="input"
          id="evidence"
          name="evidence"
          value={evidence}
          onChange={(e) => setEvidence(e.target.value)}
          disabled={locked}
          placeholder="A short example of when you did this…"
        />
      </div>

      {/* The only place the commit rule is stated to the PM. It appears while
          an answer is unconfirmed and says what will confirm it, so nobody has
          to infer the rule from the button's behaviour. */}
      {!locked && dirty && level !== null && (
        <p className="note" style={{ marginTop: 10 }} role="status">
          {/* Offline, a confirmed answer goes to the outbox and the screen does
              not move — so the hint kept saying "Not saved yet" about an answer
              that was already safe, and clicking again changed nothing visible.
              `dirty` compares against the SERVER's value, which no navigation
              refreshed; the queue is the other half of the truth. */}
          {queued[control] === level
            ? <>Saved on this device — it will send when you are back online.</>
            : <>Not saved yet — <b>{commitLabel}</b> saves it.</>}
        </p>
      )}

      <div className="assess-actions">
        {!locked && (
          /* The label changes with what the click will DO (decision D11).
             Skipping is allowed — a PM who wants to think about a hard control
             should not be trapped on it — but it is never accidental: the
             button says which of the two is about to happen. The hole stays
             visible in the progress count, the "not scored" filter and the
             blocked Submit. */
          <button
            className={level === null ? "btn btn-secondary" : "btn btn-primary"}
            type="button"
            onClick={goNext}
          >
            {level === null ? "Skip for now →" : `${commitLabel} →`}
          </button>
        )}
        {prevControl && (
          <Link className="btn btn-secondary" href={`/assess?c=${prevControl}`}>
            ← Previous
          </Link>
        )}
        {locked && nextControl && (
          <Link className="btn btn-secondary" href={`/assess?c=${nextControl}`}>
            Next →
          </Link>
        )}
      </div>
    </div>
  );
}
