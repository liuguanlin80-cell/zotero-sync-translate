(function () {
  'use strict';
  const PREFIX = 'extensions.zotero.SyncTranslate.';
  const KEYS = ['enabled', 'alignSource', 'alignEndpoint', 'alignModel', 'alignApiKey', 'reverse', 'reverseCtrl', 'capDaily'];
  const ZH = {
    'enabled-label': '启用', 'source-label': '词级对齐：', 'opt-auto': '当前翻译服务', 'opt-off': '关闭（仅整句）',
    'opt-custom': '自定义接口', 'endpoint-label': '接口：', 'model-label': '模型：', 'key-label': '密钥：',
    'reverse-label': '鼠标指向原文单词时，标出对应译文', 'ctrl-label': '仅在按住 Ctrl 时', 'cap-label': '每日 token 上限（0 为不限）：',
    'clear-align': '清空对齐缓存', 'clear-gloss': '清空词表'
  };
  function init() {
    const root = document.getElementById('sync-translate-preferences');
    if (!root || root.dataset.ready) return;
    root.dataset.ready = '1';
    const zh = /^zh/i.test(String(Zotero.locale || ''));
    const $ = id => document.getElementById('sync-translate-pref-' + id);
    const plugin = () => Zotero.SyncTranslateCompanion;
    if (zh) for (const [id, text] of Object.entries(ZH)) $(id).textContent = text;
    function refresh() {
      const source = $('alignSource').value;
      $('custom').style.display = source === 'custom' || source === 'jev' ? '' : 'none';
      $('hint').textContent = source === 'auto'
        ? (zh ? '划选时把该句发给 TFZ 当前的大模型服务；不是大模型则仅整句。' : 'Sends the selected sentence to the model TFZ translates with; sentence-level otherwise.')
        : source === 'jev' ? (zh ? '接口和模型可留空。' : 'Endpoint and model may be left empty.') : '';
      const used = plugin()?.usedToday() || 0;
      $('used').textContent = (zh ? '今日已用 ' : 'Used today: ') + used.toLocaleString();
    }
    for (const key of KEYS) {
      const el = $(key), value = Zotero.Prefs.get(PREFIX + key, true);
      if (el.type === 'checkbox') el.checked = Boolean(value); else el.value = String(value ?? '');
      el.addEventListener('change', () => {
        const next = el.type === 'checkbox' ? el.checked
          : el.type === 'number' ? Math.max(0, Math.round(Number(el.value) || 0)) : el.value.trim();
        Zotero.Prefs.set(PREFIX + key, next, true);
        refresh();
      });
    }
    const clear = (id, kind) => $(id).addEventListener('click', () => {
      plugin()?.clearCache(kind);
      $('message').textContent = zh ? '已清空' : 'Cleared';
    });
    clear('clear-align', 'align'); clear('clear-gloss', 'gloss');
    refresh();
  }
  if (document.getElementById('sync-translate-preferences')) init();
  else {
    const observer = new MutationObserver(() => {
      if (!document.getElementById('sync-translate-preferences')) return;
      observer.disconnect(); window.clearTimeout(timer); init();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    const timer = window.setTimeout(() => observer.disconnect(), 30000);
    window.addEventListener('unload', () => { observer.disconnect(); window.clearTimeout(timer); }, { once: true });
  }
})();
