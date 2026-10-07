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
/**
 * Format a DialogRefusedError into a human-readable tool response string.
 * Uses duck typing (error.refused && error.artifacts) rather than instanceof
 * because class identity can be unreliable across CommonJS require boundaries.
 */
export declare function formatDialogRefusal(error: any): string;
/**
 * Where an auto-capture's files went — or, when the page showed
 * credential-shaped content, why there are none.
 */
export declare function formatCaptureFiles(actionResult: any): string[];
/**
 * Format action response with capture information
 */
export declare function formatActionResponse(actionResult: any, actionDescription: string): string;
/**
 * Describe an eval call. On the midFlight wrapper (the eval opened a
 * dialog) the evaluated value lives on the wrapped actionResult, not the
 * top level.
 */
export declare function formatEvalDescription(expression: string, evalResult: any): string;
/**
 * Format capture response with DOM diff information.
 * When capture is null (action opened a dialog), returns dialog info instead.
 */
export declare function formatCaptureResponse(action: string, details: string, captureOrNull: {
    sessionDir: string;
    files: Record<string, string>;
    diffSummary: string;
    domSummary: string;
    pageSize: {
        width: number;
        height: number;
    };
    credentialSuppressed?: boolean;
    suppressedReason?: string;
} | null, dialog?: any, artifacts?: any, credentialSuppressed?: boolean, suppressedReason?: string): string;
/**
 * Last line of defense: every piece of text use_browser returns (results,
 * errors, dialog refusals) has credential-shaped substrings replaced, so
 * a token that reached the output by any path — extract, eval, a URL, an
 * error message — never lands in the agent's transcript. Off when
 * SUPERPOWERS_CHROME_ALLOW_CREDENTIAL_CAPTURE=1.
 */
export declare function redactUnlessAllowed(text: string): string;
//# sourceMappingURL=response-format.d.ts.map