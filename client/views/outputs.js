// Outputs: where DMX goes. This is venue setup stored on the show computer, not in the show.

import { h, mount, select, numberInput, textInput, icon, toast } from '../lib/dom.js';
import { UsbBridge } from '../lib/usb.js';

const parseUniverses = (text) =>
  String(text)
    .split(/[\s,;]+/)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 63999);

export class OutputsView {
  constructor(app) {
    this.app = app;
    this.store = app.store;
    this.usb = app.usb;
    this.el = h('div', { class: 'outputs' });
    this.draft = null;
    this.interfaces = [];
    this.rates = new Map();
    this.usbUniverse = 1;
    this.store.on('outputs', () => {
      // The engine broadcasts this to every window whenever any of them applies. Replacing
      // an edited draft would throw away work the operator has not applied yet, with no
      // warning and no way back, so unapplied changes are kept and flagged instead.
      if (this.dirty) {
        this.conflict = true;
        this.render();
        return;
      }
      this.conflict = false;
      this.draft = structuredClone(this.store.outputs);
      this.render();
    });
    this.store.on('status', () => this.updateStatus());
    this.store.on('clients', () => this.updateStatus());
    this.store.on('usb', () => this.render());
    fetch('/api/info')
      .then((r) => r.json())
      .then((info) => {
        this.interfaces = info.interfaces || [];
        this.info = info;
        this.render();
      })
      .catch(() => {});
  }

  get dirty() {
    return JSON.stringify(this.draft) !== JSON.stringify(this.store.outputs);
  }

  render() {
    if (!this.store.outputs) return;
    if (!this.draft) this.draft = structuredClone(this.store.outputs);
    const d = this.draft;
    const sacn = d.outputs.find((o) => o.type === 'sacn');
    const artnet = d.outputs.find((o) => o.type === 'artnet');
    const changed = () => this.render();
    mount(
      this.el,
      h('div', { class: 'card' },
        h('div', { class: 'row', style: { marginBottom: '10px' } },
          h('h2', { class: 'grow' }, 'DMX outputs'),
          h('span', { class: 'muted' }, 'Frame rate'),
          select([[25, '25 Hz'], [30, '30 Hz'], [40, '40 Hz'], [44, '44 Hz']], d.frameRate, (v) => ((d.frameRate = v), changed())),
        ),
        sacn ? this.sacnCard(sacn, changed) : null,
        artnet ? this.artnetCard(artnet, changed) : null,
        this.usbCard(),
        this.conflict
          ? h('p', { class: 'notice warn' },
              'Another window changed the output settings while you were editing. Your changes are still here — ',
              'Apply to use them, or Revert to take the other window’s.')
          : null,
        h('div', { class: 'row', style: { justifyContent: 'flex-end', marginTop: '12px' } },
          h('button', { class: 'btn ghost', disabled: !this.dirty, onclick: () => ((this.draft = structuredClone(this.store.outputs)), (this.conflict = false), changed()) }, 'Revert'),
          h('button', { class: 'btn primary', disabled: !this.dirty, onclick: () => this.apply() }, 'Apply'),
        ),
      ),
      this.an2Card(),
      h('div', { class: 'card' }, h('h2', {}, 'Engine'), h('div', { class: 'stack', dataset: { status: 'engine' } })),
    );
    this.updateStatus();
  }

  apply() {
    this.conflict = false;
    this.store.setOutputs(this.draft);
    toast('Output settings sent to the engine.', 'ok');
  }

  interfaceSelect(o, changed) {
    const opts = [['', 'Automatic (operating system decides)'], ...this.interfaces.map((i) => [i.address, `${i.address} — ${i.name}`])];
    if (o.interface && !this.interfaces.some((i) => i.address === o.interface)) opts.push([o.interface, `${o.interface} (not present now)`]);
    return select(opts, o.interface, (v) => ((o.interface = v), changed()));
  }

  sacnCard(o, changed) {
    return h('div', { class: 'card', style: { background: 'var(--panel-2)' } },
      h('div', { class: 'row' },
        h('input', { type: 'checkbox', checked: o.enabled, onchange: (e) => ((o.enabled = e.target.checked), changed()) }),
        h('h2', { class: 'grow' }, 'sACN (E1.31)'),
        h('span', { class: 'muted', dataset: { status: o.id } }),
      ),
      h('div', { class: 'stack', style: { marginTop: '8px' } },
        h('label', { class: 'field' }, h('span', {}, 'Universes'), textInput(o.universes.join(', '), (v) => ((o.universes = parseUniverses(v)), changed()), { placeholder: '1, 2' })),
        h('label', { class: 'field' }, h('span', {}, 'Send by'), select([['multicast', 'Multicast (standard, no node IP needed)'], ['unicast', 'Unicast to one node']], o.mode, (v) => ((o.mode = v), changed()))),
        o.mode === 'unicast' ? h('label', { class: 'field' }, h('span', {}, 'Node IP'), textInput(o.unicast, (v) => ((o.unicast = v.trim()), changed()), { placeholder: 'e.g. 10.20.0.2' })) : null,
        h('label', { class: 'field' }, h('span', {}, 'Network adapter'), this.interfaceSelect(o, changed)),
        h('label', { class: 'field' }, h('span', {}, 'Priority'), numberInput(o.priority, (v) => ((o.priority = Math.round(v)), changed()), { min: 0, max: 200 })),
        o.mode === 'multicast' && !o.interface && this.interfaces.length > 1
          ? h('div', { class: 'note warn' }, 'This computer has more than one network adapter. Choose the one the DMX node is plugged into, or multicast may leave through Wi-Fi instead.')
          : null,
      ),
    );
  }

  artnetCard(o, changed) {
    return h('div', { class: 'card', style: { background: 'var(--panel-2)' } },
      h('div', { class: 'row' },
        h('input', { type: 'checkbox', checked: o.enabled, onchange: (e) => ((o.enabled = e.target.checked), changed()) }),
        h('h2', { class: 'grow' }, 'Art-Net'),
        h('span', { class: 'muted', dataset: { status: o.id } }),
      ),
      h('div', { class: 'stack', style: { marginTop: '8px' } },
        h('label', { class: 'field' }, h('span', {}, 'Universes'), textInput(o.universes.join(', '), (v) => ((o.universes = parseUniverses(v)), changed()), { placeholder: '1, 2' })),
        h('label', { class: 'field' }, h('span', {}, 'Send to'), textInput(o.host, (v) => ((o.host = v.trim()), changed()), { placeholder: '2.255.255.255 or the node IP' })),
        h('label', { class: 'field' }, h('span', {}, 'Numbering'), select([[-1, 'Universe 1 here = Art-Net universe 0 (most nodes)'], [0, 'Universe 1 here = Art-Net universe 1']], o.universeOffset, (v) => ((o.universeOffset = v), changed()))),
        h('label', { class: 'field' }, h('span', {}, 'Network adapter'), this.interfaceSelect(o, changed)),
      ),
    );
  }

  usbCard() {
    const usb = this.usb;
    if (!UsbBridge.supported()) {
      return h('div', { class: 'card', style: { background: 'var(--panel-2)' } },
        h('h2', {}, 'USB DMX interface'),
        h('p', { class: 'muted', style: { margin: 0 } }, UsbBridge.unsupportedReason()));
    }
    return h('div', { class: 'card', style: { background: 'var(--panel-2)' } },
      h('div', { class: 'row' }, h('h2', { class: 'grow' }, 'USB DMX interface (Enttec DMX USB Pro or compatible)'), h('span', { class: 'muted', dataset: { status: 'usb' } })),
      h('p', { class: 'muted' }, 'Sends one universe through this browser window. Keep this window open during the show (it can be in the background).'),
      usb.connected
        ? h('div', { class: 'row' }, h('span', {}, `Connected — universe ${usb.universe}`), h('button', { class: 'btn', onclick: () => usb.disconnect() }, 'Disconnect'))
        : h('div', { class: 'row' },
            h('span', { class: 'muted' }, 'Universe'),
            numberInput(this.usbUniverse, (v) => (this.usbUniverse = Math.max(1, Math.round(v))), { min: 1, max: 63999 }),
            h('button', { class: 'btn', onclick: async () => {
              try {
                await usb.connect(this.usbUniverse);
                toast('USB DMX interface connected.', 'ok');
              } catch (err) {
                if (err.name !== 'NotFoundError') toast(err.message, 'error', 7000);
              }
            } }, icon('dmx', 14), 'Connect interface'),
          ),
      usb.error ? h('div', { class: 'note warn', style: { marginTop: '8px' } }, usb.error) : null,
    );
  }

  an2Card() {
    return h('div', { class: 'card' },
      h('div', { class: 'row', style: { marginBottom: '8px' } },
        h('h2', { class: 'grow' }, 'Chauvet DJ DMX-AN2 setup'),
        h('button', { class: 'btn', onclick: () => this.applyAn2Preset() }, 'Use DMX-AN2 settings'),
      ),
      h('ol', { class: 'muted', style: { margin: 0, paddingLeft: '18px', lineHeight: 1.7 } },
        h('li', {}, 'Connect the node to this computer’s Ethernet port (or a switch). It can be powered over PoE or by its 9 V adapter.'),
        h('li', {}, 'Give this computer’s Ethernet adapter the address 2.0.0.2, subnet mask 255.0.0.0 (the node ships as 2.0.0.1).'),
        h('li', {}, 'Open http://2.0.0.1 in a browser to reach the node’s settings page.'),
        h('li', {}, 'Set Port A to sACN universe 1 and Port B to sACN universe 2, both as Output, 40 Hz.'),
        h('li', {}, 'Click “Use DMX-AN2 settings” above, choose the Ethernet adapter, then Apply.'),
      ),
    );
  }

  applyAn2Preset() {
    const d = this.draft;
    for (const o of d.outputs) {
      if (o.type === 'sacn') Object.assign(o, { enabled: true, universes: [1, 2], mode: 'multicast' });
      if (o.type === 'artnet') o.enabled = false;
    }
    const ether = this.interfaces.find((i) => i.address.startsWith('2.'));
    const sacn = d.outputs.find((o) => o.type === 'sacn');
    if (ether && sacn) sacn.interface = ether.address;
    d.frameRate = 40;
    this.render();
    toast(ether ? `Using adapter ${ether.address}. Click Apply.` : 'Preset filled in. Choose the Ethernet adapter, then click Apply.', 'ok', 6000);
  }

  updateStatus() {
    const status = this.store.status;
    if (!status || !this.el.isConnected) return;
    const now = performance.now();
    for (const o of status.outputs || []) {
      const el = this.el.querySelector(`[data-status="${o.id}"]`);
      const prev = this.rates.get(o.id);
      this.rates.set(o.id, { packets: o.packets, at: now });
      const rate = prev ? ((o.packets - prev.packets) * 1000) / (now - prev.at) : null;
      if (el) el.textContent = o.ready ? `${o.target} · ${rate == null ? '…' : Math.round(rate)} packets/s${o.errors ? ` · ${o.errors} errors (${o.lastError})` : ''}` : `not running: ${o.lastError || 'starting'}`;
    }
    const usbEl = this.el.querySelector('[data-status="usb"]');
    if (usbEl && this.usb.connected) usbEl.textContent = `${this.usb.frames} frames sent${this.usb.dropped ? `, ${this.usb.dropped} skipped` : ''}`;
    const eng = this.el.querySelector('[data-status="engine"]');
    if (eng && status.engine) {
      const e = status.engine;
      mount(eng,
        this.info ? h('div', {}, h('strong', {}, `DMX Show Controller ${this.info.version}`), h('span', { class: 'muted' }, ` · Node ${this.info.node}`)) : null,
        h('div', {}, `Output rate ${e.fps} frames/s (target ${e.frameRate}) · frame work ${e.avgFrameMs} ms avg, ${e.maxFrameMs} ms max`),
        h('div', { class: 'muted' }, `${e.fixtures} fixtures, ${e.clips} active clips in the engine`),
        h('div', { class: 'muted' }, `Connected windows: ${this.store.clients.map((c) => `${c.name}${c.usbUniverse ? ` (USB U${c.usbUniverse})` : ''}`).join(', ') || 'none'}`),
        this.info?.lan?.length ? h('div', { class: 'muted' }, `Other devices can open: ${this.info.lan.join('  ')}`) : h('div', { class: 'muted' }, 'Only this computer can open the app (start with --host 0.0.0.0 to allow tablets on the network).'),
      );
    }
  }
}
