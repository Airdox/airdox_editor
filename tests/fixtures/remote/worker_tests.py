import copy
import json
import math
import os
from pathlib import Path
import struct
import sys
import tempfile
import threading
import time
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'colab'))
from remote_worker import (JobStore, LocalAdapterRunner, ProtocolError, _wav_geometry,
                           parse_args, run_job, safe_path, sha256_file, validate_manifest, answer_connection_probe, write_json_atomic)
from remote_setup import model, validate_engine


def wav():
    samples = b''.join(struct.pack('<ff', math.sin(i / 20) * .1, math.sin(i / 20) * .1) for i in range(4410))
    return b'RIFF' + struct.pack('<I', 36 + len(samples)) + b'WAVEfmt ' + struct.pack('<IHHIIHH', 16, 3, 2, 44100, 352800, 8, 32) + b'data' + struct.pack('<I', len(samples)) + samples


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.store = JobStore(str(self.root / 'drive'), 'test')
        self.job = str(uuid.uuid4())
        self.input = Path(self.store.job_dir(self.job)) / 'input/mix.wav'
        self.input.parent.mkdir(parents=True)
        self.input.write_bytes(wav())
        descriptor = model()
        self.manifest = dict(schemaVersion=1, jobId=self.job, status='RUNNING',
            input=dict(fileName='mix.wav', relativePath=f'jobs/{self.job}/input/mix.wav',
                       sha256=sha256_file(str(self.input)), bytes=self.input.stat().st_size, sampleRate=44100, channels=2, durationSeconds=.1),
            engine=dict(modelId=descriptor['id'], family=descriptor['family'], profile='HIGH_QUALITY',
                        checkpoint=descriptor['checkpoint'], config=descriptor['config'], stems=descriptor['stemOrder'],
                        chunkSizeSamples=131584, numOverlap=4, ensemblePasses=1), output=dict(stems=[]))
        self.store.write_manifest(self.job, self.manifest)
        os.environ.pop('AIRDOX_TEST_ADAPTER_MODE', None)

    def tearDown(self):
        os.environ.pop('AIRDOX_TEST_ADAPTER_MODE', None)
        self.temp.cleanup()

    def run_job(self, **kw):
        return run_job(self.store, self.job, self.store.read_manifest(self.job),
                       model_dir=str(self.root), device='cpu', adapter=str(Path(__file__).with_name('adapter.py')),
                       work_dir=str(self.root / 'work'), sync_timeout=kw.pop('sync_timeout', .1),
                       timeout=10, idle_timeout=kw.pop('idle_timeout', 3), heartbeat_interval=.01, **kw)

    def test_connection_nonce_and_expiry(self):
        request = Path(self.store.root) / 'connection/request.json'
        response = request.with_name('response.json')
        status = dict(id='test-worker', device='cpu', sourceCommit='revision')
        nonce = str(uuid.uuid4())
        payload = dict(schemaVersion=1, nonce=nonce, requestedAt=int(time.time() * 1000))
        write_json_atomic(str(request), payload)
        answer_connection_probe(self.store.root, status)
        result = json.loads(response.read_text())
        self.assertEqual(result['nonce'], nonce)
        self.assertEqual(result['sourceCommit'], 'revision')
        self.assertIn('does not independently', result['scope'])
        response.unlink()
        payload['requestedAt'] -= 700000
        write_json_atomic(str(request), payload)
        answer_connection_probe(self.store.root, status)
        self.assertFalse(response.exists())
        request.write_text('{partial')
        answer_connection_probe(self.store.root, status)
        self.assertFalse(response.exists())

    def test_cli_no_abbreviations(self):
        for args in (['--model', 'bad'], ['--profile', 'HIGH_QUALITY']):
            with self.assertRaises(SystemExit) as error:
                parse_args(args)
            self.assertEqual(error.exception.code, 2)
        self.assertEqual(parse_args(['--model-dir','ok']).model_dir, 'ok')

    def test_float_wav_and_production_filenames(self):
        self.assertEqual(_wav_geometry(str(self.input)), (4410, 44100, 2))
        before = sha256_file(str(self.input))
        self.assertEqual(self.run_job(), 'completed')
        result = self.store.read_manifest(self.job)
        self.assertEqual(len(result['output']['stems']), 4)
        self.assertTrue(Path(self.store.output_dir(self.job), 'result.json').is_file())
        self.assertEqual(sha256_file(str(self.input)), before)
        self.assertEqual(self.run_job(), 'skipped')
        self.assertEqual(result['attempts'], 1)

    def test_stderr_cannot_deadlock(self):
        os.environ['AIRDOX_TEST_ADAPTER_MODE'] = 'stderr'
        self.assertEqual(self.run_job(), 'completed')

    def test_silent_child_times_out(self):
        os.environ['AIRDOX_TEST_ADAPTER_MODE'] = 'silent'
        started = time.monotonic()
        self.assertEqual(self.run_job(idle_timeout=.3), 'failed')
        self.assertLess(time.monotonic() - started, 5)
        self.assertEqual(self.store.read_manifest(self.job)['error']['code'], 'REMOTE_INFERENCE_TIMEOUT')

    def test_cancel_during_inference(self):
        os.environ['AIRDOX_TEST_ADAPTER_MODE'] = 'silent'
        timer = threading.Timer(.4, lambda: Path(self.store.job_dir(self.job), 'cancel.flag').write_text('cancel'))
        timer.start()
        try:
            self.assertEqual(self.run_job(), 'cancelled')
            self.assertNotEqual(self.store.read_manifest(self.job)['status'], 'COMPLETED')
        finally:
            timer.join()

    def test_heartbeat_during_silent_inference(self):
        os.environ['AIRDOX_TEST_ADAPTER_MODE'] = 'silent'
        before = int(time.time() * 1000)
        self.run_job(idle_timeout=.5)
        claim = json.loads(Path(self.store.claim_path(self.job)).read_text())
        self.assertGreater(claim['heartbeatAt'], before + 200)

    def test_error_details_preserved(self):
        os.environ['AIRDOX_TEST_ADAPTER_MODE'] = 'error'
        self.assertEqual(self.run_job(), 'failed')
        self.assertEqual(self.store.read_manifest(self.job)['error']['code'], 'MODEL_CORRUPT')

    def test_done_required(self):
        os.environ['AIRDOX_TEST_ADAPTER_MODE'] = 'no-done'
        self.assertEqual(self.run_job(), 'failed')
        self.assertEqual(self.store.read_manifest(self.job)['error']['code'], 'REMOTE_OUTPUT_INCOMPLETE')

    def test_delayed_input(self):
        data = self.input.read_bytes()
        self.input.unlink()
        timer = threading.Timer(.2, lambda: self.input.write_bytes(data))
        timer.start()
        try:
            self.assertEqual(self.run_job(sync_timeout=2), 'completed')
        finally:
            timer.join()

    def test_missing_input_bounded(self):
        self.input.unlink()
        self.assertEqual(self.run_job(), 'failed')
        self.assertEqual(self.store.read_manifest(self.job)['error']['code'], 'REMOTE_INPUT_SYNC_TIMEOUT')

    def test_foreign_lease(self):
        JobStore(self.store.root, 'other').claim(self.job)
        self.assertEqual(self.run_job(), 'skipped')

    def test_preparing_not_claimed(self):
        self.manifest['status'] = 'PREPARING'
        self.store.write_manifest(self.job, self.manifest)
        self.assertEqual(self.run_job(), 'skipped')
        self.assertFalse(Path(self.store.claim_path(self.job)).exists())

    def test_path_validation(self):
        for path in ('../x', 'C:/x', '/abs', 'a/../../b', 'a\\b'):
            with self.assertRaises(ProtocolError):
                safe_path(str(self.root), path)
        self.manifest['input']['relativePath'] = 'jobs/another/input/mix.wav'
        with self.assertRaises(ProtocolError):
            validate_manifest(self.manifest, self.job)

    def test_model_contract(self):
        validate_engine(self.manifest['engine'])
        self.manifest['engine']['stems'] = ['vocals', 'drums', 'bass', 'other']
        with self.assertRaises(ProtocolError):
            validate_engine(self.manifest['engine'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
