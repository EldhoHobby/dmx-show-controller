// HTTP: the browser app (static files) and the media API that caches song audio on the show
// machine so every window, and a reload, can play it without re-loading the file.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.txt': 'text/plain; charset=utf-8',
};
const AUDIO_TYPES = /^audio\/[\w.+-]{1,40}$/;
const MAX_MEDIA_BYTES = 400 * 1024 * 1024;

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}

const sendJson = (res, status, obj) => send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8');

/** True when a browser request comes from our own page (or from a non-browser tool). */
export function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

export function createRequestHandler({ root, mediaDir, log, getInfo }) {
  const mounts = [
    { prefix: '/shared/', dir: path.join(root, 'shared') },
    { prefix: '/samples/', dir: path.join(root, 'samples') },
    { prefix: '/', dir: path.join(root, 'client') },
  ];

  function serveStatic(req, res, pathname) {
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return send(res, 400, 'Bad path');
    }
    if (decoded.includes('\0')) return send(res, 400, 'Bad path');
    const mount = mounts.find((m) => decoded.startsWith(m.prefix));
    let rel = decoded.slice(mount.prefix.length);
    if (!rel || rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(mount.dir, rel);
    if (!file.startsWith(mount.dir + path.sep)) return send(res, 403, 'Forbidden');
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return send(res, 404, 'Not found');
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': st.size,
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      });
      if (req.method === 'HEAD') return res.end();
      streamFile(file, res);
    });
  }

  /**
   * pipe() does not forward source errors, so a file that disappears or becomes unreadable
   * between the stat and the open would raise an unhandled 'error' and end the process.
   * The headers are already sent by this point, so all we can do is drop the response.
   */
  function streamFile(file, res) {
    const stream = fs.createReadStream(file);
    stream.on('error', (err) => {
      log.warn(`Could not read ${file}: ${err.message}`);
      res.destroy();
      stream.destroy();
    });
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }

  function serveMedia(req, res, hash) {
    const file = path.join(mediaDir, hash);
    const metaFile = `${file}.json`;
    if (req.method === 'GET' || req.method === 'HEAD') {
      fs.stat(file, (err, st) => {
        if (err) return send(res, 404, 'Not found');
        let type = 'application/octet-stream';
        try {
          const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
          if (AUDIO_TYPES.test(meta.type)) type = meta.type;
        } catch {}
        res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': 'private, max-age=31536000, immutable' });
        if (req.method === 'HEAD') return res.end();
        streamFile(file, res);
      });
      return;
    }
    if (req.method !== 'PUT') return send(res, 405, 'Method not allowed');
    if (!sameOrigin(req)) return send(res, 403, 'Forbidden');
    const length = Number(req.headers['content-length']);
    if (!Number.isFinite(length) || length <= 0 || length > MAX_MEDIA_BYTES) return send(res, 413, 'Audio file too large (limit 400 MB)');
    if (fs.existsSync(file)) {
      req.resume();
      return sendJson(res, 200, { hash, stored: true });
    }
    fs.mkdirSync(mediaDir, { recursive: true });
    const tmp = `${file}.${process.pid}.part`;
    const out = fs.createWriteStream(tmp);
    const sha = crypto.createHash('sha256');
    let received = 0;
    let failed = false;
    const abort = (status, message) => {
      if (failed) return;
      failed = true;
      out.destroy();
      fs.rm(tmp, { force: true }, () => {});
      send(res, status, message);
    };
    req.on('data', (chunk) => {
      received += chunk.length;
      if (received > MAX_MEDIA_BYTES) return abort(413, 'Too large');
      sha.update(chunk);
      // A fast LAN can outrun a slow disk (a cloud-synced folder, a virus scanner) by a wide
      // margin. Without pausing, the backlog of a 400 MB upload is held in memory.
      if (!out.write(chunk)) {
        req.pause();
        out.once('drain', () => req.resume());
      }
    });
    req.on('error', () => abort(400, 'Upload failed'));
    req.on('end', () => {
      if (failed) return;
      out.end(() => {
        if (sha.digest('hex') !== hash) return abort(400, 'Content does not match its hash');
        fs.rename(tmp, file, (err) => {
          if (err) return abort(500, 'Could not store audio');
          const type = AUDIO_TYPES.test(req.headers['content-type'] || '') ? req.headers['content-type'] : 'application/octet-stream';
          const name = String(req.headers['x-file-name'] || '').slice(0, 200);
          fs.writeFile(metaFile, JSON.stringify({ type, name: safeDecode(name) }), () => {});
          log.info(`Stored audio ${safeDecode(name) || hash.slice(0, 12)} (${(received / 1048576).toFixed(1)} MB)`);
          sendJson(res, 201, { hash, stored: true });
        });
      });
    });
  }

  return (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return send(res, 400, 'Bad request');
    }
    try {
      if (url.pathname === '/api/info') return sendJson(res, 200, getInfo());
      const media = /^\/api\/media\/([a-f0-9]{64})$/.exec(url.pathname);
      if (media) return serveMedia(req, res, media[1]);
      if (url.pathname.startsWith('/api/')) return send(res, 404, 'Not found');
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
      return serveStatic(req, res, url.pathname);
    } catch (err) {
      log.error(`HTTP ${req.method} ${url.pathname}: ${err.message}`);
      if (!res.headersSent) send(res, 500, 'Internal error');
    }
  };
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
