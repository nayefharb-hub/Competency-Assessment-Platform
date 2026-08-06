"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "@/app/link";
import { commit, pendingFor } from "@/lib/outbox";
import { createDwellClock, type DwellClock } from "@/lib/dwell";

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
  boundary,
}: {
  control: string;
  nextControl: string | null;
  prevControl: string | null;
  levels: Level[];
  savedLevel: number | null;
  savedEvidence: string;
  locked: boolean;
  /** Set when this control ends a competency or an area (D25). */
  boundary?: {
    href: string; done: "ce" | "area" | "assessment"; complete: boolean; label: string;
  } | null;
}) {
  const router = useRouter();
  const [level, setLevel] = useState<number | null>(savedLevel);
  const [evidence, setEvidence] = useState(savedEvidence);

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
    const queued = pendingFor(control);
    setLevel(queued ? queued.level : savedLevel);
    setEvidence(queued ? (queued.evidence ?? "") : savedEvidence);
  }, [control, savedLevel, savedEvidence]);

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
    }
    // Never ask the browser to navigate when it has told us it cannot
    // (decision D13). Measured: router.push falls back to a hard navigation,
    // which lands on Chrome's own error page — the app disappears, taking the
    // failure banner with it, and the PM has no way to know their answer was
    // kept. The answer is already in the outbox by this line, so staying put
    // costs nothing and keeps them inside the app.
    // The app-wide OfflineBanner explains this; app/link.tsx does the same for
    // every other navigation, so all of them behave alike when offline.
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    // A competency boundary sends the PM back to the list that names what they
    // just finished, rather than into the next competency's first control.
    if (boundary) { router.push(boundary.href); return; }
    router.push(nextControl ? `/assess?c=${nextControl}` : "/assess/controls?saved=1");
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
          Not saved yet — <b>{nextControl ? "Next control" : "Review before submitting"}</b> saves it.
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
            {level === null
              ? "Skip for now →"
              : boundary
                ? (boundary.done === "assessment"
                    ? (boundary.complete ? "Review before submitting →" : "Back to the list →")
                    : (boundary.complete ? "Finish this competency →" : "Back to the list →"))
                : "Next control →"}
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
