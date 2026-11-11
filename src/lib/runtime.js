'use strict';
const { CancellationController } = require('./cancellation');
const { safeGet, unwrap, canonical, hash, letterCount } = require('./util');
const { sourceGeometryFromCaptures } = require('./geom');
const A = require('./align');
const { TFZ, Aligner, groupKey, applyLinks } = require('./provider');
const { Store } = require('./store');
const { PDFAdapter, html } = require('./pdf');
const { TextSurface, HighlightPalette, AlignmentIndicator } = require('./surface');

const ID = 'sync-translate-companion@local.zotero';
/** The same document can be reached through different wrapper objects. */
const sameDoc = (a, b) => unwrap(a) === unwrap(b);
const PREFIX = 'extensions.zotero.SyncTranslate.';
const DEFAULTS = { enabled: true, alignSource: 'auto', alignEndpoint: '', alignModel: '', alignApiKey: '',
  reverse: true, reverseCtrl: false, capDaily: 0 };
const OBSOLETE = ['aiEnabled', 'mode', 'alignProvider', 'minConfidence', 'maxProbeRequests', 'timeoutMs', 'maxTokens',
  'maxSourceChars', 'pollMs', 'allowNetwork'];
const TEXT = {
  pending: ['Aligning…', '对齐中…'],
  fail: ['Align failed', '对齐失败'],
  cap: ['Daily cap reached', '已达今日上限'],
  nogeo: ['No PDF coords', '无 PDF 坐标'],
  nomark: ['Highlight failed', '高亮失败'],
  none: ['Not in the selection', '所选原文之外'],
  retry: ['Retry', '重试'],
  button: ['Sync', '对齐'],
  toggle: ['Pause / resume', '暂停 / 恢复']
};

/** The block added to the reader's selection popup when a word inside a translated passage is selected. */
class Card {
  constructor(doc) {
    this.doc = doc; this.removed = false; this.seen = false;
    const node = this.node = html(doc, 'div');
    node.className = 'sync-translate-card';
    node.style.cssText = 'display:none;box-sizing:border-box;margin:6px 2px 2px;padding:6px 8px;border-radius:6px;max-width:360px;' +
      'background:var(--color-sidepane,rgba(128,128,128,.12));font-size:12px;line-height:1.5;white-space:normal;' +
      'word-break:break-word;user-select:text;-moz-user-select:text;';
    this.head = html(doc, 'div'); this.head.style.cssText = 'font-weight:600;margin-bottom:2px;';
    this.body = html(doc, 'div');
    this.foot = html(doc, 'div'); this.foot.style.cssText = 'opacity:.65;font-size:11px;margin-top:2px;';
    node.append(this.head, this.body, this.foot);
  }
  alive() {
    if (this.node.isConnected) this.seen = true;
    return !this.removed && !(this.seen && !this.node.isConnected);
  }
  render({ head, sentence, marks, status, retry, retryLabel }) {
    this.node.style.display = '';
    this.head.textContent = head || ''; this.head.style.display = head ? '' : 'none';
    this.body.replaceChildren();
    let at = 0;
    for (const [a, b] of [...marks].sort((x, y) => x[0] - y[0])) {
      if (a < at) continue;
      if (a > at) this.body.append(sentence.slice(at, a));
      const mark = html(this.doc, 'mark');
      mark.style.cssText = 'background:rgba(255,181,35,.5);color:inherit;border-radius:2px;padding:0 1px;';
      mark.textContent = sentence.slice(a, b);
      this.body.append(mark); at = b;
    }
    if (at < sentence.length) this.body.append(sentence.slice(at));
    this.foot.replaceChildren(); this.foot.style.display = status ? '' : 'none';
    if (!status) return;
    this.foot.append(status);
    if (retry) {
      const link = html(this.doc, 'a');
      link.textContent = retryLabel; link.style.cssText = 'cursor:pointer;text-decoration:underline;margin-left:6px;';
      link.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); retry(); });
      this.foot.append(link);
    }
  }
  remove() { this.removed = true; safeGet(() => this.node.remove()); }
}

class Companion {
  constructor(Zotero, meta, env) {
    this.Z = Zotero; this.meta = meta || {}; this.zh = /^zh/i.test(String(Zotero.locale || ''));
    this.tfz = new TFZ(Zotero); this.store = new Store(Zotero, env);
    this.prefs = this.readPrefs();
    this.events = [];
    this.aligner = new Aligner(Zotero, this.tfz, this.store, () => this.prefs, (type, data) => this.trace(type, data));
    this.readers = new Map(); this.documents = new Map(); this.records = new Map();
    this.listeners = []; this.buttons = new Set();
    this.paused = false; this.disposed = false; this.busy = false; this.errors = 0;
    this.drag = null; this.active = null; this.pointer = null; this.shownKey = '';
    this.hotUntil = 0; this.timer = null; this.wantTimer = null; this.paneID = null;
    this.hovering = false; this.hover = { moves: 0, points: 0, hits: 0 }; this.ctrlTimer = null; this.leaveTimer = null;
  }
  t(key) { return TEXT[key][this.zh ? 1 : 0]; }
  on() { return this.prefs.enabled && !this.paused; }
  log(where, error) {
    safeGet(() => this.Z.debug('[SyncTranslate] ' + where + ': ' + (error?.message || error)));
    if (this.errors++ < 5) safeGet(() => this.Z.logError(error));
  }
  trace(type, data) {
    this.events.push({ at: new Date().toTimeString().slice(0, 8), type, ...data });
    if (this.events.length > 80) this.events.shift();
    this.store.log({ version: this.meta.version || '', hover: this.hover, events: this.events });
  }
  getPref(key, fallback) { const v = safeGet(() => this.Z.Prefs.get(PREFIX + key, true), undefined); return v === undefined ? fallback : v; }
  setPref(key, value) { safeGet(() => this.Z.Prefs.set(PREFIX + key, value, true)); }
  readPrefs() {
    const out = {};
    for (const [key, fallback] of Object.entries(DEFAULTS)) out[key] = this.getPref(key, fallback);
    if (!['auto', 'off', 'custom', 'jev'].includes(out.alignSource)) out.alignSource = 'auto';
    for (const key of ['alignEndpoint', 'alignModel', 'alignApiKey']) out[key] = String(out[key] || '').trim();
    out.capDaily = Math.max(0, Number(out.capDaily) || 0);
    return out;
  }
  migrate() {
    if (Number(this.getPref('schema', 0)) >= 4) return;
    this.setPref('enabled', true);
    this.setPref('alignSource', this.getPref('alignProvider', '') === 'openai' ? 'custom' : 'auto');
    for (const key of OBSOLETE) safeGet(() => this.Z.Prefs.clear(PREFIX + key, true));
    this.setPref('schema', 4);
  }

  start() {
    this.migrate(); this.prefs = this.readPrefs();
    this.store.load().catch(() => {});
    const bind = (type, fn) => { this.Z.Reader.registerEventListener(type, fn, ID); this.listeners.push([type, fn]); };
    bind('renderTextSelectionPopup', e => { safeGet(() => this.onPopup(e).catch(err => this.log('popup', err))); });
    bind('renderToolbar', e => { safeGet(() => this.onToolbar(e)); });
    safeGet(() => Promise.resolve(this.Z.PreferencePanes.register({ pluginID: ID, label: 'Sync Translate',
      src: 'content/preferences.xhtml', scripts: ['content/preferences.js'] })).then(id => {
      if (this.disposed) safeGet(() => this.Z.PreferencePanes.unregister(id)); else this.paneID = id;
    }).catch(() => {}));
    this.Z.SyncTranslateCompanion = this;
    this.loop();
    return this;
  }
  loop() {
    if (this.disposed) return;
    this.tick();
    this.timer = setTimeout(() => this.loop(), Date.now() < this.hotUntil ? 80 : 400);
  }
  /** Check often for a few seconds: a selection was made or a translation is running. */
  heat(ms = 4000) {
    const wasHot = Date.now() < this.hotUntil;
    this.hotUntil = Math.max(this.hotUntil, Date.now() + ms);
    if (!wasHot && !this.disposed) { clearTimeout(this.timer); this.timer = setTimeout(() => this.loop(), 30); }
  }

  isPDF(reader) { return safeGet(() => reader.type || reader._type, 'pdf') === 'pdf'; }
  ensureReader(reader) {
    let state = this.readers.get(reader);
    if (state) return state;
    state = { reader, captures: [], passages: new Map(), subs: new Set(), capCtl: null, capError: '',
      lastSel: '', lastSelAt: 0, lastHit: null, born: Date.now(), refreshed: Date.now() };
    this.readers.set(reader, state);
    state.pdf = new PDFAdapter(reader, (doc, pdf) => this.watch(doc, pdf));
    const doc = safeGet(() => unwrap(reader._iframeWindow).document, null);
    if (doc) this.watch(doc);
    return state;
  }
  dropReader(reader) {
    const state = this.readers.get(reader);
    if (!state) return;
    state.capCtl?.abort();
    for (const p of state.passages.values()) p.dead = true;
    for (const [el, r] of this.records) if (r.passage.state === state) this.dropRecord(el);
    state.pdf.dispose(); state.captures = []; state.passages.clear();
    this.readers.delete(reader);
  }
  dropRecord(element) {
    const r = this.records.get(element);
    if (!r) return;
    if (this.active?.record === r || this.drag?.record === r) this.clearInteraction();
    r.indicator.dispose(); r.palette.dispose(); r.surface.dispose();
    this.records.delete(element);
  }
  dropRecords() { this.clearInteraction(); for (const el of [...this.records.keys()]) this.dropRecord(el); }
  syncReaders() {
    const live = safeGet(() => this.Z.Reader._readers, null);
    if (!Array.isArray(live)) return;
    for (const reader of live) if (this.isPDF(reader)) this.ensureReader(reader);
    for (const [reader, state] of this.readers) if (!live.includes(reader) && Date.now() - state.born > 1200) this.dropReader(reader);
  }
  syncButtons() {
    for (const button of this.buttons) {
      if (!button.isConnected) { this.buttons.delete(button); continue; }
      button.setAttribute('aria-pressed', String(this.on())); button.style.opacity = this.on() ? '1' : '.45';
    }
  }
  onToolbar(event) {
    if (!this.isPDF(event.reader)) return;
    this.ensureReader(event.reader); this.watch(event.doc);
    const button = html(event.doc, 'button');
    button.className = 'toolbar-button sync-translate-toggle';
    button.textContent = this.t('button'); button.title = this.t('toggle');
    button.addEventListener('click', () => {
      if (!this.prefs.enabled) { this.setPref('enabled', true); this.prefs.enabled = true; this.paused = false; }
      else this.paused = !this.paused;
      if (!this.on()) this.dropRecords();
      this.syncButtons(); this.heat();
    });
    event.append(button); this.buttons.add(button); this.syncButtons();
  }
  collectDocs(readers) {
    const docs = new Set();
    const add = doc => { if (doc?.documentElement && !safeGet(() => doc.defaultView.closed, false)) docs.add(doc); };
    const wins = safeGet(() => this.Z.getMainWindows(), null) || [safeGet(() => this.Z.getMainWindow(), null)];
    for (const win of wins) add(win?.document);
    for (const reader of readers) {
      add(safeGet(() => unwrap(reader._iframeWindow).document, null));
      add(safeGet(() => reader._window.document, null));
    }
    add(safeGet(() => this.tfz.addon().data.panel.windowPanel.document, null));
    return docs;
  }

  tick() {
    if (this.disposed || this.busy) return;
    this.busy = true;
    try {
      const was = this.prefs;
      this.prefs = this.readPrefs();
      if (['alignSource', 'alignEndpoint', 'alignModel', 'alignApiKey'].some(k => was[k] !== this.prefs[k])) {
        for (const state of this.readers.values()) for (const p of state.passages.values()) {
          for (const g of p.groups) if (!g.done) { g.note = ''; g.failAt = 0; }
        }
      }
      this.syncReaders(); this.syncButtons();
      if (!this.on() || !this.tfz.available()) { if (this.records.size) this.dropRecords(); return; }
      if (this.drag) return;
      const now = Date.now(), readers = [...this.readers.keys()], docs = this.collectDocs(readers);
      for (const doc of docs) this.watch(doc);
      const live = new Set([...docs].map(unwrap));
      for (const [id, b] of this.documents) if (safeGet(() => b.win.closed, true) || (!b.pdf && !live.has(id))) this.unwatch(b.doc);
      for (const state of this.readers.values()) {
        if (!state.pdf.views.length || now - state.refreshed > 2000) { state.pdf.refresh(); state.refreshed = now; }
      }
      if (this.tfz.busy()) this.heat(1500);
      const seen = new Set();
      for (const d of this.tfz.surfaces(docs, readers)) {
        const state = this.readers.get(d.reader);
        const p = state && this.passage(state, d.task);
        if (!p) continue;
        let record = this.records.get(d.element);
        if (record?.passage !== p) {
          this.dropRecord(d.element);
          const surface = new TextSurface(d.element, p.result, p.tTokens);
          record = { surface, indicator: new AlignmentIndicator(surface), palette: new HighlightPalette(surface), passage: p };
          this.records.set(d.element, record);
        }
        seen.add(d.element);
      }
      for (const el of [...this.records.keys()]) if (!seen.has(el)) this.dropRecord(el);
    } catch (error) { this.log('tick', error); }
    finally { this.busy = false; }
  }

  /** One translated selection: its text, sentence groups, alignment links and PDF coordinates. */
  passage(state, task) {
    const key = task.id + '|' + hash(task.raw + '\u0001' + task.result);
    let p = state.passages.get(key);
    if (p) { this.geo(p); return p; }
    if (task.raw.length > 20000 || task.result.length > 20000) return null;
    if (state.subs.has(canonical(task.raw).value)) return null;
    p = { key, state, raw: task.raw, result: task.result, langfrom: task.langfrom, langto: task.langto, service: task.service,
      groups: A.segment(task.raw, task.result, this.store.ratio(task.langfrom + '>' + task.langto)), sTokens: A.tokenize(task.raw, task.langfrom),
      tTokens: A.tokenize(task.result, task.langto), n: letterCount(task.raw),
      geometry: null, inverse: null, pages: null, hit: null, used: false, dead: false };
    const lang = p.langfrom + '>' + p.langto;
    if (p.groups.ratio) this.store.learnRatio(lang, p.groups.ratio);
    this.trace('passage', p.groups.stats || { pairs: p.groups.length });
    for (const g of p.groups) {
      const cached = this.store.getAlign(groupKey(p, g));
      if (cached) { applyLinks(g, cached); continue; }
      for (const l of this.store.glossLinks(lang, p.raw.slice(g.s[0], g.s[1]), p.result.slice(g.t[0], g.t[1]))) {
        g.links.push({ s: [g.s[0] + l[0], g.s[0] + l[1]], t: [g.t[0] + l[2], g.t[0] + l[3]], k: 'g' });
      }
    }
    this.geo(p);
    state.passages.set(key, p);
    while (state.passages.size > 30) {
      const [oldKey, old] = state.passages.entries().next().value;
      old.dead = true; state.passages.delete(oldKey);
    }
    this.bump('statShown');
    if (this.eager()) {
      const g = p.groups.find(x => !x.done);
      if (g) this.aligner.ensure(p, g, () => this.refresh(p));
    }
    return p;
  }
  geo(p) {
    if (p.geometry) return true;
    const geometry = sourceGeometryFromCaptures(p.raw, p.state.captures);
    if (!geometry) return false;
    p.geometry = geometry; p.inverse = new Map(); p.pages = new Set(); p.hit = null;
    geometry.map.forEach((glyphs, offset) => {
      for (const g of glyphs) {
        const key = g.pageIndex + ':' + g.charIndex;
        if (!p.inverse.has(key)) p.inverse.set(key, offset);
        p.pages.add(g.pageIndex);
      }
    });
    return true;
  }
  /** People who check most translations get the first sentence aligned ahead of time. */
  eager() {
    const shown = Number(this.getPref('statShown', 0)) || 0, used = Number(this.getPref('statUsed', 0)) || 0;
    return shown >= 20 && used / shown >= 0.6;
  }
  bump(key) {
    let shown = Number(this.getPref('statShown', 0)) || 0, used = Number(this.getPref('statUsed', 0)) || 0;
    if (key === 'statShown') shown++; else used++;
    if (shown > 200) { shown = Math.round(shown / 2); used = Math.round(used / 2); }
    this.setPref('statShown', shown); this.setPref('statUsed', Math.min(used, shown));
  }

  onPopup(event) {
    if (this.disposed || !this.on() || !this.isPDF(event.reader)) return Promise.resolve();
    const state = this.ensureReader(event.reader);
    this.watch(event.doc);
    const annotation = event.params?.annotation, text = String(annotation?.text || '').trim();
    if (!text || text.length > 20000) return Promise.resolve();
    const identity = text + '|' + JSON.stringify(annotation.position || {});
    const page = annotation.position?.pageIndex;
    const short = text.length <= 80 && [...state.passages.values()].some(p => p.pages?.has(page) && p.n > 1.5 * letterCount(text));
    const addCard = () => {
      state.card = null;
      if (!short) return;
      state.card = new Card(event.doc);
      safeGet(() => event.append(state.card.node));
    };
    // The reader re-renders the popup, and with it this event, for an unchanged selection.
    if (identity === state.lastSel && !state.capError) {
      addCard();
      if (state.card && state.lastHit) this.subSelect(state.lastHit, state.card, text);
      return Promise.resolve();
    }
    state.lastSel = identity; state.lastHit = null;
    this.clearInteraction();
    addCard();
    state.capCtl?.abort();
    const ctl = state.capCtl = new CancellationController();
    this.heat();
    return (async () => {
      let capture;
      try { capture = await state.pdf.capture(annotation, ctl.signal); }
      catch (error) {
        if (error?.name === 'AbortError') return;
        state.card?.remove();
        state.capError = String(error?.message || 'PDF_COORDS'); this.log('capture', error);
        return;
      }
      if (ctl.signal.aborted || this.disposed) return;
      state.captures = state.captures.filter(c => c.signature !== capture.signature);
      state.captures.push(capture);
      while (state.captures.length > 16) state.captures.shift();
      state.capError = '';
      const hit = short && this.enclosing(state, capture);
      if (hit) {
        if (state.subs.size > 50) state.subs.clear();
        state.subs.add(canonical(text).value);
        state.lastHit = hit;
        if (state.card) this.subSelect(hit, state.card, text);
      } else state.card?.remove();
      this.heat();
    })();
  }
  /** The translated passage that fully contains a new PDF selection, with the selection's source range. */
  enclosing(state, capture) {
    const keys = new Set();
    for (const g of capture.geometry.map) if (g) keys.add(g.pageIndex + ':' + g.charIndex);
    if (!keys.size) return null;
    for (const p of [...state.passages.values()].reverse()) {
      if (!p.inverse) continue;
      let lo = Infinity, hi = -1, inside = 0;
      for (const key of keys) {
        const offset = p.inverse.get(key);
        if (offset === undefined) continue;
        inside++; lo = Math.min(lo, offset); hi = Math.max(hi, offset);
      }
      if (inside >= 0.8 * keys.size && letterCount(p.raw, lo, hi + 1) * 1.5 < p.n) return { p, a: lo, b: hi + 1 };
    }
    return null;
  }
  subSelect({ p, a, b }, card, text) {
    const tokens = p.sTokens.filter(t => t.start < b && t.end > a);
    if (tokens.length) { a = tokens[0].start; b = tokens[tokens.length - 1].end; }
    const g = p.groups.find(x => a < x.s[1] && b > x.s[0]);
    if (!g) { card.remove(); return; }
    const sentence = p.result.slice(g.t[0], g.t[1]);
    let settled = false;
    const render = () => {
      if (this.disposed || !card.alive()) return;
      const fine = A.resolve(p, 's', a, b).items.filter(i => !i.coarse && i.t[0] >= g.t[0] && i.t[1] <= g.t[1]);
      const marks = fine.map(i => [i.t[0] - g.t[0], i.t[1] - g.t[0]]);
      let status = '';
      if (!fine.length && settled && g.done) this.aligner.lookup(p, g, 's', a, b, render);
      if (!fine.length) {
        if (g.pending || g.looking || !settled) status = this.t('pending');
        else if (g.note === 'fail') status = this.t('fail');
        else if (g.note === 'cap') status = this.t('cap');
      }
      card.render({ head: marks.map(m => sentence.slice(m[0], m[1])).join(' … '), sentence, marks, status,
        retry: status && g.note === 'fail' && !g.pending ? () => { g.failAt = 0; request(); } : null, retryLabel: this.t('retry') });
    };
    const request = () => { settled = true; this.aligner.ensure(p, g, render); render(); };
    if (!A.resolve(p, 's', a, b).need.length) { settled = true; render(); return; }
    render();
    const started = Date.now();
    const poll = () => {
      if (this.disposed || !card.alive()) return;
      const found = this.tfz.resultFor(text);
      if (found) {
        const link = A.candidateLink(p, g, a, b, A.candidatesFrom(found.result, found.word));
        if (link) {
          if (!g.links.some(l => l.k === 'd' && l.s[0] === link.s[0] && l.t[0] === link.t[0])) g.links.push(link);
          this.store.learn(p.langfrom + '>' + p.langto, p.raw.slice(a, b), p.result.slice(link.t[0], link.t[1]));
          settled = true; render(); return;
        }
      }
      if (found || Date.now() - started > 800) { request(); return; }
      setTimeout(poll, 60);
    };
    poll();
  }

  watch(doc, pdf = null) {
    if (!doc?.defaultView) return () => {};
    const id = unwrap(doc);
    let b = this.documents.get(id);
    if (b) { if (pdf) b.pdf = pdf; return () => {}; }
    const win = doc.defaultView;
    b = { doc, win, pdf, events: [], frame: 0, pending: null, selFrame: 0 };
    this.documents.set(id, b);
    const on = (target, type, fn, capture = false) => { target.addEventListener(type, fn, capture); b.events.push([target, type, fn, capture]); };
    // Events inside the reader also travel up to the main window; each document handles only its own.
    const mine = e => {
      const t = e.target, owner = t?.ownerDocument || (t?.nodeType === 9 ? t : null);
      return !owner || unwrap(owner) === id;
    };
    const queue = record => {
      if (!record || b.selFrame) return;
      b.selFrame = win.requestAnimationFrame(() => {
        b.selFrame = 0;
        if (this.disposed) return;
        const focused = this.recordFor(doc, doc.activeElement) === record;
        if (this.drag?.doc === doc || this.active?.record === record || focused) this.syncSelection(record);
      });
    };
    on(doc, 'pointermove', e => {
      if (!mine(e)) return;
      b.pending = { target: e.target, clientX: e.clientX, clientY: e.clientY, ctrlKey: e.ctrlKey, buttons: e.buttons, doc, pdf: b.pdf };
      if (b.frame) return;
      b.frame = win.requestAnimationFrame(() => {
        b.frame = 0;
        const pointer = b.pending; b.pending = null;
        if (pointer && !this.disposed) this.move(pointer);
      });
    }, true);
    on(doc, 'pointerdown', e => {
      if (!mine(e)) return;
      if ([...this.records.values()].some(r => sameDoc(r.surface.doc, doc) && r.palette.contains(e.target))) { e.preventDefault(); return; }
      if (b.pdf) b.pdf.pdfPoint(e);
      if (!this.on() || e.button !== 0) return;
      const record = this.recordFor(doc, e.target);
      if (!record) { if (this.active && sameDoc(this.active.record.surface.doc, doc)) this.clearInteraction(); return; }
      this.hovering = false; this.clearHighlights(); this.active = null;
      this.drag = { doc, record };
      queue(record);
    }, true);
    on(doc, 'select', e => { if (mine(e)) queue(this.recordFor(doc, e.target) || (this.drag?.doc === doc ? this.drag.record : null)); }, true);
    on(doc, 'selectionchange', e => {
      if (mine(e)) queue((this.drag?.doc === doc ? this.drag.record : null) || this.recordFor(doc, doc.activeElement) ||
        (this.active && sameDoc(this.active.record.surface.doc, doc) ? this.active.record : null));
    }, true);
    on(doc, 'pointerup', e => {
      if (!mine(e) || e.button !== 0 || this.drag?.doc !== doc) return;
      const drag = this.drag; this.drag = null;
      win.requestAnimationFrame(() => { if (!this.disposed) this.syncSelection(drag.record); });
    }, true);
    on(doc, 'pointercancel', () => { if (this.drag?.doc === doc) this.drag = null; }, true);
    on(doc, 'keydown', e => {
      if (!mine(e)) return;
      if (e.key === 'Escape') this.clearInteraction();
      // Ctrl held on its own for a moment looks up the word under the pointer; Ctrl+C and the like do not.
      clearTimeout(this.ctrlTimer);
      if (e.key === 'Control' && !e.repeat && this.pointer) {
        this.ctrlTimer = setTimeout(() => { if (!this.disposed && this.pointer) this.move({ ...this.pointer, ctrlKey: true }); }, 250);
      }
    }, true);
    on(doc, 'keyup', e => {
      if (!mine(e) || e.key !== 'Control') return;
      clearTimeout(this.ctrlTimer);
      if (this.prefs.reverseCtrl) this.endHover();
      else if (this.pointer) this.move({ ...this.pointer, ctrlKey: false });
    }, true);
    on(win, 'blur', () => this.clearInteraction());
    on(doc, 'visibilitychange', () => { if (doc.hidden) this.clearInteraction(); });
    const layout = e => {
      if (e && !mine(e)) return;
      for (const r of this.records.values()) if (sameDoc(r.surface.doc, doc)) { r.surface.sync(true); r.indicator.position(); r.palette.position(); }
      b.pdf?.redraw();
    };
    on(doc, 'scroll', layout, true); on(win, 'resize', layout);
    on(win, 'unload', () => this.unwatch(doc), { once: true });
    return () => this.unwatch(doc);
  }
  unwatch(doc) {
    const id = unwrap(doc), b = this.documents.get(id);
    if (!b) return;
    for (const [target, type, fn, capture] of b.events) safeGet(() => target.removeEventListener(type, fn, capture));
    if (b.frame) safeGet(() => b.win.cancelAnimationFrame(b.frame));
    if (b.selFrame) safeGet(() => b.win.cancelAnimationFrame(b.selFrame));
    this.documents.delete(id);
    for (const [el, r] of this.records) if (sameDoc(r.surface.doc, doc)) this.dropRecord(el);
    if (this.pointer?.doc === b.doc || this.drag?.doc === b.doc) this.clearInteraction();
  }
  recordFor(doc, node) {
    for (const r of this.records.values()) if (sameDoc(r.surface.doc, doc) && !r.passage.dead && r.surface.containsNode(node)) return r;
    return null;
  }

  syncSelection(record) {
    if (!record || record.passage.dead || !this.records.has(record.surface.element)) return;
    const sel = record.surface.selection();
    if (!sel || sel.start >= sel.end) {
      if (this.active?.record === record || this.drag?.record === record) { this.clearHighlights(); this.active = null; }
      return;
    }
    this.active = { record, start: sel.start, end: sel.end };
    if (!this.hovering) this.showForward(record, sel.start, sel.end);
  }
  /** Translation selection -> PDF source. */
  showForward(record, a, b) {
    const p = record.passage, state = p.state;
    this.geo(p);
    const r = A.resolve(p, 't', a, b);
    if (!r.items.length) {
      this.clearHighlights();
      if (letterCount(p.result, a, b)) record.indicator.set(this.t('none'));
      return;
    }
    this.want(p, r.need, () => this.note(record, r.need));
    if (!this.drag && b - a <= 12) for (const m of r.miss) this.aligner.lookup(p, m.g, 't', m.lo, m.hi, () => this.refresh(p));
    this.note(record, [...r.need, ...r.miss.map(m => m.g)]);
    if (!p.geometry) { record.indicator.set(this.t('nogeo'), state.capError); return; }
    const ranges = A.mergeRanges(r.items.map(i => ({ a: i.s[0], b: i.s[1], coarse: i.coarse })), p.raw);
    const glyphs = A.glyphsForRanges(ranges, p.geometry.map);
    if (!glyphs.length) { record.indicator.set(this.t('nogeo')); return; }
    const key = p.key + '|t|' + ranges.map(x => x.a + '-' + x.b + (x.coarse ? 'c' : '')).join(',');
    if (this.shownKey !== key) {
      this.shownKey = key;
      for (const s of this.readers.values()) if (s !== state && s.pdf.glyphs.length) s.pdf.clear();
      state.pdf.show(glyphs);
    }
    if (this.drag) { record.palette.hide(); return; }
    const quote = ranges.map(x => p.raw.slice(x.a, x.b)).join(' … ');
    record.palette.show(record.surface.selection(), async color => {
      const ok = await state.pdf.createPermanentHighlight(glyphs, color, quote);
      if (ok) state.pdf.clearTemporary(); else record.indicator.set(this.t('nomark'), state.pdf.lastAnnotationError);
      return ok;
    });
  }
  /** PDF word under the pointer -> translation. */
  showReverse(record, offset, intent) {
    const p = record.passage;
    const token = p.sTokens.find(t => offset >= t.start && offset < t.end);
    if (!token?.word) { if (this.shownKey) this.clearHighlights(); return; }
    const r = A.resolve(p, 's', token.start, token.end);
    if (!r.items.length) { if (this.shownKey) this.clearHighlights(); return; }
    if (intent) {
      this.want(p, r.need, () => this.note(record, r.need));
      for (const m of r.miss) this.aligner.lookup(p, m.g, 's', token.start, token.end, () => this.refresh(p));
      this.note(record, [...r.need, ...r.miss.map(m => m.g)]);
    }
    const key = p.key + '|s|' + token.start + '|' + r.items.map(i => i.t[0] + '-' + i.t[1] + (i.coarse ? 'c' : '')).join(',');
    if (this.shownKey === key) return;
    this.shownKey = key;
    // The word under the pointer is always outlined, so it is clear what was picked up.
    const ranges = A.mergeRanges([...r.items.map(i => ({ a: i.s[0], b: i.s[1], coarse: i.coarse })),
      { a: token.start, b: token.end, coarse: false }], p.raw);
    p.state.pdf.show(A.glyphsForRanges(ranges, p.geometry.map));
    const marks = A.mergeRanges(r.items.map(i => ({ a: i.t[0], b: i.t[1], coarse: i.coarse })), p.result).map(x => [x.a, x.b, x.coarse]);
    for (const other of this.records.values()) if (other.passage === p) other.surface.highlightRanges(marks);
    const fine = r.items.filter(i => !i.coarse);
    this.trace('hover', { word: token.text, to: fine.length ? fine.map(i => p.result.slice(i.t[0], i.t[1])).join('+') : '',
      state: fine.length ? 'word' : r.need.length ? 'sentence-waiting' : r.miss.length ? 'sentence-unpaired' : 'sentence' });
  }
  /** Ask for fine alignment of sentence groups; while dragging, wait until the selection settles. */
  want(p, groups, after) {
    if (this.wantTimer) { clearTimeout(this.wantTimer); this.wantTimer = null; }
    if (!groups.length) return;
    const go = () => {
      this.wantTimer = null;
      if (this.disposed || p.dead) return;
      if (!p.used) { p.used = true; this.bump('statUsed'); }
      for (const g of groups) this.aligner.ensure(p, g, () => this.refresh(p));
      safeGet(() => after?.());
    };
    if (this.drag) this.wantTimer = setTimeout(go, 120); else go();
  }
  note(record, groups) {
    let text = '', title = '';
    const failed = groups.find(g => g.note === 'fail');
    if (groups.some(g => g.pending || g.looking)) text = this.t('pending');
    else if (failed) { text = this.t('fail'); title = failed.error || ''; }
    else if (groups.some(g => g.note === 'cap')) text = this.t('cap');
    record.indicator.set(text, title);
  }
  refresh(p) {
    if (this.disposed || p.dead) return;
    if (this.active?.record.passage === p) {
      this.shownKey = '';
      this.showForward(this.active.record, this.active.start, this.active.end);
    } else if (this.pointer && !this.active) { this.shownKey = ''; this.move(this.pointer); }
  }
  sourceHit(pdf, point) {
    for (const record of this.records.values()) {
      const p = record.passage;
      if (p.state.pdf !== pdf || !p.geometry) continue;
      if (!p.hit) {
        p.hit = new Map();
        const seen = new Set();
        p.geometry.map.forEach((glyphs, offset) => {
          for (const g of glyphs) {
            const key = g.pageIndex + ':' + g.charIndex;
            if (seen.has(key)) continue;
            seen.add(key);
            if (!p.hit.has(g.pageIndex)) p.hit.set(g.pageIndex, []);
            const h = g.hitRect || g.rect;
            p.hit.get(g.pageIndex).push({ r: [h[0], Math.min(h[1], g.rect[1]), h[2], Math.max(h[3], g.rect[3])], offset });
          }
        });
      }
      // Nearest character on the line, so the gaps between letters and words still count.
      let best = null, bestD = Infinity;
      for (const { r, offset } of p.hit.get(point.pageIndex) || []) {
        const dx = Math.max(r[0] - point.x, 0, point.x - r[2]), dy = Math.max(r[1] - point.y, 0, point.y - r[3]);
        if (dx > 4 || dy > 2) continue;
        const d = dx + dy * 3;
        if (d < bestD) { bestD = d; best = offset; }
      }
      if (best !== null) return { record, offset: best };
    }
    return null;
  }
  move(pointer) {
    if (this.disposed || !this.on()) return;
    this.pointer = pointer;
    if (this.drag?.doc === pointer.doc) {
      const drag = this.drag;
      if (Number.isFinite(pointer.buttons) && !(pointer.buttons & 1)) this.drag = null;
      this.syncSelection(drag.record);
      return;
    }
    // A selection in the translation stays shown; holding Ctrl over the PDF looks up a word regardless.
    if (this.active && !pointer.ctrlKey && !this.hovering) return;
    if (pointer.pdf && this.prefs.reverse && (pointer.ctrlKey || (!this.prefs.reverseCtrl && !this.active))) {
      this.hover.moves++;
      const point = pointer.pdf.pdfPoint(pointer);
      if (point) this.hover.points++;
      const hit = point && this.sourceHit(pointer.pdf, point);
      if (hit) {
        clearTimeout(this.leaveTimer); this.leaveTimer = null;
        this.hover.hits++; this.hovering = true;
        this.showReverse(hit.record, hit.offset, pointer.ctrlKey);
        return;
      }
    }
    if (this.hovering) {
      // The result stays while Ctrl is held; otherwise it goes shortly after the pointer leaves the word.
      if (pointer.ctrlKey || this.leaveTimer) return;
      this.leaveTimer = setTimeout(() => { this.leaveTimer = null; if (!this.disposed) this.endHover(); }, 150);
      return;
    }
    if (this.shownKey && !this.active) this.clearHighlights();
  }
  endHover() {
    if (!this.hovering) return;
    this.hovering = false; this.clearHighlights();
    if (this.active) this.showForward(this.active.record, this.active.start, this.active.end);
  }
  clearHighlights() {
    this.shownKey = '';
    if (this.wantTimer) { clearTimeout(this.wantTimer); this.wantTimer = null; }
    for (const state of this.readers.values()) state.pdf.clearTemporary();
    for (const r of this.records.values()) { r.surface.clear(); r.palette.hide(); r.indicator.set(''); }
  }
  clearInteraction() {
    clearTimeout(this.leaveTimer); this.leaveTimer = null;
    this.clearHighlights(); this.pointer = null; this.drag = null; this.active = null; this.hovering = false;
  }

  clearCache(kind) { this.store.clear(kind); }
  usedToday() { return this.store.used(); }
  diagnostics() {
    return { version: this.meta.version || '', zotero: this.Z.version || '', tfz: this.tfz.version(),
      on: this.on(), source: this.prefs.alignSource, records: this.records.size, usedToday: this.store.used(),
      stored: this.store.counts(), hover: this.hover,
      readers: [...this.readers.values()].map(s => ({ item: Number(s.reader.itemID), views: s.pdf.views.length,
        captures: s.captures.length, captureError: s.capError, annotationError: s.pdf.lastAnnotationError, pageAccess: s.pdf.lastAccessMethod, pageError: s.pdf.lastAccessError,
        passages: [...s.passages.values()].map(p => ({ groups: p.groups.length, done: p.groups.filter(g => g.done).length,
          coords: !!p.geometry, errors: p.groups.map(g => g.error).filter(Boolean) })) })) };
  }
  onMainWindowLoad(win) { this.watch(win.document); this.heat(); }
  onMainWindowUnload(win) { this.unwatch(win.document); }
  shutdown() {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.timer); clearTimeout(this.ctrlTimer); clearTimeout(this.leaveTimer); this.clearInteraction();
    for (const [type, fn] of this.listeners) safeGet(() => this.Z.Reader.unregisterEventListener(type, fn));
    this.listeners = [];
    for (const reader of [...this.readers.keys()]) this.dropReader(reader);
    for (const b of [...this.documents.values()]) this.unwatch(b.doc);
    for (const button of this.buttons) safeGet(() => button.remove());
    this.buttons.clear();
    this.aligner.dispose(); this.store.dispose();
    if (this.paneID) safeGet(() => this.Z.PreferencePanes.unregister(this.paneID));
    if (this.Z.SyncTranslateCompanion === this) delete this.Z.SyncTranslateCompanion;
  }
}

function start(Zotero, meta, env) { return new Companion(Zotero, meta, env).start(); }
module.exports = { Companion, Card, start };
