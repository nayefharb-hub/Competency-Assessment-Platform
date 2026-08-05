/**
 * Has this assessment stopped moving? (D16)
 *
 * Completion alone cannot tell apart a PM who is 40% through and scoring
 * daily from one who stopped three weeks ago — they render identically. This
 * is the difference.
 *
 * STALL_DAYS is a starting number, not a studied one. Seven days is "a week
 * has gone by", which is when a human would start wondering; nothing has been
 * measured to support it, and the pilot is what should replace it. It is also
 * deliberately silent about someone on leave: the marker is an invitation to
 * look, never a verdict, and there is no email attached to it.
 */
export const STALL_DAYS = 7;

export function daysSince(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  return Math.floor((now - then) / 86_400_000);
}

export function hasStalled(
  opts: { lastScored: string | null; scored: number; total: number; state: string | null },
  now: number,
): boolean {
  // Only a draft in progress can stall. A submitted assessment is waiting on
  // the assessor, and an untouched one has not started rather than stopped.
  if (opts.state !== "draft") return false;
  if (opts.scored === 0 || opts.scored >= opts.total) return false;
  const days = daysSince(opts.lastScored, now);
  return days !== null && days >= STALL_DAYS;
}
