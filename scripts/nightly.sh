#!/bin/bash
# Pocketfolio nightly run, on the owner's Mac (TASK-ebay-direct.md §4):
#
#   scrape-ebay-sold.mjs → build-snapshot.mjs → git add data/ → commit → push
#
# Started by launchd at 04:00 local (scripts/launchd/com.pocketfolio.nightly.plist),
# logging to ~/.pocketfolio/nightly.log. A failed scrape (login wall, bot
# check, zero items everywhere) stops here and nothing is built or committed.
# A failed push (no network) leaves the commit; the next run pushes both.
#
# PPT_TOKEN, if set in ~/.pocketfolio/env, lets the build fill grades our own
# sales did not answer while the subscription lasts.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"   # launchd starts with a bare PATH
[ -f "$HOME/.pocketfolio/env" ] && . "$HOME/.pocketfolio/env"

echo "=== $(date '+%Y-%m-%d %H:%M:%S %z') nightly"

# Start from what GitHub has, so the commit lands on top of the Action's.
# Everything under data/ is regenerated below, so on a conflict the local
# (replayed) side wins; if even that fails, abort cleanly and build locally.
if ! git pull -q --rebase --autostash -X theirs origin main; then
  git rebase --abort 2>/dev/null || true
  echo "pull failed — building on the local copy"
fi

node scripts/scrape-ebay-sold.mjs
node scripts/build-snapshot.mjs
node scripts/prune-snapshots.mjs

git add data/
if git diff --cached --quiet; then
  echo "nothing changed"
else
  git commit -q -m "prices: eBay sold + snapshot $(date +%Y-%m-%d)"
fi

if git push origin HEAD:main; then
  echo "pushed"
else
  echo "push failed — the commit stays; the next run pushes it"
fi
