/**
 * Launch options for the MCP server's Chrome, resolved from the command line
 * and environment. Kept apart from index.ts so tests can import it without
 * booting Chrome or an MCP server (same pattern as payload.ts and
 * response-format.ts).
 */
/**
 * Whether Chrome starts headless, and why (for the startup log).
 *
 * Order: a `--headless` / `--headed` flag, then `CHROME_WS_HEADLESS`, then
 * display auto-detection (headless when no display is available).
 *
 * The environment variable exists for servers whose command line the user
 * cannot change — a plugin-installed server in Claude Code starts with the
 * plugin's fixed arguments — matching CHROME_WS_PORT, CHROME_WS_PROFILE and
 * CHROME_WS_BROWSER. An unrecognized value is reported through `warn` and
 * ignored.
 */
export declare function resolveHeadless(argv: readonly string[], env: Record<string, string | undefined>, hasDisplay: () => boolean, warn?: (message: string) => void): {
    headless: boolean;
    reason: string;
};
//# sourceMappingURL=launch-options.d.ts.map