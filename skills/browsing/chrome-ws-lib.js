/**
 * Chrome WebSocket Library - Core CDP automation functions
 * Used by both CLI and MCP server
 */

const http = require('http');
const crypto = require('crypto');

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
  const url = new URL(`http://localhost:9222${path}`);

  return new Promise((resolve, reject) => {
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
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

// Helper to resolve tab index or ws URL to actual ws URL
async function resolveWsUrl(wsUrlOrIndex) {
  // If it's already a WebSocket URL, return it
  if (typeof wsUrlOrIndex === 'string' && wsUrlOrIndex.startsWith('ws://')) {
    return wsUrlOrIndex;
  }

  // If it's a number (tab index), resolve it
  const index = typeof wsUrlOrIndex === 'number' ? wsUrlOrIndex : parseInt(wsUrlOrIndex);
  if (!isNaN(index)) {
    const tabs = await chromeHttp('/json');
    const pageTabs = tabs.filter(t => t.type === 'page');
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
  return tabs.filter(tab => tab.type === 'page');
}

async function newTab(url = 'about:blank') {
  return await chromeHttp(`/json/new?${url}`, 'PUT');
}

async function closeTab(tabIndexOrWsUrl) {
  const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);
  const tabs = await chromeHttp('/json');
  const tab = tabs.find(t => t.webSocketDebuggerUrl === wsUrl);
  if (tab) {
    await chromeHttp(`/json/close/${tab.id}`, 'GET');
  }
}

async function navigate(tabIndexOrWsUrl, url) {
  const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);
  const result = await sendCdpCommand(wsUrl, 'Page.navigate', { url });

  // Wait for page load
  await new Promise((resolve) => {
    const ws = new WebSocketClient(wsUrl);
    ws.on('message', (msg) => {
      const data = JSON.parse(msg);
      if (data.method === 'Page.loadEventFired') {
        ws.close();
        resolve();
      }
    });
    ws.connect().then(() => {
      sendCdpCommand(wsUrl, 'Page.enable');
    });
    // Timeout after 30s
    setTimeout(() => {
      ws.close();
      resolve();
    }, 30000);
  });

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
  const buffer = Buffer.from(result.data, 'base64');
  fs.writeFileSync(filename, buffer);
  return filename;
}

async function startChrome() {
  const { spawn } = require('child_process');
  const { existsSync } = require('fs');
  const os = require('os');

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

  const userDataDir = require('path').join(os.tmpdir(), `chrome-remote-${Date.now()}`);

  const proc = spawn(chromePath, [
    `--remote-debugging-port=9222`,
    `--user-data-dir=${userDataDir}`,
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
  ], {
    detached: true,
    stdio: 'ignore'
  });

  proc.unref();

  // Wait for Chrome to be ready
  await new Promise(resolve => setTimeout(resolve, 2000));
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
  startChrome
};
