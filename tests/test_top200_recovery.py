import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("batch", Path(__file__).parents[1] / "colab" / "top200_batch.py")
batch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(batch)


class RecoveryTest(unittest.TestCase):
    def test_scoped_retry_requires_verified_setup_and_preserves_completed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "batches").mkdir()
            models = root / "models"
            models.mkdir()
            model = {"id": "editor-model", "family": "bs_roformer", "stemOrder": ["drums", "bass", "other", "vocals"], "qualityProfile": {"serves": ["HIGH_QUALITY"]}}
            for kind in ("checkpoint", "config"):
                data = kind.encode()
                model[kind] = {"file": kind + ".bin", "url": "https://example.invalid/" + kind, "sha256": hashlib.sha256(data).hexdigest()}
                if kind != "config":
                    (models / model[kind]["file"]).write_bytes(data)
            catalog = {"models": [model]}
            identifier = "a" * 36
            ids = ["already-completed", "failed-configuration"]
            (root / "batches" / (identifier + ".json")).write_text(json.dumps({"id": identifier, "jobIds": ids}))
            for job_id, status in zip(ids, ["COMPLETED", "FAILED"]):
                folder = root / "jobs" / job_id
                folder.mkdir(parents=True)
                (folder / "manifest.json").write_text(json.dumps({"jobId": job_id, "status": status, "engine": {"modelId": model["id"], "stems": model["stemOrder"], "profile": "HIGH_QUALITY", "checkpoint": model["checkpoint"], "config": model["config"]}}))
            before = (root / "jobs" / ids[0] / "manifest.json").read_bytes()
            calls = []
            def runner(command, check):
                self.assertIn("--retry-failed", command)
                job_id = command[command.index("--job-id") + 1]
                calls.append(job_id)
                filename = root / "jobs" / job_id / "manifest.json"
                document = json.loads(filename.read_text())
                document["status"] = "COMPLETED"
                filename.write_text(json.dumps(document))
            command = ["python", "worker", "--model", model["id"], "--model-dir", str(models)]
            batch.run_batch(root, identifier, command, runner, catalog, retry_failed=True)
            self.assertEqual(calls, [])
            self.assertEqual(json.loads((root / "jobs" / ids[1] / "manifest.json").read_text())["status"], "FAILED")
            (models / model["config"]["file"]).write_bytes(b"wrong")
            batch.run_batch(root, identifier, command, runner, catalog, retry_failed=True)
            self.assertEqual(calls, [])
            (models / model["config"]["file"]).write_bytes(b"config")
            batch.run_batch(root, identifier, command, runner, catalog, retry_failed=True)
            self.assertEqual(calls, [ids[1]])
            self.assertEqual((root / "jobs" / ids[0] / "manifest.json").read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
