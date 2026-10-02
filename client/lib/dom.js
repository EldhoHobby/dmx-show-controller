// Tiny DOM helpers. No framework: views build elements with h() and re-render on store events.

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'value' && ('value' in el)) el.value = value;
    else if (key === 'checked') el.checked = !!value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, value);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function mount(el, ...children) {
  clear(el);
  append(el, children);
  return el;
}

/** <select> with [value, label] options. Numeric option values come back as numbers. */
export function select(options, value, onChange, props = {}) {
  const el = h(
    'select',
    props,
    options.map(([v, label]) => h('option', { value: String(v), selected: String(v) === String(value) }, label)),
  );
  el.addEventListener('change', () => {
    const raw = el.value;
    const match = options.find(([v]) => String(v) === raw);
    onChange(match ? match[0] : raw);
  });
  return el;
}

export function numberInput(value, onCommit, props = {}) {
  const el = h('input', { type: 'number', value: Number.isFinite(value) ? String(value) : '', ...props });
  const commit = () => {
    const v = Number(el.value);
    if (el.value !== '' && Number.isFinite(v)) onCommit(v);
  };
  el.addEventListener('change', commit);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') el.blur();
  });
  return el;
}

export function textInput(value, onCommit, props = {}) {
  const el = h('input', { type: 'text', value: value ?? '', ...props });
  el.addEventListener('change', () => onCommit(el.value));
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') el.blur();
  });
  return el;
}

const ICONS = {
  play: 'M7 4.5v15l12-7.5z',
  pause: 'M6 4h4v16H6zM14 4h4v16h-4z',
  stop: 'M6 6h12v12H6z',
  start: 'M6 5h2v14H6zM20 5v14L9 12z',
  undo: 'M9 7V3L3 9l6 6v-4c5 0 8.5 1.6 11 5-1-5-4-9.5-11-9z',
  redo: 'M15 7V3l6 6-6 6v-4c-5 0-8.5 1.6-11 5 1-5 4-9.5 11-9z',
  plus: 'M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z',
  trash: 'M9 3h6l1 2h4v2H4V5h4zM6 9h12l-1 12H7z',
  open: 'M3 6h7l2 2h9v11H3z',
  save: 'M5 3h12l4 4v14H3V3zm2 2v5h9V5zm5 8a3 3 0 100 6 3 3 0 000-6z',
  popout: 'M14 3h7v7h-2V6.4l-8.3 8.3-1.4-1.4L17.6 5H14zM5 5h5v2H5v12h12v-5h2v7H3V5z',
  bulb: 'M9 21h6v-2H9zm3-19a7 7 0 00-4 12.7V17h8v-2.3A7 7 0 0012 2z',
  wand: 'M7.5 5.6L5 7l1.4-2.5L5 2l2.5 1.4L10 2 8.6 4.5 10 7zM19.5 15.4L22 14l-1.4 2.5L22 19l-2.5-1.4L17 19l1.4-2.5L17 14zM22 2l-1.4 2.5L22 7l-2.5-1.4L17 7l1.4-2.5L17 2l2.5 1.4zM14.4 7l2.6 2.6L6.6 20 4 17.4z',
  check: 'M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z',
  warn: 'M1 21h22L12 2zm12-3h-2v-2h2zm0-4h-2v-4h2z',
  sliders: 'M5 3h2v8h2v3H3v-3h2zm0 13h2v5H5zM11 3h2v3h2v3H9V6h2zm0 8h2v10h-2zM17 3h2v10h2v3h-6v-3h2zm0 15h2v3h-2z',
  target: 'M11 2h2v3.07A7 7 0 0118.93 11H22v2h-3.07A7 7 0 0113 18.93V22h-2v-3.07A7 7 0 015.07 13H2v-2h3.07A7 7 0 0111 5.07zm1 5a5 5 0 100 10 5 5 0 000-10zm0 3a2 2 0 110 4 2 2 0 010-4z',
  mic: 'M12 2a3 3 0 013 3v6a3 3 0 01-6 0V5a3 3 0 013-3zm7 9a7 7 0 01-6 6.93V21h3v2H8v-2h3v-3.07A7 7 0 015 11h2a5 5 0 0010 0z',
  grid: 'M3 3h8v8H3zm10 0h8v8h-8zM3 13h8v8H3zm10 0h8v8h-8z',
  scenes: 'M12 2l10 5-10 5L2 7zm-7.6 7.8L12 13.6l7.6-3.8L22 11l-10 5-10-5zm0 4L12 17.6l7.6-3.8L22 15l-10 5-10-5z',
  move: 'M12 2l3.5 3.5h-2.5V11h5.5V8.5L22 12l-3.5 3.5V13H13v5.5h2.5L12 22l-3.5-3.5H11V13H5.5v2.5L2 12l3.5-3.5V11H11V5.5H8.5z',
  dmx: 'M12 2a10 10 0 100 20 10 10 0 000-20zm-4 8a1.5 1.5 0 110 3 1.5 1.5 0 010-3zm8 0a1.5 1.5 0 110 3 1.5 1.5 0 010-3zm-4 4a1.5 1.5 0 110 3 1.5 1.5 0 010-3zm0-8a1.5 1.5 0 110 3 1.5 1.5 0 010-3z',
};

export function icon(name, size = 16) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name] || '');
  path.setAttribute('fill', 'currentColor');
  path.setAttribute('fill-rule', 'evenodd');
  svg.append(path);
  return svg;
}

let toastHost = null;
export function toast(message, kind = 'info', ms = 4000) {
  if (!toastHost) {
    toastHost = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastHost);
  }
  const el = h('div', { class: `toast ${kind}` }, message);
  toastHost.append(el);
  setTimeout(() => el.remove(), ms);
}

/** Modal dialog; resolves with the value passed to close(). */
export function dialog(title, body, actions = [['Close', null]]) {
  return new Promise((resolve) => {
    const close = (v) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') close(null);
    };
    const overlay = h(
      'div',
      { class: 'overlay', onmousedown: (e) => e.target === overlay && close(null) },
      h(
        'div',
        { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        h('h2', {}, title),
        typeof body === 'function' ? body(close) : body,
        h(
          'div',
          { class: 'actions' },
          actions.map(([label, value, cls]) => h('button', { class: `btn ${cls || ''}`, onclick: () => close(value) }, label)),
        ),
      ),
    );
    document.addEventListener('keydown', onKey);
    document.body.append(overlay);
    overlay.querySelector('.actions .btn:last-child')?.focus();
  });
}

export const confirmDialog = (title, message, okLabel = 'OK') =>
  dialog(title, h('p', {}, message), [['Cancel', false], [okLabel, true, 'primary']]);

/** Size a canvas to its CSS box at device pixel ratio; returns { ctx, w, h } in CSS pixels. */
export function fitCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width));
  const hgt = Math.max(1, Math.round(rect.height));
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hgt * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(hgt * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h: hgt };
}

export function pickFile(accept) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, style: { display: 'none' } });
    input.addEventListener('change', () => {
      resolve(input.files?.[0] || null);
      input.remove();
    });
    document.body.append(input);
    input.click();
  });
}

export function downloadText(filename, text, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: filename, style: { display: 'none' } });
  document.body.append(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 1000);
}

export const SECTION_COLORS = {
  intro: '#5b7cbf',
  groove: '#3fa7a0',
  build: '#e0a030',
  drop: '#e5484d',
  high: '#d0605a',
  breakdown: '#7a5bbf',
  low: '#4f6a8a',
  outro: '#5b7cbf',
};
