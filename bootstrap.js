var ReadingNotes;
var chromeHandle;

function install() {}
function uninstall() {}

async function startup({ id, rootURI }) {
  await Zotero.initializationPromise;
  await Zotero.uiReadyPromise;
  Services.scriptloader.loadSubScript(rootURI + "docx.js", this, "UTF-8");
  Services.scriptloader.loadSubScript(rootURI + "reading-notes.js", this, "UTF-8");
  chromeHandle = Cc["@mozilla.org/addons/addon-manager-startup;1"]
    .getService(Ci.amIAddonManagerStartup).registerChrome(
      Services.io.newURI(rootURI + "manifest.json"), [["content", "reading-notes", rootURI]]);
  ReadingNotes.start(id, rootURI);
}

function onMainWindowLoad({ window }) {
  ReadingNotes?.addWindow(window);
}

function onMainWindowUnload({ window }) {
  ReadingNotes?.removeWindow(window);
}

function shutdown() {
  ReadingNotes?.stop();
  ReadingNotes = undefined;
  chromeHandle?.destruct();
  chromeHandle = undefined;
}
