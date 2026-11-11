'use strict';
function safeGet(fn, fallback) { try { const v = fn(); return v === undefined ? fallback : v; } catch (_) { return fallback; } }
function unwrap(value) { return safeGet(() => value.wrappedJSObject, null) || value; }
function canonical(text) {
  text = String(text || '');
  let value = '';
  const map = [];
  const re = /\P{M}\p{M}*|\p{M}+/gu;
  for (const m of text.matchAll(re)) {
    const normalized = m[0].normalize('NFKC').toLocaleLowerCase('en-US');
    for (const c of normalized) {
      if (!/[\p{L}\p{N}\p{M}]/u.test(c)) continue;
      value += c;
      for (let k = 0; k < c.length; k++) map.push({ start: m.index, end: m.index + m[0].length });
    }
  }
  return { value, map };
}
class LRU {
  constructor(limit = 100) { this.limit = limit; this.data = new Map(); }
  get(key) { if (!this.data.has(key)) return undefined; const v = this.data.get(key); this.data.delete(key); this.data.set(key, v); return v; }
  set(key, value) { this.data.delete(key); this.data.set(key, value); while (this.data.size > this.limit) this.data.delete(this.data.keys().next().value); }
  clear() { this.data.clear(); }
}

function abortError() { const e = new Error('CANCELLED'); e.name = 'AbortError'; return e; }
function checkAbort(signal) { if (signal?.aborted) throw abortError(); }
function hash(value) {
  value = String(value);
  let a = 2166136261, b = 5381;
  for (let i = 0; i < value.length; i++) { const c = value.charCodeAt(i); a = Math.imul(a ^ c, 16777619); b = (Math.imul(b, 33) + c) | 0; }
  return (a >>> 0).toString(36) + (b >>> 0).toString(36) + value.length.toString(36);
}
const LETTER = /[\p{L}\p{N}]/u;
function letterCount(text, a = 0, b = text.length) { let n = 0; for (let i = a; i < b; i++) if (LETTER.test(text[i])) n++; return n; }
module.exports = { safeGet, unwrap, canonical, LRU, abortError, checkAbort, hash, LETTER, letterCount };
