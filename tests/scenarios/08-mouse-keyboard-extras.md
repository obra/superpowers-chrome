# Scenario 08 — Mouse and keyboard extras

**Goal:** Exercise the mouse and keyboard actions that scenario 02 didn't reach.

## Setup

Navigate to a fixture with interactive elements:

```
data:text/html,<style>body{font:14px sans-serif}#box{width:100px;height:100px;background:lightblue}#log{height:100px;overflow:auto;border:1px solid #ccc}</style>
<title>Mouse/keyboard test</title>
<input id="i" placeholder="type here">
<div id="box" tabindex="0">box</div>
<button id="b">btn</button>
<div id="log"></div>
<script>
  const log = document.getElementById('log');
  function add(s) { log.innerHTML += s + '<br>'; log.scrollTop = log.scrollHeight; }
  const box = document.getElementById('box');
  box.addEventListener('mouseenter', () => add('hover-enter'));
  box.addEventListener('mouseleave', () => add('hover-leave'));
  box.addEventListener('dblclick', () => add('dblclick'));
  box.addEventListener('contextmenu', e => { e.preventDefault(); add('rightclick'); });
  box.addEventListener('mousedown', () => add('mousedown'));
  box.addEventListener('mouseup', () => add('mouseup'));
  document.addEventListener('keydown', e => add('keydown:' + e.key + (e.shiftKey?'+shift':'') + (e.ctrlKey?'+ctrl':'')));
  window.addEventListener('scroll', () => add('scroll:' + window.scrollY));
</script>
<div style="height:2000px"></div>
```

## Steps

For each step issue the listed `use_browser` call, then read `#log`
via `{"action": "extract", "selector": "#log", "payload": "text"}`
and assert the per-step substring is present. Note: `type` IS the
human-typing action (char-by-char with delays); there is no separate
`humanType` action in this version of the schema.

1. **hover**: `{"action": "hover", "selector": "#box"}`. After: log
   contains `hover-enter`.
2. **double_click**: `{"action": "double_click", "selector": "#box"}`.
   After: log contains `dblclick`.
3. **right_click**: `{"action": "right_click", "selector": "#box"}`.
   After: log contains `rightclick`.
4. **mouse_move**: `{"action": "mouse_move", "payload": {"x": 200, "y": 200}}`.
   PASS if it returns without error. The fixture has no listener for
   `mousemove` on the body, so no log entry is required.
5. **scroll**: `{"action": "scroll", "payload": {"deltaY": 500}}`.
   After: log contains `scroll:` (the exact number may differ
   slightly because of fractional deltas; the literal prefix is what
   matters).
6. **type (humanized)**:
   `{"action": "type", "selector": "#i", "payload": "abc"}` then
   `{"action": "eval", "payload": "document.getElementById('i').value"}`.
   PASS if eval result is exactly `abc`.
7. **keyboard_press with shift**:
   `{"action": "keyboard_press", "payload": {"key": "a", "modifiers": {"shift": true}}}`.
   After: log contains either `keydown:A+shift` or `keydown:a+shift`
   (Chrome may report either key case; both are acceptable).
8. **drag_drop to coords**:
   `{"action": "drag_drop", "selector": "#box", "payload": {"x": 300, "y": 300}}`.
   PASS if it returns without error. No log entry required.

## Pass criteria

- Each step satisfies its per-step substring / value criterion above
- Step 4 and 8 PASS on returning without error (no log entry required)

## Failure signals

- Action throws → migration broke mouse.js or keyboard-input.js
- Event handler doesn't fire → action did something different than expected
- Step 6 input value != `abc` → per-char dispatch in `type` is broken

Report the matrix of 8 actions × pass / fail.
