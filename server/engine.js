// The output engine: evaluates the show at the transport position and sends DMX frames.
//
// Timing note (measured on Windows 11 with Node 24): timers fire on a 15.6 ms OS tick, so a
// plain setInterval(25) runs at ~32 Hz. The loop below schedules frames on an ideal grid and
// computes each frame from the real clock at the moment it is sent. Frame spacing therefore
// jitters by up to one OS tick, but the lights are always exactly where the music is and the
// average rate is the configured one. The DMX node re-transmits the latest frame on its own
// steady clock regardless.

import { performance } from 'node:perf_hooks';
import { createEvaluator } from '../shared/evaluate.js';
import { renderUniverses } from '../shared/dmx-render.js';
import { now } from './session.js';

export function startFrameLoop(hz, onFrame, log) {
  const period = 1000 / hz;
  let next = now() + period;
  let timer = null;
  let running = true;
  let lastError = 0;
  const tick = () => {
    if (!running) return;
    const t = now();
    if (t >= next) {
      try {
        onFrame(t);
      } catch (err) {
        // One bad frame must never stop the output; report at most every 5 s.
        if (t - lastError > 5000) {
          lastError = t;
          log?.error(`Frame error: ${err.stack || err.message}`);
        }
      }
      next += period;
      if (t - next > period * 4) next = t + period; // stalled (sleep, debugger): resync, don't burst
    }
    timer = setTimeout(tick, Math.max(0, next - now()));
  };
  timer = setTimeout(tick, period);
  return () => {
    running = false;
    clearTimeout(timer);
  };
}

export class Engine {
  constructor({ session, outputs, frameRate = 40, log }) {
    this.session = session;
    this.outputs = outputs;
    this.frameRate = frameRate;
    this.log = log;
    this.universes = new Map();
    this.evaluator = null;
    this.dirty = true;
    this.stats = { frames: 0, fps: 0, avgFrameMs: 0, maxFrameMs: 0, windowStart: now(), windowFrames: 0, windowWork: 0, windowMax: 0, hitFrames: 0, hitFps: 0 };
    session.onShowChanged = () => {
      this.dirty = true;
    };
    // A live-audio hit is sent out at once instead of waiting up to a whole frame period.
    // Even a regular frame sent a millisecond earlier did not include the hit, so none is
    // skipped; the detector's refractory times keep this to ~40 a second, and the cap only
    // guards against a misbehaving window flooding the network.
    session.onAudioHit = (t) => {
      if (this.stats.hitFrames >= 120) return;
      this.stats.hitFrames++;
      try {
        this.frame(t);
      } catch (err) {
        this.log?.error(`Hit frame error: ${err.message}`);
      }
    };
  }

  start() {
    this.stop?.();
    this.stop = startFrameLoop(this.frameRate, (t) => this.frame(t), this.log);
  }

  setFrameRate(hz) {
    if (hz === this.frameRate) return;
    this.frameRate = hz;
    this.start();
  }

  frame(t) {
    const t0 = performance.now();
    const s = this.session;
    if (this.dirty || !this.evaluator) {
      this.evaluator = createEvaluator(s.show);
      this.dirty = false;
    }
    const duration = s.show.timeline.durationMs;
    let pos = s.positionAt(t);
    if (s.transport.playing && pos >= duration) {
      s.reachedEnd(t);
      pos = duration;
    }
    if (s.cleanupScenes(t)) s.broadcast({ t: 'live', live: s.live });
    s.expireAudio(t);
    s.tickAuto(t);
    const states = this.evaluator.evaluate(pos, s.liveContext(), t);
    for (const u of this.outputs.routedUniverses()) if (!this.universes.has(u)) this.universes.set(u, new Uint8Array(512));
    for (const c of s.clients.values()) if (c.usbUniverse && !this.universes.has(c.usbUniverse)) this.universes.set(c.usbUniverse, new Uint8Array(512));
    renderUniverses(this.evaluator, states, t, this.universes);
    this.outputs.send(this.universes);
    this.sendUsbBridges();
    this.recordStats(t, performance.now() - t0);
  }

  /** Frames for browser windows driving a USB DMX interface over Web Serial. */
  sendUsbBridges() {
    for (const c of this.session.clients.values()) {
      if (!c.usbUniverse || !c.conn.open) continue;
      // A backgrounded or slow tab gets frames dropped rather than a growing backlog.
      if (c.conn.bufferedAmount > 64 * 1024) continue;
      const data = this.universes.get(c.usbUniverse);
      const msg = Buffer.alloc(3 + 512);
      msg[0] = 0x01;
      msg.writeUInt16BE(c.usbUniverse, 1);
      msg.set(data, 3);
      c.conn.send(msg);
    }
  }

  recordStats(t, workMs) {
    const st = this.stats;
    st.frames++;
    st.windowFrames++;
    st.windowWork += workMs;
    st.windowMax = Math.max(st.windowMax, workMs);
    const elapsed = t - st.windowStart;
    if (elapsed >= 1000) {
      st.fps = (st.windowFrames * 1000) / elapsed;
      st.avgFrameMs = st.windowWork / st.windowFrames;
      st.maxFrameMs = st.windowMax;
      st.hitFps = (st.hitFrames * 1000) / elapsed;
      st.windowStart = t;
      st.windowFrames = 0;
      st.windowWork = 0;
      st.windowMax = 0;
      st.hitFrames = 0;
    }
  }

  status() {
    return {
      frameRate: this.frameRate,
      fps: Math.round(this.stats.fps * 10) / 10,
      avgFrameMs: Math.round(this.stats.avgFrameMs * 100) / 100,
      maxFrameMs: Math.round(this.stats.maxFrameMs * 100) / 100,
      hitFps: Math.round(this.stats.hitFps * 10) / 10,
      fixtures: this.evaluator?.fixtures.length ?? 0,
      clips: this.evaluator?.clipCount ?? 0,
    };
  }
}
