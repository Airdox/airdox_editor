import copy
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'colab'))
from batch_setup import prepare_model, select_batch_job
from top200_batch import validate_model


class BatchSetupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.batch = '01161650-f4bd-4e4e-81d2-e8d1406d324e'
        self.payload = {'checkpoint': b'weights', 'config': b'training: valid'}
        self.model = {'id': 'editor-model', 'family': 'bs_roformer', 'stemOrder': ['drums', 'bass', 'other', 'vocals'], 'qualityProfile': {'serves': ['HIGH_QUALITY']}}
        for kind, content in self.payload.items():
            self.model[kind] = {'file': kind, 'url': 'https://test/' + kind, 'sha256': hashlib.sha256(content).hexdigest()}
        self.catalog = {'models': [self.model]}
        self.manifest = {'jobId': 'failed-job', 'status': 'FAILED', 'engine': {'modelId': 'editor-model', 'profile': 'HIGH_QUALITY', 'stems': self.model['stemOrder'], 'checkpoint': copy.deepcopy(self.model['checkpoint']), 'config': copy.deepcopy(self.model['config'])}}

    def download(self, url, target):
        Path(target).write_bytes(self.payload[url.rsplit('/', 1)[-1]])

    def test_both_files_required_and_verified(self):
        prepare_model(self.manifest, self.catalog, self.root, validate_model, self.download)
        (self.root / 'config').unlink()
        prepare_model(self.manifest, self.catalog, self.root, validate_model, self.download)
        self.assertEqual((self.root / 'config').read_bytes(), self.payload['config'])
        self.assertEqual((self.root / 'checkpoint').read_bytes(), self.payload['checkpoint'])

    def test_bad_download_preserves_checkpoint(self):
        (self.root / 'checkpoint').write_bytes(self.payload['checkpoint'])
        for payload in (b'wrong', None):
            def bad_download(url, target):
                if payload is not None:
                    Path(target).write_bytes(payload)
            with self.assertRaises(RuntimeError):
                prepare_model(self.manifest, self.catalog, self.root, validate_model, bad_download)
            self.assertEqual((self.root / 'checkpoint').read_bytes(), self.payload['checkpoint'])
            self.assertFalse((self.root / 'config').exists())

    def test_manifest_artifact_mismatch_and_missing_config(self):
        for kind in ('checkpoint', 'config'):
            altered = copy.deepcopy(self.manifest)
            altered['engine'][kind]['url'] += '/wrong'
            with self.assertRaises(ValueError):
                prepare_model(altered, self.catalog, self.root, validate_model, self.download)
        catalog = copy.deepcopy(self.catalog)
        del catalog['models'][0]['config']
        with self.assertRaises(ValueError):
            prepare_model(self.manifest, catalog, self.root, validate_model, self.download)
        self.assertFalse((self.root / 'checkpoint').exists())

    def publish(self, statuses):
        (self.root / 'batches').mkdir(exist_ok=True)
        for job, status in statuses.items():
            folder = self.root / 'jobs' / job
            folder.mkdir(parents=True, exist_ok=True)
            manifest = dict(self.manifest, jobId=job, status=status)
            (folder / 'manifest.json').write_text(json.dumps(manifest))
        (self.root / 'batches' / (self.batch + '.json')).write_text(json.dumps({'id': self.batch, 'uploadComplete': True, 'jobIds': list(statuses)}))

    def test_zero_open_failed_selection_scoped_without_reset(self):
        self.publish({'done-job': 'COMPLETED', 'failed-job': 'FAILED', 'cancelled-job': 'CANCELLED'})
        checkpoint = self.root / 'batches' / (self.batch + '.checkpoint.json')
        checkpoint.write_bytes(b'preserved checkpoint')
        unrelated = self.root / 'jobs' / 'outside-job'
        unrelated.mkdir()
        (unrelated / 'manifest.json').write_text(json.dumps(dict(self.manifest, jobId='outside-job', status='PENDING')))
        before = {p: p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        with self.assertRaisesRegex(RuntimeError, 'FAILED'):
            select_batch_job(self.root, self.batch)
        self.assertEqual(select_batch_job(self.root, self.batch, retry_failed=True)['jobId'], 'failed-job')
        self.assertEqual(before, {p: p.read_bytes() for p in before})

    def test_complete_and_cancelled_actionable(self):
        self.publish({'done-job': 'COMPLETED'})
        with self.assertRaisesRegex(RuntimeError, 'abgeschlossen'):
            select_batch_job(self.root, self.batch, True)
        self.publish({'cancelled-job': 'CANCELLED'})
        with self.assertRaisesRegex(RuntimeError, 'abgebrochen'):
            select_batch_job(self.root, self.batch, True)


if __name__ == '__main__':
    unittest.main()
