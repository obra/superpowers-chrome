# Chrome Direct Access Examples

## Table of Contents

1. [Basic Operations](#basic-operations)
2. [Form Automation](#form-automation)
3. [Web Scraping](#web-scraping)
4. [Multi-Tab Workflows](#multi-tab-workflows)
5. [Dynamic Content](#dynamic-content)
6. [Advanced Patterns](#advanced-patterns)
7. [Error Handling](#error-handling)

---

## Basic Operations

### Extract Page Content

```bash
chrome-ws navigate 0 "https://example.com"
chrome-ws wait-for 0 "h1"

# Get page title
TITLE=$(chrome-ws eval 0 "document.title")

# Get main heading
HEADING=$(chrome-ws extract 0 "h1")

# Get first link URL
LINK=$(chrome-ws attr 0 "a" "href")
```

### Get All Links

Use `eval` to execute JavaScript that returns structured data:

```bash
chrome-ws navigate 0 "https://example.com"
LINKS=$(chrome-ws eval 0 "Array.from(document.querySelectorAll('a')).map(a => ({
  text: a.textContent.trim(),
  href: a.href
}))")
echo "$LINKS"
```

### Extract Table Data

```bash
chrome-ws navigate 0 "https://example.com/data"
chrome-ws wait-for 0 "table"

# Convert table to JSON array
TABLE=$(chrome-ws eval 0 "
  Array.from(document.querySelectorAll('table tr')).map(row =>
    Array.from(row.cells).map(cell => cell.textContent.trim())
  )
")
```

---

## Form Automation

### Simple Login

```bash
chrome-ws navigate 0 "https://app.example.com/login"
chrome-ws wait-for 0 "input[name=email]"

# Fill credentials
chrome-ws fill 0 "input[name=email]" "user@example.com"
chrome-ws fill 0 "input[name=password]" "securepass123"

# Submit and wait for dashboard
chrome-ws click 0 "button[type=submit]"
chrome-ws wait-text 0 "Dashboard"
```

### Multi-Step Form

Forms that show steps progressively require waiting between steps:

```bash
chrome-ws navigate 0 "https://example.com/register"

# Step 1: Personal information
chrome-ws fill 0 "input[name=firstName]" "John"
chrome-ws fill 0 "input[name=lastName]" "Doe"
chrome-ws fill 0 "input[name=email]" "john@example.com"
chrome-ws click 0 "button.next"

# Wait for step 2 to load
chrome-ws wait-for 0 "input[name=address]"

# Step 2: Address
chrome-ws fill 0 "input[name=address]" "123 Main St"
chrome-ws select 0 "select[name=state]" "IL"
chrome-ws fill 0 "input[name=zip]" "62701"
chrome-ws click 0 "button.submit"

chrome-ws wait-text 0 "Registration complete"
```

### Search with Filters

Dropdowns require `select` command, not `fill`:

```bash
chrome-ws navigate 0 "https://library.example.com/search"
chrome-ws wait-for 0 "form"

# Select category dropdown
chrome-ws select 0 "select[name=category]" "books"

# Fill search term
chrome-ws fill 0 "input[name=query]" "chrome devtools"

# Submit search
chrome-ws click 0 "button[type=submit]"
chrome-ws wait-for 0 ".results"

# Count results
RESULTS=$(chrome-ws eval 0 "document.querySelectorAll('.result').length")
echo "Found $RESULTS results"
```

---

## Web Scraping

### Article Content

```bash
chrome-ws navigate 0 "https://blog.example.com/article"
chrome-ws wait-for 0 "article"

# Extract metadata
TITLE=$(chrome-ws extract 0 "article h1")
AUTHOR=$(chrome-ws extract 0 ".author-name")
DATE=$(chrome-ws extract 0 "time")
CONTENT=$(chrome-ws extract 0 "article .content")

# Save to file
cat > article.txt <<EOF
Title: $TITLE
Author: $AUTHOR
Date: $DATE

$CONTENT
EOF
```

### Product Information

```bash
chrome-ws navigate 0 "https://shop.example.com/product/123"
chrome-ws wait-for 0 ".product-details"

NAME=$(chrome-ws extract 0 "h1.product-name")
PRICE=$(chrome-ws extract 0 ".price")
IMAGE=$(chrome-ws attr 0 ".product-image img" "src")
STOCK=$(chrome-ws extract 0 ".stock-status")

# Output as JSON
cat <<EOF
{
  "name": "$NAME",
  "price": "$PRICE",
  "image": "$IMAGE",
  "in_stock": "$STOCK"
}
EOF
```

### Batch Process URLs

```bash
URLS=("page1" "page2" "page3")

for URL in "${URLS[@]}"; do
  chrome-ws navigate 0 "https://example.com/$URL"
  chrome-ws wait-for 0 "h1"
  TITLE=$(chrome-ws extract 0 "h1")
  echo "$URL: $TITLE" >> results.txt
done
```

---

## Multi-Tab Workflows

### Email Extraction (Dan's Example)

List tabs to find the email tab index, then extract data:

```bash
# List all tabs
chrome-ws tabs

# Use the email tab index from output (e.g., tab 2)
EMAIL_TAB=2

# Click specific email by subject line
chrome-ws click $EMAIL_TAB "a[title*='Organization receipt']"

# Wait for email to load
chrome-ws wait-for $EMAIL_TAB ".email-body"

# Extract donation amount
AMOUNT=$(chrome-ws extract $EMAIL_TAB ".donation-amount")
echo "Donation: $AMOUNT"
```

### Price Comparison

Open multiple stores and extract prices:

```bash
chrome-ws navigate 0 "https://store1.com/product"
chrome-ws new "https://store2.com/product"
chrome-ws new "https://store3.com/product"
sleep 3  # Let pages load

PRICE1=$(chrome-ws extract 0 ".price")
PRICE2=$(chrome-ws extract 1 ".price")
PRICE3=$(chrome-ws extract 2 ".price")

echo "Store 1: $PRICE1"
echo "Store 2: $PRICE2"
echo "Store 3: $PRICE3"
```

### Cross-Reference Between Sites

Extract data from one site and use it in another:

```bash
# Get phone number from company site
chrome-ws navigate 0 "https://company.com/contact"
chrome-ws wait-for 0 ".phone"
PHONE=$(chrome-ws extract 0 ".phone")

# Look up phone number in verification site
chrome-ws new "https://lookup.com"
chrome-ws fill 1 "input[name=phone]" "$PHONE"
chrome-ws click 1 "button.search"
chrome-ws wait-for 1 ".results"
chrome-ws extract 1 ".verification-status"
```

---

## Dynamic Content

### Wait for AJAX to Complete

Don't extract until loading spinner disappears:

```bash
chrome-ws navigate 0 "https://app.com/dashboard"

# Wait for spinner to disappear
chrome-ws eval 0 "new Promise(resolve => {
  const check = () => {
    if (!document.querySelector('.spinner')) {
      resolve(true);
    } else {
      setTimeout(check, 100);
    }
  };
  check();
})"

# Now safe to extract
chrome-ws extract 0 ".dashboard-data"
```

### Infinite Scroll

Scroll repeatedly to load more content:

```bash
chrome-ws navigate 0 "https://example.com/feed"
chrome-ws wait-for 0 ".feed-item"

# Scroll 5 times
for i in {1..5}; do
  chrome-ws eval 0 "window.scrollTo(0, document.body.scrollHeight)"
  sleep 2
done

# Count loaded items
chrome-ws eval 0 "document.querySelectorAll('.feed-item').length"
```

### Monitor for Changes

Poll every 10 seconds for 5 minutes:

```bash
chrome-ws navigate 0 "https://example.com/status"
END=$(($(date +%s) + 300))

while [ $(date +%s) -lt $END ]; do
  STATUS=$(chrome-ws extract 0 ".status")
  echo "[$(date +%H:%M:%S)] $STATUS"

  if [[ "$STATUS" == *"ERROR"* ]]; then
    echo "ALERT: Error detected"
    break
  fi

  sleep 10
done
```

### Wait for Element to Become Enabled

Use `eval` with custom condition:

```bash
chrome-ws click 0 "button.start"

# Wait for button to enable
chrome-ws eval 0 "new Promise(resolve => {
  const check = () => {
    const btn = document.querySelector('button.continue');
    if (btn && !btn.disabled) {
      resolve(true);
    } else {
      setTimeout(check, 100);
    }
  };
  check();
})"

chrome-ws click 0 "button.continue"
```

---

## Advanced Patterns

### Multi-Step Workflow

Complete booking flow with validation at each step:

```bash
chrome-ws navigate 0 "https://booking.example.com"

# Search
chrome-ws fill 0 "input[name=destination]" "San Francisco"
chrome-ws fill 0 "input[name=checkin]" "2025-12-01"
chrome-ws click 0 "button.search"

# Select hotel
chrome-ws wait-for 0 ".hotel-results"
chrome-ws click 0 ".hotel-card:first-child .select"

# Choose room
chrome-ws wait-for 0 ".room-options"
chrome-ws click 0 ".room[data-type=deluxe] .book"

# Fill guest info
chrome-ws wait-for 0 "form.guest-info"
chrome-ws fill 0 "input[name=firstName]" "Jane"
chrome-ws fill 0 "input[name=lastName]" "Smith"
chrome-ws fill 0 "input[name=email]" "jane@example.com"

# Review (don't complete)
chrome-ws click 0 "button.review"
chrome-ws wait-for 0 ".summary"

# Extract confirmation
HOTEL=$(chrome-ws extract 0 ".hotel-name")
TOTAL=$(chrome-ws extract 0 ".total-price")
echo "$HOTEL: $TOTAL"
```

### Cookies and LocalStorage

```bash
# Get cookies
chrome-ws eval 0 "document.cookie"

# Set cookie
chrome-ws eval 0 "document.cookie = 'theme=dark; path=/'"

# Get localStorage
chrome-ws eval 0 "JSON.stringify(localStorage)"

# Set localStorage
chrome-ws eval 0 "localStorage.setItem('lastVisit', new Date().toISOString())"
```

### Handle Modals

Wait for modal to appear, interact, then wait for it to close:

```bash
chrome-ws click 0 "button.open-modal"
chrome-ws wait-for 0 ".modal.visible"

# Fill modal form
chrome-ws fill 0 ".modal input[name=username]" "testuser"
chrome-ws click 0 ".modal button.submit"

# Wait for modal to close
chrome-ws eval 0 "new Promise(resolve => {
  const check = () => {
    if (!document.querySelector('.modal.visible')) {
      resolve(true);
    } else {
      setTimeout(check, 100);
    }
  };
  check();
})"
```

### Network Monitoring with Raw CDP

Use `raw` command for CDP methods not wrapped by high-level commands:

```bash
# Enable network monitoring
chrome-ws raw 0 '{"id":1,"method":"Network.enable","params":{}}'

# Navigate and capture traffic
chrome-ws navigate 0 "https://api.example.com"

# Get performance metrics
chrome-ws raw 0 '{"id":2,"method":"Performance.getMetrics","params":{}}'
```

### Screenshots and PDF

```bash
# Capture screenshot
chrome-ws screenshot 0 "page.png"

# Or use raw CDP for more control
SCREENSHOT=$(chrome-ws raw 0 '{
  "id":1,
  "method":"Page.captureScreenshot",
  "params":{"format":"png","quality":80}
}')

# Extract base64 and save
echo "$SCREENSHOT" | node -pe "JSON.parse(require('fs').readFileSync(0)).result.data" | base64 -d > screenshot.png
```

---

## Error Handling

### Check Element Exists Before Interacting

```bash
# Verify button exists
EXISTS=$(chrome-ws eval 0 "!!document.querySelector('.important-button')")

if [ "$EXISTS" = "true" ]; then
  chrome-ws click 0 ".important-button"
else
  echo "Button not found on page"
fi
```

### Verify Command Success

All commands exit with code 1 on failure:

```bash
if ! chrome-ws navigate 0 "https://example.com"; then
  echo "Navigation failed - Chrome not running?"
  exit 1
fi
```

### Retry Pattern

```bash
for attempt in {1..3}; do
  if chrome-ws click 0 ".submit-button"; then
    echo "Click succeeded"
    break
  fi
  echo "Attempt $attempt failed, retrying..."
  sleep 2
done
```

---

## Tips and Best Practices

### Tab Index Management

Tab indices can change when tabs close. Always fetch fresh:

```bash
# Check current tabs before using an index
chrome-ws tabs

# Store index in variable
EMAIL_TAB=2
chrome-ws click $EMAIL_TAB ".email"
```

### Always Wait Before Interaction

Don't click or fill immediately after navigate - pages need time to load:

```bash
# BAD - might fail if page slow to load
chrome-ws navigate 0 "https://example.com"
chrome-ws click 0 "button"  # May fail!

# GOOD - wait for element first
chrome-ws navigate 0 "https://example.com"
chrome-ws wait-for 0 "button"
chrome-ws click 0 "button"
```

### Use Specific Selectors

Avoid generic selectors that might match multiple elements:

```bash
# BAD - matches first button on page (might not be the one you want)
chrome-ws click 0 "button"

# GOOD - specific selector
chrome-ws click 0 "button[type=submit]"
chrome-ws click 0 "button.login-button"
chrome-ws click 0 "#submit-form"
```

### Test Selectors with html Command

Before building a workflow, verify selectors work:

```bash
# Check page structure
chrome-ws html 0 | grep "submit"

# Check specific element exists
chrome-ws html 0 "form"
```

### Escape Special Characters

Properly quote bash variables and special characters:

```bash
# Use double quotes for variables
chrome-ws fill 0 "input[name=search]" "$SEARCH_TERM"

# Use single quotes for literal strings with special chars
chrome-ws eval 0 'document.querySelector(".item").textContent'
```

---

## Common Pitfalls

### Don't Cache Tab Indices

Tab indices change when tabs close:

```bash
# BAD - index might be stale
TAB=2
# ... much later ...
chrome-ws click $TAB "button"  # Tab 2 might not exist anymore

# GOOD - fetch fresh before use
chrome-ws tabs
chrome-ws click 2 "button"
```

### Don't Forget to Wait for Dynamic Content

Many sites load content asynchronously:

```bash
# BAD - tries to extract before content loads
chrome-ws navigate 0 "https://app.com"
chrome-ws extract 0 ".user-name"  # Might be empty!

# GOOD - wait for content
chrome-ws navigate 0 "https://app.com"
chrome-ws wait-for 0 ".user-name"
chrome-ws extract 0 ".user-name"
```

### Handle Element State

Check if element is enabled/visible before interaction:

```bash
# Check if button is disabled
DISABLED=$(chrome-ws eval 0 "document.querySelector('button.submit').disabled")

if [ "$DISABLED" = "false" ]; then
  chrome-ws click 0 "button.submit"
else
  echo "Button is disabled"
fi
```

### Monitor Command Output for Errors

Commands print errors to stderr. Check exit codes:

```bash
if chrome-ws navigate 0 "https://bad-url.example.com" 2>error.log; then
  echo "Success"
else
  echo "Failed: $(cat error.log)"
fi
```
