/**
 * Chrome WebSocket Library - Core CDP automation functions
 * Used by both CLI and MCP server
 */

const http = require('http');
const crypto = require('crypto');

const {
  CHROME_DEBUG_HOST,
  CHROME_DEBUG_PORT,
  rewriteWsUrl
} = require('./host-override');

// Minimal WebSocket client implementation (dependency-free)
class WebSocketClient {
  constructor(url) {
    this.url = new URL(url);
    this.callbacks = {};
    this.socket = null;
    this.buffer = Buffer.alloc(0);
  }

  on(event, callback) {
    this.callbacks[event] = callback;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64');

      const options = {
        hostname: this.url.hostname,
        port: this.url.port || 80,
        path: this.url.pathname + this.url.search,
        headers: {
          'Upgrade': 'websocket',
          'Connection': 'Upgrade',
          'Sec-WebSocket-Key': key,
          'Sec-WebSocket-Version': '13'
        }
      };

      const req = http.request(options);

      req.on('upgrade', (res, socket) => {
        this.socket = socket;

        socket.on('data', (data) => {
          this.buffer = Buffer.concat([this.buffer, data]);
          this.processFrames();
        });

        socket.on('error', (err) => {
          if (this.callbacks.error) this.callbacks.error(err);
        });

        if (this.callbacks.open) this.callbacks.open();
        resolve();
      });

      req.on('error', reject);
      req.end();
    });
  }

  processFrames() {
    while (this.buffer.length >= 2) {
      const firstByte = this.buffer[0];
      const secondByte = this.buffer[1];

      const fin = (firstByte & 0x80) !== 0;
      const opcode = firstByte & 0x0F;
      const masked = (secondByte & 0x80) !== 0;
      let payloadLen = secondByte & 0x7F;

      let offset = 2;

      if (payloadLen === 126) {
        if (this.buffer.length < 4) return;
        payloadLen = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this.buffer.length < 10) return;
        payloadLen = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }

      if (this.buffer.length < offset + payloadLen) return;

      let payload = this.buffer.slice(offset, offset + payloadLen);
      this.buffer = this.buffer.slice(offset + payloadLen);

      if (opcode === 0x1 && this.callbacks.message) {
        this.callbacks.message(payload.toString('utf8'));
      }
    }
  }

  send(data) {
    const payload = Buffer.from(data, 'utf8');
    const payloadLen = payload.length;

    let frame;
    let offset = 2;

    if (payloadLen < 126) {
      frame = Buffer.alloc(payloadLen + 6);
      frame[1] = payloadLen | 0x80;
    } else if (payloadLen < 65536) {
      frame = Buffer.alloc(payloadLen + 8);
      frame[1] = 126 | 0x80;
      frame.writeUInt16BE(payloadLen, 2);
      offset = 4;
    } else {
      frame = Buffer.alloc(payloadLen + 14);
      frame[1] = 127 | 0x80;
      frame.writeBigUInt64BE(BigInt(payloadLen), 2);
      offset = 10;
    }

    frame[0] = 0x81; // FIN + text frame

    const mask = Buffer.alloc(4);
    crypto.randomFillSync(mask);
    mask.copy(frame, offset);
    offset += 4;

    for (let i = 0; i < payloadLen; i++) {
      frame[offset + i] = payload[i] ^ mask[i % 4];
    }

    this.socket.write(frame);
  }

  close() {
    if (this.socket) {
      this.socket.end();
      this.socket = null;
    }
  }
}

// Helper to make HTTP requests to Chrome
async function chromeHttp(path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: CHROME_DEBUG_HOST,
      port: CHROME_DEBUG_PORT,
      path,
      method: method
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (!data) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          // Some endpoints return plain text (e.g., "Target is closing")
          resolve({ message: data });
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

// Console message storage per tab
const consoleMessages = new Map();

// Session management
let sessionDir = null;
let captureCounter = 0;

// Chrome process management
let chromeProcess = null;
let chromeHeadless = true; // Default to headless mode
let chromeUserDataDir = null;
let chromeProfileName = 'superpowers-chrome'; // Default profile name

// Helper to resolve tab index or ws URL to actual ws URL
async function resolveWsUrl(wsUrlOrIndex) {
  // If it's already a WebSocket URL, rewrite and return it
  if (typeof wsUrlOrIndex === 'string' && wsUrlOrIndex.startsWith('ws://')) {
    return rewriteWsUrl(wsUrlOrIndex);
  }

  // If it's a number (tab index), resolve it
  const index = typeof wsUrlOrIndex === 'number' ? wsUrlOrIndex : parseInt(wsUrlOrIndex);
  if (!isNaN(index)) {
    const tabs = await chromeHttp('/json');
    const pageTabs = tabs.filter(t => t.type === 'page');

    // Auto-create tab if none exist (similar to auto-start Chrome behavior)
    if (pageTabs.length === 0) {
      const newTabInfo = await newTab();
      return newTabInfo.webSocketDebuggerUrl;
    }

    if (index < 0 || index >= pageTabs.length) {
      throw new Error(`Tab index ${index} out of range (0-${pageTabs.length - 1})`);
    }
    return pageTabs[index].webSocketDebuggerUrl;
  }

  throw new Error(`Invalid tab specifier: ${wsUrlOrIndex}`);
}

// Message ID counter (simple incrementing counter)
let messageIdCounter = 1;

// Helper to generate element selection code (supports CSS and XPath)
function getElementSelector(selector) {
  if (selector.startsWith('/') || selector.startsWith('//')) {
    // XPath selector
    return `document.evaluate(${JSON.stringify(selector)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue`;
  } else {
    // CSS selector
    return `document.querySelector(${JSON.stringify(selector)})`;
  }
}

// Send CDP command and wait for response
async function sendCdpCommand(wsUrl, method, params = {}) {
  const ws = new WebSocketClient(wsUrl);

  return new Promise((resolve, reject) => {
    const id = messageIdCounter++;
    let resolved = false;

    ws.on('message', (msg) => {
      const data = JSON.parse(msg);
      if (data.id === id) {
        resolved = true;
        ws.close();
        if (data.error) {
          reject(new Error(data.error.message || JSON.stringify(data.error)));
        } else {
          resolve(data.result);
        }
      }
    });

    ws.on('error', (err) => {
      if (!resolved) {
        reject(err);
      }
    });

    ws.connect()
      .then(() => {
        ws.send(JSON.stringify({ id, method, params }));
      })
      .catch(reject);

    // Timeout after 30s
    setTimeout(() => {
      if (!resolved) {
        ws.close();
        reject(new Error('CDP command timeout'));
      }
    }, 30000);
  });
}

// API Functions

async function getTabs() {
  const tabs = await chromeHttp('/json');
  if (!Array.isArray(tabs)) {
    return [];
  }
  return tabs
    .filter(tab => tab.type === 'page')
    .map(tab => ({
      ...tab,
      webSocketDebuggerUrl: rewriteWsUrl(tab.webSocketDebuggerUrl)
    }));
}

async function newTab(url = 'about:blank') {
  const encoded = encodeURIComponent(url);
  const tab = await chromeHttp(`/json/new?${encoded}`, 'PUT');
  if (tab && typeof tab === 'object') {
    tab.webSocketDebuggerUrl = rewriteWsUrl(tab.webSocketDebuggerUrl);
  }
  return tab;
}

async function closeTab(tabIndexOrWsUrl) {
  const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);
  const tabs = await chromeHttp('/json');
  const tab = tabs.find(t => t.webSocketDebuggerUrl === wsUrl);
  if (tab) {
    await chromeHttp(`/json/close/${tab.id}`, 'GET');
  }
}

async function navigate(tabIndexOrWsUrl, url, autoCapture = false) {
  const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);

  // Clear previous console messages if auto-capture is on
  const startTime = new Date();
  if (autoCapture) {
    await clearConsoleMessages(tabIndexOrWsUrl);
  }

  const result = await sendCdpCommand(wsUrl, 'Page.navigate', { url });

  // Wait for page load with console logging enabled if needed
  await new Promise((resolve) => {
    const ws = new WebSocketClient(wsUrl);
    let pageLoaded = false;

    ws.on('message', (msg) => {
      const data = JSON.parse(msg);

      if (data.method === 'Page.loadEventFired' && !pageLoaded) {
        pageLoaded = true;
        // Keep connection alive a bit longer for console messages if auto-capture is on
        if (autoCapture) {
          setTimeout(() => {
            ws.close();
            resolve();
          }, 1000); // Wait 1 second for console messages
        } else {
          ws.close();
          resolve();
        }
      }

      // Capture console messages during navigation if auto-capture is on
      if (autoCapture && data.method === 'Runtime.consoleAPICalled') {
        const entry = data.params;
        const timestamp = new Date().toISOString();
        const level = entry.type || 'log';
        const args = entry.args || [];

        // Extract text from arguments
        const text = args.map(arg => {
          if (arg.type === 'string') return arg.value;
          if (arg.type === 'number') return String(arg.value);
          if (arg.type === 'boolean') return String(arg.value);
          if (arg.type === 'object') return arg.description || '[Object]';
          return String(arg.value || arg.description || arg.type);
        }).join(' ');

        const messages = consoleMessages.get(wsUrl) || [];
        messages.push({
          timestamp,
          level,
          text
        });
        consoleMessages.set(wsUrl, messages);
      }
    });

    ws.connect().then(() => {
      // Enable both Page and Runtime domains
      sendCdpCommand(wsUrl, 'Page.enable');
      if (autoCapture) {
        sendCdpCommand(wsUrl, 'Runtime.enable');
      }
    });

    // Timeout after 30s
    setTimeout(() => {
      if (!pageLoaded) {
        ws.close();
        resolve();
      }
    }, 30000);
  });

  // Auto-capture if requested
  if (autoCapture) {
    try {
      const artifacts = await capturePageArtifacts(tabIndexOrWsUrl, 'navigate');

      // TODO: Fix console logging - currently returns empty array
      // The console logging needs a persistent WebSocket connection which
      // conflicts with the current single-use connection pattern
      const consoleLog = []; // Placeholder for now

      return {
        frameId: result.frameId,
        url,
        pageSize: artifacts.pageSize,
        capturePrefix: artifacts.capturePrefix,
        sessionDir: artifacts.sessionDir,
        files: artifacts.files,
        domSummary: artifacts.domSummary,
        consoleLog
      };
    } catch (error) {
      // If auto-capture fails, still return success but with error note
      return {
        frameId: result.frameId,
        url,
        error: `Auto-capture failed: ${error.message}`
      };
    }
  }

  return result.frameId;
}

async function click(tabIndexOrWsUrl, selector) {
  const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);
  const js = `${getElementSelector(selector)}?.click()`;
  await sendCdpCommand(wsUrl, 'Runtime.evaluate', { expression: js });
}

async function fill(tabIndexOrWsUrl, selector, value) {
  const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);
  const escapedValue = value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
  const js = `
    (() => {
      const el = ${getElementSelector(selector)};
      if (el) {
        el.value = '${escapedValue}';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        ${value.endsWith('\n') ? 'el.form?.submit() || el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, bubbles: true }));' : ''}
      }
    })()
  `;
  await sendCdpCommand(wsUrl, 'Runtime.evaluate', { expression: js });
}

async function selectOption(tabIndexOrWsUrl, selector, value) {
  const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);
  const js = `
    (() => {
      const el = ${getElementSelector(selector)};
      if (el && el.tagName === 'SELECT') {
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
      return false;
    })()
  `;
  const result = await sendCdpCommand(wsUrl, 'Runtime.evaluate', {
    expression: js,
    returnByValue: true
  });
  return result.result.value;
}

async function evaluate(tabIndexOrWsUrl, expression) {
  const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);
  const result = await sendCdpCommand(wsUrl, 'Runtime.evaluate', {
    expression,
    returnByValue: true
  });
  return result.result.value;
}

async function extractText(tabIndexOrWsUrl, selector) {
  const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);
  const js = `${getElementSelector(selector)}?.textContent`;
  const result = await sendCdpCommand(wsUrl, 'Runtime.evaluate', {
    expression: js,
    returnByValue: true
  });
  return result.result.value;
}

async function getHtml(tabIndexOrWsUrl, selector = null) {
  const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);
  const js = selector
    ? `${getElementSelector(selector)}?.innerHTML`
    : 'document.documentElement.outerHTML';
  const result = await sendCdpCommand(wsUrl, 'Runtime.evaluate', {
    expression: js,
    returnByValue: true
  });
  return result.result.value;
}

async function getAttribute(tabIndexOrWsUrl, selector, attrName) {
  const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);
  const js = `${getElementSelector(selector)}?.getAttribute(${JSON.stringify(attrName)})`;
  const result = await sendCdpCommand(wsUrl, 'Runtime.evaluate', {
    expression: js,
    returnByValue: true
  });
  return result.result.value;
}

async function waitForElement(tabIndexOrWsUrl, selector, timeout = 5000) {
  const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);
  const js = `
    new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout')), ${timeout});
      const check = () => {
        if (${getElementSelector(selector)}) {
          clearTimeout(timeout);
          resolve(true);
        } else {
          setTimeout(check, 100);
        }
      };
      check();
    })
  `;
  await sendCdpCommand(wsUrl, 'Runtime.evaluate', {
    expression: js,
    awaitPromise: true
  });
}

async function waitForText(tabIndexOrWsUrl, text, timeout = 5000) {
  const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);
  const js = `
    new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout')), ${timeout});
      const check = () => {
        if (document.body.textContent.includes(${JSON.stringify(text)})) {
          clearTimeout(timeout);
          resolve(true);
        } else {
          setTimeout(check, 100);
        }
      };
      check();
    })
  `;
  await sendCdpCommand(wsUrl, 'Runtime.evaluate', {
    expression: js,
    awaitPromise: true
  });
}

async function screenshot(tabIndexOrWsUrl, filename, selector = null) {
  const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);

  let clip = undefined;
  if (selector) {
    // Get element bounds
    const js = `
      (() => {
        const el = ${getElementSelector(selector)};
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return {
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height,
          scale: 1
        };
      })()
    `;
    const result = await sendCdpCommand(wsUrl, 'Runtime.evaluate', {
      expression: js,
      returnByValue: true
    });
    clip = result.result.value;
  }

  const result = await sendCdpCommand(wsUrl, 'Page.captureScreenshot', {
    format: 'png',
    ...(clip ? { clip } : {})
  });

  const fs = require('fs');
  const path = require('path');
  const buffer = Buffer.from(result.data, 'base64');
  fs.writeFileSync(filename, buffer);
  // Return absolute path so caller knows exactly where file is
  return path.resolve(filename);
}

async function startChrome(headless = null, profileName = null) {
  const { spawn } = require('child_process');
  const { existsSync, mkdirSync } = require('fs');
  const os = require('os');

  // Use provided headless parameter, or fall back to current mode
  if (headless !== null) {
    chromeHeadless = headless;
  }

  // Use provided profile name, or fall back to current profile
  if (profileName !== null) {
    chromeProfileName = profileName;
  }

  // Platform-specific Chrome paths
  const chromePaths = {
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium'
    ],
    linux: [
      '/usr/bin/google-chrome',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium'
    ],
    win32: [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
    ]
  };

  const platform = os.platform();
  const paths = chromePaths[platform] || [];

  let chromePath = null;
  for (const path of paths) {
    if (existsSync(path)) {
      chromePath = path;
      break;
    }
  }

  if (!chromePath) {
    throw new Error(`Chrome not found. Searched: ${paths.join(', ')}`);
  }

  // Set up profile directory (persistent across sessions)
  if (!chromeUserDataDir) {
    chromeUserDataDir = getChromeProfileDir(chromeProfileName);
    // Ensure profile directory exists
    mkdirSync(chromeUserDataDir, { recursive: true });
  }

  const args = [
    `--remote-debugging-port=9222`,
    `--user-data-dir=${chromeUserDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-breakpad',
    '--disable-client-side-phishing-detection',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-dev-shm-usage',
    '--disable-extensions',
    '--disable-features=TranslateUI',
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

  // Add headless flag if in headless mode
  if (chromeHeadless) {
    args.push('--headless=new');
  }

  const proc = spawn(chromePath, args, {
    detached: true,
    stdio: 'ignore'
  });

  proc.unref();
  chromeProcess = proc;

  // Wait for Chrome to be ready
  await new Promise(resolve => setTimeout(resolve, 2000));

  const mode = chromeHeadless ? 'headless' : 'headed';
  console.error(`Chrome started in ${mode} mode (PID: ${proc.pid}, profile: ${chromeProfileName})`);
}

async function killChrome() {
  if (!chromeProcess) {
    return;
  }

  try {
    // Try graceful shutdown first via CDP
    try {
      await chromeHttp('/json/close', 'GET');
      await new Promise(resolve => setTimeout(resolve, 500));
    } catch (e) {
      // Ignore errors, Chrome might already be dead
    }

    // Force kill if still running
    if (chromeProcess && chromeProcess.pid) {
      try {
        process.kill(chromeProcess.pid, 'SIGTERM');
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (e) {
        // Process might already be dead
      }
    }
  } catch (e) {
    console.error(`Error killing Chrome: ${e.message}`);
  }

  chromeProcess = null;
}

async function showBrowser() {
  if (!chromeHeadless) {
    return 'Browser is already visible';
  }

  console.error('Switching to headed mode (browser window will be visible)...');
  console.error('WARNING: This will restart Chrome and lose any POST-based page state');

  // Get current tabs before killing Chrome
  let currentTabs = [];
  try {
    const tabs = await getTabs();
    currentTabs = tabs.map(t => t.url).filter(url => url && url !== 'about:blank');
  } catch (e) {
    // Ignore errors if Chrome isn't running
  }

  // Kill current Chrome instance
  await killChrome();

  // Start Chrome in headed mode
  await startChrome(false);

  // Reopen tabs (Note: This will re-request pages via GET, losing POST state)
  if (currentTabs.length > 0) {
    console.error(`Reopening ${currentTabs.length} tab(s)...`);
    for (const url of currentTabs) {
      try {
        await newTab(url);
      } catch (e) {
        console.error(`Failed to reopen ${url}: ${e.message}`);
      }
    }
  }

  return 'Browser window is now visible. Note: Pages were reloaded via GET requests.';
}

async function hideBrowser() {
  if (chromeHeadless) {
    return 'Browser is already in headless mode';
  }

  console.error('Switching to headless mode (hiding browser window)...');
  console.error('WARNING: This will restart Chrome and lose any POST-based page state');

  // Get current tabs before killing Chrome
  let currentTabs = [];
  try {
    const tabs = await getTabs();
    currentTabs = tabs.map(t => t.url).filter(url => url && url !== 'about:blank');
  } catch (e) {
    // Ignore errors if Chrome isn't running
  }

  // Kill current Chrome instance
  await killChrome();

  // Start Chrome in headless mode
  await startChrome(true);

  // Reopen tabs (Note: This will re-request pages via GET, losing POST state)
  if (currentTabs.length > 0) {
    console.error(`Reopening ${currentTabs.length} tab(s)...`);
    for (const url of currentTabs) {
      try {
        await newTab(url);
      } catch (e) {
        console.error(`Failed to reopen ${url}: ${e.message}`);
      }
    }
  }

  return 'Browser is now in headless mode. Note: Pages were reloaded via GET requests.';
}

async function getBrowserMode() {
  return {
    headless: chromeHeadless,
    mode: chromeHeadless ? 'headless' : 'headed',
    running: chromeProcess !== null,
    profile: chromeProfileName,
    profileDir: chromeUserDataDir
  };
}

function getProfileName() {
  return chromeProfileName;
}

function setProfileName(profileName) {
  if (chromeProcess) {
    throw new Error('Cannot change profile while Chrome is running. Kill Chrome first.');
  }
  chromeProfileName = profileName;
  chromeUserDataDir = null; // Reset so next startChrome() uses new profile
  return `Profile set to: ${profileName}`;
}

// Console logging utilities
async function enableConsoleLogging(tabIndexOrWsUrl) {
  const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);

  // Initialize console messages array for this tab
  if (!consoleMessages.has(wsUrl)) {
    consoleMessages.set(wsUrl, []);
  }

  // Start persistent WebSocket connection for console logging
  const ws = new WebSocketClient(wsUrl);

  return new Promise((resolve, reject) => {
    let enabledRuntime = false;

    ws.on('message', (msg) => {
      const data = JSON.parse(msg);

      // Handle Runtime.enable response
      if (data.id === 999999 && !enabledRuntime) {
        enabledRuntime = true;
        // Don't close the WebSocket - keep it open for console messages
        resolve();
        return;
      }

      // Capture console messages
      if (data.method === 'Runtime.consoleAPICalled') {
        const entry = data.params;
        const timestamp = new Date().toISOString();
        const level = entry.type || 'log';
        const args = entry.args || [];

        // Extract text from arguments
        const text = args.map(arg => {
          if (arg.type === 'string') return arg.value;
          if (arg.type === 'number') return String(arg.value);
          if (arg.type === 'boolean') return String(arg.value);
          if (arg.type === 'object') return arg.description || '[Object]';
          return String(arg.value || arg.description || arg.type);
        }).join(' ');

        const messages = consoleMessages.get(wsUrl) || [];
        messages.push({
          timestamp,
          level,
          text
        });
        consoleMessages.set(wsUrl, messages);
      }
    });

    ws.on('error', (err) => {
      if (!enabledRuntime) {
        reject(err);
      }
    });

    ws.connect()
      .then(() => {
        // Enable Runtime domain to receive console messages
        ws.send(JSON.stringify({
          id: 999999, // Use fixed ID to identify this response
          method: 'Runtime.enable'
        }));
      })
      .catch(reject);

    // Timeout after 5s
    setTimeout(() => {
      if (!enabledRuntime) {
        ws.close();
        reject(new Error('Console logging enable timeout'));
      }
    }, 5000);
  });
}

async function getConsoleMessages(tabIndexOrWsUrl, sinceTime = null) {
  const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);
  const messages = consoleMessages.get(wsUrl) || [];

  if (!sinceTime) {
    return messages;
  }

  // Filter messages since the specified time
  return messages.filter(msg => new Date(msg.timestamp) > sinceTime);
}

async function clearConsoleMessages(tabIndexOrWsUrl) {
  const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);
  consoleMessages.set(wsUrl, []);
}

// Session and directory management
function getXdgCacheHome() {
  const os = require('os');
  const path = require('path');

  // Check XDG_CACHE_HOME environment variable first
  if (process.env.XDG_CACHE_HOME) {
    return process.env.XDG_CACHE_HOME;
  }

  // Fall back to platform-specific defaults
  const platform = os.platform();
  const homeDir = os.homedir();

  if (platform === 'darwin') {
    return path.join(homeDir, 'Library', 'Caches');
  } else if (platform === 'win32') {
    return process.env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local');
  } else {
    // Linux and other Unix-like systems
    return path.join(homeDir, '.cache');
  }
}

function getChromeProfileDir(profileName = 'superpowers-chrome') {
  const path = require('path');
  const cacheHome = getXdgCacheHome();
  return path.join(cacheHome, 'superpowers', 'browser-profiles', profileName);
}

function initializeSession() {
  if (!sessionDir) {
    const fs = require('fs');
    const path = require('path');

    // Create XDG cache directory structure: ~/.cache/superpowers/browser/YYYY-MM-DD/session-{timestamp}
    const cacheHome = getXdgCacheHome();
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD
    const sessionId = `session-${Date.now()}`;

    sessionDir = path.join(cacheHome, 'superpowers', 'browser', dateStr, sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    captureCounter = 0;

    console.error(`Browser session directory: ${sessionDir}`);

    // Register cleanup on process exit
    process.on('exit', cleanupSession);
    process.on('SIGINT', () => {
      cleanupSession();
      process.exit(0);
    });
    process.on('SIGTERM', () => {
      cleanupSession();
      process.exit(0);
    });
  }
  return sessionDir;
}

function cleanupSession() {
  if (sessionDir) {
    try {
      const fs = require('fs');
      fs.rmSync(sessionDir, { recursive: true, force: true });
      console.error(`Cleaned up session directory: ${sessionDir}`);
    } catch (error) {
      console.error(`Failed to cleanup session directory: ${error.message}`);
    }
    sessionDir = null;
  }
}

function createCapturePrefix(actionType = 'navigate') {
  // Ensure session is initialized
  initializeSession();

  // Create time-ordered prefix for flat file structure
  captureCounter++;
  return `${String(captureCounter).padStart(3, '0')}-${actionType}`;
}

async function generateDomSummary(tabIndexOrWsUrl) {
  const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);

  // Smart, token-efficient DOM summary
  const js = `
    (() => {
      // Count interactive elements
      const buttons = document.querySelectorAll('button, input[type="button"], input[type="submit"]').length;
      const inputs = document.querySelectorAll('input:not([type="button"]):not([type="submit"]), textarea, select').length;
      const links = document.querySelectorAll('a[href]').length;

      // Get page structure
      const title = document.title.slice(0, 60);
      const allH1s = Array.from(document.querySelectorAll('h1')).map(h => h.textContent.trim().slice(0, 40)).filter(Boolean);
      const h1s = allH1s.slice(0, 3);
      const h1Extra = allH1s.length > 3 ? allH1s.length - 3 : 0;

      // Find main content area
      const main = document.querySelector('main, [role="main"], .main, #main, .content, #content');
      const mainTag = main ? main.tagName.toLowerCase() + (main.id ? '#' + main.id : main.className ? '.' + main.className.split(' ')[0] : '') : 'body';

      // Check for forms
      const forms = document.querySelectorAll('form');
      const formInfo = forms.length > 0 ? \`\${forms.length} form\${forms.length > 1 ? 's' : ''}\` : '';

      // Navigation elements
      const nav = document.querySelector('nav, [role="navigation"], .nav, #nav') ? 'nav' : '';

      return [
        \`\${title}\`,
        \`Interactive: \${buttons} buttons, \${inputs} inputs, \${links} links\`,
        h1s.length > 0 ? \`Headings: \${h1s.map(h => '"' + h + '"').join(', ')}\${h1Extra > 0 ? ', and ' + h1Extra + ' more' : ''}\` : '',
        \`Layout: \${nav ? 'nav + ' : ''}\${mainTag}\${formInfo ? ' + ' + formInfo : ''}\`
      ].filter(Boolean).join('\\n');
    })()
  `;

  const result = await sendCdpCommand(wsUrl, 'Runtime.evaluate', {
    expression: js,
    returnByValue: true
  });
  return result.result.value;
}

async function getPageSize(tabIndexOrWsUrl) {
  const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);

  const js = `({
    width: window.innerWidth,
    height: window.innerHeight,
    documentWidth: document.documentElement.scrollWidth,
    documentHeight: document.documentElement.scrollHeight
  })`;

  const result = await sendCdpCommand(wsUrl, 'Runtime.evaluate', {
    expression: js,
    returnByValue: true
  });
  return result.result.value;
}

async function generateMarkdown(tabIndexOrWsUrl) {
  const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);

  // Enhanced markdown extraction with image support
  const js = `
    (() => {
      const results = [];

      // Extract title
      const title = document.title;
      if (title) results.push(\`# \${title}\\n\`);

      // Count images for summary
      const allImages = document.querySelectorAll('img');
      const significantImages = Array.from(allImages).filter(img => {
        const rect = img.getBoundingClientRect();
        return rect.width >= 100 && rect.height >= 100;
      });

      // Add image summary at top if there are significant images
      if (significantImages.length > 0) {
        results.push(\`\\n**📷 This page contains \${significantImages.length} significant image(s). Check screenshot.png for visual content.**\\n\`);
      }

      // Extract main content elements including images
      const elements = document.querySelectorAll('h1, h2, h3, h4, h5, h6, p, a, li, pre, code, blockquote, table, img, figure');

      for (const el of elements) {
        const tag = el.tagName.toLowerCase();
        const text = el.textContent.trim();

        if (tag === 'img') {
          const alt = el.alt || '';
          const src = el.src || '';
          const rect = el.getBoundingClientRect();
          // Only include images that are reasonably sized (not tiny icons)
          if (rect.width >= 50 && rect.height >= 50) {
            const sizeInfo = \`\${Math.round(rect.width)}x\${Math.round(rect.height)}\`;
            const description = alt ? \`"\${alt}"\` : '(no alt text)';
            results.push(\`\\n![Image: \${description} - \${sizeInfo}](\${src})\\n\`);
          }
          continue;
        }

        if (tag === 'figure') {
          const figcaption = el.querySelector('figcaption');
          if (figcaption) {
            results.push(\`\\n*Figure: \${figcaption.textContent.trim()}*\\n\`);
          }
          continue;
        }

        if (!text) continue;

        if (tag.startsWith('h')) {
          const level = parseInt(tag[1]);
          results.push(\`\${'#'.repeat(level)} \${text}\\n\`);
        } else if (tag === 'p') {
          results.push(\`\${text}\\n\`);
        } else if (tag === 'a') {
          const href = el.href;
          results.push(\`[\${text}](\${href})\`);
        } else if (tag === 'li') {
          results.push(\`- \${text}\`);
        } else if (tag === 'pre' || tag === 'code') {
          results.push(\`\\\`\\\`\\\`\\n\${text}\\n\\\`\\\`\\\`\\n\`);
        } else if (tag === 'blockquote') {
          results.push(\`> \${text}\\n\`);
        } else if (tag === 'table') {
          // Simple table extraction
          const rows = el.querySelectorAll('tr');
          if (rows.length > 0) {
            results.push('\\n| Table Content |\\n|---|');
            for (let i = 0; i < Math.min(rows.length, 10); i++) {
              const cells = rows[i].querySelectorAll('td, th');
              const cellTexts = Array.from(cells).map(cell => cell.textContent.trim()).slice(0, 3);
              if (cellTexts.length > 0) {
                results.push(\`| \${cellTexts.join(' | ')} |\`);
              }
            }
            results.push('\\n');
          }
        }
      }

      return results.join('\\n').slice(0, 50000); // Limit size
    })()
  `;

  const result = await sendCdpCommand(wsUrl, 'Runtime.evaluate', {
    expression: js,
    returnByValue: true
  });
  return result.result.value;
}

async function capturePageArtifacts(tabIndexOrWsUrl, actionType = 'navigate') {
  const prefix = createCapturePrefix(actionType);
  const fs = require('fs');
  const path = require('path');

  // All files go in session root directory
  const dir = initializeSession();

  // Capture all artifacts in parallel
  const [html, markdown, pageSize, domSummary] = await Promise.all([
    getHtml(tabIndexOrWsUrl),
    generateMarkdown(tabIndexOrWsUrl),
    getPageSize(tabIndexOrWsUrl),
    generateDomSummary(tabIndexOrWsUrl)
  ]);

  // Save files with prefix (flat structure - all in session dir)
  const htmlPath = path.join(dir, `${prefix}.html`);
  const markdownPath = path.join(dir, `${prefix}.md`);
  const screenshotPath = path.join(dir, `${prefix}.png`);
  const consoleLogPath = path.join(dir, `${prefix}-console.txt`);

  fs.writeFileSync(htmlPath, html || '');
  fs.writeFileSync(markdownPath, markdown || '');

  // Create console log file (placeholder for now)
  fs.writeFileSync(consoleLogPath, '# Console Log\n# TODO: Console logging not yet implemented\n');

  // Take screenshot
  await screenshot(tabIndexOrWsUrl, screenshotPath);

  return {
    capturePrefix: prefix,
    sessionDir: dir,
    files: {
      html: htmlPath,
      markdown: markdownPath,
      screenshot: screenshotPath,
      consoleLog: consoleLogPath
    },
    pageSize,
    domSummary
  };
}

// Enhanced DOM actions with auto-capture
async function clickWithCapture(tabIndexOrWsUrl, selector) {
  await click(tabIndexOrWsUrl, selector);
  const artifacts = await capturePageArtifacts(tabIndexOrWsUrl, 'click');
  return {
    action: 'click',
    selector,
    pageSize: artifacts.pageSize,
    capturePrefix: artifacts.capturePrefix,
    sessionDir: artifacts.sessionDir,
    files: artifacts.files,
    domSummary: artifacts.domSummary,
    consoleLog: [] // Placeholder
  };
}

async function fillWithCapture(tabIndexOrWsUrl, selector, value) {
  await fill(tabIndexOrWsUrl, selector, value);
  const artifacts = await capturePageArtifacts(tabIndexOrWsUrl, 'type');
  return {
    action: 'type',
    selector,
    value,
    pageSize: artifacts.pageSize,
    capturePrefix: artifacts.capturePrefix,
    sessionDir: artifacts.sessionDir,
    files: artifacts.files,
    domSummary: artifacts.domSummary,
    consoleLog: [] // Placeholder
  };
}

async function selectOptionWithCapture(tabIndexOrWsUrl, selector, value) {
  await selectOption(tabIndexOrWsUrl, selector, value);
  const artifacts = await capturePageArtifacts(tabIndexOrWsUrl, 'select');
  return {
    action: 'select',
    selector,
    value,
    pageSize: artifacts.pageSize,
    capturePrefix: artifacts.capturePrefix,
    sessionDir: artifacts.sessionDir,
    files: artifacts.files,
    domSummary: artifacts.domSummary,
    consoleLog: [] // Placeholder
  };
}

async function evaluateWithCapture(tabIndexOrWsUrl, expression) {
  const result = await evaluate(tabIndexOrWsUrl, expression);
  const artifacts = await capturePageArtifacts(tabIndexOrWsUrl, 'eval');
  return {
    action: 'eval',
    expression,
    result,
    pageSize: artifacts.pageSize,
    capturePrefix: artifacts.capturePrefix,
    sessionDir: artifacts.sessionDir,
    files: artifacts.files,
    domSummary: artifacts.domSummary,
    consoleLog: [] // Placeholder
  };
}

module.exports = {
  getTabs,
  newTab,
  closeTab,
  navigate,
  click,
  fill,
  selectOption,
  evaluate,
  extractText,
  getHtml,
  getAttribute,
  waitForElement,
  waitForText,
  screenshot,
  startChrome,
  killChrome,
  // Headless mode management
  showBrowser,
  hideBrowser,
  getBrowserMode,
  // Profile management
  getChromeProfileDir,
  getProfileName,
  setProfileName,
  // Console logging utilities
  enableConsoleLogging,
  getConsoleMessages,
  clearConsoleMessages,
  // Session management
  getXdgCacheHome,
  initializeSession,
  cleanupSession,
  createCapturePrefix,
  // Auto-capture utilities
  generateDomSummary,
  getPageSize,
  generateMarkdown,
  capturePageArtifacts,
  // Enhanced DOM actions
  clickWithCapture,
  fillWithCapture,
  selectOptionWithCapture,
  evaluateWithCapture
};
