'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const root = __dirname, src = path.join(root, 'src'), version = require('./src/manifest.json').version;

const modules = fs.readdirSync(path.join(src, 'lib')).filter(f => f.endsWith('.js')).sort();
const bundle = "(function(root){'use strict';\nconst factories={\n" +
  modules.map(f => JSON.stringify(f.slice(0, -3)) + ':function(module,exports,require){\n' +
    fs.readFileSync(path.join(src, 'lib', f), 'utf8') + '\n}').join(',\n') +
  "\n};\nconst cache={};\nfunction load(name){name=name.replace(/^\\.\\//,'').replace(/\\.js$/,'');" +
  "if(cache[name])return cache[name].exports;if(!factories[name])throw new Error('Missing module '+name);" +
  "const m=cache[name]={exports:{}};factories[name](m,m.exports,load);return m.exports;}\n" +
  "root.SyncTranslate=load('index');\n})(this);\n";

const read = name => fs.readFileSync(path.join(src, name));
const files = [
  ['manifest.json', read('manifest.json')],
  ['bootstrap.js', read('bootstrap.js')],
  ['prefs.js', read('prefs.js')],
  ['content/preferences.xhtml', read('content/preferences.xhtml')],
  ['content/preferences.js', read('content/preferences.js')],
  ['content/icons/icon.png', read('content/icons/icon.png')],
  ['content/icons/icon@2x.png', read('content/icons/icon@2x.png')],
  ['content/sync-translate.js', Buffer.from(bundle)]
];

function zip(entries) {
  const parts = [], central = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name), body = zlib.deflateRawSync(data, { level: 9 }), crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8); local.writeUInt16LE(0, 10); local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(20, 6);
    head.writeUInt16LE(0x0800, 8); head.writeUInt16LE(8, 10); head.writeUInt16LE(0, 12); head.writeUInt16LE(0x21, 14);
    head.writeUInt32LE(crc, 16); head.writeUInt32LE(body.length, 20); head.writeUInt32LE(data.length, 24);
    head.writeUInt16LE(nameBuf.length, 28); head.writeUInt32LE(offset, 42);
    parts.push(local, nameBuf, body); central.push(head, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }
  const dir = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}

const manifest = require('./src/manifest.json'), app = manifest.applications.zotero;
fs.writeFileSync(path.join(root, 'update.json'), JSON.stringify({ addons: { [app.id]: { updates: [{
  version,
  update_link: manifest.homepage_url + '/releases/download/v' + version + '/sync-translate-' + version + '.xpi',
  applications: { zotero: { strict_min_version: app.strict_min_version, strict_max_version: app.strict_max_version } }
}] } } }, null, 2) + '\n');
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist', 'sync-translate.js'), bundle);
const out = path.join(root, 'dist', 'sync-translate-' + version + '.xpi');
fs.writeFileSync(out, zip(files));
console.log(out, fs.statSync(out).size + ' bytes');
