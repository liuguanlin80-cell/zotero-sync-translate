'use strict';
const assert = require('assert');
const G = require('../src/lib/geom');

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('ok  ' + name); }
// One glyph per character, as the PDF page data gives them.
function page(text) {
  return { text, map: [...text].map((c, i) => (c === ' ' ? null : { pageIndex: 0, charIndex: i, rect: [i, 0, i + 1, 10], hitRect: [i, 0, i + 1, 10], rotation: 0 })) };
}
const SOURCE = 'Fertility test in knockout female mice. Plugging latency from cohabitation to detection of the first vaginal plug. ' +
  'Pregnancy rates were recorded at two, five and seven months for every cohort.';

test('exact text maps every letter', () => {
  const found = G.sourceGeometryFromCaptures(SOURCE, [{ text: SOURCE, geometry: page(SOURCE) }]);
  assert.strictEqual(found.ratio, 1);
});

test('page characters that differ in places still give coordinates for the rest', () => {
  // a figure label caught inside the selection, and two characters the PDF encodes differently
  const noisy = SOURCE.replace('Plugging', 'Control 2M 5M Plugging').replace('vaginal', 'vagina1').replace('cohort', 'c0hort');
  const capture = { text: SOURCE, geometry: page(noisy) };
  assert.strictEqual(G.mapGeometry(SOURCE, capture.geometry), null, 'the exact match fails');
  const found = G.sourceGeometryFromCaptures(SOURCE, [capture]);
  assert(found && found.ratio > 0.75, 'ratio ' + (found && found.ratio));
  const at = SOURCE.indexOf('latency');
  assert.strictEqual(noisy[found.map[at][0].charIndex], 'l');
  assert.strictEqual(noisy.slice(found.map[at][0].charIndex, found.map[at][0].charIndex + 7), 'latency');
});

test('unrelated page text gives no coordinates', () => {
  const other = page('Completely different words about weather, rivers and mountains in a distant northern country far away.');
  assert.strictEqual(G.sourceGeometryFromCaptures(SOURCE, [{ text: 'x', geometry: other }]), null);
});

console.log(passed + ' passed');
