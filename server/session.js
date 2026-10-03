// The engine's authoritative state: the show, the transport clock, the live controls and the
// connected browser windows. Clients send ops and commands; the session applies them and
// broadcasts the result so every window shows the same thing.

import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { randomBytes } from 'node:crypto';
import { createShow, normalizeShow, REACTIVE_BANDS } from '../shared/show.js';
import { applyProgrammer, emptyProgrammer } from '../shared/programmer.js';
import { createLiveTracker } from '../shared/analysis/live-tracker.js';
import { applyOp, isNoop } from '../shared/ops.js';

/** Monotonic milliseconds on the Unix epoch scale; the engine's single time base. */
export const now = () => performance.timeOrigin + performance.now();

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

function emptyReactive() {
  return {
    last: { low: null, mid: null, high: null },
    strength: { low: 0, mid: 0, high: 0 },
    count: { low: 0, mid: 0, high: 0 },
    env: { low: 0, mid: 0, high: 0, energy: 0 },
    bpm: 0,
    source: null,
    at: 0,
    // Live beat clock and song part for the auto show (shared/analysis/live-tracker.js).
    auto: null,
  };
}

export class Session {
  constructor({ dataDir, log }) {
    this.log = log;
    this.showsDir = path.join(dataDir, 'shows');
    this.autosaveFile = path.join(this.showsDir, 'autosave.json');
    this.show = this.loadAutosave() || createShow('Untitled show');
    this.rev = 0;
    this.transport = { playing: false, position: 0, anchor: now(), master: null };
    // scenes: active scenes [{ id, at, releasedAt }]; calibrate: Prime/Calibrate output or null;
    // audioReactive: whether live audio drives the lights.
    // autoShow: the live auto show replaces the timeline, following the live input.
    this.live = { master: 1, blackout: false, flash: null, scenes: [], calibrate: null, audioReactive: false, autoShow: false };
    this.flashOwner = null;
    // Manual faders (the "programmer"): fixture attributes and raw channel values that
    // override the show on the real lights until cleared. Live state, not saved in the show.
    this.programmer = emptyProgrammer();
    this.reactive = emptyReactive();
    this.tracker = createLiveTracker();
    this.reactiveDirty = false;
    this.clients = new Map();
    this.saveTimer = null;
    this.lastSyncBroadcast = 0;
    this.onShowChanged = null;
    this.onOutputsRequest = null;
    this.onAudioHit = null;
    this.getStatus = () => ({});
    this.getOutputsConfig = () => null;
  }

  /** Everything the evaluator needs on top of the show for one frame. */
  liveContext() {
    return { ...this.live, programmer: this.programmer, reactive: this.reactive };
  }

  // ---- Persistence ---------------------------------------------------------------------

  loadAutosave() {
    try {
      if (!fs.existsSync(this.autosaveFile)) return null;
      const show = normalizeShow(JSON.parse(fs.readFileSync(this.autosaveFile, 'utf8')));
      this.log.info(`Restored autosaved show "${show.meta.name}" (${show.fixtures.length} fixtures, ${show.timeline.clips.length} clips)`);
      return show;
    } catch (err) {
      const backup = this.autosaveFile.replace(/\.json$/, `.broken-${Date.now()}.json`);
      try {
        fs.renameSync(this.autosaveFile, backup);
      } catch {}
      this.log.warn(`Autosave could not be read (${err.message}); kept a copy at ${backup} and started a new show.`);
      return null;
    }
  }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 1500);
  }

  /**
   * Write the autosave. In the background by default: a slow disk (a folder synced to the
   * cloud, a virus scan of the new file) can take a few hundred milliseconds, and the DMX
   * frames must not wait for it. `sync` is for shutting down, when the write must finish.
   */
  saveNow({ sync = false } = {}) {
    clearTimeout(this.saveTimer);
    const data = JSON.stringify(this.show);
    const tmp = `${this.autosaveFile}.tmp`;
    if (sync) {
      try {
        fs.mkdirSync(this.showsDir, { recursive: true });
        fs.writeFileSync(tmp, data);
        fs.renameSync(tmp, this.autosaveFile);
      } catch (err) {
        this.log.error(`Autosave failed: ${err.message}`);
      }
      return;
    }
    // One write at a time, in order, so an older show never lands after a newer one.
    this.saving = (this.saving || Promise.resolve()).then(async () => {
      try {
        await fs.promises.mkdir(this.showsDir, { recursive: true });
        await fs.promises.writeFile(tmp, data);
        await fs.promises.rename(tmp, this.autosaveFile);
      } catch (err) {
        this.log.error(`Autosave failed: ${err.message}`);
      }
    });
  }

  // ---- Transport -----------------------------------------------------------------------

  positionAt(t = now()) {
    const tr = this.transport;
    return tr.playing ? tr.position + (t - tr.anchor) : tr.position;
  }

  setTransport(changes, t = now()) {
    const position = this.positionAt(t);
    this.transport = { ...this.transport, position, anchor: t, ...changes };
    this.broadcastTransport();
  }

  /** Called by the engine when playback runs off the end of the timeline. */
  reachedEnd(t) {
    this.setTransport({ playing: false, position: this.show.timeline.durationMs, master: null }, t);
  }

  transportMessage() {
    const { playing, position, anchor, master } = this.transport;
    return { t: 'transport', transport: { playing, position, anchor, master }, serverTime: now() };
  }

  broadcastTransport() {
    this.lastSyncBroadcast = now();
    this.broadcast(this.transportMessage());
  }

  handleTransport(client, msg) {
    const t = now();
    const duration = this.show.timeline.durationMs;
    const pos = this.positionAt(t);
    switch (msg.action) {
      case 'play': {
        const requested = Number(msg.position);
        const start = Number.isFinite(requested) ? clamp(requested, 0, duration) : pos >= duration ? 0 : pos;
        this.setTransport({ playing: true, position: start, master: msg.audioMaster ? client.id : null }, t);
        break;
      }
      case 'pause':
        this.setTransport({ playing: false, master: null }, t);
        break;
      case 'stop':
        this.setTransport({ playing: false, position: 0, master: null }, t);
        break;
      case 'seek': {
        const p = Number(msg.position);
        if (Number.isFinite(p)) this.setTransport({ position: clamp(p, 0, duration) }, t);
        break;
      }
      default:
        break;
    }
  }

  /**
   * A browser that plays the song is the clock master while it plays: it reports its audio
   * position a few times a second and the engine follows it, nudging small drift and jumping
   * on large differences (a seek, or audio output latency changes).
   */
  handleSync(client, msg) {
    if (this.transport.master !== client.id || !this.transport.playing) return;
    const p = Number(msg.position);
    if (!Number.isFinite(p)) return;
    const t = now();
    const drift = p - this.positionAt(t);
    if (Math.abs(drift) > 30) {
      this.transport.position = p;
      this.transport.anchor = t;
      this.broadcastTransport();
    } else if (Math.abs(drift) > 3) {
      this.transport.anchor -= drift * 0.5;
      if (t - this.lastSyncBroadcast > 1000) this.broadcastTransport();
    }
  }

  // ---- Live controls -------------------------------------------------------------------

  handleLive(client, msg) {
    const c = msg.changes && typeof msg.changes === 'object' ? msg.changes : {};
    if (typeof c.master === 'number' && Number.isFinite(c.master)) this.live.master = clamp(c.master, 0, 1);
    if (typeof c.blackout === 'boolean') this.live.blackout = c.blackout;
    if ('flash' in c) {
      this.live.flash = c.flash === 'blinder' || c.flash === 'strobe' ? c.flash : null;
      this.flashOwner = this.live.flash ? client.id : null;
    }
    if ('calibrate' in c) {
      const cal = c.calibrate;
      if (cal && typeof cal === 'object') {
        const fixtureId = typeof cal.fixtureId === 'string' && this.show.fixtures.some((f) => f.id === cal.fixtureId) ? cal.fixtureId : null;
        this.live.calibrate = { fixtureId, all: cal.all === true, othersOff: cal.othersOff !== false };
      } else {
        this.live.calibrate = null;
      }
    }
    if (typeof c.audioReactive === 'boolean') this.live.audioReactive = c.audioReactive;
    if (typeof c.autoShow === 'boolean') this.live.autoShow = c.autoShow;
    this.broadcast({ t: 'live', live: this.live });
  }

  // ---- Manual faders ("programmer") ----------------------------------------------------

  handleProgrammer(client, msg) {
    const known = new Set(this.show.fixtures.map((f) => f.id));
    this.programmer = applyProgrammer(this.programmer, msg, known);
    // `seq` lets the sending window tell which of its own fader moves are now confirmed.
    this.broadcast({ t: 'programmer', programmer: this.programmer, from: client.id, seq: finite(msg.seq) ? msg.seq : null });
  }

  // ---- Scenes --------------------------------------------------------------------------

  handleScene(client, msg) {
    const t = now();
    const scenes = this.live.scenes;
    switch (msg.action) {
      case 'go':
        if (!this.show.scenes.some((s) => s.id === msg.id)) return;
        this.live.scenes = [...scenes.filter((e) => e.id !== msg.id), { id: msg.id, at: t }];
        break;
      case 'release':
        this.live.scenes = scenes.map((e) => (e.id === msg.id && e.releasedAt == null ? { ...e, releasedAt: t } : e));
        break;
      case 'toggle': {
        const active = scenes.some((e) => e.id === msg.id && e.releasedAt == null);
        return this.handleScene(client, { ...msg, action: active ? 'release' : 'go' });
      }
      case 'releaseAll':
        this.live.scenes = scenes.map((e) => (e.releasedAt == null ? { ...e, releasedAt: t } : e));
        break;
      default:
        return;
    }
    this.cleanupScenes(t);
    this.broadcast({ t: 'live', live: this.live });
  }

  /** Forget scenes whose release fade has finished (or that were deleted). True if any went. */
  cleanupScenes(t = now()) {
    const before = this.live.scenes.length;
    this.live.scenes = this.live.scenes.filter((e) => {
      const scene = this.show.scenes.find((s) => s.id === e.id);
      if (!scene) return false;
      return e.releasedAt == null || t - e.releasedAt < (scene.fadeMs || 0);
    });
    return this.live.scenes.length !== before;
  }

  // ---- Live audio in -------------------------------------------------------------------

  /**
   * Hits and levels from the live-audio worker (the browser's real-time audio thread, relayed
   * by a worker thread, never the page's UI loop). Hits are stamped on arrival and trigger an
   * immediate DMX frame, so a kick reaches the lights without waiting for the next tick.
   */
  handleAudio(client, msg) {
    const r = this.reactive;
    const t = now();
    // One live input at a time: a second window listening too would double every hit.
    if (r.source && r.source !== client.id && t - r.at < 1500) {
      if (!client.audioRefused) {
        client.audioRefused = true;
        this.send(client, { t: 'error', message: 'Another window is already the live audio input. Stop it there first.' });
      }
      return;
    }
    client.audioRefused = false;
    // When the sound happened, as the input window's audio thread measured it: a busy
    // computer can hold a message up for a few hundred milliseconds, and stamping it on
    // arrival would put those hits off the beat. Windows that do not say use arrival time.
    const at = finite(msg.at) && msg.at <= t + 5 && msg.at >= t - 2000 ? Math.min(msg.at, t) : t;
    let hit = false;
    if (Array.isArray(msg.on)) {
      for (const e of msg.on.slice(0, 16)) {
        const band = Array.isArray(e) ? REACTIVE_BANDS[e[0]] : undefined;
        if (!band) continue;
        r.last[band] = at;
        r.strength[band] = finite(e[1]) ? clamp(e[1], 0, 1) : 1;
        r.count[band] = (r.count[band] + 1) % 1e9;
        this.tracker.hit(e[0], at);
        hit = true;
      }
    }
    if (Array.isArray(msg.lv) && msg.lv.length >= 4) {
      const [low, mid, high, energy] = msg.lv.map((v) => (finite(v) ? clamp(v, 0, 1) : 0));
      r.env = { low, mid, high, energy };
      this.tracker.levels(msg.lv, at);
    }
    if (finite(msg.bpm)) r.bpm = clamp(msg.bpm, 0, 300);
    r.source = client.id;
    r.at = t;
    if (hit) {
      this.tracker.update(t);
      r.auto = this.tracker.snapshot(t);
    }
    this.reactiveDirty = true;
    if (hit && (this.live.audioReactive || this.live.autoShow) && this.onAudioHit) this.onAudioHit(t);
  }

  /**
   * Called every frame: the song part can change with no hit at all (the kick stops, the
   * input goes quiet), so the tracker is advanced here too.
   */
  tickAuto(t = now()) {
    if (this.tracker.update(t) || (this.reactive.auto && this.reactive.auto.section !== this.tracker.section)) {
      this.reactive.auto = this.tracker.snapshot(t);
      this.reactiveDirty = true;
    }
  }

  /** The input went quiet (window closed, device unplugged): levels to zero, once. */
  expireAudio(t = now()) {
    const r = this.reactive;
    if (r.source && t - r.at > 1500) {
      r.source = null;
      r.env = { low: 0, mid: 0, high: 0, energy: 0 };
      r.bpm = 0;
      this.reactiveDirty = true;
    }
  }

  // ---- Clients -------------------------------------------------------------------------

  addClient(conn, req) {
    const id = randomBytes(4).toString('hex');
    // A window's live-audio worker connects with ?view=audio: it only sends hits and levels,
    // so it gets no copy of the show and no broadcasts.
    let audioOnly = false;
    try {
      audioOnly = new URL(req.url || '/', 'http://localhost').searchParams.get('view') === 'audio';
    } catch {}
    const client = { id, conn, name: audioOnly ? 'Live audio input' : 'Browser', view: audioOnly ? 'audio' : 'design', usbUniverse: null, address: req.socket.remoteAddress, lastSeen: now() };
    this.clients.set(id, client);
    conn.onmessage = (data, binary) => {
      client.lastSeen = now();
      if (binary) return;
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        return this.send(client, { t: 'error', message: 'Malformed message' });
      }
      try {
        this.handle(client, msg);
      } catch (err) {
        this.log.error(`Message ${msg?.t} from ${client.name}: ${err.stack || err.message}`);
        this.send(client, { t: 'error', message: err.message });
      }
    };
    conn.onclose = () => this.removeClient(client);
    if (audioOnly) {
      this.send(client, { t: 'welcome', clientId: id, audioOnly: true, serverTime: now() });
      return this.broadcastClients();
    }
    this.send(client, {
      t: 'welcome',
      clientId: id,
      rev: this.rev,
      show: this.show,
      transport: this.transportMessage().transport,
      live: this.live,
      programmer: this.programmer,
      reactive: this.reactive,
      outputs: this.getOutputsConfig(),
      status: this.getStatus(),
      serverTime: now(),
    });
    this.broadcastClients();
  }

  removeClient(client) {
    if (!this.clients.delete(client.id)) return;
    if (this.transport.master === client.id) this.transport.master = null;
    if (this.reactive.source === client.id) this.expireAudio(Infinity);
    // A flash button whose owner vanished (closed tab, dropped Wi-Fi) must not stay on.
    if (this.flashOwner === client.id) {
      this.live.flash = null;
      this.flashOwner = null;
      this.broadcast({ t: 'live', live: this.live });
    }
    this.broadcastClients();
  }

  handle(client, msg) {
    switch (msg?.t) {
      case 'hello':
        client.name = typeof msg.name === 'string' ? msg.name.slice(0, 40) : client.name;
        client.view = ['design', 'live', 'visualizer', 'audio'].includes(msg.view) ? msg.view : client.view;
        this.broadcastClients();
        break;
      case 'programmer':
        this.handleProgrammer(client, msg);
        break;
      case 'scene':
        this.handleScene(client, msg);
        break;
      case 'au':
        this.handleAudio(client, msg);
        break;
      case 'op':
        this.applyClientOp(client, msg);
        break;
      case 'transport':
        this.handleTransport(client, msg);
        break;
      case 'sync':
        this.handleSync(client, msg);
        break;
      case 'live':
        this.handleLive(client, msg);
        break;
      case 'outputs':
        if (this.onOutputsRequest) this.onOutputsRequest(msg.config, client);
        break;
      case 'ping':
        this.send(client, { t: 'pong', c: msg.c, s: now() });
        break;
      case 'usb': {
        const u = Number(msg.universe);
        client.usbUniverse = msg.attach && Number.isInteger(u) && u >= 1 && u <= 63999 ? u : null;
        this.log.info(client.usbUniverse ? `USB DMX bridge attached in ${client.name}: universe ${u}` : `USB DMX bridge detached in ${client.name}`);
        this.broadcastClients();
        break;
      }
      default:
        this.send(client, { t: 'error', message: `Unknown message "${msg?.t}"` });
    }
  }

  applyClientOp(client, msg) {
    let op = msg.op;
    try {
      const inverse = applyOp(this.show, op);
      if (isNoop(inverse)) {
        this.send(client, { t: 'ack', opId: msg.opId, rev: this.rev, noop: true });
        return;
      }
      // Normalizing a whole show may fill in defaults (dates); send everyone the canonical copy.
      if (op.type === 'show.replace') op = { type: 'show.replace', show: this.show };
      this.rev++;
      this.broadcast({ t: 'op', op, rev: this.rev, from: client.id, opId: msg.opId, undo: msg.undo === true, redo: msg.redo === true });
      if (this.transport.position > this.show.timeline.durationMs) this.setTransport({ position: this.show.timeline.durationMs });
      this.scheduleSave();
      if (this.onShowChanged) this.onShowChanged();
    } catch (err) {
      this.send(client, { t: 'nack', opId: msg.opId, error: err.message });
    }
  }

  // ---- Messaging -----------------------------------------------------------------------

  send(client, obj) {
    if (client.conn.open) client.conn.send(JSON.stringify(obj));
  }

  broadcast(obj) {
    const text = JSON.stringify(obj);
    // The live-audio worker only sends; keep its socket free of show traffic.
    for (const c of this.clients.values()) if (c.conn.open && c.view !== 'audio') c.conn.send(text);
  }

  clientList() {
    return [...this.clients.values()].map((c) => ({ id: c.id, name: c.name, view: c.view, usbUniverse: c.usbUniverse, address: c.address }));
  }

  broadcastClients() {
    this.broadcast({ t: 'clients', clients: this.clientList() });
  }
}
