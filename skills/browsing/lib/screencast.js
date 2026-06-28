const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, execSync } = require('child_process');

/**
 * Page screencast capture — records a tab as a video.
 *
 * CDP has no "record to a video file" command. `Page.startScreencast` streams
 * individual base64-encoded JPEG/PNG frames via `Page.screencastFrame` events;
 * Chrome stops sending once a few un-acked frames pile up, so every frame must
 * be acked with `Page.screencastFrameAck`. Turning the frame stream into a
 * video is the client's job.
 *
 * This mirrors `console-logging.js`: we subscribe to a CDP event stream on the
 * long-lived bridge pageSession and buffer the results keyed by `sessionId`.
 * Because the MCP server caches one pageSession per tab for its whole lifetime,
 * the listener registered by `startScreencast` is still live when a later
 * `stopScreencast` tool call arrives — the two calls share in-process state.
 * (The CLI spawns a fresh process per command, so a CLI screencast cannot span
 * two invocations; the MCP is the supported path.)
 *
 * Frames are written to disk as they arrive (one file each, zero-padded index)
 * rather than held in memory, so a long recording doesn't balloon RSS. We keep
 * only a small metadata array — index + frame timestamp — in memory, used to
 * compute per-frame durations at assembly time.
 *
 * On stop, if `ffmpeg` is on PATH we mux the frames into an MP4 using the
 * concat demuxer with per-frame durations derived from each frame's
 * `metadata.timestamp`, preserving real (variable) timing. If ffmpeg is
 * missing we leave the numbered frames in place and report the directory —
 * the same best-effort, no-hard-dependency stance `screenshot.js` takes with
 * sips/ImageMagick downscaling.
 *
 * `attachScreencast({ state, getPageSession, initializeSession })` returns the
 * bound API. `initializeSession` is the lazy session-dir thunk (same one
 * screenshot.js receives); it is called to resolve relative/auto output paths.
 */
function attachScreencast({ state, getPageSession, initializeSession }) {
  /**
   * Resolve a user-supplied output filename to an absolute path.
   * Mirrors screenshot.js: absolute → as-is, relative → joined with the
   * session dir, falsy → auto-generated timestamped name in the session dir.
   */
  function resolveOutputPath(filename, extension) {
    if (!filename) {
      const dir = initializeSession ? initializeSession() : (state && state.sessionDir) || process.cwd();
      return path.join(dir, `screencast-${Date.now()}.${extension}`);
    }
    if (path.isAbsolute(filename)) return filename;
    let dir;
    if (initializeSession) {
      dir = initializeSession();
    } else if (state && state.sessionDir) {
      dir = state.sessionDir;
    } else {
      return path.resolve(filename);
    }
    return path.join(dir, filename);
  }

  function hasFfmpeg() {
    try {
      execSync('ffmpeg -version', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Assemble captured frames into an MP4 via ffmpeg's concat demuxer.
   *
   * Each entry's display duration is the gap to the next frame's timestamp, so
   * variable frame intervals are preserved. The last frame has no "next" gap,
   * so it gets the average of the others (falling back to 0.1s). ffmpeg's
   * concat demuxer ignores the duration after the final `file` line, so we
   * repeat the last file to give it a real on-screen duration.
   *
   * yuv420p requires even dimensions; the pad filter rounds odd width/height up
   * by one pixel so the encode never fails on an off-by-one frame size.
   *
   * Returns true on success, false if ffmpeg exited non-zero (caller then
   * falls back to reporting the raw frames).
   */
  function assembleMp4(frames, framesDir, outputPath) {
    const durations = [];
    for (let i = 0; i < frames.length - 1; i++) {
      const d = frames[i + 1].timestamp - frames[i].timestamp;
      // Guard against non-monotonic / missing timestamps.
      durations.push(d > 0 && Number.isFinite(d) ? d : 0.1);
    }
    const avg = durations.length
      ? durations.reduce((a, b) => a + b, 0) / durations.length
      : 0.1;
    const lastDuration = Number.isFinite(avg) && avg > 0 ? avg : 0.1;

    const lines = [];
    for (let i = 0; i < frames.length; i++) {
      lines.push(`file '${frames[i].file}'`);
      lines.push(`duration ${(i < durations.length ? durations[i] : lastDuration).toFixed(4)}`);
    }
    // Repeat the final frame so its duration is honored by the concat demuxer.
    lines.push(`file '${frames[frames.length - 1].file}'`);

    const listPath = path.join(framesDir, 'frames.txt');
    fs.writeFileSync(listPath, lines.join('\n'));

    try {
      execFileSync(
        'ffmpeg',
        [
          '-y',
          '-f', 'concat',
          '-safe', '0',
          '-i', listPath,
          '-vsync', 'vfr',
          '-pix_fmt', 'yuv420p',
          '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2',
          outputPath,
        ],
        { stdio: 'ignore' }
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Start recording the tab. Subscribes to Page.screencastFrame, writing each
   * frame to a fresh frames directory and acking it so Chrome keeps streaming.
   *
   * options:
   *   - format: 'jpeg' (default) | 'png'
   *   - quality: 0-100 JPEG quality (default 80; ignored for png)
   *   - maxWidth / maxHeight: frame cap in px (default 1280 / 720)
   *   - everyNthFrame: send every Nth frame (default 1)
   */
  async function startScreencast(tabIndexOrWsUrl, options = {}) {
    const ps = await getPageSession(tabIndexOrWsUrl);

    if (state.screencasts.has(ps.sessionId)) {
      throw new Error('Screencast already recording for this tab. Call stop_screencast first.');
    }

    const format = options.format === 'png' ? 'png' : 'jpeg';
    const quality = typeof options.quality === 'number' ? options.quality : 80;
    const maxWidth = typeof options.maxWidth === 'number' ? options.maxWidth : 1280;
    const maxHeight = typeof options.maxHeight === 'number' ? options.maxHeight : 720;
    const everyNthFrame = typeof options.everyNthFrame === 'number' ? options.everyNthFrame : 1;

    const framesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'superpowers-screencast-'));
    const ext = format === 'png' ? 'png' : 'jpg';

    const recording = {
      framesDir,
      ext,
      format,
      frames: [],            // { file, timestamp }
      startedAt: Date.now(),
      frameCount: 0,
      unsubscribe: null,
    };

    await ps.enableDomain('Page');

    const unsubscribe = ps.onEvent((msg) => {
      if (msg.method !== 'Page.screencastFrame') return;
      const params = msg.params || {};
      // Ack first (best-effort) so Chrome keeps streaming even if a write fails.
      // params.sessionId here is the screencast frame id, distinct from the CDP
      // session id that ps.send envelopes with.
      ps.send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});

      if (!params.data) return;
      const idx = recording.frameCount++;
      const file = `frame-${String(idx).padStart(6, '0')}.${ext}`;
      try {
        fs.writeFileSync(path.join(framesDir, file), Buffer.from(params.data, 'base64'));
        const ts = params.metadata && typeof params.metadata.timestamp === 'number'
          ? params.metadata.timestamp
          : Date.now() / 1000;
        recording.frames.push({ file, timestamp: ts });
      } catch {
        // Drop the frame rather than tear down the recording.
      }
    });
    recording.unsubscribe = unsubscribe;

    state.screencasts.set(ps.sessionId, recording);

    await ps.send('Page.startScreencast', {
      format,
      quality,
      maxWidth,
      maxHeight,
      everyNthFrame,
    });

    return {
      recording: true,
      framesDir,
      format,
    };
  }

  /**
   * Stop recording and assemble the captured frames.
   *
   * options:
   *   - path: output file path (absolute → as-is, relative → session dir,
   *           omitted → auto-named in session dir).
   *   - keepFrames: when true, the raw frame directory is left on disk even
   *     after a successful mux (default false — frames are cleaned up).
   *
   * Returns a structured result describing what was produced.
   */
  async function stopScreencast(tabIndexOrWsUrl, options = {}) {
    const ps = await getPageSession(tabIndexOrWsUrl);
    const recording = state.screencasts.get(ps.sessionId);
    if (!recording) {
      throw new Error('No screencast is recording for this tab. Call start_screencast first.');
    }

    // Detach from state immediately so a failure below can't leave a zombie.
    state.screencasts.delete(ps.sessionId);

    try {
      await ps.send('Page.stopScreencast');
    } catch {
      // Page may be gone; we still have whatever frames arrived.
    }
    if (recording.unsubscribe) recording.unsubscribe();

    const durationMs = Date.now() - recording.startedAt;
    const frameCount = recording.frames.length;

    if (frameCount === 0) {
      try { fs.rmSync(recording.framesDir, { recursive: true, force: true }); } catch {}
      return {
        recorded: false,
        frameCount: 0,
        durationMs,
        message: 'No frames were captured. The tab may have been backgrounded or hidden — screencast only captures a visible surface.',
      };
    }

    const ffmpegAvailable = hasFfmpeg();
    const outputPath = resolveOutputPath(options.path, 'mp4');

    if (ffmpegAvailable && assembleMp4(recording.frames, recording.framesDir, outputPath)) {
      if (!options.keepFrames) {
        try { fs.rmSync(recording.framesDir, { recursive: true, force: true }); } catch {}
      }
      return {
        recorded: true,
        format: 'mp4',
        path: outputPath,
        frameCount,
        durationMs,
        framesDir: options.keepFrames ? recording.framesDir : undefined,
      };
    }

    // Fallback: ffmpeg missing or muxing failed — leave the frames on disk.
    return {
      recorded: true,
      format: 'frames',
      path: recording.framesDir,
      frameCount,
      durationMs,
      ffmpegAvailable,
      message: ffmpegAvailable
        ? `ffmpeg failed to assemble the video; ${frameCount} raw ${recording.ext} frames are in ${recording.framesDir}.`
        : `ffmpeg is not installed; ${frameCount} raw ${recording.ext} frames are in ${recording.framesDir}. Install ffmpeg to get an MP4, or assemble them yourself.`,
    };
  }

  /**
   * Report whether a screencast is currently recording for the tab, and if so
   * how many frames have been captured so far.
   */
  async function isScreencastRecording(tabIndexOrWsUrl) {
    const ps = await getPageSession(tabIndexOrWsUrl);
    const recording = state.screencasts.get(ps.sessionId);
    if (!recording) return { recording: false };
    return {
      recording: true,
      frameCount: recording.frames.length,
      format: recording.format,
      elapsedMs: Date.now() - recording.startedAt,
    };
  }

  return { startScreencast, stopScreencast, isScreencastRecording };
}

module.exports = { attachScreencast };
