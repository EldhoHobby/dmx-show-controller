// WebSocket link to the engine with automatic reconnect and clock synchronisation.
//
// Clock sync: ping/pong pairs give round-trip time and the engine's clock; the sample with the
// smallest round trip gives the best offset estimate (same idea as NTP). On localhost the
// offset is accurate to well under a millisecond; on Wi-Fi to a few milliseconds.

export const localNow = () => performance.timeOrigin + performance.now();

export class Connection {
  constructor({ onMessage, onBinary, onStatus }) {
    this.onMessage = onMessage;
    this.onBinary = onBinary;
    this.onStatus = onStatus;
    this.ws = null;
    this.open = false;
    this.retry = 0;
    this.samples = [];
    this.offset = 0;
    this.rtt = 0;
    this.pingTimer = null;
  }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.onStatus?.('connecting');
    ws.onopen = () => {
      this.open = true;
      this.retry = 0;
      this.samples = [];
      this.onStatus?.('open');
      // A burst of pings for a good first estimate, then one every 5 s.
      for (let i = 0; i < 5; i++) setTimeout(() => this.ping(), i * 120);
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => this.ping(), 5000);
    };
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return this.onBinary?.(e.data);
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.t === 'pong') return this.handlePong(msg);
      this.onMessage(msg);
    };
    ws.onclose = () => {
      const wasOpen = this.open;
      this.open = false;
      clearInterval(this.pingTimer);
      this.onStatus?.('closed', wasOpen);
      const delay = Math.min(5000, 400 * 2 ** this.retry++);
      setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => {};
  }

  send(obj) {
    if (!this.open) return false;
    this.ws.send(JSON.stringify(obj));
    return true;
  }

  ping() {
    this.send({ t: 'ping', c: localNow() });
  }

  handlePong(msg) {
    const t = localNow();
    const rtt = t - msg.c;
    if (!(rtt >= 0) || rtt > 5000) return;
    this.samples.push({ rtt, offset: msg.s + rtt / 2 - t });
    if (this.samples.length > 8) this.samples.shift();
    const best = this.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
    this.offset = best.offset;
    this.rtt = best.rtt;
  }

  /** The engine's clock, estimated locally. */
  serverNow() {
    return localNow() + this.offset;
  }
}
