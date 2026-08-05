"use client";

import { useSyncExternalStore } from "react";
import { getServerSnapshot, getSnapshot, subscribe } from "@/lib/outbox";
import { submitAssessmentAction } from "@/app/actions";

/**
 * Submit — but never on top of an answer that has not reached the server.
 *
 * Submitting copies every `self_level` into `assessor_level` and moves the row
 * out of `draft`. A commit still in the outbox at that moment loses either
 * way: land first and the submit's prefill overwrites it, land after and the
 * draft-state check rejects it forever. Both end with the assessor reviewing a
 * number the PM did not give, and nothing on screen having said so.
 *
 * `docs/eng-plan-save-ux.md` specified this gate; the first build shipped
 * without it and a review pass found the race it leaves open.
 */
export default function SubmitButton({ complete }: { complete: boolean }) {
  const state = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const queued = state.pending.length;

  return (
    <form action={submitAssessmentAction}>
      <button className="btn btn-accent" type="submit" disabled={!complete || queued > 0}>
        Submit for review
      </button>
      {queued > 0 && (
        <p className="note" style={{ marginTop: 6 }} role="status">
          {queued === 1 ? "1 answer is" : `${queued} answers are`} still being saved —
          submitting will be possible once {queued === 1 ? "it lands" : "they land"}.
        </p>
      )}
    </form>
  );
}
