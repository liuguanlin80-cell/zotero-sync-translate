'use strict';
class CancellationSignal {
  constructor() { this.aborted = false; this.reason = undefined; this.listeners = new Map(); }
  addEventListener(type, listener, options = {}) {
    if (type !== 'abort' || this.aborted || !listener) return;
    if (typeof listener !== 'function' && typeof listener.handleEvent !== 'function') return;
    if (!this.listeners.has(listener)) this.listeners.set(listener, !!options?.once);
  }
  removeEventListener(type, listener) { if (type === 'abort') this.listeners.delete(listener); }
  throwIfAborted() { if (this.aborted) throw this.reason; }
  trigger(reason) {
    if (this.aborted) return;
    this.aborted = true;
    if (reason === undefined) { reason = new Error('CANCELLED'); reason.name = 'AbortError'; }
    this.reason = reason;
    const event = { type: 'abort', target: this, currentTarget: this };
    for (const listener of [...this.listeners.keys()]) {
      if (!this.listeners.has(listener)) continue;
      try { typeof listener === 'function' ? listener.call(this, event) : listener.handleEvent(event); }
      catch (_) { /* A failed cleanup must not prevent other cancellation hooks. */ }
    }
    this.listeners.clear();
  }
}
class CancellationController {
  constructor() { this.signal = new CancellationSignal(); }
  abort(reason) { this.signal.trigger(reason); }
}
module.exports = { CancellationController, CancellationSignal };
