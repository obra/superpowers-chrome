import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { makePageSessionFake } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const { attachScreencast } = require('../../skills/browsing/lib/screencast.js');

// 1x1 transparent PNG, reused as fake frame payload.
const FAKE_FRAME_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

function setup(sessionId = 'S-cast') {
  const ps = makePageSessionFake(
    { 'Page.startScreencast': () => ({}), 'Page.stopScreencast': () => ({}) },
    { sessionId }
  );
  const state = { screencasts: new Map(), sessionDir: null };
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'screencast-out-'));
  state.sessionDir = sessionDir;
  const getPageSession = async () => ps;
  const initializeSession = () => sessionDir;
  const api = attachScreencast({ state, getPageSession, initializeSession });
  return { ps, state, sessionDir, ...api };
}

function injectFrame(ps, { data = FAKE_FRAME_B64, frameSessionId = 1, timestamp } = {}) {
  ps.injectEvent({
    method: 'Page.screencastFrame',
    params: {
      data,
      sessionId: frameSessionId,
      metadata: timestamp !== undefined ? { timestamp } : {},
    },
  });
}

describe('screencast', () => {
  it('startScreencast enables Page domain and sends Page.startScreencast with options', async () => {
    const { ps, startScreencast } = setup();
    await startScreencast(0, { format: 'png', quality: 50, maxWidth: 640, maxHeight: 480, everyNthFrame: 2 });

    assert.ok(ps.calls.some(c => c.method === 'Page.enable'), 'Page.enable should be called');
    const startCall = ps.calls.find(c => c.method === 'Page.startScreencast');
    assert.ok(startCall, 'Page.startScreencast should be sent');
    assert.equal(startCall.params.format, 'png');
    assert.equal(startCall.params.quality, 50);
    assert.equal(startCall.params.maxWidth, 640);
    assert.equal(startCall.params.maxHeight, 480);
    assert.equal(startCall.params.everyNthFrame, 2);
  });

  it('defaults to jpeg with sensible quality/size when no options given', async () => {
    const { ps, startScreencast } = setup();
    await startScreencast(0);
    const startCall = ps.calls.find(c => c.method === 'Page.startScreencast');
    assert.equal(startCall.params.format, 'jpeg');
    assert.equal(startCall.params.quality, 80);
    assert.equal(startCall.params.maxWidth, 1280);
    assert.equal(startCall.params.maxHeight, 720);
    assert.equal(startCall.params.everyNthFrame, 1);
  });

  it('acks every screencast frame so Chrome keeps streaming', async () => {
    const { ps, startScreencast } = setup();
    await startScreencast(0);

    injectFrame(ps, { frameSessionId: 7 });
    injectFrame(ps, { frameSessionId: 8 });

    const acks = ps.calls.filter(c => c.method === 'Page.screencastFrameAck');
    assert.equal(acks.length, 2, 'each frame should be acked');
    assert.equal(acks[0].params.sessionId, 7);
    assert.equal(acks[1].params.sessionId, 8);
  });

  it('buffers frames to disk and reports them via screencast_status', async () => {
    const { ps, startScreencast, isScreencastRecording } = setup();
    const { framesDir } = await startScreencast(0);

    injectFrame(ps, { timestamp: 1 });
    injectFrame(ps, { timestamp: 2 });
    injectFrame(ps, { timestamp: 3 });

    const status = await isScreencastRecording(0);
    assert.equal(status.recording, true);
    assert.equal(status.frameCount, 3);

    const written = fs.readdirSync(framesDir).filter(f => f.startsWith('frame-'));
    assert.equal(written.length, 3, 'three frame files should be on disk');
    fs.rmSync(framesDir, { recursive: true, force: true });
  });

  it('screencast_status reports not-recording when nothing is active', async () => {
    const { isScreencastRecording } = setup();
    const status = await isScreencastRecording(0);
    assert.equal(status.recording, false);
  });

  it('refuses to start a second recording on the same tab', async () => {
    const { startScreencast } = setup();
    await startScreencast(0);
    await assert.rejects(() => startScreencast(0), /already recording/i);
  });

  it('stopScreencast without an active recording throws', async () => {
    const { stopScreencast } = setup();
    await assert.rejects(() => stopScreencast(0), /No screencast is recording/i);
  });

  it('stopScreencast sends Page.stopScreencast and clears state', async () => {
    const { ps, state, startScreencast, stopScreencast } = setup('S-clear');
    await startScreencast(0);
    injectFrame(ps, { timestamp: 1 });
    await stopScreencast(0, { keepFrames: true });
    assert.ok(ps.calls.some(c => c.method === 'Page.stopScreencast'), 'Page.stopScreencast sent');
    assert.equal(state.screencasts.has('S-clear'), false, 'recording removed from state');
  });

  it('stop with zero frames returns recorded:false with an explanatory message', async () => {
    const { startScreencast, stopScreencast } = setup();
    await startScreencast(0);
    const result = await stopScreencast(0);
    assert.equal(result.recorded, false);
    assert.equal(result.frameCount, 0);
    assert.match(result.message, /No frames/i);
  });

  it('stop with frames returns recorded:true with frameCount (mp4 or frames fallback)', async () => {
    const { ps, startScreencast, stopScreencast } = setup();
    await startScreencast(0);
    injectFrame(ps, { timestamp: 1 });
    injectFrame(ps, { timestamp: 2 });

    const result = await stopScreencast(0, { keepFrames: true });
    assert.equal(result.recorded, true);
    assert.equal(result.frameCount, 2);
    assert.ok(['mp4', 'frames'].includes(result.format), `unexpected format ${result.format}`);
    if (result.format === 'frames') {
      // ffmpeg not available in this environment — raw frames preserved.
      assert.ok(fs.existsSync(result.path), 'frames dir should exist');
    } else {
      // ffmpeg muxed an MP4; keepFrames means the source dir is reported too.
      assert.ok(fs.existsSync(result.path), 'mp4 output should exist');
      assert.ok(result.path.endsWith('.mp4'));
    }
  });

  it('auto-names the output in the session dir when no path is given', async () => {
    const { ps, sessionDir, startScreencast, stopScreencast } = setup();
    await startScreencast(0);
    injectFrame(ps, { timestamp: 1 });
    const result = await stopScreencast(0);
    if (result.format === 'mp4') {
      assert.equal(path.dirname(result.path), sessionDir);
      assert.match(path.basename(result.path), /^screencast-\d+\.mp4$/);
    }
  });

  it('ignores non-screencast events', async () => {
    const { ps, startScreencast, isScreencastRecording } = setup();
    await startScreencast(0);
    ps.injectEvent({ method: 'Page.loadEventFired', params: {} });
    ps.injectEvent({ method: 'Runtime.consoleAPICalled', params: { type: 'log', args: [] } });
    const status = await isScreencastRecording(0);
    assert.equal(status.frameCount, 0);
  });
});
