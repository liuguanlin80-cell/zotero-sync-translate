'use strict';
const { safeGet, unwrap, canonical, checkAbort, LRU } = require('./util');
const { validRect, pageGlyphs, concatenateGeometry, mergeGlyphRects } = require('./geom');
const NS = 'http://www.w3.org/1999/xhtml';
const PAGE_BRIDGE_FN = '__syncTranslatePageDataV1';
const PAGE_BRIDGE_READY = '__syncTranslatePageDataReadyV1_';
const PAGE_BRIDGE_RESULT = '__syncTranslatePageDataResultV1_';
const PAGE_BRIDGE_ERROR = '__syncTranslatePageDataErrorV1_';
let bridgeSequence = 0;
const ANNOTATION_COLORS = Object.freeze([
  ['yellow','#ffd400'],['red','#ff6666'],['green','#5fb236'],['blue','#2ea8e5'],
  ['purple','#a28ae5'],['magenta','#e56eee'],['orange','#f19837'],['gray','#aaaaaa']
]);
function clamp(v,min,max){return Math.max(min,Math.min(max,v));}
function sortIndexFor(pageIndex,charIndex,rect,viewBox){
  const height=Array.isArray(viewBox)&&viewBox.length>=4?Number(viewBox[3])-Number(viewBox[1]):0;
  let top=height&&rect?height-Number(rect[3]):0;if(!Number.isFinite(top)||top<0)top=0;
  return String(pageIndex).slice(0,5).padStart(5,'0')+'|'+
    String(Math.max(0,Number(charIndex)||0)).slice(0,6).padStart(6,'0')+'|'+
    String(Math.floor(top)).slice(0,5).padStart(5,'0');
}
function toRealm(value, win) {
  try {
    if (typeof Components !== 'undefined' && Components.utils?.cloneInto && win)
      return Components.utils.cloneInto(value, win, { wrapReflectors: true });
  } catch (_) {}
  return value;
}
function html(doc, name) { return doc.createElementNS(NS, name); }
function plainRect(value) {
  if (!value || typeof value.length !== 'number' || value.length < 4) return null;
  const r = [Number(value[0]), Number(value[1]), Number(value[2]), Number(value[3])];
  return r.every(Number.isFinite) ? r : null;
}
function normalizePageData(data) {
  const source = data && data.chars;
  if (!source || typeof source.length !== 'number') return null;
  const chars = [];
  for (let i = 0; i < source.length; i++) {
    let ch;
    try { ch = source[i]; } catch (_) { continue; }
    const rect = plainRect(ch?.rect);
    if (!ch || typeof ch.c !== 'string' || !rect) continue;
    const inlineRect = plainRect(ch.inlineRect);
    chars.push({
      c: ch.c, rect, inlineRect: inlineRect || rect.slice(),
      rotation: Number.isFinite(Number(ch.rotation)) ? Number(ch.rotation) : 0,
      spaceAfter: Boolean(ch.spaceAfter), lineBreakAfter: Boolean(ch.lineBreakAfter),
      paragraphBreakAfter: Boolean(ch.paragraphBreakAfter), wordBreakAfter: Boolean(ch.wordBreakAfter),
      ignorable: Boolean(ch.ignorable), offset: Number.isInteger(ch.offset) ? ch.offset : i
    });
  }
  return { chars, viewBox: plainRect(data?.viewBox) };
}
function bridgeSource() {
  const q = JSON.stringify;
  return "(function(){"+
    "var FN="+q(PAGE_BRIDGE_FN)+",READY="+q(PAGE_BRIDGE_READY)+",RESULT="+q(PAGE_BRIDGE_RESULT)+",ERROR="+q(PAGE_BRIDGE_ERROR)+";"+
    "if(typeof window[FN]==='function')return;"+
    "window[FN]=function(pageIndex,requestId){"+
      "var ready=READY+String(requestId),result=RESULT+String(requestId),error=ERROR+String(requestId);"+
      "window[ready]=false;window[result]='';window[error]='';"+
      "var app=window.PDFViewerApplication,doc=app&&app.pdfDocument;"+
      "if(!doc||typeof doc.getPageData!=='function'){window[error]='NO_GET_PAGE_DATA';window[ready]=true;return;}"+
      "var promise;try{promise=doc.getPageData({pageIndex:Number(pageIndex)});}catch(e){window[error]='GET_PAGE_DATA_THROW';window[ready]=true;return;}"+
      "Promise.resolve(promise).then(function(data){"+
        "var src=(data&&data.chars&&typeof data.chars.length==='number')?data.chars:[],chars=[];"+
        "for(var i=0;i<src.length;i++){var ch=src[i],r=ch&&ch.rect;if(!ch||typeof ch.c!=='string'||!r||typeof r.length!=='number'||r.length<4)continue;"+
          "var rect=[Number(r[0]),Number(r[1]),Number(r[2]),Number(r[3])];if(!rect.every(Number.isFinite))continue;"+
          "var ir=ch.inlineRect,inlineRect=null;if(ir&&typeof ir.length==='number'&&ir.length>=4){inlineRect=[Number(ir[0]),Number(ir[1]),Number(ir[2]),Number(ir[3])];if(!inlineRect.every(Number.isFinite))inlineRect=null;}"+
          "chars.push({c:ch.c,rect:rect,inlineRect:inlineRect||rect.slice(),rotation:Number.isFinite(Number(ch.rotation))?Number(ch.rotation):0,"+
            "spaceAfter:!!ch.spaceAfter,lineBreakAfter:!!ch.lineBreakAfter,paragraphBreakAfter:!!ch.paragraphBreakAfter,wordBreakAfter:!!ch.wordBreakAfter,ignorable:!!ch.ignorable,offset:Number.isInteger(ch.offset)?ch.offset:i});}"+
        "var vb=data&&data.viewBox,v=null;if(vb&&typeof vb.length==='number'&&vb.length>=4){v=[Number(vb[0]),Number(vb[1]),Number(vb[2]),Number(vb[3])];if(!v.every(Number.isFinite))v=null;}"+
        "window[result]=JSON.stringify({chars:chars,viewBox:v});"+
      "},function(){window[error]='GET_PAGE_DATA_REJECT';}).then(function(){window[ready]=true;},function(){window[error]='SERIALIZE_FAILED';window[ready]=true;});"+
    "};"+
  "})();";
}
function ensurePageBridge(win) {
  const native = unwrap(win);
  try { if (typeof native?.[PAGE_BRIDGE_FN] === 'function') return native; } catch (_) {}
  try {
    if (typeof native?.eval === 'function') native.eval.call(native, bridgeSource());
    if (typeof native?.[PAGE_BRIDGE_FN] === 'function') return native;
  } catch (_) {}
  try {
    const Cu = typeof Components !== 'undefined' ? Components.utils : null;
    if (Cu?.exportFunction) {
      const installer = function(source) {
        try { return this.eval.call(this, String(source)); } catch (_) { return false; }
      };
      if (typeof native.__syncTranslateInstallV1 !== 'function')
        Cu.exportFunction(installer, native, { defineAs: '__syncTranslateInstallV1' });
      native.__syncTranslateInstallV1(bridgeSource());
      if (typeof native?.[PAGE_BRIDGE_FN] === 'function') return native;
    }
  } catch (_) {}
  return null;
}
async function fetchPageDataBridge(win, pageIndex, signal, timeoutMs = 6000) {
  checkAbort(signal);
  const native = ensurePageBridge(win);
  if (!native) throw new Error('PDF_BRIDGE_UNAVAILABLE');
  const id = (++bridgeSequence).toString(36) + Date.now().toString(36);
  const ready = PAGE_BRIDGE_READY + id, result = PAGE_BRIDGE_RESULT + id, error = PAGE_BRIDGE_ERROR + id;
  try {
    native[PAGE_BRIDGE_FN](pageIndex, id);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      checkAbort(signal);
      let done = false;
      try { done = native[ready] === true; } catch (_) {}
      if (done) {
        const err = safeGet(() => String(native[error] || ''), '');
        const json = safeGet(() => native[result], '');
        if (!json) throw new Error(err ? 'PDF_BRIDGE_' + err : 'PDF_BRIDGE_EMPTY');
        let parsed;
        try { parsed = JSON.parse(String(json)); } catch (_) { throw new Error('PDF_BRIDGE_BAD_JSON'); }
        const data = normalizePageData(parsed);
        if (!data?.chars?.length) throw new Error('PDF_BRIDGE_NO_CHARS');
        return data;
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('PDF_BRIDGE_TIMEOUT');
  } finally {
    for (const key of [ready,result,error]) try { delete native[key]; } catch (_) {}
  }
}
function discoverViews(reader) {
  const internal = safeGet(() => unwrap(reader._internalReader), null) || reader;
  const result = [], seen = new Set();
  for (let host of [internal?._primaryView, internal?._secondaryView]) {
    host = unwrap(host); if (!host) continue;
    const view = host._view ? unwrap(host._view) : host;
    const win = safeGet(() => unwrap(view._iframeWindow || view._iframe?.contentWindow), null);
    const app = safeGet(() => win.PDFViewerApplication, null);
    if (app?.pdfViewer && !seen.has(win)) { seen.add(win); result.push({ view, owner:host, win, app }); }
  }
  const root = safeGet(() => unwrap(reader._iframeWindow), null);
  const visit = (win, depth) => {
    if (!win || depth > 3 || seen.has(win)) return;
    const app = safeGet(() => win.PDFViewerApplication, null);
    if (app?.pdfViewer) { seen.add(win); result.push({ view: null, owner:null, win, app }); return; }
    for (const frame of safeGet(() => [...win.document.querySelectorAll('iframe')], [])) visit(unwrap(frame.contentWindow), depth + 1);
  };
  visit(root, 0);
  return result;
}
function snapshotRanges(view, raw, position) {
  const ranges = safeGet(() => view._selectionRanges, null);
  if (!Array.isArray(ranges) || !ranges.length) return null;
  const text = ranges.map(r => r.text || '').join(' ');
  if (canonical(text).value !== canonical(raw).value) return null;
  if (position && !ranges.some(r => r.position?.pageIndex === position.pageIndex)) return null;
  const copied = ranges.filter(r => r.position && Number.isInteger(r.position.pageIndex) &&
    Number.isInteger(r.anchorOffset) && Number.isInteger(r.headOffset)).map(r => ({
      pageIndex: r.position.pageIndex, start: Math.min(r.anchorOffset, r.headOffset),
      end: Math.max(r.anchorOffset, r.headOffset), rects: Array.from(r.position.rects || [], x => Array.from(x))
    }));
  return copied.length ? copied : null;
}
function positionRanges(position) {
  if (!position || !Number.isInteger(position.pageIndex)) return [];
  const out = [{ pageIndex: position.pageIndex, rects: Array.from(position.rects || [], x => Array.from(x)) }];
  if (position.nextPageRects?.length) out.push({ pageIndex: position.pageIndex + 1,
    rects: Array.from(position.nextPageRects, x => Array.from(x)) });
  return out.filter(r => r.rects.some(validRect));
}

class PDFAdapter {
  constructor(reader, onDocument) {
    this.reader = reader; this.onDocument = onDocument; this.bindings = new Map();
    this.glyphs = []; this.layers = new Set(); this.cache = new LRU(20); this.disposed = false;
    this.lastAnnotationError='';
    this.views = []; this.lastView = null; this.lastAccessMethod = ''; this.lastAccessError = ''; this.refresh();
  }
  refresh() {
    if (this.disposed) return;
    this.views = discoverViews(this.reader);
    const alive = new Set(this.views.map(x => x.win));
    if (this.lastView && !alive.has(this.lastView.win)) this.lastView = null;
    for (const [win, binding] of this.bindings) if (!alive.has(win)) {
      binding.dispose(); this.bindings.delete(win);
    }
    for (const entry of this.views) {
      if (this.bindings.has(entry.win)) continue;
      const bus = entry.app.eventBus;
      const handler = () => this.redraw();
      const names = ['pagerendered', 'textlayerrendered', 'scalechanging', 'rotationchanging', 'updateviewarea', 'pagesinit'];
      const on = bus?.on || bus?._on, off = bus?.off || bus?._off;
      if (on) for (const name of names) on.call(bus, name, handler);
      const win = entry.win;
      win.addEventListener('resize', handler);
      const removeDoc = this.onDocument?.(win.document, this);
      this.bindings.set(win, { dispose: () => {
        if (off) for (const name of names) safeGet(() => off.call(bus, name, handler));
        safeGet(() => win.removeEventListener('resize', handler)); removeDoc?.();
      } });
    }
    if (this.glyphs.length) this.redraw();
  }
  async page(entry, pageIndex, signal) {
    const fingerprint = safeGet(() => entry.app.pdfDocument?.fingerprints?.[0], 'pdf');
    const key = fingerprint + ':' + pageIndex;
    let data = this.cache.get(key);
    if (data) return data;
    let bridgeError = '';
    try {
      data = await fetchPageDataBridge(entry.win, pageIndex, signal);
      this.lastAccessMethod = 'native-json-bridge'; this.lastAccessError = '';
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      bridgeError = String(error?.message || 'PDF_BRIDGE_FAILED');
    }
    if (!data) {
      const cached = safeGet(() => entry.view?._pdfPages?.[pageIndex], null);
      data = normalizePageData(cached);
      if (data?.chars?.length) { this.lastAccessMethod = 'reader-page-cache'; this.lastAccessError = bridgeError; }
    }
    if (!data?.chars?.length) {
      try {
        const pdf = entry.app.pdfDocument;
        if (typeof pdf?.getPageData === 'function') {
          const direct = await pdf.getPageData(toRealm({ pageIndex }, entry.win));
          data = normalizePageData(direct);
          if (data?.chars?.length) { this.lastAccessMethod = 'direct-getPageData'; this.lastAccessError = bridgeError; }
        }
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        this.lastAccessError = bridgeError || String(error?.message || 'PDF_DIRECT_FAILED');
      }
    }
    if (!data?.chars?.length) {
      this.lastAccessMethod = 'failed';
      this.lastAccessError = this.lastAccessError || bridgeError || 'PDF_NO_TEXT_LAYER';
      throw new Error(this.lastAccessError);
    }
    this.cache.set(key, data);
    return data;
  }
  async geometryFrom(entry, ranges, signal) {
    if (!ranges?.length) return null;
    if (ranges.length > 32) throw new Error('SELECTION_TOO_MANY_PAGES');
    const parts = [];
    for (const r of [...ranges].sort((a, b) => a.pageIndex - b.pageIndex)) {
      checkAbort(signal);
      const page = await this.page(entry, r.pageIndex, signal); checkAbort(signal);
      const start = r.start === undefined ? 0 : Math.max(0, r.start);
      const end = r.end === undefined ? page.chars.length : Math.min(page.chars.length, r.end);
      parts.push(pageGlyphs(r.pageIndex, page.chars, start, end,
        r.start === undefined ? r.rects : null));
    }
    const geometry = concatenateGeometry(parts);
    return canonical(geometry.text).value ? geometry : null;
  }
  async capture(annotation, signal) {
    this.refresh(); checkAbort(signal);
    const text = String(annotation?.text || '').trim();
    if (!text) throw new Error('EMPTY_SELECTION');
    if (!this.views.length) throw new Error('PDF_VIEW_UNAVAILABLE');
    const expected = canonical(text).value;
    const publicRanges = positionRanges(annotation.position);
    const ordered = this.lastView ? [this.lastView, ...this.views.filter(v => v.win !== this.lastView.win)] : [...this.views];
    let best = null, lastError = '';
    for (const entry of ordered) {
      const candidates = [];
      if (publicRanges.length) candidates.push({ kind:'position', ranges:publicRanges });
      const snapshot = snapshotRanges(entry.view, text, annotation.position);
      if (snapshot?.length) candidates.push({ kind:'offsets', ranges:snapshot });
      for (const candidate of candidates) {
        try {
          const geometry = await this.geometryFrom(entry, candidate.ranges, signal);
          if (!geometry) continue;
          const got = canonical(geometry.text).value;
          const at = expected ? got.indexOf(expected) : -1;
          const exact = got === expected;
          const containsOnce = at >= 0 && got.indexOf(expected, at + Math.max(1, expected.length)) < 0;
          const score = exact ? 3 : containsOnce ? 2 : got && expected.includes(got) ? 1 : 0;
          if (!best || score > best.score) best = { entry, candidate, geometry, score };
          if (score >= 2) break;
        } catch (error) {
          if (error?.name === 'AbortError') throw error;
          lastError = String(error?.message || 'PDF_CAPTURE_FAILED');
        }
      }
      if (best?.score >= 2) break;
    }
    if (!best?.geometry) throw new Error(lastError || 'PDF_SELECTION_UNAVAILABLE');
    if (best.score < 1) throw new Error('PDF_SELECTION_TEXT_MISMATCH');
    this.lastView = best.entry;
    return { text, geometry:best.geometry, stamp:Date.now(), method:best.candidate.kind,
      signature: JSON.stringify(best.candidate.ranges.map(r => [r.pageIndex, r.start, r.end, r.rects])) };
  }
  clearLayers() { for (const layer of this.layers) safeGet(() => layer.remove()); this.layers.clear(); }
  show(glyphs) { this.glyphs = glyphs || []; this.redraw(); }
  clearTemporary() { this.glyphs = []; this.clearLayers(); }
  clear() { this.clearTemporary(); }
  /** Adds straight to the annotation store. The reader's own entry point also changes the
   * annotation selection, which clears the text selection and closes the translation popup. */
  annotationWriter() {
    const manager = safeGet(() => unwrap(this.reader._internalReader)._annotationManager, null);
    if (typeof manager?.addAnnotation === 'function' && !safeGet(() => manager._readOnly, false)) return a => manager.addAnnotation(a);
    const entry = [this.lastView, ...this.views].filter(Boolean)
      .find(e => typeof e.view?._onAddAnnotation === 'function' && !safeGet(() => e.view._readOnly, false));
    return entry ? a => entry.view._onAddAnnotation(a, false) : null;
  }
  async createPermanentHighlight(glyphs, color, text = '') {
    const rows = mergeGlyphRects(glyphs || []), pages = [...new Set(rows.map(r => r.pageIndex))].sort((x, y) => x - y);
    if (!rows.length || pages.length > 2 || !ANNOTATION_COLORS.some(x => x[1] === color)) { this.lastAnnotationError = 'ANNOTATION_UNSUPPORTED_RANGE'; return false; }
    const write = this.annotationWriter(), entry = this.lastView || this.views[0];
    if (!write || !entry) { this.lastAnnotationError = 'ANNOTATION_WRITER_UNAVAILABLE'; return false; }
    try {
      const pageIndex = pages[0], pageRows = rows.filter(r => r.pageIndex === pageIndex);
      const first = (glyphs || []).filter(g => g.pageIndex === pageIndex).reduce((m, g) => !m || g.charIndex < m.charIndex ? g : m, null);
      const page = safeGet(() => entry.app.pdfViewer.getPageView(pageIndex), null);
      const viewBox = safeGet(() => page.viewport.viewBox, null) || safeGet(() => page.pdfPage.view, null);
      const position = { pageIndex, rects: pageRows.map(r => Array.from(r.rect)) };
      if (pages[1] !== undefined) position.nextPageRects = rows.filter(r => r.pageIndex === pages[1]).map(r => Array.from(r.rect));
      const annotation = { type: 'highlight', color, position, text: String(text || ''),
        sortIndex: sortIndexFor(pageIndex, first?.charIndex || 0, pageRows[0]?.rect || first?.rect, viewBox),
        pageLabel: String(safeGet(() => entry.view?._getPageLabel(pageIndex, true), pageIndex + 1)) };
      const readerWin = safeGet(() => unwrap(this.reader?._iframeWindow), null);
      await Promise.resolve(write(readerWin ? toRealm(annotation, readerWin) : annotation));
      this.lastAnnotationError = ''; return true;
    } catch (error) { this.lastAnnotationError = String(error?.message || 'ANNOTATION_WRITE_FAILED'); return false; }
  }
  redraw() {
    if (this.disposed || !this.glyphs.length) { this.clearLayers(); return; }
    const rows = mergeGlyphRects(this.glyphs), grouped = new Map();
    for (const row of rows) {
      if (!grouped.has(row.pageIndex)) grouped.set(row.pageIndex, []);
      grouped.get(row.pageIndex).push(row);
    }
    const used = new Set();
    for (const entry of this.views) {
      for (const [pageIndex, rects] of grouped) {
        const page = safeGet(() => entry.app.pdfViewer.getPageView(pageIndex), null);
        if (!page?.div?.isConnected || !page.viewport || !page.div.clientWidth) continue;
        const doc = page.div.ownerDocument;
        let layer = [...page.div.children].find(x => x.classList?.contains('sync-translate-pdf-layer') && x.dataset?.syncTranslateOwner === '1');
        if (!layer) {
          layer = html(doc, 'div'); layer.className = 'sync-translate-pdf-layer';
          layer.dataset.syncTranslateOwner='1'; layer.setAttribute('aria-hidden', 'true');
          layer.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:500;overflow:hidden;';
          page.div.appendChild(layer);
        }
        used.add(layer); this.layers.add(layer);
        const sx = page.div.clientWidth / page.viewport.width;
        const sy = page.div.clientHeight / page.viewport.height;
        const boxes=[];
        for (const row of rects) {
          const r = page.viewport.convertToViewportRectangle(toRealm(row.rect, entry.win));
          if (!r.every(Number.isFinite)) continue;
          let box=layer.children[boxes.length];
          if(!box){box=html(doc,'div');box.className='sync-translate-pdf-highlight';layer.appendChild(box);}
          box.style.cssText = `position:absolute;left:${Math.min(r[0],r[2])*sx}px;top:${Math.min(r[1],r[3])*sy}px;` +
            `width:${Math.max(1,Math.abs(r[2]-r[0])*sx)}px;height:${Math.max(1,Math.abs(r[3]-r[1])*sy)}px;` +
            (row.coarse ? 'background:rgba(255,181,35,.2);box-shadow:inset 0 0 0 1px rgba(184,112,0,.28);' : 'background:rgba(255,181,35,.36);box-shadow:inset 0 0 0 1px rgba(184,112,0,.55);') + 'border-radius:2px;';
          boxes.push(box);
        }
        while(layer.children.length>boxes.length)layer.lastElementChild?.remove();
      }
    }
    for(const layer of [...this.layers])if(!used.has(layer)){safeGet(()=>layer.remove());this.layers.delete(layer);}
  }
  pdfPoint(event) {
    const pageElement = event.target?.closest?.('.page[data-page-number]');
    if (!pageElement) return null;
    // The event target and the stored window reach the same document through different wrappers.
    const doc = unwrap(pageElement.ownerDocument);
    const entry = this.views.find(x => safeGet(() => unwrap(x.win.document) === doc, false)) ||
      (this.views.length === 1 ? this.views[0] : this.lastView);
    if (!entry) return null;
    const pageIndex = Number(pageElement.dataset.pageNumber) - 1;
    const page = safeGet(() => entry.app.pdfViewer.getPageView(pageIndex), null);
    if (!page?.viewport || !pageElement.clientWidth) return null;
    const b = pageElement.getBoundingClientRect();
    const x = (event.clientX - b.left - pageElement.clientLeft) * page.viewport.width / pageElement.clientWidth;
    const y = (event.clientY - b.top - pageElement.clientTop) * page.viewport.height / pageElement.clientHeight;
    const p = page.viewport.convertToPdfPoint(x, y);
    this.lastView = entry;
    return { pageIndex, x: p[0], y: p[1] };
  }
  dispose() {
    this.disposed = true; this.clear(); this.cache.clear();
    for (const b of this.bindings.values()) b.dispose();
    this.bindings.clear(); this.views = []; this.lastView = null;
  }
}
module.exports = { toRealm, html, ANNOTATION_COLORS, PDFAdapter };
