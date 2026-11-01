import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("batch", Path(__file__).parents[1] / "colab" / "top200_batch.py")
batch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(batch)


class BatchTest(unittest.TestCase):
    def test_editor_model_is_authoritative(self):
        import copy
        catalog = json.loads((Path(__file__).parents[1] / "src" / "stems" / "modelCatalog.json").read_text())
        model = catalog["models"][0]
        engine = {"modelId": model["id"], "stems": model["stemOrder"], "profile": "HIGH_QUALITY", "checkpoint": model["checkpoint"], "config": model["config"]}
        self.assertEqual(batch.validate_model({"engine": engine}, catalog)["id"], model["id"])
        with self.assertRaises(ValueError):
            batch.validate_model({"engine": engine}, catalog, "different-model")
        for change in ({"stems": ["vocals", "other"]}, {"modelId": "bsroformer-viperx-vocals-1297"}, {"profile": "UNSUPPORTED"}, {"checkpoint": {**engine["checkpoint"], "sha256": "0" * 64}}, {"config": {**engine["config"], "file": "wrong.yaml"}}):
            with self.assertRaises(ValueError):
                batch.validate_model({"engine": {**copy.deepcopy(engine), **change}}, catalog)

    def test_scoped_resume_and_error_isolation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            batch_id = "a" * 36
            (root / "batches").mkdir()
            jobs = ["completed-job", "pending-job1", "pending-job2"]
            (root / "batches" / (batch_id + ".json")).write_text(json.dumps({"id": batch_id, "jobIds": jobs}))
            for index, job_id in enumerate(jobs):
                folder = root / "jobs" / job_id
                folder.mkdir(parents=True)
                (folder / "manifest.json").write_text(json.dumps({"jobId": job_id, "status": "COMPLETED" if index == 0 else "PENDING"}))
            calls = []

            def runner(command, check):
                job_id = command[command.index("--job-id") + 1]
                calls.append(job_id)
                if job_id == "pending-job1":
                    raise RuntimeError("GPU failure")
                (root / "jobs" / job_id / "manifest.json").write_text(json.dumps({"jobId": job_id, "status": "COMPLETED"}))

            result = batch.run_batch(root, batch_id, ["worker"], runner)
            self.assertEqual(calls, jobs[1:])
            self.assertEqual(result[jobs[0]], "COMPLETED")
            self.assertEqual(result[jobs[2]], "COMPLETED")
            self.assertIn("GPU failure", result[jobs[1]])
            metrics = json.loads((root / "batches" / (batch_id + ".metrics.json")).read_text())
            self.assertFalse(metrics[jobs[1]]["workerSucceeded"])
            self.assertIsNone(metrics[jobs[1]]["tracksPerHour"])
            self.assertTrue(metrics[jobs[2]]["workerSucceeded"])
            self.assertGreaterEqual(metrics[jobs[2]]["workerWallSeconds"], 0)
            if metrics[jobs[2]]["workerWallSeconds"] == 0:
                self.assertIsNone(metrics[jobs[2]]["tracksPerHour"])
            self.assertIsNone(metrics[jobs[2]]["gpuUtilizationMeanPercent"])


if __name__ == "__main__":
    unittest.main()
