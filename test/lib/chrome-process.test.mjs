import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { attachChromeProcess } = require('../../skills/browsing/lib/chrome-process.js');

describe('chrome-process', () => {
  function setup() {
    const state = {
      hostOverride: {
        getHost: () => '127.0.0.1',
        getPort: () => 9222,
      },
      activePort: 9222,
      chromeHeadless: true,
      chromeProcess: null,
      chromeProfileName: 'superpowers-chrome',
      chromeUserDataDir: null,
    };
    const chromeHttp = async () => ({});
    const getTabs = async () => [];
    const newTab = async () => ({});
    return { ...attachChromeProcess({ state, chromeHttp, getTabs, newTab }), state };
  }

  it('getActivePort returns state.activePort', () => {
    const { getActivePort, state } = setup();
    state.activePort = 9333;
    assert.equal(getActivePort(), 9333);
  });

  it('getProfileName returns state.chromeProfileName', () => {
    const { getProfileName, state } = setup();
    state.chromeProfileName = 'custom';
    assert.equal(getProfileName(), 'custom');
  });

  it('setProfileName validates the name and updates state', () => {
    const { setProfileName, state } = setup();
    setProfileName('valid-name_2');
    assert.equal(state.chromeProfileName, 'valid-name_2');
    // chromeUserDataDir reset so next startChrome re-derives it.
    assert.equal(state.chromeUserDataDir, null);
  });

  it('setProfileName throws on invalid characters', () => {
    const { setProfileName } = setup();
    assert.throws(() => setProfileName('foo/bar'), /Invalid profile name/);
    assert.throws(() => setProfileName('../etc'), /Invalid profile name/);
  });

  it('setProfileName throws if chrome is running', () => {
    const { setProfileName, state } = setup();
    state.chromeProcess = { pid: 1234 };
    assert.throws(() => setProfileName('new'), /Cannot change profile while Chrome is running/);
  });

  it('getChromePid returns null when no process, pid when running', () => {
    const { getChromePid, state } = setup();
    assert.equal(getChromePid(), null);
    state.chromeProcess = { pid: 5678 };
    assert.equal(getChromePid(), 5678);
  });

  it('getBrowserMode reflects state', async () => {
    const { getBrowserMode, state } = setup();
    state.chromeHeadless = false;
    state.chromeProcess = { pid: 9999 };
    state.activePort = 9444;
    const mode = await getBrowserMode();
    assert.equal(mode.headless, false);
    assert.equal(mode.mode, 'headed');
    assert.equal(mode.running, true);
    assert.equal(mode.pid, 9999);
    assert.equal(mode.port, 9444);
  });
});
