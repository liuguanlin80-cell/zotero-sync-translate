'use strict';
const { LETTER, letterCount } = require('./util');

const ALPHA = /[A-Za-zÀ-ɏ]/, DIGIT = /[0-9]/;
/** True when two neighbouring characters belong to one word or one number. */
function joined(a, b) { return (ALPHA.test(a) && ALPHA.test(b)) || (DIGIT.test(a) && DIGIT.test(b)); }
const TERM = /[A-Za-z0-9][A-Za-z0-9.\-\/]*[A-Za-z0-9]|[A-Za-z0-9]/g;
const ABBR = /(?:^|[\s(\[])(?:Fig|Figs|Eq|Eqs|Ref|Refs|No|Nos|Dr|Mr|Mrs|Ms|Prof|vs|etc|al|approx|ca|cf|e\.g|i\.e|St|Vol|pp|Suppl|Tab|[A-Za-z])$/;

function isCJK(text) { return /[぀-ヿ㐀-鿿가-힯]/.test(text); }

function tokenize(text, lang) {
  text = String(text || '');
  let segments = null;
  try {
    segments = [...new Intl.Segmenter(lang && lang !== 'auto' ? lang : undefined, { granularity: 'word' }).segment(text)];
  } catch (_) {}
  if (!segments) {
    segments = [...text.matchAll(/[\p{L}\p{N}\p{M}]+(?:['’-][\p{L}\p{N}\p{M}]+)*|[^\s]/gu)]
      .map(m => ({ segment: m[0], index: m.index, isWordLike: LETTER.test(m[0]) }));
  }
  return segments.filter(s => s.segment.trim()).map((s, i) => ({
    id: i, text: s.segment, start: s.index, end: s.index + s.segment.length,
    word: s.isWordLike === undefined ? LETTER.test(s.segment) : s.isWordLike
  }));
}

function sentences(text) {
  const out = [];
  let start = 0;
  const push = end => {
    let a = start, b = end;
    while (a < b && /\s/.test(text[a])) a++;
    while (b > a && /\s/.test(text[b - 1])) b--;
    if (b > a) {
      if (letterCount(text, a, b)) out.push([a, b]);
      else if (out.length) out[out.length - 1][1] = b;
    }
    start = end;
  };
  const re = /([.!?]+)["'”’)\]]*(?=\s+\S)|[。！？]+["'”’」』）]*/gu;
  for (const m of text.matchAll(re)) {
    const end = m.index + m[0].length;
    if (m[1] === '.') {
      if (ABBR.test(text.slice(Math.max(start, m.index - 8), m.index))) continue;
      const next = text.slice(end).match(/\S/);
      if (next && /\p{Ll}/u.test(next[0])) continue;
    }
    push(end);
  }
  push(text.length);
  return out.length ? out : [[0, text.length]];
}

function occurrences(text, a, b, value) {
  const out = [];
  for (let pos = text.indexOf(value, a); pos >= 0 && pos + value.length <= b; pos = text.indexOf(value, pos + 1)) {
    const end = pos + value.length;
    if (pos > 0 && joined(text[pos - 1], text[pos])) continue;
    if (end < text.length && joined(text[end - 1], text[end])) continue;
    out.push(pos);
  }
  return out;
}

function isAnchorTerm(value, cjkTarget) {
  return /\d/.test(value) || /[A-Z]/.test(value.slice(1)) || (cjkTarget && value.length >= 2 && /[A-Za-z]/.test(value));
}

function anchorLinks(raw, result, g) {
  const cjk = isCJK(result), links = [];
  const count = new Map();
  const found = [...result.slice(g.t[0], g.t[1]).matchAll(TERM)];
  for (const m of found) count.set(m[0], (count.get(m[0]) || 0) + 1);
  for (const m of found) {
    const v = m[0];
    if (count.get(v) !== 1 || !isAnchorTerm(v, cjk)) continue;
    const at = g.t[0] + m.index;
    if (occurrences(result, g.t[0], g.t[1], v).length !== 1) continue;
    const occ = occurrences(raw, g.s[0], g.s[1], v);
    if (occ.length === 1) links.push({ s: [occ[0], occ[0] + v.length], t: [at, at + v.length], k: 'a' });
  }
  return links;
}

/** Pairs sentences of the source with sentences of the translation. Either side may hold sentences the
 * other lacks (a translation that runs past the selection, a truncated reply); those stay unpaired.
 * prior: expected translation/source length ratio for this language pair, when known. */
function pairSentences(raw, result, prior) {
  const S = sentences(raw), T = sentences(result), ns = S.length, nt = T.length;
  const whole = [{ s: [0, raw.length], t: [0, result.length] }];
  const totS = letterCount(raw), totT = letterCount(result);
  if (!totS || !totT) return whole;
  const sl = S.map(r => Math.max(1, letterCount(raw, r[0], r[1])));
  const tl = T.map(r => Math.max(1, letterCount(result, r[0], r[1])));
  const cjk = isCJK(result);
  // Names and numbers the translation keeps as they are, counted per sentence on both sides.
  const vocab = [...new Set([...result.matchAll(TERM)].map(m => m[0]).filter(v => isAnchorTerm(v, cjk)))];
  const count = (text, r) => vocab.map(v => occurrences(text, r[0], r[1], v).length);
  const sc = S.map(r => count(raw, r)), tc = T.map(r => count(result, r));
  const sum = (arr, i, n) => { let v = 0; for (let k = 0; k < n; k++) v += arr[i + k]; return v; };
  const terms = (i, sn, j, tn) => {
    let miss = 0, hit = 0;
    for (let v = 0; v < vocab.length; v++) {
      let a = 0, b = 0;
      for (let k = 0; k < sn; k++) a += sc[i + k][v];
      for (let k = 0; k < tn; k++) b += tc[j + k][v];
      miss += Math.abs(a - b); hit += Math.min(a, b);
    }
    return Math.min(1.6, 0.45 * miss) - Math.min(1.2, 0.35 * hit);
  };
  const base = prior || (cjk && !isCJK(raw) ? 0.3 : !cjk && isCJK(raw) ? 3.3 : 1);
  const r0 = totT / totS, EDGE = 0.5;
  const moves = [[1, 1, 0], [1, 2, 0.34], [2, 1, 0.34], [1, 0, 1.6], [0, 1, 1.6]];
  let best = null;
  for (const r of new Set([r0, base, Math.sqrt(r0 * base), base * 1.35, base / 1.35])) {
    const dp = Array.from({ length: ns + 1 }, () => Array(nt + 1).fill(Infinity));
    const prev = Array.from({ length: ns + 1 }, () => Array(nt + 1).fill(null));
    // Both sides start together; what one side lacks is at the end.
    for (let i = 0; i <= ns; i++) dp[i][0] = i * 1.6;
    for (let j = 0; j <= nt; j++) dp[0][j] = j * 1.6;
    for (let i = 0; i <= ns; i++) for (let j = 0; j <= nt; j++) {
      for (const [sn, tn, penalty] of moves) {
        const ni = i + sn, nj = j + tn;
        if (ni > ns || nj > nt) continue;
        const cost = sn && tn
          ? Math.abs(Math.log(sum(tl, j, tn) / (r * sum(sl, i, sn)))) + penalty + terms(i, sn, j, tn) : penalty;
        if (dp[i][j] + cost < dp[ni][nj]) { dp[ni][nj] = dp[i][j] + cost; prev[ni][nj] = { i, j, sn, tn }; }
      }
    }
    for (let i = 0; i <= ns; i++) for (let j = 0; j <= nt; j++) {
      const total = dp[i][j] + (ns - i + nt - j) * EDGE + Math.abs(Math.log(r / base));
      if (!best || total < best.total) best = { total, i, j, prev };
    }
  }
  const groups = [];
  for (let i = best.i, j = best.j; best.prev[i][j];) {
    const p = best.prev[i][j];
    if (p.sn && p.tn) groups.unshift({ s: [S[p.i][0], S[p.i + p.sn - 1][1]], t: [T[p.j][0], T[p.j + p.tn - 1][1]] });
    i = p.i; j = p.j;
  }
  if (!groups.length) return whole;
  const paired = n => groups.reduce((sum, g) => sum + n(g), 0);
  groups.stats = { source: ns, translation: nt, pairs: groups.length };
  if (paired(g => letterCount(raw, g.s[0], g.s[1])) === totS && paired(g => letterCount(result, g.t[0], g.t[1])) === totT) groups.ratio = r0;
  return groups;
}

function segment(raw, result, prior) {
  const groups = pairSentences(raw, result, prior);
  for (const g of groups) {
    g.n = { s: letterCount(raw, g.s[0], g.s[1]), t: letterCount(result, g.t[0], g.t[1]) };
    g.links = anchorLinks(raw, result, g);
    g.done = false;
  }
  return groups;
}

function norm(text) {
  let v = '';
  const map = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (/\s/.test(c)) {
      if (v && v[v.length - 1] !== ' ') { v += ' '; map.push(i); }
      continue;
    }
    const n = c.normalize('NFKC').toLowerCase()
      .replace(/[“”„«»]/g, '"').replace(/[‘’]/g, "'").replace(/[‐-―−]/g, '-');
    for (let k = 0; k < n.length; k++) { v += n[k]; map.push(i); }
  }
  return { v, map };
}

function findAll(h, text, needle) {
  const n = norm(String(needle || '')).v.trim(), out = [];
  if (!n) return out;
  for (let pos = h.v.indexOf(n); pos >= 0; pos = h.v.indexOf(n, pos + 1)) {
    const a = h.map[pos], b = h.map[pos + n.length - 1] + 1;
    if (a > 0 && joined(text[a - 1], text[a])) continue;
    if (b < text.length && joined(text[b - 1], text[b])) continue;
    out.push([a, b]);
  }
  return out;
}

function alignPrompt(source, translation) {
  return 'Align the translation with its source word by word.\n' +
    'Output one pair per line: source word ||| translated word\n' +
    'Copy both sides exactly as they appear. Pair single words; join words only when they translate as one unit. ' +
    'If a word occurs more than once, include a neighbouring word so the pair is unambiguous. ' +
    'Skip words that have no counterpart. Follow the order of the translation. Output nothing else.\n\n' +
    'Source: The drug markedly reduced tumor growth in mice.\n' +
    'Translation: 该药物显著抑制了小鼠的肿瘤生长。\n' +
    'drug ||| 药物\nmarkedly ||| 显著\nreduced ||| 抑制\nmice ||| 小鼠\ntumor ||| 肿瘤\ngrowth ||| 生长\n\n' +
    'Source: ' + source + '\nTranslation: ' + translation;
}

/** Question about the words in [a,b) of one side that the sentence alignment left out. */
function lookupPrompt(source, translation, side, a, b) {
  const mark = text => text.slice(0, a) + '[[' + text.slice(a, b) + ']]' + text.slice(b);
  const from = side === 's' ? 'source' : 'translation', to = side === 's' ? 'translation' : 'source';
  return 'The words marked with [[ ]] are in the ' + from + '. Reply with the exact words of the ' + to +
    ' that correspond to them, copied as they appear, or - if there are none. Reply with nothing else.\n' +
    'Source: ' + (side === 's' ? mark(source) : source) + '\nTranslation: ' + (side === 't' ? mark(translation) : translation);
}

/** Ranges of text that the reply names; a repeated word resolves to the occurrence nearest to hint. */
function verifyLookup(text, answer, hint) {
  const line = String(answer || '').replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim().split(/\r?\n/)[0] || '';
  const h = norm(text), out = [];
  for (let part of line.split(/\s*(?:\.\.\.|…|\|\|\|)\s*/)) {
    part = part.replace(/^[\s"'“”「」\[\]`]+|[\s"'“”「」\[\]`。.，,]+$/g, '');
    if (!part || part === '-' || part.length > 60) continue;
    const occ = findAll(h, text, part).filter(r => !out.some(o => r[0] < o[1] && r[1] > o[0]));
    if (occ.length) out.push(occ.reduce((best, r) => Math.abs(r[0] - hint) < Math.abs(best[0] - hint) ? r : best, occ[0]));
  }
  return out;
}

function parsePairs(answer) {
  const text = String(answer || '').replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').replace(/```[a-z]*\n?/gi, '');
  const sep = text.includes('|||') ? '|||' : text.includes('\t') ? '\t' : ' = ';
  const clean = x => x.trim().replace(/^[-*•]\s+/, '').replace(/^["'“”「」`]+|["'“”「」`]+$/g, '').trim();
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf(sep);
    if (at < 0) continue;
    const s = clean(line.slice(0, at)), t = clean(line.slice(at + sep.length));
    if (s && t && s.length <= 300 && t.length <= 300) out.push([s, t]);
    if (out.length >= 300) break;
  }
  return out;
}

/** Keeps a pair only when both phrases are found verbatim. Offsets are relative to the two texts. */
function verifyPairs(sText, tText, pairs) {
  const hs = norm(sText), ht = norm(tText), links = [], usedS = [], usedT = [];
  const ns = letterCount(sText), nt = letterCount(tText);
  const free = (r, used) => !used.some(u => r[0] < u[1] && r[1] > u[0]);
  let lastS = 0, lastT = 0, rejected = 0;
  for (const [sp, tp] of pairs) {
    const tOcc = findAll(ht, tText, tp).filter(r => free(r, usedT));
    const sOcc = findAll(hs, sText, sp).filter(r => free(r, usedS));
    if (!tOcc.length || !sOcc.length) { rejected++; continue; }
    const t = tOcc.find(r => r[0] >= lastT) || tOcc[0];
    const s = sOcc.reduce((best, r) => Math.abs(r[0] - lastS) < Math.abs(best[0] - lastS) ? r : best, sOcc[0]);
    if (ns > 12 && letterCount(sText, s[0], s[1]) > 0.7 * ns && letterCount(tText, t[0], t[1]) > 0.7 * nt) continue;
    links.push([s[0], s[1], t[0], t[1]]);
    usedS.push(s); usedT.push(t); lastS = s[1]; lastT = t[1];
  }
  let covered = 0;
  for (const u of usedT) covered += letterCount(tText, u[0], u[1]);
  return { links, rejected, coverage: nt ? covered / nt : 0 };
}

const BREAK = /[,;:，；：。.!?！？()（）、]/;

/** A short run of short words ("of the", "that were", "的"): function words, not content left out by the model. */
function minor(run) {
  if (isCJK(run)) return run.length <= 2;
  const words = run.split(/\s+/);
  return run.length <= 14 && words.length <= 3 && words.every(w => letterCount(w) <= 5);
}

/** Unpaired words go with a neighbouring pair: the following one in spaced scripts ("of the loss"),
 * the preceding one for Chinese-style particles. Returns each link's widened range on one side. */
function owned(g, text, side) {
  const key = side + g.links.length + ':' + g.links.reduce((n, l) => n + l[side][0] + l[side][1], 0);
  if (g.owned?.[key]) return g.owned[key];
  const ranges = new Map(g.links.map(l => [l, [l[side][0], l[side][1]]]));
  const sorted = [...g.links].sort((x, y) => x[side][0] - y[side][0]);
  const linked = i => sorted.some(l => i >= l[side][0] && i < l[side][1]);
  const clear = (x, y) => !letterCount(text, x, y) && !BREAK.test(text.slice(x, y));
  const end = g[side][1];
  for (let i = g[side][0]; i < end;) {
    if (!LETTER.test(text[i]) || linked(i)) { i++; continue; }
    let j = i;
    while (j < end && !linked(j) && !BREAK.test(text[j])) j++;
    let b = j;
    while (b > i && !LETTER.test(text[b - 1])) b--;
    if (minor(text.slice(i, b))) {
      const next = sorted.find(l => l[side][0] >= b && clear(b, l[side][0]));
      const prev = [...sorted].reverse().find(l => l[side][1] <= i && clear(l[side][1], i));
      const owner = isCJK(text.slice(i, b)) ? prev || next : next || prev;
      if (owner) { const r = ranges.get(owner); r[0] = Math.min(r[0], i); r[1] = Math.max(r[1], b); }
    }
    i = Math.max(j, i + 1);
  }
  g.owned = { ...(g.owned || {}), [key]: ranges };
  return ranges;
}

/** side: 't' when [a,b) is a range of the translation, 's' for the source. */
function resolve(p, side, a, b) {
  const text = side === 't' ? p.result : p.raw, items = [], need = [], miss = [];
  const out = side === 't' ? 's' : 't', outText = side === 't' ? p.raw : p.result;
  for (const g of p.groups) {
    let lo = Math.max(a, g[side][0]), hi = Math.min(b, g[side][1]);
    while (lo < hi && !LETTER.test(text[lo])) lo++;
    while (hi > lo && !LETTER.test(text[hi - 1])) hi--;
    if (hi <= lo) continue;
    const n = letterCount(text, lo, hi);
    if (n >= 0.85 * g.n[side]) { items.push({ s: g.s, t: g.t, coarse: false }); continue; }
    const mine = owned(g, text, side), theirs = owned(g, outText, out);
    const hit = r => {
      const ov = Math.min(hi, r[1]) - Math.max(lo, r[0]);
      return ov > 0 && (ov * 2 >= r[1] - r[0] || ov * 2 >= hi - lo);
    };
    let picked = g.links.filter(l => hit(l[side]) || hit(mine.get(l)));
    // A selection inside one pair resolves to that pair alone: the tightest one.
    const within = (r) => r[0] <= lo && r[1] >= hi;
    const containing = picked.filter(l => within(mine.get(l)));
    if (containing.length) {
      const size = l => (within(l[side]) ? 0 : 1e6) + l[side][1] - l[side][0];
      picked = [containing.reduce((x, y) => size(y) < size(x) ? y : x)];
    }
    let covered = 0;
    for (let i = lo; i < hi; i++) {
      if (LETTER.test(text[i]) && picked.some(l => i >= mine.get(l)[0] && i < mine.get(l)[1])) covered++;
    }
    const full = covered >= n;
    if (picked.length && (g.done || full)) {
      for (const l of picked) items.push({ [side]: mine.get(l), [out]: theirs.get(l), coarse: false });
      // Words left unpaired between two selected pairs belong with them.
      const sorted = [...picked].sort((x, y) => theirs.get(x)[0] - theirs.get(y)[0]);
      for (let k = 0; k + 1 < sorted.length; k++) {
        const ga = theirs.get(sorted[k])[1], gb = theirs.get(sorted[k + 1])[0];
        if (gb <= ga || gb - ga > 40 || !letterCount(outText, ga, gb)) continue;
        if (g.links.some(l => !picked.includes(l) && theirs.get(l)[0] < gb && theirs.get(l)[1] > ga)) continue;
        const edge = mine.get(sorted[k])[1];
        items.push({ [out]: [ga, gb], [side]: [edge, edge], coarse: false });
      }
    } else {
      items.push({ s: g.s, t: g.t, coarse: true });
      if (g.done && !picked.length) miss.push({ g, lo, hi });
    }
    if (!g.done && !full) need.push(g);
  }
  return { items, need, miss };
}

function mergeRanges(list, text) {
  const out = [];
  for (const r of [...list].sort((x, y) => x.a - y.a || x.b - y.b)) {
    const last = out[out.length - 1];
    if (last && !!last.coarse === !!r.coarse && (r.a <= last.b || !letterCount(text, last.b, r.a))) last.b = Math.max(last.b, r.b);
    else out.push({ a: r.a, b: r.b, coarse: !!r.coarse });
  }
  return out;
}

function glyphsForRanges(ranges, map) {
  const out = [];
  ranges.forEach((r, group) => {
    const seen = new Set();
    for (let i = r.a; i < r.b; i++) for (const g of map[i] || []) {
      const key = g.pageIndex + ':' + g.charIndex;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...g, _syncGroup: group, _coarse: !!r.coarse });
    }
  });
  return out;
}

/** Candidate translations of a sub-selection, taken from what TFZ already returned for it. */
function candidatesFrom(resultText, isDictionary) {
  const text = String(resultText || '');
  if (!isDictionary) {
    const c = text.trim().replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, '');
    return c && c.length <= 40 ? [c] : [];
  }
  const out = new Set();
  for (let x of text.split(/[\s;；,，、。.:：()（）\[\]【】<>《》\/|]+/u)) {
    x = x.trim();
    if (!x || x.length > 20 || (isCJK(x) ? x.length < 2 : x.length < 3)) continue;
    out.add(x);
    if (isCJK(x) && x.length >= 3 && /[的地了]$/.test(x)) out.add(x.slice(0, -1));
  }
  return [...out];
}

function candidateLink(p, g, a, b, candidates) {
  const tText = p.result.slice(g.t[0], g.t[1]), h = norm(tText);
  for (const c of [...candidates].sort((x, y) => y.length - x.length)) {
    const occ = findAll(h, tText, c);
    if (occ.length === 1) return { s: [a, b], t: [g.t[0] + occ[0][0], g.t[0] + occ[0][1]], k: 'd' };
  }
  return null;
}

module.exports = { isCJK, tokenize, sentences, pairSentences, segment, norm, findAll, alignPrompt, parsePairs, lookupPrompt, verifyLookup,
  verifyPairs, resolve, mergeRanges, glyphsForRanges, candidatesFrom, candidateLink };
