'use strict';
const { safeGet, unwrap, canonical } = require('./util');
const { spansFromIDs, tokensAtRange } = require('./geom');
const { html, ANNOTATION_COLORS } = require('./pdf');
function visible(element) {
  if (!element?.isConnected || element.hidden) return false;
  const rect = element.getBoundingClientRect();
  const style = element.ownerDocument.defaultView.getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
}
function nativeControl(element, text) {
  const nodes = [element, ...safeGet(() => [...element.querySelectorAll('textarea,input')], []),
    ...safeGet(() => [...element.shadowRoot.querySelectorAll('textarea,input')], [])];
  return nodes.find(e => ['textarea','input'].includes(e?.localName) && e.value === text && visible(e));
}
function clipRect(r, b) {
  const left = Math.max(r.left, b.left), top = Math.max(r.top, b.top);
  const right = Math.min(r.right, b.right), bottom = Math.min(r.bottom, b.bottom);
  return right > left && bottom > top ? { left, top, right, bottom, width: right-left, height: bottom-top } : null;
}

class TextSurface {
  constructor(element, text, tokens) {
    this.element = element; this.doc = element.ownerDocument; this.win = this.doc.defaultView;
    this.text = text; this.tokens = tokens; this.control = null; this.root = null; this.mirror = null;
    this.rects = new Map(); this.ranges = []; this.stamp = ''; this.spans = [];
    this.glyphMap = null; this.disposed = false; this.sync(true);
  }
  matches() {
    if (!visible(this.element)) return false;
    const value = safeGet(() => unwrap(this.element).value, undefined);
    return typeof value !== 'string' || value === this.text;
  }
  overlay() {
    if (!this.root?.isConnected) {
      this.root?.remove();
      this.root = html(this.doc, 'div'); this.root.className = 'sync-translate-text-layer';
      this.root.setAttribute('aria-hidden', 'true');
      this.root.style.cssText = 'position:fixed;pointer-events:none;overflow:hidden;z-index:2147483000;contain:layout style;';
      (this.doc.body || this.doc.documentElement).appendChild(this.root);
      this.mirror = null;
    }
    return this.root;
  }
  sync(force = false) {
    if (this.disposed || !this.matches()) { this.clear(); return false; }
    const control = nativeControl(this.element, this.text);
    const el = control || this.element, b = el.getBoundingClientRect();
    const s = this.win.getComputedStyle(el);
    const stamp = JSON.stringify([b.x,b.y,b.width,b.height,el.scrollTop,el.scrollLeft,el.clientWidth,
      el.clientHeight,s.font,s.fontSize,s.fontFamily,s.lineHeight,s.letterSpacing,s.wordSpacing,
      s.paddingTop,s.paddingBottom,s.paddingLeft,s.paddingRight,s.direction,
      safeGet(() => el.textContent, ''), !!control]);
    if (!force && this.stamp === stamp) return true;
    this.stamp = stamp; this.rects.clear(); this.ranges = []; this.control = control;
    this.box = { left:b.left+(el.clientLeft||0), top:b.top+(el.clientTop||0),
      right:b.left+(el.clientLeft||0)+el.clientWidth, bottom:b.top+(el.clientTop||0)+el.clientHeight };
    if (!control) {
      this.box = { left:b.left, top:b.top, right:b.right, bottom:b.bottom };
    }
    for (let p = el.parentElement; p; p = p.parentElement) {
      const ps = this.win.getComputedStyle(p);
      if (/(auto|scroll|hidden|clip)/.test(ps.overflow + ps.overflowX + ps.overflowY)) {
        const pb = p.getBoundingClientRect();
        this.box = { left:Math.max(this.box.left,pb.left), top:Math.max(this.box.top,pb.top),
          right:Math.min(this.box.right,pb.right), bottom:Math.min(this.box.bottom,pb.bottom) };
      }
    }
    this.box.left = Math.max(0,this.box.left); this.box.top = Math.max(0,this.box.top);
    this.box.right = Math.min(this.win.innerWidth,this.box.right); this.box.bottom = Math.min(this.win.innerHeight,this.box.bottom);
    const root = this.overlay();
    root.replaceChildren(); this.mirror = null;
    root.style.left = this.box.left+'px'; root.style.top = this.box.top+'px';
    root.style.width = Math.max(0,this.box.right-this.box.left)+'px'; root.style.height = Math.max(0,this.box.bottom-this.box.top)+'px';
    if (control) {
      const mirror = html(this.doc, 'div'); this.mirror = mirror;
      mirror.style.cssText = 'position:absolute;box-sizing:border-box;pointer-events:none;color:transparent!important;background:transparent!important;border:0;margin:0;min-height:100%;';
      const properties = ['fontFamily','fontSize','fontWeight','fontStyle','fontVariant','fontStretch',
        'lineHeight','letterSpacing','wordSpacing','textTransform','textIndent','textAlign','direction',
        'tabSize','paddingTop','paddingBottom','paddingLeft','paddingRight','wordBreak'];
      for (const prop of properties) mirror.style[prop] = s[prop];
      mirror.style.whiteSpace = control.wrap === 'off' ? 'pre' : 'pre-wrap';
      mirror.style.overflowWrap = 'break-word';
      mirror.style.width = control.clientWidth+'px';
      mirror.style.left = (b.left + control.clientLeft - this.box.left - control.scrollLeft)+'px';
      mirror.style.top = (b.top + control.clientTop - this.box.top - control.scrollTop)+'px';
      this.textNode = this.doc.createTextNode(this.text + '\u200b'); mirror.appendChild(this.textNode); root.appendChild(mirror);
      this.glyphMap = null;
    } else this.buildDOMMap();
    if (this.spans.length) this.paint();
    return true;
  }
  buildDOMMap() {
    const root = this.element.shadowRoot || this.element;
    const walker = this.doc.createTreeWalker(root, 4);
    const pieces = [], nodes = [];
    let text = '', node;
    while ((node = walker.nextNode())) {
      const parent = node.parentElement;
      if (!parent || parent.closest('script,style,button,.sync-translate-text-layer,.katex-mathml')) continue;
      if (!node.textContent) continue;
      nodes.push({ node, start:text.length, end:text.length+node.textContent.length });
      pieces.push(node.textContent); text += node.textContent;
    }
    const target = canonical(this.text), rendered = canonical(text);
    const map = Array(this.text.length).fill(null);
    const place = (from, to, position) => {
      const begin = nodes.find(n => position.start >= n.start && position.start < n.end);
      const end = nodes.find(n => position.end > n.start && position.end <= n.end);
      if (!begin || !end) return;
      for (let j=from;j<to;j++) map[j] = { node:begin.node, offset:position.start-begin.start,
        endNode:end.node, endOffset:position.end-end.start };
    };
    const at = rendered.value.indexOf(target.value);
    if (target.value && at >= 0 && rendered.value.indexOf(target.value,at+1) < 0) {
      for (let i=0;i<target.value.length;i++) place(target.map[i].start,target.map[i].end,rendered.map[at+i]);
    } else {
      for (const n of nodes) {
        const s = n.node.textContent;
        const offset = this.text.indexOf(s);
        if (!s.trim() || offset < 0 || this.text.indexOf(s,offset+1) >= 0) continue;
        for (let i=0;i<s.length;i++) map[offset+i] = { node:n.node, offset:i, endNode:n.node, endOffset:i+1 };
      }
    }
    this.glyphMap = map;
  }
  getSpanRects(start,end) {
    if (start >= end || !this.root) return [];
    const range = this.doc.createRange();
    if (this.mirror) { range.setStart(this.textNode,start); range.setEnd(this.textNode,Math.min(end,this.text.length)); }
    else {
      let a = start, b = end-1;
      while(a<end && !this.glyphMap?.[a]) a++;
      while(b>=a && !this.glyphMap?.[b]) b--;
      if (a>b) return [];
      for(let i=a;i<=b;i++) if(!this.glyphMap[i] && /[\p{L}\p{N}]/u.test(this.text[i])) return [];
      const s=this.glyphMap[a], e=this.glyphMap[b];
      try { range.setStart(s.node,s.offset); range.setEnd(e.endNode,e.endOffset); } catch (_) { return []; }
    }
    return [...range.getClientRects()].map(r=>clipRect(r,this.box)).filter(Boolean);
  }
  tokenRects(id) {
    if (!this.rects.has(id)) {
      const t=this.tokens[id]; this.rects.set(id,t?this.getSpanRects(t.start,t.end):[]);
    }
    return this.rects.get(id);
  }
  hit(x,y) {
    if (!this.sync() || !this.box || x<this.box.left || x>this.box.right || y<this.box.top || y>this.box.bottom) return null;
    for(const t of this.tokens) for(const r of this.tokenRects(t.id)) {
      if(x>=r.left && x<=r.right && y>=r.top && y<=r.bottom) return t.id;
    }
    return null;
  }
  containsNode(node) {
    if (!node) return false;
    if (node===this.control || node===this.element) return true;
    return safeGet(()=>this.element.contains(node),false) || safeGet(()=>this.element.shadowRoot?.contains(node),false);
  }
  selection() {
    if (this.disposed) return null;
    let control=this.control;
    if (!control?.isConnected || control.value !== this.text) {
      if (!this.sync()) return null;
      control=this.control;
    }
    if (!control || !Number.isInteger(control.selectionStart) || !Number.isInteger(control.selectionEnd)) return null;
    const start=Math.max(0,Math.min(control.selectionStart,control.selectionEnd));
    const end=Math.min(this.text.length,Math.max(control.selectionStart,control.selectionEnd));
    return { start,end,ids: start<end ? tokensAtRange(this.tokens,start,end) : [] };
  }
  highlight(ids) { this.spans=spansFromIDs(this.tokens,ids); this.sync(); this.paint(); }
  highlightRanges(ranges) { this.spans=ranges.filter(r=>r[1]>r[0]).map(r=>({start:r[0],end:r[1],coarse:!!r[2]})); this.sync(); this.paint(); }
  paint() {
    if(!this.root) return;
    this.root.querySelectorAll('.sync-translate-text-highlight').forEach(e=>e.remove());
    for(const span of this.spans) for(const r of this.getSpanRects(span.start,span.end)) {
      const mark=html(this.doc,'div'); mark.className='sync-translate-text-highlight';
      mark.style.cssText=`position:absolute;left:${r.left-this.box.left}px;top:${r.top-this.box.top}px;`+
        `width:${r.width}px;height:${r.height}px;border-radius:2px;pointer-events:none;`+
        (span.coarse?'background:rgba(255,181,35,.14);':'background:rgba(255,181,35,.34);box-shadow:inset 0 0 0 1.5px rgba(196,112,0,.95);');
      this.root.appendChild(mark);
    }
  }
  clear() { this.spans=[]; this.root?.querySelectorAll('.sync-translate-text-highlight').forEach(e=>e.remove()); }
  dispose() { this.disposed=true; this.root?.remove(); this.root=null; this.mirror=null; this.glyphMap=null; this.rects.clear(); }
}

class HighlightPalette {
  constructor(surface) {
    this.surface=surface;this.doc=surface.doc;this.win=surface.win;this.node=null;
    this.action=null;this.busy=false;this.selection=null;this.trackFrame=0;this.lastBoxKey='';
  }
  ensure() {
    if(this.node?.isConnected)return this.node;
    const node=html(this.doc,'div');this.node=node;node.className='sync-translate-highlight-palette';
    node.setAttribute('role','toolbar');
    node.style.cssText='position:fixed;z-index:2147483200;display:none;flex-direction:column;gap:3px;padding:3px;'+
      'border-radius:7px;background:color-mix(in srgb, Canvas 84%, transparent);'+
      'border:1px solid color-mix(in srgb, CanvasText 20%, transparent);box-shadow:0 1px 5px #0003;';
    const hold=e=>{e.preventDefault();e.stopPropagation();e.stopImmediatePropagation?.();};
    node.addEventListener('pointerdown',hold,true);node.addEventListener('mousedown',hold,true);
    node.addEventListener('contextmenu',hold,true);
    for(const [name,color] of ANNOTATION_COLORS){
      const button=html(this.doc,'button');button.type='button';button.dataset.color=color;button.title=name;
      button.style.cssText=`width:16px;height:16px;min-width:16px;min-height:16px;padding:0;border-radius:4px;border:1px solid #0004;background:${color};cursor:pointer;`;
      button.addEventListener('click',async e=>{
        e.preventDefault();e.stopPropagation();e.stopImmediatePropagation?.();
        if(this.busy||!this.action)return;
        const action=this.action;this.busy=true;
        for(const b of node.querySelectorAll('button'))b.disabled=true;
        try{const ok=await action(color);if(ok)this.hide();}
        finally{this.busy=false;for(const b of node.querySelectorAll('button'))b.disabled=false;}
      },true);
      node.appendChild(button);
    }
    (this.doc.body||this.doc.documentElement).appendChild(node);return node;
  }
  show(selection,onPick) {
    this.selection=selection||this.surface.selection();this.action=typeof onPick==='function'?onPick:null;
    if(!this.selection?.ids?.length||!this.action){this.hide();return false;}
    const node=this.ensure();node.style.display='flex';this.position();this.startTracking();return true;
  }
  startTracking(){
    if(this.trackFrame||!this.action)return;
    const tick=()=>{
      this.trackFrame=0;
      if(!this.action||!this.node?.isConnected||this.node.style.display==='none')return;
      this.position();
      this.trackFrame=this.win.requestAnimationFrame(tick);
    };
    this.trackFrame=this.win.requestAnimationFrame(tick);
  }
  stopTracking(){if(this.trackFrame){this.win.cancelAnimationFrame(this.trackFrame);this.trackFrame=0;}}
  position() {
    if(!this.node?.isConnected||!this.action)return false;
    const el=this.surface.control?.isConnected?this.surface.control:this.surface.element;
    if(!el?.isConnected){this.hide();return false;}
    const b=el.getBoundingClientRect();
    if(!Number.isFinite(b.left)||!Number.isFinite(b.top)||b.width<=0||b.height<=0)return false;
    const h=8*16+7*3+6,w=24,gap=6,y=(b.top+b.bottom)/2;
    const rightRoom=this.win.innerWidth-b.right,leftRoom=b.left;
    let left=rightRoom>=w+gap?b.right+gap:b.left-w-gap;
    if(left<4&&rightRoom>leftRoom)left=Math.min(this.win.innerWidth-w-4,b.right+gap);
    left=Math.max(4,Math.min(this.win.innerWidth-w-4,left));
    const top=Math.max(4,Math.min(this.win.innerHeight-h-4,y-h/2));
    const key=[Math.round(left*2)/2,Math.round(top*2)/2].join(':');
    if(key!==this.lastBoxKey){this.lastBoxKey=key;this.node.style.left=left+'px';this.node.style.top=top+'px';}
    return true;
  }
  contains(node){return !!node&&!!this.node?.isConnected&&(node===this.node||this.node.contains(node));}
  hide(){this.action=null;this.selection=null;this.lastBoxKey='';this.stopTracking();if(this.node)this.node.style.display='none';}
  dispose(){this.stopTracking();this.node?.remove();this.node=null;this.action=null;this.selection=null;}
}

class AlignmentIndicator {
  constructor(surface) { this.surface=surface; this.doc=surface.doc; this.win=surface.win; this.node=null; this.text=''; this.title=''; }
  ensure() {
    if(this.node?.isConnected)return this.node;
    this.node=html(this.doc,'span');this.node.className='sync-translate-alignment-indicator';
    this.node.setAttribute('role','status');this.node.setAttribute('aria-live','polite');this.node.setAttribute('aria-atomic','true');
    this.node.style.cssText='position:fixed;z-index:2147483050;pointer-events:none;padding:1px 4px;border-radius:4px;'+
      'font:10px/1.35 system-ui,sans-serif;letter-spacing:.01em;opacity:.78;'+
      'background:color-mix(in srgb, Canvas 78%, transparent);color:CanvasText;'+
      'border:1px solid color-mix(in srgb, CanvasText 18%, transparent);backdrop-filter:blur(2px);';
    (this.doc.body||this.doc.documentElement).appendChild(this.node);return this.node;
  }
  set(text,title='') {
    this.text=String(text||'');this.title=String(title||'');
    if(!this.text){this.hide();return;}
    const node=this.ensure();node.textContent=this.text;node.title=this.title;node.style.display='';this.position();
  }
  position() {
    if(!this.node?.isConnected||!this.text)return;
    const el=this.surface.control?.isConnected?this.surface.control:this.surface.element;
    if(!el?.isConnected){this.hide();return;}
    const b=el.getBoundingClientRect();
    const top=Math.max(2,Math.min(this.win.innerHeight-18,b.top+3));
    const right=Math.max(2,Math.min(this.win.innerWidth-24,this.win.innerWidth-b.right+4));
    this.node.style.top=top+'px';this.node.style.right=right+'px';
  }
  hide(){if(this.node)this.node.style.display='none';}
  dispose(){this.node?.remove();this.node=null;}
}
module.exports = { visible, TextSurface, HighlightPalette, AlignmentIndicator };
