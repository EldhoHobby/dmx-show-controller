// USB DMX through the browser's Web Serial API (Chrome 89+, Edge, desktop Firefox 151+; not
// Safari). Browsers only expose serial ports on secure pages, so this works in a window on the
// show computer itself (http://localhost counts as secure), not from a tablet over plain http.
//
// Supports the Enttec DMX USB Pro and compatible "Pro-protocol" interfaces: the interface
// generates the DMX signal and timing itself; we only hand it complete frames. Simple FTDI
// "Open DMX" cables need precise break timing that a browser cannot guarantee, so they are
// not supported. The engine streams frames for the chosen universe to this window, which
// must stay open (it can be in the background).
//
// Enttec Pro "Output Only Send DMX" message: 0x7E, label 6, length LSB, length MSB,
// start code 0x00 + 512 slots, 0xE7.

export class UsbBridge {
  constructor(store) {
    this.store = store;
    this.port = null;
    this.writer = null;
    this.universe = 1;
    this.connected = false;
    this.busy = false;
    this.frames = 0;
    this.dropped = 0;
    this.error = null;
    this.packet = new Uint8Array(518);
    store.on('binary', (buf) => this.onFrame(buf));
    store.on('ready', () => {
      if (this.connected) store.net.send({ t: 'usb', attach: true, universe: this.universe });
    });
  }

  static supported() {
    return typeof navigator !== 'undefined' && 'serial' in navigator;
  }

  /** Why USB is unavailable in this window, in words an operator can act on. */
  static unsupportedReason() {
    if (typeof window !== 'undefined' && !window.isSecureContext) {
      return 'USB interfaces only work in a window opened on the show computer itself (http://localhost:8080): browsers allow serial ports only on secure pages.';
    }
    return 'This browser cannot use serial ports. Use Chrome, Edge or Firefox 151 or newer (Safari has no support).';
  }

  async connect(universe) {
    if (!UsbBridge.supported()) throw new Error(UsbBridge.unsupportedReason());
    const port = await navigator.serial.requestPort();
    await port.open({ baudRate: 57600 });
    this.port = port;
    this.writer = port.writable.getWriter();
    this.universe = universe;
    this.connected = true;
    this.error = null;
    this.frames = 0;
    this.dropped = 0;
    navigator.serial.addEventListener('disconnect', (e) => {
      if (e.target === this.port) this.disconnect('The USB interface was unplugged.');
    });
    this.store.net.send({ t: 'usb', attach: true, universe });
    this.store.emit('usb');
  }

  async disconnect(reason = null) {
    if (!this.connected) return;
    this.connected = false;
    this.error = reason;
    this.store.net.send({ t: 'usb', attach: false });
    try {
      this.writer?.releaseLock();
      await this.port?.close();
    } catch {}
    this.port = null;
    this.writer = null;
    this.store.emit('usb');
  }

  onFrame(arrayBuffer) {
    if (!this.connected) return;
    const bytes = new Uint8Array(arrayBuffer);
    if (bytes[0] !== 0x01 || ((bytes[1] << 8) | bytes[2]) !== this.universe) return;
    if (this.busy) {
      this.dropped++;
      return;
    }
    const p = this.packet;
    p[0] = 0x7e;
    p[1] = 6;
    p[2] = 513 & 0xff;
    p[3] = 513 >> 8;
    p[4] = 0x00;
    p.set(bytes.subarray(3, 515), 5);
    p[517] = 0xe7;
    this.busy = true;
    this.writer.write(p.slice()).then(
      () => {
        this.busy = false;
        this.frames++;
      },
      (err) => {
        this.busy = false;
        this.disconnect(`USB write failed: ${err.message}`);
      },
    );
  }
}
