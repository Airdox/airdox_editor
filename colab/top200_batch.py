"""Process only the job IDs of a published AirDox batch; safe to rerun."""
import json
import re
import subprocess
import shutil
import tempfile
import time
import importlib.util
import sys
import os
import math
import hashlib
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


def _atomic_batch_json(path, value):
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                         prefix="." + path.name, suffix=".tmp", delete=False) as handle:
            temporary = Path(handle.name)
            json.dump(value, handle, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def _load_batch(path):
    return json.loads(path.read_text(encoding="utf-8"))


def _validate_batch(document, batch_id):
    if not isinstance(document, dict) or document.get("id") != batch_id or not isinstance(document.get("jobIds"), list):
        raise ValueError("Invalid batch document")
    for job_id in document["jobIds"]:
        if not isinstance(job_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{8,64}", job_id):
            raise ValueError("Invalid job ID")
    return document


def run_batch(root, batch_id, command, runner=subprocess.run, catalog=None, monitor_gpu=False, persistent=False,
              *, idle_timeout=900, poll_interval=5, sleep=time.sleep, monotonic=time.monotonic, reload_batch=None, retry_failed=False):
    """Opt in to one local worker/adapter for this bounded list of jobs.

    The default subprocess runner and single-job CLI remain unchanged. Persistent
    mode requires this checkout's worker; custom runners retain the old contract.
    Explicit uploadComplete=false follows appended IDs until finalized, with a
    bounded idle wait. Missing uploadComplete means a finished legacy upload.
    Outcomes are saved per job and checkpoints every ten jobs and on exit.
    reload_batch(path), sleep(seconds), and monotonic() can be injected for tests.
    """
    if persistent:
        worker_path = Path(__file__).with_name("remote_worker.py").resolve()
        if runner is not subprocess.run or len(command) < 2 or Path(command[1]).resolve() != worker_path:
            raise ValueError("Persistent batch requires the bundled Python remote_worker command")
        interpreter = Path(shutil.which(command[0]) or command[0]).resolve()
        if interpreter != Path(sys.executable).resolve():
            raise ValueError("Persistent batch must run in the worker's requested Python interpreter")
        spec = importlib.util.spec_from_file_location("airdox_batch_remote_worker", worker_path)
        worker = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(worker)
        session = worker.PersistentAdapter()

        def local_runner(job_command, check):
            options = worker.parse_args(job_command[2:])
            options.persistent_adapter = True
            options._adapter_session = session
            if Path(options.root).resolve() != Path(root).resolve():
                raise ValueError("Batch and worker stores differ")
            counts = worker.run_worker_cycle(options, Path(root))
            if counts["failed"]:
                raise subprocess.CalledProcessError(1, job_command)

        try:
            return run_batch(root, batch_id, command, local_runner, catalog, monitor_gpu,
                             idle_timeout=idle_timeout, poll_interval=poll_interval,
                             sleep=sleep, monotonic=monotonic, reload_batch=reload_batch, retry_failed=retry_failed)
        finally:
            session.close()
    if not re.fullmatch(r"[a-f0-9-]{36}", batch_id):
        raise ValueError("Invalid batch ID")
    if not math.isfinite(idle_timeout) or idle_timeout <= 0 or not math.isfinite(poll_interval) or poll_interval <= 0:
        raise ValueError("idle_timeout and poll_interval must be finite and positive")
    root = Path(root)
    descriptor_path = root / "batches" / (batch_id + ".json")
    reload_batch = reload_batch or _load_batch
    document = _validate_batch(reload_batch(descriptor_path), batch_id)
    outcomes_path = descriptor_path.with_suffix(".outcomes.json")
    checkpoint_path = descriptor_path.with_suffix(".checkpoint.json")
    try:
        results = _load_batch(outcomes_path)
        if not isinstance(results, dict) or any(not isinstance(key, str) or not isinstance(value, str) for key, value in results.items()):
            results = {}
    except (OSError, ValueError):
        results = {}
    metrics_path = root / "batches" / (batch_id + ".metrics.json")
    try:
        metrics = json.loads(metrics_path.read_text(encoding="utf-8"))
        if not isinstance(metrics, dict):
            metrics = {}
    except (OSError, ValueError):
        metrics = {}
    seen = set()
    processed = 0
    reason = "complete"

    def checkpoint(state):
        _atomic_batch_json(checkpoint_path, {"schemaVersion": 1, "batchId": batch_id,
                                           "processedJobs": processed, "results": results,
                                           "state": state, "updatedAt": int(time.time() * 1000)})

    try:
        while True:
            for job_id in dict.fromkeys(document["jobIds"]):
                if job_id in seen:
                    continue
                try:
                    results[job_id] = _run_batch_job(root, job_id, command, runner, catalog,
                                                     monitor_gpu, metrics_path, metrics, retry_failed)
                except Exception as error:
                    results[job_id] = str(error)
                seen.add(job_id)
                processed += 1
                _atomic_batch_json(outcomes_path, results)
                if processed % 10 == 0:
                    checkpoint("processing")
                print(job_id, results[job_id], flush=True)
            if document.get("uploadComplete") is not False:
                return results
            idle_started = monotonic()
            reload_error = None
            while True:
                try:
                    updated = _validate_batch(reload_batch(descriptor_path), batch_id)
                except (OSError, ValueError) as error:
                    reload_error = str(error)
                else:
                    reload_error = None
                    document = updated
                    if any(job_id not in seen for job_id in document["jobIds"]) or document.get("uploadComplete") is not False:
                        break
                remaining = idle_timeout - (monotonic() - idle_started)
                if remaining <= 0:
                    detail = f" Last descriptor error: {reload_error}" if reload_error else ""
                    raise TimeoutError(f"Batch {batch_id}: no new job IDs for {idle_timeout:g}s while uploadComplete=false. "
                                       f"Finished outcomes saved in {outcomes_path}.{detail}")
                sleep(min(poll_interval, remaining, 60))
    except BaseException as error:
        reason = "timeout" if isinstance(error, TimeoutError) else "interrupted" if isinstance(error, KeyboardInterrupt) else "error"
        raise
    finally:
        _atomic_batch_json(outcomes_path, results)
        checkpoint(reason)


def verify_model_files(manifest, catalog, command):
    model = validate_model(manifest, catalog, command[command.index("--model") + 1])
    directory = Path(command[command.index("--model-dir") + 1])
    for kind in ("checkpoint", "config"):
        artifact = model[kind]
        filename = directory / Path(artifact["file"]).name
        digest = hashlib.sha256()
        with filename.open("rb") as handle:
            for block in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(block)
        if digest.hexdigest() != artifact["sha256"]:
            raise ValueError("Model setup checksum mismatch: " + kind)


def _run_batch_job(root, job_id, command, runner, catalog, monitor_gpu, metrics_path, metrics, retry_failed=False):
    manifest_path = root / "jobs" / job_id / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest["jobId"] != job_id:
        raise ValueError("Job identity mismatch")
    if catalog is not None:
        expected_id = command[command.index("--model") + 1]
        validate_model(manifest, catalog, expected_id)
    retry = retry_failed and manifest["status"] == "FAILED"
    if retry:
        if catalog is None:
            raise ValueError("Failed-job recovery requires the verified editor model catalog")
        verify_model_files(manifest, catalog, command)
    if manifest["status"] not in {"COMPLETED", "CANCELLED", "FAILED"} or retry:
        started = time.monotonic()
        monitor = None
        worker_succeeded = False
        samples = tempfile.TemporaryFile(mode="w+t")
        try:
            if monitor_gpu and shutil.which("nvidia-smi"):
                monitor = subprocess.Popen(["nvidia-smi", "--query-gpu=utilization.gpu,memory.used", "--format=csv,noheader,nounits", "-l", "1"], stdout=samples, stderr=subprocess.DEVNULL)
            runner(command + ["--job-id", job_id, "--once", "--max-jobs", "1"] + (["--retry-failed"] if retry else []), check=True)
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
            _atomic_batch_json(metrics_path, metrics)
            print("Durchsatz (inkl. Modellstart und I/O):", metrics[job_id], flush=True)
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    return manifest["status"]
