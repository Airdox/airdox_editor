/**
 * QualityValidator (§14, §17).
 *
 * A stem file is only "complete" when every technical check passes:
 * header, sample rate, channel count, sample count, plausible size, finite
 * samples and a recorded sha256. Partially written files can never be reported
 * as finished stems.
 *
 * On top of that the validator measures the boundary artefacts §14 lists:
 * clicks, level jumps, stereo jumps, duplicated or missing transients at chunk
 * borders.
 *
 * This is the TECHNICAL validator of part 1. It does not judge separation
 * quality – that is the Stem Isolation Gate of part 2.
 */
import { stat } from 'node:fs/promises';
import { StemSeparationError } from './errors';
import { analyzeAudio, parseWavLayout, readWavFile, sha256File, type DecodedAudio } from './wavIo';
import { measureContinuity, measureBoundaryError } from './reconstructor';
import type { BoundaryContinuityReport, ProcessingMode, QualityValidationReport, StemDescriptor, StemId, StemValidationIssue, StemValidationReport } from './types';

export const DEFAULT_CONTINUITY_EXCESS_DB = 6;
export const DEFAULT_RMS_JUMP_DB = 9;
export const DEFAULT_STEREO_JUMP = 0.35;
/** Recombination tolerance for trained models (dB, relative to the mix RMS). */
export const RECOMBINATION_WARN_DB = -24;
/** The pipeline double must recombine essentially exactly. */
export const RECOMBINATION_DOUBLE_DB = -90;

export interface ValidateSeparationOptions {
  expectedSampleRate: number;
  expectedChannels: number;
  expectedFrames: number;
  /** Chunk border offsets in samples (absolute, in the reconstructed file). */
  boundaryOffsets: number[];
  /** Path of the working copy – reference for transients and recombination. */
  workingCopyPath: string;
  fromTrainedModel: boolean;
  continuityExcessDb?: number;
  rmsJumpDb?: number;
  stereoJump?: number;
  /** Override of the recombination tolerance in dB. */
  recombinationLimitDb?: number;
  /** Border specific reconstruction error tolerance in dB. */
  boundaryErrorExcessDb?: number;
  /**
   * `fast_dj` limits the validator to the checks that protect the user:
   * file geometry, finite samples, peak, non-silence. The boundary metrics,
   * the recombination measurement and the continuity scan are skipped –
   * together they are the expensive part (three full passes over every stem
   * plus a transient search) and they judge *artefacts*, not correctness.
   *
   * The report keeps the same shape; the skipped metrics are `null`, so a
   * consumer can tell "not measured" from "measured and good".
   */
  mode?: ProcessingMode;
  /** Explicit off switch for the continuity block (studio mode). */
  measureContinuity?: boolean;
}

async function readStem(filePath: string): Promise<DecodedAudio> {
  return readWavFile(filePath);
}

/** Validates a single stem file against the expected geometry. */
export async function validateStemFile(
  stemId: StemId,
  filePath: string,
  options: Pick<ValidateSeparationOptions, 'expectedSampleRate' | 'expectedChannels' | 'expectedFrames'>
): Promise<{ report: StemValidationReport; audio: DecodedAudio }> {
  const issues: StemValidationIssue[] = [];
  let info;
  try {
    info = await stat(filePath);
  } catch (error) {
    return {
      report: {
        stemId, pass: false,
        issues: [{ severity: 'error', code: 'STEM_FILE_MISSING', message: `Stem-Datei fehlt: ${filePath}` }],
        headerOk: false, sampleRateOk: false, channelCountOk: false, frameCountOk: false,
        sizePlausible: false, sha256: '', finiteSamples: false, peak: 0, rms: 0, dcOffset: 0,
      },
      audio: { sampleRate: 0, channels: 0, frames: 0, data: new Float32Array(0), sourceFormat: 'wav', encoding: 'unknown' },
    };
  }

  const expectedBytes = 44 + options.expectedFrames * options.expectedChannels * 4;
  const sizePlausible = info.size >= 44 && Math.abs(info.size - expectedBytes) <= options.expectedChannels * 4 * 8;
  if (!sizePlausible) {
    issues.push({
      severity: 'error',
      code: 'STEM_SIZE_IMPLAUSIBLE',
      message: `Dateigröße ${info.size} Byte passt nicht zu ${options.expectedFrames} Frames (${expectedBytes} Byte erwartet)`,
      stemId,
    });
  }

  let audio: DecodedAudio;
  let headerOk = false;
  try {
    audio = await readStem(filePath);
    headerOk = true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    issues.push({ severity: 'error', code: 'STEM_HEADER_INVALID', message: `WAV-Header ungültig: ${message}`, stemId });
    return {
      report: {
        stemId, pass: false, issues, headerOk: false, sampleRateOk: false, channelCountOk: false,
        frameCountOk: false, sizePlausible, sha256: '', finiteSamples: false, peak: 0, rms: 0, dcOffset: 0,
      },
      audio: { sampleRate: 0, channels: 0, frames: 0, data: new Float32Array(0), sourceFormat: 'wav', encoding: 'unknown' },
    };
  }

  const sampleRateOk = audio.sampleRate === options.expectedSampleRate;
  if (!sampleRateOk) {
    issues.push({ severity: 'error', code: 'STEM_SAMPLE_RATE_MISMATCH', message: `Samplerate ${audio.sampleRate} statt ${options.expectedSampleRate}`, stemId });
  }
  const channelCountOk = audio.channels === options.expectedChannels;
  if (!channelCountOk) {
    issues.push({ severity: 'error', code: 'STEM_CHANNEL_MISMATCH', message: `${audio.channels} Kanäle statt ${options.expectedChannels} (Stereo-Erhaltung verletzt)`, stemId });
  }
  const frameCountOk = Math.abs(audio.frames - options.expectedFrames) <= 1;
  if (!frameCountOk) {
    issues.push({ severity: 'error', code: 'STEM_FRAME_MISMATCH', message: `${audio.frames} Samples statt ${options.expectedFrames}`, stemId });
  }

  const stats = analyzeAudio(audio.data, audio.channels, audio.frames);
  if (!stats.finite) issues.push({ severity: 'error', code: 'STEM_NON_FINITE', message: 'Stem enthält NaN/Infinity', stemId });
  if (stats.peak > 1.5) {
    issues.push({ severity: 'warning', code: 'STEM_OVER_LEVEL', message: `Peak ${stats.peak.toFixed(3)} liegt deutlich über 0 dBFS`, stemId });
  }
  if (Math.abs(stats.dc) > 0.01) {
    issues.push({ severity: 'warning', code: 'STEM_DC_OFFSET', message: `DC-Offset ${stats.dc.toFixed(4)}`, stemId });
  }

  const sha256 = await sha256File(filePath);
  const pass = !issues.some((issue) => issue.severity === 'error');
  return {
    report: {
      stemId,
      pass,
      issues,
      headerOk,
      sampleRateOk,
      channelCountOk,
      frameCountOk,
      sizePlausible,
      sha256,
      finiteSamples: stats.finite,
      peak: stats.peak,
      rms: stats.rms,
      dcOffset: stats.dc,
    },
    audio,
  };
}

function worst(values: number[]): number {
  return values.length ? Math.max(...values) : 0;
}

/**
 * Full technical validation of one separation result.
 */
export async function validateSeparation(
  stemFiles: Map<StemId, string>,
  options: ValidateSeparationOptions
): Promise<{ report: QualityValidationReport; stems: StemDescriptor[] }> {
  if (stemFiles.size === 0) {
    throw new StemSeparationError('STEM_CONFIG_INVALID', 'Keine Stems zur Validierung übergeben');
  }
  const issues: StemValidationIssue[] = [];
  const stemReports: StemValidationReport[] = [];
  const descriptors: StemDescriptor[] = [];
  const audioByStem = new Map<StemId, DecodedAudio>();

  for (const [stemId, filePath] of stemFiles) {
    const { report, audio } = await validateStemFile(stemId, filePath, options);
    stemReports.push(report);
    audioByStem.set(stemId, audio);
    for (const issue of report.issues) issues.push(issue);
    const info = await stat(filePath).catch(() => ({ size: 0 } as { size: number }));
    descriptors.push({
      id: stemId,
      displayName: stemId,
      outputIndex: [...stemFiles.keys()].indexOf(stemId),
      channelCount: audio.channels,
      sampleRate: audio.sampleRate,
      frames: audio.frames,
      filePath,
      sha256: report.sha256,
      bytes: info.size,
      peak: report.peak,
      rms: report.rms,
      complete: report.pass,
    });
  }

  const mode: ProcessingMode = options.mode ?? 'studio_master';
  if (mode === 'fast_dj') {
    // Fast path: geometry + finite + peak + non-silence per stem (already
    // collected above). Everything below this line is artefact analysis and
    // costs several full passes over every stem.
    const silent = stemReports.filter((report) => report.pass && report.peak <= 1e-6).map((report) => report.stemId);
    if (silent.length > 0) {
      issues.push({
        severity: 'error',
        code: 'STEM_SILENT',
        message: `Stem(s) ohne Signal: ${silent.join(', ')} – Separation hat nichts geliefert`,
      });
    }
    const pass = !issues.some((issue) => issue.severity === 'error');
    return {
      report: {
        pass,
        issues,
        stems: stemReports,
        // Not measured in fast_dj: null means "not measured", never "good".
        continuity: null,
        recombinationErrorDb: null,
        fromTrainedModel: options.fromTrainedModel,
        mode,
      },
      stems: descriptors,
    };
  }

  // Recombination: sum of all stems versus the working copy.
  const mix = await readWavFile(options.workingCopyPath);
  const frames = Math.min(options.expectedFrames, mix.frames);
  const channels = options.expectedChannels;
  const sum = new Float32Array(frames * channels);
  for (const audio of audioByStem.values()) {
    for (let i = 0; i < frames * channels; i++) sum[i] += audio.data[i] || 0;
  }
  let errorSq = 0;
  let mixSq = 0;
  for (let i = 0; i < frames * channels; i++) {
    const m = mix.data[i] || 0;
    errorSq += (sum[i] - m) ** 2;
    mixSq += m * m;
  }
  const recombinationErrorDb = mixSq > 1e-18 ? 10 * Math.log10(errorSq / mixSq) : -180;
  const recombinationLimit = options.recombinationLimitDb ?? (options.fromTrainedModel ? RECOMBINATION_WARN_DB : RECOMBINATION_DOUBLE_DB);
  if (recombinationErrorDb > recombinationLimit) {
    issues.push({
      severity: options.fromTrainedModel ? 'warning' : 'error',
      code: 'RECOMBINATION_DEVIATION',
      message: `Summe der Stems weicht um ${recombinationErrorDb.toFixed(1)} dB vom Mix ab (Limit ${recombinationLimit} dB)`,
    });
  }

  // Boundary continuity (§14): level/phase/stereo behaviour is measured per
  // stem, doubled or lost transients are a property of the reconstruction and
  // are therefore measured on the recombined sum against the working copy.
  const excessDb: number[] = [];
  const rmsJumps: number[] = [];
  const stereoJumps: number[] = [];
  const boundaryDeltas: number[] = [];
  const interiorDeltas: number[] = [];
  for (const audio of audioByStem.values()) {
    const measurement = measureContinuity(audio.data, audio.channels, audio.frames, options.boundaryOffsets);
    boundaryDeltas.push(measurement.boundaryDeltaDb);
    interiorDeltas.push(measurement.interiorDeltaDb);
    excessDb.push(measurement.excessDb);
  }

  const recombinationMeasurement = measureContinuity(sum, channels, frames, options.boundaryOffsets, mix.data);
  rmsJumps.push(recombinationMeasurement.rmsJumpDb);
  stereoJumps.push(recombinationMeasurement.stereoJump);
  const duplicates = recombinationMeasurement.duplicateTransients;
  const missing = recombinationMeasurement.missingTransients;
  if (duplicates > 0) {
    issues.push({ severity: 'error', code: 'DUPLICATE_TRANSIENT', message: `${duplicates} doppelte Transienten an Chunk-Grenzen (Rekombination)` });
  }
  if (missing > 0) {
    issues.push({ severity: 'error', code: 'MISSING_TRANSIENT', message: `${missing} fehlende Transienten an Chunk-Grenzen (Rekombination)` });
  }

  const boundaryError = measureBoundaryError(sum, mix.data, channels, frames, options.boundaryOffsets);
  const continuity: BoundaryContinuityReport = {
    boundaryDeltaDb: worst(boundaryDeltas),
    interiorDeltaDb: worst(interiorDeltas),
    excessDb: worst(excessDb),
    rmsJumpDb: worst(rmsJumps),
    stereoJump: worst(stereoJumps),
    duplicateTransients: duplicates,
    missingTransients: missing,
    boundaryErrorDb: boundaryError.boundaryErrorDb,
    interiorErrorDb: boundaryError.interiorErrorDb,
    boundaryErrorExcessDb: boundaryError.boundaryErrorExcessDb,
    boundarySampleOffsets: [...options.boundaryOffsets],
    pass: true,
  };

  const excessLimit = options.continuityExcessDb ?? DEFAULT_CONTINUITY_EXCESS_DB;
  const rmsLimit = options.rmsJumpDb ?? DEFAULT_RMS_JUMP_DB;
  const stereoLimit = options.stereoJump ?? DEFAULT_STEREO_JUMP;
  if (continuity.excessDb > excessLimit) {
    issues.push({ severity: 'error', code: 'BOUNDARY_CLICK', message: `Sprung an Chunk-Grenze ${continuity.excessDb.toFixed(1)} dB über Innenbereich (Limit ${excessLimit} dB)` });
    continuity.pass = false;
  }
  if (continuity.rmsJumpDb > rmsLimit) {
    issues.push({ severity: 'error', code: 'BOUNDARY_LEVEL_JUMP', message: `Lautheitssprung ${continuity.rmsJumpDb.toFixed(1)} dB an Chunk-Grenze (Limit ${rmsLimit} dB)` });
    continuity.pass = false;
  }
  if (continuity.stereoJump > stereoLimit) {
    issues.push({ severity: 'warning', code: 'BOUNDARY_STEREO_JUMP', message: `Stereo-Sprung ${continuity.stereoJump.toFixed(2)} an Chunk-Grenze` });
  }
  const boundaryErrorLimit = options.boundaryErrorExcessDb ?? 12;
  if (options.boundaryOffsets.length > 0 && continuity.boundaryErrorExcessDb > boundaryErrorLimit) {
    issues.push({
      severity: 'error',
      code: 'BOUNDARY_SPECIFIC_ERROR',
      message:
        `Rekonstruktionsfehler an Chunk-Grenzen liegt ${continuity.boundaryErrorExcessDb.toFixed(1)} dB über dem ` +
        `übrigen Material (Grenze ${boundaryErrorLimit} dB)`,
    });
    continuity.pass = false;
  }

  const pass = !issues.some((issue) => issue.severity === 'error');
  return {
    report: {
      pass,
      issues,
      stems: stemReports,
      continuity,
      recombinationErrorDb,
      fromTrainedModel: options.fromTrainedModel,
      mode,
    },
    stems: descriptors,
  };
}

/** Convenience: asserts the WAV header geometry without loading samples. */
export async function assertWavGeometry(filePath: string, sampleRate: number, channels: number, frames: number): Promise<void> {
  const { readFile } = await import('node:fs/promises');
  const bytes = new Uint8Array(await readFile(filePath));
  const layout = parseWavLayout(bytes);
  if (layout.sampleRate !== sampleRate) throw new StemSeparationError('STEM_CONFIG_INVALID', `Samplerate ${layout.sampleRate} != ${sampleRate}`);
  if (layout.channels !== channels) throw new StemSeparationError('STEM_CONFIG_INVALID', `Kanäle ${layout.channels} != ${channels}`);
  const actualFrames = Math.floor(layout.dataSize / Math.max(1, layout.blockAlign));
  if (Math.abs(actualFrames - frames) > 1) throw new StemSeparationError('STEM_CONFIG_INVALID', `Frames ${actualFrames} != ${frames}`);
}
