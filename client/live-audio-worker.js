// Relays live-audio hits from the audio thread to the engine on a WebSocket of its own.
//
// The page's main thread can be busy for tens of milliseconds (3D view, timeline drawing,
// a garbage collection); this worker is not, so a hit leaves the browser as soon as the
// audio thread finds it. The engine sends it to the lights straight away.

let ws = null;
let url = '';
let closing = false;
let retry = 0;

self.onmessage = (e) => {
  const m = e.data || {};
  if (m.port) m.port.onmessage = (ev) => forward(ev.data);
  if (m.connect) {
    url = m.connect;
    open();
  }
  if (m.close) {
    closing = true;
    ws?.close();
    self.close();
  }
};

function open() {
  ws = new WebSocket(url);
  ws.onopen = () => {
    retry = 0;
    self.postMessage({ state: 'open' });
  };
  ws.onmessage = (e) => {
    if (typeof e.data !== 'string') return;
    try {
      const msg = JSON.parse(e.data);
      if (msg.t === 'error') self.postMessage({ error: msg.message });
    } catch {}
  };
  ws.onclose = () => {
    self.postMessage({ state: 'closed' });
    if (!closing) setTimeout(open, Math.min(5000, 300 * 2 ** retry++));
  };
  ws.onerror = () => {};
}

// Audio clock -> the computer's clock (epoch ms, as the engine counts). A message can only
// arrive after it happened, so the smallest gap between the two is the true offset (plus the
// shortest delivery time). The offset may also grow, but only as fast as a sound card's clock
// drifts from the computer's (1 ms a second is generous): a busy computer holding messages
// up for seconds must not drag the hits' times along with it.
let offset = null;
let offsetAt = 0;
let lastAudio = -Infinity;
function epochOf(audioMs) {
  if (!Number.isFinite(audioMs)) return undefined;
  const now = performance.timeOrigin + performance.now();
  const gap = now - audioMs;
  if (offset == null || audioMs < lastAudio - 1000) offset = gap; // first message, or a new clock
  else offset = Math.min(gap, offset + (now - offsetAt) * 0.001);
  offsetAt = now;
  lastAudio = audioMs;
  return Math.round((audioMs + offset) * 10) / 10;
}

function forward(d) {
  const at = epochOf(d.at);
  if (!ws || ws.readyState !== 1) return;
  // On a congested link, level updates can wait; hits always go.
  if (!d.on && ws.bufferedAmount > 8192) return;
  ws.send(JSON.stringify({ t: 'au', on: d.on, lv: d.lv, bpm: d.bpm, at }));
}
