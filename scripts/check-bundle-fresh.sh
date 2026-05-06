#!/bin/bash
# Fail if mcp/dist/ would be modified by a fresh build — i.e. someone
# changed the lib but didn't rebuild the bundle. Wired into `npm test`
# so drift can't slip past CI.
set -e

# Build into a temporary location so we don't mutate the working tree
# during the test run.
ORIG_DIST=$(mktemp -d)
cp -r mcp/dist/. "$ORIG_DIST/"

cd mcp && npm run build > /dev/null 2>&1 && cd ..

if ! diff -r mcp/dist "$ORIG_DIST" > /dev/null 2>&1; then
  echo "ERROR: mcp/dist/ is stale. Run 'npm run build' and commit the result."
  diff -r mcp/dist "$ORIG_DIST" | head -20
  # Restore original dist so the working tree isn't dirtied.
  rm -rf mcp/dist
  cp -r "$ORIG_DIST" mcp/dist
  rm -rf "$ORIG_DIST"
  exit 1
fi

rm -rf "$ORIG_DIST"
echo "Bundle is fresh."
