import fs from 'node:fs';import vm from 'node:vm';import {DOMParser} from './linkedom-worker.mjs';
const doc=new DOMParser().parseFromString('<html><head></head><body></body></html>','text/html');
let source=fs.readFileSync('native-editor.js','utf8');
const cut=source.indexOf(',Va=[',source.indexOf('qa=function'));
source=source.slice(0,cut)+';self.native={schema:$a,EditorState:Cn,TextSelection:un,Slice:ge,Fragment:he,parse:qa};})(),o})()));';
const context=vm.createContext({console,setTimeout,clearTimeout,document:doc,window:doc.defaultView,navigator:{userAgent:'Firefox/128.0',platform:'Win32'},React:{},ReactDOM:{}});context.self=context;
vm.runInContext(source,context);
console.log(Object.keys(context.native));
fs.writeFileSync('native-engine-export.txt',Object.keys(context.native.schema.nodes).join(','));
import assert from 'node:assert/strict';
const original=fs.readFileSync('native-editor.js','utf8');
const method=original.indexOf('insertHTML(e,t){');
const start=original.indexOf('function(e,t){return function(n,r){',method);
const stop=original.indexOf('(e,t)(this.view.state,this.view.dispatch)',start);
const nativeInsertion=original.slice(start,stop);
vm.runInContext('const qa=self.native.parse, ge=self.native.Slice, he=self.native.Fragment, un=self.native.TextSelection;self.native.insert=('+nativeInsertion+');',context);
const {schema,EditorState,TextSelection}=context.native;
const annotation={attachmentURI:'http://zotero.org/users/local/test/items/PDFKEY',position:{pageIndex:0,rects:[[0,0,1,1]]},pageLabel:'1'};
const html='<p><span class="highlight" data-annotation="'+encodeURIComponent(JSON.stringify(annotation))+'">摘录的最后两个字</span></p>';
// Plugin code runs in a separate realm from the native editor, as in Zotero.
let cloneCalls=0;
const nativeArrayPrototype=vm.runInContext('Array.prototype',context);
const pluginContext=vm.createContext({Components:{utils:{cloneInto(value,target){
  assert.ok(Array.isArray(value));assert.equal(value.length,0);
  assert.ok(target.wrappedJSObject._currentEditorInstance._editorCore);
  cloneCalls++;
  return vm.runInContext('[]',context);
}}}});
vm.runInContext(fs.readFileSync('reading-notes.js','utf8'),pluginContext);
for (const mode of ['empty','after-enter','after-text','inside-old-excerpt']) {
  let doc,caret;
  const p=(text)=>schema.nodes.paragraph.create(null,text?schema.text(text):null);
  if(mode==='empty'){doc=schema.nodes.doc.create(null,[p()]);caret=1;}
  if(mode==='after-enter'){doc=schema.nodes.doc.create(null,[p('已有笔记'),p()]);caret=doc.content.size-1;}
  if(mode==='after-text'){doc=schema.nodes.doc.create(null,[p('已有笔记')]);caret=doc.content.size-1;}
  if(mode==='inside-old-excerpt'){
    const quote=schema.nodes.highlight.create({annotation},schema.text('旧摘录'));
    doc=schema.nodes.doc.create(null,[schema.nodes.paragraph.create(null,[quote])]);caret=3;
  }
  let state=EditorState.create({doc,selection:TextSelection.create(doc,caret)});
  const view={get state(){return state;},dispatch(tr){state=state.apply(tr);},focus(){}};
  const core={view,insertHTML(pos,html){context.native.insert(pos,html)(state,tr=>view.dispatch(tr));}};
  // Demonstrate the installed native null-position branch's bad empty-block caret.
  if(mode==='after-enter'){
    core.insertHTML(null,html);
    const legacy=state.selection.$from;
    assert.equal(legacy.parent.type.name,'highlight');
    assert.ok(legacy.parentOffset<legacy.parent.content.size);
    console.log('REPRODUCED: native empty-paragraph insertion leaves caret inside the excerpt before its end.');
    state=EditorState.create({doc,selection:TextSelection.create(doc,caret)});
  }
  pluginContext.ReadingNotes.insertAtCaret({_iframeWindow:{wrappedJSObject:{_currentEditorInstance:{_editorCore:core}},focus(){}}},html);
  const selection=state.selection;
  assert.equal(selection.$from.parent.type.name,'paragraph',mode);
  assert.equal(selection.$from.nodeBefore.text.endsWith(' '),true,mode);
  assert.equal(selection.$from.nodeAfter,null,mode);
  assert.equal(state.storedMarks.length,0);
  assert.equal(Object.getPrototypeOf(state.storedMarks),nativeArrayPrototype,
    'typing marks must belong to the editor realm, not the privileged plugin');
  assert.deepEqual(Array.from(state.storedMarks.slice()),[]);
  let found;
  state.doc.descendants((node)=>{if(node.type.name==='highlight'&&node.textContent==='摘录的最后两个字')found=node;});
  assert.ok(found);assert.equal(found.attrs.annotation.attachmentURI,annotation.attachmentURI);
  // The first Chinese insertion must be ordinary text, not nested excerpt content.
  view.dispatch(state.tr.insertText('中文输入'));
  assert.equal(state.selection.$from.parent.type.name,'paragraph');
  assert.equal(found.textContent,'摘录的最后两个字');
  assert.equal(state.doc.childCount,doc.childCount,mode+' must not add a paragraph');
  pluginContext.ReadingNotes.insertAtCaret({_iframeWindow:{wrappedJSObject:{_currentEditorInstance:{_editorCore:core}},focus(){}}},html);
  assert.equal(Object.getPrototypeOf(state.storedMarks),nativeArrayPrototype);
  assert.equal(state.selection.$from.parent.type.name,'paragraph');
  assert.equal(state.doc.childCount,doc.childCount);
  console.log('PASS actual Zotero engine:',mode,'caret and first Chinese insertion outside excerpt; source metadata retained.');
}

assert.equal(cloneCalls,8);console.log('PASS: all typing-mark arrays are cloned into the editor realm; native slice() remains accessible.');
