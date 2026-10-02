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

function forward(d) {
  if (!ws || ws.readyState !== 1) return;
  // On a congested link, level updates can wait; hits always go.
  if (!d.on && ws.bufferedAmount > 8192) return;
  ws.send(JSON.stringify({ t: 'au', on: d.on, lv: d.lv, bpm: d.bpm }));
}
