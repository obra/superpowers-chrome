#!/usr/bin/env bash
# Manual test: requires Chrome running with --remote-debugging-port=9222

# Get first tab's WebSocket URL
TAB_URL=$(curl -s http://127.0.0.1:9222/json | node -pe "JSON.parse(require('fs').readFileSync(0))[0].webSocketDebuggerUrl")

# Test raw command - get browser version
./chrome-ws raw "$TAB_URL" '{"id":1,"method":"Browser.getVersion"}'
