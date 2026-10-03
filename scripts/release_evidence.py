#!/usr/bin/env python3
"""Build/verify a source -> command/log -> test -> binary evidence graph.

SHA256 establishes integrity, not publisher identity. GitHub's independent
artifact provenance (if present) is verified separately, never implied here.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
REQUIRED_PREAUTH = ('model-preflight', 'model-live', 'notebook-preauth')
REQUIRED_RELEASE = REQUIRED_PREAUTH + ('windows-types', 'windows-tests', 'windows-build', 'windows-smoke')


def digest(file):
    value = hashlib.sha256()
    with open(file, 'rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def source_revision():
    return subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()


def source_ledger():
    names = subprocess.check_output(['git', 'ls-files', '-z'], cwd=ROOT).decode().split('\0')
    files = {}
    for name in names:
        if not name:
            continue
        if name.split('/')[0] in {'src', 'electron', 'colab', 'python', 'scripts', 'tests', '.github'} or name in {'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts'}:
            files[name] = digest(ROOT / name)
    return dict(sourceCommit=source_revision(), files=files)


def safe_file(root, name):
    if not isinstance(name, str) or not name or '\\' in name or ':' in name or name.startswith('/'):
        raise ValueError(f'Unsafe evidence path: {name}')
    if any(part in {'', '.', '..'} for part in name.split('/')):
        raise ValueError(f'Unsafe evidence path: {name}')
    result = (Path(root) / name).resolve()
    if Path(root).resolve() not in result.parents:
        raise ValueError(f'Evidence path escapes package: {name}')
    return result


def validate_stages(directory, required, revision, run_id=None):
    records = []
    for stage in required:
        file = Path(directory) / f'{stage}.json'
        report = json.loads(file.read_text(encoding='utf-8'))
        if report.get('stage') != stage or report.get('result') != 'PASS' or report.get('exitCode') != 0:
            raise ValueError(f'Missing/passing command evidence: {stage}')
        if report.get('sourceCommit') != revision:
            raise ValueError(f'Source revision mismatch: {stage}')
        if run_id and str(report.get('workflowRun')) != str(run_id):
            raise ValueError(f'Workflow run mismatch: {stage}')
        log = safe_file(directory, report['log']['file'])
        if digest(log) != report['log']['sha256']:
            raise ValueError(f'Command log hash mismatch: {stage}')
        records.append(dict(stage=stage, file=file.name, sha256=digest(file)))
    return records


def inventory(root, excluded=()):
    root = Path(root)
    return {p.relative_to(root).as_posix(): dict(sha256=digest(p), bytes=p.stat().st_size)
            for p in sorted(root.rglob('*')) if p.is_file() and p.relative_to(root).as_posix() not in excluded}


def write_json(file, data):
    Path(file).parent.mkdir(parents=True, exist_ok=True)
    Path(file).write_text(json.dumps(data, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')


def prepare_resource_proof(folder, evidence_dir, required=False):
    """Embedded pre-build proof. Never claim the EXE's future build was already tested."""
    folder = Path(folder)
    evidence_dir = Path(evidence_dir)
    revision = source_revision()
    destination = folder / 'nachweise'
    shutil.rmtree(destination, ignore_errors=True)
    destination.mkdir(parents=True)
    stages = []
    try:
        stages = validate_stages(evidence_dir, REQUIRED_PREAUTH, revision, os.environ.get('GITHUB_RUN_ID'))
    except (OSError, ValueError, KeyError):
        if required:
            raise
    if stages:
        for name in [*(f'{s}.{ext}' for s in REQUIRED_PREAUTH for ext in ('json', 'log')),
                     'model-live-tests.json', 'remote-real-model-evidence.json', 'notebook-preauth-report.json', 'notebook-execution.json']:
            source = evidence_dir / name
            if not source.is_file():
                raise ValueError(f'Required raw evidence missing: {name}')
            shutil.copyfile(source, destination / name)
    if stages:
        execution = json.loads((destination / 'notebook-execution.json').read_text(encoding='utf-8'))
        if execution['notebookSha256'] != digest(folder / 'airdox-stem-remote-worker.ipynb'):
            raise ValueError('Exported notebook differs from actual tested notebook')
    write_json(destination / 'source-files.json', source_ledger())
    write_json(folder / 'PREAUTH_NACHWEIS.json', dict(
        schemaVersion=1, sourceCommit=revision,
        result='PASS' if stages else 'NOT_VERIFIED', state='AUTH_REQUIRED' if stages else 'NOT_VERIFIED',
        googleAuthentication='NOT_ATTEMPTED', googleDriveTested=False,
        scope='CPU model + exported notebook preparation before drive.mount; not a user Google session',
        workflowUrl=f"https://github.com/Airdox/airdox_editor/actions/runs/{os.environ['GITHUB_RUN_ID']}" if os.environ.get('GITHUB_RUN_ID') else None,
        stages=stages, files=inventory(folder, ('PREAUTH_NACHWEIS.json',))
    ))


def verify_inventory(root, manifest_name):
    root = Path(root)
    report = json.loads((root / manifest_name).read_text(encoding='utf-8'))
    if report.get('schemaVersion') != 1 or not report.get('files'):
        raise ValueError('Unsupported or empty evidence manifest')
    for name, entry in report['files'].items():
        file = safe_file(root, name)
        if file.stat().st_size != entry['bytes'] or digest(file) != entry['sha256']:
            raise ValueError(f'File changed or incomplete: {name}')
    return report


def finalize(destination, evidence_dir):
    destination = Path(destination).resolve()
    if destination == ROOT.resolve() or destination in ROOT.resolve().parents or destination == Path(evidence_dir).resolve():
        raise ValueError('Output directory must not replace source repository or evidence inputs')
    revision = source_revision()
    version = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))['version']
    stages = validate_stages(evidence_dir, REQUIRED_RELEASE, revision, os.environ.get('GITHUB_RUN_ID'))
    model = json.loads((Path(evidence_dir) / 'remote-real-model-evidence.json').read_text(encoding='utf-8'))
    exported = json.loads((Path(evidence_dir) / 'notebook-preauth-report.json').read_text(encoding='utf-8'))
    tests = json.loads((Path(evidence_dir) / 'windows-tests-tests.json').read_text(encoding='utf-8'))
    smoke = json.loads((ROOT / 'release/windows-smoke.json').read_text(encoding='utf-8'))
    if model['result'] != 'PASS' or exported['result'] != 'PASS' or exported['state'] != 'AUTH_REQUIRED' or tests['failed'] or smoke['result'] != 'PASS':
        raise ValueError('Raw test evidence not passing')
    if exported['sourceCommit'] != revision or smoke['sourceCommit'] != revision or model['sourceCommit'] != revision:
        raise ValueError('Raw model/Windows evidence belongs to a different build')
    live_tests = json.loads((Path(evidence_dir) / 'model-live-tests.json').read_text(encoding='utf-8'))
    if live_tests['failed'] or live_tests['skipped'] or not live_tests['passed']:
        raise ValueError('Essential real model test failed or skipped')
    execution = json.loads((Path(evidence_dir) / 'notebook-execution.json').read_text(encoding='utf-8'))
    if execution['result'] != 'PASS' or execution['notebookSha256'] != digest(ROOT / 'resources/colab/airdox-stem-remote-worker.ipynb'):
        raise ValueError('Notebook execution not bound to shipped notebook')
    verify_inventory(ROOT / 'resources/colab', 'PREAUTH_NACHWEIS.json')
    shutil.rmtree(destination, ignore_errors=True)
    destination.mkdir(parents=True)
    for variant in ('setup', 'portable'):
        file = ROOT / f'release/airdox_SMART_Editor-{version}-{variant}.exe'
        if not file.is_file() or file.stat().st_size < 1000000:
            raise ValueError(f'Missing executable: {variant}')
        shutil.copyfile(file, destination / file.name)
    shutil.copytree(evidence_dir, destination / 'NACHWEISE')
    shutil.copytree(ROOT / 'resources/colab', destination / 'Colab')
    for file in ('windows-smoke.json', 'windows-smoke.png', 'SHA256SUMS.txt'):
        shutil.copyfile(ROOT / 'release' / file, destination / file)
    for name, source in [('PRUEFEN.ps1', 'scripts/verify-release.ps1'), ('START_HIER.md', 'docs/COLAB_START_HIER.md')]:
        shutil.copyfile(ROOT / source, destination / name)
    for name in ('COLAB_AUTH_RECHERCHE.md', 'COLAB_ABNAHME.md'):
        shutil.copyfile(ROOT / 'docs' / name, destination / 'NACHWEISE' / name)
    write_json(destination / 'NACHWEISE/source-files.json', source_ledger())
    write_json(destination / 'NACHWEISKETTE.json', dict(
        schemaVersion=1, appVersion=version, sourceCommit=revision,
        createdAt=datetime.now(timezone.utc).isoformat(), result='PRE_AUTH_VERIFIED',
        googleAuthentication='NOT_ATTEMPTED', googleDriveEndToEnd='PENDING_USER_AUTHORIZATION',
        workflowUrl=f"https://github.com/Airdox/airdox_editor/actions/runs/{os.environ.get('GITHUB_RUN_ID', '')}",
        statements=dict(windowsPackagedStartup='PASS', realModelCpu='PASS', exportedNotebookPreAuth='PASS',
                        userGoogleAccount='NOT_TESTED', colabGpu='NOT_TESTED', fullUserTrack='NOT_TESTED'),
        stages=stages, files=inventory(destination)
    ))
    verify_inventory(destination, 'NACHWEISKETTE.json')
    print(f'PRE_AUTH_VERIFIED: {destination}; Google authorization remains explicitly pending')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['finalize', 'verify'])
    parser.add_argument('--directory', default='delivery')
    parser.add_argument('--evidence', default='evidence')
    args = parser.parse_args()
    try:
        if args.command == 'finalize':
            finalize(args.directory, args.evidence)
        else:
            report = verify_inventory(args.directory, 'NACHWEISKETTE.json')
            validate_stages(Path(args.directory) / 'NACHWEISE', REQUIRED_RELEASE, report['sourceCommit'])
            print('PASS: package files and command/log evidence match. Google authentication is still pending.')
    except Exception as error:
        if os.environ.get('GITHUB_ACTIONS'):
            message = f'{type(error).__name__}: {error}'.replace('%', '%25').replace('\n', '%0A').replace('\r', '%0D')
            print(f'::error title=Release evidence::{message}', flush=True)
        raise
