// Live audio input, on the browser's real-time audio thread (AudioWorklet).
//
// Every 128-sample block (2.7 ms at 48 kHz) goes through the shared live detector. A hit is
// posted to the relay worker the moment it is found; levels and tempo follow ~50 times a
// second. Nothing here waits for the page's UI loop, which may be busy drawing.

import { createLiveDetector } from '/shared/analysis/live-detector.js';

class LiveAudioProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.det = createLiveDetector(sampleRate, { sensitivity: options?.processorOptions?.sensitivity });
    this.out = null; // MessagePort to the relay worker
    this.mono = new Float32Array(128);
    this.blocks = 0;
    this.lv = [0, 0, 0, 0];
    this.peak = [0, 0, 0, 0]; // highest level since the last report, so short hits show
    this.stopped = false;
    this.port.onmessage = (e) => {
      const m = e.data || {};
      if (m.relay) this.out = m.relay;
      if (m.sensitivity) this.det.setSensitivity(m.sensitivity);
      if (m.stop) this.stopped = true;
    };
  }

  process(inputs) {
    if (this.stopped) return false;
    const input = inputs[0];
    if (!input || !input.length || !input[0]) return true;
    let block = input[0];
    if (input.length > 1) {
      const n = block.length;
      if (this.mono.length !== n) this.mono = new Float32Array(n);
      const k = 1 / input.length;
      for (let i = 0; i < n; i++) {
        let s = 0;
        for (let c = 0; c < input.length; c++) s += input[c][i];
        this.mono[i] = s * k;
      }
      block = this.mono;
    }
    const events = this.det.process(block);
    const lv = this.det.levels(this.lv);
    for (let b = 0; b < 4; b++) if (lv[b] > this.peak[b]) this.peak[b] = lv[b];
    const withLevels = ++this.blocks % 7 === 0;
    if (!events.length && !withLevels) return true;
    const msg = {};
    if (events.length) msg.on = events.map((e) => [e.band, Math.round(e.strength * 100) / 100]);
    if (withLevels) {
      msg.lv = this.peak.map((v) => Math.round(v * 1000) / 1000);
      msg.bpm = this.det.bpm();
      this.peak.fill(0);
    }
    if (this.out) this.out.postMessage(msg);
    // The page gets the same for its own meters and to tell when the input is silent.
    this.port.postMessage(msg);
    return true;
  }
}

registerProcessor('live-audio', LiveAudioProcessor);
