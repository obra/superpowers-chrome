#!/usr/bin/env bash
# Test navigation commands

echo "=== Navigate to google.com ==="
./chrome-ws navigate 0 "https://google.com"

echo -e "\n=== Wait for search input ==="
./chrome-ws wait-for 0 "textarea[name=q]"
echo "Search box appeared!"
