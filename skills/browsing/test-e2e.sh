#!/usr/bin/env bash
# End-to-end test: Navigate, extract, and verify multi-step workflow

echo "=== End-to-End Workflow Test ==="
echo

# Step 1: Navigate to example.com
echo "Step 1: Navigate to example.com"
./chrome-ws navigate 0 "https://example.com"
echo

# Step 2: Wait for page to load
echo "Step 2: Wait for page to load"
./chrome-ws wait-for 0 "h1"
echo

# Step 3: Extract page title
echo "Step 3: Extract page title"
TITLE=$(./chrome-ws eval 0 "document.title")
echo "Title: $TITLE"
echo

# Step 4: Extract main heading
echo "Step 4: Extract main heading"
HEADING=$(./chrome-ws extract 0 "h1")
echo "Heading: $HEADING"
echo

# Step 5: Extract link URL
echo "Step 5: Extract link URL"
LINK=$(./chrome-ws attr 0 "a" "href")
echo "Link: $LINK"
echo

# Step 6: Navigate to the link
echo "Step 6: Navigate to the link"
./chrome-ws navigate 0 "$LINK"
echo

# Step 7: Wait for new page
echo "Step 7: Wait for new page to load"
./chrome-ws wait-for 0 "body"
echo

# Step 8: Get new page title
echo "Step 8: Get new page title"
NEW_TITLE=$(./chrome-ws eval 0 "document.title")
echo "New page title: $NEW_TITLE"
echo

echo "=== End-to-End Test Complete ==="
