from pathlib import Path
import subprocess, json, base64, re, zipfile, io
from lxml import etree
from PIL import Image

root = Path(__file__).resolve().parent.parent
fixture = '''<div data-schema-version="9"><h1>阅读笔记</h1>
<p><span class="highlight" data-annotation="source">原文摘录 &amp; source</span><span class="citation" data-citation="x">不要导出的长引用</span> 我的行内想法</p>
<p>我的想法 <strong>加粗</strong> <em>斜体</em> <a href="zotero://open-pdf/library/items/ABCDEFGH">普通文字链接</a></p>
<p><span style="color: #ff2020; background-color: #ffd40080; font-family: KaiTi; font-size: 18pt">彩色格式</span><code>等宽代码</code><span style="color:rgb(0, 0, 255)">蓝色</span></p>
<ul><li>要点一</li><li>要点二</li></ul><table><tr><td>方法</td><td>结论</td></tr></table>
<blockquote><p><img data-attachment-key="TESTIMAGE" width="120" height="160" data-annotation="source"/></p></blockquote></div>'''
image = io.BytesIO()
Image.new('RGB', (120, 160), '#9ca3af').save(image, 'PNG')
png = image.getvalue()
html = '''<!doctype html><html><head><meta charset="utf-8"><script src="plugin/docx.js"></script></head><body><pre id="result">pending</pre><script>
(async () => {
 try {
  const bytes = Uint8Array.from(atob(PNG), c => c.charCodeAt(0));
  const docx = await ReadingNotesDocx.fromHTML(FIXTURE, async key => { if(key !== 'TESTIMAGE') throw Error('Wrong image key'); return bytes; });
  document.getElementById('result').textContent = JSON.stringify({ok:true,zip:btoa(Array.from(docx, n => String.fromCharCode(n)).join(''))});
 } catch(e) { document.getElementById('result').textContent=JSON.stringify({ok:false,error:String(e),stack:e.stack}); }
})();</script></body></html>'''
html = html.replace('PNG', json.dumps(base64.b64encode(png).decode())).replace('FIXTURE', json.dumps(fixture, ensure_ascii=True))
testfile = root / 'work/docx-browser-test.html'
testfile.write_text(html, encoding='utf-8')
runner = '''import {DOMParser} from './test-deps/linkedom-worker.mjs';
import fs from 'node:fs'; import vm from 'node:vm';
const context=vm.createContext({DOMParser,TextEncoder,Uint8Array,DataView,atob,console});
vm.runInContext(fs.readFileSync('work/plugin/docx.js','utf8'),context);
const fixture=FIXTURE;
const image=Uint8Array.from(Buffer.from(PNG,'base64'));
try {
 const bytes=await context.ReadingNotesDocx.fromHTML(fixture,async key=>{if(key!=='TESTIMAGE')throw Error('Wrong image key');return image;}, {excerptFont:'Times New Roman',ownFont:'Microsoft YaHei',fontSize:16,lineHeight:1.5,paragraphBefore:1,paragraphAfter:4,italic:true,bold:true});
 console.log(JSON.stringify({ok:true,zip:Buffer.from(bytes).toString('base64')}));
} catch(e) {console.log(JSON.stringify({ok:false,error:String(e),stack:e.stack}));}
'''.replace('FIXTURE', json.dumps(fixture, ensure_ascii=True)).replace('PNG', json.dumps(base64.b64encode(png).decode()))
(root / 'work/docx-dom-test.mjs').write_text(runner, encoding='utf-8')
result = subprocess.run(['node', 'work/docx-dom-test.mjs'], cwd=root, capture_output=True, timeout=25)
assert result.returncode == 0, result.stderr.decode(errors='replace')
report = json.loads(result.stdout)
assert report.get('ok'), report
data = base64.b64decode(report['zip'])
(root / 'work/docx-export-test.docx').write_bytes(data)
with zipfile.ZipFile(io.BytesIO(data)) as archive:
 assert archive.testzip() is None
 for name in archive.namelist():
  if name.endswith(('.xml', '.rels')): etree.fromstring(archive.read(name))
 xml = archive.read('word/document.xml').decode()
 assert '原文摘录' in xml and '我的想法' in xml
 assert '不要导出的长引用' not in xml
 assert 'zotero://' not in xml and 'data-annotation' not in xml and 'w:hyperlink' not in xml
 assert '<w:b/>' in xml and '<w:i/>' in xml and '<w:tbl>' in xml
 assert archive.read('word/media/image1.png') == png
 doc = etree.fromstring(archive.read('word/document.xml'))
 ns = {'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
 for paragraph in doc.xpath('//w:p', namespaces=ns):
  text = ''.join(paragraph.xpath('.//w:t/text()', namespaces=ns))
  if '我的想法' in text: assert not paragraph.xpath('./w:pPr/w:shd', namespaces=ns)
  assert not paragraph.xpath('./w:pPr/w:shd | ./w:pPr/w:pBdr', namespaces=ns)
  if paragraph.xpath('./w:pPr/w:spacing', namespaces=ns):
   assert paragraph.xpath('./w:pPr/w:spacing/@w:line', namespaces=ns) == ['360']
   assert paragraph.xpath('./w:pPr/w:spacing/@w:before', namespaces=ns) == ['15']
   assert paragraph.xpath('./w:pPr/w:spacing/@w:after', namespaces=ns) == ['60']
 for run in doc.xpath('//w:r', namespaces=ns):
  text = ''.join(run.xpath('.//w:t/text()', namespaces=ns))
  if '原文摘录' in text:
   assert run.xpath('./w:rPr/w:rFonts/@w:ascii', namespaces=ns) == ['Times New Roman']
   assert run.xpath('./w:rPr/w:i', namespaces=ns) and run.xpath('./w:rPr/w:b', namespaces=ns)
  if '我的行内想法' in text: assert not run.xpath('./w:rPr/w:rFonts', namespaces=ns)
 for text, font, color, fill, size in [('彩色格式','KaiTi','FF2020','FFE97F','36'),('等宽代码','Consolas',None,None,None),('蓝色',None,'0000FF',None,None)]:
  runs = doc.xpath('//w:r[w:t="'+text+'"]', namespaces=ns)
  assert len(runs) == 1, text
  for prop, value in [('w:rFonts/@w:ascii',font),('w:color/@w:val',color),('w:shd/@w:fill',fill),('w:sz/@w:val',size)]:
   if value: assert runs[0].xpath('./w:rPr/'+prop, namespaces=ns) == [value], (text, prop)
 styles = archive.read('word/styles.xml').decode()
 assert 'Microsoft YaHei' in styles and 'w:val="24"' in styles
print('PASS: DOCX ZIP/XML, embedded image, custom fonts/italic/bold/font size/line/paragraph spacing, ordinary own text on same line, no shading/border/citation/PDF hyperlink.')

