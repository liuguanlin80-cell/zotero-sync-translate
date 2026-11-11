'use strict';
const { safeGet } = require('./util');
const A = require('./align');

const PREFIX = 'extensions.zotero.SyncTranslate.';
const MAX_ALIGN = 4000, MAX_GLOSS = 6000;

/** Alignment cache (offsets only, no text), personal phrase table, and the daily token count. */
class Store {
  constructor(Zotero, env) {
    this.Z = Zotero; this.io = env.IOUtils; this.env = env;
    this.path = safeGet(() => env.PathUtils.join(Zotero.DataDirectory.dir, 'sync-translate.json'), '');
    this.data = { v: 1, align: {}, gloss: {}, ratio: {} };
    this.dirty = false; this.timer = null; this.glossSize = 0;
    this.logPath = safeGet(() => env.PathUtils.join(Zotero.DataDirectory.dir, 'sync-translate-log.json'), '');
    this.logData = null; this.logTimer = null;
  }
  async load() {
    if (!this.io || !this.path) return;
    try {
      const d = await this.io.readJSON(this.path);
      if (d?.v === 1) this.data = { v: 1, align: d.align || {}, gloss: d.gloss || {}, ratio: d.ratio || {} };
    } catch (_) {}
    this.glossSize = Object.values(this.data.gloss).reduce((n, table) => n + Object.keys(table).length, 0);
  }
  touch() {
    this.dirty = true;
    if (!this.timer) this.timer = this.env.setTimeout(() => { this.timer = null; this.flush(); }, 4000);
  }
  flush() {
    if (!this.dirty || !this.io || !this.path) return;
    this.dirty = false;
    safeGet(() => this.io.writeJSON(this.path, this.data, { tmpPath: this.path + '.tmp' }).catch(() => {}));
  }
  /** Recent activity, kept in a local file so a problem can be traced afterwards. */
  log(data) {
    this.logData = data;
    if (this.logTimer || !this.io || !this.logPath) return;
    this.logTimer = this.env.setTimeout(() => {
      this.logTimer = null;
      safeGet(() => this.io.writeJSON(this.logPath, this.logData).catch(() => {}));
    }, 1500);
  }
  getAlign(key) {
    const entry = this.data.align[key];
    if (!entry) return null;
    entry.t = Date.now();
    return entry.l;
  }
  putAlign(key, links) {
    this.data.align[key] = { t: Date.now(), l: links };
    const keys = Object.keys(this.data.align);
    if (keys.length > MAX_ALIGN) {
      keys.sort((x, y) => this.data.align[x].t - this.data.align[y].t);
      for (const k of keys.slice(0, 500)) delete this.data.align[k];
    }
    this.touch();
  }
  /** Typical translation/source length ratio seen for a language pair; steadies sentence pairing. */
  ratio(lang) { return this.data.ratio[lang] || null; }
  learnRatio(lang, value) {
    if (!(value > 0.02 && value < 50)) return;
    const old = this.data.ratio[lang];
    this.data.ratio[lang] = old ? old * 0.8 + value * 0.2 : value;
    this.touch();
  }
  learn(lang, source, target) {
    const s = A.norm(String(source || '')).v.trim(), t = String(target || '').trim();
    if (!s || !t || t.length > 24 || s === t.toLowerCase()) return;
    if (A.isCJK(s)) { if (s.length < 2 || s.length > 12) return; }
    else {
      const words = s.split(' ');
      if (words.length > 5 || s.length > 60 || !words.some(w => w.replace(/[^\p{L}]/gu, '').length >= 4)) return;
    }
    const table = this.data.gloss[lang] || (this.data.gloss[lang] = {});
    if (!table[s]) {
      table[s] = {}; this.glossSize++;
      if (this.glossSize > MAX_GLOSS) {
        for (const k of Object.keys(table).slice(0, 1000)) { delete table[k]; this.glossSize--; }
      }
    }
    table[s][t] = (table[s][t] || 0) + 1;
    this.touch();
  }
  /** Known phrase pairs that occur exactly once on each side. Offsets are relative to the two texts. */
  glossLinks(lang, sText, tText) {
    const table = this.data.gloss[lang];
    if (!table) return [];
    const hs = A.norm(sText), ht = A.norm(tText), found = [];
    for (const s in table) {
      if (!hs.v.includes(s)) continue;
      const so = A.findAll(hs, sText, s);
      if (so.length !== 1) continue;
      for (const [t] of Object.entries(table[s]).sort((x, y) => y[1] - x[1])) {
        const to = A.findAll(ht, tText, t);
        if (to.length === 1) { found.push([so[0][0], so[0][1], to[0][0], to[0][1]]); break; }
      }
    }
    found.sort((x, y) => (y[1] - y[0]) - (x[1] - x[0]));
    const kept = [];
    for (const l of found) {
      if (!kept.some(k => (l[0] < k[1] && l[1] > k[0]) || (l[2] < k[3] && l[3] > k[2]))) kept.push(l);
    }
    return kept;
  }
  clear(kind) {
    if (kind === 'gloss') { this.data.gloss = {}; this.glossSize = 0; } else this.data.align = {};
    this.touch();
  }
  counts() { return { align: Object.keys(this.data.align).length, gloss: this.glossSize }; }

  pref(key, fallback) { const v = safeGet(() => this.Z.Prefs.get(PREFIX + key, true), undefined); return v === undefined ? fallback : v; }
  today() { const d = new Date(); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }
  used() { return this.pref('usedDay', '') === this.today() ? Number(this.pref('usedToday', 0)) || 0 : 0; }
  spend(tokens) {
    tokens = Math.max(0, Math.round(Number(tokens) || 0));
    if (!tokens) return;
    const total = this.used() + tokens;
    safeGet(() => { this.Z.Prefs.set(PREFIX + 'usedDay', this.today(), true); this.Z.Prefs.set(PREFIX + 'usedToday', total, true); });
  }
  allowed() { const cap = Number(this.pref('capDaily', 0)) || 0; return !cap || this.used() < cap; }
  dispose() {
    if (this.timer) this.env.clearTimeout(this.timer);
    if (this.logTimer) this.env.clearTimeout(this.logTimer);
    this.timer = this.logTimer = null; this.flush();
  }
}

module.exports = { Store };
