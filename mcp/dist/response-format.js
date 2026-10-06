/**
 * Formatting helpers for use_browser tool responses: turning an action
 * result (capture info, an open dialog, or an error) into the string the
 * agent sees.
 *
 * Pure string formatting plus the credential-guard module (itself
 * side-effect-free) — no chrome-ws, no MCP transport, no `main()`. Unlike
 * mcp/src/index.ts (which auto-starts Chrome and connects an MCP stdio
 * transport as an unconditional side effect of being imported), this module
 * can be imported directly by tests. Mirrors mcp/src/payload.ts, which was
 * split out for the same reason.
 */
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);
const credentialGuard = require(join(__dirname, "../../skills/browsing/lib/credential-guard.js"));
const sensitiveUrl = require(join(__dirname, "../../skills/browsing/lib/sensitive-url.js"));
// capture.js tags a suppressed capture with `suppressedReason` so this
// layer can show an accurate notice: 'sensitive-url' (the page's URL
// alone, e.g. a 2FA setup page, regardless of content) gets a different
// explanation than the default credential-shape/marker notice. Absent or
// any other value falls back to the original credential-shape wording,
// so an older capture.js result (no suppressedReason at all) renders
// exactly as it always did.
function suppressedNoticeFor(reason) {
    return reason === "sensitive-url" ? sensitiveUrl.URL_SUPPRESSED_NOTICE : credentialGuard.CREDENTIAL_SUPPRESSED_NOTICE;
}
/**
 * Format a DialogRefusedError into a human-readable tool response string.
 * Uses duck typing (error.refused && error.artifacts) rather than instanceof
 * because class identity can be unreliable across CommonJS require boundaries.
 */
export function formatDialogRefusal(error) {
    const lines = [error.message || 'Page is behind a dialog.'];
    if (error.artifacts?.markdown) {
        lines.push('');
        lines.push(error.artifacts.markdown);
    }
    return lines.join('\n');
}
/**
 * Where an auto-capture's files went — or, when the page showed
 * credential-shaped content, why there are none.
 */
export function formatCaptureFiles(actionResult) {
    if (actionResult.credentialSuppressed) {
        return [suppressedNoticeFor(actionResult.suppressedReason)];
    }
    const prefix = actionResult.capturePrefix || '???';
    return [
        `Session dir: ${actionResult.sessionDir}`,
        `Files: ${prefix}.html, ${prefix}.md, ${prefix}.png, ${prefix}-console.txt`
    ];
}
/**
 * Format action response with capture information
 */
export function formatActionResponse(actionResult, actionDescription) {
    if (actionResult.midFlight) {
        // The action itself opened a dialog (withDialogAwarenessForSession's
        // AFTER-dialog branch in dialogs.js): `actionResult` here is the wrapper
        // shape `{ midFlight, actionResult, dialog, artifacts }`, not the click/
        // select/eval result directly. Render the dialog the same way
        // formatCaptureResponse's null-capture branch does, instead of reading
        // url/pageSize/capturePrefix off a top level where they don't exist.
        const dialogDesc = actionResult.artifacts?.markdown
            || (actionResult.dialog ? `Dialog opened: ${actionResult.dialog.kind}` : 'Dialog opened');
        const suppressedNotice = actionResult.actionResult?.credentialSuppressed
            ? `\n\n${suppressedNoticeFor(actionResult.actionResult?.suppressedReason)}`
            : '';
        return `${actionDescription}\n\nDialog is now open — page is waiting for user input.${suppressedNotice}\n\n${dialogDesc}`;
    }
    const response = [
        `${actionDescription}`,
        `Current URL: ${actionResult.url || 'unknown'}`,
        `Size: ${actionResult.pageSize?.width}×${actionResult.pageSize?.height}`,
        ...formatCaptureFiles(actionResult)
    ];
    // Add console messages if any
    if (actionResult.consoleLog && actionResult.consoleLog.length > 0) {
        response.push(`Console: ${actionResult.consoleLog.length} messages`);
        actionResult.consoleLog.slice(0, 3).forEach((msg) => {
            response.push(`  ${msg.level}: ${msg.text}`);
        });
        if (actionResult.consoleLog.length > 3) {
            response.push(`  ... +${actionResult.consoleLog.length - 3} more`);
        }
    }
    // Compact DOM summary
    if (actionResult.domSummary) {
        const lines = actionResult.domSummary.split('\n').slice(0, 8);
        response.push('DOM:', ...lines.map((l) => `  ${l}`));
        if (actionResult.domSummary.split('\n').length > 8) {
            response.push('  ...');
        }
    }
    return response.join('\n');
}
/**
 * Describe an eval call. On the midFlight wrapper (the eval opened a
 * dialog) the evaluated value lives on the wrapped actionResult, not the
 * top level.
 */
export function formatEvalDescription(expression, evalResult) {
    const value = evalResult.midFlight ? evalResult.actionResult?.result : evalResult.result;
    return `Evaluated: ${expression}\nResult: ${value}`;
}
/**
 * Format capture response with DOM diff information.
 * When capture is null (action opened a dialog), returns dialog info instead.
 */
export function formatCaptureResponse(action, details, captureOrNull, dialog, artifacts, credentialSuppressed, suppressedReason) {
    if (!captureOrNull) {
        // Action succeeded but opened a dialog — show dialog info. When the
        // action's dialog was suppressed (its message was credential-shaped),
        // capture.js still hands back the (unredacted-at-this-layer) `artifacts`
        // and `dialog` — only the disk write was skipped there — so show the
        // redacted response, the ⚠️ notice, and the dialog::accept/dismiss
        // instructions together rather than dropping them. The final
        // redactUnlessAllowed() pass on the whole tool response blanks any
        // credential-shaped substring still in `dialogDesc` before it reaches
        // the agent.
        const dialogDesc = artifacts?.markdown || (dialog ? `Dialog opened: ${dialog.kind}` : 'Dialog opened');
        const suppressedNotice = credentialSuppressed ? `\n\n${suppressedNoticeFor(suppressedReason)}` : '';
        return `${action}: ${details}\n\nDialog is now open — page is waiting for user input.${suppressedNotice}\n\n${dialogDesc}`;
    }
    const capture = captureOrNull;
    if (capture.credentialSuppressed) {
        return `${action}: ${details}

${suppressedNoticeFor(capture.suppressedReason)}

📊 Page: ${capture.pageSize.width}×${capture.pageSize.height}
${capture.domSummary}`;
    }
    const fileList = Object.entries(capture.files)
        .map(([key, path]) => `  ${key}: ${path}`)
        .join('\n');
    return `${action}: ${details}

📁 Capture saved to: ${capture.sessionDir}
${fileList}

📊 Page: ${capture.pageSize.width}×${capture.pageSize.height}
${capture.domSummary}

📝 DOM Changes:
${capture.diffSummary}`;
}
/**
 * Last line of defense: every piece of text use_browser returns (results,
 * errors, dialog refusals) has credential-shaped substrings replaced, so
 * a token that reached the output by any path — extract, eval, a URL, an
 * error message — never lands in the agent's transcript. Off when
 * SUPERPOWERS_CHROME_ALLOW_CREDENTIAL_CAPTURE=1.
 */
export function redactUnlessAllowed(text) {
    return credentialGuard.credentialCaptureAllowed() ? text : credentialGuard.redactCredentialShaped(text);
}
//# sourceMappingURL=response-format.js.map