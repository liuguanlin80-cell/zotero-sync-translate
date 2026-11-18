'use strict';
const assert = require('assert');
const { PDFAdapter } = require('../src/lib/pdf');

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('ok  ' + name); }
const glyph = (pageIndex, i) => ({ pageIndex, charIndex: i, rect: [i * 10, 100, i * 10 + 8, 110], rotation: 0 });

(async () => {
  await test('pages that are not next to each other become separate annotations', async () => {
    const written = [];
    const reader = { _internalReader: { _annotationManager: { addAnnotation: a => written.push(a) } } };
    const pdf = new PDFAdapter(reader, () => {});
    pdf.views = [{ app: { pdfViewer: { getPageView: () => null } }, view: { _getPageLabel: i => String(i + 1) } }];
    const glyphs = [glyph(4, 1), glyph(4, 2), glyph(6, 1), glyph(7, 1)];
    assert.strictEqual(await pdf.createPermanentHighlight(glyphs, '#ffd400', 'q'), true);
    assert.strictEqual(written.length, 2);
    assert.strictEqual(written[0].position.pageIndex, 4);
    assert.strictEqual(written[0].position.nextPageRects, undefined);
    assert.strictEqual(written[1].position.pageIndex, 6);
    assert.strictEqual(written[1].position.nextPageRects.length, 1, 'page 7 rides on page 6');
  });

  await test('two adjacent pages stay one annotation', async () => {
    const written = [];
    const pdf = new PDFAdapter({ _internalReader: { _annotationManager: { addAnnotation: a => written.push(a) } } }, () => {});
    pdf.views = [{ app: { pdfViewer: { getPageView: () => null } }, view: {} }];
    assert.strictEqual(await pdf.createPermanentHighlight([glyph(2, 1), glyph(3, 1)], '#ffd400', 'q'), true);
    assert.strictEqual(written.length, 1);
    assert.strictEqual(written[0].position.pageIndex, 2);
  });

  console.log(passed + ' passed');
})().catch(e => { console.error(e); process.exit(1); });
