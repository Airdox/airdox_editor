import hashlib
import json
import re
import tempfile
import urllib.request
from pathlib import Path


def sha256(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def select_batch_job(root, batch_id, retry_failed=False):
    root = Path(root)
    if not re.fullmatch(r'[a-f0-9-]{36}', batch_id):
        raise ValueError('BATCH_ID aus dem Editor eintragen.')
    path = root / 'batches' / (batch_id + '.json')
    if not path.is_file():
        raise RuntimeError('Stapeldatei fehlt: Drive-Sync abwarten und JOB_ORDNER prüfen.')
    batch = json.loads(path.read_text(encoding='utf-8'))
    if batch.get('id') != batch_id or not isinstance(batch.get('jobIds'), list):
        raise ValueError('Ungültige Stapeldatei oder abweichende Stapel-ID.')
    manifests = []
    missing = []
    for job_id in batch['jobIds']:
        if not isinstance(job_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{8,64}', job_id):
            raise ValueError('Ungültige Job-ID im Stapel.')
        path = root / 'jobs' / job_id / 'manifest.json'
        if not path.is_file():
            missing.append(job_id)
            continue
        manifest = json.loads(path.read_text(encoding='utf-8'))
        if manifest.get('jobId') != job_id:
            raise ValueError('Manifest-ID stimmt nicht mit Stapel-Job überein.')
        manifests.append(manifest)
    eligible = {'PENDING', 'PREPARING', 'RUNNING', 'RECONSTRUCTING', 'VALIDATING'}
    if retry_failed:
        eligible.add('FAILED')
    for manifest in manifests:
        if manifest.get('status') in eligible:
            return manifest
    if missing or batch.get('uploadComplete') is False:
        raise RuntimeError('Keine verfügbaren Jobs: Upload unvollständig. Editor geöffnet lassen, Drive-Sync abwarten und Setup erneut ausführen.')
    if any(m.get('status') == 'FAILED' for m in manifests):
        raise RuntimeError('Stapel enthält FAILED-Jobs: FEHLGESCHLAGENE_WIEDERHOLEN = True setzen und Setup erneut ausführen. IDs und fertige Ergebnisse bleiben erhalten.')
    if manifests and all(m.get('status') == 'COMPLETED' for m in manifests):
        raise RuntimeError('Stapel vollständig abgeschlossen. Import im Editor prüfen; keine Wiederholung erforderlich.')
    raise RuntimeError('Keine ausführbaren Jobs in diesem Stapel (leer oder abgebrochen). Stapelstatus im Editor prüfen.')


def prepare_model(manifest, catalog, model_dir, validate_model, download=urllib.request.urlretrieve):
    model = validate_model(manifest, catalog)
    artifacts = []
    for kind in ('checkpoint', 'config'):
        artifact = model.get(kind, {})
        name = artifact.get('file', '')
        if not name or Path(name).name != name or '\\' in name or name in {'.', '..'}:
            raise ValueError('Unsicherer Artefaktname: ' + kind)
        if not re.fullmatch(r'[a-f0-9]{64}', artifact.get('sha256', '')) or not artifact.get('url'):
            raise ValueError('Verifizierter Download fehlt: ' + kind)
        artifacts.append(artifact)
    directory = Path(model_dir)
    directory.mkdir(parents=True, exist_ok=True)
    for artifact in artifacts:
        target = directory / artifact['file']
        if target.is_file() and sha256(target) == artifact['sha256']:
            continue
        with tempfile.TemporaryDirectory(dir=directory) as staging:
            temporary = Path(staging) / artifact['file']
            download(artifact['url'], str(temporary))
            if not temporary.is_file() or sha256(temporary) != artifact['sha256']:
                raise RuntimeError('Download fehlt oder SHA256 stimmt nicht: ' + artifact['file'])
            temporary.replace(target)
    for artifact in artifacts:
        if sha256(directory / artifact['file']) != artifact['sha256']:
            raise RuntimeError('Modell nach Setup verändert: ' + artifact['file'])
    return model
