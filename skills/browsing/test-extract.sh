#!/usr/bin/env bash
# Test extraction commands

echo "=== Navigate to example.com ==="
./chrome-ws navigate 0 "https://example.com"

echo -e "\n=== Evaluate JavaScript ==="
./chrome-ws eval 0 "document.title"

echo -e "\n=== Extract text content ==="
./chrome-ws extract 0 "h1"

echo -e "\n=== Get attribute ==="
./chrome-ws attr 0 "a" "href"

echo -e "\n=== Get HTML ==="
./chrome-ws html 0 "body"
