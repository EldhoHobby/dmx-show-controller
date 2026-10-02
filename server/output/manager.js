// Owns the network outputs and fans each frame out to them.

import { SacnOutput, cidFromUuid } from './sacn.js';
import { ArtNetOutput } from './artnet.js';

export class OutputManager {
  constructor({ log }) {
    this.log = log;
    this.outputs = [];
    this.config = null;
    this.routed = new Set();
  }

  async configure(config) {
    const old = this.outputs;
    this.outputs = [];
    this.routed = new Set();
    await Promise.all(old.map((o) => o.close().catch(() => {})));
    this.config = config;
    const cid = cidFromUuid(config.cid);
    for (const cfg of config.outputs) {
      if (!cfg.enabled || !cfg.universes.length) continue;
      const out =
        cfg.type === 'sacn'
          ? new SacnOutput({ ...cfg, cid, sourceName: config.sourceName })
          : cfg.type === 'artnet'
            ? new ArtNetOutput(cfg)
            : null;
      if (!out) continue;
      out.id = cfg.id;
      await out.open();
      if (out.ready) {
        this.log.info(`Output ${cfg.type} ${out.describe()}: universes ${cfg.universes.join(', ')}`);
      } else {
        this.log.warn(`Output ${cfg.type} could not start: ${out.stats.lastError}`);
      }
      this.outputs.push(out);
      cfg.universes.forEach((u) => this.routed.add(u));
    }
  }

  routedUniverses() {
    return this.routed;
  }

  send(universes) {
    for (const out of this.outputs) out.send(universes);
  }

  status() {
    return this.outputs.map((o) => ({
      id: o.id,
      type: o.type,
      target: o.describe(),
      universes: o.cfg.universes,
      ready: o.ready,
      packets: o.stats.packets,
      errors: o.stats.errors,
      skipped: o.stats.skipped,
      lastError: o.stats.lastError,
    }));
  }

  async close() {
    await Promise.all(this.outputs.map((o) => o.close().catch(() => {})));
    this.outputs = [];
  }
}
