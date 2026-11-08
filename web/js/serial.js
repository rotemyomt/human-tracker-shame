// Web Serial transport for the Arduino Leonardo. Line-based, newline-terminated ASCII.
// Events (EventTarget): 'line' {detail: string}, 'ready' {detail: string}, 'lost' {detail: reason},
//                       'closed', 'log' {detail: {dir, text}}

const BAUD = 115200;               // NEVER 1200: a 1200-baud open resets a Leonardo into its bootloader
const HANDSHAKE_TIMEOUT_MS = 6000;
const HANDSHAKE_RETRY_MS = 300;
const PING_INTERVAL_MS = 1000;
const LINK_TIMEOUT_MS = 3500;      // no bytes for this long => link considered lost
const MAX_QUEUE = 20;              // outgoing lines kept before oldest non-critical ones are dropped

export class SerialLink extends EventTarget {
  constructor() {
    super();
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.connected = false;   // port open
    this.ready = false;       // handshake done
    this.portInfo = null;
    this.firmwareInfo = '';
    this.lastRx = 0;
    this._buf = '';
    this._queue = [];
    this._writing = false;
    this._pingTimer = null;
    this._watchTimer = null;
    this._closing = false;
    this._readLoopDone = null;
    this._onDisconnect = this._onDisconnect.bind(this);
  }

  /** A port this site was already given permission for (no prompt), preferring Arduino USB IDs. */
  static async findKnownPort() {
    if (!SerialLink.isSupported()) return null;
    const ports = await navigator.serial.getPorts();
    const arduino = ports.find(p => [0x2341, 0x2a03].includes(p.getInfo?.().usbVendorId));
    return arduino || (ports.length === 1 ? ports[0] : null);
  }

  static isSupported() {
    return 'serial' in navigator && window.isSecureContext;
  }

  /** Connect. Without `existingPort`, shows the browser's port picker (needs a user gesture). */
  async connect(existingPort = null) {
    if (!SerialLink.isSupported()) throw new Error('Web Serial is not available in this browser/context.');
    if (this.port) await this.disconnect('reconnect');

    const port = existingPort || await navigator.serial.requestPort();
    this.port = port;
    this.portInfo = port.getInfo ? port.getInfo() : {};
    this._closing = false;

    await this._openWithRetry(port);
    this.connected = true;
    navigator.serial.removeEventListener('disconnect', this._onDisconnect);
    navigator.serial.addEventListener('disconnect', this._onDisconnect);

    // Leonardo CDC: assert DTR so the sketch's Serial sees an open host.
    try { await port.setSignals({ dataTerminalReady: true, requestToSend: true }); } catch { /* optional */ }

    this.writer = port.writable.getWriter();
    this._readLoopDone = this._readLoop();
    this.lastRx = performance.now();

    const info = await this._handshake();
    this.ready = true;
    this.firmwareInfo = info;
    this._startTimers();
    this.dispatchEvent(new CustomEvent('ready', { detail: info }));
    return info;
  }

  // The Leonardo's USB device can re-enumerate right after reset/plug-in; retry briefly.
  async _openWithRetry(port) {
    let lastErr;
    for (let i = 0; i < 4; i++) {
      try {
        await port.open({ baudRate: BAUD, bufferSize: 4096 });
        return;
      } catch (e) {
        lastErr = e;
        if (/already open/i.test(e.message)) return;
        await sleep(500);
      }
    }
    throw new Error(`Could not open serial port: ${lastErr?.message || lastErr}. ` +
      'Close the Arduino IDE Serial Monitor or any other program using the port, then try again.');
  }

  async _handshake() {
    const start = performance.now();
    return new Promise((resolve, reject) => {
      let timer = null;
      const onLine = (e) => {
        if (e.detail.startsWith('READY')) { cleanup(); resolve(e.detail); }
      };
      const cleanup = () => { clearInterval(timer); this.removeEventListener('line', onLine); };
      this.addEventListener('line', onLine);
      const tick = () => {
        if (performance.now() - start > HANDSHAKE_TIMEOUT_MS) {
          cleanup();
          reject(new Error('No READY reply from the Arduino. Is the HumanTracker firmware uploaded, ' +
            'and did you pick the Leonardo\'s port?'));
          return;
        }
        this._rawWrite('HELLO').catch(() => {});
      };
      tick();
      timer = setInterval(tick, HANDSHAKE_RETRY_MS);
    });
  }

  _startTimers() {
    this._stopTimers();
    this._pingTimer = setInterval(() => this.send('PING'), PING_INTERVAL_MS);
    this._watchTimer = setInterval(() => {
      if (this.connected && performance.now() - this.lastRx > LINK_TIMEOUT_MS) {
        this._lost('No response from Arduino (timeout).');
      }
    }, 500);
  }

  _stopTimers() {
    clearInterval(this._pingTimer); clearInterval(this._watchTimer);
    this._pingTimer = this._watchTimer = null;
  }

  async _readLoop() {
    const decoder = new TextDecoder();
    while (this.port && this.port.readable && !this._closing) {
      try {
        this.reader = this.port.readable.getReader();
        while (true) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (value) {
            this.lastRx = performance.now();
            this._buf += decoder.decode(value, { stream: true });
            let idx;
            while ((idx = this._buf.indexOf('\n')) >= 0) {
              const line = this._buf.slice(0, idx).replace(/\r$/, '').trim();
              this._buf = this._buf.slice(idx + 1);
              if (line) {
                this.dispatchEvent(new CustomEvent('log', { detail: { dir: 'rx', text: line } }));
                this.dispatchEvent(new CustomEvent('line', { detail: line }));
              }
            }
            if (this._buf.length > 1024) this._buf = ''; // garbage guard
          }
        }
      } catch (e) {
        if (!this._closing) { this._lost(`Serial read error: ${e.message}`); }
        break;
      } finally {
        try { this.reader?.releaseLock(); } catch { /* ignore */ }
        this.reader = null;
      }
    }
  }

  /**
   * Queue a command. `critical` commands (STOP, CENTER…) jump the queue and are never dropped.
   * Returns false if the link is not usable.
   */
  send(line, { critical = false } = {}) {
    if (!this.connected || !this.writer) return false;
    if (critical) this._queue.unshift(line);
    else {
      // Coalesce: only the newest ANGLE command matters.
      if (line.startsWith('ANGLE:')) this._queue = this._queue.filter(l => !l.startsWith('ANGLE:'));
      this._queue.push(line);
      while (this._queue.length > MAX_QUEUE) {
        // Drop the oldest droppable line (a PING or STATUS); never config or safety commands.
        const i = this._queue.findIndex(l => l === 'PING' || l === 'STATUS');
        if (i < 0) break;
        this._queue.splice(i, 1);
      }
    }
    this._drain();
    return true;
  }

  async _drain() {
    if (this._writing) return;
    this._writing = true;
    try {
      while (this._queue.length && this.connected) {
        const line = this._queue.shift();
        await this._rawWrite(line);
      }
    } catch (e) {
      this._lost(`Serial write error: ${e.message}`);
    } finally {
      this._writing = false;
    }
  }

  async _rawWrite(line) {
    if (!this.writer) throw new Error('not connected');
    this.dispatchEvent(new CustomEvent('log', { detail: { dir: 'tx', text: line } }));
    await this.writer.write(new TextEncoder().encode(line + '\n'));
  }

  _onDisconnect(e) {
    if (e.target === this.port || e.port === this.port) this._lost('USB device disconnected.');
  }

  _lost(reason) {
    if (!this.port || this._closing) return;
    this.dispatchEvent(new CustomEvent('lost', { detail: reason }));
    this.disconnect(reason);
  }

  async disconnect(reason = 'user') {
    if (!this.port) return;
    this._closing = true;
    this._stopTimers();
    this._queue = [];
    const port = this.port;
    this.connected = false;
    this.ready = false;
    navigator.serial?.removeEventListener('disconnect', this._onDisconnect);
    try { await this.reader?.cancel(); } catch { /* ignore */ }
    try { await this._readLoopDone; } catch { /* ignore */ }
    try { this.writer?.releaseLock(); } catch { /* ignore */ }
    this.writer = null;
    try { await port.close(); } catch { /* already closed */ }
    this.port = null;
    this._buf = '';
    this.dispatchEvent(new CustomEvent('closed', { detail: reason }));
  }

  /** Send STOP as fast as possible, bypassing the queue. */
  async emergencyStop() {
    if (!this.connected || !this.writer) return false;
    this._queue = this._queue.filter(l => !l.startsWith('ANGLE:') && l !== 'CENTER');
    try {
      // Wait for any in-flight write, then write directly.
      this._queue.unshift('STOP');
      await this._drain();
      return true;
    } catch { return false; }
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
