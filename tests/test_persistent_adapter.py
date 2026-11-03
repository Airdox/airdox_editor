"""CPU-only lifecycle/protocol tests; no Torch, weights or GPU required."""
import contextlib
import importlib.util
import io
import json
import os
import queue
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest import mock
import wave


ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


worker = load("persistent_test_worker", ROOT / "colab/remote_worker.py")
batch = load("persistent_test_batch", ROOT / "colab/top200_batch.py")
adapter = load("persistent_test_adapter", ROOT / "python/bsroformer_inference.py")

DOUBLE = '''
import importlib.util, json, os, signal, sys, time, types, wave
from pathlib import Path
spec = importlib.util.spec_from_file_location("adapter", ADAPTER_PATH)
a = importlib.util.module_from_spec(spec)
spec.loader.exec_module(a)
sys.modules["torch"] = types.SimpleNamespace(__version__="cpu-double", version=types.SimpleNamespace(cuda=None))
counter = Path(__file__).with_suffix(".loads")
def build(*args):
    with counter.open("a") as f: f.write("load\\n")
    return object()
a.build_model = build
a.load_config_dict = lambda path: object()
a.load_checkpoint = lambda *args: "checkpoint"
def job(argv, session, model_id):
    args = a.parse_args(argv)
    session.get(args, "cpu", model_id)
    mode = Path(args.input).stem
    if mode in ("error", "oom"):
        raise RuntimeError("GPU_OUT_OF_MEMORY" if mode == "oom" else "per-job error")
    if mode == "silent":
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        Path(args.output_dir).mkdir(parents=True, exist_ok=True)
        Path(args.output_dir, "started").touch()
        while True: time.sleep(.01)
    Path(args.output_dir).mkdir(parents=True, exist_ok=True)
    for stem in args.stem_order.split(","):
        with wave.open(str(Path(args.output_dir, stem + ".wav")), "wb") as f:
            f.setnchannels(2); f.setsampwidth(2); f.setframerate(44100)
            f.writeframes(b"\\0" * 400)
    a.emit({"type":"done", "report":{"double":True}})
    return 0
a.main = job
sys.exit(a.serve())
'''


class LifecycleTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.double = self.base / "double.py"
        self.double.write_text("ADAPTER_PATH = " + repr(str(ROOT / "python/bsroformer_inference.py")) + "\n" + DOUBLE)
        (self.base / "model.ckpt").write_bytes(b"checkpoint")
        (self.base / "config.yaml").write_bytes(b"config")
        self.options = worker.parse_args([
            "--root", str(self.base / "store"), "--model-dir", str(self.base),
            "--work-dir", str(self.base / "work"), "--adapter", str(self.double),
            "--device", "cpu", "--cancel-poll", ".05", "--persistent-adapter",
        ])
        self.root = Path(self.options.root)
        self.session = self.options._adapter_session = worker.PersistentAdapter()
        self.addCleanup(self.session.close)

    def manifest(self, job_id="protocol-job", mode="mix"):
        manifest = worker._make_self_test_manifest(job_id, b"input")
        manifest["input"]["fileName"] = mode + ".wav"
        manifest["input"]["relativePath"] = f"jobs/{job_id}/input/{mode}.wav"
        manifest["engine"].update(config={"file": "config.yaml"}, checkpoint={"file": "model.ckpt"})
        return manifest

    def run_job(self, mode="mix", manifest=None):
        manifest = manifest or self.manifest(mode=mode)
        folder = self.root / "jobs" / manifest["jobId"]
        output = self.base / "output"
        folder.mkdir(parents=True, exist_ok=True)
        output.mkdir(exist_ok=True)
        command = worker._resolve_adapter_command(self.options, manifest["jobId"], manifest,
                                                  self.base / (mode + ".wav"), output)
        return worker._run_adapter(command, self.options, self.root, folder, manifest, {}, output)

    def loads(self):
        return len(self.double.with_suffix(".loads").read_text().splitlines())

    def test_two_jobs_one_load_runtime_and_shutdown(self):
        self.assertEqual(self.run_job()[0], 0)
        process = self.session.process
        self.assertEqual(self.run_job()[0], 0)
        self.assertIs(self.session.process, process)
        self.assertEqual(self.loads(), 1)
        worker._write_worker_status(self.root, self.options, "IDLE")
        status = worker.atomic_read_json(self.root / "worker.status.json")
        facts = status["capabilities"]["runtime"]
        self.assertEqual(facts["torchVersion"], "cpu-double")
        self.assertEqual(facts["checkpointSha256"], worker.sha256_file(self.base / "model.ckpt"))
        self.assertNotIn("gpuUtilization", facts)
        self.session.close()
        self.assertEqual(process.wait(timeout=3), 0)
        self.assertIsNone(self.session.runtime)

    def test_model_id_config_and_checkpoint_changes_reload(self):
        self.run_job()
        changed = self.manifest()
        changed["engine"]["modelId"] = "different-model"
        self.assertEqual(self.run_job(manifest=changed)[0], 0)
        (self.base / "config.yaml").write_bytes(b"new config")
        self.assertEqual(self.run_job(manifest=changed)[0], 0)
        (self.base / "model.ckpt").write_bytes(b"new checkpoint")
        self.assertEqual(self.run_job(manifest=changed)[0], 0)
        self.assertEqual(self.loads(), 4)

    def test_declared_hash_mismatch_rejects_before_load(self):
        manifest = self.manifest()
        manifest["engine"]["config"]["sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):
            self.run_job(manifest=manifest)
        self.assertFalse(self.double.with_suffix(".loads").exists())

    def test_job_errors_and_oom_discard_child_then_recover(self):
        for mode in ("error", "oom"):
            with self.subTest(mode=mode):
                code, output = self.run_job(mode)
                self.assertNotEqual(code, 0)
                self.assertIn("GPU_OUT_OF_MEMORY" if mode == "oom" else "per-job error", output)
                self.assertIsNone(self.session.process)
                self.assertEqual(self.run_job()[0], 0)
        self.assertEqual(self.loads(), 3)

    def test_silent_uncooperative_cancel_kills_before_next_job(self):
        folder = self.root / "jobs" / "protocol-job"
        stopped = threading.Event()

        def cancel_when_started():
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline and not stopped.wait(.02):
                if (self.base / "output/started").exists():
                    self.cancelled_process = self.session.process
                    (folder / "cancel.flag").touch()
                    return

        thread = threading.Thread(target=cancel_when_started, daemon=True)
        thread.start()
        try:
            with self.assertRaises(worker.WorkerCancelled):
                self.run_job("silent")
        finally:
            stopped.set()
            thread.join(timeout=2)
        self.assertIsNotNone(self.cancelled_process.poll())
        self.assertIsNone(self.session.process)
        (folder / "cancel.flag").unlink()
        self.assertEqual(self.run_job()[0], 0)

    def test_owner_eof_stops_silent_inference(self):
        command = worker._resolve_adapter_command(self.options, "protocol-job", self.manifest(),
                                                  self.base / "silent.wav", self.base / "output")
        process, lines, request = self.session.start_job(command, self.manifest())
        deadline = time.monotonic() + 10
        while not (self.base / "output/started").exists() and time.monotonic() < deadline:
            time.sleep(.02)
        self.assertTrue((self.base / "output/started").exists())
        process.stdin.close()
        self.assertEqual(process.wait(timeout=3), adapter.EXIT_CANCELLED)

    def test_server_rejects_model_change_without_owner_restart(self):
        self.run_job()
        process = self.session.process
        args = worker._resolve_adapter_command(self.options, "protocol-job", self.manifest(),
                                               self.base / "mix.wav", self.base / "output")[2:]
        process.stdin.write(json.dumps({"type": "run", "id": "changed", "modelId": "other", "argv": args,
                                        "artifacts": {"checkpoint": worker.sha256_file(self.base / "model.ckpt"),
                                                      "config": worker.sha256_file(self.base / "config.yaml")}}) + "\n")
        process.stdin.flush()
        seen = []
        while True:
            line = self.session.lines.get(timeout=5)
            if line is None:
                break
            seen.append(line)
        self.assertIn("MODEL_IDENTITY_CHANGED", "\n".join(seen))
        self.assertNotEqual(process.wait(timeout=3), 0)
        self.assertEqual(self.loads(), 1)

    def test_batch_reuses_worker_publishes_and_removes_staging(self):
        batch_id = "a" * 36
        (self.root / "batches").mkdir(parents=True)
        jobs = ["batch-job-one", "batch-job-two"]
        descriptor = self.root / "batches" / (batch_id + ".json")
        descriptor.write_text(json.dumps({"id": batch_id, "jobIds": jobs[:1], "uploadComplete": False}))
        for job_id in jobs:
            manifest = self.manifest(job_id)
            folder = self.root / "jobs" / job_id
            source = folder / "input/mix.wav"
            source.parent.mkdir(parents=True)
            source.write_bytes(b"input")
            worker.atomic_write_json(folder / "manifest.json", manifest)
        command = [sys.executable, str(ROOT / "colab/remote_worker.py"),
                   "--root", str(self.root), "--adapter", str(self.double),
                   "--model-dir", str(self.base), "--work-dir", str(self.base / "work"), "--device", "cpu"]
        def publish_next(seconds):
            self.assertEqual(self.loads(), 1)
            self.assertTrue((self.root / "jobs" / jobs[0] / "output/result.json").exists())
            descriptor.write_text(json.dumps({"id": batch_id, "jobIds": jobs, "uploadComplete": True}))

        with contextlib.redirect_stdout(io.StringIO()):
            result = batch.run_batch(self.root, batch_id, command, persistent=True, sleep=publish_next)
        self.assertEqual(result, dict.fromkeys(jobs, "COMPLETED"))
        self.assertEqual(self.loads(), 1)
        for job_id in jobs:
            self.assertFalse((self.base / "work" / job_id).exists())
            self.assertTrue((self.root / "jobs" / job_id / "output/result.json").exists())

    def test_actual_main_reuses_load_and_keeps_default_cli_serial(self):
        config = types.SimpleNamespace(
            audio=types.SimpleNamespace(sample_rate=44100),
            training=types.SimpleNamespace(instruments=["vocals"], target_instrument=None),
        )
        torch = types.SimpleNamespace(
            __version__="cpu-double", version=types.SimpleNamespace(cuda=None),
            cuda=types.SimpleNamespace(is_available=lambda: False, OutOfMemoryError=MemoryError),
        )
        mix = types.SimpleNamespace(shape=(2, 100))

        class Estimates:
            shape = (1, 2, 100)

            def __getitem__(self, index):
                return object()

        def infer(model, mix, args, *rest):
            args.inference_report = {"batchSizeRequested": args.batch_size}
            return Estimates(), 44100

        argv = worker._resolve_adapter_command(self.options, "protocol-job", self.manifest(),
                                               self.base / "mix.wav", self.base / "output")[2:]
        argv[argv.index("--stem-order") + 1] = "vocals"
        argv[argv.index("--stems") + 1] = "vocals"
        argv += ["--batch-size", "0"]
        with mock.patch.dict(sys.modules, {"torch": torch, "numpy": types.ModuleType("numpy")}), \
                mock.patch.object(adapter, "load_config_dict", return_value=config), \
                mock.patch.object(adapter, "build_model", return_value=object()) as build, \
                mock.patch.object(adapter, "load_checkpoint", return_value="checkpoint") as weights, \
                mock.patch.object(adapter, "read_audio", return_value=(mix, 44100, 100, mix)), \
                mock.patch.object(adapter, "write_audio"), \
                mock.patch.object(adapter, "run_inference", side_effect=infer), \
                contextlib.redirect_stdout(io.StringIO()):
            session = adapter.ModelSession()
            self.assertEqual(adapter.main(argv, session, "test-model"), 0)
            self.assertEqual(adapter.main(argv, session, "test-model"), 0)
            self.assertEqual(build.call_count, 1)
            self.assertEqual(weights.call_count, 1)
            self.assertEqual(adapter.main(argv), 0)
            self.assertEqual(adapter.main(argv), 0)
            self.assertEqual(build.call_count, 3)
            self.assertEqual(weights.call_count, 3)

    def test_bad_completion_or_eof_never_commits_and_discards_session(self):
        for events in ([{"type": "job_end", "id": "request", "exitCode": 0}],
                       [{"type": "done"}, {"type": "job_end", "id": "other", "exitCode": 0}],
                       [None]):
            with self.subTest(events=events):
                lines = queue.Queue()
                for event in events:
                    lines.put(None if event is None else json.dumps(event))
                process = types.SimpleNamespace(poll=lambda: None)
                fake = types.SimpleNamespace(
                    start_job=lambda *args: (process, lines, "request"), close=mock.Mock(),
                )
                self.options._adapter_session = fake
                folder = self.root / "jobs/protocol-job"
                folder.mkdir(parents=True, exist_ok=True)
                if events == [None]:
                    code, output = worker._run_adapter([], self.options, self.root, folder,
                                                       self.manifest(), {}, self.base / "output")
                    self.assertNotEqual(code, 0)
                else:
                    with self.assertRaises(RuntimeError):
                        worker._run_adapter([], self.options, self.root, folder,
                                            self.manifest(), {}, self.base / "output")
                fake.close.assert_called_once()

    def test_unconfirmed_kill_is_fatal_instead_of_starting_another_job(self):
        process = mock.Mock()
        process.poll.return_value = None
        process.wait.side_effect = subprocess.TimeoutExpired("double", 1)
        with self.assertRaises(worker.AdapterStopFailed):
            worker._terminate_process(process, .01)
        process.kill.assert_called_once()

    def test_expected_hashes_bind_server_to_owner_verified_content(self):
        args = adapter.parse_args(worker._resolve_adapter_command(
            self.options, "protocol-job", self.manifest(), self.base / "mix.wav", self.base / "output")[2:])
        session = adapter.ModelSession()
        session.expected_artifacts = {"checkpoint": "0" * 64, "config": "0" * 64}
        with mock.patch.object(adapter, "build_model") as build:
            with self.assertRaisesRegex(ValueError, "owner's verified hashes"):
                session.get(args, "cpu", "test-model")
            build.assert_not_called()


if __name__ == "__main__":
    unittest.main()
