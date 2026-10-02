// App shell: modes (Edit / Live / Visualizer window), transport, keyboard, files.
// (Edit mode is called 'design' internally and in saved settings.)

import { Store, windowName } from './lib/store.js';
import { AudioPlayer } from './lib/audio.js';
import { UsbBridge } from './lib/usb.js';
import { h, mount, icon, toast, dialog, confirmDialog, pickFile, downloadText, textInput } from './lib/dom.js';
import { PatchView } from './views/patch.js';
import { SongView } from './views/song.js';
import { TimelineView } from './views/timeline.js';
import { OutputsView } from './views/outputs.js';
import { Inspector } from './views/inspector.js';
import { Visualizer } from './views/visualizer.js';
import { LiveView } from './views/live.js';
import { ControlView } from './views/control.js';
import { CalibrateView } from './views/calibrate.js';
import { LiveAudioInput } from './lib/live-audio.js';
import { createShow, exportShow, normalizeShow } from '/shared/show.js';
import { createTempo } from '/shared/tempo.js';
import { validateShow } from '/shared/validate.js';
import { formatTime, clamp } from '/shared/util.js';

const params = new URLSearchParams(location.search);
const vizOnly = params.get('view') === 'visualizer';
// Opened on the laptop running the engine, or from a phone/tablet over the network?
const isShowComputer = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
const savedMode = localStorage.getItem('mode');
const smallScreen = matchMedia('(max-width: 700px)').matches;
const store = new Store(vizOnly ? 'visualizer' : savedMode === 'live' || savedMode === 'design' ? savedMode : smallScreen ? 'live' : 'design');
const audio = new AudioPlayer(store);
store.audio = audio;
const root = document.getElementById('app');

// ---- Transport ---------------------------------------------------------------------------

const app = {
  store,
  audio,
  usb: new UsbBridge(store),
  // Microphone / line-in for audio-reactive lighting (only on the controller computer).
  liveAudio: new LiveAudioInput({
    onChange: () => store.emit('liveaudio'),
    onError: (msg) => toast(msg, 'error', 7000),
  }),
  // The show computer plays the song by default; a phone or tablet is a remote control.
  playAudio: localStorage.getItem('playAudio') === null ? isShowComputer : localStorage.getItem('playAudio') === 'true',
  mode: store.viewName,

  setPlayAudio(on) {
    this.playAudio = on;
    localStorage.setItem('playAudio', String(on));
    if (on) restoreAudio();
    store.emit('audio');
  },

  hasMatchingAudio() {
    return !!(audio.buffer && store.show?.audio?.hash && audio.hash === store.show.audio.hash);
  },

  play() {
    const duration = store.show.timeline.durationMs;
    let pos = store.positionNow();
    if (pos >= duration - 50) pos = 0;
    if (this.playAudio && this.hasMatchingAudio()) {
      audio.play(pos);
      store.transportCmd('play', { position: pos, audioMaster: true });
    } else {
      store.transportCmd('play', { position: pos });
    }
  },
  pause() {
    audio.stop();
    store.transportCmd('pause');
  },
  stop() {
    audio.stop();
    audio.startPos = 0;
    store.transportCmd('stop');
  },
  togglePlay() {
    if (store.transport.playing) this.pause();
    else this.play();
  },
  seek(ms) {
    const pos = clamp(ms, 0, store.show.timeline.durationMs);
    store.transportCmd('seek', { position: pos });
    if (audio.isPlaying && store.transport.master === store.clientId) audio.play(pos);
    else audio.startPos = pos;
  },
  nudge(ms) {
    this.seek(store.positionNow() + ms);
  },

  showTab(tab) {
    store.ui.tab = tab;
    localStorage.setItem('tab', tab);
    renderDesignTab();
  },

  /** Open the Control page on one group's faders. */
  showControl(groupKey) {
    if (app.mode !== 'design') switchMode('design');
    views.control?.showGroup(groupKey);
    this.showTab('control');
  },

  async openShow() {
    const file = await pickFile('.json,application/json');
    if (!file) return;
    let show;
    try {
      show = normalizeShow(JSON.parse(await file.text()));
    } catch (err) {
      return toast(err instanceof SyntaxError ? 'That file is not valid JSON.' : err.message, 'error', 7000);
    }
    if (store.show.fixtures.length || store.show.timeline.clips.length) {
      const ok = await confirmDialog('Open show', `Replace “${store.show.meta.name}” with “${show.meta.name}”? The current show is replaced in every window. You can undo this.`, 'Open');
      if (!ok) return;
    }
    this.stop();
    await store.op({ type: 'show.replace', show }).catch(() => {});
    toast(`Opened “${show.meta.name}”: ${show.fixtures.length} fixtures, ${show.timeline.clips.length} clips.`, 'ok');
    restoreAudio();
  },

  async newShow() {
    const ok = await confirmDialog('New show', 'Start a new, empty show? The current one is replaced in every window (you can undo this, and Export saves a copy first).', 'Start new');
    if (!ok) return;
    this.stop();
    await store.op({ type: 'show.replace', show: createShow('Untitled show') }).catch(() => {});
    audio.set(null, null, '');
  },

  exportShow() {
    const v = validateShow(store.show, { routedUniverses: store.routedUniverses() });
    if (v.errors) return this.showIssues('Fix these problems before exporting the show');
    const data = exportShow(store.show, v);
    const name = (store.show.meta.name || 'show').replace(/[^\w\- ]+/g, '').trim() || 'show';
    downloadText(`${name}.dmxshow.json`, JSON.stringify(data, null, 1));
    toast(v.warnings ? `Exported with ${v.warnings} warning${v.warnings === 1 ? '' : 's'}.` : 'Exported. The file is ready for the event.', 'ok');
  },

  showIssues(title = 'Show check') {
    const v = store.validation();
    const body = (close) =>
      h('div', {},
        v.issues.length
          ? v.issues.map((i) =>
              h('div', {
                class: 'issue',
                onclick: () => {
                  close(null);
                  if (i.clips.length) {
                    store.selectClips(i.clips);
                    app.showTab('timeline');
                    switchMode('design');
                  } else if (i.fixtures.length) {
                    store.ui.tab = 'patch';
                    store.selectFixtures(i.fixtures);
                    app.showTab('patch');
                    switchMode('design');
                  }
                },
              }, h('span', { class: `lvl ${i.level}` }, i.level), h('span', {}, i.message)))
          : h('p', {}, 'No problems found. The show is ready to export.'),
      );
    dialog(`${title} — ${v.errors} error${v.errors === 1 ? '' : 's'}, ${v.warnings} warning${v.warnings === 1 ? '' : 's'}`, body);
  },
};

// Following the transport: stop or re-sync local audio when another window takes over.
store.on('transport', () => {
  const tr = store.transport;
  if (!audio.isPlaying) return;
  if (!tr.playing || tr.master !== store.clientId) {
    audio.stop();
    return;
  }
  const serverPos = tr.position + (store.net.serverNow() - tr.anchor);
  if (Math.abs(audio.positionMs - serverPos) > 150) audio.play(serverPos);
});

setInterval(() => {
  if (audio.isPlaying && store.transport.playing && store.transport.master === store.clientId) {
    store.net.send({ t: 'sync', position: audio.positionMs });
  }
}, 250);

async function restoreAudio() {
  const a = store.show?.audio;
  if (!a?.hash || audio.hash === a.hash) return;
  // A phone used as a remote only downloads the song when asked to play it.
  if (!isShowComputer && !app.playAudio) return;
  try {
    await audio.loadCached(a.hash, a.name);
  } catch {
    /* not cached on this machine; the Song page asks for the file */
  }
}

// ---- Shell -------------------------------------------------------------------------------

const views = {};
let sideViz = null;
let designEls = null;
let liveView = null;

function switchMode(mode) {
  if (app.mode === mode && root.dataset.built) return;
  app.mode = mode;
  localStorage.setItem('mode', mode);
  store.net.send({ t: 'hello', name: windowName(mode), view: mode });
  build();
}

function topbar() {
  const v = store.validation();
  const issues = v.errors ? h('button', { class: 'badge error', onclick: () => app.showIssues() }, icon('warn', 12), `${v.errors} error${v.errors === 1 ? '' : 's'}`)
    : v.warnings ? h('button', { class: 'badge warn', onclick: () => app.showIssues() }, `${v.warnings} warning${v.warnings === 1 ? '' : 's'}`)
      : h('span', { class: 'badge ok' }, icon('check', 12), 'Show OK');
  return h('header', { class: 'topbar' },
    h('div', { class: 'brand' }, icon('bulb', 20), h('span', { class: 'hide-narrow' }, 'DMX Show')),
    textInput(store.show.meta.name, (name) => store.op({ type: 'meta.set', changes: { name } }), { class: 'show-name hide-phone', 'aria-label': 'Show name' }),
    h('div', { class: 'modes', role: 'tablist' },
      h('button', { class: app.mode === 'design' ? 'active' : '', onclick: () => switchMode('design') }, 'Edit'),
      h('button', { class: app.mode === 'live' ? 'active live' : '', onclick: () => switchMode('live') }, 'Live'),
    ),
    statusChips(),
    h('div', { class: 'grow' }),
    app.mode === 'design' ? [
      h('button', { class: 'btn icon ghost hide-phone', title: 'Undo (Ctrl+Z)', disabled: !store.undoStack.length, onclick: () => store.undo() }, icon('undo')),
      h('button', { class: 'btn icon ghost hide-phone', title: 'Redo (Ctrl+Y)', disabled: !store.redoStack.length, onclick: () => store.redo() }, icon('redo')),
    ] : null,
    issues,
    h('button', { class: 'btn small hide-narrow', onclick: () => app.newShow() }, 'New'),
    h('button', { class: 'btn small hide-phone', onclick: () => app.openShow() }, icon('open', 14), 'Open'),
    h('button', { class: 'btn small primary hide-phone', onclick: () => app.exportShow() }, icon('save', 14), 'Export'),
    h('div', { class: 'conn', title: 'Connection to the DMX engine' },
      h('span', { class: `dot ${store.connection === 'open' ? 'ok' : 'error'}` }),
      h('span', { class: 'hide-narrow' }, store.connection === 'open' ? 'Engine' : 'Reconnecting…')),
  );
}

/** Things holding the lights away from the show, each with a one-click way out. */
function statusChips() {
  const chips = [];
  if (store.live.calibrate) {
    chips.push(h('button', { class: 'badge warn chip-btn', title: 'Moving heads are showing calibration beams and the show is paused on them. Click to stop.', onclick: () => store.setLive({ calibrate: null }) }, icon('target', 12), h('span', { class: 'hide-narrow' }, 'Calibrating · '), 'stop'));
  }
  const held = new Set([...Object.keys(store.programmer.attrs), ...Object.keys(store.programmer.raw)]).size;
  if (held) {
    chips.push(h('button', { class: 'badge warn chip-btn', title: `Faders hold ${held} fixture${held === 1 ? '' : 's'}: the show cannot change them until released. Click to release all.`, onclick: () => store.clearProgrammer('all') }, icon('sliders', 12), h('span', { class: 'hide-narrow' }, 'Manual '), `${held} · release`));
  }
  if (store.live.autoShow) {
    chips.push(h('button', { class: 'badge ok chip-btn', title: 'The auto show is running the lights from the live audio instead of the timeline. Click to stop it.', onclick: () => store.setLive({ autoShow: false }) }, icon('wand', 12), h('span', { class: 'hide-narrow' }, 'Auto show')));
  }
  if (store.live.audioReactive) chips.push(h('span', { class: 'badge ok', title: 'Live audio drives the lights (Live › Live audio)' }, icon('mic', 12), h('span', { class: 'hide-narrow' }, 'Audio')));
  return chips;
}

function transportBar() {
  const clock = h('span', { class: 'clock' });
  const bb = h('span', { class: 'barbeat' });
  const playBtn = h('button', { class: 'btn primary play', title: 'Play / pause (Space)', onclick: () => app.togglePlay() }, icon('play'));
  const audioBox = h('label', { class: 'row', style: { gap: '4px' } },
    h('input', { type: 'checkbox', checked: app.playAudio, onchange: (e) => app.setPlayAudio(e.target.checked) }), 'Play song');
  const bar = h('footer', { class: 'transport' },
    h('button', { class: 'btn icon', title: 'Back to start (Home)', onclick: () => app.seek(0) }, icon('start')),
    playBtn,
    h('button', { class: 'btn icon', title: 'Stop', onclick: () => app.stop() }, icon('stop')),
    clock, bb,
    h('span', { class: 'muted', dataset: { role: 'tempo' } }),
    h('div', { class: 'grow' }),
    audioBox,
    h('span', { class: 'muted hide-phone', dataset: { role: 'audio' } }),
    h('a', { class: 'btn small hide-phone', href: '?view=visualizer', target: '_blank', title: 'Open the 3D view in its own window (for a second screen)' }, icon('popout', 14), '3D window'),
  );
  const update = () => playBtn.replaceChildren(icon(store.transport.playing ? 'pause' : 'play'));
  store.on('transport', update);
  store.on('frame', (pos) => {
    if (!bar.isConnected) return;
    const tempo = createTempo(store.show.tempo);
    const p = tempo.barBeat(pos);
    clock.textContent = formatTime(pos).slice(0, -1);
    bb.textContent = `${p.bar}.${p.beat}`;
  });
  const updateInfo = () => {
    bar.querySelector('[data-role="tempo"]').textContent = `${createTempo(store.show.tempo).bpm.toFixed(1)} BPM`;
    const a = bar.querySelector('[data-role="audio"]');
    a.textContent = app.hasMatchingAudio() ? audio.name : store.show.audio ? 'song not loaded here' : 'no song';
  };
  store.on('show', updateInfo);
  store.on('audio', updateInfo);
  updateInfo();
  update();
  return bar;
}

function renderDesignTab() {
  if (!designEls) return;
  if (!views[store.ui.tab]) store.ui.tab = 'patch';
  const tab = store.ui.tab;
  for (const b of designEls.nav.querySelectorAll('button[data-tab]')) b.classList.toggle('active', b.dataset.tab === tab);
  const view = views[tab];
  designEls.content.className = tab === 'timeline' ? 'content flush' : 'content';
  mount(designEls.content, view.el);
  if (view.render) view.render();
  if (tab === 'timeline') {
    view.renderToolbar();
    view.dirty = true;
  }
  views.inspector.render();
}

function build() {
  root.dataset.built = '1';
  sideViz?.stop();
  liveView?.stop();
  if (app.mode === 'live') {
    liveView = liveView || new LiveView(app);
    liveView.build();
    mount(root, topbar(), liveView.el);
    liveView.start();
    root.style.gridTemplateRows = '48px 1fr';
    return;
  }
  root.style.gridTemplateRows = '';
  views.patch = views.patch || new PatchView(app);
  views.song = views.song || new SongView(app);
  views.timeline = views.timeline || new TimelineView(app);
  views.outputs = views.outputs || new OutputsView(app);
  views.inspector = views.inspector || new Inspector(app);
  views.control = views.control || new ControlView(app);
  views.calibrate = views.calibrate || new CalibrateView(app);
  const navBtn = (tab, step, label, iconName = 'dmx') => h('button', { dataset: { tab }, onclick: () => app.showTab(tab) }, step ? h('span', { class: 'step' }, step) : icon(iconName, 14), label);
  const nav = h('nav', { class: 'nav' },
    navBtn('patch', '1', 'Patch'),
    navBtn('song', '2', 'Song'),
    navBtn('timeline', '3', 'Timeline'),
    navBtn('control', null, 'Control', 'sliders'),
    navBtn('calibrate', null, 'Calibrate', 'target'),
    h('div', { class: 'spacer' }),
    navBtn('outputs', null, 'Outputs'),
  );
  const content = h('main', { class: 'content' });
  // One canvas for the life of the page: browsers cap the number of WebGL contexts.
  if (!sideViz) {
    const vizCanvas = h('canvas', { 'aria-label': '3D stage view' });
    const vizLabel = h('div', { class: 'viz-label' }, 'Drag to orbit · wheel to zoom · double-click to reset');
    sideViz = new Visualizer(store, vizCanvas, { label: vizLabel });
    sideViz.wrap = h('div', { class: 'viz-wrap' }, vizCanvas, vizLabel);
  }
  const side = h('aside', { class: 'side' }, sideViz.wrap, views.inspector.el);
  designEls = { nav, content };
  mount(root, topbar(), h('div', { class: 'design' }, nav, content, side), transportBar());
  renderDesignTab();
  sideViz.start();
}

function refreshTopbar() {
  const old = root.querySelector('.topbar');
  if (old && store.show) {
    const focused = document.activeElement?.classList.contains('show-name');
    if (!focused) old.replaceWith(topbar());
  }
}

// ---- Visualizer-only window --------------------------------------------------------------

function buildVizOnly() {
  const canvas = h('canvas');
  const label = h('div', { class: 'viz-label' });
  mount(root, h('div', { class: 'viz-only' }, canvas, label));
  const viz = new Visualizer(store, canvas, { label });
  viz.start();
  store.on('frame', (pos) => {
    const p = createTempo(store.show.tempo).barBeat(pos);
    label.textContent = `${store.show.meta.name} · ${formatTime(pos, false)} · bar ${p.bar}.${p.beat}${store.connection === 'open' ? '' : ' · reconnecting…'}`;
  });
  document.title = `3D view — ${store.show.meta.name}`;
}

// ---- Keyboard ----------------------------------------------------------------------------

function typing(e) {
  const t = e.target;
  return t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) && !(t instanceof HTMLInputElement && ['checkbox', 'range', 'button'].includes(t.type));
}

const held = new Set();
document.addEventListener('keydown', (e) => {
  if (!store.show || vizOnly || typing(e)) return;
  const k = e.key.toLowerCase();
  if (e.key === ' ') {
    e.preventDefault();
    if (!e.repeat) app.togglePlay();
    return;
  }
  if (e.key === 'Home') return app.seek(0);
  if (app.mode === 'live') {
    if (e.repeat) return;
    if (k === 'b') store.setLive({ blackout: !store.live.blackout });
    else if (k === 'f' || k === 's') {
      held.add(k);
      store.setLive({ flash: k === 'f' ? 'blinder' : 'strobe' });
    } else if (e.key === 'ArrowLeft') app.nudge(-50);
    else if (e.key === 'ArrowRight') app.nudge(50);
    return;
  }
  if ((e.ctrlKey || e.metaKey) && k === 'z') {
    e.preventDefault();
    return e.shiftKey ? store.redo() : store.undo();
  }
  if ((e.ctrlKey || e.metaKey) && k === 'y') {
    e.preventDefault();
    return store.redo();
  }
  if (store.ui.tab === 'timeline' && views.timeline?.handleKey(e)) e.preventDefault();
});
document.addEventListener('keyup', (e) => {
  const k = e.key.toLowerCase();
  if (held.has(k)) {
    held.delete(k);
    if (!held.size) store.setLive({ flash: null });
  }
});
window.addEventListener('blur', () => {
  if (held.size) {
    held.clear();
    store.setLive({ flash: null });
  }
});

// ---- Start -------------------------------------------------------------------------------

store.ui.tab = localStorage.getItem('tab') || 'patch';
store.on('error', (msg) => toast(msg, 'error', 6000));
store.on('ready', () => {
  if (vizOnly) buildVizOnly();
  else if (!root.dataset.built) build();
  else refreshTopbar();
  restoreAudio();
});
store.on('show', (op) => {
  if (!vizOnly && root.dataset.built) {
    refreshTopbar();
    if (op?.type === 'show.replace' && app.mode === 'live') liveView?.build();
  }
});
store.on('history', refreshTopbar);
// The top bar's status chips change with manual control, calibration and audio; rebuild it
// only when what they show changes (faders send many updates a second).
let chipKey = '';
const updateChips = () => {
  const held = new Set([...Object.keys(store.programmer.attrs), ...Object.keys(store.programmer.raw)]).size;
  const key = `${!!store.live.calibrate}|${store.live.audioReactive}|${store.live.autoShow}|${held}`;
  if (key === chipKey) return;
  chipKey = key;
  if (!vizOnly && root.dataset.built) refreshTopbar();
};
store.on('programmer', updateChips);
store.on('live', updateChips);
// Keep the live input's band sensitivities in step with the show.
let sensKey = '';
const syncSensitivity = () => {
  const sens = store.show?.audioReactive?.sensitivity;
  const key = JSON.stringify(sens);
  if (!sens || app.liveAudio.state !== 'on' || key === sensKey) return;
  sensKey = key;
  app.liveAudio.setSensitivity(sens);
};
store.on('show', syncSensitivity);
store.on('liveaudio', () => {
  sensKey = '';
  syncSensitivity();
});
store.on('outputs', refreshTopbar);
store.on('connection', ({ state, wasOpen }) => {
  if (root.dataset.built) refreshTopbar();
  if (state === 'closed' && wasOpen) toast('Lost the connection to the engine. The lights keep running; reconnecting…', 'error', 5000);
});

(function frame() {
  if (store.show) store.emit('frame', store.positionNow());
  requestAnimationFrame(frame);
})();

store.connect();
