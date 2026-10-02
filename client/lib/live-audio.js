// Live audio input: a microphone or line-in on the computer running the controller.
//
//   audio device -> AudioWorklet (real-time audio thread: band filters + onset detector)
//                -> MessagePort -> Worker (its own WebSocket) -> engine -> DMX frame at once
//
// The page's UI thread is not on that path; it only receives copies for its meters.

export function liveAudioSupport() {
  if (!window.isSecureContext) {
    return { ok: false, reason: 'Browsers only allow audio input on http://localhost (or HTTPS). Start live audio from the window on the controller computer.' };
  }
  if (!navigator.mediaDevices?.getUserMedia) return { ok: false, reason: 'This browser cannot open audio inputs.' };
  if (!window.AudioWorkletNode) return { ok: false, reason: 'This browser has no AudioWorklet. Use a current Chrome, Edge or Firefox.' };
  return { ok: true };
}

export class LiveAudioInput {
  constructor({ onChange, onError } = {}) {
    this.onChange = onChange || (() => {});
    this.onError = onError || (() => {});
    this.state = 'off'; // off | starting | on
    this.relay = 'closed'; // the worker's link to the engine
    this.deviceId = '';
    this.deviceLabel = '';
    this.sampleRate = 0;
    this.latency = null; // { input, block, total } in ms (estimate)
    this.levels = [0, 0, 0, 0];
    this.bpm = 0;
    this.hits = [0, 0, 0]; // performance.now() of the last hit per band
    this.lastMessage = 0;
    this.ctx = null;
    this.stream = null;
    this.node = null;
    this.worker = null;
  }

  async devices() {
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      return list.filter((d) => d.kind === 'audioinput').map((d, i) => ({ id: d.deviceId, label: d.label || (d.deviceId === 'default' ? 'Default input' : `Input ${i + 1}`) }));
    } catch {
      return [];
    }
  }

  async start(deviceId = '', sensitivity = null) {
    if (this.state !== 'off') return;
    const support = liveAudioSupport();
    if (!support.ok) throw new Error(support.reason);
    this.state = 'starting';
    this.onChange();
    try {
      // No echo cancellation, noise suppression or automatic gain: they smear and pump
      // exactly the transients the detector listens for.
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: { ideal: 2 },
          latency: { ideal: 0 },
        },
      });
      const track = this.stream.getAudioTracks()[0];
      const settings = track.getSettings?.() || {};
      this.deviceId = settings.deviceId || deviceId;
      this.deviceLabel = track.label || 'Audio input';
      track.addEventListener('ended', () => {
        this.onError('The audio input was disconnected.');
        this.stop();
      });

      const ctx = new AudioContext({ latencyHint: 'interactive' });
      this.ctx = ctx;
      await ctx.audioWorklet.addModule('/live-audio-worklet.js');
      const source = ctx.createMediaStreamSource(this.stream);
      const node = new AudioWorkletNode(ctx, 'live-audio', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: { sensitivity },
      });
      this.node = node;
      // The graph only runs if it reaches the speakers; a silent gain keeps it running
      // without playing the input back.
      const silent = ctx.createGain();
      silent.gain.value = 0;
      source.connect(node).connect(silent).connect(ctx.destination);

      const worker = new Worker('/live-audio-worker.js');
      this.worker = worker;
      const channel = new MessageChannel();
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      worker.postMessage({ connect: `${proto}://${location.host}/ws?view=audio`, port: channel.port2 }, [channel.port2]);
      node.port.postMessage({ relay: channel.port1 }, [channel.port1]);
      worker.onmessage = (e) => {
        const m = e.data || {};
        if (m.state) {
          this.relay = m.state;
          this.onChange();
        }
        if (m.error) this.onError(m.error);
      };
      node.port.onmessage = (e) => this.receive(e.data);
      await ctx.resume();

      this.sampleRate = ctx.sampleRate;
      const input = Number.isFinite(settings.latency) ? settings.latency * 1000 : null;
      const block = (128 / ctx.sampleRate) * 1000;
      this.latency = { input, block, total: (input ?? 10) + block };
      this.state = 'on';
      this.onChange();
    } catch (err) {
      this.stop();
      if (err.name === 'NotAllowedError') throw new Error('Microphone access was blocked. Allow it in the address bar, then try again.');
      if (err.name === 'NotFoundError' || err.name === 'OverconstrainedError') throw new Error('That audio input was not found. Pick another one.');
      throw err;
    }
  }

  receive(m) {
    const t = performance.now();
    this.lastMessage = t;
    if (m.on) for (const [band] of m.on) if (band >= 0 && band < 3) this.hits[band] = t;
    if (m.lv) this.levels = m.lv;
    if (Number.isFinite(m.bpm)) this.bpm = m.bpm;
  }

  setSensitivity(sensitivity) {
    this.node?.port.postMessage({ sensitivity });
  }

  stop() {
    try {
      this.node?.port.postMessage({ stop: true });
      this.node?.disconnect();
    } catch {}
    this.stream?.getTracks().forEach((t) => t.stop());
    this.worker?.postMessage({ close: true });
    this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.stream = null;
    this.node = null;
    this.worker = null;
    this.state = 'off';
    this.relay = 'closed';
    this.levels = [0, 0, 0, 0];
    this.bpm = 0;
    this.onChange();
  }
}
