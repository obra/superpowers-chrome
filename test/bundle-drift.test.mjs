import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const { createSession } = require('../skills/browsing/chrome-ws-lib.js');

describe('bundle drift', () => {
  it('every chromeLib.X call in mcp/dist/index.js exists on the lib session object', () => {
    const distSource = fs.readFileSync(path.join(__dirname, '..', 'mcp', 'dist', 'index.js'), 'utf8');

    // Find every chromeLib.X( occurrence. The bundled MCP renames the
    // import; in the current bundle it's `chromeLib`. If the bundle
    // changes its variable name, update the regex.
    const callRegex = /\bchromeLib\.([a-zA-Z_$][\w$]*)\s*\(/g;
    const calledMethods = new Set();
    let m;
    while ((m = callRegex.exec(distSource)) !== null) {
      calledMethods.add(m[1]);
    }

    assert.ok(calledMethods.size > 0, 'no chromeLib.X( calls found in dist — regex needs updating');

    const session = createSession();
    const sessionMethods = new Set(Object.keys(session));

    const missing = [...calledMethods].filter(name => !sessionMethods.has(name));
    assert.deepEqual(missing, [], `bundle calls methods missing from lib: ${missing.join(', ')}`);
  });
});
