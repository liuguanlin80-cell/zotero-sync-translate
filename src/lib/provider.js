'use strict';
const { safeGet, unwrap, canonical, hash } = require('./util');
const A = require('./align');

const TFZ_PREFIX = 'extensions.zotero.ZoteroPDFTranslate.';
const GPT = ['chatgpt', 'customgpt1', 'customgpt2', 'customgpt3', 'azuregpt'];
const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
const DIALECTS = [
  ['openai', ['api.openai.com', 'openai.azure.com']],
  ['openrouter', ['openrouter.ai']],
  ['deepseek', ['deepseek.com']],
  ['thinkingType', ['bigmodel.cn', 'z.ai', 'moonshot.cn', 'kimi.com', 'kimi.ai', 'volces.com']],
  ['dashscope', ['aliyuncs.com']]
];

function isResponses(url) { return url.endsWith('/responses') || url.includes('/responses?'); }

/** Same rules Translate for Zotero applies to a user-entered endpoint. */
function normalizeEndpoint(endPoint, apiFormat) {
  const raw = String(endPoint || '').trim();
  if (!raw || raw.includes('?')) return raw;
  const base = raw.replace(/\/+$/, '');
  const path = base.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '');
  const anthropic = apiFormat === 'anthropic';
  const resource = anthropic ? '/messages' : '/chat/completions';
  if (!path) return base + '/v1' + resource;
  const last = path.split('/').pop();
  if (last === 'openai' && !anthropic) return base + resource;
  if (last === 'anthropic' && anthropic) return base + '/v1' + resource;
  if (/^v\d+[a-z0-9]*$/i.test(last)) return base + resource;
  return raw;
}

function safeURL(url) {
  let parsed;
  try { parsed = new URL(url); } catch (_) { return false; }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  return (parsed.protocol === 'https:' || (local && parsed.protocol === 'http:')) && !parsed.username && !parsed.password;
}

function dialect(url) {
  const host = safeGet(() => new URL(url).hostname.toLowerCase(), '');
  for (const [name, hosts] of DIALECTS) if (hosts.some(h => host === h || host.endsWith('.' + h))) return name;
  return '';
}

function reasoningModel(model) { return /^(gpt-5|o\d)/i.test(String(model || '')); }

function thinkingOff(url, model) {
  switch (dialect(url)) {
    case 'openai': {
      if (!reasoningModel(model)) return {};
      const m = /^gpt-5(?:\.(\d+))?/i.exec(model);
      const effort = m && !(m[1] && parseInt(m[1]) >= 1) ? 'minimal' : 'none';
      return isResponses(url) ? { reasoning: { effort } } : { reasoning_effort: effort };
    }
    case 'openrouter': return { reasoning: { enabled: false } };
    case 'deepseek':
    case 'thinkingType': return { thinking: { type: 'disabled' } };
    case 'dashscope': return { enable_thinking: false };
    default: return {};
  }
}

class TFZ {
  constructor(Zotero) { this.Z = Zotero; }
  addon() { return safeGet(() => unwrap(this.Z.PDFTranslate), null); }
  available() { return Array.isArray(safeGet(() => this.addon().data.translate.queue, null)); }
  pref(key, fallback = '') { return safeGet(() => this.Z.Prefs.get(TFZ_PREFIX + key, true), fallback); }
  version() { return safeGet(() => this.addon().api.getVersion(), ''); }
  tasks() {
    const out = [];
    for (const task of safeGet(() => this.addon().data.translate.queue, []) || []) {
      if (!task || typeof task.raw !== 'string') continue;
      out.push(task);
      for (const extra of task.extraTasks || []) if (extra && typeof extra.raw === 'string') out.push(extra);
    }
    return out;
  }
  task(id) { return this.tasks().find(t => String(t.id) === String(id)); }
  busy() { return this.tasks().slice(-3).some(t => t.status === 'processing'); }
  snapshot(task) {
    if (!task || task.status !== 'success' || !task.raw || !task.result) return null;
    return {
      id: String(task.id), raw: String(task.raw), result: String(task.result),
      service: String(task.service || this.pref('translateSource')), itemID: Number(task.itemId || -1),
      langfrom: String(task.langfrom || this.pref('sourceLanguage', 'en')),
      langto: String(task.langto || this.pref('targetLanguage', 'zh-CN'))
    };
  }
  /** What TFZ itself returned for a short selection: a dictionary entry or a translation. */
  resultFor(text) {
    const key = canonical(text).value;
    const task = [...this.tasks()].reverse().find(t => t.status === 'success' && t.result && canonical(t.raw).value === key);
    if (!task) return null;
    const word = safeGet(() => this.addon().data.translate.services.getServiceById(task.service).type, '') === 'word';
    return { result: String(task.result), word };
  }
  surfaces(docs, readers) {
    const out = [], seen = new Set();
    const add = (element, task, reader) => {
      if (!element || seen.has(element) || !reader) return false;
      const snapshot = this.snapshot(task);
      if (!snapshot) return false;
      if (snapshot.itemID > 0 && Number(reader.itemID) !== snapshot.itemID) return false;
      const value = safeGet(() => unwrap(element).value, undefined);
      if (typeof value === 'string' && value !== snapshot.result) return false;
      if (safeGet(() => element.hidden, false)) return false;
      seen.add(element); out.push({ element, task: snapshot, reader });
      return true;
    };
    for (const doc of docs) {
      if (!doc?.documentElement) continue;
      for (const popup of safeGet(() => [...doc.querySelectorAll('.selection-popup[translate-task-id]')], [])) {
        const task = this.task(popup.getAttribute('translate-task-id'));
        const owner = readers.find(r => safeGet(() => unwrap(r._iframeWindow).document === doc, false));
        let fields = popup.querySelectorAll('textarea.zoteropdftranslate-popup-textarea');
        if (!fields.length) fields = popup.querySelectorAll('textarea');
        for (const field of fields) add(field, task, owner);
      }
      for (const panel of safeGet(() => [...doc.querySelectorAll('translator-plugin-panel')], [])) {
        const task = this.task(safeGet(() => unwrap(panel)._taskID, ''));
        if (!task) continue;
        const candidates = readers.filter(r => Number(r.itemID) === Number(task.itemId));
        const owner = candidates.find(r => safeGet(() => r._window.document === doc, false)) ||
          candidates.find(r => safeGet(() => this.Z.getMainWindow().Zotero_Tabs.selectedID === r.tabID, false)) ||
          (candidates.length === 1 ? candidates[0] : null);
        for (const selector of ['#result-text', '#raw-text']) {
          const element = panel.querySelector(selector) || panel.shadowRoot?.querySelector(selector);
          if (!element) continue;
          const isText = typeof safeGet(() => unwrap(element).value, undefined) === 'string';
          if ((isText || selector === '#result-text') && add(element, task, owner)) break;
        }
      }
    }
    return out;
  }
  /** Request settings of a TFZ large-model service, read the way TFZ reads them. */
  llmSpec(service) {
    let secrets = {};
    try { secrets = JSON.parse(this.pref('secretObj', '{}') || '{}'); } catch (_) {}
    const secret = String(secrets?.[service] || '');
    let url, model, format = 'chat', prefix = service;
    if (GPT.includes(service)) {
      prefix = service.replace('gpt', 'GPT');
      model = String(this.pref(prefix + '.model', ''));
      if (service === 'azuregpt') {
        const u = safeGet(() => new URL(String(this.pref('azureGPT.endPoint', ''))), null);
        if (!u || !model) return null;
        u.pathname = '/openai/deployments/' + model + '/chat/completions';
        u.search = 'api-version=' + this.pref('azureGPT.apiVersion', '');
        url = u.href;
      } else {
        const apiFormat = service.startsWith('customgpt') ? String(this.pref(prefix + '.apiFormat', '')) : '';
        if (apiFormat === 'anthropic') format = 'anthropic';
        url = normalizeEndpoint(this.pref(prefix + '.endPoint', ''), apiFormat);
        if (format === 'chat' && isResponses(url)) format = 'responses';
      }
    } else if (service === 'claude') {
      format = 'anthropic'; url = String(this.pref('claude.endPoint', '')); model = String(this.pref('claude.model', ''));
    } else if (service === 'gemini') {
      const u = safeGet(() => new URL(String(this.pref('gemini.endPoint', ''))), null);
      if (!u || !secret) return null;
      u.pathname = u.pathname.replace(/:(?:streamGenerateContent|generateContent)$/, '') + ':generateContent';
      u.search = ''; u.searchParams.set('key', secret);
      format = 'gemini'; url = u.href; model = 'gemini';
    } else return null;
    if (!url || !model || !safeURL(url)) return null;
    let extra = {};
    try { extra = JSON.parse(this.pref(prefix + '.customParams', '') || '{}') || {}; } catch (_) {}
    for (const key of ['model', 'messages', 'input', 'temperature', 'stream', 'system', 'max_tokens']) delete extra[key];
    const temperature = parseFloat(this.pref(prefix + '.temperature', ''));
    return { kind: 'llm', format, url, model, secret, extra, temperature: Number.isFinite(temperature) ? Math.min(temperature, 0.2) : undefined };
  }
}

function buildRequest(spec, prompt, tuned) {
  const headers = { 'Content-Type': 'application/json' };
  if (spec.format === 'gemini') return { headers, body: { contents: [{ role: 'user', parts: [{ text: prompt }] }] } };
  if (spec.format === 'anthropic') {
    headers['x-api-key'] = spec.secret; headers['anthropic-version'] = '2023-06-01';
    const body = { model: spec.model, max_tokens: 1024, messages: [{ role: 'user', content: prompt }], stream: false, ...spec.extra };
    if (tuned && Number.isFinite(spec.temperature)) body.temperature = spec.temperature;
    return { headers, body };
  }
  if (spec.secret) { headers.Authorization = 'Bearer ' + spec.secret; headers['api-key'] = spec.secret; }
  const think = tuned ? thinkingOff(spec.url, spec.model) : {};
  const extra = Object.fromEntries(Object.entries(spec.extra).filter(([k]) => !(k in think)));
  const body = { model: spec.model, stream: false, ...think, ...extra };
  if (spec.format === 'responses') { body.input = prompt; body.store = false; } else body.messages = [{ role: 'user', content: prompt }];
  if (tuned && Number.isFinite(spec.temperature) && !reasoningModel(spec.model)) body.temperature = spec.temperature;
  return { headers, body };
}

function answerText(spec, data) {
  let text = '';
  if (spec.format === 'gemini') text = (data?.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
  else if (Array.isArray(data?.content)) text = data.content.filter(b => b.type === 'text').map(b => b.text || '').join('');
  else if (Array.isArray(data?.output)) {
    text = data.output.flatMap(x => x.content || []).filter(c => c.type === 'output_text').map(c => c.text || '').join('');
  } else text = data?.choices?.[0]?.message?.content || data?.message?.content || '';
  return typeof text === 'string' ? text : '';
}

function usageOf(data) {
  const u = data?.usage || {};
  const total = Number(u.total_tokens) || (Number(u.prompt_tokens) || 0) + (Number(u.completion_tokens) || 0) ||
    (Number(u.input_tokens) || 0) + (Number(u.output_tokens) || 0) || Number(data?.usageMetadata?.totalTokenCount) || 0;
  return Number.isFinite(total) ? total : 0;
}

async function post(Z, url, headers, body, timeout) {
  try {
    const res = await Z.HTTP.request('POST', url, { headers, body: JSON.stringify(body), responseType: 'text', timeout });
    return JSON.parse(res.responseText || res.response);
  } catch (e) {
    const status = Number(e?.status || e?.xmlhttp?.status || 0);
    throw Object.assign(new Error(status ? 'HTTP_' + status : e instanceof SyntaxError ? 'BAD_JSON' : 'NETWORK'), { status });
  }
}

function groupKey(p, g) {
  return hash(['3', p.langfrom, p.langto, p.raw.slice(g.s[0], g.s[1]), p.result.slice(g.t[0], g.t[1])].join('\u0001'));
}

/** Installs links (offsets relative to the group) as the group's fine alignment. */
function applyLinks(g, relative) {
  const fine = relative.map(l => ({ s: [g.s[0] + l[0], g.s[0] + l[1]], t: [g.t[0] + l[2], g.t[0] + l[3]], k: 'm' }));
  const hit = (x, y) => x[0] < y[1] && x[1] > y[0];
  const kept = g.links.filter(l => l.k !== 'm' && (l.k !== 'g' || !fine.some(m => hit(m.s, l.s) || hit(m.t, l.t))));
  g.links = kept.concat(fine); g.done = true; g.note = '';
}

const WEAK_ZH = new Set(['的', '了', '着', '过', '之']);
const WEAK_EN = new Set(['a', 'an', 'the', 'be', 'been', 'being', 'is', 'are', 'was', 'were']);
function weak(token, lang) {
  return /^zh/i.test(String(lang || '')) ? WEAK_ZH.has(token.text) : WEAK_EN.has(token.text.toLowerCase());
}

class Aligner {
  constructor(Zotero, tfz, store, prefs, trace) {
    this.Z = Zotero; this.tfz = tfz; this.store = store; this.prefs = prefs; this.trace = trace || (() => {});
    this.queue = []; this.active = 0; this.plain = new Set(); this.disposed = false;
  }
  spec(p) {
    const prefs = this.prefs(), mode = prefs.alignSource;
    if (mode === 'off') return null;
    if (mode === 'auto') return safeGet(() => this.tfz.llmSpec(p.service), null);
    if (mode === 'jev') {
      const url = prefs.alignEndpoint || JEV_URL;
      if (!prefs.alignApiKey || !safeURL(url)) return null;
      return { kind: 'jev', url, model: prefs.alignModel || 'jev-latest', secret: prefs.alignApiKey };
    }
    const url = normalizeEndpoint(prefs.alignEndpoint, '');
    if (!url || !prefs.alignModel || !safeURL(url)) return null;
    const format = /\/messages$/.test(url) ? 'anthropic' : isResponses(url) ? 'responses' : 'chat';
    return { kind: 'llm', format, url, model: prefs.alignModel, secret: prefs.alignApiKey, extra: {}, temperature: 0 };
  }
  /** Starts a fine alignment of one sentence group unless it is done, running, or not allowed. */
  ensure(p, g, done) {
    if (g.done || this.disposed) return;
    if (done) (g.waiters || (g.waiters = new Set())).add(done);
    if (g.pending || (g.failAt && Date.now() - g.failAt < 5000)) return;
    const spec = this.spec(p);
    if (!spec) { g.note = 'off'; return; }
    if (!this.store.allowed()) { g.note = 'cap'; return; }
    g.pending = true; g.note = '';
    this.queue.push({ p, g, spec }); this.pump();
  }
  pump() {
    while (this.active < 3 && this.queue.length) {
      const job = this.queue.pop();
      this.active++;
      (job.lookup ? this.runLookup(job) : this.run(job)).finally(() => { this.active--; this.pump(); });
    }
  }
  /** Asks about one word or short phrase that the sentence alignment left out. */
  lookup(p, g, side, lo, hi, done) {
    if (this.disposed || !g.done) return;
    const key = side + lo + '-' + hi, asked = g.asked || (g.asked = new Map()), state = asked.get(key);
    if (state === 'done' || state === 'pending' || (typeof state === 'number' && Date.now() - state < 5000)) return;
    const spec = this.spec(p);
    if (!spec || spec.kind !== 'llm' || !this.store.allowed()) { asked.set(key, 'done'); return; }
    asked.set(key, 'pending'); g.looking = (g.looking || 0) + 1;
    this.queue.push({ p, g, spec, lookup: { side, lo, hi, key, done } }); this.pump();
  }
  async runLookup({ p, g, spec, lookup }) {
    const { side, lo, hi, key, done } = lookup, out = side === 's' ? 't' : 's', started = Date.now();
    const sText = p.raw.slice(g.s[0], g.s[1]), tText = p.result.slice(g.t[0], g.t[1]);
    const word = (side === 's' ? p.raw : p.result).slice(lo, hi);
    try {
      const answer = await this.ask(spec, A.lookupPrompt(sText, tText, side, lo - g[side][0], hi - g[side][0]));
      const near = g.links.reduce((best, l) => {
        const d = Math.abs(l[side][0] - lo);
        return !best || d < best.d ? { d, at: l[out][0] - g[out][0] } : best;
      }, null);
      const found = A.verifyLookup(side === 's' ? tText : sText, answer, near ? near.at : 0);
      for (const r of found) g.links.push({ [side]: [lo, hi], [out]: [g[out][0] + r[0], g[out][0] + r[1]], k: 'q' });
      g.asked.set(key, 'done');
      if (found.length) {
        this.store.putAlign(groupKey(p, g), g.links.filter(l => l.k === 'm' || l.k === 'q')
          .map(l => [l.s[0] - g.s[0], l.s[1] - g.s[0], l.t[0] - g.t[0], l.t[1] - g.t[0]]));
      }
      this.trace('lookup', { word, answer: answer.slice(0, 40), found: found.length, ms: Date.now() - started });
    } catch (e) {
      g.asked.set(key, Date.now());
      this.trace('lookup', { word, error: String(e?.message || 'FAILED'), ms: Date.now() - started });
    } finally {
      g.looking--;
      if (!this.disposed) safeGet(() => done?.());
    }
  }
  async run({ p, g, spec }) {
    const sText = p.raw.slice(g.s[0], g.s[1]), tText = p.result.slice(g.t[0], g.t[1]), started = Date.now();
    try {
      const links = spec.kind === 'jev' ? await this.jev(spec, p, sText, tText) : await this.llm(spec, sText, tText);
      if (!links.length) throw new Error('NO_VALID_PAIRS');
      applyLinks(g, links);
      this.store.putAlign(groupKey(p, g), links);
      for (const l of links) this.store.learn(p.langfrom + '>' + p.langto, sText.slice(l[0], l[1]), tText.slice(l[2], l[3]));
      this.trace('align', { links: links.length, chars: sText.length, ms: Date.now() - started });
    } catch (e) {
      g.failAt = Date.now(); g.note = 'fail'; g.error = String(e?.message || 'FAILED');
      this.trace('align', { error: g.error, chars: sText.length, ms: Date.now() - started });
      safeGet(() => this.Z.debug('[SyncTranslate] align failed: ' + g.error));
    } finally {
      g.pending = false;
      const waiters = [...(g.waiters || [])]; g.waiters = null;
      if (!this.disposed) for (const fn of waiters) safeGet(() => fn());
    }
  }
  async llm(spec, sText, tText) {
    const answer = await this.ask(spec, A.alignPrompt(sText, tText));
    const checked = A.verifyPairs(sText, tText, A.parsePairs(answer));
    if (checked.rejected) this.trace('rejected', { pairs: checked.rejected, kept: checked.links.length });
    return checked.links;
  }
  async ask(spec, prompt) {
    const id = spec.url + '|' + spec.model;
    let data, req = buildRequest(spec, prompt, !this.plain.has(id));
    try { data = await post(this.Z, spec.url, req.headers, req.body, 12000); }
    catch (e) {
      if (e.status !== 400 || this.plain.has(id)) throw e;
      this.plain.add(id);
      req = buildRequest(spec, prompt, false);
      data = await post(this.Z, spec.url, req.headers, req.body, 12000);
    }
    const answer = answerText(spec, data);
    this.store.spend(usageOf(data) || Math.ceil((prompt.length + answer.length) / 3));
    if (!answer) throw new Error('EMPTY_ANSWER');
    return answer;
  }
  async jev(spec, p, sText, tText) {
    const sw = A.tokenize(sText, p.langfrom).filter(t => t.word), tw = A.tokenize(tText, p.langto).filter(t => t.word);
    const questions = {};
    let count = 0;
    for (const t of tw) for (const s of sw) {
      if (count >= 1500 || (weak(s, p.langfrom) && weak(t, p.langto))) continue;
      questions['a_' + s.id + '_' + t.id] = { type: 'noul', instructions: { source_focus: [s.id, s.text], target_focus: [t.id, t.text] } };
      count++;
    }
    if (!count) return [];
    const body = { model: spec.model, questions, state: {
      task: 'bilingual_word_alignment_binary_matrix', source_language: p.langfrom, target_language: p.langto,
      source_sentences: [{ text: sText, words: sw.map(t => [t.id, t.text]) }],
      target_sentence: { text: tText, words: tw.map(t => [t.id, t.text]) },
      alignment_rule: 'For every Noul, return P(true) ONLY when source_focus and target_focus are direct bilingual alignment counterparts in this sentence context. Do NOT mark two tokens true merely because they occur in the same phrase or clause. Prefer a sparse matrix. Untranslated tokens may have no true edge.'
    } };
    const data = await post(this.Z, spec.url, { 'Content-Type': 'application/json', Authorization: 'Bearer ' + spec.secret }, body, 12000);
    this.store.spend(usageOf(data));
    const cells = [], rowMax = new Map(), colMax = new Map();
    for (const [key, answer] of Object.entries(data?.answers || {})) {
      const m = /^a_(\d+)_(\d+)$/.exec(key);
      const prob = Number(answer?.noul ?? answer?.probabilities?.true);
      if (!m || !Number.isFinite(prob)) continue;
      const cell = { s: Number(m[1]), t: Number(m[2]), prob };
      cells.push(cell);
      rowMax.set(cell.t, Math.max(rowMax.get(cell.t) || 0, prob));
      colMax.set(cell.s, Math.max(colMax.get(cell.s) || 0, prob));
    }
    const sByID = new Map(sw.map(t => [t.id, t])), tByID = new Map(tw.map(t => [t.id, t]));
    return cells.filter(c => c.prob >= 0.7 || (c.prob >= 0.5 && c.prob === rowMax.get(c.t) && c.prob === colMax.get(c.s)))
      .filter(c => sByID.has(c.s) && tByID.has(c.t))
      .map(c => [sByID.get(c.s).start, sByID.get(c.s).end, tByID.get(c.t).start, tByID.get(c.t).end]);
  }
  dispose() { this.disposed = true; this.queue = []; }
}

module.exports = { TFZ, Aligner, groupKey, applyLinks, normalizeEndpoint, buildRequest, answerText, usageOf, thinkingOff };
