# Command-Line Usage: chrome-ws Tool

Direct command-line access to Chrome DevTools Protocol via the `chrome-ws` bash tool.

**Note**: For use within Claude Code, the MCP `use_browser` tool is recommended. This document is for direct command-line usage or integration with other tools.

## Setup

```bash
cd ~/.claude/plugins/cache/using-chrome-directly/skills/using-chrome-directly
chmod +x chrome-ws
./chrome-ws start    # Auto-detects platform, launches Chrome
./chrome-ws tabs     # Verify running
```

Chrome starts with `--remote-debugging-port=9222` and separate profile in `/tmp/chrome-debug` (or `C:\temp\chrome-debug` on Windows).

## Command Reference

**Setup:**
```bash
chrome-ws start                 # Launch Chrome (auto-detects platform)
```

**Tab Management:**
```bash
chrome-ws tabs                  # List tabs
chrome-ws new <url>            # Create tab
chrome-ws close <ws-url>       # Close tab
```

**Navigation:**
```bash
chrome-ws navigate <tab> <url>        # Navigate
chrome-ws wait-for <tab> <selector>   # Wait for element
chrome-ws wait-text <tab> <text>      # Wait for text
```

**Interaction:**
```bash
chrome-ws click <tab> <selector>              # Click
chrome-ws fill <tab> <selector> <value>       # Fill input
chrome-ws select <tab> <selector> <value>     # Select dropdown
```

**Extraction:**
```bash
chrome-ws eval <tab> <js>               # Execute JavaScript
chrome-ws extract <tab> <selector>      # Get text content
chrome-ws attr <tab> <selector> <attr>  # Get attribute
chrome-ws html <tab> [selector]         # Get HTML
```

**Export:**
```bash
chrome-ws screenshot <tab> <file.png>   # Capture screenshot
chrome-ws markdown <tab> <file.md>      # Save as markdown
```

**Raw Protocol:**
```bash
chrome-ws raw <ws-url> <json-rpc>       # Direct CDP access
```

`<tab>` accepts either tab index (0, 1, 2) or full WebSocket URL.

## Examples

### Basic Operations

**Extract page content:**
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

**Get all links:**
```bash
chrome-ws navigate 0 "https://example.com"
LINKS=$(chrome-ws eval 0 "Array.from(document.querySelectorAll('a')).map(a => ({
  text: a.textContent.trim(),
  href: a.href
}))")
echo "$LINKS"
```

**Extract table data:**
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

### Form Automation

**Simple login:**
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

**Multi-step form:**
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

**Search with filters:**
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

### Web Scraping

**Article content:**
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

**Product information:**
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

**Batch process URLs:**
```bash
URLS=("page1" "page2" "page3")

for URL in "${URLS[@]}"; do
  chrome-ws navigate 0 "https://example.com/$URL"
  chrome-ws wait-for 0 "h1"
  TITLE=$(chrome-ws extract 0 "h1")
  echo "$URL: $TITLE" >> results.txt
done
```

### Multi-Tab Workflows

**Email extraction:**
```bash
# List all tabs
chrome-ws tabs

# Use the email tab index from output (e.g., tab 2)
EMAIL_TAB=2

# Click specific email
chrome-ws click $EMAIL_TAB "a[title*='Organization receipt']"

# Wait for email to load
chrome-ws wait-for $EMAIL_TAB ".email-body"

# Extract donation amount
AMOUNT=$(chrome-ws extract $EMAIL_TAB ".donation-amount")
echo "Donation: $AMOUNT"
```

**Price comparison:**
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

**Cross-reference between sites:**
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

### Dynamic Content

**Wait for AJAX to complete:**
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

**Infinite scroll:**
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

**Monitor for changes:**
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

### Advanced Patterns

**Multi-step workflow:**
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

# Review
chrome-ws click 0 "button.review"
chrome-ws wait-for 0 ".summary"

# Extract confirmation
HOTEL=$(chrome-ws extract 0 ".hotel-name")
TOTAL=$(chrome-ws extract 0 ".total-price")
echo "$HOTEL: $TOTAL"
```

**Cookies and localStorage:**
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

**Handle modals:**
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

**Network monitoring with raw CDP:**
```bash
# Enable network monitoring
chrome-ws raw 0 '{"id":1,"method":"Network.enable","params":{}}'

# Navigate and capture traffic
chrome-ws navigate 0 "https://api.example.com"

# Get performance metrics
chrome-ws raw 0 '{"id":2,"method":"Performance.getMetrics","params":{}}'
```

**Screenshots and PDF:**
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

## Error Handling

**Check element exists:**
```bash
# Verify button exists
EXISTS=$(chrome-ws eval 0 "!!document.querySelector('.important-button')")

if [ "$EXISTS" = "true" ]; then
  chrome-ws click 0 ".important-button"
else
  echo "Button not found on page"
fi
```

**Verify command success:**
```bash
if ! chrome-ws navigate 0 "https://example.com"; then
  echo "Navigation failed - Chrome not running?"
  exit 1
fi
```

**Retry pattern:**
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

## Best Practices

**Always wait before interaction:**
```bash
# BAD - might fail if page slow to load
chrome-ws navigate 0 "https://example.com"
chrome-ws click 0 "button"  # May fail!

# GOOD - wait for element first
chrome-ws navigate 0 "https://example.com"
chrome-ws wait-for 0 "button"
chrome-ws click 0 "button"
```

**Use specific selectors:**
```bash
# BAD - matches first button on page
chrome-ws click 0 "button"

# GOOD - specific selector
chrome-ws click 0 "button[type=submit]"
chrome-ws click 0 "button.login-button"
chrome-ws click 0 "#submit-form"
```

**Test selectors with html command:**
```bash
# Check page structure
chrome-ws html 0 | grep "submit"

# Check specific element exists
chrome-ws html 0 "form"
```

**Escape special characters:**
```bash
# Use double quotes for variables
chrome-ws fill 0 "input[name=search]" "$SEARCH_TERM"

# Use single quotes for literal strings with special chars
chrome-ws eval 0 'document.querySelector(".item").textContent'
```

## Common Pitfalls

**Don't cache tab indices** - they change when tabs close:
```bash
# BAD - index might be stale
TAB=2
# ... much later ...
chrome-ws click $TAB "button"  # Tab 2 might not exist anymore

# GOOD - fetch fresh before use
chrome-ws tabs
chrome-ws click 2 "button"
```

**Don't forget to wait for dynamic content:**
```bash
# BAD - tries to extract before content loads
chrome-ws navigate 0 "https://app.com"
chrome-ws extract 0 ".user-name"  # Might be empty!

# GOOD - wait for content
chrome-ws navigate 0 "https://app.com"
chrome-ws wait-for 0 ".user-name"
chrome-ws extract 0 ".user-name"
```

**Handle element state:**
```bash
# Check if button is disabled
DISABLED=$(chrome-ws eval 0 "document.querySelector('button.submit').disabled")

if [ "$DISABLED" = "false" ]; then
  chrome-ws click 0 "button.submit"
else
  echo "Button is disabled"
fi
```

## Troubleshooting

**Connection refused:** Verify Chrome running with `curl http://127.0.0.1:9222/json`

**Element not found:** Check page structure with `chrome-ws html 0`

**Timeout:** Use `wait-for` before interaction. Chrome has 30s timeout.

**Tab index out of range:** Run `chrome-ws tabs` to get current indices.

## Protocol Reference

Full CDP documentation: https://chromedevtools.github.io/devtools-protocol/

Common methods via `raw` command:
- `Page.navigate`
- `Runtime.evaluate`
- `Network.enable`
- `Performance.getMetrics`
