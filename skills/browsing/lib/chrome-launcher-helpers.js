/**
 * Pure helpers used by the Chrome launcher: HTTP probing, profile path
 * resolution, meta.json read/write, port allocation, and Chrome flag list
 * construction. None of these touch session state — every input is passed
 * explicitly. Kept together because they share no dependency on the rest
 * of chrome-ws-lib.
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

// HTTP request to Chrome's DevTools endpoint at an explicit host:port.
// Used for probing arbitrary ports before settling on activePort.
async function chromeHttpAt(host, port, urlPath, method = 'GET') {
  return new Promise((resolve, reject) => {
    const options = { hostname: host, port, path: urlPath, method };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (!data) { resolve({}); return; }
        try { resolve(JSON.parse(data)); }
        catch (_e) { resolve({ message: data }); }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

function getXdgCacheHome() {
  if (process.env.XDG_CACHE_HOME) {
    return process.env.XDG_CACHE_HOME;
  }

  const platform = os.platform();
  const homeDir = os.homedir();

  if (platform === 'darwin') {
    return path.join(homeDir, 'Library', 'Caches');
  } else if (platform === 'win32') {
    return process.env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local');
  } else {
    return path.join(homeDir, '.cache');
  }
}

function getChromeProfileDir(profileName = 'superpowers-chrome') {
  return path.join(getXdgCacheHome(), 'superpowers', 'browser-profiles', profileName);
}

// --- Per-profile meta.json ---
//
// Each profile gets a sibling meta.json file next to its data directory:
//   ~/.cache/superpowers/browser-profiles/superpowers-chrome/       ← profile data
//   ~/.cache/superpowers/browser-profiles/superpowers-chrome.meta.json ← port/pid tracking
//
// Enables: reconnection across sessions, parallel Chrome instances per
// profile, and collision detection.

function getProfileMetaPath(profileName = 'superpowers-chrome') {
  return path.join(getXdgCacheHome(), 'superpowers', 'browser-profiles', `${profileName}.meta.json`);
}

function readProfileMeta(profileName = 'superpowers-chrome') {
  try {
    const data = fs.readFileSync(getProfileMetaPath(profileName), 'utf8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function writeProfileMeta(profileName, data) {
  const metaPath = getProfileMetaPath(profileName);
  fs.mkdirSync(path.dirname(metaPath), { recursive: true });
  fs.writeFileSync(metaPath, JSON.stringify(data, null, 2) + '\n');
}

function clearProfileMeta(profileName) {
  try {
    fs.unlinkSync(getProfileMetaPath(profileName));
  } catch {
    // Already absent — nothing to do
  }
}

// Check if a port has a live Chrome DevTools instance, optionally verify PID.
async function isPortAlive(host, port, expectedPid = null) {
  try {
    const data = await chromeHttpAt(host, port, '/json/version');
    if (!data || !data.Browser) return false;
    if (expectedPid) {
      try { process.kill(expectedPid, 0); } // signal 0 = existence check
      catch { return false; }
    }
    return true;
  } catch {
    return false;
  }
}

// Probe whether a port is free (no listener) using a temporary TCP server.
// "Free" means free on BOTH IPv4 and IPv6 — Chrome may bind ::1 only on
// some macOS configurations, and a port bound on ::1 still appears free
// from a 127.0.0.1 probe. Without checking both, we'd start a second
// Chrome that races the first for the same port number on different
// stacks, with non-deterministic answers to /json HTTP requests.
function isPortFreeOn(host, port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    // Resolve with the OS error code so the caller can tell "port in use"
    // (EADDRINUSE) apart from "this loopback/address family isn't available
    // here at all" (EADDRNOTAVAIL / EAFNOSUPPORT) — very different signals.
    server.once('error', (err) => resolve({ free: false, code: err.code }));
    server.once('listening', () => { server.close(() => resolve({ free: true })); });
    server.listen(port, host);
  });
}

// Pure decision over the IPv4 and IPv6 loopback probe results. A port is free
// only if IPv4 loopback is free. The IPv6 probe is a race-guard for hosts where
// Chrome may bind ::1 only (some macOS configs) — but an UNAVAILABLE IPv6
// loopback (e.g. a container with net.ipv6.conf.lo.disable_ipv6=1, where every
// ::1 bind returns EADDRNOTAVAIL) is NOT a port conflict and must not veto the
// port. Only a genuine in-use signal on ::1 vetoes. Exported for testing.
function portFreeFromProbes(v4, v6) {
  if (!v4.free) return false;
  if (v6.free) return true;
  if (v6.code === 'EADDRNOTAVAIL' || v6.code === 'EAFNOSUPPORT') return true;
  return false;
}

async function isPortFree(port) {
  const v4 = await isPortFreeOn('127.0.0.1', port);
  if (!v4.free) return false;
  const v6 = await isPortFreeOn('::1', port);
  return portFreeFromProbes(v4, v6);
}

// Port range tried sequentially, starting at 9222 for backward compat.
const PORT_RANGE_START = 9222;
const PORT_RANGE_END = 12111;

// Find first available port in range. Defaults span the full PORT_RANGE.
async function findAvailablePort(start = PORT_RANGE_START, end = PORT_RANGE_END) {
  for (let port = start; port <= end; port++) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No available port in range ${start}-${end}`);
}

// Find the PID of the process holding `port`, or null if none.
// Uses platform-native tools — lsof on macOS/Linux, netstat on Windows.
// Returns null on any failure (parsing, missing tool, no listener).
function findPidOnPort(port) {
  const { execSync } = require('child_process');
  try {
    if (process.platform === 'darwin' || process.platform === 'linux') {
      const out = execSync(`lsof -ti:${port} -sTCP:LISTEN`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim();
      if (!out) return null;
      const first = out.split('\n')[0];
      const pid = parseInt(first, 10);
      return Number.isFinite(pid) ? pid : null;
    }
    if (process.platform === 'win32') {
      const out = execSync(`netstat -ano | findstr :${port}`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      });
      const lines = out.split(/\r?\n/).filter(l => /LISTENING/i.test(l));
      if (!lines.length) return null;
      const cols = lines[0].trim().split(/\s+/);
      const pid = parseInt(cols[cols.length - 1], 10);
      return Number.isFinite(pid) ? pid : null;
    }
  } catch (_e) {
    return null;
  }
  return null;
}

// Scan running processes for a Chrome holding our profile's lock.
// Used to adopt orphan Chrome instances (meta.json missing/stale).
// Returns { pid, port } for first match, or null.
//
// Scans ps output for Chrome processes with:
//   --user-data-dir=<our profileDir> AND --remote-debugging-port=<N>
// Skips Chrome Helper processes (renderer, GPU, etc).
function findOrphanChromeForProfile(profileName) {
  const { execSync } = require('child_process');
  try {
    const profileDir = getChromeProfileDir(profileName);
    let psOutput;

    if (process.platform === 'darwin' || process.platform === 'linux') {
      // ps auxw: full command line per process
      psOutput = execSync('ps auxw', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      });
    } else if (process.platform === 'win32') {
      // Windows: use wmic to list processes with their full command line
      psOutput = execSync('wmic process list full', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      });
    } else {
      return null; // Unsupported platform
    }

    const lines = psOutput.split('\n');
    for (const line of lines) {
      // Skip empty lines and Chrome Helper processes (rendering, GPU, etc)
      if (!line.trim() || line.includes('Chrome Helper') || line.includes('chrome.exe --type=')) {
        continue;
      }

      // Must contain our profile dir
      if (!line.includes(profileDir)) {
        continue;
      }

      // Must contain --remote-debugging-port
      const portMatch = line.match(/--remote-debugging-port=(\d+)/);
      if (!portMatch || !portMatch[1]) {
        continue;
      }

      const port = parseInt(portMatch[1], 10);

      // Extract PID: position varies by platform, but it's early in the line.
      // macOS/Linux: "USER PID ..." — PID is second field after spaces
      // Windows wmic: "ProcessId=..." or first numeric field
      let pid;
      if (process.platform === 'darwin' || process.platform === 'linux') {
        const fields = line.split(/\s+/);
        if (fields.length >= 2) {
          pid = parseInt(fields[1], 10);
        }
      } else if (process.platform === 'win32') {
        const pidMatch = line.match(/ProcessId=(\d+)|^(\d+)\s/);
        if (pidMatch) {
          pid = parseInt(pidMatch[1] || pidMatch[2], 10);
        }
      }

      if (Number.isFinite(pid) && Number.isFinite(port)) {
        return { pid, port };
      }
    }

    return null;
  } catch (_e) {
    // ps or wmic failed, no process info available
    return null;
  }
}

function buildChromeArgs({ chosenPort, chromeUserDataDir, chromeHeadless }) {
  const args = [
    `--remote-debugging-port=${chosenPort}`,
    `--user-data-dir=${chromeUserDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-search-engine-choice-screen',
    '--password-store=basic',
    '--use-mock-keychain',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-breakpad',
    '--disable-client-side-phishing-detection',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-dev-shm-usage',
    '--disable-extensions',
    '--disable-features=Translate,TranslateUI,OptimizationHints',
    '--disable-hang-monitor',
    '--disable-ipc-flooding-protection',
    '--disable-popup-blocking',
    '--disable-prompt-on-repost',
    '--disable-sync',
    '--force-color-profile=srgb',
    '--metrics-recording-only',
    '--no-sandbox',
    '--safebrowsing-disable-auto-update',
    '--disable-blink-features=AutomationControlled'
  ];

  if (chromeHeadless) {
    args.push('--headless=new');
  }

  // CHROME_EXTRA_ARGS: whitespace-separated extra flags to append, e.g. for
  // software WebGL in headless containers:
  //   CHROME_EXTRA_ARGS="--use-gl=angle --use-angle=swiftshader-webgl --enable-unsafe-swiftshader"
  const extraArgs = process.env.CHROME_EXTRA_ARGS;
  if (extraArgs) {
    const tokens = extraArgs.split(/\s+/).filter(Boolean);
    args.push(...tokens);
  }

  return args;
}

module.exports = {
  PORT_RANGE_START,
  PORT_RANGE_END,
  chromeHttpAt,
  getXdgCacheHome,
  getChromeProfileDir,
  getProfileMetaPath,
  readProfileMeta,
  writeProfileMeta,
  clearProfileMeta,
  isPortAlive,
  isPortFree,
  portFreeFromProbes,
  findAvailablePort,
  findPidOnPort,
  findOrphanChromeForProfile,
  buildChromeArgs,
};
