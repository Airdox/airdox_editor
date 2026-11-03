"""Progressive batch publication with protocol doubles and a virtual clock."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock


spec = importlib.util.spec_from_file_location("progressive_batch", Path(__file__).parents[1] / "colab/top200_batch.py")
batch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(batch)


class ProgressiveBatchTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.batch_id = "a" * 36
        (self.root / "batches").mkdir()
        self.descriptor = self.root / "batches" / (self.batch_id + ".json")
        self.calls = []
        self.clock = 0
        self.waits = []
        self.stdout = contextlib.redirect_stdout(io.StringIO())
        self.stdout.__enter__()
        self.addCleanup(self.stdout.__exit__, None, None, None)

    def jobs(self, count):
        ids = [f"track-job-{index:03}" for index in range(count)]
        for job_id in ids:
            folder = self.root / "jobs" / job_id
            folder.mkdir(parents=True, exist_ok=True)
            (folder / "manifest.json").write_text(json.dumps({"jobId": job_id, "status": "PENDING"}))
        return ids

    def publish(self, ids, complete=False):
        self.descriptor.write_text(json.dumps({"id": self.batch_id, "jobIds": ids, "uploadComplete": complete}))

    def saved(self, suffix):
        return json.loads(self.descriptor.with_suffix(suffix).read_text())

    def runner(self, command, check):
        job_id = command[command.index("--job-id") + 1]
        if self.calls:
            self.assertEqual(self.saved(".outcomes.json")[self.calls[-1]], "COMPLETED")
        self.calls.append(job_id)
        folder = self.root / "jobs" / job_id
        (folder / "output").mkdir(exist_ok=True)
        (folder / "output" / "vocals.wav").write_bytes(b"finished stem")
        (folder / "manifest.json").write_text(json.dumps({"jobId": job_id, "status": "COMPLETED"}))

    def sleep(self, seconds):
        self.waits.append(seconds)
        self.clock += seconds

    def run_batch(self, **kwargs):
        options = {"sleep": self.sleep, "monotonic": lambda: self.clock, "poll_interval": 2, "idle_timeout": 6}
        options.update(kwargs)
        return batch.run_batch(self.root, self.batch_id, ["worker"], self.runner, **options)

    def test_initial_ten_finish_before_growth_to_200_and_each_ten_checkpoint(self):
        ids = self.jobs(200)
        self.publish(ids[:10] + ids[:2])
        checkpoints = []
        atomic_write = batch._atomic_batch_json

        def record(path, value):
            if path.suffixes[-2:] == [".checkpoint", ".json"]:
                checkpoints.append((value["processedJobs"], value["state"]))
            atomic_write(path, value)

        def grow(seconds):
            self.assertEqual(self.calls, ids[:10])
            self.assertEqual(self.saved(".outcomes.json"), dict.fromkeys(ids[:10], "COMPLETED"))
            self.assertEqual(self.saved(".checkpoint.json")["processedJobs"], 10)
            self.sleep(seconds)
            self.publish(ids + ids[:10], complete=True)

        with mock.patch.object(batch, "_atomic_batch_json", side_effect=record):
            results = self.run_batch(sleep=grow)
        self.assertEqual(results, dict.fromkeys(ids, "COMPLETED"))
        self.assertEqual(self.calls, ids)
        self.assertEqual(self.waits, [2])
        self.assertEqual([count for count, state in checkpoints if state == "processing"], list(range(10, 201, 10)))
        self.assertEqual(checkpoints[-1], (200, "complete"))

    def test_timeout_preserves_finished_stems_and_can_resume(self):
        ids = self.jobs(10)
        self.publish(ids)
        with self.assertRaisesRegex(TimeoutError, "no new job IDs for 6s.*uploadComplete=false"):
            self.run_batch()
        self.assertEqual(self.saved(".outcomes.json"), dict.fromkeys(ids, "COMPLETED"))
        self.assertEqual(self.saved(".checkpoint.json")["state"], "timeout")
        self.assertEqual(self.waits, [2, 2, 2])
        for job_id in ids:
            self.assertEqual((self.root / "jobs" / job_id / "output/vocals.wav").read_bytes(), b"finished stem")
        self.publish(ids, complete=True)
        self.assertEqual(self.run_batch(), dict.fromkeys(ids, "COMPLETED"))
        self.assertEqual(self.calls, ids)

    def test_interruption_while_waiting_preserves_outcomes_and_checkpoint(self):
        ids = self.jobs(10)
        self.publish(ids)

        def interrupt(seconds):
            raise KeyboardInterrupt()

        with self.assertRaises(KeyboardInterrupt):
            self.run_batch(sleep=interrupt)
        self.assertEqual(self.saved(".outcomes.json"), dict.fromkeys(ids, "COMPLETED"))
        self.assertEqual(self.saved(".checkpoint.json")["state"], "interrupted")
        self.assertTrue((self.root / "jobs" / ids[-1] / "output/vocals.wav").exists())

    def test_interruption_during_next_job_preserves_previous_results(self):
        ids = self.jobs(2)
        self.publish(ids, complete=True)
        run = self.runner

        def interrupt(command, check):
            if len(self.calls) == 1:
                raise KeyboardInterrupt()
            run(command, check)

        with self.assertRaises(KeyboardInterrupt):
            batch.run_batch(self.root, self.batch_id, ["worker"], interrupt)
        self.assertEqual(self.saved(".outcomes.json"), {ids[0]: "COMPLETED"})
        self.assertEqual(self.saved(".checkpoint.json")["state"], "interrupted")
        self.assertTrue((self.root / "jobs" / ids[0] / "output/vocals.wav").exists())

    def test_legacy_absent_upload_complete_finishes_without_sleep_or_reload(self):
        ids = self.jobs(2)
        self.descriptor.write_text(json.dumps({"id": self.batch_id, "jobIds": ids + ids}))
        reload = mock.Mock(side_effect=batch._load_batch)
        self.assertEqual(self.run_batch(reload_batch=reload), dict.fromkeys(ids, "COMPLETED"))
        reload.assert_called_once_with(self.descriptor)
        self.assertEqual(self.waits, [])
        self.assertEqual(self.calls, ids)

    def test_per_job_error_isolated_and_not_retried_on_descriptor_growth(self):
        ids = self.jobs(3)
        self.publish(ids[:2])
        called = []

        def runner(command, check):
            job_id = command[command.index("--job-id") + 1]
            called.append(job_id)
            if job_id == ids[0]:
                raise RuntimeError("isolated failure")
            folder = self.root / "jobs" / job_id
            (folder / "manifest.json").write_text(json.dumps({"jobId": job_id, "status": "COMPLETED"}))

        def grow(seconds):
            self.assertEqual(called, ids[:2])
            self.sleep(seconds)
            self.publish(ids + ids, complete=True)

        result = batch.run_batch(self.root, self.batch_id, ["worker"], runner,
                                 sleep=grow, monotonic=lambda: self.clock)
        self.assertEqual(called, ids)
        self.assertEqual(result[ids[0]], "isolated failure")
        self.assertEqual(result[ids[1]], "COMPLETED")
        self.assertEqual(result[ids[2]], "COMPLETED")
        self.assertFalse(self.saved(".metrics.json")[ids[0]]["workerSucceeded"])

    def test_transient_unreadable_descriptor_recovers_without_duplicate_jobs(self):
        ids = self.jobs(2)
        self.publish(ids[:1])
        reloads = 0

        def reload(path):
            nonlocal reloads
            reloads += 1
            if reloads == 2:
                raise json.JSONDecodeError("incomplete Drive update", "", 0)
            return batch._load_batch(path)

        def grow(seconds):
            self.sleep(seconds)
            self.publish(ids, complete=True)

        result = self.run_batch(sleep=grow, reload_batch=reload)
        self.assertEqual(result, dict.fromkeys(ids, "COMPLETED"))
        self.assertEqual(self.calls, ids)

    def test_repeated_descriptor_errors_have_bounded_timeout(self):
        ids = self.jobs(1)
        self.publish(ids)
        initial = batch._load_batch(self.descriptor)
        reads = 0

        def reload(path):
            nonlocal reads
            reads += 1
            if reads == 1:
                return initial
            raise OSError("Drive unavailable")

        with self.assertRaisesRegex(TimeoutError, "Last descriptor error: Drive unavailable"):
            self.run_batch(reload_batch=reload)
        self.assertEqual(self.clock, 6)
        self.assertEqual(self.saved(".outcomes.json"), dict.fromkeys(ids, "COMPLETED"))


if __name__ == "__main__":
    unittest.main()
