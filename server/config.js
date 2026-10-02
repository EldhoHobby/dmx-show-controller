// Output configuration. This is venue setup (which network, which node, which universes),
// so it lives in config/outputs.json on the show machine rather than in the show file.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const DEFAULT_OUTPUTS = [
  { id: 'sacn', type: 'sacn', enabled: true, universes: [1, 2], mode: 'multicast', unicast: '', interface: '', priority: 100 },
  { id: 'artnet', type: 'artnet', enabled: false, universes: [1, 2], host: '2.255.255.255', universeOffset: -1, interface: '' },
];

const isIPv4 = (s) =>
  typeof s === 'string' && /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(s) && s.split('.').every((p) => Number(p) <= 255);

function universes(list) {
  const out = (Array.isArray(list) ? list : [])
    .map(Number)
    .filter((u) => Number.isInteger(u) && u >= 1 && u <= 63999);
  return [...new Set(out)].slice(0, 64).sort((a, b) => a - b);
}

function normalizeOutput(o, i) {
  if (!o || typeof o !== 'object') return null;
  const id = typeof o.id === 'string' && /^[\w-]{1,32}$/.test(o.id) ? o.id : `out${i + 1}`;
  // Non-standard destination port: only for testing or forwarding through other software.
  const port = Number.isInteger(o.port) && o.port >= 1024 && o.port <= 65535 ? { port: o.port } : {};
  if (o.type === 'sacn') {
    return {
      id,
      type: 'sacn',
      enabled: o.enabled !== false,
      universes: universes(o.universes),
      mode: o.mode === 'unicast' ? 'unicast' : 'multicast',
      unicast: isIPv4(o.unicast) ? o.unicast : '',
      interface: isIPv4(o.interface) ? o.interface : '',
      priority: Number.isInteger(o.priority) ? Math.max(0, Math.min(200, o.priority)) : 100,
      ...port,
    };
  }
  if (o.type === 'artnet') {
    return {
      id,
      type: 'artnet',
      enabled: o.enabled === true,
      universes: universes(o.universes),
      host: isIPv4(o.host) ? o.host : '2.255.255.255',
      universeOffset: Number.isInteger(o.universeOffset) ? Math.max(-1, Math.min(1, o.universeOffset)) : -1,
      interface: isIPv4(o.interface) ? o.interface : '',
      ...port,
    };
  }
  return null;
}

export function normalizeConfig(input = {}, previous = null) {
  const outputs = (Array.isArray(input.outputs) ? input.outputs : DEFAULT_OUTPUTS).map(normalizeOutput).filter(Boolean);
  const cid = typeof previous?.cid === 'string' ? previous.cid : typeof input.cid === 'string' && /^[0-9a-f-]{36}$/i.test(input.cid) ? input.cid : randomUUID();
  const rate = Number(input.frameRate);
  return {
    cid,
    sourceName: typeof input.sourceName === 'string' && input.sourceName.trim() ? input.sourceName.trim().slice(0, 63) : 'DMX Show Controller',
    frameRate: Number.isFinite(rate) ? Math.max(10, Math.min(44, Math.round(rate))) : 40,
    outputs,
  };
}

export function loadConfig(file, log) {
  try {
    if (fs.existsSync(file)) return normalizeConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (err) {
    log?.warn(`Could not read ${file} (${err.message}); using default outputs.`);
  }
  const config = normalizeConfig({});
  saveConfig(file, config, log);
  return config;
}

export function saveConfig(file, config, log) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
    fs.renameSync(tmp, file);
  } catch (err) {
    log?.error(`Could not save ${file}: ${err.message}`);
  }
}
