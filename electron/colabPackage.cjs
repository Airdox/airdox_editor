// Fixed packaged resources only. No renderer-controlled URLs/commands/paths.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

async function verifyColabPackage(folder) {
  const root = await fs.realpath(folder);
  const proof = JSON.parse(await fs.readFile(path.join(root, 'PREAUTH_NACHWEIS.json'), 'utf8'));
  const bundle = JSON.parse(await fs.readFile(path.join(root, 'bundle.json'), 'utf8'));
  if (proof.schemaVersion !== 1 || proof.sourceCommit !== bundle.sourceRevision || !proof.files || Object.keys(proof.files).length < 5) {
    throw new Error('Paketnachweis unvollständig oder falsche Revision.');
  }
  for (const [name, expected] of Object.entries(proof.files)) {
    if (typeof name !== 'string' || name.includes('\\') || name.includes(':') || name.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('Unsicherer Nachweispfad');
    const file = await fs.realpath(path.join(root, name));
    if (!file.startsWith(root + path.sep)) throw new Error('Nachweispfad verlässt das Paket');
    const data = await fs.readFile(file);
    if (data.length !== expected.bytes || createHash('sha256').update(data).digest('hex') !== expected.sha256) {
      throw new Error(`Paketdatei verändert: ${name}`);
    }
  }
  if (proof.result === 'PASS') {
    for (const stage of ['model-preflight', 'model-live', 'notebook-preauth', 'cli-auth-boundary']) {
      const name = `nachweise/${stage}.json`;
      if (!proof.files[name]) throw new Error(`Pflichtnachweis fehlt: ${stage}`);
      const report = JSON.parse(await fs.readFile(path.join(root, name), 'utf8'));
      if (report.result !== 'PASS' || report.exitCode !== 0 || report.sourceCommit !== proof.sourceCommit) throw new Error(`Pflichtnachweis ungültig: ${stage}`);
    }
    const execution = JSON.parse(await fs.readFile(path.join(root, 'nachweise/notebook-execution.json'), 'utf8'));
    if (execution.notebookSha256 !== proof.files['airdox-stem-remote-worker.ipynb'].sha256) throw new Error('Notebook stimmt nicht mit geprüftem Export überein');
  }
  return { ok: true, result: proof.result, state: proof.state, sourceCommit: proof.sourceCommit,
    appVersion: bundle.appVersion, workflowUrl: proof.workflowUrl,
    filesVerified: Object.keys(proof.files).length, googleAuthentication: 'NOT_ATTEMPTED',
    scope: 'Mitgelieferte CI-Nachweise; Dateiintegrität gerade lokal geprüft. Kein Modelllauf auf diesem PC, keine Google-Anmeldung.' };
}

async function saveNotebook(folder, destination, isProtected = () => false) {
  if (path.extname(destination).toLowerCase() !== '.ipynb' || isProtected(destination)) throw new Error('Nur eine neue .ipynb-Datei außerhalb geschützter Originalquellen erlaubt.');
  const proof = await verifyColabPackage(folder);
  if (proof.result !== 'PASS') throw new Error('Vorbereitung nicht verifiziert. Bitte das vollständige geprüfte Windows-Paket verwenden.');
  const bytes = await fs.readFile(path.join(folder, 'airdox-stem-remote-worker.ipynb'));
  await fs.writeFile(destination, bytes, { flag: 'wx' });
  return { bytes: bytes.length, proof };
}

module.exports = { verifyColabPackage, saveNotebook };
