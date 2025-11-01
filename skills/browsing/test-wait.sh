#!/usr/bin/env bash
# Test wait commands

echo "=== Navigate to example.com ==="
./chrome-ws navigate 0 "https://example.com"

echo "=== Wait for text 'Example Domain' ==="
./chrome-ws wait-text 0 "Example Domain"
echo "Text found!"
