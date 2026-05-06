#!/bin/bash
# Fail if mcp/dist/ would be modified by a fresh build — i.e. someone
# changed mcp/src/ but didn't rebuild the bundle. Wired into `npm test`
# so drift can't slip past CI.
#
# Note: this only catches mcp/src/ drift. The bundle loads
# skills/browsing/chrome-ws-lib.js at runtime, so lib changes do NOT
# show up here — they're caught by test/bundle-drift.test.mjs instead.
set -e

# Build into a temporary location so we don't mutate the working tree
# during the test run.
ORIG_DIST=$(mktemp -d)
cp -r mcp/dist/. "$ORIG_DIST/"

# If we're interrupted or fail mid-build, restore the original dist so
# the working tree is never left with a freshly-built bundle clobbering
# the committed one.
restore_dist() {
  if [ -d "$ORIG_DIST" ]; then
    rm -rf mcp/dist
    cp -r "$ORIG_DIST" mcp/dist
    rm -rf "$ORIG_DIST"
  fi
}
trap restore_dist EXIT INT TERM

cd mcp && npm run build > /dev/null 2>&1 && cd ..

if ! diff -r mcp/dist "$ORIG_DIST" > /dev/null 2>&1; then
  echo "ERROR: mcp/dist/ is stale. Run 'npm run build' and commit the result."
  diff -r mcp/dist "$ORIG_DIST" | head -20
  exit 1
fi

# Clean exit — disable trap so we don't double-restore.
trap - EXIT INT TERM
rm -rf "$ORIG_DIST"
echo "Bundle is fresh."
