#!/bin/bash
# Install gstack (AI dev toolkit) so its skills are available to Claude Code
# on the web. Clones your fork, builds it, and registers the skill router.
#
# - Idempotent: safe to run every session (skips work once built/cached).
# - Non-interactive.
# - Non-fatal: if anything gstack-specific fails, the session still starts.
#
# gstack: https://github.com/garrytan/gstack  (this uses your fork below)
set -uo pipefail

# Only needed in the remote (web) environment. Local Claude Code keeps its own
# persistent install in ~/.claude, so there is nothing to do there.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# --- Config ---------------------------------------------------------------
GSTACK_REPO="https://github.com/nayefharb-hub/gstack"   # your public fork
GSTACK_DIR="$HOME/.claude/skills/gstack"
BUILT_MARKER="$GSTACK_DIR/browse/dist/browse"           # exists after a build

# Make bun/node discoverable (paths used by the web container).
export PATH="$HOME/.bun/bin:/opt/node22/bin:$PATH"

# --- Fast path: already built in this (cached) container ------------------
if [ -f "$GSTACK_DIR/SKILL.md" ] && [ -x "$BUILT_MARKER" ]; then
  echo "gstack: already installed"
  exit 0
fi

command -v git >/dev/null 2>&1 || { echo "gstack: git not found, skipping"; exit 0; }
command -v bun >/dev/null 2>&1 || { echo "gstack: bun not found (gstack requires bun), skipping"; exit 0; }

# --- Async: install in the background so the session starts immediately ----
# Emitted only once we know real work (clone + build) is needed; the fast paths
# above return synchronously and instantly. Trade-off: the session may open
# before gstack finishes installing on the very first run in a fresh container.
echo '{"async": true, "asyncTimeout": 300000}'

# --- Clone your fork if not present ---------------------------------------
if [ ! -f "$GSTACK_DIR/SKILL.md" ]; then
  echo "gstack: cloning $GSTACK_REPO ..."
  rm -rf "$GSTACK_DIR"
  git clone --single-branch --depth 1 "$GSTACK_REPO" "$GSTACK_DIR" \
    || { echo "gstack: clone failed (network policy may block GitHub), skipping"; exit 0; }
fi

# --- Build + register skills ----------------------------------------------
# The Playwright browser DOWNLOAD is blocked by the web network policy and is
# non-fatal: a Chromium is already present at /opt/pw-browsers for the browser
# skills, and the reasoning skills register regardless of the browser step.
export GSTACK_SKIP_FONTS=1
export GSTACK_SKIP_COREUTILS=1
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}"

echo "gstack: running setup (build + register skills)..."
( cd "$GSTACK_DIR" && ./setup --host claude ) \
  || echo "gstack: setup exited non-zero (browser step is skipped on web) — reasoning skills still registered"

echo "gstack: ready — use the 'gstack' skill to route to review / plan / qa / cso / ship / etc."
exit 0
