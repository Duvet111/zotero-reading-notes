/* Original plugin code. Uses the Zotero 9.0.6 native note editor and annotation APIs. */
var ReadingNotes = {
  alive: false,
  windows: new Map(),
  nodes: new Set(),
  listeners: [],
  queues: new Map(),
  detached: new Map(),
  keyTargets: new Map(),
  styled: new Set(),

  start(id, rootURI) {
    this.rootURI = rootURI;
    this.alive = true;
    this.id = id;
    this.listen("renderToolbar", event => this.toolbar(event));
    this.listen("renderTextSelectionPopup", event => {
      if (event.reader.type !== "pdf" || !event.params.annotation?.text) return;
      const annotation = JSON.parse(JSON.stringify(event.params.annotation));
      event.append(this.button(event.doc, "摘录到随读笔记", () =>
        this.run(event.reader, () => this.excerpt(event.reader, annotation))));
    });
    this.listen("createAnnotationContextMenu", event => {
      if (event.reader.type !== "pdf" || !event.params.ids?.length) return;
      const ids = Array.from(event.params.ids);
      event.append({ label: "添加到随读笔记", onCommand: () =>
        this.run(event.reader, () => this.insertExisting(event.reader, ids)) });
    });
    for (const win of Zotero.getMainWindows()) this.addWindow(win);
    // The render event may already have fired when a plugin is installed mid-session.
    for (const reader of Zotero.Reader._readers || []) {
      const doc = reader._iframeWindow?.document;
      const target = doc?.querySelector(".toolbar .end");
      if (target) this.toolbar({ reader, doc, append: node => target.prepend(node) });
    }
  },

  listen(type, handler) {
    this.listeners.push([type, handler]);
    Zotero.Reader.registerEventListener(type, handler, this.id);
  },

  stop() {
    this.alive = false;
    if (this.settingsWindow && !this.settingsWindow.closed) this.settingsWindow.close();
    this.settingsWindow = null;
    // Zotero 9.0.6 unregisterEventListener filters other handlers too; use plugin cleanup.
    Zotero.Reader._unregisterEventListenerByPluginID(this.id);
    this.listeners = [];
    for (const [target, handler] of this.keyTargets) target.removeEventListener("keydown", handler, true);
    this.keyTargets.clear();
    for (const style of this.styled) style.remove();
    this.styled.clear();
    // Native note windows remain usable after the plugin is disabled.
    this.detached.clear();
    for (const win of Array.from(this.windows.keys())) this.removeWindow(win);
    for (const node of this.nodes) node.remove();
    this.nodes.clear();
  },

  addWindow(win) {
    if (this.windows.has(win)) return;
    const popup = win.document.getElementById("menu_ToolsPopup");
    if (!popup) return;
    const menu = win.document.createXULElement("menuitem");
    menu.setAttribute("label", "随读笔记：打开当前文献笔记");
    menu.addEventListener("command", () => {
      const reader = Zotero.Reader.getByTabID(win.Zotero_Tabs.selectedID);
      if (!reader) {
        Zotero.alert(win, "随读笔记", "请先在 Zotero 标签页中打开一篇 PDF 文献。");
        return;
      }
      this.run(reader, () => this.open(reader));
    });
    popup.append(menu);
    this.windows.set(win, menu);
    this.bindShortcut(win, () => Zotero.Reader.getByTabID(win.Zotero_Tabs.selectedID));
  },

  removeWindow(win) {
    this.windows.get(win)?.remove();
    this.windows.delete(win);
    const handler = this.keyTargets.get(win);
    if (handler) win.removeEventListener("keydown", handler, true);
    this.keyTargets.delete(win);
  },

  button(doc, label, action) {
    const button = doc.createElementNS("http://www.w3.org/1999/xhtml", "button");
    button.type = "button";
    button.textContent = label;
    button.title = label;
    button.setAttribute("aria-label", label);
    button.classList.add("toolbar-button");
    button.style.cssText = "-moz-window-dragging:no-drag;width:auto;font:inherit;color:inherit;background:transparent;border:1px solid #8886;border-radius:5px;padding:4px 8px;cursor:pointer;white-space:nowrap";
    const activate = async event => {
      event.preventDefault();
      event.stopPropagation();
      if (button.disabled) return;
      button.disabled = true;
      try { await action(); }
      finally { button.disabled = false; }
    };
    // The reader toolbar is a window drag region. Explicit no-drag is essential;
    // pointer timing alone cannot turn titlebar gestures into normal button clicks.
    button.addEventListener("pointerdown", event => {
      event.stopPropagation();
    }, true);
    button.addEventListener("mousedown", event => {
      event.preventDefault();
      event.stopPropagation();
    }, true);
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      activate(event);
    }, true);
    // Forget popup elements when they are detached, to avoid holding entire PDF windows.
    for (const node of this.nodes) if (!node.isConnected) this.nodes.delete(node);
    this.nodes.add(button);
    return button;
  },

  toolbar({ reader, doc, append }) {
    if (reader.type !== "pdf") return;
    if (doc.querySelector('[data-reading-notes="toolbar"]')) return;
    const group = doc.createElement("span");
    group.dataset.readingNotes = "toolbar";
    group.style.cssText = "-moz-window-dragging:no-drag;display:inline-flex;gap:2px;margin:0 3px";
    group.append(this.button(doc, "随读笔记", () => this.run(reader, () => this.open(reader))));
    group.append(this.button(doc, "切换窗口", () => this.run(reader, () => this.toggleWindow(reader))));
    group.append(this.button(doc, "导出 Word", () => this.run(reader, () => this.exportWord(reader))));
    group.append(this.button(doc, "设置", () => this.run(reader, () => this.showSettings(reader))));
    // Keep the reader toolbar compact on small laptop screens; full names remain in tooltips.
    const shortLabels = { "随读笔记": "笔记", "切换窗口": "切换", "导出 Word": "Word" };
    for (const button of group.children) {
      if (shortLabels[button.textContent]) button.textContent = shortLabels[button.textContent];
    }
    this.bindShortcut(doc.defaultView, () => reader);
    this.nodes.add(group);
    append(group);
  },

  async run(reader, operation) {
    // Serialize note creation and edits for the same PDF across repeated clicks/windows.
    const key = reader.itemID;
    const previous = this.queues.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      if (!this.alive) return;
      try { return await operation(); }
      catch (error) {
        Zotero.logError(error);
        if (this.alive) Zotero.alert(reader._window || Zotero.getMainWindow(),
          "随读笔记", error.message || String(error));
      }
    });
    this.queues.set(key, next);
    try { return await next; }
    finally { if (this.queues.get(key) === next) this.queues.delete(key); }
  },

  assertCurrent(reader) {
    if (!this.alive) throw new Error("插件已停用，请重新打开后再试。");
    const win = reader._window;
    if (!reader.tabID || !win?.ZoteroContextPane || !win.Zotero_Tabs) {
      throw new Error("第一版支持 Zotero 主窗口中的 PDF 标签页。请将文献在标签页中打开。");
    }
    if (win.Zotero_Tabs.selectedID !== reader.tabID) {
      throw new Error("当前文献已切换，请返回原来的文献再执行操作。");
    }
    return win;
  },

  async getNote(attachment) {
    const pref = `readingNotes.note.${attachment.libraryID}.${attachment.key}`;
    const marker = `随读笔记/${attachment.key}`;
    const noteKey = Zotero.Prefs.get(pref);
    let note = noteKey && Zotero.Items.getByLibraryAndKey(attachment.libraryID, noteKey);
    const valid = item => item?.isNote() && !item.deleted
      && item.libraryID === attachment.libraryID
      && (item.parentID || false) === (attachment.parentID || false);
    if (!valid(note)) {
      const search = new Zotero.Search();
      search.libraryID = attachment.libraryID;
      search.addCondition("itemType", "is", "note");
      search.addCondition("tag", "is", marker);
      const items = await Zotero.Items.getAsync(await search.search());
      note = items.find(valid);
    }
    if (!note) {
      note = new Zotero.Item("note");
      note.libraryID = attachment.libraryID;
      if (attachment.parentID) note.parentID = attachment.parentID;
      note.setNote('<div data-schema-version="9"><p></p></div>');
      note.addTag(marker);
      await note.saveTx();
    }
    Zotero.Prefs.set(pref, note.key);
    return note;
  },

  async open(reader, forceSide = false) {
    const win = this.assertCurrent(reader);
    const attachment = Zotero.Items.get(reader.itemID);
    if (!attachment || attachment.deleted || attachment.parentItem?.deleted) {
      throw new Error("文献已删除，无法创建笔记。");
    }
    if (!attachment.isEditable()) throw new Error("当前文献所在文库没有编辑权限。");
    const floating = this.detached.get(attachment.id);
    if (!forceSide && floating && !floating.win.closed) {
      await this.prepareEditor(floating.editor, reader);
      floating.win.focus();
      await floating.editor.focus();
      return { instance: floating.instance, note: floating.editor.item, attachment };
    }
    if (floating?.win.closed) this.detached.delete(attachment.id);
    const pane = win.ZoteroContextPane;
    if (typeof pane.context?._setupNotesContext !== "function") {
      throw new Error("未找到兼容的笔记面板接口，请确认 Zotero 版本为 9.0.6。");
    }
    const note = await this.getNote(attachment);
    this.assertCurrent(reader);
    pane.collapsed = false;
    pane.context.mode = "notes";
    await pane.context._setupNotesContext(reader.tabID);
    this.assertCurrent(reader);
    const context = pane.context._getCurrentNotesContext();
    if (typeof context?._setPinnedNote !== "function") throw new Error("无法打开文献笔记面板。");
    if (pane.activeEditor?.item?.id !== note.id) {
      pane.activeEditor?.saveSync();
      // Remove the prior editor for this tab only after saving it.
      for (const box of Array.from(context.tabNotesDeck.children)) {
        if (box.getAttribute("data-tab-id") === reader.tabID) box.remove();
      }
      context._setPinnedNote(note);
    }
    const editor = pane.activeEditor;
    if (!editor) throw new Error("笔记编辑器未能打开。");
    await this.waitForEditor(editor, win);
    this.assertCurrent(reader);
    pane.updateAddToNote();
    const instance = editor.getCurrentInstance();
    await this.prepareEditor(editor, reader);
    win.focus();
    await editor.focus();
    return { instance, note, attachment };
  },

  async waitForEditor(editor, win) {
    let timer;
    try {
      await Promise.race([
        editor._initPromise,
        new Promise((_, reject) => { timer = win.setTimeout(() =>
          reject(new Error("笔记编辑器加载超时，请关闭此文献后重新打开。")), 12000); })
      ]);
    }
    finally { win.clearTimeout(timer); }
  },

  async excerpt(reader, selection) {
    if (!selection.text || !selection.position || !selection.sortIndex) {
      throw new Error("没有取得文字的位置，请重新选择 PDF 中的文字。");
    }
    const { instance, attachment } = await this.open(reader);
    this.assertCurrent(reader);
    // A note-only excerpt: position is sufficient for native Show on Page navigation.
    // Do not save an annotation item or modify the PDF reader's annotation collection.
    const json = {
      ...selection, type: "highlight", color: selection.color || "#ffd400",
      comment: selection.comment || "", pageLabel: selection.pageLabel || "", tags: []
    };
    delete json.id;
    delete json.key;
    json.attachmentItemID = attachment.id;
    await this.insertStyled(instance, [json]);
  },

  async insertExisting(reader, ids) {
    const attachment = Zotero.Items.get(reader.itemID);
    const annotations = [];
    for (const key of ids) {
      const item = Zotero.Items.getByLibraryAndKey(attachment.libraryID, key);
      if (!item || item.deleted || !item.isAnnotation() || item.parentID !== attachment.id) {
        throw new Error("批注尚未保存或来源不属于当前 PDF，请稍后重试。");
      }
      const json = await Zotero.Annotations.toJSON(item);
      if (["image", "ink"].includes(json.type) && !json.image) {
        throw new Error("图片批注还在生成，请稍等片刻，再右键添加到随读笔记。");
      }
      json.id = item.key;
      json.attachmentItemID = attachment.id;
      annotations.push(json);
    }
    const { instance, note } = await this.open(reader);
    if (annotations.some(x => x.image) && !Zotero.Libraries.get(note.libraryID).filesEditable) {
      throw new Error("当前群组文库不允许保存图片附件。");
    }
    this.assertCurrent(reader);
    await this.insertStyled(instance, annotations);
  },

  bindShortcut(target, getReader) {
    if (!target || this.keyTargets.has(target)) return;
    const handler = event => {
      if (event.defaultPrevented || event.repeat || event.isComposing) return;
      if (!(event.ctrlKey || event.metaKey) || !event.altKey || event.shiftKey || event.code !== "KeyN") return;
      const reader = getReader();
      if (!reader || reader.type !== "pdf") return;
      event.preventDefault();
      event.stopPropagation();
      this.run(reader, () => this.toggleWindow(reader));
    };
    target.addEventListener("keydown", handler, true);
    this.keyTargets.set(target, handler);
    target.addEventListener("unload", () => {
      target.removeEventListener("keydown", handler, true);
      this.keyTargets.delete(target);
    }, { once: true });
  },

  async prepareEditor(editor, reader) {
    await this.waitForEditor(editor, editor.ownerGlobal);
    const instance = editor.getCurrentInstance();
    await instance._initPromise;
    const doc = instance._iframeWindow.document;
    let style = doc.getElementById("reading-notes-style");
    if (!style) {
      style = doc.createElement("style");
      style.id = "reading-notes-style";
      doc.head.append(style);
      this.styled.add(style);
      instance._iframeWindow.addEventListener("unload", () => this.styled.delete(style), { once: true });
    }
    style.textContent = this.editorCSS();
    this.bindShortcut(instance._iframeWindow, () => reader);
  },

  getSettings() {
    const defaults = { ownFont: "Microsoft YaHei", excerptFont: "SimSun", fontSize: 14,
      lineHeight: 1.3, paragraphBefore: 0, paragraphAfter: 2, italic: true, bold: false };
    let saved = {};
    try { saved = JSON.parse(Zotero.Prefs.get("readingNotes.appearance") || "{}"); }
    catch (_) {}
    const result = { ...defaults };
    const fonts = ["Microsoft YaHei", "SimSun", "KaiTi", "Arial", "Times New Roman"];
    for (const key of ["ownFont", "excerptFont"]) if (fonts.includes(saved[key])) result[key] = saved[key];
    for (const [key, min, max] of [["fontSize", 10, 28], ["lineHeight", 1, 2.5],
      ["paragraphBefore", 0, 24], ["paragraphAfter", 0, 24]]) {
      if (typeof saved[key] === "number" && Number.isFinite(saved[key])) result[key] = Math.max(min, Math.min(max, saved[key]));
    }
    for (const key of ["italic", "bold"]) if (typeof saved[key] === "boolean") result[key] = saved[key];
    return result;
  },

  editorCSS() {
    const settings = this.getSettings();
    return `
        .ProseMirror .citation { display:none !important; }
        .ProseMirror {
          font-family:"${settings.ownFont}",sans-serif !important;
          font-size:${settings.fontSize}px !important;
          line-height:${settings.lineHeight} !important;
        }
        .ProseMirror p, .ProseMirror li {
          line-height:${settings.lineHeight} !important;
          margin-top:${settings.paragraphBefore}px !important;
          margin-bottom:${settings.paragraphAfter}px !important;
        }
        .ProseMirror blockquote {
          background:transparent !important; border:0 !important;
          margin:0 !important; padding:0 !important;
        }
        .ProseMirror .highlight,
        .ProseMirror .underline,
        .ProseMirror span[data-annotation] {
          font-family:"${settings.excerptFont}",serif !important;
          font-style:${settings.italic ? "italic" : "normal"} !important;
          font-weight:${settings.bold ? "bold" : "normal"} !important;
          background:transparent !important;
        }
      `;
  },

  async insertStyled(instance, annotations) {
    // Local serialization only: do not change Zotero's global annotation templates.
    await instance._ensureNoteCreated();
    await instance.importImages(annotations);
    const parser = new DOMParser();
    let html = "";
    for (const annotation of annotations) {
      const serialized = Zotero.EditorInstanceUtilities.serializeAnnotations([annotation]).html;
      const doc = parser.parseFromString('<!doctype html><html><head></head><body>' + serialized + '</body></html>', "text/html");
      for (const citation of doc.querySelectorAll(".citation[data-citation]")) citation.remove();
      for (const quote of Array.from(doc.querySelectorAll("blockquote"))) {
        quote.replaceWith(...Array.from(quote.childNodes));
      }
      // Keep data-annotation for navigation, with no quote wrapper or trailing paragraph.
      for (const original of doc.querySelectorAll("span[data-annotation]")) {
        original.style.fontFamily = '"Times New Roman", SimSun, serif';
      }
      html += doc.body.innerHTML;
    }
    this.insertAtCaret(instance, html);
  },

  insertAtCaret(instance, html) {
    const win = instance._iframeWindow;
    const core = win?.wrappedJSObject?._currentEditorInstance?._editorCore;
    if (!core?.view) throw new Error("无法取得 Zotero 笔记编辑器，请重启 Zotero 后重试。");
    // The null-position insertion path uses block-end arithmetic that leaves
    // its selection inside the excerpt when replacing an empty paragraph.
    // Use the native replaceSelection path, like pasting at the current caret.
    core.insertHTML(undefined, html);
    const view = core.view, state = view.state;
    let end = state.selection.to;
    const resolved = state.doc.resolve(end);
    for (let depth = resolved.depth; depth > 0; depth--) {
      const type = resolved.node(depth).type.name;
      if (type === "highlight" || type === "underline_annotation") {
        end = resolved.after(depth);
        break;
      }
    }
    // A real, unmarked text node outside the inline annotation gives Gecko's
    // IME a normal composition target. Merely moving a range to the boundary
    // of a nested inline textblock is insufficient. This is one ordinary space,
    // with no invisible sentinel and no extra paragraph.
    // Arrays passed into the content editor must belong to its compartment.
    // A privileged [] becomes an inaccessible object when editor plugins later
    // copy the typing marks (for example with .slice()).
    const emptyMarks = Components.utils.cloneInto([], win);
    const transaction = state.tr.setStoredMarks(emptyMarks).insertText(" ", end, end);
    const caret = state.selection.constructor.near(transaction.doc.resolve(end + 1), 1);
    view.dispatch(transaction.setSelection(caret).setStoredMarks(emptyMarks).scrollIntoView());
    win.focus();
    view.focus();
  },

  async flush(editor) {
    if (!editor) return;
    await this.waitForEditor(editor, editor.ownerGlobal);
    const instance = editor.getCurrentInstance();
    const data = instance._iframeWindow.wrappedJSObject.getDataSync(true);
    if (data) await instance._save(JSON.parse(JSON.stringify(data)));
  },

  async toggleWindow(reader) {
    const main = this.assertCurrent(reader);
    const fullScreen = main.fullScreen;
    const maximized = main.STATE_MAXIMIZED !== undefined && main.windowState === main.STATE_MAXIMIZED;
    try { return await this.switchWindow(reader); }
    finally {
      if (maximized && main.windowState !== main.STATE_MAXIMIZED) main.maximize();
      if (fullScreen && !main.fullScreen) main.fullScreen = true;
    }
  },

  async switchWindow(reader) {
    const main = this.assertCurrent(reader);
    const current = this.detached.get(reader.itemID);
    if (current && !current.win.closed) {
      await this.flush(current.editor);
      this.rememberGeometry(current.win);
      this.detached.delete(reader.itemID);
      current.win.close();
      main.focus();
      await this.open(reader, true);
      return;
    }
    const { note } = await this.open(reader, true);
    const pane = main.ZoteroContextPane;
    await this.flush(pane.activeEditor);
    const context = pane.context._getCurrentNotesContext();
    for (const box of Array.from(context.tabNotesDeck.children)) {
      if (box.getAttribute("data-tab-id") === reader.tabID) box.remove();
    }
    context.mode = "notesList";
    pane.collapsed = true;
    const instance = await Zotero.Notes.open(note.id, undefined, { openInWindow: true });
    const win = main.ZoteroPane.findNoteWindow(note.id);
    if (!win || win === main || win.document.documentElement.getAttribute("windowtype") !== "zotero:note") {
      throw new Error("独立笔记窗口未能正确识别，已停止调整窗口。");
    }
    const editor = win.document.getElementById("zotero-note-editor");
    const record = { win, editor, instance };
    this.detached.set(reader.itemID, record);
    win.addEventListener("unload", () => {
      if (this.detached.get(reader.itemID) === record) this.detached.delete(reader.itemID);
    }, { once: true });
    const geometry = Zotero.Prefs.get("readingNotes.windowGeometry");
    if (geometry) {
      try {
        const size = JSON.parse(geometry);
        win.resizeTo(Math.max(380, Math.min(size.width, win.screen.availWidth)),
          Math.max(300, Math.min(size.height, win.screen.availHeight)));
        // Clamp to the current monitor so a disconnected external screen cannot hide it.
        const left = win.screen.availLeft || 0, top = win.screen.availTop || 0;
        win.moveTo(Math.max(left, Math.min(size.x, left + win.screen.availWidth - win.outerWidth)),
          Math.max(top, Math.min(size.y, top + win.screen.availHeight - win.outerHeight)));
      } catch (error) { Zotero.logError(error); }
    } else { win.resizeTo(520, Math.min(720, win.screen.availHeight)); }
    win.addEventListener("close", () => this.rememberGeometry(win));
    this.bindShortcut(win, () => reader);
    const bar = win.document.createElementNS("http://www.w3.org/1999/xhtml", "div");
    bar.style.cssText = "display:flex;gap:8px;padding:8px;align-items:center";
    bar.append(this.button(win.document, "返回右侧笔记", () => this.run(reader, () => this.toggleWindow(reader))),
      this.button(win.document, "导出 Word", () => this.run(reader, () => this.exportWord(reader))),
      this.button(win.document, "设置", () => this.run(reader, () => this.showSettings(reader))));
    editor.before(bar);
    this.nodes.add(bar);
    await this.prepareEditor(editor, reader);
    win.focus();
    await editor.focus();
  },

  rememberGeometry(win) {
    if (win.closed) return;
    Zotero.Prefs.set("readingNotes.windowGeometry", JSON.stringify({
      width: win.outerWidth, height: win.outerHeight, x: win.screenX, y: win.screenY
    }));
  },

  async capture(reader) {
    this.assertCurrent(reader);
    await this.open(reader);
    this.assertCurrent(reader);
    reader._window.focus();
    await reader.focus();
    const nativeButton = reader._iframeWindow.document.querySelector("button.area");
    if (!nativeButton) throw new Error("没有找到 Zotero 选择区域工具，请确认已打开 PDF。");
    if (!nativeButton.classList.contains("active")) nativeButton.click();
    // Use the native toolbar action, avoiding parameters passed across privileged compartments.
  },

  async exportWord(reader) {
    const { note, instance } = await this.open(reader);
    const floating = this.detached.get(reader.itemID);
    const owner = floating && !floating.win.closed ? floating.win : reader._window;
    const data = instance._iframeWindow.wrappedJSObject.getDataSync(true);
    if (data) await instance._save(JSON.parse(JSON.stringify(data)));
    const { FilePicker } = ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs");
    const picker = new FilePicker();
    picker.init(owner, "导出随读笔记为 Word", picker.modeSave);
    picker.appendFilter("Word 文档 (.docx)", "*.docx");
    picker.defaultExtension = "docx";
    const attachment = Zotero.Items.get(reader.itemID);
    const title = attachment.parentItem?.getDisplayTitle() || attachment.getDisplayTitle() || "阅读笔记";
    picker.defaultString = title.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 90) + "-笔记.docx";
    const result = await picker.show();
    if (result !== picker.returnOK && result !== picker.returnReplace) return;
    let path = picker.file;
    if (!path.toLowerCase().endsWith(".docx")) path += ".docx";
    // Read a fresh snapshot after the save dialog, including text typed while it was open.
    const snapshot = instance._iframeWindow.wrappedJSObject.getDataSync(true);
    if (snapshot) await instance._save(JSON.parse(JSON.stringify(snapshot)));
    const html = snapshot?.html || note.getNote();
    const bytes = await ReadingNotesDocx.fromHTML(html, async key => {
      const image = Zotero.Items.getByLibraryAndKey(note.libraryID, key);
      if (!image?.isAttachment() || image.parentID !== note.id) throw new Error("笔记图片来源无效，无法导出。");
      const imagePath = await image.getFilePathAsync();
      if (!imagePath || !(await IOUtils.exists(imagePath))) throw new Error("笔记图片未下载，请完成 Zotero 文件同步后重试。");
      return await IOUtils.read(imagePath);
    }, this.getSettings());
    await IOUtils.write(path, bytes, { tmpPath: path + ".reading-notes.tmp" });
    Zotero.alert(owner, "随读笔记", "Word 文档已导出：\n" + path);
  },

  async showSettings(reader) {
    if (this.settingsWindow && !this.settingsWindow.closed) {
      this.settingsWindow.focus();
      return;
    }
    const main = this.assertCurrent(reader);
    const floating = this.detached.get(reader.itemID);
    const owner = floating && !floating.win.closed ? floating.win : main;
    const settings = this.getSettings();
    const win = owner.openDialog("chrome://reading-notes/content/settings.xhtml",
      "reading-notes-settings", "chrome,dialog=no,resizable,centerscreen,width=460,height=720");
    this.settingsWindow = win;
    await new Promise(resolve => {
      if (win.document.getElementById("save")) resolve();
      else {
        const loaded = () => {
          if (!win.document.getElementById("save")) return;
          win.removeEventListener("load", loaded);
          resolve();
        };
        win.addEventListener("load", loaded);
      }
    });
    this.initializeSettings(win, settings);
  },

  initializeSettings(win, settings) {
    const doc = win.document;
    const keys = Object.keys(settings);
    const fonts = [["Microsoft YaHei", "微软雅黑"], ["SimSun", "宋体"], ["KaiTi", "楷体"], ["Arial", "Arial"], ["Times New Roman", "Times New Roman"]];
    const setFont = (key, value) => {
      const field = doc.getElementById(key);
      field.dataset.value = value;
      field.textContent = (fonts.find(font => font[0] === value)?.[1] || value) + " ▾";
    };
    for (const key of ["ownFont", "excerptFont"]) {
      const field = doc.getElementById(key), list = doc.getElementById(key + "Options");
      for (const [value, label] of fonts) {
        const option = doc.createElementNS("http://www.w3.org/1999/xhtml", "button");
        option.type = "button"; option.textContent = label;
        option.setAttribute("role", "option");
        option.addEventListener("click", () => {
          setFont(key, value); list.hidden = true;
          field.setAttribute("aria-expanded", "false"); preview(); field.focus();
        });
        list.append(option);
      }
      field.addEventListener("click", () => {
        const opening = list.hidden;
        for (const other of doc.querySelectorAll(".font-options")) other.hidden = true;
        list.hidden = !opening; field.setAttribute("aria-expanded", String(opening));
      });
    }
    doc.addEventListener("keydown", event => {
      if (event.key === "Escape") for (const list of doc.querySelectorAll(".font-options")) list.hidden = true;
    });
    const fill = values => { for (const key of keys) {
      const field = doc.getElementById(key);
      if (key === "ownFont" || key === "excerptFont") setFont(key, values[key]);
      else if (field.type === "checkbox") field.checked = values[key]; else field.value = values[key];
    } };
    const read = () => Object.fromEntries(keys.map(key => {
      const field = doc.getElementById(key);
      return [key, field.type === "checkbox" ? field.checked : field.dataset.numeric ? Number(field.value) : field.dataset.value || field.value];
    }));
    const preview = () => {
      const value = read(), box = doc.getElementById("preview"), quote = doc.getElementById("quotePreview");
      box.style.fontFamily = value.ownFont; box.style.fontSize = value.fontSize + "px"; box.style.lineHeight = value.lineHeight;
      for (const p of box.querySelectorAll("p")) { p.style.marginTop = value.paragraphBefore + "px"; p.style.marginBottom = value.paragraphAfter + "px"; }
      quote.style.fontFamily = value.excerptFont; quote.style.fontStyle = value.italic ? "italic" : "normal";
      quote.style.fontWeight = value.bold ? "bold" : "normal";
    };
    fill(settings); preview();
    for (const key of keys) doc.getElementById(key).addEventListener("input", preview);
    doc.getElementById("cancel").addEventListener("click", () => win.close());
    doc.getElementById("reset").addEventListener("click", () => {
      fill({ ownFont: "Microsoft YaHei", excerptFont: "SimSun", fontSize: 14, lineHeight: 1.3,
        paragraphBefore: 0, paragraphAfter: 2, italic: true, bold: false }); preview();
    });
    doc.getElementById("save").addEventListener("click", () => {
      for (const key of keys) {
        const field = doc.getElementById(key);
        if (!field.dataset.numeric) continue;
        const value = Number(field.value);
        if (!field.value.trim() || !Number.isFinite(value) || value < Number(field.dataset.min) || value > Number(field.dataset.max)) {
          doc.getElementById("error").textContent = "请按输入框旁的范围填写数字。";
          field.focus(); return;
        }
      }
      Zotero.Prefs.set("readingNotes.appearance", JSON.stringify(read()));
      const css = this.editorCSS();
      for (const style of this.styled) if (style.isConnected) style.textContent = css;
      win.close();
    });
  }
};
