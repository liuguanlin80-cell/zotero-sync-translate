'use strict';
var companion;
var generation = 0;
function install() {}
function uninstall() {}
async function startup({ id, version, rootURI }) {
  const mine = ++generation;
  await Zotero.initializationPromise;
  await Zotero.uiReadyPromise;
  if (mine !== generation) return;
  const scope = { Zotero, Services, Components, ChromeUtils, URL, setTimeout, clearTimeout };
  Services.scriptloader.loadSubScriptWithOptions(rootURI + 'content/sync-translate.js', { target: scope, ignoreCache: true });
  const env = {
    IOUtils: typeof IOUtils === 'undefined' ? null : IOUtils,
    PathUtils: typeof PathUtils === 'undefined' ? null : PathUtils,
    setTimeout, clearTimeout
  };
  companion = scope.SyncTranslate.start(Zotero, { id, version, rootURI }, env);
}
function onMainWindowLoad({ window }) { companion?.onMainWindowLoad(window); }
function onMainWindowUnload({ window }) { companion?.onMainWindowUnload(window); }
function shutdown() {
  generation++;
  companion?.shutdown();
  companion = null;
}
