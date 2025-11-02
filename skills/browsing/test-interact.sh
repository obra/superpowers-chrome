#!/usr/bin/env bash
# Test interaction commands

echo "=== Navigate to search page ==="
./chrome-ws navigate 0 "https://google.com"

echo "=== Fill search box ==="
./chrome-ws fill 0 "textarea[name=q]" "chrome devtools protocol"

echo "=== Click search button ==="
./chrome-ws click 0 "input[name=btnK]"
