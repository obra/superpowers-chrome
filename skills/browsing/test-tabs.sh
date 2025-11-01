#!/usr/bin/env bash
# Test tab management commands

echo "=== Listing tabs ==="
./chrome-ws tabs

echo -e "\n=== Creating new tab ==="
NEW_TAB=$(./chrome-ws new "https://example.com")
echo "Created tab: $NEW_TAB"

echo -e "\n=== Listing tabs again ==="
./chrome-ws tabs

echo -e "\n=== Closing new tab ==="
./chrome-ws close "$NEW_TAB"
