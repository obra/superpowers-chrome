# Chrome Direct Access Examples (MCP Tool)

Examples using the `use_browser` MCP tool. For command-line bash examples, see [COMMANDLINE-USAGE.md](COMMANDLINE-USAGE.md).

## Table of Contents

1. [Basic Operations](#basic-operations)
2. [Form Automation](#form-automation)
3. [Web Scraping](#web-scraping)
4. [Multi-Tab Workflows](#multi-tab-workflows)
5. [Dynamic Content](#dynamic-content)
6. [Advanced Patterns](#advanced-patterns)

---

## Basic Operations

### Extract Page Content

Navigate to a page and extract various elements:

```
{action: "navigate", payload: "https://example.com"}
{action: "await_element", selector: "h1"}

// Get page title
{action: "eval", payload: "document.title"}

// Get main heading text
{action: "extract", payload: "text", selector: "h1"}

// Get first link URL
{action: "attr", selector: "a", payload: "href"}
```

### Get All Links

Use JavaScript evaluation to get structured data:

```
{action: "navigate", payload: "https://example.com"}
{action: "eval", payload: "Array.from(document.querySelectorAll('a')).map(a => ({ text: a.textContent.trim(), href: a.href }))"}
```

### Extract Table Data

Convert HTML table to structured data:

```
{action: "navigate", payload: "https://example.com/data"}
{action: "await_element", selector: "table"}

// Convert table to JSON array
{action: "eval", payload: "Array.from(document.querySelectorAll('table tr')).map(row => Array.from(row.cells).map(cell => cell.textContent.trim()))"}
```

### Get Page as Markdown

Extract entire page content in markdown format:

```
{action: "navigate", payload: "https://example.com"}
{action: "await_element", selector: "body"}
{action: "extract", payload: "markdown"}
```

---

## Form Automation

### Simple Login

Navigate, fill credentials, and submit:

```
{action: "navigate", payload: "https://app.example.com/login"}
{action: "await_element", selector: "input[name=email]"}

// Fill credentials
{action: "type", selector: "input[name=email]", payload: "user@example.com"}
{action: "type", selector: "input[name=password]", payload: "securepass123\n"}

// Wait for successful login
{action: "await_text", payload: "Dashboard"}
```

Note: The `\n` at the end of the password submits the form.

### Multi-Step Form

Handle forms that show steps progressively:

```
{action: "navigate", payload: "https://example.com/register"}

// Step 1: Personal information
{action: "type", selector: "input[name=firstName]", payload: "John"}
{action: "type", selector: "input[name=lastName]", payload: "Doe"}
{action: "type", selector: "input[name=email]", payload: "john@example.com"}
{action: "click", selector: "button.next"}

// Wait for step 2 to load
{action: "await_element", selector: "input[name=address]"}

// Step 2: Address
{action: "type", selector: "input[name=address]", payload: "123 Main St"}
{action: "select", selector: "select[name=state]", payload: "IL"}
{action: "type", selector: "input[name=zip]", payload: "62701"}
{action: "click", selector: "button.submit"}

{action: "await_text", payload: "Registration complete"}
```

### Search with Filters

Use dropdowns and text inputs together:

```
{action: "navigate", payload: "https://library.example.com/search"}
{action: "await_element", selector: "form"}

// Select category dropdown
{action: "select", selector: "select[name=category]", payload: "books"}

// Fill search term
{action: "type", selector: "input[name=query]", payload: "chrome devtools"}

// Submit and count results
{action: "click", selector: "button[type=submit]"}
{action: "await_element", selector: ".results"}

// Count results
{action: "eval", payload: "document.querySelectorAll('.result').length"}
```

---

## Web Scraping

### Article Content

Extract article metadata and content:

```
{action: "navigate", payload: "https://blog.example.com/article"}
{action: "await_element", selector: "article"}

// Extract metadata
{action: "extract", payload: "text", selector: "article h1"}
{action: "extract", payload: "text", selector: ".author-name"}
{action: "extract", payload: "text", selector: "time"}
{action: "extract", payload: "text", selector: "article .content"}
```

### Product Information

Scrape product details from e-commerce site:

```
{action: "navigate", payload: "https://shop.example.com/product/123"}
{action: "await_element", selector: ".product-details"}

// Extract product data
{action: "extract", payload: "text", selector: "h1.product-name"}
{action: "extract", payload: "text", selector: ".price"}
{action: "attr", selector: ".product-image img", payload: "src"}
{action: "extract", payload: "text", selector: ".stock-status"}
```

### Batch Extract Structured Data

Get multiple products at once using JavaScript:

```
{action: "navigate", payload: "https://shop.example.com/category/electronics"}
{action: "await_element", selector: ".product-grid"}

// Extract all products as structured data
{action: "eval", payload: `
  Array.from(document.querySelectorAll('.product-card')).map(card => ({
    name: card.querySelector('.product-name').textContent,
    price: card.querySelector('.price').textContent,
    image: card.querySelector('img').src,
    url: card.querySelector('a').href
  }))
`}
```

---

## Multi-Tab Workflows

### Email Extraction

List tabs, then extract data from specific tab:

```
// Find email tab
{action: "list_tabs"}

// Use tab 2 for email (from list_tabs output)
{action: "click", tab_index: 2, selector: "a[title*='Organization receipt']"}
{action: "await_element", tab_index: 2, selector: ".email-body"}

// Extract donation amount
{action: "extract", tab_index: 2, payload: "text", selector: ".donation-amount"}
```

### Price Comparison

Open multiple stores and compare prices:

```
// Navigate first tab
{action: "navigate", payload: "https://store1.com/product"}

// Open additional tabs
{action: "new_tab"}
{action: "navigate", tab_index: 1, payload: "https://store2.com/product"}

{action: "new_tab"}
{action: "navigate", tab_index: 2, payload: "https://store3.com/product"}

// Wait for all to load and extract prices
{action: "await_element", tab_index: 0, selector: ".price"}
{action: "extract", tab_index: 0, payload: "text", selector: ".price"}

{action: "await_element", tab_index: 1, selector: ".price"}
{action: "extract", tab_index: 1, payload: "text", selector: ".price"}

{action: "await_element", tab_index: 2, selector: ".price"}
{action: "extract", tab_index: 2, payload: "text", selector: ".price"}
```

### Cross-Reference Between Sites

Extract data from one site and use in another:

```
// Get phone number from company site
{action: "navigate", payload: "https://company.com/contact"}
{action: "await_element", selector: ".phone"}
{action: "extract", payload: "text", selector: ".phone"}

// Store the result, then open verification site
{action: "new_tab"}
{action: "navigate", tab_index: 1, payload: "https://lookup.com"}
{action: "await_element", tab_index: 1, selector: "input[name=phone]"}

// Fill with extracted phone number
{action: "type", tab_index: 1, selector: "input[name=phone]", payload: "<phone-from-previous-extract>"}
{action: "click", tab_index: 1, selector: "button.search"}
{action: "await_element", tab_index: 1, selector: ".results"}
{action: "extract", tab_index: 1, payload: "text", selector: ".verification-status"}
```

---

## Dynamic Content

### Wait for AJAX to Complete

Wait for loading spinner to disappear:

```
{action: "navigate", payload: "https://app.com/dashboard"}

// Wait for spinner to disappear using custom JavaScript
{action: "eval", payload: `
  new Promise(resolve => {
    const check = () => {
      if (!document.querySelector('.spinner')) {
        resolve(true);
      } else {
        setTimeout(check, 100);
      }
    };
    check();
  })
`}

// Now safe to extract
{action: "extract", payload: "text", selector: ".dashboard-data"}
```

### Infinite Scroll

Scroll to load more content:

```
{action: "navigate", payload: "https://example.com/feed"}
{action: "await_element", selector: ".feed-item"}

// Scroll multiple times
{action: "eval", payload: "window.scrollTo(0, document.body.scrollHeight)"}
{action: "await_element", selector: ".feed-item", timeout: 2000}

{action: "eval", payload: "window.scrollTo(0, document.body.scrollHeight)"}
{action: "await_element", selector: ".feed-item", timeout: 2000}

{action: "eval", payload: "window.scrollTo(0, document.body.scrollHeight)"}
{action: "await_element", selector: ".feed-item", timeout: 2000}

// Count loaded items
{action: "eval", payload: "document.querySelectorAll('.feed-item').length"}
```

### Wait for Element to Become Enabled

Wait for button to be clickable:

```
{action: "click", selector: "button.start"}

// Wait for continue button to enable
{action: "eval", payload: `
  new Promise(resolve => {
    const check = () => {
      const btn = document.querySelector('button.continue');
      if (btn && !btn.disabled) {
        resolve(true);
      } else {
        setTimeout(check, 100);
      }
    };
    check();
  })
`}

{action: "click", selector: "button.continue"}
```

---

## Advanced Patterns

### Multi-Step Workflow

Complete booking flow with validation:

```
{action: "navigate", payload: "https://booking.example.com"}

// Search
{action: "type", selector: "input[name=destination]", payload: "San Francisco"}
{action: "type", selector: "input[name=checkin]", payload: "2025-12-01"}
{action: "click", selector: "button.search"}

// Select hotel
{action: "await_element", selector: ".hotel-results"}
{action: "click", selector: ".hotel-card:first-child .select"}

// Choose room
{action: "await_element", selector: ".room-options"}
{action: "click", selector: ".room[data-type=deluxe] .book"}

// Fill guest info
{action: "await_element", selector: "form.guest-info"}
{action: "type", selector: "input[name=firstName]", payload: "Jane"}
{action: "type", selector: "input[name=lastName]", payload: "Smith"}
{action: "type", selector: "input[name=email]", payload: "jane@example.com"}

// Review (don't complete)
{action: "click", selector: "button.review"}
{action: "await_element", selector: ".summary"}

// Extract confirmation details
{action: "extract", payload: "text", selector: ".hotel-name"}
{action: "extract", payload: "text", selector: ".total-price"}
```

### Cookies and LocalStorage

Access browser storage:

```
// Get cookies
{action: "eval", payload: "document.cookie"}

// Set cookie
{action: "eval", payload: "document.cookie = 'theme=dark; path=/'"}

// Get localStorage
{action: "eval", payload: "JSON.stringify(localStorage)"}

// Set localStorage
{action: "eval", payload: "localStorage.setItem('lastVisit', new Date().toISOString())"}
```

### Handle Modals

Interact with modal dialogs:

```
{action: "click", selector: "button.open-modal"}
{action: "await_element", selector: ".modal.visible"}

// Fill modal form
{action: "type", selector: ".modal input[name=username]", payload: "testuser"}
{action: "click", selector: ".modal button.submit"}

// Wait for modal to close
{action: "eval", payload: `
  new Promise(resolve => {
    const check = () => {
      if (!document.querySelector('.modal.visible')) {
        resolve(true);
      } else {
        setTimeout(check, 100);
      }
    };
    check();
  })
`}
```

### Screenshots

Capture full page or specific elements:

```
// Full page screenshot
{action: "navigate", payload: "https://example.com"}
{action: "await_element", selector: "body"}
{action: "screenshot", payload: "/tmp/page.png"}

// Element-specific screenshot
{action: "screenshot", payload: "/tmp/element.png", selector: ".important-section"}
```

### Check Element State

Verify element properties before interaction:

```
// Check if button is disabled
{action: "eval", payload: "document.querySelector('button.submit').disabled"}

// Check if element is visible
{action: "eval", payload: "!!document.querySelector('.important-button') && window.getComputedStyle(document.querySelector('.important-button')).display !== 'none'"}

// Check element exists
{action: "eval", payload: "!!document.querySelector('.important-button')"}
```

---

## Tips and Best Practices

### Always Wait Before Interaction

Don't interact with elements immediately after navigation:

```
// BAD - might fail if page slow to load
{action: "navigate", payload: "https://example.com"}
{action: "click", selector: "button"}  // May fail!

// GOOD - wait for element first
{action: "navigate", payload: "https://example.com"}
{action: "await_element", selector: "button"}
{action: "click", selector: "button"}
```

### Use Specific Selectors

Avoid generic selectors that match multiple elements:

```
// BAD - matches first button on page
{action: "click", selector: "button"}

// GOOD - specific selector
{action: "click", selector: "button[type=submit]"}
{action: "click", selector: "button.login-button"}
{action: "click", selector: "#submit-form"}
```

### Verify Selectors First

Check page structure before building workflow:

```
// Check page HTML
{action: "extract", payload: "html"}

// Or check specific element
{action: "extract", payload: "html", selector: "form"}
```

### Handle Dynamic Content

Wait for content to load before extraction:

```
// BAD - tries to extract before content loads
{action: "navigate", payload: "https://app.com"}
{action: "extract", payload: "text", selector: ".user-name"}  // Might be empty!

// GOOD - wait for content
{action: "navigate", payload: "https://app.com"}
{action: "await_element", selector: ".user-name"}
{action: "extract", payload: "text", selector: ".user-name"}
```

### Use \n for Form Submission

Append newline to auto-submit forms:

```
// Submit search without explicit click
{action: "type", selector: "#search-input", payload: "my query\n"}

// Submit login form
{action: "type", selector: "input[name=email]", payload: "user@example.com"}
{action: "type", selector: "input[name=password]", payload: "password123\n"}
```

---

## Common Pitfalls

### Don't Cache Tab Indices

Tab indices change when tabs close - always get fresh list:

```
// BAD - index might be stale after closing tabs
// (using tab 2 without checking if it still exists)
{action: "click", tab_index: 2, selector: "button"}

// GOOD - list tabs first
{action: "list_tabs"}
// Then use appropriate index from the output
{action: "click", tab_index: 2, selector: "button"}
```

### Increase Timeout for Slow Pages

Default timeout is 5000ms, increase if needed:

```
// For slow-loading elements
{action: "await_element", selector: ".lazy-content", timeout: 30000}

// For slow AJAX requests
{action: "await_text", payload: "Data loaded", timeout: 15000}
```

### Extract Structured Data with JavaScript

For complex data extraction, use JavaScript evaluation:

```
// Instead of multiple extract calls, use one eval
{action: "eval", payload: `
  {
    title: document.querySelector('h1').textContent,
    author: document.querySelector('.author').textContent,
    date: document.querySelector('time').textContent,
    links: Array.from(document.querySelectorAll('a')).map(a => a.href)
  }
`}
```

---

## Reference

- [SKILL.md](SKILL.md) - Complete tool reference
- [COMMANDLINE-USAGE.md](COMMANDLINE-USAGE.md) - Command-line bash examples
- [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/) - Full protocol documentation
