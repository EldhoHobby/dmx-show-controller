// Owns the network outputs and fans each frame out to them.

import { SacnOutput, cidFromUuid } from './sacn.js';
import { ArtNetOutput } from './artnet.js';

export class OutputManager {
  constructor({ log }) {
    this.log = log;
    this.outputs = [];
    this.config = null;
    this.routed = new Set();
    this.pending = null;
  }

  /**
   * Apply an output configuration. Calls are queued rather than run concurrently: two
   * overlapping ones would interleave across the awaits in applyConfig, the second finding
   * this.outputs already emptied by the first and so closing nothing. Both would then push
   * their sockets, leaving two sources transmitting the same CID with independent sequence
   * numbers — which receivers read as sequence errors and discard.
   */
  configure(config) {
    this.pending = Promise.resolve(this.pending)
      .catch(() => {})
      .then(() => this.applyConfig(config));
    return this.pending;
  }

  async applyConfig(config) {
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
    // Queued behind any configure still in flight, so shutdown cannot leave a socket open.
    this.pending = Promise.resolve(this.pending)
      .catch(() => {})
      .then(async () => {
        await Promise.all(this.outputs.map((o) => o.close().catch(() => {})));
        this.outputs = [];
      });
    return this.pending;
  }
}
