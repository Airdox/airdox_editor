#!/usr/bin/env python3
"""Real local worker inference before any Drive import or Google authorization.

Uses the bundled, attributed music fixture, not user files. Produces evidence,
not a claim that Google Drive or a particular user account was tested.
"""
import argparse
from datetime import datetime, timezone
import importlib.metadata
import json
from pathlib import Path
import platform
import tempfile
import time
import uuid

from remote_setup import ROOT, model, preflight
from remote_worker import JobStore, run_job, sha256_file


def execute(model_dir, device, report_path):
    import numpy as np
    import soundfile as sf
    from scipy.signal import resample_poly
    descriptor = model()
    adapter = ROOT / 'python/bsroformer_inference.py'
    health = preflight(model_dir, str(adapter), device)
    fixture = ROOT / 'tests/fixtures/musdb-falcon69/mixture.wav'
    fixture_hash = sha256_file(str(fixture))
    bundle = json.loads((ROOT / 'bundle.json').read_text()) if (ROOT / 'bundle.json').is_file() else {}
    started = datetime.now(timezone.utc).isoformat()
    reports = []
    with tempfile.TemporaryDirectory(prefix='airdox-preauth-') as temporary:
        base = Path(temporary)
        for rate in (44100, 48000):
            audio, source_rate = sf.read(fixture, frames=88200, dtype='float32', always_2d=True)
            from math import gcd
            divisor = gcd(rate, source_rate)
            audio = resample_poly(audio, rate // divisor, source_rate // divisor, axis=0)
            job_id = str(uuid.uuid4())
            store = JobStore(str(base / f'jobs-{rate}'), 'preauth-real-model-check')
            source = Path(store.job_dir(job_id)) / 'input' / 'music.wav'
            source.parent.mkdir(parents=True)
            sf.write(source, audio, rate, subtype='FLOAT')
            before = sha256_file(str(source))
            manifest = dict(schemaVersion=1, jobId=job_id, status='RUNNING',
                input=dict(fileName=source.name, relativePath=f'jobs/{job_id}/input/{source.name}',
                           sha256=before, bytes=source.stat().st_size, sampleRate=rate,
                           channels=audio.shape[1], durationSeconds=len(audio) / rate),
                engine=dict(modelId=descriptor['id'], family=descriptor['family'], profile='HIGH_QUALITY',
                            stems=descriptor['stemOrder'], checkpoint=descriptor['checkpoint'], config=descriptor['config'],
                            chunkSizeSamples=descriptor['chunkSizeSamples'], numOverlap=4, ensemblePasses=1),
                output=dict(stems=[]))
            store.write_manifest(job_id, manifest)
            start = time.monotonic()
            result = run_job(store, job_id, manifest, model_dir=model_dir, device=health['device'],
                             adapter=str(adapter), work_dir=str(base / 'work'), timeout=900, idle_timeout=300)
            if result != 'completed':
                raise RuntimeError(f'Pre-auth model test failed: {store.read_manifest(job_id).get("error")}')
            done = store.read_manifest(job_id)
            outputs = []
            for stem in done['output']['stems']:
                filename = Path(store.root) / stem['relativePath']
                samples, actual_rate = sf.read(filename, dtype='float32', always_2d=True)
                if actual_rate != rate or samples.shape != audio.shape or not np.isfinite(samples).all() or np.max(np.abs(samples)) <= 0:
                    raise RuntimeError(f'Invalid output geometry/values: {stem["id"]}')
                digest = sha256_file(str(filename))
                if digest != stem['sha256']:
                    raise RuntimeError('Output hash mismatch')
                outputs.append(dict(id=stem['id'], sha256=digest, frames=len(samples), channels=samples.shape[1], sampleRate=rate))
            if sha256_file(str(source)) != before:
                raise RuntimeError('Input changed')
            reports.append(dict(sampleRate=rate, inputSha256=before, originalUnchanged=True,
                                device=done['worker'].get('device'), cpuFallback=done['worker'].get('cpuFallback', False),
                                durationMs=round((time.monotonic() - start) * 1000), outputs=outputs))
    if sha256_file(str(fixture)) != fixture_hash:
        raise RuntimeError('Bundled fixture changed')
    result = dict(schemaVersion=1, result='PASS', state='AUTH_REQUIRED',
                  sourceCommit=bundle.get('sourceRevision'), appVersion=bundle.get('appVersion'),
                  startedAt=started, finishedAt=datetime.now(timezone.utc).isoformat(),
                  googleAuthentication='NOT_ATTEMPTED', googleDriveTested=False,
                  fixtureSha256=fixture_hash, environment=dict(python=platform.python_version(), platform=platform.system(), **health),
                  packages={name: importlib.metadata.version(name) for name in ('torch', 'torchaudio', 'msst', 'numpy', 'soundfile', 'scipy')},
                  tests=reports)
    Path(report_path).parent.mkdir(parents=True, exist_ok=True)
    Path(report_path).write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print('AUTH_REQUIRED: Paket und echter Modelllauf geprüft. Noch kein Google-/Drive-Zugriff.', flush=True)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument('--model-dir', required=True)
    parser.add_argument('--device', default='auto', choices=['auto', 'cpu', 'cuda'])
    parser.add_argument('--report', required=True)
    args = parser.parse_args()
    try:
        execute(args.model_dir, args.device, args.report)
    except Exception as error:
        Path(args.report).parent.mkdir(parents=True, exist_ok=True)
        Path(args.report).write_text(json.dumps(dict(result='FAIL', state='PREPARATION_FAILED', error=str(error), googleAuthentication='NOT_ATTEMPTED'), indent=2), encoding='utf-8')
        raise
