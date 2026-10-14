from pathlib import Path
import json
import zipfile

root = Path(__file__).resolve().parent.parent
plugin = root / 'work' / 'plugin'
out = root / 'outputs'
out.mkdir(exist_ok=True)
manifest = json.loads((plugin / 'manifest.json').read_text(encoding='utf-8'))
assert manifest['applications']['zotero']['strict_min_version'] == '9.0.6'
version = manifest['version']
app = manifest['applications']['zotero']
# Required by Zotero's patched Extension.sys.mjs, beyond JSON/ZIP validity.
for field in ('id', 'update_url', 'strict_max_version'):
    assert app.get(field), 'Missing required Zotero manifest field: ' + field
from urllib.parse import urlparse
assert urlparse(app['update_url']).scheme == 'https'
with zipfile.ZipFile(out / f'reading-notes-{version}.xpi', 'w', zipfile.ZIP_DEFLATED) as archive:
    for path in sorted(plugin.rglob('*')):
        if path.is_file(): archive.write(path, path.relative_to(plugin).as_posix())
with zipfile.ZipFile(out / f'reading-notes-{version}.xpi') as archive:
    assert archive.testzip() is None
    assert set(archive.namelist()) == {'manifest.json', 'bootstrap.js', 'reading-notes.js', 'docx.js', 'settings.xhtml'}
    packaged = json.loads(archive.read('manifest.json').decode('utf-8'))
    assert packaged == manifest
    for filename in ('bootstrap.js', 'reading-notes.js', 'docx.js'):
        archive.read(filename).decode('utf-8')
with zipfile.ZipFile(out / f'reading-notes-{version}-source.zip', 'w', zipfile.ZIP_DEFLATED) as archive:
    for path in [*plugin.glob('*'), root / 'work/verify.cjs', root / 'work/verify-dom.mjs', root / 'work/verify-native.mjs', root / 'work/test_docx.py',
                 root / 'work/test-deps/linkedom-worker.mjs', root / 'work/test-deps/linkedom-LICENSE',
                 root / 'work/build.py', out / f'随读笔记-{version}-使用说明.md']:
        archive.write(path, path.relative_to(root).as_posix())
print('Built and checked XPI and source ZIP.')
