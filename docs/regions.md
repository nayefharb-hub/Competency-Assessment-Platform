# Where this app runs, and why it matters

**Supabase (Postgres):** Central EU — Frankfurt, `eu-central-1`.
**Vercel functions:** Frankfurt, `fra1`, pinned in `vercel.json`.

Keep them the same. This is not a preference; it was measured.

## What went wrong

Vercel defaults new projects to `iad1` (Washington DC). Nobody chose that, and
nothing on screen suggested it mattered. A log export from 2026-08-04 showed:

```
middleware @ bom1  (Mumbai)         142 requests, p50   8ms
function   @ iad1  (Washington DC)  150 requests, p50   8ms
```

The p50 is a trap: 140 of those 150 function invocations were Next.js `_rsc`
link prefetches, which are cheap. Filtering to REAL page loads:

```
_rsc prefetch  n=140   p50    7ms   p90   43ms
document       n= 10   p50 1794ms   p90 5127ms
```

**Real page loads had a median of 1.8 seconds**, which is what the Head of PMO
reported as "each navigation takes a couple of seconds" and "4 seconds to move
between controls".

It was not cold starts — only three instances served the whole window, and
reused instances still reached 5,127ms.

It was distance. Every page render makes a small number of SEQUENTIAL Supabase
round trips, and each one was crossing the Atlantic:

| | co-located | Washington → Frankfurt |
|---|---|---|
| 4 sequential DB round trips | ~8ms | ~800ms |
| plus Kuwait → function, once | — | ~250ms |

## Why the function follows the DATABASE, not the user

There are several sequential database hops per render and only one user round
trip, so the database distance is multiplied and the user distance is not.
Frankfurt is also far closer to Kuwait than Washington is, so this happens to
win both ways — but if it ever conflicts, follow the database.

## If the Supabase region ever changes

Change `vercel.json` in the same commit. They are one decision, and splitting
them across a dashboard and a repo is how they drift apart.

## Related

The number of round trips per render was cut from ~18 to 4 on 2026-08-04 (see
`lib/framework.ts`, `proxy.ts`, `lib/auth.ts`). That work was worth doing and
is not made redundant by the region — 4 slow round trips still beat 18 — but
the region is the multiplier, and no amount of code removes it.
