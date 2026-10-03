import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
import zipfile
import base64
import io
import subprocess

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'scripts'))
from release_evidence import validate_stages, verify_inventory, safe_file, inventory


class EvidenceTests(unittest.TestCase):
    def test_missing_failed_wrong_commit_and_tampered_log(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with self.assertRaises(FileNotFoundError):
                validate_stages(root, ['test'], 'source')
            (root / 'test.log').write_bytes(b'actual command output')
            report = dict(stage='test', result='PASS', exitCode=0, sourceCommit='source', workflowRun='same-run',
                          log=dict(file='test.log', sha256=hashlib.sha256(b'actual command output').hexdigest()))
            (root / 'test.json').write_text(json.dumps(report))
            self.assertEqual(len(validate_stages(root, ['test'], 'source', 'same-run')), 1)
            for key, value in [('result', 'FAIL'), ('exitCode', 1), ('sourceCommit', 'different'), ('workflowRun', 'old-run')]:
                broken = dict(report, **{key: value})
                (root / 'test.json').write_text(json.dumps(broken))
                with self.assertRaises(ValueError):
                    validate_stages(root, ['test'], 'source', 'same-run')
            (root / 'test.json').write_text(json.dumps(report))
            (root / 'test.log').write_bytes(b'altered')
            with self.assertRaises(ValueError):
                validate_stages(root, ['test'], 'source', 'same-run')

    def test_paths_and_inventory(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name in ('../x', '/abs', 'C:/x', 'a\\b', 'a/../b'):
                with self.assertRaises(ValueError):
                    safe_file(root, name)
            (root / 'file').write_bytes(b'original')
            (root / 'proof.json').write_text(json.dumps(dict(schemaVersion=1, files=inventory(root))))
            verify_inventory(root, 'proof.json')
            (root / 'file').write_bytes(b'tampered')
            with self.assertRaises(ValueError):
                verify_inventory(root, 'proof.json')

    def test_complete_delivery_under_windows_default_encoding(self):
        # Synthetic packaging fixture only. Never used as inference/Windows evidence.
        import os
        import shutil
        from unittest.mock import patch
        import release_evidence as module
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            evidence = root / 'evidence'
            evidence.mkdir()
            revision = 'a' * 40
            original_read_text = Path.read_text
            def windows_default_read_text(file, *args, **kwargs):
                kwargs.setdefault('encoding', 'cp1252')
                return original_read_text(file, *args, **kwargs)
            for stage in module.REQUIRED_RELEASE:
                (evidence / f'{stage}.log').write_bytes(b'unit fixture output')
                module.write_json(evidence / f'{stage}.json', dict(stage=stage, result='PASS', exitCode=0,
                    sourceCommit=revision, workflowRun=os.environ.get('GITHUB_RUN_ID'),
                    log=dict(file=f'{stage}.log', sha256=module.digest(evidence / f'{stage}.log'))))
            module.write_json(evidence / 'remote-real-model-evidence.json', dict(result='PASS', sourceCommit=revision))
            module.write_json(evidence / 'notebook-preauth-report.json', dict(result='PASS', state='AUTH_REQUIRED', sourceCommit=revision))
            module.write_json(evidence / 'windows-tests-tests.json', dict(passed=1, failed=0, skipped=0, output='Unicode regression: ←'))
            module.write_json(evidence / 'cli-auth-boundary-report.json', dict(result='PASS', state='AUTH_REQUIRED', sourceCommit=revision, authenticated=False, runtimeProvisioned=False))
            module.write_json(evidence / 'model-live-tests.json', dict(passed=1, failed=0, skipped=0))
            kit = root / 'resources/colab'
            kit.mkdir(parents=True)
            (kit / 'airdox-stem-remote-worker.ipynb').write_bytes(b'unit notebook fixture')
            (kit / 'airdox-colab-worker.zip').write_bytes(b'unit worker fixture')
            (kit / 'CLI_AUTORISIERUNG.py').write_bytes(b'unit helper fixture')
            module.write_json(evidence / 'notebook-execution.json', dict(result='PASS', notebookSha256=module.digest(kit / 'airdox-stem-remote-worker.ipynb')))
            module.write_json(kit / 'PREAUTH_NACHWEIS.json', dict(schemaVersion=1, files=module.inventory(kit)))
            module.write_json(root / 'package.json', dict(version='unit'))
            (root / 'release').mkdir()
            for variant in ('setup', 'portable'):
                (root / f'release/airdox_SMART_Editor-unit-{variant}.exe').write_bytes(b'0' * 1000001)
            module.write_json(root / 'release/windows-smoke.json', dict(result='PASS', sourceCommit=revision))
            for name in ('windows-smoke.png', 'SHA256SUMS.txt'):
                (root / 'release' / name).write_bytes(b'unit fixture')
            (root / 'scripts').mkdir()
            shutil.copyfile(ROOT / 'scripts/verify-release.ps1', root / 'scripts/verify-release.ps1')
            (root / 'docs').mkdir()
            for name in ('COLAB_START_HIER.md', 'COLAB_AUTH_RECHERCHE.md', 'COLAB_ABNAHME.md'):
                (root / 'docs' / name).write_text('fixture', encoding='utf-8')
            with patch.object(module, 'ROOT', root), patch.object(module, 'source_revision', return_value=revision), \
                 patch.object(module, 'source_ledger', return_value=dict(sourceCommit=revision)), \
                 patch.object(Path, 'read_text', windows_default_read_text):
                module.finalize(root / 'delivery', evidence)
                report = module.verify_inventory(root / 'delivery', 'NACHWEISKETTE.json')
                self.assertEqual(report['googleAuthentication'], 'NOT_ATTEMPTED')
                self.assertIn('PRUEFEN.ps1', report['files'])
                import audit_download
                downloaded = audit_download.inspect(root / 'delivery', revision, require_cli=True)
                self.assertTrue(downloaded['evidenceActuallyPresent'])
                with self.assertRaises(ValueError):
                    audit_download.inspect(root / 'delivery', 'wrong-source', require_cli=True)
                audit_download.seal_audit(root / 'delivery', downloaded)
                self.assertEqual(module.verify_inventory(root / 'delivery', 'NACHWEISKETTE.json')['downloadAudit'], 'PASS')
                extra = root / 'delivery/unlisted-file'
                extra.write_text('unexpected')
                with self.assertRaises(ValueError):
                    audit_download.inspect(root / 'delivery', revision, require_cli=True)
                extra.unlink()
                with self.assertRaises(ValueError):
                    module.finalize(root, evidence)
            if sys.platform == 'win32':
                for shell in ('pwsh', 'powershell.exe'):
                    result = subprocess.run([shell, '-NoProfile', '-File', str(root / 'delivery/PRUEFEN.ps1')], capture_output=True, text=True)
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                    # Verification must fail after changing an executable, not just at build time.
                    binary = root / 'delivery/airdox_SMART_Editor-unit-setup.exe'
                    binary.write_bytes(b'tampered')
                    failed = subprocess.run([shell, '-NoProfile', '-File', str(root / 'delivery/PRUEFEN.ps1')], capture_output=True, text=True)
                    self.assertNotEqual(failed.returncode, 0)
                    binary.write_bytes(b'0' * 1000001)

    def test_oauth_probe_isolated_and_fail_closed(self):
        from unittest.mock import patch
        import os
        sys.path.insert(0, str(ROOT / 'colab'))
        import cli_auth
        url = 'https://accounts.google.com/o/oauth2/auth?redirect_uri=https%3A%2F%2Fsdk.cloud.google.com%2Fapplicationdefaultauthcode.html&response_type=code&token_usage=remote&state=discard-me&client_id=public-client&scope=openid'
        def run(command, **kwargs):
            self.assertIn('--auth=oauth2', command)
            self.assertEqual(command[-1], 'whoami')
            self.assertEqual(kwargs['stdin'], subprocess.DEVNULL)
            self.assertNotEqual(kwargs['env']['HOME'], os.environ.get('HOME'))
            self.assertNotIn('GOOGLE_APPLICATION_CREDENTIALS', kwargs['env'])
            return subprocess.CompletedProcess(command, 1, 'Enter the authorization code: ', url)
        with patch.object(cli_auth.subprocess, 'run', side_effect=run):
            report = cli_auth.probe('/test/colab', dict(os.environ, GOOGLE_APPLICATION_CREDENTIALS='must-not-read'))
        self.assertEqual(report['state'], 'AUTH_REQUIRED')
        self.assertFalse(report['authenticated'])
        self.assertNotIn('discard-me', json.dumps(report))
        self.assertNotIn('public-client', json.dumps(report))
        with patch.object(cli_auth.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, '', 'network failure')):
            with self.assertRaises(RuntimeError):
                cli_auth.probe('/test/colab', os.environ)

    def test_notebook_boundary_and_self_contained_payload(self):
        # Source template must fail safely instead of silently fetching arbitrary code.
        source = json.loads((ROOT / 'colab/airdox-stem-remote-worker.ipynb').read_text(encoding='utf-8'))
        code = [''.join(c['source']) for c in source['cells'] if c['cell_type'] == 'code']
        self.assertEqual(len(code), 5)
        self.assertTrue(code[3].startswith('# AIRDOX_AUTH_GATE'))
        for cell in code:
            compile(cell, 'source-notebook', 'exec')
        self.assertNotIn('from google.colab', ''.join(code[:3]))
        self.assertNotIn('drive.mount', ''.join(code[:3]))
        self.assertIn('preauth_check.py', code[2])
        self.assertIn('WORKERBETRIEB_BESTAETIGT', code[4])
        # Build logic itself must embed a payload rather than a Drive path.
        import importlib.util
        spec = importlib.util.spec_from_file_location('build_colab', ROOT / 'scripts/build-colab-bundle.py')
        builder = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(builder)
        with tempfile.TemporaryDirectory() as temporary:
            builder.OUT = Path(temporary) / 'kit'
            import os
            from unittest.mock import patch
            with patch.dict(os.environ, {'AIRDOX_REQUIRE_EVIDENCE': '0', 'AIRDOX_EVIDENCE_DIR': str(Path(temporary) / 'empty')}):
                builder.main()
            notebook = json.loads((builder.OUT / 'airdox-stem-remote-worker.ipynb').read_text(encoding='utf-8'))
            cells = [''.join(c['source']) for c in notebook['cells'] if c['cell_type'] == 'code']
            namespace = {'CONTENT_ROOT': Path(temporary) / 'content'}
            namespace['CONTENT_ROOT'].mkdir()
            exec(compile(cells[1], 'export-payload', 'exec'), namespace)
            payload = namespace['payload']
            self.assertEqual(payload, (builder.OUT / 'airdox-colab-worker.zip').read_bytes())
            self.assertTrue((namespace['REPO_DIR'] / 'colab/preauth_check.py').is_file())
            self.assertTrue((namespace['REPO_DIR'] / 'tests/fixtures/musdb-falcon69/README.md').is_file())
            before = (builder.OUT / 'airdox-stem-remote-worker.ipynb').read_bytes()
            with patch.dict(os.environ, {'AIRDOX_REQUIRE_EVIDENCE': '0', 'AIRDOX_EVIDENCE_DIR': str(Path(temporary) / 'empty')}):
                builder.main()
            self.assertEqual(before, (builder.OUT / 'airdox-stem-remote-worker.ipynb').read_bytes())
            with patch.dict(os.environ, {'AIRDOX_REQUIRE_EVIDENCE': '1', 'AIRDOX_EVIDENCE_DIR': str(Path(temporary) / 'empty')}):
                with self.assertRaises(FileNotFoundError):
                    builder.main()


if __name__ == '__main__':
    unittest.main(verbosity=2)
