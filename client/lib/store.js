// Client-side state: a mirror of the engine's show, transport and live controls.
//
// Edits are never applied locally first. A view calls store.op(); the engine applies it and
// broadcasts it; every window (this one included) applies the broadcast with the same shared
// applyOp(). That keeps all windows identical. On localhost the round trip is ~1 ms.
// Undo: the inverse returned by applyOp for this window's own ops is kept on a stack.

import { applyOp } from '/shared/ops.js';
import { createEvaluator } from '/shared/evaluate.js';
import { validateShow } from '/shared/validate.js';
import { applyProgrammer, emptyProgrammer, mergeSets, programmerHolds } from '/shared/programmer.js';
import { Connection } from './net.js';

/** How a window is named in the engine's list of connected windows. */
export const windowName = (view) => `${{ design: 'Edit', live: 'Live', visualizer: '3D view' }[view] || view} window`;

export class Store {
  constructor(viewName) {
    this.viewName = viewName;
    this.listeners = new Map();
    this.show = null;
    this.rev = 0;
    this.clientId = null;
    this.transport = { playing: false, position: 0, anchor: 0, master: null };
    this.live = { master: 1, blackout: false, flash: null, scenes: [], calibrate: null, audioReactive: false };
    // Manual control as the engine last confirmed it, this window's unconfirmed changes on top
    // of it, and the result (what this window shows and evaluates).
    this.programmer = emptyProgrammer();
    this.prog = { server: emptyProgrammer(), inflight: [], pending: null, timer: null, seq: 0 };
    // Live-audio levels and hits as the engine sees them (stamped on the engine clock).
    this.reactive = null;
    // The live-audio input, when this window is the one listening.
    this.liveAudio = null;
    this.outputs = null;
    this.status = null;
    this.clients = [];
    this.connection = 'connecting';
    this.undoStack = [];
    this.redoStack = [];
    this.pending = new Map();
    this.nextOpId = 1;
    this.ui = {
      tab: 'patch',
      selectedClips: new Set(),
      selectedFixtures: new Set(),
      snap: 1,
      follow: true,
    };
    this.audio = null;
    this.cache = { evaluator: null, validation: null };
    this.net = new Connection({
      onMessage: (m) => this.handle(m),
      onBinary: (b) => this.emit('binary', b),
      onStatus: (s, wasOpen) => {
        this.connection = s;
        if (s === 'closed') {
          for (const p of this.pending.values()) p.reject(new Error('Connection lost'));
          this.pending.clear();
        }
        this.emit('connection', { state: s, wasOpen });
      },
    });
  }

  on(evt, fn) {
    if (!this.listeners.has(evt)) this.listeners.set(evt, new Set());
    this.listeners.get(evt).add(fn);
    return () => this.listeners.get(evt).delete(fn);
  }

  emit(evt, payload) {
    for (const fn of this.listeners.get(evt) || []) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`listener for "${evt}" failed`, err);
      }
    }
  }

  connect() {
    this.net.connect();
  }

  handle(msg) {
    switch (msg.t) {
      case 'welcome':
        this.clientId = msg.clientId;
        this.show = msg.show;
        this.rev = msg.rev;
        this.transport = msg.transport;
        this.live = msg.live;
        this.prog = { server: msg.programmer || emptyProgrammer(), inflight: [], pending: null, timer: null, seq: this.prog.seq };
        this.rebuildProgrammer();
        this.reactive = msg.reactive || null;
        this.outputs = msg.outputs;
        this.status = msg.status;
        this.undoStack = [];
        this.redoStack = [];
        this.invalidate();
        this.net.send({ t: 'hello', name: windowName(this.viewName), view: this.viewName });
        this.emit('ready');
        this.emit('show', null);
        this.emit('transport');
        this.emit('live');
        this.emit('programmer');
        this.emit('reactive');
        this.emit('outputs');
        break;
      case 'op':
        this.applyRemote(msg);
        break;
      case 'ack': {
        const p = this.pending.get(msg.opId);
        if (p) {
          this.pending.delete(msg.opId);
          p.resolve(null);
        }
        break;
      }
      case 'nack': {
        const p = this.pending.get(msg.opId);
        if (p) {
          this.pending.delete(msg.opId);
          p.reject(new Error(msg.error));
        }
        this.emit('error', msg.error);
        break;
      }
      case 'transport':
        this.transport = msg.transport;
        this.emit('transport');
        break;
      case 'live':
        this.live = msg.live;
        this.emit('live');
        break;
      case 'programmer':
        this.prog.server = msg.programmer;
        if (msg.from === this.clientId && msg.seq != null) this.prog.inflight = this.prog.inflight.filter((e) => e.seq > msg.seq);
        this.rebuildProgrammer();
        this.emit('programmer');
        break;
      case 'reactive':
        this.reactive = msg.reactive;
        this.emit('reactive');
        break;
      case 'outputs':
        this.outputs = msg.outputs;
        this.cache.validation = null;
        this.emit('outputs');
        break;
      case 'status':
        this.status = msg.status;
        this.emit('status');
        break;
      case 'clients':
        this.clients = msg.clients;
        this.cache.validation = null;
        this.emit('clients');
        break;
      case 'error':
        this.emit('error', msg.message);
        break;
      default:
        break;
    }
  }

  applyRemote(msg) {
    let inverse;
    try {
      inverse = applyOp(this.show, msg.op);
    } catch (err) {
      // Should never happen: both sides run the same code. Recover with a full reload.
      console.error('Show out of sync, reloading from the engine', err);
      this.net.ws?.close();
      return;
    }
    if (msg.from === this.clientId) {
      const p = this.pending.get(msg.opId);
      if (p) {
        this.pending.delete(msg.opId);
        if (p.kind === 'undo') this.redoStack.push(inverse);
        else if (p.kind === 'redo') this.undoStack.push(inverse);
        else if (p.undoable) {
          this.undoStack.push(inverse);
          if (this.undoStack.length > 200) this.undoStack.shift();
          this.redoStack = [];
        }
        p.resolve(inverse);
      }
    }
    this.rev = msg.rev;
    this.invalidate();
    this.pruneSelection();
    this.emit('show', msg.op);
  }

  /** Send an edit to the engine. Resolves when it has been applied everywhere. */
  op(op, { undoable = true, kind = 'normal' } = {}) {
    if (!this.net.open) {
      this.emit('error', 'Not connected to the engine — the edit was not saved.');
      return Promise.reject(new Error('offline'));
    }
    const opId = this.nextOpId++;
    const done = new Promise((resolve, reject) => this.pending.set(opId, { resolve, reject, kind, undoable }));
    this.net.send({ t: 'op', opId, op, undo: kind === 'undo', redo: kind === 'redo' });
    done.catch(() => {});
    return done;
  }

  undo() {
    const inv = this.undoStack.pop();
    if (inv) this.op(inv, { kind: 'undo' });
    this.emit('history');
  }

  redo() {
    const inv = this.redoStack.pop();
    if (inv) this.op(inv, { kind: 'redo' });
    this.emit('history');
  }

  transportCmd(action, extra = {}) {
    this.net.send({ t: 'transport', action, ...extra });
  }

  setLive(changes) {
    this.net.send({ t: 'live', changes });
  }

  /** Everything the evaluator needs on top of the show; the same as the engine's liveContext(). */
  liveContext() {
    return { ...this.live, programmer: this.programmer, reactive: this.reactive };
  }

  // ---- Manual control --------------------------------------------------------------------

  /**
   * Fader and channel changes: { attrs: { fx: { dimmer: 0.5, pan: null } }, raw: { fx: { 3: 255 } } }
   * (null releases a value). Shown in this window at once and sent to the engine at most
   * ~30 times a second while a fader is being dragged.
   */
  setProgrammer(set) {
    this.prog.pending = mergeSets(this.prog.pending, set);
    this.rebuildProgrammer();
    this.emit('programmer');
    if (!this.prog.timer) this.prog.timer = setTimeout(() => this.flushProgrammer(), 33);
  }

  flushProgrammer() {
    clearTimeout(this.prog.timer);
    this.prog.timer = null;
    if (!this.prog.pending) return;
    const set = this.prog.pending;
    this.prog.pending = null;
    this.sendProgrammer({ set });
  }

  /** Hand fixtures back to the show: 'all', or a list of fixture ids. */
  clearProgrammer(fixtures = 'all') {
    this.flushProgrammer();
    this.sendProgrammer({ clear: fixtures === 'all' ? 'all' : { fixtures: [...fixtures] } });
    this.rebuildProgrammer();
    this.emit('programmer');
  }

  sendProgrammer(msg) {
    if (!this.net.open) return this.emit('error', 'Not connected to the engine.');
    const seq = ++this.prog.seq;
    this.prog.inflight.push({ seq, msg });
    this.net.send({ t: 'programmer', seq, ...msg });
  }

  /** The engine's confirmed state with this window's unconfirmed changes replayed on top. */
  rebuildProgrammer() {
    let p = this.prog.server;
    for (const e of this.prog.inflight) p = applyProgrammer(p, e.msg);
    if (this.prog.pending) p = applyProgrammer(p, { set: this.prog.pending });
    this.programmer = p;
  }

  programmerHolds(fixtureId = null) {
    return programmerHolds(this.programmer, fixtureId);
  }

  /** Scenes: 'go' | 'release' | 'toggle' | 'releaseAll'. */
  sceneCmd(action, id = null) {
    this.net.send({ t: 'scene', action, id });
  }

  setOutputs(config) {
    this.net.send({ t: 'outputs', config });
  }

  /** Current show position in ms, as this window should display it. */
  positionNow() {
    if (!this.show) return 0;
    if (this.audio?.isPlaying && this.transport.master === this.clientId) return this.audio.positionMs;
    const tr = this.transport;
    const p = tr.playing ? tr.position + (this.net.serverNow() - tr.anchor) : tr.position;
    return Math.max(0, Math.min(this.show.timeline.durationMs, p));
  }

  evaluator() {
    if (!this.cache.evaluator) this.cache.evaluator = createEvaluator(this.show);
    return this.cache.evaluator;
  }

  routedUniverses() {
    const set = new Set();
    for (const o of this.outputs?.outputs || []) if (o.enabled) o.universes.forEach((u) => set.add(u));
    for (const c of this.clients) if (c.usbUniverse) set.add(c.usbUniverse);
    return set;
  }

  validation() {
    if (!this.cache.validation) this.cache.validation = validateShow(this.show, { routedUniverses: this.routedUniverses() });
    return this.cache.validation;
  }

  invalidate() {
    this.cache.evaluator = null;
    this.cache.validation = null;
  }

  pruneSelection() {
    const clipIds = new Set(this.show.timeline.clips.map((c) => c.id));
    for (const id of this.ui.selectedClips) if (!clipIds.has(id)) this.ui.selectedClips.delete(id);
    const fxIds = new Set(this.show.fixtures.map((f) => f.id));
    for (const id of this.ui.selectedFixtures) if (!fxIds.has(id)) this.ui.selectedFixtures.delete(id);
  }

  selectClips(ids, additive = false) {
    if (!additive) this.ui.selectedClips.clear();
    for (const id of ids) this.ui.selectedClips.add(id);
    this.emit('selection');
  }

  selectFixtures(ids, additive = false) {
    if (!additive) this.ui.selectedFixtures.clear();
    for (const id of ids) this.ui.selectedFixtures.add(id);
    this.emit('selection');
  }
}
