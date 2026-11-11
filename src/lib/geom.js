'use strict';
const { canonical } = require('./util');
function tokensAtRange(tokens, start, end) {
  return tokens.filter(t => t.start < end && t.end > start).map(t => t.id);
}
function spansFromIDs(tokens, ids) {
  const sorted = [...new Set(ids)].filter(i => tokens[i]).sort((a, b) => a - b);
  const spans = [];
  for (const i of sorted) {
    const t = tokens[i]; const last = spans.at(-1);
    if (last && i === last.last + 1) { last.end = t.end; last.last = i; }
    else spans.push({ start: t.start, end: t.end, last: i });
  }
  return spans.map(({ start, end }) => ({ start, end }));
}
function validRect(r) { return Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[2] >= r[0] && r[3] >= r[1]; }
function pageGlyphs(pageIndex, chars, start = 0, end = chars?.length || 0, clipRects = null) {
  let text = ''; const map = [];
  for (let i = start; i < Math.min(end, chars.length); i++) {
    const ch = chars[i];
    if (!ch || ch.ignorable || typeof ch.c !== 'string' || !validRect(ch.rect)) continue;
    const rect = validRect(ch.inlineRect) ? ch.inlineRect : ch.rect;
    if (clipRects?.length) {
      const c = [(ch.rect[0] + ch.rect[2]) / 2, (ch.rect[1] + ch.rect[3]) / 2];
      if (!clipRects.some(r => c[0] >= r[0] - 0.1 && c[0] <= r[2] + 0.1 && c[1] >= r[1] - 0.1 && c[1] <= r[3] + 0.1)) continue;
    }
    const glyph = { pageIndex, charIndex: i, rect: [...rect], hitRect: [...ch.rect], rotation: ch.rotation || 0 };
    text += ch.c;
    for (let j = 0; j < ch.c.length; j++) map.push(glyph);
    if (ch.spaceAfter || ch.lineBreakAfter || ch.paragraphBreakAfter) { text += ' '; map.push(null); }
  }
  return { text, map };
}
function concatenateGeometry(parts) {
  let text = ''; const map = [];
  for (const part of parts) { if (text) { text += ' '; map.push(null); } text += part.text; map.push(...part.map); }
  return { text, map };
}

function mapGeometry(source, geometry) {
  const s = canonical(source), g = canonical(geometry.text);
  if (!s.value || !g.value) return null;
  const at = g.value.indexOf(s.value);
  if (at < 0 || g.value.indexOf(s.value, at + 1) !== -1) return null;
  const result = Array.from({ length: source.length }, () => []);
  for (let i = 0; i < s.value.length; i++) {
    const gs = g.map[at + i], ss = s.map[i];
    const glyphs = geometry.map.slice(gs.start, gs.end).filter(Boolean);
    for (let j = ss.start; j < ss.end; j++) result[j].push(...glyphs);
  }

  const assignGap = (s0,s1,g0,g1) => {
    if (s1<=s0 || g1<=g0) return;
    const sourceGap = source.slice(s0,s1);
    if (!sourceGap || !/[^\p{L}\p{N}\p{M}\s]/u.test(sourceGap)) return;
    const glyphs = geometry.map.slice(g0,g1).filter(Boolean);
    if (!glyphs.length) return;
    for(let j=s0;j<s1;j++) if(/[^\p{L}\p{N}\p{M}\s]/u.test(source[j]||'')) result[j].push(...glyphs);
  };
  for(let i=0;i+1<s.value.length;i++) {
    const a=s.map[i], b=s.map[i+1], ga=g.map[at+i], gb=g.map[at+i+1];
    assignGap(a.end,b.start,ga.end,gb.start);
  }
  const edgeShape = value => String(value||'').replace(/[\p{L}\p{N}\p{M}]/gu,'');
  const firstS=s.map[0], firstG=g.map[at];
  if(firstS?.start>0&&firstG){
    const g0=at>0?g.map[at-1].end:0,g1=firstG.start;
    const ss=source.slice(0,firstS.start),gg=geometry.text.slice(g0,g1);
    if(edgeShape(ss)&&edgeShape(gg).endsWith(edgeShape(ss))) assignGap(0,firstS.start,g1-edgeShape(ss).length,g1);
  }
  const lastSI=s.value.length-1,lastGI=at+lastSI,lastS=s.map[lastSI],lastG=g.map[lastGI];
  if(lastS&&lastS.end<source.length&&lastG){
    const g0=lastG.end,g1=(lastGI+1<g.map.length?g.map[lastGI+1].start:geometry.text.length);
    const ss=source.slice(lastS.end),gg=geometry.text.slice(g0,g1);
    if(edgeShape(ss)&&edgeShape(gg).startsWith(edgeShape(ss))) assignGap(lastS.end,source.length,g0,g0+edgeShape(ss).length);
  }
  return result;
}

function sourceGeometryFromCaptures(source, captures) {
  for (const capture of [...captures].reverse()) {
    const result = mapGeometry(source, capture.geometry);
    if (result) return { map: result, ratio: 1 };
  }
  const cs = canonical(source); const map = Array.from({ length: source.length }, () => []);
  let matched = 0; const occupied = new Set();
  for (const capture of [...captures].reverse()) {
    const cg = canonical(capture.text); if (!cg.value) continue;
    const at = cs.value.indexOf(cg.value);
    if (at < 0 || cs.value.indexOf(cg.value, at + 1) >= 0) continue;
    if (Array.from({ length: cg.value.length }, (_, i) => at + i).some(i => occupied.has(i))) continue;
    const local = mapGeometry(capture.text, capture.geometry); if (!local) continue;
    for (let i = 0; i < cg.value.length; i++) {
      const a = cs.map[at + i], b = cg.map[i];
      const glyphs = local.slice(b.start, b.end).flat();
      for (let j = a.start; j < a.end; j++) map[j].push(...glyphs);
      occupied.add(at + i); matched++;
    }
    const rawStart=cs.map[at]?.start, rawEnd=cs.map[at+cg.value.length-1]?.end;
    if(Number.isInteger(rawStart)&&Number.isInteger(rawEnd)){
      const capFirst=cg.map[0]?.start||0,capLast=cg.map[cg.value.length-1]?.end||capture.text.length;
      const span=capture.text.slice(capFirst,capLast);
      const base=source.slice(rawStart,rawEnd);
      if(base===span){for(let i=0;i<span.length;i++) if(local[capFirst+i]?.length) map[rawStart+i].push(...local[capFirst+i]);}
    }
  }
  return matched ? { map, ratio: matched / Math.max(1, cs.value.length) } : null;
}
function mergeGlyphRects(glyphs) {
  const rows = [];
  const ordered = [...(glyphs || [])].sort((a,b) =>
    (a._syncGroup||0)-(b._syncGroup||0) || a.pageIndex-b.pageIndex || (a.rotation||0)-(b.rotation||0) ||
    b.rect[3]-a.rect[3] || a.rect[0]-b.rect[0]);
  for (const g of ordered) {
    const explicitGroup=Number.isInteger(g._syncGroup);
    const group=explicitGroup?g._syncGroup:0;
    const gh = Math.max(1, Math.abs(g.rect[3]-g.rect[1]));
    const gw = Math.max(1, Math.abs(g.rect[2]-g.rect[0]));
    let row = rows.find(r => {
      if (r.group!==group || r.explicitGroup!==explicitGroup || r.pageIndex !== g.pageIndex || r.rotation !== g.rotation) return false;
      if (Math.abs(r.rect[1]-g.rect[1]) >= Math.max(0.9, gh*0.16) ||
          Math.abs(r.rect[3]-g.rect[3]) >= Math.max(0.9, gh*0.16)) return false;
      const rh = Math.max(1, Math.abs(r.rect[3]-r.rect[1]));
      const typical = Math.max(gw, r.lastWidth || gw);
      const indexGap = Number.isInteger(g.charIndex) && Number.isInteger(r.lastCharIndex)
        ? g.charIndex - r.lastCharIndex : null;
      const bridge = explicitGroup&&r.explicitGroup
        ? Math.max(4, Math.min(72, Math.max(typical*3.4, Math.min(gh,rh)*4.2)))
        : Math.max(3, Math.min(28, Math.max(typical*2.8, Math.min(gh,rh)*1.4)));
      return g.rect[0] <= r.rect[2] + bridge && g.rect[2] >= r.rect[0] - bridge;
    });
    if (row) {
      row.rect[0]=Math.min(row.rect[0],g.rect[0]); row.rect[1]=Math.min(row.rect[1],g.rect[1]);
      row.rect[2]=Math.max(row.rect[2],g.rect[2]); row.rect[3]=Math.max(row.rect[3],g.rect[3]); row.lastWidth=gw; row.lastCharIndex=g.charIndex;
    } else rows.push({group,explicitGroup,coarse:!!g._coarse,pageIndex:g.pageIndex,rect:[...g.rect],rotation:g.rotation,lastWidth:gw,lastCharIndex:g.charIndex});
  }
  return rows.map(({group,explicitGroup,lastWidth,lastCharIndex,...row})=>row);
}
module.exports = { tokensAtRange, spansFromIDs, validRect, pageGlyphs, concatenateGeometry, mapGeometry, sourceGeometryFromCaptures, mergeGlyphRects };
