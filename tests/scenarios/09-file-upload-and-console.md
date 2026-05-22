# Scenario 09 — File upload + console logging

**Goal:** Exercise `file_upload`, `enableConsoleLogging`, `getConsoleMessages`, `clearConsoleMessages`.

## Setup

Create a small file fixture:

```bash
echo "hello upload" > /tmp/upload-test.txt
```

Use a data URL fixture with a file input and a console-noisy script:

```
data:text/html,<title>Upload+console test</title>
<input id="f" type="file">
<div id="info"></div>
<script>
  console.log('initial-load');
  console.warn('a-warning');
  console.error('an-error');
  document.getElementById('f').addEventListener('change', (e) => {
    const f = e.target.files[0];
    document.getElementById('info').textContent = f ? f.name + ':' + f.size : 'no-file';
    console.log('file-changed:' + (f ? f.name : 'none'));
  });
</script>
```

## Steps

### File upload
1. Navigate to the data URL.
2. `file_upload(0, '#f', '/tmp/upload-test.txt')` — set the input's files.
3. Read `#info` text — should show `upload-test.txt:13` (13 bytes for "hello upload\n").
4. Read `#f.files[0].name` via eval — should be `"upload-test.txt"`.

### Console logging
5. `enableConsoleLogging(0)` — turn on capture.
6. Reload the page (navigate to the same URL again, which re-triggers the script).
7. Wait a moment, then `getConsoleMessages(0)` — should return the 3 log entries (`initial-load`, `a-warning`, `an-error`) with appropriate `level` fields.
8. `getConsoleMessages(0, sinceTime)` — filter by timestamp. Should respect the filter.
9. `clearConsoleMessages(0)` — reset.
10. After clear, `getConsoleMessages(0)` should return an empty array.

## Pass criteria

- File upload sets the input and fires the change event
- Console capture catches all log/warn/error entries
- Levels are correctly attributed (`log`, `warn`, `error`)
- sinceTime filter works
- clear resets

## Failure signals

- file_upload throws → DOM.setFileInputFiles dispatch broken in the migrated file-upload.js
- Console messages missing → console-logging.js's pageSession.onEvent subscription not capturing
- Levels wrong → arg-format logic broken in the migration
- sinceTime not applied → filter logic broken

Report each step's outcome.
