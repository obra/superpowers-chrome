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

1. **hover**: hover `#box`. Read `#log` — should contain `hover-enter`.
2. **doubleClick**: double-click `#box`. Log should contain `dblclick`.
3. **rightClick**: right-click `#box`. Log should contain `rightclick`.
4. **mouseMove**: move mouse to coords (200, 200). May or may not affect anything; mostly just verifying no crash.
5. **scroll**: scroll the page by 500px. Log should contain `scroll:500` (or similar).
6. **humanType**: humanType into `#i` with `"abc"`. Verify via eval that input value is `"abc"`. (Compare to `fill` which is instant — `humanType` types char by char with delays.)
7. **keyboardPress with modifiers**: send `Shift+a` then read log → should contain `keydown:A+shift` or `keydown:a+shift` (whatever the page registers).
8. **drag**: try to drag from `#box` to coords (300, 300). May or may not produce visible effects; verify no crash.

## Pass criteria

- Each action returns without error
- Each event handler fires (log records the expected events)
- humanType produces the correct final value

## Failure signals

- Action throws → migration broke mouse.js or keyboard-input.js
- Event handler doesn't fire → action did something different than expected
- humanType doesn't type all chars → timing or per-char dispatch broken

Report the matrix of 8 actions × pass / fail.
