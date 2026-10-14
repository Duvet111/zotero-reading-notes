const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const source = fs.readFileSync('work/plugin/reading-notes.js', 'utf8');

function setup() {
  const records = new Map();
  const prefs = new Map();
  const alerts = [];
  let saved = 0;
  class Item {
    constructor(type) { this.type = type; this.parentID = false; this.deleted = false; this.tags = []; }
    isNote() { return this.type === 'note'; }
    isAnnotation() { return this.type === 'annotation'; }
    setNote(html) { this.html = html; }
    addTag(tag) { this.tags.push(tag); }
    async saveTx() {
      await new Promise(resolve => setImmediate(resolve));
      this.id = ++saved;
      this.key = 'NOTE' + this.id;
      records.set(this.key, this);
    }
  }
  const Zotero = {
    Item, Prefs: { get: k => prefs.get(k), set: (k, v) => prefs.set(k, v) },
    Items: {
      getByLibraryAndKey: (libraryID, key) => {
        const item = records.get(key);
        return item?.libraryID === libraryID ? item : false;
      },
      getAsync: async ids => ids.map(k => records.get(k)),
      get: () => attachment
    },
    Search: class {
      addCondition(field, op, value) { if (field === 'tag') this.tag = value; }
      async search() { return [...records.values()].filter(x => x.tags.includes(this.tag)).map(x => x.key); }
    },
    Annotations: { toJSON: async item => ({ ...item.json }) },
    Libraries: { get: () => ({ filesEditable: true }) },
    logError() {}, alert: (win, title, message) => alerts.push(message)
  };
  const attachment = { id: 100, key: 'PDF12345', libraryID: 1, parentID: 90, isEditable: () => true };
  const win = { Zotero_Tabs: { selectedID: 'tab-1' }, ZoteroContextPane: {}, setTimeout, clearTimeout };
  const reader = { itemID: attachment.id, tabID: 'tab-1', _window: win };
  const context = vm.createContext({ Zotero, console, setTimeout, clearTimeout });
  vm.runInContext(source, context);
  context.ReadingNotes.alive = true;
  // Existing behavior tests isolate insertion from the native DOM serializer.
  context.ReadingNotes.insertStyled = (instance, annotations) => instance.insertAnnotations(annotations);
  return { app: context.ReadingNotes, records, prefs, alerts, attachment, reader, win, Zotero, count: () => saved };
}

test('repeated concurrent clicks create one note per PDF', async () => {
  const s = setup();
  const notes = await Promise.all(Array.from({ length: 8 }, () =>
    s.app.run(s.reader, () => s.app.getNote(s.attachment))));
  assert.equal(s.count(), 1);
  assert.ok(notes.every(n => n === notes[0]));
  assert.equal(notes[0].parentID, 90);
  assert.ok(!notes[0].html.includes('研究问题'));
});

test('sync marker recovers note if local mapping is lost', async () => {
  const s = setup();
  const first = await s.app.getNote(s.attachment);
  s.prefs.clear();
  assert.equal(await s.app.getNote(s.attachment), first);
  assert.equal(s.count(), 1);
});

test('deleted notes are not reused and other PDFs have separate notes', async () => {
  const s = setup();
  const first = await s.app.getNote(s.attachment);
  first.deleted = true;
  assert.notEqual(await s.app.getNote(s.attachment), first);
  const secondPDF = { ...s.attachment, key: 'PDF22222' };
  const second = await s.app.getNote(secondPDF);
  assert.equal(s.count(), 3);
  assert.ok(second.tags.includes('随读笔记/PDF22222'));
});

test('switching documents or using detached reader cannot target the wrong note', () => {
  const s = setup();
  s.win.Zotero_Tabs.selectedID = 'other-tab';
  assert.throws(() => s.app.assertCurrent(s.reader), /当前文献已切换/);
  assert.throws(() => s.app.assertCurrent({ _window: {} }), /标签页/);
});

test('read-only libraries are rejected before writing', async () => {
  const s = setup();
  s.attachment.isEditable = () => false;
  await assert.rejects(s.app.open(s.reader), /没有编辑权限/);
  assert.equal(s.count(), 0);
});

test('text excerpts retain exact position without creating a PDF annotation', async () => {
  const s = setup();
  let inserted;
  let saves = 0;
  s.app.open = async () => ({ attachment: s.attachment, instance: {
    insertAnnotations: async items => { inserted = items; }, focus() {}
  } });
  s.Zotero.Annotations.saveFromJSON = async (attachment, json) => {
    saves++;
    return { key: json.key, json };
  };
  const position = { pageIndex: 3, rects: [[10, 20, 40, 50]] };
  await s.app.excerpt(s.reader, { text: '原文', position, sortIndex: '00003|000001|00000', pageLabel: '4' });
  assert.equal(saves, 0);
  assert.deepEqual(inserted[0].position, position);
  assert.equal(inserted[0].id, undefined);
  assert.equal(inserted[0].attachmentItemID, 100);
  assert.equal(inserted[0].text, '原文');
});

test('image excerpt carries the image and source; missing images do not insert', async () => {
  const s = setup();
  let inserted;
  s.app.open = async () => ({ note: { libraryID: 1 }, instance: {
    insertAnnotations: async items => { inserted = items; }, focus() {}
  } });
  const item = { key: 'IMAGE123', libraryID: 1, parentID: 100, isAnnotation: () => true,
    json: { type: 'image', image: 'data:image/png;base64,AA==', position: { pageIndex: 2 } } };
  s.records.set(item.key, item);
  await s.app.insertExisting(s.reader, [item.key]);
  assert.equal(inserted[0].image, item.json.image);
  assert.equal(inserted[0].id, item.key);
  assert.equal(inserted[0].attachmentItemID, 100);
  delete item.json.image;
  inserted = undefined;
  await assert.rejects(s.app.insertExisting(s.reader, [item.key]), /图片批注还在生成/);
  assert.equal(inserted, undefined);
});

test('annotation from another PDF is rejected', async () => {
  const s = setup();
  s.records.set('OTHER123', { libraryID: 1, parentID: 999, isAnnotation: () => true });
  await assert.rejects(s.app.insertExisting(s.reader, ['OTHER123']), /来源不属于当前 PDF/);
});

test('queued operation is skipped after disable', async () => {
  const s = setup();
  let resolve;
  s.app.queues.set(100, new Promise(r => { resolve = r; }));
  let ran = false;
  const pending = s.app.run(s.reader, () => { ran = true; });
  s.app.alive = false;
  resolve();
  await pending;
  assert.equal(ran, false);
});

test('capture clicks native area tool once and preserves active selection mode', async () => {
  const s = setup();
  s.app.open = async () => ({});
  let active = false, clicks = 0, focused = 0;
  s.reader._window.focus = () => {};
  s.reader.focus = async () => { focused++; };
  s.reader._iframeWindow = { document: { querySelector: () => ({
    classList: { contains: () => active }, click: () => { clicks++; active = true; }
  }) } };
  await s.app.capture(s.reader);
  await s.app.capture(s.reader);
  assert.equal(clicks, 1);
  assert.equal(focused, 2);
});

test('Ctrl+Alt+N switches once and ignores IME composition/repeated keys', async () => {
  const s = setup();
  const handlers = {};
  const target = { addEventListener: (name, fn) => { handlers[name] = fn; } };
  s.reader.type = 'pdf';
  let toggled = 0;
  s.app.toggleWindow = async () => { toggled++; };
  s.app.bindShortcut(target, () => s.reader);
  const key = { ctrlKey: true, altKey: true, code: 'KeyN', preventDefault() {}, stopPropagation() {} };
  handlers.keydown({ ...key, isComposing: true });
  handlers.keydown({ ...key, repeat: true });
  handlers.keydown(key);
  await s.app.queues.get(100);
  assert.equal(toggled, 1);
});
