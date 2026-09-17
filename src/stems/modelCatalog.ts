import type { StemId } from './types';
import { DSP_SEPARATOR_ENGINE, DSP_STEM_LABELS, DSP_STEM_ORDER } from './dspSeparator';

/**
 * Modell-Katalog der Stem-Gewichte.
 *
 * Zwei Klassen von „Engine“:
 *
 *  1. `requiresExternalRuntime: true`  – echte trainierte Gewichte
 *     (BS-RoFormer, Mel-Band-RoFormer, MDX-Net, Demucs). Sie werden von der
 *     Python-CLI `audio-separator` geladen und inferiert; die Gewichte liegen
 *     im Modell-Ordner der Desktop-App (see `electron/stemModelStore.cjs`).
 *     `stemOrder: null` heißt: die endgültige Stem-Liste meldet die CLI zur
 *     Laufzeit (Modell-Liste bzw. Dateinamen der Ausgabe).
 *  2. `requiresExternalRuntime: false` – die eingebaute Heuristik
 *     (`dsp-heuristic-v1`). Läuft überall, braucht keine Gewichte, ist aber
 *     ausdrücklich kein KI-Ergebnis.
 *
 * Der Katalog ist bewusst isomorph (kein Node-Import): Renderer, Electron-Bridge
 * und Tests arbeiten mit denselben Modell-Ids.
 */

export type StemModelArchitecture =
  | 'BS_ROFORMER'
  | 'MEL_BAND_ROFORMER'
  | 'MDX_NET'
  | 'VR_ARCH'
  | 'DEMUCS'
  | 'HEURISTIC_DSP';

export interface StemModelEntry {
  /** Stabile, interne Id (für Auswahl, Projektdatei und Logs). */
  id: string;
  /** Dateiname der Gewichte, wie ihn `--model_filename` erwartet. */
  fileName: string | null;
  label: string;
  architecture: StemModelArchitecture;
  /** `null` = Stem-Liste wird zur Laufzeit von der Inferenz gemeldet. */
  stemOrder: StemId[] | null;
  trainedModel: boolean;
  requiresExternalRuntime: boolean;
  /** Empfehlung für den DJ-Alltag (Vocals/Instrumental schnell & gut). */
  recommended: boolean;
  /** Kurze, ehrliche Einordnung der erwarteten Qualität/Kosten. */
  qualityHint: string;
  /** Bekannte Lizenz der Gewichte (soweit öffentlich dokumentiert). */
  license?: string;
  /**
   * Offizielle Direkt-URL, falls der Download nicht von der CLI übernommen
   * wird. `null` = die CLI lädt die Gewichte selbst in den Modell-Ordner.
   */
  downloadUrl?: string | null;
  /** Ungefähre Größe der Gewichte in MB (Anzeige im UI, keine Prüfung). */
  approximateSizeMb?: number;
  /** Empfohlenes Profil für die Inferenz. */
  profile: 'PREVIEW' | 'HIGH_QUALITY';
}

/** Eingebaute Heuristik – immer verfügbar, niemals als KI-Modell ausgegeben. */
export const BUILTIN_HEURISTIC_MODEL: StemModelEntry = {
  id: DSP_SEPARATOR_ENGINE,
  fileName: null,
  label: 'Interne Heuristik (DSP, ohne Gewichte)',
  architecture: 'HEURISTIC_DSP',
  stemOrder: [...DSP_STEM_ORDER],
  trainedModel: false,
  requiresExternalRuntime: false,
  recommended: false,
  qualityHint:
    'Mid/Side-Extraktion + Transienten-Gate + Frequenzweiche. Läuft sofort und überall, ist aber kein trainiertes Modell – hörbar weniger sauber als RoFormer/Demucs.',
  profile: 'PREVIEW',
};

/**
 * Kuratierte Auswahl öffentlich dokumentierter Gewichte, die `audio-separator`
 * unterstützt. Die Stem-Reihenfolge steht nur dort fest, wo sie öffentlich
 * dokumentiert ist; sonst meldet die Laufzeit die tatsächlichen Stems.
 */
export const TRAINED_MODEL_CATALOG: readonly StemModelEntry[] = [
  {
    id: 'bsroformer-ep317-sdr12-9755',
    fileName: 'model_bs_roformer_ep_317_sdr_12.9755.ckpt',
    label: 'BS-RoFormer (ep317, SDR 12.98)',
    architecture: 'BS_ROFORMER',
    stemOrder: ['vocals', 'other'],
    trainedModel: true,
    requiresExternalRuntime: true,
    recommended: true,
    qualityHint: 'Referenzklasse für Vocal/Instrumental-Trennung, hoher Speicher- und Rechenbedarf.',
    license: 'MIT (Checkpoint gemäß Upstream-Repository)',
    downloadUrl: null,
    approximateSizeMb: 260,
    profile: 'HIGH_QUALITY',
  },
  {
    id: 'melband-roformer-ep3005-sdr11-4360',
    fileName: 'model_mel_band_roformer_ep_3005_sdr_11.4360.ckpt',
    label: 'Mel-Band-RoFormer (ep3005, SDR 11.44)',
    architecture: 'MEL_BAND_ROFORMER',
    stemOrder: ['vocals', 'other'],
    trainedModel: true,
    requiresExternalRuntime: true,
    recommended: true,
    qualityHint: 'Standardmodell der audio-separator-CLI; sehr gute Vocals, etwas schneller als BS-RoFormer.',
    license: 'MIT (Checkpoint gemäß Upstream-Repository)',
    downloadUrl: null,
    approximateSizeMb: 220,
    profile: 'HIGH_QUALITY',
  },
  {
    id: 'mdxnet-inst-hq3',
    fileName: 'UVR-MDX-NET-Inst_HQ_3.onnx',
    label: 'MDX-Net Inst HQ 3',
    architecture: 'MDX_NET',
    stemOrder: ['vocals', 'other'],
    trainedModel: true,
    requiresExternalRuntime: true,
    recommended: false,
    qualityHint: 'Schnell und CPU-freundlich (ONNX), gute Instrumental-/Vocal-Trennung für Vorhören.',
    license: 'MIT (UVR-Modellliste)',
    downloadUrl: null,
    approximateSizeMb: 60,
    profile: 'PREVIEW',
  },
  {
    id: 'mdxnet-kara-2',
    fileName: 'UVR_MDXNET_KARA_2.onnx',
    label: 'MDX-Net Karaoke 2',
    architecture: 'MDX_NET',
    stemOrder: null,
    trainedModel: true,
    requiresExternalRuntime: true,
    recommended: false,
    qualityHint: 'Karaoke-Modell: trennt Lead- und Backing-Vocals; Stem-Liste meldet die Laufzeit.',
    license: 'MIT (UVR-Modellliste)',
    downloadUrl: null,
    approximateSizeMb: 60,
    profile: 'PREVIEW',
  },
  {
    id: 'htdemucs-4stem',
    fileName: 'htdemucs',
    label: 'HT-Demucs (4 Stems)',
    architecture: 'DEMUCS',
    stemOrder: ['drums', 'bass', 'other', 'vocals'],
    trainedModel: true,
    requiresExternalRuntime: true,
    recommended: true,
    qualityHint: 'Echte 4-Stem-Trennung (Drums/Bass/Other/Vocals), PyTorch-Laufzeit erforderlich.',
    license: 'MIT (Demucs)',
    downloadUrl: null,
    approximateSizeMb: 80,
    profile: 'HIGH_QUALITY',
  },
  {
    id: 'htdemucs-ft-4stem',
    fileName: 'htdemucs_ft',
    label: 'HT-Demucs FT (4 Stems, fine-tuned)',
    architecture: 'DEMUCS',
    stemOrder: ['drums', 'bass', 'other', 'vocals'],
    trainedModel: true,
    requiresExternalRuntime: true,
    recommended: false,
    qualityHint: 'Feinabgestimmte Demucs-Variante: bessere Qualität, rund vierfache Laufzeit.',
    license: 'MIT (Demucs)',
    downloadUrl: null,
    approximateSizeMb: 320,
    profile: 'HIGH_QUALITY',
  },
  {
    id: 'htdemucs-6stem',
    fileName: 'htdemucs_6s',
    label: 'HT-Demucs 6S (6 Stems)',
    architecture: 'DEMUCS',
    stemOrder: ['drums', 'bass', 'other', 'vocals', 'guitar', 'piano'],
    trainedModel: true,
    requiresExternalRuntime: true,
    recommended: false,
    qualityHint: 'Sechs Stems inkl. Guitar/Piano; höchster Rechenbedarf im Katalog.',
    license: 'MIT (Demucs)',
    downloadUrl: null,
    approximateSizeMb: 380,
    profile: 'HIGH_QUALITY',
  },
];

export const STEM_MODEL_CATALOG: readonly StemModelEntry[] = [...TRAINED_MODEL_CATALOG, BUILTIN_HEURISTIC_MODEL];

/** Id, mit der die Desktop-App startet, wenn der Nutzer nichts wählt. */
export const DEFAULT_TRAINED_MODEL_ID = 'melband-roformer-ep3005-sdr11-4360';

export function findStemModel(id: string | null | undefined): StemModelEntry | undefined {
  if (!id) return undefined;
  return STEM_MODEL_CATALOG.find((entry) => entry.id === id);
}

/** Auflösung über Id oder Dateinamen (die CLI arbeitet mit Dateinamen). */
export function findStemModelByFileName(fileName: string | null | undefined): StemModelEntry | undefined {
  if (!fileName) return undefined;
  const normalized = String(fileName).trim().toLowerCase();
  return STEM_MODEL_CATALOG.find((entry) => entry.fileName?.toLowerCase() === normalized);
}

export function trainedModels(): StemModelEntry[] {
  return STEM_MODEL_CATALOG.filter((entry) => entry.trainedModel);
}

export function builtinModels(): StemModelEntry[] {
  return STEM_MODEL_CATALOG.filter((entry) => !entry.requiresExternalRuntime);
}

export function stemLabelsFor(ids: readonly StemId[] | null): string[] {
  if (!ids || !ids.length) return [];
  return ids.map((id) => DSP_STEM_LABELS[id] ?? id);
}

/**
 * Von der Laufzeit gemeldete Modell-Liste (z. B. `audio-separator -l
 * --list_format=json`) in den kuratierten Katalog einarbeiten: bekannte
 * Einträge werden bestätigt, unbekannte als „von der CLI gemeldet“ ergänzt.
 */
export interface RuntimeModelInfo {
  fileName: string;
  stemNames?: string[];
  architecture?: string;
  modelSize?: number;
  trainable?: boolean;
}

export function mergeRuntimeModels(runtimeModels: readonly RuntimeModelInfo[], catalog: readonly StemModelEntry[] = STEM_MODEL_CATALOG): StemModelEntry[] {
  const merged: StemModelEntry[] = catalog.map((entry) => ({ ...entry }));
  const known = new Set(merged.map((entry) => entry.fileName?.toLowerCase()).filter(Boolean));
  for (const runtime of runtimeModels) {
    const fileName = String(runtime.fileName ?? '').trim();
    if (!fileName || known.has(fileName.toLowerCase())) continue;
    known.add(fileName.toLowerCase());
    merged.push({
      id: `runtime-${fileName.replace(/[^a-zA-Z0-9._-]+/g, '-').toLowerCase()}`,
      fileName,
      label: fileName.replace(/\.[^.]+$/, ''),
      architecture: (runtime.architecture as StemModelArchitecture) ?? 'VR_ARCH',
      stemOrder: runtime.stemNames && runtime.stemNames.length ? runtime.stemNames.map((name) => name.toLowerCase() as StemId) : null,
      trainedModel: true,
      requiresExternalRuntime: true,
      recommended: false,
      qualityHint: 'Von der installierten Separator-CLI gemeldetes Modell (nicht kuratiert).',
      downloadUrl: null,
      approximateSizeMb: runtime.modelSize ? Math.round(runtime.modelSize) : undefined,
      profile: 'HIGH_QUALITY',
    });
  }
  return merged;
}
