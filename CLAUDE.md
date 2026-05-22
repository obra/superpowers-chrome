# Superpowers Chrome - Developer Documentation

This document contains comprehensive information for maintaining and releasing the superpowers-chrome MCP plugin.

## Project Structure

```
superpowers-chrome/
├── package.json              # Root package (version source of truth)
├── mcp/                      # MCP server implementation
│   ├── package.json          # MCP-specific package (must match root version)
│   ├── src/index.ts          # TypeScript source
│   └── dist/index.js         # Bundled output (committed to git)
├── skills/                   # Claude Code skills
│   └── browsing/
│       ├── chrome-ws-lib.js  # Core Chrome CDP library (bundled with MCP)
│       ├── chrome-ws.md      # Skill definition
│       └── package.json      # Skill metadata (independent version)
├── CHANGELOG.md              # Release notes
└── README.md                 # User documentation
```

## Version Management

### Version Numbers
- **Root package.json**: Source of truth for release version
- **mcp/package.json**: Must match root version exactly
- **skills/browsing/package.json**: Independent versioning (skill metadata only)

### Version Bumping Rules
Always bump versions together:
1. Update root `package.json` version
2. Update `mcp/package.json` to match
3. Update `CHANGELOG.md` with changes
4. Commit with message: `Bump version to X.Y.Z`

## Build System

### Build Architecture
The MCP server uses a TypeScript → JavaScript → Bundled ESM pipeline:

1. **Source**: `mcp/src/index.ts` (TypeScript with imports)
2. **Compile**: `tsc` → intermediate JavaScript
3. **Bundle**: `esbuild` → `mcp/dist/index.js` (single file, all deps bundled)
4. **External deps**: `chrome-ws-lib.js` bundled via relative path

### Build Commands

```bash
# Full build (from project root)
npm run build

# Equivalent to:
cd mcp && npm install && npm run build

# Which runs:
tsc && esbuild src/index.ts --bundle --platform=node --format=esm --outfile=dist/index.js --external:fsevents

# Clean build
cd mcp && npm run clean && npm run build
```

### Build Outputs
- `mcp/dist/index.js` - Bundled MCP server (~528KB)
- Committed to git (required for npm/npx distribution)
- Contains all dependencies except `fsevents` (macOS-specific)

### Build Dependencies
- `chrome-ws-lib.js` bundled from `../../skills/browsing/chrome-ws-lib.js`
- Must exist at build time
- Relative path resolution in bundled output

## Release Engineering Process

### Pre-Release Checklist

1. **Code Quality**
   - [ ] All tests pass (if applicable)
   - [ ] No uncommitted changes in working directory
   - [ ] Run full build: `npm run build`
   - [ ] Test bundled MCP: `node mcp/dist/index.js` (should start without errors)

2. **Version Management**
   - [ ] Decide version number (semver: major.minor.patch)
   - [ ] Update `package.json` version
   - [ ] Update `mcp/package.json` version (must match)
   - [ ] Update `CHANGELOG.md` with release notes

3. **Build Verification**
   - [ ] Clean build: `cd mcp && npm run clean && npm run build`
   - [ ] Verify `mcp/dist/index.js` updated timestamp
   - [ ] Test: `timeout 2 node mcp/dist/index.js || true` (should show "Chrome MCP server running")
   - [ ] Check bundle size reasonable (~528KB)

### Release Steps

```bash
# 1. Version bump and changelog
# Edit package.json, mcp/package.json, CHANGELOG.md

# 2. Rebuild with new version
npm run build

# 3. Commit version bump
git add package.json mcp/package.json mcp/dist/index.js CHANGELOG.md
git commit -m "Bump version to 1.5.1"

# 4. Tag release
git tag -a v1.5.1 -m "Release v1.5.1 - <Brief description>"

# 5. Push to GitHub
git push origin main
git push origin v1.5.1

# 6. Update marketplace (if applicable)
# See "Marketplace Distribution" section below
```

### Marketplace Distribution

The superpowers-chrome plugin is distributed via the superpowers-marketplace repository.

**Marketplace Update Process:**

```bash
# 1. Navigate to marketplace repo
cd ../superpowers-marketplace/

# 2. Update plugin files
# The marketplace expects these files:
# - plugins/superpowers-chrome/mcp/dist/index.js (bundled MCP)
# - plugins/superpowers-chrome/skills/ (skill definitions)
# - plugins/superpowers-chrome/package.json (metadata)

# 3. Copy updated files
# (Automated script or manual copy - document actual process here)

# 4. Commit to marketplace
git add plugins/superpowers-chrome/
git commit -m "Update superpowers-chrome to v1.5.1"

# 5. Push to marketplace
git push origin main
```

**Marketplace Files Structure:**
```
superpowers-marketplace/
└── plugins/
    └── superpowers-chrome/
        ├── package.json          # Plugin metadata
        ├── mcp/
        │   └── dist/
        │       └── index.js      # Bundled MCP server
        └── skills/
            └── browsing/
                ├── chrome-ws-lib.js
                └── chrome-ws.md
```

## Installation Methods

### NPX GitHub (Recommended for testing)
```bash
npx github:obra/superpowers-chrome
```

### NPM (When published)
```bash
npm install -g superpowers-chrome-mcp
```

### Claude Code Plugin (Via Marketplace)
Plugin auto-updates from marketplace when user has it installed.

## Agent-driven test scenarios

The unit suite (`npm test`) verifies code correctness. The scenarios under `tests/scenarios/` verify the **agent experience** — that a Claude Code session with the plugin loaded can use it to do realistic browser work end-to-end. These caught at least one real bug (the autoAttach session cache disconnect, fix in commit `20490af`) that the unit tests missed because they manipulate state directly rather than going through the MCP layer.

### Running scenarios via Claude Session Driver

The `claude-session-driver` plugin (`csd`) launches a separate Claude Code worker session, loads the plugin from a local path via `--plugin-dir`, and sends it prompts. You observe what the worker does via its event stream and final responses.

```bash
# 1. Set the skill path once (or use the absolute path inline)
SKILL=/Users/jesse/.claude/plugins/cache/superpowers-marketplace/claude-session-driver/3.0.0/skills/driving-claude-code-sessions/scripts

# 2. Launch a worker rooted in the worktree, with this plugin loaded from its current directory
$SKILL/csd launch bridge-test /path/to/superpowers-chrome -- --plugin-dir /path/to/superpowers-chrome

# 3. Send the worker a scenario to execute. The bare shim path is /tmp/claude-workers/bin/<tmux-name>.
/tmp/claude-workers/bin/bridge-test send "Read tests/scenarios/01-smoke.md and execute it. Report each step's outcome explicitly."

# 4. Wait for the worker to finish the turn (the event file gets a "stop" line)
EVENTS=$(jq -r '.events' /tmp/claude-workers/<session-id>.meta.json 2>/dev/null || ls /tmp/claude-workers/*.events.jsonl)
while ! tail -1 "$EVENTS" | grep -q '"event":"stop"'; do sleep 15; done

# 5. Read the worker's final assistant text from its session log
SESSION_DIR=/Users/jesse/.claude/projects/$(echo "$PWD" | sed 's|/|-|g')
tail -300 "$SESSION_DIR"/*.jsonl | python3 -c "
import json, sys
texts=[]
for line in sys.stdin:
    if not line.strip(): continue
    try:
        msg = json.loads(line)
        if msg.get('type') == 'assistant':
            for block in msg.get('message',{}).get('content', []):
                if isinstance(block, dict) and block.get('type') == 'text':
                    t = block.get('text', '').strip()
                    if t: texts.append(t)
    except: pass
print(texts[-1] if texts else '(no text)')
"

# 6. Iterate: rebuild the bundle, restart the worker to pick up changes
npm run build
/tmp/claude-workers/bin/bridge-test stop
$SKILL/csd launch bridge-test ... # relaunch
```

**After fixing code, you must `npm run build` AND restart the worker** — the worker's MCP server process holds the bundled `mcp/dist/index.js` in memory; rebuilds don't hot-reload.

The scenarios are deliberately written so they can be run in any order. Each is self-contained (sets up fixtures, exercises behavior, reports outcome). When adding new scenarios, follow the same shape so future Claude can pick up the corpus without re-deriving the pattern.

### Scenarios as regression corpus

Each scenario file documents what to test, what the pass criteria are, and what failure signals look like. They're checked into `tests/scenarios/` so they grow over time:

- Add a scenario whenever a real-use bug exposes a gap our unit tests miss
- Add a scenario whenever a new feature has agent-visible behavior worth pinning
- Name them `NN-short-name.md` (zero-padded to keep them sorted)

The scenarios are NOT executed by `npm test` — they require a Claude Code worker and real Chrome. Run them manually before a release, or after any change to the bridge / dialog system / MCP layer.

## Common Issues

### Build Issues

**Problem**: `initializeSession is not a function`
- **Cause**: Outdated `mcp/dist/index.js` bundle
- **Fix**: Run `npm run build` to rebuild

**Problem**: Bundle size unexpectedly large/small
- **Cause**: Dependencies changed or build cache issues
- **Fix**: `cd mcp && npm run clean && npm run build`

**Problem**: `chrome-ws-lib.js` not found at runtime
- **Cause**: Relative path mismatch in bundle
- **Fix**: Verify `skills/browsing/chrome-ws-lib.js` exists before building

### Version Mismatch Issues

**Problem**: Root and MCP versions out of sync
- **Symptom**: Confusion about what version is running
- **Fix**: Always update both `package.json` and `mcp/package.json` together

**Problem**: Marketplace has wrong version
- **Fix**: Re-run marketplace update process with correct version

### Cache Issues

**Problem**: Claude Code using old MCP version
- **Location**: `~/.claude/plugins/cache/superpowers-chrome/`
- **Fix**: Plugin should auto-update, but can manually delete cache to force refresh

## Development Workflow

### Making Changes

1. **Edit source**: Modify `mcp/src/index.ts` or `skills/browsing/chrome-ws-lib.js`
2. **Build**: `npm run build`
3. **Test locally**: `node mcp/dist/index.js`
4. **Commit**: Include both source and `mcp/dist/index.js` in commit

### Testing Changes

```bash
# Quick test - MCP server starts
timeout 2 node mcp/dist/index.js || true

# Manual MCP testing
# Add to Claude Code's MCP config temporarily and test via Claude

# Integration testing
# Use the browsing skill in Claude Code
```

### Debugging

**Enable verbose logging:**
```javascript
// In mcp/src/index.ts or chrome-ws-lib.js
console.error("Debug:", someVariable);
```

**Check MCP stdio communication:**
- MCP communicates via stdin/stdout
- Logging must use `console.error()` (stderr) not `console.log()` (stdout)

## File Inclusion (npm package)

Files included in npm package (from root `package.json`):
```json
"files": [
  "mcp/dist/",
  "skills/browsing/chrome-ws-lib.js",
  "skills/browsing/host-override.js",
  "skills/browsing/package.json",
  "README.md",
  "CHANGELOG.md"
]
```

**Important**: Only `dist/` is included, not `src/`. The bundle must be committed.

## Git Workflow

### Branching
- **main**: Stable releases only
- **feature branches**: For development work
- **No develop branch**: Keep it simple

### Commit Messages
- `Bump version to X.Y.Z` - Version bumps
- `Fix: <description>` - Bug fixes
- `Add: <description>` - New features
- `Update: <description>` - Changes/improvements

### What to Commit
- ✅ Source files (`mcp/src/**`)
- ✅ Built bundle (`mcp/dist/index.js`)
- ✅ Library code (`skills/browsing/chrome-ws-lib.js`)
- ✅ Package files (`package.json`, `mcp/package.json`)
- ✅ Documentation (`README.md`, `CHANGELOG.md`, `CLAUDE.md`)
- ❌ `node_modules/`
- ❌ Build artifacts except `mcp/dist/index.js`

## Release Checklist Template

Use this for each release:

```markdown
## Release X.Y.Z Checklist

### Pre-Release
- [ ] All changes committed
- [ ] Tests pass (if applicable)
- [ ] Version bumped in package.json
- [ ] Version bumped in mcp/package.json
- [ ] CHANGELOG.md updated
- [ ] Clean build: `cd mcp && npm run clean && npm run build`
- [ ] Build test: `timeout 2 node mcp/dist/index.js`

### Release
- [ ] Commit: `git add -A && git commit -m "Bump version to X.Y.Z"`
- [ ] Tag: `git tag -a vX.Y.Z -m "Release vX.Y.Z - <description>"`
- [ ] Push: `git push origin main && git push origin vX.Y.Z`

### Post-Release
- [ ] Update marketplace (if applicable)
- [ ] Verify npx installation works
- [ ] Test in Claude Code
- [ ] Monitor for issues
```

## Architecture Notes

### Why Bundle dist/index.js?

1. **NPX compatibility**: GitHub installs need working code immediately
2. **Dependency management**: All deps bundled, no install required
3. **Single file distribution**: Simpler for users

### Why Commit dist/?

1. **NPX GitHub installs**: No build step for end users
2. **Version control**: Exact output is tracked
3. **Reproducibility**: Know exactly what was released

### Chrome Library Integration

The `chrome-ws-lib.js` is:
- Pure Node.js (no build required)
- CommonJS format (`module.exports`)
- Bundled into MCP via `require()` at relative path
- Shared between skill and MCP

## Support

- **GitHub Issues**: https://github.com/obra/superpowers-chrome/issues
- **Discussions**: Use GitHub Discussions for questions
- **Marketplace**: Report plugin-specific issues there
