'use strict';

/**
 * High-quality, local stem separation through Meta's Demucs model.
 * The complete mix is the only model input. No reference stems are accepted.
 */
const { spawn } = require('node:child_process');
const { access, mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const STEM_NAMES = ['vocals', 'drums', 'bass', 'other'];

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

async function resolvePython(repoRoot) {
  if (process.env.DEMUCS_PYTHON) return process.env.DEMUCS_PYTHON;
  const candidates = process.platform === 'win32'
    ? [path.join(repoRoot, '.venv', 'Scripts', 'python.exe'), 'python']
    : [path.join(repoRoot, '.venv', 'bin', 'python3'), path.join(repoRoot, '.venv', 'bin', 'python'), 'python3'];
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate) || await exists(candidate)) return candidate;
  }
  return candidates[candidates.length - 1];
}

function run(command, args, onProgress) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, env: process.env });
    let output = '';
    const capture = (chunk) => {
      const text = chunk.toString();
      output = (output + text).slice(-16000);
      onProgress?.(text);
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.on('error', (error) => reject(new Error(
      `Demucs konnte nicht gestartet werden (${command}): ${error.message}. ` +
      'Bitte zuerst "npm run stems:setup" ausführen.'
    )));
    child.on('close', (code) => code === 0
      ? resolve()
      : reject(new Error(`Demucs ist mit Code ${code} fehlgeschlagen.\n${output}`)));
  });
}

async function separateWav(wavBytes, options = {}) {
  if (!wavBytes || wavBytes.byteLength < 44) throw new Error('Keine gültige WAV-Mixdatei empfangen.');
  const repoRoot = options.repoRoot || path.join(__dirname, '..');
  const model = options.model || process.env.DEMUCS_MODEL || 'htdemucs_ft';
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'airdox-demucs-'));
  const inputPath = path.join(workDir, 'input-mix.wav');
  const outputRoot = path.join(workDir, 'output');

  try {
    await writeFile(inputPath, Buffer.from(wavBytes));
    const python = await resolvePython(repoRoot);
    const args = [
      '-m', 'demucs',
      '--name', model,
      '--device', process.env.DEMUCS_DEVICE || 'cpu',
      '--jobs', process.env.DEMUCS_JOBS || '1',
      '--out', outputRoot,
      inputPath,
    ];
    await run(python, args, options.onProgress);

    const songDir = path.join(outputRoot, model, 'input-mix');
    const result = { model, stems: {} };
    for (const stem of STEM_NAMES) {
      const stemPath = path.join(songDir, `${stem}.wav`);
      if (!await exists(stemPath)) throw new Error(`Demucs-Ausgabe fehlt: ${stem}.wav`);
      result.stems[stem] = await readFile(stemPath);
    }
    return result;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

module.exports = { STEM_NAMES, resolvePython, separateWav };
