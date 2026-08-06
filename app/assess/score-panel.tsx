"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "@/app/link";
import { commit, pendingFor } from "@/lib/outbox";
import { createDwellClock, type DwellClock } from "@/lib/dwell";
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
  nextControl,
  prevControl,
  levels,
  savedLevel,
  savedEvidence,
  locked,
  milestone,
  ceLevels,
}: {
  control: string;
  nextControl: string | null;
  prevControl: string | null;
  levels: Level[];
  savedLevel: number | null;
  savedEvidence: string;
  locked: boolean;
  /** Set when this control ends a competency or an area (D25, revised by N32). */
  milestone?: Milestone | null;
  /** Persisted levels for the competency this control belongs to — the recap. */
  ceLevels?: Record<string, number | null>;
}) {
  const router = useRouter();
  const [level, setLevel] = useState<number | null>(savedLevel);
  const [evidence, setEvidence] = useState(savedEvidence);
  /* The milestone is shown INSTEAD of the panel, after the answer is committed
     and without navigating. Keyed off the control below so that arriving at a
     new control — including via Back — never lands on a stale milestone (FM7). */
  const [reached, setReached] = useState(false);
  /* Answers for this competency sitting in the outbox, unseen by the server. */
  const [queued, setQueued] = useState<Record<string, number>>({});
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

    /* THE WHOLE COMPETENCY'S QUEUE, not just this control's.
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
     * Read in an EFFECT rather than during render: the outbox is client-only,
     * so consulting it while rendering would make the server's HTML and the
     * first client render disagree about the button's label. */
    const q: Record<string, number> = {};
    for (const c of milestone?.controls ?? []) {
      const p = pendingFor(c.code);
      if (p && p.level !== null) q[c.code] = p.level;
    }
    if (queuedHere && queuedHere.level !== null) q[control] = queuedHere.level;
    setQueued(q);

    // A milestone belongs to the answer that produced it. Landing on any
    // control — forwards, or backwards with the browser button — starts from
    // the panel, never from a milestone someone already passed through.
    setReached(false);
  }, [control, savedLevel, savedEvidence, milestone]);

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
   * WHAT THE PM HAS ACTUALLY ANSWERED — server, then outbox, then this screen.
   *
   * This is N30. The server render is always one answer behind at exactly the
   * moment it matters (the last control of a competency), so the client has to
   * add what it holds. The mistake worth not repeating is doing that with
   * arithmetic: `scored + 1` can only ever correct for ONE control, and the
   * outbox routinely holds several. Asking each control what its answer is
   * makes the count and the recap agree by construction rather than by two
   * expressions that happen to match.
   *
   * `submitSelfAssessment` still counts for itself server-side. This decides
   * what the screen SAYS, never what the record holds.
   */
  const effectiveLevel = (code: string): number | null =>
    code === control ? level : (ceLevels?.[code] ?? queued[code] ?? null);

  const ceComplete = milestone
    ? milestone.controls.every((c) => effectiveLevel(c.code) !== null)
    : false;

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
      });
      // The queue is now newer than the server for this control. Record it here
      // rather than re-reading the outbox during render, which would make the
      // server's HTML and the first client render disagree.
      setQueued((q) => ({ ...q, [control]: level }));
    }
    /* Finishing a competency raises the milestone IN PLACE — no navigation, so
       this happens whether or not the browser is online. The card disables
       every action while offline and says why (review decision A1); withholding
       the milestone would deny the PM the one moment that makes 132 controls
       feel finishable, precisely when the app is already frustrating them. */
    if (milestone && ceComplete) { setReached(true); return; }

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
    router.push(nextControl ? `/assess?c=${nextControl}` : "/assess/controls?saved=1");
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
    const target = milestone?.nextControl;
    if (target) {
      const secure = location.protocol === "https:" ? "; Secure" : "";
      document.cookie =
        `cap.last=${encodeURIComponent(target)}; path=/; max-age=${60 * 60 * 24 * 120}; SameSite=Lax${secure}`;
    }
    startNavigating(() => router.push(href));
  }

  /** Continue, from the milestone. */
  function continueRun() {
    const next = milestone?.nextControl;
    leaveMilestone(next ? `/assess?c=${encodeURIComponent(next)}` : (milestone?.listHref ?? "/assess/controls?saved=1"));
  }

  /**
   * Revise a control from the recap.
   *
   * THE ROW FOR THE CONTROL YOU ARE STANDING ON IS THE COMMON CASE, and it was
   * the one that did not work: the milestone only ever renders on the last
   * control of a competency, so that control is always the last recap row —
   * the answer just given, the most likely one to want back. Pushing its own
   * URL is a no-op, and `reached` is cleared only by the effect keyed on
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
   * ONE label, used by both the button and the hint above it.
   *
   * They used to be computed separately — the hint from `nextControl`, the
   * button from the boundary — so at a competency boundary the hint said
   * "Next control saves it" above a button reading "Back to the list". It named
   * a button that was not on screen. Two notions of "what happens next",
   * rendered side by side; deriving both from this removes the possibility
   * rather than fixing the symptom.
   */
  const commitLabel = milestone && ceComplete
    ? (milestone.done === "assessment" && assessmentRemaining === 0
        ? "Review before submitting"
        : "Finish this competency")
    : (nextControl ? "Next control" : "Review before submitting");

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
