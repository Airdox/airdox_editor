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
