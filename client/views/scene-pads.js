// Scene buttons for Live mode: tap to bring a scene in over the show, tap again to release it.
// The fill shows the fade, so a slow scene can be seen coming in.

import { h, mount } from '../lib/dom.js';
import { sceneAlpha } from '/shared/evaluate.js';

const touchesScenes = (op) => !op || op.type === 'show.replace' || op.type.startsWith('scene.') || (op.type === 'batch' && op.ops.some(touchesScenes));

export class ScenePads {
  constructor(store) {
    this.store = store;
    this.el = h('div', { class: 'card stack' });
    this.pads = new Map();
    store.on('show', (op) => touchesScenes(op) && this.build());
    store.on('live', () => this.update());
    store.on('frame', () => this.update());
  }

  build() {
    const scenes = this.store.show?.scenes || [];
    this.pads.clear();
    mount(this.el,
      h('div', { class: 'row' },
        h('h3', {}, 'Scenes'),
        h('div', { class: 'grow' }),
        scenes.length ? h('button', { class: 'btn small', onclick: () => this.store.sceneCmd('releaseAll') }, 'Release all') : null,
      ),
      scenes.length
        ? h('div', { class: 'scene-pads' }, scenes.map((sc) => {
          const fill = h('span', { class: 'pad-fill' });
          const pad = h('button', {
            class: 'scene-pad',
            style: `--sc:${sc.color}`,
            title: `${sc.name} · fades in ${sc.fadeMs / 1000} s · tap to toggle`,
            onclick: () => this.store.sceneCmd('toggle', sc.id),
          }, fill, h('span', { class: 'pad-name' }, sc.name));
          this.pads.set(sc.id, { pad, fill, sc, level: -1 });
          return pad;
        }))
        : h('p', { class: 'muted', style: { margin: 0, fontSize: '12px' } }, 'No scenes yet. Set faders in Edit › Control and record them as scenes; they appear here as buttons.'),
    );
    this.update();
  }

  update() {
    if (!this.pads.size || !this.el.isConnected) return;
    const now = this.store.net.serverNow();
    const active = this.store.live.scenes || [];
    for (const [id, p] of this.pads) {
      const entry = active.find((e) => e.id === id);
      const level = entry ? sceneAlpha(p.sc, entry, now) : 0;
      const on = !!entry && entry.releasedAt == null;
      p.pad.classList.toggle('on', on);
      if (Math.abs(level - p.level) > 0.005) {
        p.level = level;
        p.fill.style.transform = `scaleX(${level})`;
      }
    }
  }
}
