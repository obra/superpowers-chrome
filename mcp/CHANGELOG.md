# Changelog

All notable changes to the Chrome MCP Server will be documented in this file.

## [1.2.0] - 2025-10-18

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
