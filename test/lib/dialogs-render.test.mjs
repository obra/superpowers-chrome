import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { renderSyntheticArtifacts } = require('../../skills/browsing/lib/dialogs-render.js');

function golden(name) {
  return readFileSync(join(__dirname, 'fixtures', name), 'utf8');
}

describe('renderSyntheticArtifacts', () => {
  it('renders alert markdown matching golden file', () => {
    const out = renderSyntheticArtifacts({
      kind: 'alert',
      payload: { message: 'Something happened.', url: 'http://example.com', defaultPrompt: '', hasBrowserHandler: false },
      staged: {},
    });
    assert.equal(out.markdown.trim(), golden('dialog-alert.md').trim());
  });

  it('renders confirm matching golden', () => {
    const out = renderSyntheticArtifacts({
      kind: 'confirm',
      payload: { message: 'Are you sure?', url: 'http://example.com', defaultPrompt: '', hasBrowserHandler: false },
      staged: {},
    });
    assert.equal(out.markdown.trim(), golden('dialog-confirm.md').trim());
  });

  it('renders prompt without default matching golden', () => {
    const out = renderSyntheticArtifacts({
      kind: 'prompt',
      payload: { message: 'Enter your name:', url: 'http://example.com', defaultPrompt: '', hasBrowserHandler: false },
      staged: {},
    });
    assert.equal(out.markdown.trim(), golden('dialog-prompt.md').trim());
  });

  it('renders prompt with default matching golden', () => {
    const out = renderSyntheticArtifacts({
      kind: 'prompt',
      payload: { message: 'Enter your nickname:', url: 'http://example.com', defaultPrompt: 'guest', hasBrowserHandler: false },
      staged: {},
    });
    assert.equal(out.markdown.trim(), golden('dialog-prompt-default.md').trim());
  });

  it('renders beforeunload matching golden', () => {
    const out = renderSyntheticArtifacts({
      kind: 'beforeunload',
      payload: { message: 'The page wants to confirm you really want to leave.', url: 'http://example.com', defaultPrompt: '', hasBrowserHandler: false },
      staged: {},
    });
    assert.equal(out.markdown.trim(), golden('dialog-beforeunload.md').trim());
  });

  it('renders device-chooser with 0 devices', () => {
    const out = renderSyntheticArtifacts({
      kind: 'device-chooser',
      payload: { requestId: 'r', deviceKind: 'usb', devices: [] },
      staged: {},
    });
    assert.equal(out.markdown.trim(), golden('dialog-device-chooser-0.md').trim());
  });

  it('renders device-chooser with 1 device', () => {
    const out = renderSyntheticArtifacts({
      kind: 'device-chooser',
      payload: { requestId: 'r', deviceKind: 'usb', devices: [{ id: 'abc', name: 'Logitech USB Receiver' }] },
      staged: {},
    });
    assert.equal(out.markdown.trim(), golden('dialog-device-chooser-1.md').trim());
  });

  it('renders device-chooser with many devices', () => {
    const out = renderSyntheticArtifacts({
      kind: 'device-chooser',
      payload: { requestId: 'r', deviceKind: 'bluetooth', devices: [
        { id: 'x1', name: 'Speaker' }, { id: 'x2', name: 'Headphones' }, { id: 'x3', name: 'Watch' },
      ]},
      staged: {},
    });
    assert.equal(out.markdown.trim(), golden('dialog-device-chooser-many.md').trim());
  });

  it('renders permission', () => {
    const out = renderSyntheticArtifacts({
      kind: 'permission',
      payload: { name: 'camera', origin: 'https://example.com', jsApi: 'navigator.mediaDevices.getUserMedia' },
      staged: {},
    });
    assert.equal(out.markdown.trim(), golden('dialog-permission.md').trim());
  });

  it('renders basic-auth with realm', () => {
    const out = renderSyntheticArtifacts({
      kind: 'basic-auth',
      payload: { requestId: 'r', origin: 'https://example.com', scheme: 'basic', realm: 'Admin Area' },
      staged: {},
    });
    assert.equal(out.markdown.trim(), golden('dialog-basic-auth.md').trim());
  });

  it('renders basic-auth without realm', () => {
    const out = renderSyntheticArtifacts({
      kind: 'basic-auth',
      payload: { requestId: 'r', origin: 'https://example.com', scheme: 'basic', realm: '' },
      staged: {},
    });
    assert.equal(out.markdown.trim(), golden('dialog-basic-auth-no-realm.md').trim());
  });
});

describe('synthetic html', () => {
  it('emits an element with id=dialog-accept for confirm', () => {
    const out = renderSyntheticArtifacts({
      kind: 'confirm',
      payload: { message: 'q', url: '', defaultPrompt: '', hasBrowserHandler: false },
      staged: {},
    });
    assert.match(out.html, /<button[^>]*id="dialog-accept"/);
    assert.match(out.html, /<button[^>]*id="dialog-dismiss"/);
  });

  it('emits an input id=dialog-prompt for prompt', () => {
    const out = renderSyntheticArtifacts({
      kind: 'prompt',
      payload: { message: 'q', url: '', defaultPrompt: '', hasBrowserHandler: false },
      staged: {},
    });
    assert.match(out.html, /<input[^>]*id="dialog-prompt"/);
  });

  it('emits a button per device with data-device-id', () => {
    const out = renderSyntheticArtifacts({
      kind: 'device-chooser',
      payload: { requestId: 'r', deviceKind: 'usb', devices: [{ id: 'abc', name: 'D' }] },
      staged: {},
    });
    assert.match(out.html, /data-device-id="abc"/);
  });

  it('emits username and password inputs for basic-auth', () => {
    const out = renderSyntheticArtifacts({
      kind: 'basic-auth',
      payload: { requestId: 'r', origin: 'x', scheme: 'basic', realm: '' },
      staged: {},
    });
    assert.match(out.html, /<input[^>]*id="dialog-username"/);
    assert.match(out.html, /<input[^>]*id="dialog-password"[^>]*type="password"/);
  });
});

describe('renderResponseSummary', () => {
  const { renderResponseSummary } = require('../../skills/browsing/lib/dialogs-render.js');

  it('summarizes a confirm dialog inline', () => {
    const summary = renderResponseSummary({
      kind: 'confirm',
      payload: { message: 'Are you sure?', url: 'http://x', defaultPrompt: '', hasBrowserHandler: false },
      staged: {},
    }, 0);
    assert.match(summary, /Dialog open on tab 0: confirm/);
    assert.match(summary, /Message: "Are you sure\?"/);
    assert.match(summary, /Handle with: click dialog::accept \| click dialog::dismiss/);
    assert.match(summary, /no screenshot — dialog overlay is browser-native UI/);
  });

  it('uses a one-button hint for alert', () => {
    const summary = renderResponseSummary({
      kind: 'alert',
      payload: { message: 'hi', url: 'http://x', defaultPrompt: '', hasBrowserHandler: false },
      staged: {},
    }, 1);
    assert.match(summary, /Handle with: click dialog::accept$/m);
  });
});
