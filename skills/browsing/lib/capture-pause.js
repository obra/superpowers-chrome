/**
 * Pause switch for automatic page captures.
 *
 * Every auto-capture action (click/fill/select/eval/set_attr/navigate/
 * hover/drag/scroll/...) drops a DOM snapshot (.html/.md), a screenshot,
 * a console-log placeholder, and — when a native dialog is open — a
 * synthetic dialog artifact into the session dir. None of that is gated
 * on content: capture.js's credential-shape/marker/URL checks only catch
 * a secret with a recognizable SHAPE or an opt-in data-sen-secret MARK.
 * A page that reveals a secret only after a user action (Google Admin's
 * reset-password dialog, a "show password" toggle, a backup-codes modal)
 * in a plain element with no secret-looking id/name/class, on a URL with
 * nothing sensitive in it, slips past every one of those checks — and the
 * very next auto-capture writes it to disk.
 *
 * pause_capture/resume_capture (see lib/capture.js's pauseCapture/
 * resumeCapture, wired to session state) is the tool-level answer: an
 * agent that is about to reveal a secret this way pauses capture first,
 * performs the reveal, reads/relays the value through the credential
 * broker, then resumes once the secret is off-screen. State lives on the
 * session (see session-state.js), so it survives across actions until
 * resume_capture is called — an agent that forgets to resume simply gets
 * no more captures for the rest of the session, never a silent leak.
 *
 * Deliberately NOT auto-resumed on navigation to a different origin: that
 * would need to compare the ORIGIN at pause time against the ORIGIN after
 * every navigation (cross-tab, redirects, client-side routing all count),
 * and a same-origin page can still carry the secret forward (a SPA's
 * post-reveal route change, a same-origin redirect back to the dashboard
 * with the value still in a toast). An agent-driven resume_capture is the
 * one signal that actually means "the secret is gone now" — the pause
 * is already fail-safe (captures just stay off) if that call is forgotten.
 */

const CAPTURE_PAUSED_NOTICE =
  '⏸️ Capture is paused for this session: automatic DOM/markdown/screenshot/console/dialog captures are OFF. ' +
  'Call resume_capture as soon as the secret is off-screen.';

// Unlike CREDENTIAL_SUPPRESSED_NOTICE (credential-guard.js), there is no
// "capture happened but was redacted" middle ground here: pause means NO
// auto-capture artifact is produced at all while it's on, by design (see
// module comment above).
function capturePausedScreenshotRefusal() {
  return (
    'screenshot refused: capture is paused for this session. ' +
    'An explicit screenshot could write the same secret pause_capture exists to keep off disk. ' +
    'Call resume_capture once the secret is off-screen, then screenshot.'
  );
}

module.exports = {
  CAPTURE_PAUSED_NOTICE,
  capturePausedScreenshotRefusal,
};
