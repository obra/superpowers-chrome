# Changelog

All notable changes to the Chrome MCP Server will be documented in this file.

## [1.5.0] - 2025-11-02

### Changed
- **Major UX Improvement**: Enhanced tool description to prevent unnecessary extract calls after navigation
- Tool description now emphasizes auto-captured content (page.md, page.html, screenshot.png) is available immediately after navigation
- Updated workflow examples to show extract only when actually needed (specific elements, changed content)
- Added prominent warnings: "CHECK AUTO-CAPTURED FILES FIRST" and "EXTRACT ONLY WHEN" guidelines
- Revised help documentation to clarify when extract is truly necessary vs. using auto-captured files

### Fixed
- Reduced inefficient pattern where Claude would automatically run extract after every navigation
- Tool description examples no longer suggest extract as a standard follow-up to navigation
- Clarified that auto-captured page.md often contains exactly what extract with markdown format would provide

### Technical Details
- Updated tool description from "navigate→await_element→extract" pattern to "navigate→check_page.md_first"
- Added 🚨 warning emojis in tool description to draw attention to auto-capture behavior
- Modified workflow examples to show extract only with specific selectors or justified use cases
- Enhanced troubleshooting section to reference auto-captured page.html instead of manual extract

### Documentation
- Updated superpowers-chrome:browsing skill with comprehensive auto-capture guidance
- Added "When to Use Extract" section with clear do/don't guidelines
- Revised all workflow examples to avoid unnecessary extract pattern

## [1.3.0] - 2025-10-18

### Added
- XPath selector support - selectors now support both CSS and XPath (auto-detected by / or // prefix)
- Direct library integration - chrome-ws-lib.js for faster operations without subprocess overhead
- Comprehensive error handling with actual Error objects
- Marketplace file for plugin distribution

### Changed
- Refactored from subprocess spawning to direct library calls (10x+ faster)
- Streamlined tool descriptions - removed redundant information, reduced token usage by ~60%
- Simplified parameter descriptions to only non-obvious information
- Tool description now references superpowers-chrome:browsing skill for detailed guidance
- Updated chrome-ws path from skills/using-chrome-directly to skills/browsing

### Fixed
- CDP message ID bug - switched from timestamp to simple counter (Chrome requires small integers)
- Tool registration - switched from registerTool() to tool() for proper schema validation
- Zod schema registration - use raw shape instead of full ZodObject
- Payload schema validation - removed nested anyOf that confused MCP Inspector
- Selector parameter now properly handles both strings and numeric tab indices

### Technical Details
- Changed inputSchema from `UseBrowserSchema as any` to `UseBrowserParams` (raw shape)
- Eliminated nested anyOf in JSON Schema for cleaner validation
- All element operations now use `getElementSelector()` helper for CSS/XPath detection
- Bundled chrome-ws-lib.js into dist/index.js for single-file distribution

## [1.0.0] - Initial Release

### Added
- Single `use_browser` tool with 13 actions
- Auto-starting Chrome on first use
- Stdio transport for MCP protocol
- Basic browser automation: navigate, click, type, extract, screenshot, eval
