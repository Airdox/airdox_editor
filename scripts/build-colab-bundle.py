#!/usr/bin/env python3
"""Build deterministic worker payload + a self-contained notebook + embedded evidence."""
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import zipfile
from release_evidence import prepare_resource_proof, source_revision

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'resources/colab'
FILES = ['colab/remote_worker.py', 'colab/remote_setup.py', 'colab/preauth_check.py', 'colab/requirements-worker.txt',
         'python/bsroformer_inference.py', 'src/stems/modelCatalog.json',
         'tests/fixtures/musdb-falcon69/mixture.wav', 'tests/fixtures/musdb-falcon69/README.md']


def main():
    # Never leave stale evidence or a stale notebook from an older release.
    shutil.rmtree(OUT, ignore_errors=True)
    OUT.mkdir(parents=True)
    manifest = dict(appVersion=json.loads((ROOT / 'package.json').read_text())['version'],
                    sourceRevision=source_revision(),
                    files={name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in FILES})
    archive_path = OUT / 'airdox-colab-worker.zip'
    with zipfile.ZipFile(archive_path, 'w') as archive:
        items = [(name, (ROOT / name).read_bytes()) for name in FILES]
        items.append(('bundle.json', (json.dumps(manifest, indent=2) + '\n').encode()))
        for name, data in items:
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_STORED
            info.external_attr = 0o100644 << 16
            info.create_system = 3
            archive.writestr(info, data)
    payload = archive_path.read_bytes()
    notebook = json.loads((ROOT / 'colab/airdox-stem-remote-worker.ipynb').read_text(encoding='utf-8'))
    for cell in notebook['cells']:
        cell['source'] = [line.replace('__AIRDOX_BUNDLE_B64__', base64.b64encode(payload).decode())
                         .replace('__AIRDOX_BUNDLE_SHA256__', hashlib.sha256(payload).hexdigest()) for line in cell['source']]
    (OUT / 'airdox-stem-remote-worker.ipynb').write_text(json.dumps(notebook, indent=2, ensure_ascii=False) + '\n', encoding='utf-8', newline='\n')
    shutil.copyfile(ROOT / 'docs/COLAB_ABNAHME.md', OUT / 'ABNAHME.md')
    shutil.copyfile(ROOT / 'docs/COLAB_AUTH_RECHERCHE.md', OUT / 'GOOGLE_AUTH_RECHERCHE.md')
    (OUT / 'bundle.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8', newline='\n')
    prepare_resource_proof(OUT, os.environ.get('AIRDOX_EVIDENCE_DIR', 'evidence'), os.environ.get('AIRDOX_REQUIRE_EVIDENCE') == '1')
    print(f'Selbstenthaltendes Colab-Notebook {manifest["appVersion"]}: {OUT}')


if __name__ == '__main__':
    main()
