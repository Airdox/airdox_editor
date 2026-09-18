/**
 * QualityGate – the TECHNICAL gate of part 1 (§19.13, §20, §21).
 *
 * It runs the complete flow and produces a machine readable report:
 *
 *   INPUT AUDIO -> READ-ONLY ORIGINAL -> WORKING COPY -> 44.1 kHz STEREO
 *   -> MODEL INFERENCE -> CHUNKED INFERENCE -> OVERLAP-ADD -> STEM FILES
 *   -> VALIDATION -> JOB METADATA -> CACHE
 *
 * plus the mandatory proof: sha256 of the original before and after the run.
 * If the original changed, the gate FAILS – no exceptions.
 *
 * This gate does NOT judge separation quality. That is the Stem Isolation Gate
 * of part 2.
 */
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { StemSeparationEngine, type SeparationRequest } from './stemSeparationEngine';
import { fileFingerprint } from './wavIo';
import { parseWavLayout, readWavFile } from './wavIo';
import type { QualityProfile, SeparationJobSummary } from './types';

export interface TechnicalGateCheck {
  id: string;
  title: string;
  pass: boolean;
  detail: string;
  evidence?: Record<string, unknown>;
}

export interface TechnicalGateReport {
  gate: 'TECHNICAL_FUNCTIONALITY';
  part: 1;
  pass: boolean;
  generatedAt: number;
  durationMs: number;
  profile: QualityProfile;
  modelId: string;
  jobId?: string;
  metadataPath?: string;
  originalHashBefore?: string;
  originalHashAfter?: string;
  checks: TechnicalGateCheck[];
  summary: { total: number; passed: number; failed: number };
}

export interface TechnicalGateOptions {
  engine: StemSeparationEngine;
  inputPath: string;
  request?: Partial<SeparationRequest>;
  /** Force at least this many chunks (proves chunked inference). */
  expectChunks?: number;
  reportPath?: string;
  /** Called with each finished check (progress for CI logs). */
  onCheck?: (check: TechnicalGateCheck) => void;
}

export async function runTechnicalGate(options: TechnicalGateOptions): Promise<TechnicalGateReport> {
  const startedAt = Date.now();
  const checks: TechnicalGateCheck[] = [];
  const add = (check: TechnicalGateCheck) => {
    checks.push(check);
    options.onCheck?.(check);
  };

  const before = await fileFingerprint(options.inputPath);
  let summary: SeparationJobSummary | undefined;
  let failure: { code: string; message: string } | undefined;
  try {
    summary = await options.engine.separate({
      inputPath: options.inputPath,
      profile: 'HIGH_QUALITY',
      ...(options.request ?? {}),
    });
  } catch (error) {
    failure = {
      code: (error as { code?: string }).code ?? 'INFERENCE_FAILED',
      message: error instanceof Error ? error.message : String(error),
    };
  }
  const after = await fileFingerprint(options.inputPath);

  // --- the non negotiable check: the original must be untouched -------------
  add({
    id: 'ORIGINAL_HASH_UNCHANGED',
    title: 'Original-Hash vorher == nachher',
    pass: before.sha256 === after.sha256 && before.size === after.size && before.mtimeMs === after.mtimeMs,
    detail:
      before.sha256 === after.sha256
        ? `sha256 unverändert (${before.sha256.slice(0, 16)}…), Größe ${before.size} Byte`
        : `Original verändert! vorher ${before.sha256.slice(0, 16)}… nachher ${after.sha256.slice(0, 16)}…`,
    evidence: { sha256Before: before.sha256, sha256After: after.sha256, sizeBefore: before.size, sizeAfter: after.size },
  });

  add({
    id: 'SEPARATION_COMPLETED',
    title: 'Separation läuft bis zum Abschluss',
    pass: summary?.status === 'COMPLETED',
    detail: summary ? `Status ${summary.status}` : `Fehler: ${failure?.code} – ${failure?.message}`,
    evidence: { jobId: summary?.jobId, error: failure },
  });

  if (!summary) {
    const report = buildReport(checks, startedAt, options, summary, before.sha256, after.sha256);
    await writeReport(report, options.reportPath);
    return report;
  }

  const metadata = summary.metadata;

  // --- working copy ---------------------------------------------------------
  let workingOk = false;
  let workingDetail = 'Arbeitskopie fehlt';
  try {
    const bytes = new Uint8Array(await readFile(metadata.workingCopyPath));
    const layout = parseWavLayout(bytes);
    workingOk = layout.sampleRate === 44100 && layout.channels === 2 && layout.bitsPerSample === 32;
    workingDetail = `${layout.sampleRate} Hz, ${layout.channels} Kanäle, ${layout.bitsPerSample} Bit float`;
  } catch (error) {
    workingDetail = error instanceof Error ? error.message : String(error);
  }
  add({
    id: 'WORKING_COPY_44K_STEREO',
    title: 'Arbeitskopie ist 44,1 kHz Stereo float32',
    pass: workingOk,
    detail: workingDetail,
    evidence: { workingCopyPath: metadata.workingCopyPath },
  });

  // --- chunked inference ----------------------------------------------------
  const expectedChunks = options.expectChunks ?? 1;
  add({
    id: 'CHUNKED_INFERENCE',
    title: 'Chunk-basierte Inferenz mit Überlappung',
    pass: metadata.chunkCount >= expectedChunks && metadata.chunkPlan.length === metadata.chunkCount,
    detail: `${metadata.chunkCount} Chunks, Überlappung ${(metadata.settings.chunkOverlap * 100).toFixed(0)} %`,
    evidence: { chunkPlan: metadata.chunkPlan, chunkSize: metadata.settings.chunkSizeSamples },
  });

  // --- overlap-add ----------------------------------------------------------
  const recombination = summary.validation?.recombinationErrorDb ?? Number.NaN;
  add({
    id: 'OVERLAP_ADD_RECONSTRUCTION',
    title: 'Overlap-Add-Rekonstruktion ohne Übergangsfehler',
    pass: Boolean(summary.validation?.pass) && (summary.validation?.continuity.excessDb ?? 99) <= 6,
    detail: `Rekombinationsfehler ${recombination.toFixed(1)} dB, Grenzüberschuss ${(summary.validation?.continuity.excessDb ?? 0).toFixed(1)} dB`,
    evidence: { continuity: summary.validation?.continuity },
  });

  // --- stem files -----------------------------------------------------------
  const stemsComplete = summary.stems.length > 0 && summary.stems.every((stem) => stem.complete && stem.sha256.length === 64);
  add({
    id: 'STEM_FILES_VALIDATED',
    title: 'Stem-Dateien vollständig validiert (Header, Samplerate, Kanäle, Frames, Hash)',
    pass: stemsComplete,
    detail: summary.stems
      .map((stem) => `${stem.id}: ${stem.sampleRate} Hz/${stem.channelCount}ch/${stem.frames} Frames`)
      .join(' | '),
    evidence: { stems: summary.stems.map((stem) => ({ id: stem.id, sha256: stem.sha256, frames: stem.frames, bytes: stem.bytes })) },
  });

  const stereoPreserved = summary.stems.every((stem) => stem.channelCount === 2);
  add({
    id: 'STEREO_PRESERVED',
    title: 'Stereo-Erhaltung in allen Stems',
    pass: stereoPreserved && summary.stems.length > 0,
    detail: stereoPreserved ? 'alle Stems haben 2 Kanäle' : 'mindestens ein Stem ist nicht stereo',
  });

  // --- job metadata ---------------------------------------------------------
  const requiredFields = [
    metadata.inputAudioHash,
    metadata.settings.modelId,
    metadata.settings.modelVersion,
    metadata.settings.modelHash,
    metadata.settings.backend,
    metadata.settings.precision,
    String(metadata.settings.sampleRate),
    String(metadata.settings.channels),
    String(metadata.settings.numOverlap),
    metadata.settingsHash,
    String(metadata.timing.startedAt),
  ];
  add({
    id: 'JOB_METADATA_COMPLETE',
    title: 'Job-Metadaten enthalten Input-, Modell-, Backend- und Parameter-Hash',
    pass: requiredFields.every((value) => Boolean(value)) && metadata.schemaVersion === 1,
    detail: `jobId ${metadata.jobId}, settingsHash ${metadata.settingsHash.slice(0, 12)}…, backend ${metadata.settings.backend}`,
    evidence: { settings: metadata.settings },
  });

  // --- cache ----------------------------------------------------------------
  let cacheHit = false;
  let cacheDetail = 'Zweiter Lauf fehlgeschlagen';
  try {
    const second = await options.engine.separate({
      inputPath: options.inputPath,
      profile: 'HIGH_QUALITY',
      ...(options.request ?? {}),
    });
    cacheHit = second.cacheHit && second.status === 'COMPLETED';
    cacheDetail = cacheHit
      ? `Zweiter Lauf aus Cache (Schlüssel ${second.metadata.cacheKey.slice(0, 24)}…)`
      : `Zweiter Lauf ohne Cache-Treffer (Status ${second.status}, cacheHit=${second.cacheHit})`;
  } catch (error) {
    cacheDetail = error instanceof Error ? error.message : String(error);
  }
  add({ id: 'CACHE_REUSE', title: 'Identische Parameter führen zum Cache-Treffer', pass: cacheHit, detail: cacheDetail });

  // --- original integrity re-verified by the engine itself -------------------
  add({
    id: 'ENGINE_INTEGRITY_CHECK',
    title: 'Engine-interne Integritätsprüfung (vor/nach) bestanden',
    pass: summary.originalIntegrity.unchanged === true,
    detail: `unchanged=${summary.originalIntegrity.unchanged}`,
    evidence: { originalIntegrity: summary.originalIntegrity },
  });

  const report = buildReport(checks, startedAt, options, summary, before.sha256, after.sha256);
  await writeReport(report, options.reportPath);
  return report;
}

function buildReport(
  checks: TechnicalGateCheck[],
  startedAt: number,
  options: TechnicalGateOptions,
  summary: SeparationJobSummary | undefined,
  before: string,
  after: string
): TechnicalGateReport {
  const passed = checks.filter((check) => check.pass).length;
  return {
    gate: 'TECHNICAL_FUNCTIONALITY',
    part: 1,
    pass: checks.every((check) => check.pass),
    generatedAt: startedAt,
    durationMs: Date.now() - startedAt,
    profile: (options.request?.profile as QualityProfile) ?? 'HIGH_QUALITY',
    modelId: summary?.metadata.settings.modelId ?? options.request?.modelId ?? 'unknown',
    jobId: summary?.jobId,
    metadataPath: summary?.metadataPath,
    originalHashBefore: before,
    originalHashAfter: after,
    checks,
    summary: { total: checks.length, passed, failed: checks.length - passed },
  };
}

async function writeReport(report: TechnicalGateReport, reportPath?: string): Promise<void> {
  if (!reportPath) return;
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2));
}

/** Reads a previously written report (CI artefacts, docs). */
export async function readTechnicalGateReport(reportPath: string): Promise<TechnicalGateReport> {
  return JSON.parse(await readFile(reportPath, 'utf8')) as TechnicalGateReport;
}

/** Verifies that a decoded stem set is sample-aligned with its mix. */
export async function assertSampleAligned(stemPath: string, mixPath: string): Promise<void> {
  const stem = await readWavFile(stemPath);
  const mix = await readWavFile(mixPath);
  if (stem.sampleRate !== mix.sampleRate) throw new Error(`Samplerate ${stem.sampleRate} != ${mix.sampleRate}`);
  if (Math.abs(stem.frames - mix.frames) > 1) throw new Error(`Frames ${stem.frames} != ${mix.frames}`);
}
