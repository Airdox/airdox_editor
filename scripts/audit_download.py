#!/usr/bin/env python3
"""Inspect actual downloaded delivery artifacts, not the builder's working tree."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
from release_evidence import digest, inventory, validate_stages, verify_inventory, write_json

LEGACY_STAGES = ('model-preflight', 'model-live', 'notebook-preauth', 'windows-types', 'windows-tests', 'windows-build', 'windows-smoke')


def inspect(directory, expected_commit, require_cli=False):
    directory = Path(directory).resolve()
    manifest = verify_inventory(directory, 'NACHWEISKETTE.json')
    if manifest['sourceCommit'] != expected_commit or manifest['googleAuthentication'] != 'NOT_ATTEMPTED':
        raise ValueError('Unexpected downloaded source or Google claim')
    stages = LEGACY_STAGES + (('cli-auth-boundary',) if require_cli else ())
    validate_stages(directory / 'NACHWEISE', stages, expected_commit)
    version = manifest['appVersion']
    required = ['START_HIER.md', 'PRUEFEN.ps1', 'windows-smoke.json', 'windows-smoke.png',
                'Colab/airdox-stem-remote-worker.ipynb', 'Colab/airdox-colab-worker.zip',
                'NACHWEISE/notebook-preauth-report.json', 'NACHWEISE/remote-real-model-evidence.json',
                'NACHWEISE/COLAB_AUTH_RECHERCHE.md', 'NACHWEISE/windows-tests-tests.json',
                f'airdox_SMART_Editor-{version}-setup.exe', f'airdox_SMART_Editor-{version}-portable.exe']
    if require_cli:
        required += ['Colab/CLI_AUTORISIERUNG.py', 'NACHWEISE/cli-auth-boundary-report.json']
    for name in required:
        if name not in manifest['files'] or not (directory / name).is_file():
            raise ValueError(f'Missing actual delivery content: {name}')
    if require_cli:
        auth = json.loads((directory / 'NACHWEISE/cli-auth-boundary-report.json').read_text(encoding='utf-8'))
        if auth['result'] != 'PASS' or auth['state'] != 'AUTH_REQUIRED' or auth['authenticated'] or auth['runtimeProvisioned']:
            raise ValueError('Invalid actual CLI boundary proof')
    actual = set(inventory(directory, ('NACHWEISKETTE.json',)))
    if actual != set(manifest['files']):
        raise ValueError('Downloaded package has missing or unlisted files')
    return dict(schemaVersion=1, result='PASS', evidenceActuallyPresent=True, appVersion=version,
                sourceCommit=expected_commit, inspectedAt=datetime.now(timezone.utc).isoformat(),
                workflowRun=os.environ.get('GITHUB_RUN_ID'), verifiedFiles=len(manifest['files']), requiredStages=list(stages),
                downloadedManifestSha256=digest(directory / 'NACHWEISKETTE.json'),
                files=manifest['files'], googleAuthentication='NOT_ATTEMPTED',
                scope='Actual downloaded artifact contents and hashes on independent runner; not Google account access')


def seal_audit(directory, report, previous_report=None):
    directory = Path(directory)
    manifest = json.loads((directory / 'NACHWEISKETTE.json').read_text(encoding='utf-8'))
    write_json(directory / 'NACHWEISE/download-audit.json', report)
    if previous_report:
        shutil.copyfile(previous_report, directory / 'NACHWEISE/previous-package-audit.json')
    # Human-readable index stays at the top level so evidence cannot be mistaken
    # for a separate optional download. Hashes remain in the JSON manifest.
    names = sorted(set(inventory(directory)) | {'PAKET_INHALT.txt'})
    (directory / 'PAKET_INHALT.txt').write_text('Tatsaechlich heruntergeladen und geprueft; Google noch nicht autorisiert.\n'
                                               + '\n'.join(names) + '\n', encoding='utf-8')
    manifest['downloadAudit'] = 'PASS'
    manifest['downloadAuditScope'] = 'Candidate downloaded on independent runner; audit reports added, then final file set verified again'
    manifest['files'] = inventory(directory, ('NACHWEISKETTE.json',))
    write_json(directory / 'NACHWEISKETTE.json', manifest)
    verify_inventory(directory, 'NACHWEISKETTE.json')
    print(f'PASS: downloaded candidate inspected; final delivery contains {len(manifest["files"])} verified files')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', required=True)
    parser.add_argument('--expected-commit', required=True)
    parser.add_argument('--report')
    parser.add_argument('--seal', action='store_true')
    parser.add_argument('--previous-report')
    parser.add_argument('--artifact-id')
    args = parser.parse_args()
    try:
        report = inspect(args.directory, args.expected_commit, require_cli=args.seal)
        report['downloadedArtifactId'] = args.artifact_id
        if args.report:
            write_json(args.report, report)
        if args.seal:
            seal_audit(args.directory, report, args.previous_report)
        print(json.dumps({k: report[k] for k in ('result', 'appVersion', 'sourceCommit', 'verifiedFiles', 'evidenceActuallyPresent')}, indent=2))
    except Exception as error:
        message = str(error).replace('%', '%25').replace('\n', '%0A').replace('\r', '%0D')
        if os.environ.get('GITHUB_ACTIONS'):
            print(f'::error title=Downloaded artifact audit::{message}')
        raise
