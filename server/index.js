// DMX Show Controller engine.
//
//   node server/index.js [--port 8080] [--host 127.0.0.1] [--data <dir>]
//
// By default only this computer can connect. Use --host 0.0.0.0 to let tablets and other
// computers on the network open the app (anyone on that network can then control the lights).

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Session } from './session.js';
import { Engine } from './engine.js';
import { OutputManager } from './output/manager.js';
import { loadConfig, normalizeConfig, saveConfig } from './config.js';
import { attachWebSocketServer } from './ws-server.js';
import { createRequestHandler, sameOrigin } from './http.js';

const VERSION = '0.3.2';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The engine needs little processor time (about 1 ms a frame), but it needs it on time. On a
 * laptop kept at 100 % by browsers drawing 3D views, a normal-priority engine waited up to
 * half a second for its turn: frames dropped to 8-20 a second and live-audio hits were held
 * back. High priority (allowed without administrator rights on Windows) lets it run when it
 * asks; it never spins, so the rest of the computer does not notice. Returns the level set.
 */
function raisePriority() {
  const { PRIORITY_HIGH, PRIORITY_ABOVE_NORMAL } = os.constants.priority;
  for (const [level, name] of [[PRIORITY_HIGH, 'high'], [PRIORITY_ABOVE_NORMAL, 'above-normal']]) {
    try {
      os.setPriority(0, level);
      return name;
    } catch {
      /* not allowed here (Linux and macOS need root to raise it): try the next */
    }
  }
  return null;
}

function parseArgs(argv) {
  const args = { port: 8080, host: '127.0.0.1', data: root };
  for (let i = 0; i < argv.length; i++) {
    const [key, inline] = argv[i].split('=');
    const value = inline ?? argv[i + 1];
    const take = () => (inline === undefined ? i++ : null);
    if (key === '--port') { args.port = Number(value); take(); }
    else if (key === '--host') { args.host = value; take(); }
    else if (key === '--data') { args.data = path.resolve(value); take(); }
    else if (key === '--help' || key === '-h') { args.help = true; }
  }
  return args;
}

const stamp = () => new Date().toISOString().slice(11, 19);
const log = {
  info: (m) => console.log(`${stamp()}  ${m}`),
  warn: (m) => console.warn(`${stamp()}  WARNING ${m}`),
  error: (m) => console.error(`${stamp()}  ERROR ${m}`),
};

/**
 * Is something already answering on this port? Windows lets a second process bind 0.0.0.0
 * next to one bound to 127.0.0.1, which would mean two engines sending DMX to the same
 * universes and autosaving over the same show. Resolves 'controller', 'other' or null.
 */
function probePort(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/info', timeout: 1000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body).name === 'DMX Show Controller' ? 'controller' : 'other');
        } catch {
          resolve('other');
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', (err) => resolve(err.code === 'ECONNREFUSED' ? null : 'other'));
  });
}

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address, netmask: a.netmask });
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node server/index.js [--port 8080] [--host 127.0.0.1|0.0.0.0] [--data <dir>]');
    return;
  }
  if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535) throw new Error('--port must be 1-65535');
  const existing = await probePort(args.port);
  if (existing === 'controller') {
    log.error(`The DMX Show Controller is already running on this computer (http://localhost:${args.port}/).`);
    log.error('Close that window first: two engines would fight over the lights and the saved show.');
    process.exit(1);
  }
  if (existing === 'other') {
    log.error(`Another program is using port ${args.port}. Start with --port 8081 (and open that port instead).`);
    process.exit(1);
  }

  const configFile = path.join(args.data, 'config', 'outputs.json');
  let config = loadConfig(configFile, log);
  const session = new Session({ dataDir: args.data, log });
  const outputs = new OutputManager({ log });
  await outputs.configure(config);
  const engine = new Engine({ session, outputs, frameRate: config.frameRate, log });

  session.getOutputsConfig = () => config;
  session.getStatus = () => ({ engine: engine.status(), outputs: outputs.status() });
  session.onOutputsRequest = async (requested, client) => {
    try {
      config = normalizeConfig(requested, config);
      // Apply before saving, so a configuration that cannot be applied at all is not the one
      // waiting on disk at the next start.
      await outputs.configure(config);
      saveConfig(configFile, config, log);
      engine.setFrameRate(config.frameRate);
      session.broadcast({ t: 'outputs', outputs: config });
      log.info(`Outputs updated from ${client.name}`);
      // An output that failed to bind (usually an interface address not on this machine)
      // leaves the engine running but silent, so say so instead of looking like it worked.
      const failed = outputs.status().filter((o) => !o.ready);
      if (failed.length) {
        const detail = failed.map((o) => `${o.type} (${o.lastError || 'could not start'})`).join(', ');
        session.send(client, { t: 'error', message: `Saved, but not sending on: ${detail}` });
      }
    } catch (err) {
      session.send(client, { t: 'error', message: `Could not apply outputs: ${err.message}` });
    }
  };

  const getInfo = () => ({
    name: 'DMX Show Controller',
    version: VERSION,
    node: process.version,
    host: args.host,
    port: args.port,
    lan: args.host === '0.0.0.0' ? lanAddresses().map((a) => `http://${a.address}:${args.port}/`) : [],
    interfaces: lanAddresses(),
  });

  const server = http.createServer(createRequestHandler({ root, mediaDir: path.join(args.data, 'media'), log, getInfo }));
  attachWebSocketServer(server, {
    path: '/ws',
    verifyOrigin: sameOrigin,
    onConnection: (conn, req) => session.addClient(conn, req),
  });

  // Status for every window once a second; drop windows that stopped answering.
  setInterval(() => {
    session.broadcast({ t: 'status', status: session.getStatus(), clients: session.clients.size });
  }, 1000).unref();
  // Live-audio levels and hits for meters and 3D views in every window (~30 Hz, only with input).
  setInterval(() => {
    if (!session.reactiveDirty) return;
    session.reactiveDirty = false;
    session.broadcast({ t: 'reactive', reactive: session.reactive });
  }, 33).unref();
  setInterval(() => {
    for (const c of session.clients.values()) {
      if (Date.now() - c.conn.lastActivity > 45000) c.conn.close(1001);
      else c.conn.ping();
    }
  }, 15000).unref();

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') log.error(`Port ${args.port} is already in use. Is the controller already running? Try --port 8081.`);
    else log.error(err.message);
    process.exit(1);
  });

  server.listen(args.port, args.host, () => {
    engine.start();
    const local = `http://${args.host === '0.0.0.0' ? 'localhost' : args.host}:${args.port}/`;
    log.info(`DMX Show Controller ${VERSION} (Node ${process.version})`);
    const priority = raisePriority();
    if (priority) log.info(`Running at ${priority} priority, so the lights keep time while the computer is busy.`);
    else log.warn('Could not raise the engine\'s priority: on a busy computer the lights may stutter.');
    log.info(`Open ${local} in Chrome, Edge or Firefox.`);
    if (args.host === '0.0.0.0') {
      const lan = getInfo().lan;
      for (const url of lan) log.info(`Phones and tablets on the same Wi-Fi can open: ${url}`);
      if (!lan.length) log.warn('This computer has no network connection, so phones cannot reach it yet.');
      log.warn('Network access is on: anyone on this network can control the lights.');
      log.info('If a phone cannot connect: allow Node.js through Windows Firewall, and set this Wi-Fi to Private.');
    }
    log.info(`DMX engine running at ${config.frameRate} Hz. Press Ctrl+C to stop.`);
  });

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    log.info('Stopping: saving the show and releasing DMX outputs...');
    session.saveNow({ sync: true });
    engine.stop?.();
    await outputs.close();
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  log.error(err.stack || err.message);
  process.exit(1);
});
