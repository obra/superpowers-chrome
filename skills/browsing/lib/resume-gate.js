'use strict';

// PRI-3710: Target.setAutoAttach's `waitForDebuggerOnStart` pause is
// target-scoped, not session-scoped — confirmed against real Chrome.
// Whichever CDP client calls `Runtime.runIfWaitingForDebugger` FIRST
// unblocks a newly-attached target globally, for every client attached to
// it, not just its own session. If a second, independent client is also
// attached to the same browser-wide endpoint (e.g. sen-core's
// credential-injection arm, which marks newly-opened popups with the
// `data-sen-secret` live-DOM marker — see lib/secret-marker.js — before
// any page script runs), that client's resume races this module's: this
// module's resume alone can let page script start running, and a read
// reach the page, before the other client's mark exists.
//
// An earlier version of this module polled the target's own
// `data-sen-secret` marker for up to 300ms before resuming regardless.
// That's a heuristic, not a fix: measured mark latencies for the other
// client ranged 166-586ms, so a slow mark still lost the race, and a
// plain popup — no such client attached at all, the common case — paid
// up to 300ms of pure wait for nothing.
//
// The actual fix is structural, not timing-based: there must be exactly
// ONE resumer for an auto-attached target. hasExternalResumer() is the
// opt-out that makes this module get out of that resumer's way entirely
// instead of racing or waiting on it. When a host embedding this library
// sets SUPERPOWERS_CHROME_EXTERNAL_RESUMER=1 — meaning it runs its own
// browser-wide CDP client that takes responsibility for resuming every
// auto-attached target itself, for as long as that env var is set —
// browser-bridge.js must never call Runtime.runIfWaitingForDebugger on
// such a target; the external resumer is the only one. When the env var
// is unset — no such host attached, the common case for a plain user of
// this plugin with no other CDP client in the picture — hasExternalResumer()
// always returns false, and browser-bridge.js's resume behaves exactly as
// it did before PRI-3710: unconditional, immediate, no wait.
function hasExternalResumer() {
  return process.env.SUPERPOWERS_CHROME_EXTERNAL_RESUMER === '1';
}

module.exports = { hasExternalResumer };
