// Song playback in the browser (Web Audio). The window that plays the song is the clock master
// while it plays: the engine follows its audio position (see Session.handleSync).
//
// Audio is cached on the show machine by content hash, so a reload or another window can play
// it without picking the file again. It is never written into the show file.

export class AudioPlayer {
  constructor(store) {
    this.store = store;
    this.ctx = null;
    this.buffer = null;
    this.hash = null;
    this.name = '';
    this.source = null;
    this.startCtxTime = 0;
    this.startPos = 0;
    this.isPlaying = false;
    this.offsetMs = Number(localStorage.getItem('audioOffsetMs')) || 0;
    const v = Number(localStorage.getItem('audioVolume'));
    this.volume = Number.isFinite(v) && localStorage.getItem('audioVolume') !== null ? v : 1;
    this.finePeaks = null;
  }

  ensureContext() {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      this.gain = this.ctx.createGain();
      this.gain.gain.value = this.volume;
      this.gain.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    localStorage.setItem('audioVolume', String(this.volume));
    if (this.gain) this.gain.gain.value = this.volume;
  }

  async decode(arrayBuffer) {
    const ctx = this.ensureContext();
    try {
      return await ctx.decodeAudioData(arrayBuffer.slice(0));
    } catch {
      throw new Error('This browser cannot decode that audio file. Try MP3, WAV, AAC/M4A or FLAC.');
    }
  }

  async loadFile(file) {
    const data = await file.arrayBuffer();
    const [hash, buffer] = await Promise.all([sha256Hex(data), this.decode(data)]);
    this.set(buffer, hash, file.name);
    // Cache on the engine in the background; playback works without it.
    fetch(`/api/media/${hash}`, {
      method: 'PUT',
      body: data,
      headers: { 'Content-Type': file.type || 'audio/mpeg', 'X-File-Name': encodeURIComponent(file.name) },
    }).catch(() => {});
    return { hash, buffer };
  }

  async loadUrl(url, name) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Could not load ${name || url} (${res.status})`);
    const data = await res.arrayBuffer();
    const [hash, buffer] = await Promise.all([sha256Hex(data), this.decode(data)]);
    this.set(buffer, hash, name || url.split('/').pop());
    if (!url.startsWith('/api/media/')) {
      fetch(`/api/media/${hash}`, { method: 'PUT', body: data, headers: { 'Content-Type': res.headers.get('content-type') || 'audio/wav', 'X-File-Name': encodeURIComponent(name || '') } }).catch(() => {});
    }
    return { hash, buffer };
  }

  async loadCached(hash, name) {
    return this.loadUrl(`/api/media/${hash}`, name);
  }

  set(buffer, hash, name) {
    this.stop();
    this.buffer = buffer;
    this.hash = hash;
    this.name = name;
    this.finePeaks = null;
    this.store.emit('audio');
  }

  /** Raw channel data for analysis (copied so the worker can take ownership). */
  channelData() {
    const out = [];
    for (let c = 0; c < this.buffer.numberOfChannels; c++) out.push(this.buffer.getChannelData(c).slice());
    return out;
  }

  play(positionMs) {
    if (!this.buffer) return false;
    const ctx = this.ensureContext();
    this.stopSource();
    const offset = Math.max(0, positionMs / 1000);
    if (offset >= this.buffer.duration) return false;
    const src = ctx.createBufferSource();
    src.buffer = this.buffer;
    src.connect(this.gain);
    src.start(0, offset);
    this.source = src;
    this.startCtxTime = ctx.currentTime;
    this.startPos = positionMs;
    this.isPlaying = true;
    src.onended = () => {
      if (this.source === src) {
        this.isPlaying = false;
        this.source = null;
        this.store.emit('audio');
      }
    };
    return true;
  }

  stopSource() {
    if (this.source) {
      this.source.onended = null;
      try {
        this.source.stop();
      } catch {}
      this.source.disconnect();
      this.source = null;
    }
    this.isPlaying = false;
  }

  stop() {
    if (this.isPlaying) this.startPos = this.positionMs;
    this.stopSource();
  }

  /** Position of what is being heard: output latency removed, user offset applied. */
  get positionMs() {
    if (!this.isPlaying || !this.ctx) return this.startPos;
    const latency = (this.ctx.outputLatency || this.ctx.baseLatency || 0) * 1000;
    return this.startPos + (this.ctx.currentTime - this.startCtxTime) * 1000 - latency + this.offsetMs;
  }

  setOffset(ms) {
    this.offsetMs = ms;
    localStorage.setItem('audioOffsetMs', String(ms));
  }

  /** Min/max peaks at a fixed resolution for drawing zoomed-in waveforms. */
  peaks(perSecond = 200) {
    if (!this.buffer) return null;
    if (this.finePeaks?.perSecond === perSecond) return this.finePeaks;
    const data = this.buffer.getChannelData(0);
    const step = Math.max(1, Math.floor(this.buffer.sampleRate / perSecond));
    const n = Math.ceil(data.length / step);
    const values = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let m = 0;
      const end = Math.min(data.length, (i + 1) * step);
      for (let j = i * step; j < end; j += 4) {
        const v = data[j] < 0 ? -data[j] : data[j];
        if (v > m) m = v;
      }
      values[i] = m;
    }
    this.finePeaks = { perSecond, values };
    return this.finePeaks;
  }
}

// SHA-256 of the audio, used as its cache key. Web Crypto only exists in secure contexts
// (localhost, https); windows opened over plain http on the LAN use the fallback below.
async function sha256Hex(buffer) {
  if (globalThis.crypto?.subtle) {
    const d = await crypto.subtle.digest('SHA-256', buffer);
    return hex(new Uint8Array(d));
  }
  return hex(sha256Fallback(new Uint8Array(buffer)));
}

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256Fallback(msg) {
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const len = msg.length;
  const total = Math.ceil((len + 9) / 64) * 64;
  const data = new Uint8Array(total);
  data.set(msg);
  data[len] = 0x80;
  const view = new DataView(data.buffer);
  view.setUint32(total - 8, Math.floor((len * 8) / 2 ** 32));
  view.setUint32(total - 4, (len * 8) >>> 0);
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, h[i]);
  return out;
}

export { sha256Fallback as _sha256ForTests };
