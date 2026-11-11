'use strict';
const assert = require('assert');
const A = require('../src/lib/align');

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('ok  ' + name); }
const sText = (p, items) => items.map(i => p.raw.slice(i.s[0], i.s[1]));
const tText = (p, items) => items.map(i => p.result.slice(i.t[0], i.t[1]));
function passage(raw, result) { return { raw, result, groups: A.segment(raw, result) }; }
function applyModel(p, g, answer) {
  const s = p.raw.slice(g.s[0], g.s[1]), t = p.result.slice(g.t[0], g.t[1]);
  const v = A.verifyPairs(s, t, A.parsePairs(answer));
  g.links = g.links.concat(v.links.map(l => ({ s: [g.s[0] + l[0], g.s[0] + l[1]], t: [g.t[0] + l[2], g.t[0] + l[3]], k: 'm' })));
  g.done = true;
  return v;
}
function select(p, phrase, side = 't') {
  const text = side === 't' ? p.result : p.raw, at = text.indexOf(phrase);
  assert(at >= 0, 'phrase not in text: ' + phrase);
  return A.resolve(p, side, at, at + phrase.length);
}

const EN = 'Although the mechanism remains unclear, XBP1 splicing was markedly increased in tumor cells after treatment with the inhibitor.';
const ZH = '尽管机制尚不清楚，但在使用抑制剂处理后，肿瘤细胞中的XBP1剪接明显增加。';
const ANSWER = [
  'Although ||| 尽管', 'the mechanism ||| 机制', 'remains unclear ||| 尚不清楚', 'with ||| 在使用',
  'the inhibitor ||| 抑制剂', 'after treatment ||| 处理后', 'in tumor cells ||| 肿瘤细胞中的', 'XBP1 splicing ||| XBP1剪接',
  'was markedly ||| 明显', 'increased ||| 增加', 'made up phrase ||| 不存在的词'
].join('\n');

test('sentence split keeps abbreviations and decimals together', () => {
  const text = 'Cells were lysed (Fig. 2a) as described by Smith et al. in 2020. The p value was 0.05, i.e. significant. Next, we tested XBP1.';
  const parts = A.sentences(text).map(r => text.slice(r[0], r[1]));
  assert.strictEqual(parts.length, 3);
  assert(parts[0].endsWith('in 2020.'));
  assert(parts[1].startsWith('The p value'));
});

test('figure and reference numbers never end a sentence', () => {
  const text = 'Leakage rose (Fig. 1A and SupplementaryFig. 1B)42. It fell later (see ref. 12 and Eq. 3). Next, we tested 10 samples.';
  assert.strictEqual(A.sentences(text).length, 3);
});

test('chinese sentence split', () => {
  const text = '我们检测了XBP1。结果显示其表达升高！这是否重要？';
  assert.strictEqual(A.sentences(text).length, 3);
});

test('sentence pairing: 3 source sentences, 2 merged in translation', () => {
  const raw = 'We measured XBP1 expression. It was increased. The effect was blocked by 4u8C in all three cell lines tested here.';
  const result = '我们检测了XBP1的表达，发现其升高。在此处检测的全部三种细胞系中，该效应均被4u8C阻断。';
  const groups = A.pairSentences(raw, result);
  assert.strictEqual(groups.length, 2);
  assert(raw.slice(groups[0].s[0], groups[0].s[1]).endsWith('It was increased.'));
  assert(raw.slice(groups[1].s[0], groups[1].s[1]).startsWith('The effect'));
  assert(result.slice(groups[1].t[0], groups[1].t[1]).startsWith('在此处'));
});

test('before the model answers: whole sentence, marked coarse, and asks for alignment', () => {
  const p = passage(EN, ZH);
  const r = select(p, '抑制剂');
  assert.strictEqual(r.items.length, 1);
  assert.strictEqual(r.items[0].coarse, true);
  assert.strictEqual(sText(p, r.items)[0], EN);
  assert.strictEqual(r.need.length, 1);
});

test('anchor resolves a kept term with no request', () => {
  const p = passage(EN, ZH);
  const r = select(p, 'XBP1');
  assert.deepStrictEqual(sText(p, r.items), ['XBP1']);
  assert.strictEqual(r.items[0].coarse, false);
  assert.strictEqual(r.need.length, 0);
});

test('selecting the whole sentence never needs a request', () => {
  const p = passage(EN, ZH);
  const r = A.resolve(p, 't', 0, ZH.length);
  assert.strictEqual(r.need.length, 0);
  assert.strictEqual(r.items[0].coarse, false);
});

test('model pairs are verified verbatim; invented pairs are dropped', () => {
  const p = passage(EN, ZH);
  const v = applyModel(p, p.groups[0], ANSWER);
  assert.strictEqual(v.rejected, 1);
  assert(v.coverage > 0.9, 'coverage ' + v.coverage);
});

test('after the model answers: the earlier wrong cases are right', () => {
  const p = passage(EN, ZH);
  applyModel(p, p.groups[0], ANSWER);
  assert.deepStrictEqual(sText(p, select(p, '抑制剂').items), ['the inhibitor']);
  assert.deepStrictEqual(sText(p, select(p, '肿瘤细胞').items), ['in tumor cells']);
  assert.deepStrictEqual(sText(p, select(p, '机制').items), ['the mechanism']);
  assert.deepStrictEqual(sText(p, select(p, '明显增加').items), ['was markedly', 'increased']);
  const merged = A.mergeRanges(select(p, '明显增加').items.map(i => ({ a: i.s[0], b: i.s[1] })), p.raw);
  assert.deepStrictEqual(merged.map(r => p.raw.slice(r.a, r.b)), ['was markedly increased']);
});

test('reverse direction: source word to translation', () => {
  const p = passage(EN, ZH);
  applyModel(p, p.groups[0], ANSWER);
  assert.deepStrictEqual(tText(p, select(p, 'inhibitor', 's').items), ['抑制剂']);
  assert.deepStrictEqual(tText(p, select(p, 'XBP1', 's').items), ['XBP1']);
});

test('repeated words are matched in order, not always to the first hit', () => {
  const s = 'The cells were treated and the cells died.', t = '细胞经过处理，随后细胞死亡。';
  const v = A.verifyPairs(s, t, A.parsePairs('The cells ||| 细胞\nwere treated ||| 经过处理\nthe cells ||| 细胞\ndied ||| 死亡'));
  assert.strictEqual(v.links.length, 4);
  assert(v.links[2][0] > v.links[0][0] && v.links[2][2] > v.links[0][2]);
});

test('partial word match is refused', () => {
  const v = A.verifyPairs('Tumor cells grow.', '肿瘤细胞生长。', [['cell', '细胞'], ['grow', '生长']]);
  assert.strictEqual(v.links.length, 1);
});

test('dictionary senses locate the translation without a request', () => {
  const p = passage(EN, ZH), g = p.groups[0];
  const youdao = 'splicing\n英 [ˈsplaɪsɪŋ] 美 [ˈsplaɪsɪŋ]\nn. 剪接；拼接；接合\nv. 绞接（splice的ing形式）';
  const at = EN.indexOf('splicing');
  const link = A.candidateLink(p, g, at, at + 8, A.candidatesFrom(youdao, true));
  assert(link);
  assert.strictEqual(ZH.slice(link.t[0], link.t[1]), '剪接');
  assert.strictEqual(A.candidateLink(p, g, at, at + 8, A.candidatesFrom('n. 猫；狗', true)), null);
});

test('adjective sense with trailing 的 still matches', () => {
  assert(A.candidatesFrom('adj. 显著的；明显的', true).includes('明显'));
});


// A citation number glued to a word, and function words the model left unpaired.
const EN2 = 'We treated mice with compound A plus compound B based upon the earlier results obtained in vitro and compared the results to vehicle alone12–14. Mice that were treated with vehicle alone had a distinct pattern of actin localized to the cell membrane.';
const ZH2 = '我们对小鼠给予了化合物A联合化合物B，并与仅给予溶剂对照的结果进行比较12–14。仅给予溶剂的小鼠中，actin呈现定位于细胞膜的清晰分布模式。';
function passage2() {
  const p = passage(EN2, ZH2);
  assert.strictEqual(p.groups.length, 2);
  applyModel(p, p.groups[0], 'We treated mice with ||| 我们对小鼠给予了\ncompound A plus compound B ||| 化合物A联合化合物B\nand compared the results to vehicle alone ||| 并与仅给予溶剂对照的结果进行比较');
  applyModel(p, p.groups[1], 'treated with vehicle alone ||| 仅给予溶剂的\nMice ||| 小鼠\nof actin ||| actin\nhad ||| 呈现\nlocalized to the cell membrane ||| 定位于细胞膜的\na distinct pattern ||| 清晰分布模式');
  return p;
}
const shown = (p, r) => A.mergeRanges(r.items.map(i => ({ a: i.s[0], b: i.s[1], coarse: i.coarse })), p.raw).map(x => p.raw.slice(x.a, x.b));

test('a citation number glued to a word does not block the match', () => {
  const p = passage2();
  assert.deepStrictEqual(shown(p, select(p, '并与仅给予溶剂对照的结果进行比较12–14')), ['and compared the results to vehicle alone12–14']);
});

test('unpaired words between two selected phrases are filled in', () => {
  const p = passage2();
  assert.deepStrictEqual(shown(p, select(p, '仅给予溶剂的小鼠中')), ['Mice that were treated with vehicle alone']);
});

test('a selection across two sentences is continuous except where word order really differs', () => {
  const p = passage2();
  assert.deepStrictEqual(shown(p, select(p, '并与仅给予溶剂对照的结果进行比较12–14。仅给予溶剂的小鼠中，actin呈现')),
    ['and compared the results to vehicle alone12–14. Mice that were treated with vehicle alone had', 'of actin']);
});

test('words paired with unselected translation are not filled in', () => {
  const p = passage2();
  const out = shown(p, select(p, 'actin呈现定位于细胞膜的'));
  assert(!out.join(' ').includes('distinct pattern'), out.join(' | '));
});

// Word-level pairs: one word gives one word, and a range still stays continuous.
const EN3 = 'Moreover, the size of the drop in barrier function (~90%) caused by LPS and the size of the drop in actin at the membrane region (~90%) were similar.';
const ZH3 = '此外，LPS所致屏障功能下降的幅度（约90%）与膜区域actin下降的幅度（约90%）相似。';
const WORDS3 = ['Moreover ||| 此外', 'caused ||| 所致', 'barrier ||| 屏障', 'function ||| 功能', 'drop ||| 下降', 'size ||| 幅度',
  'membrane ||| 膜', 'region ||| 区域', 'drop ||| 下降', 'size ||| 幅度', 'similar ||| 相似'].join('\n');
function passage3() { const p = passage(EN3, ZH3); applyModel(p, p.groups[0], WORDS3); return p; }
const point = (p, word, nth = 0) => {
  let at = -1;
  for (let k = 0; k <= nth; k++) at = p.raw.indexOf(word, at + 1);
  return A.resolve(p, 's', at, at + word.length);
};

test('pointing at one word gives one word', () => {
  const p = passage3();
  assert.deepStrictEqual(tText(p, point(p, 'barrier').items), ['屏障']);
  assert.deepStrictEqual(tText(p, point(p, 'function').items), ['功能']);
  assert.deepStrictEqual(tText(p, point(p, 'region').items), ['区域']);
});

test('a repeated word goes to the right occurrence', () => {
  const p = passage3();
  const first = point(p, 'drop', 0).items[0], second = point(p, 'drop', 1).items[0];
  assert.strictEqual(p.result.slice(first.t[0], first.t[1]), '下降的');
  assert(first.t[0] < ZH3.indexOf('膜区域') && second.t[0] > ZH3.indexOf('膜区域'));
  assert(point(p, 'size', 0).items[0].t[0] < point(p, 'size', 1).items[0].t[0]);
});

test('pointing at an unpaired word uses the word it belongs to', () => {
  const p = passage3();
  assert.deepStrictEqual(tText(p, point(p, 'in').items), ['屏障']);
  assert.deepStrictEqual(tText(p, point(p, 'by').items), ['LPS']);
});

test('word-level pairs still give a continuous range', () => {
  const p = passage3();
  assert.deepStrictEqual(shown(p, select(p, '屏障功能下降的幅度')), ['the size of the drop in barrier function']);
  assert.deepStrictEqual(shown(p, select(p, '屏障功能')), ['in barrier function']);
});

// The translation runs past the selected source (the model translated more than it was given).
const EN4 = 'The gut barrier is a key defense against bacterial invasion and is usually thought to fail slowly. ' +
  'Here, we show a fast mechanism in which the factor ABC1 drives rapid loss of barrier function without new gene expression. ' +
  'Using a 3D culture device and a mouse model, we show that bacteria move ABC1 to the nucleus with later shift of actin from the membrane to the';
const ZH4 = '肠道屏障是抵御细菌入侵的关键防线，通常认为其失效较为缓慢。在此，我们揭示了一种快速机制，即因子ABC1在不依赖新基因表达的情况下驱动屏障功能迅速丧失。' +
  '利用3D培养装置和小鼠模型，我们证明细菌使ABC1进入细胞核，随后actin从细胞膜转移至细胞质，导致渗漏增加。此外，刺激增强了ABC1与DEF2的结合并促进其Tyr100磷酸化。' +
  '仅限于细胞核的ABC1表达即足以诱导屏障失效。这些发现确立了一种此前未被认识的快速反应机制。';

test('a translation longer than the selected source: extra sentences stay unpaired', () => {
  const p = passage(EN4, ZH4);
  assert.strictEqual(p.groups.length, 3);
  assert.deepStrictEqual(p.groups.map(g => ZH4.slice(g.t[0], g.t[0] + 2)), ['肠道', '在此', '利用']);
  assert.deepStrictEqual(p.groups.map(g => EN4.slice(g.s[0], g.s[0] + 5)), ['The g', 'Here,', 'Using']);
  assert.strictEqual(p.groups.ratio, undefined, 'a lopsided passage does not feed the length ratio');
});

test('selecting in the second sentence lands in the second sentence, not the first', () => {
  const p = passage(EN4, ZH4);
  const r = select(p, '即因子ABC1在不依赖新基因表达的情况下驱动屏障功能迅速丧失');
  assert.strictEqual(r.items.length, 1);
  assert(sText(p, r.items)[0].startsWith('Here, we show'));
});

test('selecting translation that has no source gives nothing', () => {
  const p = passage(EN4, ZH4);
  assert.strictEqual(select(p, '仅限于细胞核的ABC1表达').items.length, 0);
  assert.strictEqual(select(p, '这些发现').items.length, 0);
});

test('plain prose without names or numbers: the usual length ratio decides', () => {
  const groups = A.pairSentences('The cat sat quietly on the warm mat by the door.', '那只猫安静地坐在门边温暖的垫子上。它看起来很满足。窗外正在下雨。');
  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].t[1], 17);
});

test('an evenly paired passage reports its length ratio', () => {
  const p = passage('We measured XBP1 expression. It was increased in all samples.', '我们检测了XBP1的表达。它在所有样本中均升高。');
  assert.strictEqual(p.groups.length, 2);
  assert(p.groups.ratio > 0.2 && p.groups.ratio < 0.6);
});

test('occurrence numbers from the model decide repeated words, in any listing order', () => {
  const s = 'The cells were treated and the cells died.', zh = '细胞经过处理，随后细胞死亡。';
  for (const pairs of [['died ||| 死亡', 'cells#2 ||| 细胞#2', 'treated ||| 处理', 'cells ||| 细胞'], ['cells ||| 细胞', 'cells#2 ||| 细胞#2']]) {
    const links = A.verifyPairs(s, zh, pairs.map(x => x.split(' ||| '))).links;
    const first = links.find(l => l[0] === s.indexOf('cells')), second = links.find(l => l[0] === s.lastIndexOf('cells'));
    assert.strictEqual(first[2], zh.indexOf('细胞'));
    assert.strictEqual(second[2], zh.lastIndexOf('细胞'));
  }
});

test('without occurrence numbers, neighbours decide; a number out of range is ignored', () => {
  const s = 'The cells were treated and the cells died.', zh = '细胞经过处理，随后细胞死亡。';
  const links = A.verifyPairs(s, zh, [['died', '死亡'], ['cells', '细胞'], ['treated', '处理'], ['cells#5', '细胞']]).links;
  assert.strictEqual(links.length, 4);
  const second = links.find(l => l[0] === s.lastIndexOf('cells'));
  assert.strictEqual(second[2], zh.lastIndexOf('细胞'));
});

test('a word copied with its capital letter names that occurrence', () => {
  const s = 'Exposure to bacteria raised leakage, as shown by exposure to two strains.', zh = '细菌暴露使渗漏增加，两种菌株均如此。';
  const links = A.verifyPairs(s, zh, [['strains', '菌株'], ['Exposure', '暴露'], ['bacteria', '细菌']]).links;
  assert.strictEqual(links.find(l => zh.slice(l[2], l[3]) === '暴露')[0], 0);
});

test('the prompt states the rules the local check relies on', () => {
  const prompt = A.alignPrompt('a', 'b');
  for (const rule of ['|||', 'exactly', '#2', 'articles', 'Never pair a clause']) assert(prompt.includes(rule), rule);
});

test('single-word reply: exact match, nearest occurrence, and "none"', () => {
  const text = '细胞经过处理，随后细胞死亡。';
  assert.deepStrictEqual(A.verifyLookup(text, '处理', 0), [[4, 6]]);
  assert.deepStrictEqual(A.verifyLookup(text, '「细胞」', 8), [[9, 11]]);
  assert.deepStrictEqual(A.verifyLookup(text, '-', 0), []);
  assert.deepStrictEqual(A.verifyLookup(text, '不存在', 0), []);
  assert(A.lookupPrompt('a b c', 'x y', 's', 2, 3).includes('Source: a [[b]] c'));
});

console.log(passed + ' passed');
