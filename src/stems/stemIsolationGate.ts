/**
 * StemIsolationGate — the acceptance test of part 2 (§2, §12–§17, §26–§31,
 * §34).
 *
 * Runs the full pipeline against the gold standard track:
 *
 *   generate 30s track -> ground truth -> mix -> real separation ->
 *   compare every stem against ground truth -> recombine -> compare against
 *   original -> hash check -> STEM ISOLATION GATE -> PASS/FAIL
 *
 * This module does not care which backend produced the stems — it takes a
 * `StemSeparationEngine` and a `SeparationRequest` (exactly like
 * `runTechnicalGate` from part 1) so it can run against the deterministic
 * pipeline double (CI, no GPU) or a real trained model.
 *
 * IMPORTANT: running this against the pipeline double or an untrained model
 * MUST NOT be reported as "quality passed" — `fromTrainedModel` from the
 * validator is threaded through and a double/random-weights run is always
 * capped at `QUALITY_FAIL` regardless of its numbers (§24: a double is not a
 * separation, §33: speed is not the goal, correctness is).
 */
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { StemSeparationEngine, type SeparationRequest } from './stemSeparationEngine';
import { generateGoldStandardTrack, type GoldStandardTrack } from './goldStandard';
import { buildGoldStandardVariants, buildMasterBusMix, type MixVariant, type VariantId } from './goldStandardVariants';
import { buildStemGroupMap, sumStems } from './stemGroupMapping';
import { evaluateStem, qualityScore, qualityLabel, type StemMetricsReport } from './metrics';
import { sdr as sdrOf } from './metrics';
import { downmixMono } from './dsp';
import { encodeWavFloat32, encodeWavInt24, fileFingerprint, readWavFile, sha256File, analyzeAudio } from './wavIo';
import type { StemId } from './types';

export interface StemIsolationGateOptions {
  engine: StemSeparationEngine;
  /** Root directory the whole test_run/ layout (§26) is written under. */
  outputRoot: string;
  /** Separation request overrides (profile, modelId, …). Defaults to HIGH_QUALITY. */
  request?: Partial<SeparationRequest>;
  /** Which mix variant (§10) drives the main run. Defaults to the clean mix. */
  variant?: VariantId;
  seed?: number;
  /** Also builds + writes (but does not separate) every §10 variant for inspection. */
  writeAllVariants?: boolean;
  onLog?: (line: string) => void;
}

export interface StemIsolationCheck {
  id: string;
  title: string;
  pass: boolean;
  detail: string;
  evidence?: Record<string, unknown>;
}

export interface StemResultRow {
  stemId: StemId;
  isolation: number;
  bleed: number;
  transient: number;
  stereo: number;
  recombination: number;
  result: 'PASS' | 'FAIL';
  metrics: StemMetricsReport;
  qualityBreakdown: Record<string, number>;
  groundTruthComponents: StemId[];
}

export type ReleaseDecision = 'TECHNICAL_FAIL' | 'TECHNICAL_PASS_QUALITY_FAIL' | 'RELEASE_READY';

export interface StemIsolationGateReport {
  gate: 'STEM_ISOLATION';
  part: 2;
  generatedAt: number;
  durationMs: number;
  variant: VariantId;
  modelId: string;
  fromTrainedModel: boolean;
  weightsRandom: boolean;
  originalHashBefore: string;
  originalHashAfter: string;
  technicalPass: boolean;
  qualityPass: boolean;
  releaseDecision: ReleaseDecision;
  checks: StemIsolationCheck[];
  rows: StemResultRow[];
  overallScore: number;
  overallLabel: string;
  recombinationErrorDb: number;
  segments: GoldStandardTrack['segments'];
  paths: {
    root: string;
    original: string;
    groundTruth: string;
    separated: string;
    recombined: string;
    metrics: string;
    report: string;
  };
}

const HARD_FAIL_ORIGINAL_MODIFIED = 'ORIGINAL_MODIFIED';

function averageMetricsToScore(metrics: StemMetricsReport) {
  const isolation = Math.max(0, Math.min(10, (metrics.siSdrDb / 20) * 10));
  const worstBleed = metrics.bleed.length > 0 ? Math.max(...metrics.bleed.map((b) => b.bleedDb)) : -60;
  // Map bleed dB (lower/more negative = better) onto 0..10, 10 = <= -30 dB.
  const bleed = Math.max(0, Math.min(10, ((-worstBleed - 0) / 30) * 10));
  const transient = metrics.transients.preserved
    ? 9 + Math.max(-2, Math.min(1, -Math.abs(metrics.transients.meanAttackLevelErrorDb) / 6))
    : Math.max(0, 7 - (metrics.transients.missingCount / Math.max(1, metrics.transients.referenceCount)) * 10);
  const stereo = metrics.stereo.becameMono ? 2 : Math.max(0, 10 - Math.abs(metrics.stereo.widthDeltaDb) * 0.8 - Math.abs(metrics.stereo.correlationDelta) * 5);
  return {
    isolation: clamp10(isolation),
    bleed: clamp10(bleed),
    transient: clamp10(transient),
    stereo: clamp10(stereo),
  };
}

function clamp10(value: number): number {
  return Math.max(0, Math.min(10, value));
}

/**
 * Detects `weights: "random"` from either the request extras
 * (`allowRandomWeights: true`, set by the caller) or the backend's own
 * `backend-report` job event (`bsroformer_inference.py` reports
 * `weights: "random"` whenever no valid checkpoint was loaded). Either
 * signal is sufficient — this must never require both, since a caller who
 * forgot to pass `allowRandomWeights` but still got a random-weights run
 * (backend fell back) must still be flagged.
 */
function detectRandomWeights(metadata: { settings: { extras?: Record<string, string | number | boolean> }; events: { phase: string; detail?: string }[] }): boolean {
  if (metadata.settings.extras?.['allowRandomWeights'] === true) return true;
  for (const event of metadata.events) {
    if (event.phase !== 'backend-report' || !event.detail) continue;
    try {
      const parsed = JSON.parse(event.detail) as { reports?: Record<string, unknown>[] };
      if (parsed.reports?.some((r) => r['weights'] === 'random')) return true;
    } catch {
      // ignore malformed trace entries
    }
  }
  return false;
}

export async function runStemIsolationGate(options: StemIsolationGateOptions): Promise<StemIsolationGateReport> {
  const startedAt = Date.now();
  const log = (line: string) => options.onLog?.(line);
  const checks: StemIsolationCheck[] = [];
  const add = (check: StemIsolationCheck) => {
    checks.push(check);
    log(`${check.pass ? '✓' : '✘'} ${check.id}: ${check.detail}`);
  };

  const root = options.outputRoot;
  const originalDir = path.join(root, 'original');
  const groundTruthDir = path.join(root, 'ground_truth');
  const separatedDir = path.join(root, 'separated');
  const recombinedDir = path.join(root, 'recombined');
  const metricsDir = path.join(root, 'metrics');
  const reportDir = path.join(root, 'report');
  await Promise.all([originalDir, groundTruthDir, separatedDir, recombinedDir, metricsDir, reportDir].map((d) => mkdir(d, { recursive: true })));

  // -------------------------------------------------------------------
  // §2/§3: build the 30 s gold standard track and its ground truth stems.
  // -------------------------------------------------------------------
  const track = generateGoldStandardTrack({ seed: options.seed });
  log(`Gold-Standard-Track: ${track.seconds}s @ ${track.sampleRate} Hz, seed ${track.seed}`);

  const variants = buildGoldStandardVariants(track);
  const variantId = options.variant ?? 'A_clean';
  const chosen = variants.find((v) => v.id === variantId);
  if (!chosen) throw new Error(`Unbekannte Testvariante: ${variantId}`);

  if (options.writeAllVariants) {
    const variantsDir = path.join(root, 'variants');
    await mkdir(variantsDir, { recursive: true });
    for (const variant of variants) {
      await writeFile(path.join(variantsDir, `${variant.id}.wav`), encodeWavFloat32(variant.buffer.sampleRate, 2, variant.buffer.data, variant.buffer.frames));
    }
    log(`${variants.length} Mix-Varianten (§10) geschrieben nach ${variantsDir}`);
  }

  // Ground truth stems, written as >=24 bit PCM (§3) for audition/inspection.
  for (const [stemId, data] of track.stems) {
    await writeFile(path.join(groundTruthDir, `${stemId}.wav`), encodeWavInt24(track.sampleRate, 2, data, track.frames));
  }
  const mixPath = path.join(originalDir, 'mix.wav');
  await writeFile(mixPath, encodeWavFloat32(chosen.buffer.sampleRate, 2, chosen.buffer.data, chosen.buffer.frames));

  const originalBefore = await fileFingerprint(mixPath);

  // -------------------------------------------------------------------
  // §34: run the real separation pipeline against the chosen mix variant.
  // -------------------------------------------------------------------
  let summary;
  let failure: { code: string; message: string } | undefined;
  try {
    summary = await options.engine.separate({
      inputPath: mixPath,
      profile: 'HIGH_QUALITY',
      trackName: 'gold_standard',
      ...(options.request ?? {}),
    });
  } catch (error) {
    failure = { code: (error as { code?: string }).code ?? 'INFERENCE_FAILED', message: error instanceof Error ? error.message : String(error) };
  }
  const originalAfter = await fileFingerprint(mixPath);

  add({
    id: 'ORIGINAL_HASH_UNCHANGED',
    title: 'Original-Hash vorher == nachher (§18, absolute Regel)',
    pass: originalBefore.sha256 === originalAfter.sha256 && originalBefore.size === originalAfter.size,
    detail: originalBefore.sha256 === originalAfter.sha256 ? `sha256 unverändert (${originalBefore.sha256.slice(0, 16)}…)` : 'Original verändert – HARD FAIL',
    evidence: { before: originalBefore.sha256, after: originalAfter.sha256 },
  });

  add({
    id: 'SEPARATION_COMPLETED',
    title: 'Separation abgeschlossen',
    pass: summary?.status === 'COMPLETED',
    detail: summary ? `Status ${summary.status}` : `Fehler: ${failure?.code} – ${failure?.message}`,
  });

  if (!summary || summary.status !== 'COMPLETED') {
    const report = finalize(checks, [], startedAt, options, track, variantId, originalBefore, originalAfter, {
      root, original: originalDir, groundTruth: groundTruthDir, separated: separatedDir, recombined: recombinedDir, metrics: metricsDir, report: reportDir,
    }, 'unknown', false, false, Number.NaN);
    await writeReportFiles(report, metricsDir, reportDir);
    return report;
  }

  const modelDescriptor = options.engine.registry.get(summary.metadata.settings.modelId);
  const fromTrainedModel = summary.validation?.fromTrainedModel === true;
  const weightsRandom = detectRandomWeights(summary.metadata);
  const modelStemOrder = modelDescriptor?.stemOrder ?? summary.stems.map((s) => s.id);

  // -------------------------------------------------------------------
  // §12/§13: compare every produced stem against its ground truth group.
  // -------------------------------------------------------------------
  const groupMap = buildStemGroupMap(modelStemOrder, track.stemOrder);
  add({
    id: 'STEM_GROUP_MAPPING',
    title: 'Jede Ground-Truth-Quelle einem Modell-Stem zugeordnet',
    pass: groupMap.unassigned.length === 0,
    detail: groupMap.unassigned.length === 0
      ? [...groupMap.groups.entries()].map(([model, gt]) => `${model} = {${gt.join('+')}}`).join(', ')
      : `nicht zugeordnet: ${groupMap.unassigned.join(', ')}`,
    evidence: { groups: Object.fromEntries(groupMap.groups) },
  });

  const rows: StemResultRow[] = [];
  const recombinationSum = new Float32Array(track.frames * 2);
  for (const stem of summary.stems) {
    const gtIds = groupMap.groups.get(stem.id) ?? [];
    const referenceData = sumStems(track.stems, gtIds, track.frames, 2);
    const estimateAudio = await readWavFile(stem.filePath);
    await copyFile(stem.filePath, path.join(separatedDir, `${stem.id}.wav`));

    for (let i = 0; i < recombinationSum.length; i++) recombinationSum[i] += estimateAudio.data[i] || 0;

    const referenceSignal = { data: referenceData, channels: 2, frames: track.frames, sampleRate: track.sampleRate };
    const estimateSignal = { data: estimateAudio.data, channels: estimateAudio.channels, frames: estimateAudio.frames, sampleRate: estimateAudio.sampleRate };
    const others = [...groupMap.groups.entries()]
      .filter(([modelStem]) => modelStem !== stem.id)
      .map(([modelStem, ids]) => ({ id: modelStem, signal: { data: sumStems(track.stems, ids, track.frames, 2), channels: 2, frames: track.frames, sampleRate: track.sampleRate } }));

    const metrics = evaluateStem(stem.id, referenceSignal, estimateSignal, others);
    const scoreInfo = qualityScore(metrics);
    const breakdown = averageMetricsToScore(metrics);
    const recombinationDbForStem = sdrOf(downmixMono(referenceData, 2, track.frames), downmixMono(estimateAudio.data, estimateAudio.channels, Math.min(track.frames, estimateAudio.frames)));

    const result: StemResultRow['result'] = breakdown.isolation >= 4 && breakdown.bleed >= 3 && breakdown.transient >= 3 && breakdown.stereo >= 3 ? 'PASS' : 'FAIL';
    rows.push({
      stemId: stem.id,
      isolation: breakdown.isolation,
      bleed: breakdown.bleed,
      transient: breakdown.transient,
      stereo: breakdown.stereo,
      recombination: clamp10(Math.max(0, Math.min(10, (recombinationDbForStem / 20) * 10))),
      result,
      metrics,
      qualityBreakdown: scoreInfo.breakdown,
      groundTruthComponents: gtIds,
    });
  }

  add({
    id: 'ALL_STEMS_PRODUCED',
    title: 'Jeder erwartete Stem wurde erzeugt und ist technisch valide',
    pass: rows.length === modelStemOrder.length,
    detail: `${rows.length}/${modelStemOrder.length} Stems`,
  });

  // -------------------------------------------------------------------
  // §17/§34: recombine and compare against the original mix variant.
  // -------------------------------------------------------------------
  const recombinedPath = path.join(recombinedDir, 'mix.wav');
  await writeFile(recombinedPath, encodeWavFloat32(track.sampleRate, 2, recombinationSum, track.frames));
  const originalMixAudio = await readWavFile(mixPath);
  const recombinationErrorDb = sdrOf(
    downmixMono(originalMixAudio.data, originalMixAudio.channels, originalMixAudio.frames),
    downmixMono(recombinationSum, 2, track.frames)
  );
  const recombinationLimitDb = fromTrainedModel ? 6 : 20; // §28: massively deviating recombination is a hard fail
  add({
    id: 'RECOMBINATION_MATCHES_ORIGINAL',
    title: 'Recombined Mix nahe am Original (§17, §28)',
    pass: Number.isFinite(recombinationErrorDb) && recombinationErrorDb >= recombinationLimitDb,
    detail: `SDR(recombined, original) = ${recombinationErrorDb.toFixed(1)} dB (Limit ${recombinationLimitDb} dB, trainiert=${fromTrainedModel})`,
    evidence: { recombinationErrorDb, recombinationLimitDb },
  });

  add({
    id: 'FROM_TRAINED_MODEL',
    title: 'Ergebnis stammt von einem trainierten Modell (nicht Double/Zufallsgewichte)',
    pass: fromTrainedModel && !weightsRandom,
    detail: fromTrainedModel && !weightsRandom
      ? `Modell ${summary.metadata.settings.modelId}`
      : weightsRandom
        ? 'weights=random – Architektur läuft, aber keine echte Separation (siehe Doku Teil 2)'
        : 'pipeline_double – kein trainiertes Modell, Qualitäts-Gate kann nicht bestehen',
  });

  const technicalPass = checks.filter((c) => c.id !== 'FROM_TRAINED_MODEL').every((c) => c.pass);

  const overallScoreValues = rows.map((r) => (r.isolation + r.bleed + r.transient + r.stereo + r.recombination) / 5);
  const overallScore = overallScoreValues.length > 0 ? overallScoreValues.reduce((a, b) => a + b, 0) / overallScoreValues.length : 0;
  const qualityPass = technicalPass && fromTrainedModel && !weightsRandom && rows.every((r) => r.result === 'PASS') && overallScore >= 8.5;

  add({
    id: 'STEM_ISOLATION_GATE',
    title: 'Stem Isolation Gate (§29): alle Bedingungen erfüllt',
    pass: qualityPass,
    detail: `Gesamtscore ${overallScore.toFixed(2)}/10 (${qualityLabel(overallScore)}), alle Stems PASS: ${rows.every((r) => r.result === 'PASS')}`,
  });

  const report = finalize(
    checks,
    rows,
    startedAt,
    options,
    track,
    variantId,
    originalBefore,
    originalAfter,
    { root, original: originalDir, groundTruth: groundTruthDir, separated: separatedDir, recombined: recombinedDir, metrics: metricsDir, report: reportDir },
    summary.metadata.settings.modelId,
    fromTrainedModel,
    weightsRandom,
    recombinationErrorDb
  );
  await writeReportFiles(report, metricsDir, reportDir);
  return report;
}

function finalize(
  checks: StemIsolationCheck[],
  rows: StemResultRow[],
  startedAt: number,
  options: StemIsolationGateOptions,
  track: GoldStandardTrack,
  variantId: VariantId,
  before: { sha256: string },
  after: { sha256: string },
  paths: StemIsolationGateReport['paths'],
  modelId: string,
  fromTrainedModel: boolean,
  weightsRandom: boolean,
  recombinationErrorDb: number
): StemIsolationGateReport {
  const technicalPass = checks.filter((c) => c.id !== 'FROM_TRAINED_MODEL' && c.id !== 'STEM_ISOLATION_GATE').every((c) => c.pass);
  const overallScoreValues = rows.map((r) => (r.isolation + r.bleed + r.transient + r.stereo + r.recombination) / 5);
  const overallScore = overallScoreValues.length > 0 ? overallScoreValues.reduce((a, b) => a + b, 0) / overallScoreValues.length : 0;
  const qualityPass = checks.find((c) => c.id === 'STEM_ISOLATION_GATE')?.pass === true;

  let releaseDecision: ReleaseDecision = 'TECHNICAL_FAIL';
  if (technicalPass && qualityPass) releaseDecision = 'RELEASE_READY';
  else if (technicalPass) releaseDecision = 'TECHNICAL_PASS_QUALITY_FAIL';

  return {
    gate: 'STEM_ISOLATION',
    part: 2,
    generatedAt: startedAt,
    durationMs: Date.now() - startedAt,
    variant: variantId,
    modelId,
    fromTrainedModel,
    weightsRandom,
    originalHashBefore: before.sha256,
    originalHashAfter: after.sha256,
    technicalPass,
    qualityPass,
    releaseDecision,
    checks,
    rows,
    overallScore,
    overallLabel: qualityLabel(overallScore),
    recombinationErrorDb,
    segments: track.segments,
    paths,
  };
}

async function writeReportFiles(report: StemIsolationGateReport, metricsDir: string, reportDir: string): Promise<void> {
  await writeFile(path.join(metricsDir, 'metrics.json'), JSON.stringify(report, null, 2));
  const html = renderHtmlReport(report);
  await writeFile(path.join(reportDir, 'report.html'), html);
  const metadata = {
    gate: report.gate,
    part: report.part,
    generatedAt: new Date(report.generatedAt).toISOString(),
    durationMs: report.durationMs,
    variant: report.variant,
    modelId: report.modelId,
    fromTrainedModel: report.fromTrainedModel,
    weightsRandom: report.weightsRandom,
    releaseDecision: report.releaseDecision,
    technicalPass: report.technicalPass,
    qualityPass: report.qualityPass,
    overallScore: report.overallScore,
    overallLabel: report.overallLabel,
    originalHashBefore: report.originalHashBefore,
    originalHashAfter: report.originalHashAfter,
    segments: report.segments.map((s) => ({ id: s.id, title: s.title, startSeconds: s.startSeconds, endSeconds: s.endSeconds })),
  };
  await writeFile(path.join(report.paths.root, 'metadata.json'), JSON.stringify(metadata, null, 2));
}

function renderHtmlReport(report: StemIsolationGateReport): string {
  const rowsHtml = report.rows
    .map(
      (row) => `<tr class="${row.result === 'PASS' ? 'pass' : 'fail'}">
        <td>${row.stemId}</td>
        <td>${row.isolation.toFixed(1)}</td>
        <td>${row.bleed.toFixed(1)}</td>
        <td>${row.transient.toFixed(1)}</td>
        <td>${row.stereo.toFixed(1)}</td>
        <td>${row.recombination.toFixed(1)}</td>
        <td>${row.result}</td>
      </tr>`
    )
    .join('\n');
  const checksHtml = report.checks
    .map((c) => `<li class="${c.pass ? 'pass' : 'fail'}"><strong>${c.id}</strong>: ${c.detail}</li>`)
    .join('\n');
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8" />
<title>Stem Isolation Gate Report</title>
<style>
body { font-family: -apple-system, Segoe UI, sans-serif; margin: 2rem; background: #0e0e12; color: #eee; }
h1 { color: #fff; }
table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
th, td { border: 1px solid #333; padding: 0.5rem 0.8rem; text-align: left; }
tr.pass td:last-child { color: #7CFC98; font-weight: bold; }
tr.fail td:last-child { color: #FF6B6B; font-weight: bold; }
.badge { display: inline-block; padding: 0.3rem 0.8rem; border-radius: 6px; font-weight: bold; }
.badge.RELEASE_READY { background: #1c6b34; color: #fff; }
.badge.TECHNICAL_PASS_QUALITY_FAIL { background: #8a6d1a; color: #fff; }
.badge.TECHNICAL_FAIL { background: #7a1f1f; color: #fff; }
ul { list-style: none; padding: 0; }
li { padding: 0.2rem 0; }
li.pass::before { content: "✓ "; color: #7CFC98; }
li.fail::before { content: "✘ "; color: #FF6B6B; }
</style>
</head>
<body>
<h1>Stem Isolation Gate — Report</h1>
<p>Variante: <strong>${report.variant}</strong> · Modell: <strong>${report.modelId}</strong> · trainiert: <strong>${report.fromTrainedModel}</strong> · weights=random: <strong>${report.weightsRandom}</strong></p>
<p>Release-Entscheidung: <span class="badge ${report.releaseDecision}">${report.releaseDecision}</span></p>
<p>Gesamtscore: <strong>${report.overallScore.toFixed(2)}/10</strong> (${report.overallLabel})</p>
<p>Original-Hash: ${report.originalHashBefore === report.originalHashAfter ? 'unverändert ✓' : 'VERÄNDERT ✘'}</p>
<h2>Ergebnistabelle (§27)</h2>
<table>
<thead><tr><th>Stem</th><th>Isolation</th><th>Bleed</th><th>Transient</th><th>Stereo</th><th>Recombination</th><th>Result</th></tr></thead>
<tbody>
${rowsHtml || '<tr><td colspan="7">keine Stems (Lauf fehlgeschlagen)</td></tr>'}
</tbody>
</table>
<h2>Checks</h2>
<ul>
${checksHtml}
</ul>
<h2>Segmente (§4–§9)</h2>
<ul>
${report.segments.map((s) => `<li>${s.startSeconds}-${s.endSeconds}s — ${s.title}: ${s.description}</li>`).join('\n')}
</ul>
</body>
</html>`;
}
