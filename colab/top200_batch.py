"""Process only the job IDs of a published AirDox batch; safe to rerun."""
import json
import re
import subprocess
import shutil
import tempfile
import time
from pathlib import Path


def validate_model(manifest, catalog, expected_id=None):
    engine = manifest.get("engine", {})
    model_id = engine.get("modelId")
    if expected_id is not None and model_id != expected_id:
        raise ValueError("Editor model differs from the prepared worker; no model override allowed")
    model = next((entry for entry in catalog["models"] if entry["id"] == model_id), None)
    if not model or model.get("family") != "bs_roformer":
        raise ValueError("Editor model has no validated Colab adapter")
    if model.get("stemOrder") != ["drums", "bass", "other", "vocals"] or engine.get("stems") != model["stemOrder"]:
        raise ValueError("Editor model does not provide the required four stems")
    for kind in ("checkpoint", "config"):
        artifact = model.get(kind, {})
        declared = engine.get(kind, {})
        if not re.fullmatch(r"[a-f0-9]{64}", artifact.get("sha256", "")):
            raise ValueError("Model artifact has no verified checksum: " + kind)
        if any(declared.get(key) != artifact.get(key) for key in ("file", "url")):
            raise ValueError("Editor artifact differs from the catalog: " + kind)
        if kind == "checkpoint" and declared.get("sha256") != artifact["sha256"]:
            raise ValueError("Editor checkpoint checksum differs from the catalog")
        if declared.get("sha256") is not None and declared["sha256"] != artifact["sha256"]:
            raise ValueError("Editor artifact checksum differs from the catalog: " + kind)
    if engine.get("profile") not in model.get("qualityProfile", {}).get("serves", []):
        raise ValueError("Editor quality profile is not supported")
    return model


def run_batch(root, batch_id, command, runner=subprocess.run, catalog=None, monitor_gpu=False):
    if not re.fullmatch(r"[a-f0-9-]{36}", batch_id):
        raise ValueError("Invalid batch ID")
    root = Path(root)
    batch = json.loads((root / "batches" / (batch_id + ".json")).read_text(encoding="utf-8"))
    if batch.get("id") != batch_id or not isinstance(batch.get("jobIds"), list):
        raise ValueError("Invalid batch document")
    results = {}
    metrics_path = root / "batches" / (batch_id + ".metrics.json")
    try:
        metrics = json.loads(metrics_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        metrics = {}
    for job_id in dict.fromkeys(batch["jobIds"]):
        if not re.fullmatch(r"[A-Za-z0-9_-]{8,64}", job_id):
            raise ValueError("Invalid job ID")
        try:
            manifest_path = root / "jobs" / job_id / "manifest.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            if manifest["jobId"] != job_id:
                raise ValueError("Job identity mismatch")
            if catalog is not None:
                expected_id = command[command.index("--model") + 1]
                validate_model(manifest, catalog, expected_id)
            if manifest["status"] not in {"COMPLETED", "CANCELLED", "FAILED"}:
                started = time.monotonic()
                monitor = None
                worker_succeeded = False
                samples = tempfile.TemporaryFile(mode="w+t")
                try:
                    if monitor_gpu and shutil.which("nvidia-smi"):
                        monitor = subprocess.Popen(["nvidia-smi", "--query-gpu=utilization.gpu,memory.used", "--format=csv,noheader,nounits", "-l", "1"], stdout=samples, stderr=subprocess.DEVNULL)
                    runner(command + ["--job-id", job_id, "--once", "--max-jobs", "1"], check=True)
                    worker_succeeded = True
                finally:
                    if monitor is not None:
                        monitor.terminate()
                        try:
                            monitor.wait(timeout=5)
                        except subprocess.TimeoutExpired:
                            monitor.kill()
                            monitor.wait()
                    elapsed = time.monotonic() - started
                    samples.seek(0)
                    gpu_samples = []
                    for line in samples:
                        try:
                            gpu_samples.append([float(value.strip()) for value in line.split(",")])
                        except ValueError:
                            pass
                    samples.close()
                    audio_seconds = manifest.get("input", {}).get("durationSeconds", 0)
                    metrics[job_id] = {"modelId": manifest.get("engine", {}).get("modelId"), "workerSucceeded": worker_succeeded, "audioSeconds": audio_seconds, "workerWallSeconds": elapsed, "audioSecondsPerSecond": audio_seconds / elapsed if elapsed and worker_succeeded else None, "tracksPerHour": 3600 / elapsed if elapsed and worker_succeeded else None, "gpuSamples": len(gpu_samples), "gpuUtilizationMeanPercent": sum(sample[0] for sample in gpu_samples) / len(gpu_samples) if gpu_samples else None, "peakVramMiB": max((sample[1] for sample in gpu_samples), default=None)}
                    temporary = metrics_path.with_suffix(".tmp")
                    temporary.write_text(json.dumps(metrics, indent=2), encoding="utf-8")
                    temporary.replace(metrics_path)
                    print("Durchsatz (inkl. Modellstart und I/O):", metrics[job_id], flush=True)
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            results[job_id] = manifest["status"]
        except Exception as error:
            results[job_id] = str(error)
        print(job_id, results[job_id], flush=True)
    return results
