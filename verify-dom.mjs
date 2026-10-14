import { DOMParser } from './linkedom-worker.mjs';
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const context = vm.createContext({ DOMParser, console });
let posted, ensured = false, imported = false;
context.Zotero = { EditorInstanceUtilities: { serializeAnnotations: () => ({
  html: '<p><span class="highlight" data-annotation="location">Quoted &amp; text</span> <span class="citation" data-citation="x">Long unwanted citation</span></p>'
}) } };
let appearance;
context.Zotero.Prefs = { get: () => appearance };
vm.runInContext(fs.readFileSync('reading-notes.js', 'utf8'), context);
const app = context.ReadingNotes;
app.insertAtCaret = (instance, html) => { posted = { action: "insertHTML", html }; };
await app.insertStyled({
  focus() {},
  _ensureNoteCreated: async () => { ensured = true; },
  importImages: async () => { imported = true; },
  _postMessage: message => { posted = message; }
}, [{ text: 'Quoted & text' }]);
assert.ok(ensured && imported);
assert.equal(posted.action, 'insertHTML');
assert.ok(posted.html.includes('data-annotation="location"'));
assert.ok(!posted.html.includes('Long unwanted citation'));
assert.ok(!posted.html.includes('<blockquote>'));
assert.ok(!posted.html.includes('<p></p>'));
assert.ok(posted.html.includes('Times New Roman'));
console.log('PASS: insertion preserves location, removes citation, sets excerpt font, adds no quote block or blank paragraph.');

const buttonDoc = new DOMParser().parseFromString('<html><head></head><body></body></html>', 'text/html');
let presses = 0;
const button = app.button(buttonDoc, '随读笔记', async () => { presses++; });
const event = (type, values) => {
  const e = new buttonDoc.defaultView.Event(type, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries(values)) Object.defineProperty(e, key, { value });
  return e;
};
button.dispatchEvent(event('pointerdown', {button: 0}));
assert.equal(presses, 0);
button.dispatchEvent(event('click', {detail: 1}));
await new Promise(resolve => setImmediate(resolve));
assert.equal(presses, 1, 'first mouse click executes');
assert.ok(button.classList.contains('toolbar-button'));
assert.ok(button.style.cssText.includes('-moz-window-dragging:no-drag'));
button.dispatchEvent(event('click', {detail: 0}));
await new Promise(resolve => setImmediate(resolve));
assert.equal(presses, 2, 'keyboard activation must still work');
console.log('PASS: explicit no-drag and native toolbar class, first click executes, keyboard activation works.');
assert.equal(app.getSettings().italic, true);
assert.equal(app.getSettings().lineHeight, 1.3);
appearance = JSON.stringify({ excerptFont:'KaiTi', italic:false, bold:true, lineHeight:1.6, paragraphAfter:4 });
assert.ok(app.editorCSS().includes('"KaiTi"'));
assert.ok(app.editorCSS().includes('font-style:normal'));
assert.ok(app.editorCSS().includes('line-height:1.6'));
appearance = JSON.stringify({excerptFont:'evil; CSS',lineHeight:999,fontSize:1});
assert.equal(app.getSettings().excerptFont, 'SimSun');
assert.equal(app.getSettings().lineHeight, 2.5);
assert.equal(app.getSettings().fontSize, 10);
appearance = undefined;
console.log('PASS: configurable excerpt emphasis/font/spacing, safe font list and numeric bounds.');

const initialState = {STATE_MAXIMIZED:1,windowState:1,fullScreen:true,maximize(){this.windowState=1;}};
const savedAssert = app.assertCurrent;
app.assertCurrent = () => initialState;
app.switchWindow = async () => {initialState.windowState=3;initialState.fullScreen=false;};
await app.toggleWindow({});
assert.equal(initialState.windowState,1);
assert.equal(initialState.fullScreen,true);
delete app.switchWindow;
app.assertCurrent = savedAssert;
// Reload after the window-state stub to exercise the actual switch implementation below.
vm.runInContext(fs.readFileSync('reading-notes.js', 'utf8'), context);
console.log('PASS: switching preserves both maximize and fullscreen state.');

const switchedApp = context.ReadingNotes;
switchedApp.alive = true;
const order = [];
const note = { id: 10 };
const editor = { item: note, focus: async () => order.push('focus'), ownerGlobal: {} };
const side = { item: note };
const floating = { closed: false, close() { order.push('close-window'); this.closed = true; } };
const main = { focus: () => order.push('main-focus') };
const reader = { itemID: 100 };
switchedApp.assertCurrent = () => main;
switchedApp.flush = async value => { assert.equal(value, editor); order.push('saved'); };
switchedApp.rememberGeometry = () => order.push('remember');
switchedApp.open = async (value, forceSide) => {
  assert.ok(forceSide);
  assert.equal(value, reader);
  assert.equal(floating.closed, true);
  order.push('open-side');
  return { instance: {}, note };
};
switchedApp.detached.set(100, { win: floating, editor });
await switchedApp.toggleWindow(reader);
assert.deepEqual(order, ['saved', 'remember', 'close-window', 'main-focus', 'open-side']);
assert.equal(switchedApp.detached.has(100), false);
console.log('PASS: detached-to-side switch awaits save before closing the editor and reopening the same note.');

// Opening in detached mode must return its actual editor instead of the side editor.
vm.runInContext(fs.readFileSync('reading-notes.js', 'utf8'), context);
const routing = context.ReadingNotes;
routing.alive = true;
routing.assertCurrent = () => main;
routing.prepareEditor = async () => {};
context.Zotero.Items = { get: () => ({ id: 100, isEditable: () => true }) };
let instance = { test: 'floating instance' };
floating.closed = false;
floating.focus = () => {};
routing.detached.set(100, { win: floating, editor, instance });
const result = await routing.open(reader);
assert.equal(result.instance, instance);
assert.equal(result.note.id, 10);
console.log('PASS: excerpts route to the detached editor while detached mode is active.');

// Native insertion/selection is tested against the installed engine in verify-native.mjs.

// Exercise actual settings markup, option clicks, reset and numeric saving.
const settingsDoc=new DOMParser().parseFromString(fs.readFileSync('settings.xhtml','utf8'),'text/html');
let savedSettings,closed=false;
context.Zotero.Prefs.set=(key,value)=>{savedSettings=JSON.parse(value);};
for (const input of settingsDoc.querySelectorAll('input')) {
  Object.defineProperty(input,'type',{value:input.getAttribute('type')});
  input.focus=()=>{};
}
for (const button of settingsDoc.querySelectorAll('button')) button.focus=()=>{};
routing.initializeSettings({document:settingsDoc,close(){closed=true;}},routing.getSettings());
const click=node=>node.dispatchEvent(new settingsDoc.defaultView.Event('click',{bubbles:true}));
const own=settingsDoc.getElementById('ownFont'),list=settingsDoc.getElementById('ownFontOptions');
assert.ok(own.textContent.includes('微软雅黑'));assert.equal(list.children.length,5);
click(own);assert.equal(list.hidden,false);
click(list.children[2]);assert.equal(own.dataset.value,'KaiTi');assert.equal(list.hidden,true);
assert.ok(own.textContent.includes('楷体'));
settingsDoc.getElementById('lineHeight').value='1.6';
click(settingsDoc.getElementById('save'));assert.equal(savedSettings.ownFont,'KaiTi');assert.equal(savedSettings.lineHeight,1.6);assert.equal(closed,true);
assert.equal(settingsDoc.querySelectorAll('select,option').length,0);
assert.equal(settingsDoc.querySelectorAll('label input,label button').length,0);
console.log('PASS: actual settings option click, displayed font, numeric persistence, no native select or wrapping labels.');
let focused=0;
routing.settingsWindow={closed:false,focus(){focused++;}};
await routing.showSettings({});await routing.showSettings({});
assert.equal(focused,2);
console.log('PASS: repeated settings clicks focus the existing dialog without rebuilding fields.');
assert.ok(fs.readFileSync('reading-notes.js','utf8').includes('chrome://reading-notes/content/settings.xhtml'));
assert.ok(fs.readFileSync('bootstrap.js','utf8').includes('registerChrome'));
console.log('PASS: settings uses a bundled registered chrome resource.');
