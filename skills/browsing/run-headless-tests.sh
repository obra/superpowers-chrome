#!/bin/bash
# Test runner that manages Chrome in headless mode and runs all tests
# Perfect for CI/CD pipelines and automated testing

set -e  # Exit on first error

# Navigate to script directory
cd "$(dirname "$0")"

# Function to cleanup Chrome on exit
cleanup() {
  echo -e "\n=== Cleaning up ==="
  ./chrome-ws stop 2>/dev/null || true
}

# Register cleanup on exit
trap cleanup EXIT

# Start Chrome in headless mode
echo "=== Starting Chrome (headless mode) ==="
./chrome-ws start --headless

# Wait for Chrome to be ready
sleep 2

# Check Chrome is accessible
if ! curl -s http://localhost:9222/json/version > /dev/null; then
  echo "ERROR: Chrome failed to start or is not accessible"
  exit 1
fi

echo -e "\n=== Running tests ==="

# Track test results
FAILED=0
TOTAL=0

# Discover all test files matching pattern test*.sh
# Exclude run-headless-tests.sh and test-with-chrome.sh
TEST_FILES=($(ls test*.sh 2>/dev/null | grep -v "^run-headless-tests.sh$" | grep -v "^test-with-chrome.sh$" | sort))

if [[ ${#TEST_FILES[@]} -eq 0 ]]; then
  echo "ERROR: No test files found matching pattern 'test*.sh'"
  exit 1
fi

echo "Found ${#TEST_FILES[@]} test(s): ${TEST_FILES[*]}"
echo ""

# Run each test
for test in "${TEST_FILES[@]}"; do
  TOTAL=$((TOTAL + 1))
  echo -e "\n╔════════════════════════════════════════╗"
  echo "║  Running: $test"
  echo "╚════════════════════════════════════════╝"

  if bash "$test"; then
    echo "✓ $test PASSED"
  else
    echo "✗ $test FAILED"
    FAILED=$((FAILED + 1))
  fi
done

# Summary
echo -e "\n╔════════════════════════════════════════╗"
echo "║  Test Summary"
echo "╚════════════════════════════════════════╝"
echo "Total:  $TOTAL"
echo "Passed: $((TOTAL - FAILED))"
echo "Failed: $FAILED"

if [[ $FAILED -gt 0 ]]; then
  echo -e "\n❌ Some tests failed"
  exit 1
else
  echo -e "\n✅ All tests passed!"
  exit 0
fi
