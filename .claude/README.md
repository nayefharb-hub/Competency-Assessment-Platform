# .claude/ — Claude Code configuration

## gstack SessionStart hook

`hooks/session-start.sh` (wired up in `settings.json`) installs
[gstack](https://github.com/garrytan/gstack) — an AI dev toolkit of slash-command
skills (`review`, `plan-*`, `qa`, `cso`, `ship`, `office-hours`, …) — so they are
available to **Claude Code on the web**.

### How it works

- Runs at **SessionStart**, only in the web environment (`$CLAUDE_CODE_REMOTE`).
- Clones the fork **`nayefharb-hub/gstack`**, builds it with `bun`, and registers
  the skills. gstack surfaces as a single **`gstack`** router skill that dispatches
  to the sub-skills.
- **Async** — the clone/build runs in the background so the session starts
  immediately. On the very first run in a fresh container, gstack may still be
  installing for a few seconds after the session opens.
- **Idempotent** — the web container is cached after the first successful run, so
  later sessions skip straight past the clone/build (and return synchronously).
- **Non-fatal** — if gstack can't install (e.g. a network policy blocks GitHub or
  the `bun` registry), the hook logs and exits 0; your session still starts.

### Known limitations on the web

- **Browser-based skills** (screenshots, `/browse`, visual design review) need a
  Chromium that matches gstack's Playwright version. The web policy blocks that
  download, so those skills are limited here. Reasoning skills work normally.
- To update gstack, pull upstream into your fork `nayefharb-hub/gstack`; the next
  fresh web container picks it up.

Local Claude Code (on your own machine) is unaffected by this hook — install
gstack there directly per its README.
