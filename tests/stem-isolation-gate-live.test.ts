/**
 * @requires: python, torch, model
 *   Braucht Python+PyTorch UND einen installierten, trainierten Checkpoint
 *   (`npm run stems:setup:bsroformer`). Ohne beides meldet der Runner SKIP.
 *
 * TEIL 2 – QUALITÄTSFREIGABE mit echten Gewichten.
 *
 * `tests/stem-isolation-gate.test.ts` (main) beweist, dass das Gate *richtig*
 * urteilt: gegen den PipelineDoubleSeparator darf es niemals `RELEASE_READY`
 * liefern. Diese Suite ist der zweite Halbteil – sie lässt dasselbe Gate gegen
 * den **Produktionspfad** laufen (StemSeparationEngine → BSRoFormerSeparator →
 * `python/bsroformer_inference.py` → ZFTurbo-Architektur → trainierter
 * Checkpoint) und protokolliert das Ergebnis als Freigabe-Entscheidung.
 *
 * Absichtlich KEIN Qualitäts-Autor:
 *   Das `PASS`/`FAIL` der Stems und die Release-Entscheidung berechnet
 *   `runStemIsolationGate`. Diese Suite prüft nur die Bedingungen, ohne die das
 *   Ergebnis wertlos wäre (falsche Gewichte, verändertes Original, fehlende
 *   Stems, fehlende Berichte) und schreibt die Messwerte maschinenlesbar.
 *   Ein `TECHNICAL_PASS_QUALITY_FAIL` ist hier ein *gültiges Ergebnis* (und ein
 *   nützliches), kein Testfehler – sonst würde eine ehrliche Messung zur
 *   gebauten Zahl gezwungen.
 *
 * Freigabe-Protokoll (§18/§17 des Masterprompts, unverändert):
 *   - Original (die gemixte Testspur) wird read-only behandelt; sha256 vor/nach
 *     muss identisch sein – auch bei Abbruch/Fehler.
 *   - `weights` muss `checkpoint` sein, niemals `random`.
 *   - Der sha256 des Checkpoints wird gegen `modelCatalog.json` geprüft. Steht
 *     dort `unverified`, wird der gemessene Hash ausgegeben (und auf Wunsch als
 *     Patch-Vorschlag geschrieben), damit er pinnbar wird.
 *   - `AIRODOX_STEM_ALLOW_QUALITY_RUN=1` ist Pflicht: ohne dieses Flag bricht ab,
 *     bevor Audio an ein Backend geht. Es verhindert, dass ein aufwändiger oder
 *     kostenpflichtiger Lauf (Colab/GPU) versehentlich anspringt.
 *
 * Umgebung (alles optional, Defaults passen für Colab und lokale Setups):
 *   AIRODOX_STEM_ALLOW_QUALITY_RUN=1   Freigabe (Pflicht)
 *   AIRODOX_STEM_GATE_OUT=<pfad>       Ziel für test_run/ (Default: stem-gate-run/)
 *   AIRODOX_STEM_GATE_PROFILE=…        HIGH_QUALITY (Default) | MAXIMUM_QUALITY
 *   AIRODOX_STEM_GATE_DEVICE=auto      auto|cpu|cuda  (an das Backend durchgereicht)
 *   AIRODOX_STEM_GATE_PRECISION=f32    f32|f16|bf16   (f16 nur auf CUDA sinnvoll)
 *   AIRODOX_STEM_GATE_VARIANT=A_clean  Mix-Variante (§10)
 *   AIRODOX_STEM_GATE_OVERLAP=4        numOverlap übersteuern (Schnelllauf = 1;
 *                                      dann ist das ein Rauchtest, keine Freigabe)
 *   AIRODOX_STEM_GATE_SDR_TOLERANCE=4  erlaubte Abweichung (dB) vom publizierten
 *                                      SDR-Wert je Stem – plausibler Bereich, kein
 *                                      Qualitätsurteil
 *   AIRODOX_STEM_GATE_EMIT_PATCH=1     schreibt modelHash-Vorschlag als JSON
 *
 * Aufruf:
 *   AIRODOX_STEM_ALLOW_QUALITY_RUN=1 npm run test:stems:live
 */
import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createDefaultBackendFactory, StemSeparationEngine } from '../src/stems/stemSeparationEngine';
import { ModelRegistry } from '../src/stems/modelRegistry';
import { runStemIsolationGate } from '../src/stems/stemIsolationGate';
import { readWavFile, sha256File } from '../src/stems/wavIo';

const MODEL_ID = 'bsroformer-musdb18hq-4stem-zfturbo';
const ADAPTER = path.resolve('python/bsroformer_inference.py');
const CATALOG = path.resolve('src/stems/modelCatalog.json');
const SHA256_RE = /^[a-f0-9]{64}$/i;

function stemHome(...parts: string[]): string {
  const home = process.env.AIRODOX_STEM_HOME || path.join(process.env.HOME ?? os_home(), '.cache', 'airdox-stems');
  return path.join(home, ...parts);
}
function os_home(): string {
  return process.env.USERPROFILE || process.env.HOME || '.';
}
function checkpointDir(): string {
  return process.env.AIRODOX_STEM_CHECKPOINT_DIR || process.env.AIRODOX_STEM_MODEL_DIR || stemHome('checkpoints');
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/** Publizierter Referenz-SDR aus dem Katalog-Kommentar – nur Plausibilität. */
const PUBLISHED_SDR: Record<string, number> = { drums: 11.61, vocals: 11.08, bass: 8.48, other: 7.44 };

async function run() {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  TEIL 2 – STEM ISOLATION GATE mit TRAINIERTEN GEWICHTEN            ');
  console.log('═══════════════════════════════════════════════════════════════════');

  if (process.env.AIRODOX_STEM_ALLOW_QUALITY_RUN !== '1') {
    console.log('\n⚠ SKIP: AIRODOX_STEM_ALLOW_QUALITY_RUN ist nicht gesetzt.');
  console.log('  Dieser Lauf nutzt ein externes Backend und kann von Minuten (CPU) bis');
  console.log('  wenigen Stunden (CPU, 30 s Spur mit Overlap) brauchen – er springt nur');
  console.log('  explizit an:');
    console.log('    AIRODOX_STEM_ALLOW_QUALITY_RUN=1 npm run test:stems:live');
    return;
  }

  const descriptor = ModelRegistry.fromBundledCatalog().require(MODEL_ID);
  const checkpointPath = path.join(checkpointDir(), descriptor.checkpoint!.file);
  if (!(await exists(checkpointPath))) {
    console.log(`\n⚠ SKIP: trainierter Checkpoint fehlt: ${checkpointPath}`);
    console.log('  Einrichtung: bash scripts/setup-bsroformer-model.sh');
    return;
  }
  if (!(await exists(ADAPTER))) {
    console.log(`\n⚠ SKIP: Adapter fehlt: ${ADAPTER}`);
    return;
  }

  // ---- [1] Checkpoint-Identität: der gemessene sha256 muss zum Katalog passen --
  console.log('\n[ TEST ] #1 Checkpoint-Identität (sha256 gegen modelCatalog.json)');
  const actualHash = await sha256File(checkpointPath);
  const catalogHash = (JSON.parse(await readFile(CATALOG, 'utf8')).models as { id: string; modelHash?: string }[]).find(
    (m) => m.id === MODEL_ID
  )?.modelHash;
  console.log(`  gemessen:  ${actualHash}`);
  console.log(`  Katalog:   ${catalogHash ?? '(kein Eintrag)'}`);
  if (catalogHash && catalogHash !== 'unverified') {
    assert.equal(actualHash, catalogHash.toLowerCase(), 'Checkpoint passt nicht zum gepinnten modelHash – andere Datei?');
    console.log('  ✓ sha256 stimmt mit dem gepinnten modelHash überein');
  } else {
    console.log('  ⚠ modelHash ist noch „unverified“ – dieser gemessene Hash muss in');
    console.log('    src/stems/modelCatalog.json eingetragen werden (Punkt 5 der Übergabe).');
    if (process.env.AIRODOX_STEM_GATE_EMIT_PATCH === '1') {
      const out = path.resolve(process.env.AIRODOX_STEM_GATE_OUT || 'stem-gate-run');
      await mkdir(out, { recursive: true });
      await writeFile(
        path.join(out, 'model-hash-patch.json'),
        JSON.stringify(
          {
            modelId: MODEL_ID,
            file: descriptor.checkpoint!.file,
            modelHash: actualHash,
            measuredAt: new Date().toISOString(),
            source: 'tests/stem-isolation-gate-live.test.ts',
            applyTo: 'src/stems/modelCatalog.json → models[id=' + MODEL_ID + '].modelHash',
          },
          null,
          2
        ) + '\n'
      );
      console.log(`  ✓ Vorschlag geschrieben: ${path.join(out, 'model-hash-patch.json')}`);
    }
  }
  assert.ok(SHA256_RE.test(actualHash), 'gemessener Hash ist kein sha256');

  // ---- [2] Engine auf dem Produktionspfad --------------------------------------
  const outRoot = path.resolve(process.env.AIRODOX_STEM_GATE_OUT || 'stem-gate-run');
  await mkdir(outRoot, { recursive: true });
  const python = process.env.AIRODOX_STEM_PYTHON;
  const engine = new StemSeparationEngine({
    workingRoot: path.join(outRoot, 'Working'),
    outputRoot: path.join(outRoot, 'Separation'),
    cacheRoot: path.join(outRoot, 'Cache'),
    modelStoreDir: checkpointDir(),
    backendFactory: createDefaultBackendFactory({
      pythonCommand: python,
      adapterScript: ADAPTER,
      referenceSourceDir: process.env.AIRODOX_MSST_DIR || stemHome('vendor', 'msst'),
      modelStoreDir: checkpointDir(),
      // Bewusst NICHT relaxt: ohne torch ist das kein Freigabe-Lauf.
      requireTorch: true,
    }),
  });

  const profile = (process.env.AIRODOX_STEM_GATE_PROFILE as 'HIGH_QUALITY' | 'MAXIMUM_QUALITY') || 'HIGH_QUALITY';
  const device = (process.env.AIRODOX_STEM_GATE_DEVICE as 'auto' | 'cpu' | 'cuda') || 'auto';
  const precision = (process.env.AIRODOX_STEM_GATE_PRECISION as 'f32' | 'f16' | 'bf16') || 'f32';
  console.log(`\n  Store: ${checkpointDir()}`);
  console.log(`  Report: ${outRoot}`);
  console.log(`  Profil ${profile} · Gerät ${device} · Präzision ${precision}`);

  // Overlap ist der teuerste Hebel (je mehr Übergänge, desto mehr Modell-Läufe).
  // Default: der vom Modell-Deskriptor empfohlene Wert – nur explizit verändern,
  // wenn man einen bewussten Schnelllauf fahren will (dann NICHT als Freigabe
  // protokollieren, sondern als Rauchtest).
  const overlap = process.env.AIRODOX_STEM_GATE_OVERLAP ? Number(process.env.AIRODOX_STEM_GATE_OVERLAP) : undefined;
  const startedAt = Date.now();
  const report = await runStemIsolationGate({
    engine,
    outputRoot: path.join(outRoot, 'test_run'),
    variant: (process.env.AIRODOX_STEM_GATE_VARIANT as never) || 'A_clean',
    request: { profile, modelId: MODEL_ID, device, precision, ...(overlap ? { numOverlap: overlap } : {}) },
    writeAllVariants: true,
    onLog: (line) => console.log(`  ${line}`),
  });

  // ---- [3] Das Gate hat gemessen, nicht erfunden --------------------------------
  console.log('\n[ TEST ] #3 Gate-Lauf ist ein echter, trainierter Lauf');
  assert.equal(report.modelId, MODEL_ID, 'Gate musste gegen das HQ-Modell laufen');
  assert.equal(report.fromTrainedModel, true, 'fromTrainedModel=false ⇒ kein trainiertes Modell, kein Freigabe-Lauf');
  assert.equal(report.weightsRandom, false, 'weights=random ⇒ Architektur gelaufen, aber keine Separation');
  assert.ok(
    ['RELEASE_READY', 'TECHNICAL_PASS_QUALITY_FAIL', 'TECHNICAL_FAIL'].includes(report.releaseDecision),
    `undefinierte Release-Entscheidung: ${report.releaseDecision}`
  );
  console.log(`  ✓ Entscheidung: ${report.releaseDecision} (Score ${report.overallScore.toFixed(2)}/10, ${report.overallLabel})`);
  console.log(`  ✓ technische Prüfung ${report.technicalPass ? 'bestanden' : 'fehlgeschlagen'}, Qualität ${report.qualityPass ? 'bestanden' : 'unter den Grenzwerten'}`);
  if (report.releaseDecision !== 'RELEASE_READY') {
    console.log('  ℹ Das ist ein Messergebnis, kein Testfehler. Nicht bestandenechecks:');
    for (const check of report.checks.filter((c) => !c.pass)) console.log(`     ✘ ${check.id}: ${check.detail}`);
  }

  // ---- [4] Original-Integrität auf dem Freigabe-Lauf ----------------------------
  console.log('\n[ TEST ] #4 Original (Mix) unverändert – sha256 vor/nach');
  assert.equal(report.originalHashAfter, report.originalHashBefore, 'Original wurde verändert – Freigabe unmöglich');
  console.log(`  ✓ ${report.originalHashBefore.slice(0, 24)}…`);

  // ---- [5] Alle vier Stems existieren technisch --------------------------------
  console.log('\n[ TEST ] #5 Vier Stems, 44,1 kHz Stereo, endliche Samples, gelesen aus test_run/separated');
  const expectedStems = descriptor.stemOrder;
  assert.equal(report.rows.length, expectedStems.length, `Gate hat ${report.rows.length} statt ${expectedStems.length} Stems bewertet`);
  for (const stemId of expectedStems) {
    const file = path.join(outRoot, 'test_run', 'separated', `${stemId}.wav`);
    assert.ok(await exists(file), `Stem-Datei fehlt: ${file}`);
    const decoded = await readWavFile(file);
    assert.equal(decoded.sampleRate, descriptor.sampleRate, `${stemId}: Samplerate`);
    assert.equal(decoded.channels, descriptor.inputChannels, `${stemId}: Kanäle`);
    assert.ok(decoded.frames > 0 && Number.isFinite(decoded.frames), `${stemId}: Framezahl`);
    let finite = true;
    for (const sample of decoded.data) {
      if (!Number.isFinite(sample)) {
        finite = false;
        break;
      }
    }
    assert.ok(finite, `${stemId}: nicht-endliche Samples in der Ausgabe`);
  }
  console.log(`  ✓ ${expectedStems.join(', ')} (je ${descriptor.sampleRate} Hz / ${descriptor.inputChannels} Kanäle)`);

  // ---- [6] Messwerte liegen im plausiblen Bereich um den publizierten SDRs -----
  console.log('\n[ TEST ] #6 Messwerte gegen die publizierten Referenz-SDRs (Plausibilität)');
  const tolerance = Number(process.env.AIRODOX_STEM_GATE_SDR_TOLERANCE ?? '4');
  const table: Record<string, { siSdrDb: number; published: number | undefined; withinBand: boolean }> = {};
  for (const row of report.rows) {
    const measured = row.metrics.siSdrDb;
    const published = PUBLISHED_SDR[row.stemId];
    const withinBand = published === undefined ? true : Number.isFinite(measured) && measured >= published - tolerance;
    table[row.stemId] = { siSdrDb: Number(measured.toFixed(2)), published, withinBand };
    console.log(
      `  ${row.stemId.padEnd(7)} SI-SDR ${measured.toFixed(2).padStart(7)} dB · publiziert ${published ?? 'n/a'} dB · ` +
        (withinBand ? 'im erwarteten Band' : `> ${tolerance} dB darunter (andere Gewichte/Config?)`)
    );
    assert.ok(withinBand, `${row.stemId}: SI-SDR ${measured.toFixed(2)} dB liegt unplausibel weit unter dem publizierten Wert ${published} dB`);
  }

  // ---- [7] Bericht vollständig abgelegt (maschinell auswertbar) -----------------
  console.log('\n[ TEST ] #7 Bericht + Metriken geschrieben (§26)');
  const metricsFile = path.join(outRoot, 'test_run', 'metrics', 'metrics.json');
  assert.ok(await exists(metricsFile), 'metrics.json fehlt');
  const written = JSON.parse(await readFile(metricsFile, 'utf8')) as { releaseDecision: string; rows: unknown[] };
  assert.equal(written.releaseDecision, report.releaseDecision, 'metriken.json weicht vom Bericht ab');
  assert.ok(written.rows.length === expectedStems.length, 'Metrikzeilen unvollständig');
  const summaryPath = path.join(outRoot, 'stem-gate-summary.json');
  await writeFile(
    summaryPath,
    JSON.stringify(
      {
        modelId: MODEL_ID,
        checkpoint: descriptor.checkpoint!.file,
        measuredSha256: actualHash,
        catalogModelHash: catalogHash ?? null,
        profile,
        device,
        precision,
        variant: report.variant,
        releaseDecision: report.releaseDecision,
        technicalPass: report.technicalPass,
        qualityPass: report.qualityPass,
        overallScore: Number(report.overallScore.toFixed(3)),
        recombinationErrorDb: Number.isFinite(report.recombinationErrorDb) ? Number(report.recombinationErrorDb.toFixed(2)) : null,
        originalHashBefore: report.originalHashBefore,
        originalHashAfter: report.originalHashAfter,
        seconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
        siSdrByStem: table,
        checks: report.checks.map((c) => ({ id: c.id, pass: c.pass, detail: c.detail })),
      },
      null,
      2
    ) + '\n'
  );
  console.log(`  ✓ ${metricsFile}`);
  console.log(`  ✓ ${summaryPath}`);

  console.log(`\n✔ FREIGABE-LAUF ABGESCHLOSSEN: ${report.releaseDecision} (${((Date.now() - startedAt) / 1000).toFixed(1)} s)`);
  console.log('  Ergebnis ist ein Protokoll, kein Versprechen: RELEASE_READY gilt nur, wenn das');
  console.log('  Gate (Teil-2-Schwellen) bestanden wurde – und nur für genau diesen Checkpoint-Hash.');
  if (process.env.AIRODOX_STEM_GATE_FAIL_ON_QUALITY === '1' && report.releaseDecision !== 'RELEASE_READY') {
    console.error('\n✘ AIRODOX_STEM_GATE_FAIL_ON_QUALITY=1 gesetzt und das Gate ist nicht RELEASE_READY.');
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('\n✘ FEHLER:', error);
  process.exitCode = 1;
});
