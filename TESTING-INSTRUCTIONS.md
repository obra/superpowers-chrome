# Testing Instructions for superpowers-chrome Development Branch

This document provides comprehensive testing instructions for the `xdg-cache-browser-agent` branch.

## New Features to Test

1. **XDG Cache Directory** - Session files in `~/.cache/superpowers/browser/YYYY-MM-DD/session-{timestamp}/`
2. **Headless Mode by Default** - Chrome starts invisible, faster
3. **Browser Mode Toggle** - Switch between headless and headed modes
4. **Persistent Chrome Profiles** - Profiles persist across sessions (default: `superpowers-chrome`)
5. **browser-user Agent** - Read-only agent for browser automation

---

## Test Suite

### Test 1: Basic Navigation and Auto-Capture (Headless)

**Goal**: Verify Chrome starts in headless mode and auto-captures work.

**Instructions**:
```
Use the browsing skill to navigate to https://example.com and verify auto-capture files are created.
```

**Expected Results**:
- Chrome starts in headless mode (no visible window)
- Navigation succeeds
- Files are created in `~/.cache/superpowers/browser/YYYY-MM-DD/session-{timestamp}/`:
  - `001-navigate.html`
  - `001-navigate.md`
  - `001-navigate.png`
  - `001-navigate-console.txt`
- You should be able to read the `.md` file and see "Example Domain" content
- Screenshot should be readable as an image

**Verification commands**:
```
Check browser_mode to confirm headless mode
Read the auto-captured markdown file from the session directory
```

---

### Test 2: Profile Persistence

**Goal**: Verify default profile is `superpowers-chrome` and data persists.

**Instructions**:
```
1. Get the current Chrome profile name and directory
2. Navigate to https://example.com (if not already there)
3. Kill Chrome
4. Restart Chrome by navigating to https://example.com again
5. Verify the same profile directory is reused
```

**Expected Results**:
- Default profile: `superpowers-chrome`
- Profile directory: `~/Library/Caches/superpowers/browser-profiles/superpowers-chrome/`
- Profile directory persists after Chrome restarts
- Same profile directory path before and after restart

**Verification commands**:
```
get_profile - should show "superpowers-chrome"
browser_mode - should include profile information
```

---

### Test 3: Browser Mode Toggle (Headless ↔ Headed)

**Goal**: Verify mode switching works and shows warnings about POST state loss.

**Instructions**:
```
1. Navigate to https://example.com in headless mode
2. Switch to headed mode (show_browser)
3. Verify browser window becomes visible
4. Switch back to headless mode (hide_browser)
5. Verify browser window disappears
```

**Expected Results**:
- `show_browser` action:
  - Chrome restarts
  - Browser window becomes visible
  - Warning message about POST state loss
  - Page reloaded via GET
- `hide_browser` action:
  - Chrome restarts
  - Browser window disappears
  - Warning message about POST state loss
- `browser_mode` shows correct mode after each toggle

**Verification commands**:
```
browser_mode - check mode before toggle
show_browser - make visible
browser_mode - verify mode changed to "headed"
hide_browser - make invisible
browser_mode - verify mode changed to "headless"
```

---

### Test 4: Custom Profile Isolation

**Goal**: Verify different profiles have isolated data.

**Instructions**:
```
1. Kill Chrome if running
2. Set profile to "test-profile"
3. Navigate to https://example.com
4. Verify profile directory is different from default
5. Kill Chrome
6. Set profile back to "superpowers-chrome"
7. Navigate to https://example.com
8. Verify original profile directory is used
```

**Expected Results**:
- `set_profile` action succeeds when Chrome is stopped
- `set_profile` action fails when Chrome is running
- Different profile names create different directories:
  - `superpowers-chrome` → `~/.cache/superpowers/browser-profiles/superpowers-chrome/`
  - `test-profile` → `~/.cache/superpowers/browser-profiles/test-profile/`
- Both directories persist after Chrome restarts

**Verification commands**:
```
set_profile with payload "test-profile"
get_profile - verify changed
navigate to create profile directory
browser_mode - check profileDir path
```

---

### Test 5: Screenshots in Headless Mode

**Goal**: Verify screenshots work perfectly in headless mode.

**Instructions**:
```
1. Ensure Chrome is in headless mode
2. Navigate to https://example.com
3. Take a custom screenshot to /tmp/example-headless.png
4. Read the screenshot file to verify it's a valid image
```

**Expected Results**:
- Screenshot action succeeds in headless mode
- Image file is created at specified path
- Image is readable and shows the page content
- No browser window visible during screenshot

**Verification commands**:
```
browser_mode - confirm headless
screenshot action with payload "/tmp/example-headless.png"
Read tool on /tmp/example-headless.png - should display image
```

---

### Test 6: XDG Cache Directory Structure

**Goal**: Verify session files use proper XDG cache structure.

**Instructions**:
```
1. Navigate to a page (creates session directory)
2. Find and list files in the session directory
3. Verify the directory structure matches XDG conventions
```

**Expected Results**:
- Session directory follows pattern:
  - `~/Library/Caches/superpowers/browser/YYYY-MM-DD/session-{timestamp}/`
- Date-based organization (e.g., `2025-12-04`)
- Session subdirectory with timestamp
- Auto-captured files use numbered prefixes: `001-navigate`, `002-click`, etc.

**Verification commands**:
```
browser_mode - check sessionDir from auto-capture response
Use Glob to list files in session directory
Verify directory structure with Read/Glob
```

---

### Test 7: Form Interaction and Auto-Capture

**Goal**: Verify form interactions auto-capture correctly.

**Instructions**:
```
1. Navigate to https://httpbin.org/forms/post
2. Wait for the form to load
3. Fill in the "custname" field with "Test User"
4. Fill in the "custtel" field with "555-1234"
5. Verify auto-capture files are created for each interaction
```

**Expected Results**:
- Each `type` action creates auto-capture files
- Session directory contains:
  - `001-navigate.*` (initial page load)
  - `002-type.*` (after first field)
  - `003-type.*` (after second field)
- Auto-captured `.md` files show updated form state
- Screenshots show form with filled values

**Verification commands**:
```
navigate to form page
await_element for form fields
type actions for each field
List session directory to verify captures
```

---

### Test 8: browser-user Agent (if applicable)

**Goal**: Verify browser-user agent has correct permissions and pre-loaded skill.

**Instructions**:
```
Delegate a browser task to the browser-user agent:
"Use the browser-user agent to navigate to https://example.com and report what you see"
```

**Expected Results**:
- Agent can invoke browsing skill (pre-loaded)
- Agent has read access to browser cache directory
- Agent can read auto-captured files
- Agent CANNOT write files or execute bash commands
- Agent can analyze page content from cached `.md` files

**Verification**:
- Agent should successfully complete browser navigation
- Agent should be able to read and analyze cached page content
- If agent tries to write files, should be blocked by permission system

---

### Test 9: Multi-Tab Workflow

**Goal**: Verify tab management works across mode/profile changes.

**Instructions**:
```
1. Navigate to https://example.com in tab 0
2. Create a new tab
3. Navigate to https://httpbin.org in tab 1
4. List tabs to see both
5. Switch modes (headless ↔ headed)
6. List tabs again - tabs should be reopened
```

**Expected Results**:
- `new_tab` creates additional tab
- `list_tabs` shows all open tabs with indices
- After mode switch:
  - Tabs are reopened (via GET requests)
  - Tab list includes previously opened URLs
  - Note: May create additional blank tabs

**Verification commands**:
```
list_tabs - see initial tabs
new_tab
navigate to different URL on new tab
list_tabs - verify both tabs
show_browser (mode toggle)
list_tabs - tabs should be restored
```

---

### Test 10: Error Handling and Edge Cases

**Goal**: Verify proper error handling.

**Instructions**:
```
1. Try to set profile while Chrome is running (should fail)
2. Try to navigate to an invalid URL
3. Try to click a non-existent element
4. Try to screenshot to an invalid path
```

**Expected Results**:
- `set_profile` while Chrome running: Error message
- Invalid URL: Chrome error or timeout
- Non-existent element: Error or timeout
- Invalid path: File system error
- All errors return clear error messages

**Verification**:
- Errors should not crash the MCP server
- Error messages should be descriptive
- Chrome should remain functional after errors

---

## Quick Smoke Test (5 minutes)

If you don't have time for the full test suite, run this quick smoke test:

```
1. Navigate to https://example.com
   - Verify headless mode (no window)
   - Verify auto-capture files created

2. Check browser_mode
   - Should show headless=true
   - Should show profile="superpowers-chrome"

3. Show browser (toggle to headed)
   - Browser window should appear

4. Hide browser (toggle back to headless)
   - Browser window should disappear

5. Read one of the auto-captured .md files
   - Should contain "Example Domain" content
```

---

## Verification Checklist

After completing tests, verify:

- [ ] Chrome defaults to headless mode
- [ ] Auto-capture files created in XDG cache directory
- [ ] Default profile is `superpowers-chrome`
- [ ] Profile data persists in `~/.cache/superpowers/browser-profiles/{name}/`
- [ ] Mode toggling works (headless ↔ headed)
- [ ] Screenshots work in headless mode
- [ ] Different profiles have isolated directories
- [ ] Session files use date-based organization
- [ ] browser-user agent has correct permissions
- [ ] Error messages are clear and helpful

---

## Cleanup After Testing

```
1. Kill Chrome if running
2. Optional: Clean up test profile directories
   rm -rf ~/Library/Caches/superpowers/browser-profiles/test-profile
3. Optional: Clean up old session directories
   rm -rf ~/Library/Caches/superpowers/browser/2025-12-*/
```

---

## Known Issues / Expected Behavior

1. **Mode toggling loses POST state** - This is expected and documented
2. **Tabs multiplied after toggle** - Chrome may create extra blank tabs when reopening, this is normal
3. **Profile change requires Chrome restart** - Cannot change profiles on running instance
4. **Console logging incomplete** - Console capture is placeholder, not fully implemented yet

---

## Reporting Issues

If you find issues, report:
1. What test you were running
2. Exact commands/actions used
3. Expected vs actual results
4. Error messages (if any)
5. Browser mode and profile at time of issue
6. Contents of session directory (file list)

---

## Success Criteria

Tests are successful if:
✅ Chrome starts in headless mode by default
✅ Auto-capture files created in correct XDG directories
✅ Profiles persist across Chrome restarts
✅ Mode toggling works without crashes
✅ Screenshots work perfectly in headless mode
✅ Different profiles have isolated data
✅ browser-user agent works with correct permissions
