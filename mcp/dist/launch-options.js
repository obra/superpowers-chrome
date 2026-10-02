/**
 * Launch options for the MCP server's Chrome, resolved from the command line
 * and environment. Kept apart from index.ts so tests can import it without
 * booting Chrome or an MCP server (same pattern as payload.ts and
 * response-format.ts).
 */
const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);
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
export function resolveHeadless(argv, env, hasDisplay, warn = () => { }) {
    if (argv.includes('--headless'))
        return { headless: true, reason: 'forced via --headless' };
    if (argv.includes('--headed'))
        return { headless: false, reason: 'forced via --headed' };
    const raw = env.CHROME_WS_HEADLESS;
    if (raw !== undefined && raw.trim() !== '') {
        const value = raw.trim().toLowerCase();
        if (TRUE_VALUES.has(value))
            return { headless: true, reason: 'set by CHROME_WS_HEADLESS' };
        if (FALSE_VALUES.has(value))
            return { headless: false, reason: 'set by CHROME_WS_HEADLESS' };
        warn(`CHROME_WS_HEADLESS=${JSON.stringify(raw)} is not one of 1/0, true/false, yes/no, on/off; ignoring it`);
    }
    return hasDisplay()
        ? { headless: false, reason: 'display available' }
        : { headless: true, reason: 'auto-detected no display' };
}
//# sourceMappingURL=launch-options.js.map