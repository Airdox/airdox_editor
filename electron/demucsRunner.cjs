/**
 * Demucs runner, stemNamesForModel from catalog, preflight probe, buildDemucsArgs quality profile
 * htdemucs_ft quality profile: shifts 10, overlap 0.5, float32, clip-mode rescale, stemOrder from modelCatalog
 */

const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

function loadCatalog() {
  try {
    const catalogPath = path.join(__dirname, '..', 'src', 'stems', 'modelCatalog.json');
    if (fs.existsSync(catalogPath)) {
      const raw = fs.readFileSync(catalogPath, 'utf8');
      return JSON.parse(raw);
    }
  } catch {}
  try {
    const alt = path.join(process.cwd(), 'src', 'stems', 'modelCatalog.json');
    if (fs.existsSync(alt)) {
      return JSON.parse(fs.readFileSync(alt, 'utf8'));
    }
  } catch {}
  return { models: [] };
}

function stemNamesForModel(modelId, fallback = ['drums', 'bass', 'other', 'vocals']) {
  const catalog = loadCatalog();
  const entry = catalog.models.find(m => m.id === modelId);
  if (entry && Array.isArray(entry.stemOrder)) return entry.stemOrder;
  return fallback;
}

function buildDemucsArgs(options) {
  const {
    model = 'htdemucs_ft',
    shifts = 10,
    overlap = 0.5,
    float32 = true,
    clipMode = 'rescale',
    output,
    input,
    extra = [],
  } = options;
  const args = [
    '-m', 'demucs.separate',
    '-n', model,
    '--shifts', String(shifts),
    '--overlap', String(overlap),
    ...(float32 ? ['--float32'] : []),
    '--clip-mode', clipMode,
    '-o', output,
    input,
    ...extra,
  ];
  return args;
}

async function preflightProbe(pythonPath = 'python') {
  return new Promise((resolve) => {
    const child = spawn(pythonPath, ['-m', 'demucs.separate', '--help'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', d => out += d.toString());
    child.stderr.on('data', d => err += d.toString());
    child.on('close', (code) => {
      resolve({
        available: code === 0 || out.includes('demucs') || err.includes('demucs'),
        code,
        output: out + err,
        pythonPath,
      });
    });
    child.on('error', (e) => {
      resolve({ available: false, code: null, output: e.message, pythonPath });
    });
  });
}

function runDemucs(options) {
  const {
    pythonPath = 'python',
    model = 'htdemucs_ft',
    input,
    output,
    shifts = 10,
    overlap = 0.5,
    onProgress,
    onLog,
  } = options;

  const args = buildDemucsArgs({ model, shifts, overlap, float32: true, clipMode: 'rescale', output, input });

  return new Promise((resolve, reject) => {
    const child = spawn(pythonPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      const text = d.toString();
      stdout += text;
      if (onLog) onLog(text);
      // Try to parse progress
      const match = text.match(/(\d+)%/);
      if (match && onProgress) {
        onProgress({ phase: 'progress', percent: parseInt(match[1], 10) });
      }
    });
    child.stderr.on('data', (d) => {
      const text = d.toString();
      stderr += text;
      if (onLog) onLog(text);
    });
    child.on('close', (code) => {
      if (code === 0) resolve({ code, stdout, stderr });
      else reject(new Error(`Demucs failed exit ${code}: ${stderr.slice(0, 1000)}`));
    });
    child.on('error', (e) => reject(e));
  });
}

module.exports = {
  stemNamesForModel,
  buildDemucsArgs,
  preflightProbe,
  runDemucs,
  loadCatalog,
};
