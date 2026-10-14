from pathlib import Path
import json
import zipfile

root = Path(__file__).resolve().parent
out = root / 'outputs'
out.mkdir(exist_ok=True)
manifest = json.loads((root / 'manifest.json').read_text(encoding='utf-8'))
version = manifest['version']
app = manifest['applications']['zotero']
assert app['strict_min_version'] == '9.0.6'
for field in ('id', 'update_url', 'strict_max_version'):
    assert app.get(field), 'Missing required Zotero manifest field: ' + field
from urllib.parse import urlparse
assert urlparse(app['update_url']).scheme == 'https'
plugin_files = ['manifest.json', 'bootstrap.js', 'reading-notes.js', 'docx.js', 'settings.xhtml']
with zipfile.ZipFile(out / f'reading-notes-{version}.xpi', 'w', zipfile.ZIP_DEFLATED) as archive:
    for name in sorted(plugin_files):
        archive.write(root / name, name)
with zipfile.ZipFile(out / f'reading-notes-{version}.xpi') as archive:
    assert archive.testzip() is None
    assert set(archive.namelist()) == set(plugin_files)
    assert json.loads(archive.read('manifest.json').decode('utf-8')) == manifest
    for name in ('bootstrap.js', 'reading-notes.js', 'docx.js'):
        archive.read(name).decode('utf-8')
source_files = plugin_files + ['README.md', '.gitignore', 'build.py', 'verify.cjs', 'verify-dom.mjs',
    'verify-native.mjs', 'test_docx.py', 'linkedom-worker.mjs', 'linkedom-LICENSE',
    f'随读笔记-{version}-使用说明.md']
with zipfile.ZipFile(out / f'reading-notes-{version}-source.zip', 'w', zipfile.ZIP_DEFLATED) as archive:
    for name in source_files:
        archive.write(root / name, name)
print('Built and checked XPI and source ZIP.')
