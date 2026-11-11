'use strict';
// Loads the built bundle the way Zotero does, with a stand-in Zotero object.
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');

const EN = 'Although the mechanism remains unclear, XBP1 splicing was markedly increased in tumor cells after treatment with the inhibitor.';
const ZH = '尽管机制尚不清楚，但在使用抑制剂处理后，肿瘤细胞中的XBP1剪接明显增加。';
const TFZ = 'extensions.zotero.ZoteroPDFTranslate.', OWN = 'extensions.zotero.SyncTranslate.';

function world(prefs = {}) {
  const store = new Map(Object.entries({
    [TFZ + 'translateSource']: 'customgpt1',
    [TFZ + 'customGPT1.endPoint']: 'https://api.deepseek.com/chat/completions',
    [TFZ + 'customGPT1.model']: 'deepseek-flash',
    [TFZ + 'customGPT1.apiFormat']: 'openai',
    [TFZ + 'customGPT1.temperature']: '0.2',
    [TFZ + 'customGPT1.customParams']: '{"thinking":{"type":"disabled"}}',
    [TFZ + 'secretObj']: JSON.stringify({ customgpt1: 'test-key' }),
    [OWN + 'enabled']: false, [OWN + 'alignProvider']: 'jev',
    ...prefs
  }));
  const requests = [], files = new Map();
  const Zotero = {
    locale: 'zh-CN', version: '10.0.7', debug() {}, logError(e) { throw e; },
    DataDirectory: { dir: '/data' },
    Prefs: { get: k => store.get(k), set: (k, v) => store.set(k, v), clear: k => store.delete(k) },
    Reader: { _readers: [], _listeners: [], registerEventListener(type, fn) { this._listeners.push(type); }, unregisterEventListener() {} },
    PreferencePanes: { register: async () => 'pane', unregister() {} },
    getMainWindows: () => [],
    PDFTranslate: { data: { translate: { queue: [], services: { getServiceById: () => ({ type: 'sentence' }) } } }, api: { getVersion: () => '2.4.8' } },
    HTTP: { answer: '', async request(method, url, options) {
      requests.push({ url, headers: options.headers, body: JSON.parse(options.body) });
      if (Zotero.HTTP.fail) throw Object.assign(new Error('x'), { status: Zotero.HTTP.fail });
      const body = requests[requests.length - 1].body;
      const content = typeof Zotero.HTTP.answer === 'function' ? Zotero.HTTP.answer(body.messages[0].content) : Zotero.HTTP.answer;
      return { responseText: JSON.stringify({ choices: [{ message: { content } }], usage: { total_tokens: 321 } }) };
    } }
  };
  const env = { setTimeout, clearTimeout, PathUtils: { join: (...a) => a.join('/') },
    IOUtils: { readJSON: async p => { if (!files.has(p)) throw new Error('none'); return JSON.parse(files.get(p)); },
      writeJSON: async (p, d) => { files.set(p, JSON.stringify(d)); } } };
  const scope = { Zotero, URL, setTimeout, clearTimeout, console };
  scope.self = scope;
  const code = fs.readFileSync(path.join(__dirname, '..', 'dist', 'sync-translate.js'), 'utf8');
  vm.runInNewContext(code.replace(/\}\)\(this\);\s*$/, '})(self);'), scope);
  return { Zotero, env, store, requests, files, api: scope.SyncTranslate };
}
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
const task = { id: 't1', raw: EN, result: ZH, service: 'customgpt1', langfrom: 'en-US', langto: 'zh-CN' };
const state = () => ({ captures: [], passages: new Map(), subs: new Set() });
const ANSWER = ['Although ||| 尽管', 'the mechanism ||| 机制', 'remains unclear ||| 尚不清楚', 'the inhibitor ||| 抑制剂',
  'in tumor cells ||| 肿瘤细胞中的', 'XBP1 splicing ||| XBP1剪接', 'was markedly ||| 明显', 'increased ||| 增加'].join('\n');

const same = (a, b, m) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b), m);
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('ok  ' + name); }

(async () => {
  await test('starts, upgrades old settings, ticks and shuts down', async () => {
    const w = world();
    const c = w.api.start(w.Zotero, { version: '0.4.0' }, w.env);
    assert.strictEqual(w.store.get(OWN + 'enabled'), true, 'stuck pause is released on upgrade');
    assert.strictEqual(w.store.get(OWN + 'alignSource'), 'auto');
    assert.strictEqual(w.store.has(OWN + 'alignProvider'), false);
    same(w.Zotero.Reader._listeners.sort(), ['renderTextSelectionPopup', 'renderToolbar']);
    c.tick();
    assert.strictEqual(c.diagnostics().on, true);
    c.shutdown();
    assert.strictEqual(w.Zotero.SyncTranslateCompanion, undefined);
  });

  await test('request mirrors the TFZ service: endpoint, key, thinking off, no paper context', async () => {
    const w = world();
    const c = w.api.start(w.Zotero, {}, w.env);
    w.Zotero.HTTP.answer = ANSWER;
    const p = c.passage(state(), task);
    c.aligner.ensure(p, p.groups[0]);
    await tick(20);
    assert.strictEqual(w.requests.length, 1);
    const r = w.requests[0];
    assert.strictEqual(r.url, 'https://api.deepseek.com/chat/completions');
    assert.strictEqual(r.headers.Authorization, 'Bearer test-key');
    same(r.body.thinking, { type: 'disabled' });
    assert.strictEqual(r.body.stream, false);
    assert.strictEqual(r.body.temperature, 0.2);
    assert(r.body.max_tokens >= 120 && r.body.max_tokens <= 2000, 'reply length is capped');
    assert.strictEqual(r.body.messages.length, 1);
    assert(!/Paper Title/.test(r.body.messages[0].content));
    assert.strictEqual(p.groups[0].done, true);
    const at = ZH.indexOf('抑制剂');
    const items = w.api.align.resolve(p, 't', at, at + 3).items;
    same(items.map(i => EN.slice(i.s[0], i.s[1])), ['the inhibitor']);
    assert.strictEqual(c.usedToday(), 321);
    c.shutdown();
  });

  await test('second time the same sentence costs nothing (cache), also after restart', async () => {
    const w = world();
    let c = w.api.start(w.Zotero, {}, w.env);
    w.Zotero.HTTP.answer = ANSWER;
    let p = c.passage(state(), task);
    c.aligner.ensure(p, p.groups[0]);
    await tick(20);
    c.shutdown();
    assert.strictEqual(w.files.size, 1, 'cache written on shutdown');
    assert(!/机制|mechanism/.test([...w.files.values()][0].split('"gloss"')[0]), 'alignment cache holds offsets, not text');
    c = w.api.start(w.Zotero, {}, w.env);
    await tick(10);
    p = c.passage(state(), { ...task, id: 't2' });
    assert.strictEqual(p.groups[0].done, true);
    assert.strictEqual(w.requests.length, 1);
    c.shutdown();
  });

  await test('learned phrases resolve a new sentence locally', async () => {
    const w = world();
    const c = w.api.start(w.Zotero, {}, w.env);
    w.Zotero.HTTP.answer = ANSWER;
    const p = c.passage(state(), task);
    c.aligner.ensure(p, p.groups[0]);
    await tick(20);
    const raw2 = 'The inhibitor was removed before imaging.', result2 = '成像前移除了抑制剂。';
    const p2 = c.passage(state(), { ...task, id: 't3', raw: raw2, result: result2 });
    const at = result2.indexOf('抑制剂');
    const r = w.api.align.resolve(p2, 't', at, at + 3);
    same(r.items.map(i => raw2.slice(i.s[0], i.s[1])), ['The inhibitor']);
    assert.strictEqual(r.need.length, 0);
    assert.strictEqual(w.requests.length, 1);
    c.shutdown();
  });

  await test('failure is not cached and is retried only after a pause', async () => {
    const w = world();
    const c = w.api.start(w.Zotero, {}, w.env);
    w.Zotero.HTTP.fail = 500;
    const p = c.passage(state(), task), g = p.groups[0];
    c.aligner.ensure(p, g);
    await tick(20);
    assert.strictEqual(g.done, false);
    assert.strictEqual(g.note, 'fail');
    assert.strictEqual(g.error, 'HTTP_500');
    c.aligner.ensure(p, g);
    await tick(20);
    assert.strictEqual(w.requests.length, 1, 'no immediate retry');
    g.failAt = 0; w.Zotero.HTTP.fail = 0; w.Zotero.HTTP.answer = ANSWER;
    c.aligner.ensure(p, g);
    await tick(20);
    assert.strictEqual(g.done, true);
    c.shutdown();
  });

  await test('daily cap stops requests', async () => {
    const w = world({ [OWN + 'capDaily']: 300 });
    const c = w.api.start(w.Zotero, {}, w.env);
    w.Zotero.HTTP.answer = ANSWER;
    const p = c.passage(state(), task);
    c.aligner.ensure(p, p.groups[0]);
    await tick(20);
    const p2 = c.passage(state(), { ...task, id: 't4', raw: 'Cells were then washed twice.', result: '随后将细胞洗涤两次。' });
    c.aligner.ensure(p2, p2.groups[0]);
    await tick(20);
    assert.strictEqual(w.requests.length, 1);
    assert.strictEqual(p2.groups[0].note, 'cap');
    c.shutdown();
  });

  await test('machine-translation engine or "off": sentence level, no request', async () => {
    for (const prefs of [{ [OWN + 'alignSource']: 'off', [OWN + 'schema']: 4 }, {}]) {
      const w = world(prefs);
      const c = w.api.start(w.Zotero, {}, w.env);
      const p = c.passage(state(), { ...task, service: prefs[OWN + 'alignSource'] ? 'customgpt1' : 'youdao' });
      c.aligner.ensure(p, p.groups[0]);
      await tick(20);
      assert.strictEqual(w.requests.length, 0);
      assert.strictEqual(p.groups[0].note, 'off');
      c.shutdown();
    }
  });

  await test('a rejected parameter (HTTP 400) is retried once in plain form', async () => {
    const w = world();
    const c = w.api.start(w.Zotero, {}, w.env);
    let calls = 0;
    const real = w.Zotero.HTTP.request;
    w.Zotero.HTTP.request = async (...a) => { if (!calls++) { w.requests.push({}); throw Object.assign(new Error('x'), { status: 400 }); } return real(...a); };
    w.Zotero.HTTP.answer = ANSWER;
    const p = c.passage(state(), task);
    c.aligner.ensure(p, p.groups[0]);
    await tick(20);
    assert.strictEqual(w.requests.length, 2);
    assert.strictEqual(w.requests[1].body.temperature, undefined);
    assert.strictEqual(w.requests[1].body.max_tokens, undefined);
    assert.strictEqual(p.groups[0].done, true);
    c.shutdown();
  });

  // Stand-ins for the PDF view and the translation box, to drive the pointer logic.
  function stage(w, c) {
    const pdf = { views: [], glyphs: [], shown: null, point: null, draws: 0,
      show(g) { this.shown = g; this.glyphs = g; this.draws++; }, clearTemporary() { this.shown = null; this.glyphs = []; },
      clear() { this.clearTemporary(); }, pdfPoint() { return this.point; }, refresh() {}, dispose() {} };
    const st = { captures: [], passages: new Map(), subs: new Set(), pdf, reader: { itemID: 1 } };
    c.readers.set(st.reader, st);
    const p = c.passage(st, task);
    p.geometry = { map: [...EN].map((ch, i) => ch === ' ' ? [] : [{ pageIndex: 0, charIndex: i, rect: [i, 0, i + 1, 10], hitRect: [i, 0, i + 1, 10] }]) };
    const surface = { doc: {}, element: {}, marked: [], sel: null,
      highlightRanges(r) { this.marked = r.map(x => ZH.slice(x[0], x[1])).join(''); }, clear() { this.marked = ''; },
      selection() { return this.sel; }, dispose() {} };
    const record = { surface, passage: p, indicator: { text: '', set(x) { this.text = x; }, dispose() {} }, palette: { hide() {}, show() {}, dispose() {} } };
    c.records.set(surface.element, record);
    const over = (word, ctrlKey) => { pdf.point = { pageIndex: 0, x: EN.indexOf(word) + 0.5, y: 5 }; c.move({ pdf, ctrlKey, doc: {} }); };
    const off = ctrlKey => { pdf.point = { pageIndex: 0, x: -50, y: 5 }; c.move({ pdf, ctrlKey, doc: {} }); };
    const lit = () => [...new Set((pdf.shown || []).map(g => g._syncGroup))].map(k => (pdf.shown.filter(g => g._syncGroup === k).map(g => EN[g.charIndex]).join('')));
    return { pdf, p, surface, record, over, off, lit };
  }

  await test('pointing at a PDF word with Ctrl marks its translation; without Ctrl nothing happens', async () => {
    const w = world({ [OWN + 'reverse']: true, [OWN + 'reverseCtrl']: true });
    const c = w.api.start(w.Zotero, {}, w.env);
    w.Zotero.HTTP.answer = ANSWER;
    const s = stage(w, c);
    s.over('inhibitor', false);
    assert.strictEqual(s.surface.marked.length, 0);
    assert.strictEqual(w.requests.length, 0);
    s.over('inhibitor', true);
    assert.strictEqual(s.surface.marked, ZH, 'whole sentence until the model answers');
    await tick(30);
    assert.strictEqual(w.requests.length, 1);
    assert.strictEqual(s.surface.marked, '抑制剂');
    same(s.lit(), ['theinhibitor']);
    s.off(true);
    assert.strictEqual(s.surface.marked, '抑制剂', 'stays while Ctrl is held');
    s.off(false);
    await tick(200);
    assert.strictEqual(s.surface.marked, '');
    assert.strictEqual(s.pdf.shown, null);
    same(c.diagnostics().hover, { moves: 3, points: 3, hits: 2 });
    c.shutdown();
  });

  await test('without the Ctrl requirement, pointing never sends a request', async () => {
    const w = world({ [OWN + 'reverse']: true, [OWN + 'reverseCtrl']: false });
    const c = w.api.start(w.Zotero, {}, w.env);
    const s = stage(w, c);
    s.over('inhibitor', false);
    await tick(30);
    assert(s.surface.marked.length > 0);
    assert.strictEqual(w.requests.length, 0);
    c.shutdown();
  });

  await test('Ctrl lookup works over an existing translation selection and restores it afterwards', async () => {
    const w = world({ [OWN + 'reverse']: true, [OWN + 'reverseCtrl']: true });
    const c = w.api.start(w.Zotero, {}, w.env);
    w.Zotero.HTTP.answer = ANSWER;
    const s = stage(w, c);
    c.aligner.ensure(s.p, s.p.groups[0]);
    await tick(30);
    const at = ZH.indexOf('机制');
    s.surface.sel = { start: at, end: at + 2, ids: [1] };
    c.syncSelection(s.record);
    same(s.lit(), ['themechanism']);
    s.over('inhibitor', false);
    same(s.lit(), ['themechanism'], 'plain pointing leaves the selection alone');
    s.over('inhibitor', true);
    assert.strictEqual(s.surface.marked, '抑制剂');
    s.off(false);
    await tick(200);
    same(s.lit(), ['themechanism']);
    c.shutdown();
  });

  await test('repeated moves over one word draw once; moves seen by another document do not clear it', async () => {
    const w = world({ [OWN + 'reverse']: true, [OWN + 'reverseCtrl']: true });
    const c = w.api.start(w.Zotero, {}, w.env);
    w.Zotero.HTTP.answer = ANSWER;
    const s = stage(w, c);
    c.aligner.ensure(s.p, s.p.groups[0]);
    await tick(30);
    for (let k = 0; k < 20; k++) { s.over('inhibitor', true); c.move({ pdf: null, ctrlKey: true, doc: {} }); }
    assert.strictEqual(s.pdf.draws, 1);
    assert.strictEqual(s.surface.marked, '抑制剂');
    assert.strictEqual(c.events.filter(e => e.type === 'hover').length, 1);
    c.shutdown();
  });

  await test('a word the sentence alignment left out is asked about on its own, once', async () => {
    const w = world({ [OWN + 'reverse']: true, [OWN + 'reverseCtrl']: true });
    const c = w.api.start(w.Zotero, {}, w.env);
    w.Zotero.HTTP.answer = prompt => prompt.includes('[[') ? '处理' : ANSWER;
    const s = stage(w, c);
    s.over('treatment', true);
    await tick(40);
    assert.strictEqual(w.requests.length, 2);
    assert(w.requests[1].body.messages[0].content.includes('[[treatment]]'));
    assert.strictEqual(s.surface.marked, '处理后');
    same(s.lit(), ['aftertreatment']);
    s.off(true); s.over('treatment', true);
    await tick(40);
    assert.strictEqual(w.requests.length, 2, 'the answer is kept');
    c.shutdown();
  });

  await test('the pointed word is outlined at once, before any answer', async () => {
    const w = world({ [OWN + 'reverse']: true, [OWN + 'reverseCtrl']: true });
    const c = w.api.start(w.Zotero, {}, w.env);
    w.Zotero.HTTP.answer = ANSWER;
    const s = stage(w, c);
    s.over('splicing', true);
    assert(s.lit().includes('splicing'), s.lit().join('|'));
    await tick(40);
    c.shutdown();
  });

  await test('activity is written to a local log file', async () => {
    const w = world({ [OWN + 'reverse']: true, [OWN + 'reverseCtrl']: true });
    const c = w.api.start(w.Zotero, {}, w.env);
    w.Zotero.HTTP.answer = ANSWER;
    const s = stage(w, c);
    s.over('inhibitor', true);
    await tick(1700);
    const log = JSON.parse(w.files.get('/data/sync-translate-log.json'));
    assert(log.events.some(e => e.type === 'align' && e.links > 0));
    assert(log.events.some(e => e.type === 'hover' && e.state === 'word' && e.to === '抑制剂'));
    c.shutdown();
  });

  await test('endpoint normalisation matches TFZ', async () => {
    const { normalizeEndpoint } = world().api.provider;
    assert.strictEqual(normalizeEndpoint('https://api.openai.com/v1', ''), 'https://api.openai.com/v1/chat/completions');
    assert.strictEqual(normalizeEndpoint('https://api.deepseek.com', ''), 'https://api.deepseek.com/v1/chat/completions');
    assert.strictEqual(normalizeEndpoint('https://x.test/anthropic', 'anthropic'), 'https://x.test/anthropic/v1/messages');
    assert.strictEqual(normalizeEndpoint('https://api.deepseek.com/chat/completions', ''), 'https://api.deepseek.com/chat/completions');
  });

  console.log(passed + ' passed');
})().catch(e => { console.error(e); process.exit(1); });
