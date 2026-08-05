"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "@/app/link";
import { commit } from "@/lib/outbox";

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
}: {
  control: string;
  nextControl: string | null;
  prevControl: string | null;
  levels: Level[];
  savedLevel: number | null;
  savedEvidence: string;
  locked: boolean;
}) {
  const router = useRouter();
  const [level, setLevel] = useState<number | null>(savedLevel);
  const [evidence, setEvidence] = useState(savedEvidence);

  // Re-mounting is not guaranteed between controls (React reuses the tree when
  // only the query string changes), so the fields are re-seeded from the server
  // whenever the control does. This is also what makes an ABANDONED pick clear
  // itself: nothing was written, so the server's value is the truth.
  useEffect(() => {
    setLevel(savedLevel);
    setEvidence(savedEvidence);
  }, [control, savedLevel, savedEvidence]);

  const dirty = level !== savedLevel || evidence !== savedEvidence;

  function goNext() {
    if (level !== null && dirty) {
      commit({ control, level, evidence: evidence.trim() || null });
    }
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
              : nextControl ? "Next control →" : "Review before submitting →"}
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
