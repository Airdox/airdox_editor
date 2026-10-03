#!/usr/bin/env python3
"""Execute the exported notebook up to (never through) the Google consent gate.

No replacement inference code, no credentials, no Drive mount. CI explicitly
uses CPU and public dependency downloads. The notebook SHA binds the result to
exactly the file later shipped on Windows (deterministic payload).
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model-dir', required=True)
    args = parser.parse_args()
    notebook_path = ROOT / 'resources/colab/airdox-stem-remote-worker.ipynb'
    notebook = json.loads(notebook_path.read_text(encoding='utf-8'))
    destination = ROOT / os.environ.get('AIRDOX_EVIDENCE_DIR', 'evidence')
    destination.mkdir(parents=True, exist_ok=True)
    started = datetime.now(timezone.utc).isoformat()
    executed = []
    with tempfile.TemporaryDirectory(prefix='airdox-notebook-preauth-') as temporary:
        os.environ.update(AIRDOX_COLAB_CONTENT=temporary, AIRDOX_COLAB_DEVICE='cpu', AIRDOX_COLAB_TORCH_INDEX='cpu',
                          AIRDOX_COLAB_MODEL_DIR=str(Path(args.model_dir).resolve()))
        namespace = {'__name__': '__main__'}
        for index, cell in enumerate(notebook['cells']):
            if cell['cell_type'] != 'code':
                continue
            text = ''.join(cell['source'])
            if '# AIRDOX_AUTH_GATE' in text:
                break
            if not text.startswith('# AIRDOX_STAGE:'):
                raise RuntimeError(f'Unrecognized pre-auth code cell {index}')
            print(f'Executing EXPORTED notebook cell {index}: {text.splitlines()[0]}', flush=True)
            exec(compile(text, f'{notebook_path.name}:cell-{index}', 'exec'), namespace)
            executed.append(index)
        else:
            raise RuntimeError('Notebook has no explicit Google authorization boundary')
        if len(executed) != 3:
            raise RuntimeError(f'Unexpected preparation cell count: {executed}')
        report = namespace['preauth']
        if report.get('result') != 'PASS' or report.get('state') != 'AUTH_REQUIRED' or report.get('googleAuthentication') != 'NOT_ATTEMPTED':
            raise RuntimeError('Notebook did not reach the expected authorization boundary')
        shutil.copyfile(namespace['PREAUTH_REPORT'], destination / 'notebook-preauth-report.json')
    (destination / 'notebook-execution.json').write_text(json.dumps(dict(
        schemaVersion=1, result='PASS', sourceCommit=report['sourceCommit'],
        startedAt=started, finishedAt=datetime.now(timezone.utc).isoformat(),
        notebookSha256=hashlib.sha256(notebook_path.read_bytes()).hexdigest(),
        executedCells=executed, stoppedBeforeCell=index, device='cpu',
        googleAuthentication='NOT_ATTEMPTED', googleDriveTested=False,
        scope='Actual exported notebook preparation cells on Linux CPU; not a Google Colab runtime'
    ), indent=2) + '\n', encoding='utf-8')
    print('PASS: exact exported notebook reached AUTH_REQUIRED. No Google authentication attempted.', flush=True)


if __name__ == '__main__':
    main()
