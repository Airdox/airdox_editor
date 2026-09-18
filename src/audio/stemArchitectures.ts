/**
 * Stem-Architekturen – Daten und Regeln für das Einstellungsmenü.
 *
 * Dieses Modul ist absichtlich frei von Node-, Electron- und React-Abhängigkeiten
 * (nur Typen aus dem Transport-Vertrag), damit dieselbe Logik im Renderer, im
 * Test und im Dev-Server gilt. Es beantwortet drei Fragen:
 *
 *   1. Welche Architekturen gibt es?  -> `describeArchitectures(status.models)`
 *   2. Was bedeutet die Auswahl für einen Job? -> `resolveArchitectureJobOptions`
 *   3. Wie wird sie gespeichert? -> `load/saveStemArchitectureSettings`
 *
 * Wichtig: Die Architektur ist eine *Voreinstellung*, keine Ausführung. Sie
 * wählt nur, welches Modell (bzw. welches Backend) ein Job bekommt; die
 * eigentliche Auflösung bleibt beim Engine-Katalog, inklusive Fehlermeldungen.
 */
import type { StemComputeDevice, StemServiceStatus, StemValidationMode } from '../stems/transportTypes';

/** `auto` = Profil entscheidet, sonst eine Modell-ID aus dem Katalog. */
export type StemArchitectureId = 'auto' | (string & {});

export interface StemArchitectureSettings {
  architectureId: StemArchitectureId;
  validationMode: StemValidationMode;
  device: StemComputeDevice;
}

export const DEFAULT_STEM_ARCHITECTURE_SETTINGS: StemArchitectureSettings = {
  architectureId: 'auto',
  // Live ist der Default des Editors (der Studio-Pfad bleibt bewusst wählbar).
  validationMode: 'fast_dj',
  device: 'auto',
};

export interface StemArchitectureOption {
  /** `auto` oder die Modell-ID. */
  id: string;
  modelId?: string;
  label: string;
  family: string;
  /** Eine Zeile Kontext für das Menü (Stems, Profile, Herkunft). */
  detail: string;
  installed: boolean;
  reason?: string;
  /** Läuft im Editor-Prozess (ONNX) statt in einem Python-Subprozess. */
  inProcess: boolean;
  stems: string[];
  serves: string[];
}

const FAMILY_LABEL: Record<string, string> = {
  bs_roformer: 'BS-RoFormer',
  mel_band_roformer: 'Mel-Band RoFormer',
  htdemucs: 'HT-Demucs',
  pipeline_double: 'Pipeline-Double',
};

const MODE_LABEL: Record<StemValidationMode, string> = {
  fast_dj: 'Live (fast_dj)',
  studio_master: 'Studio (studio_master)',
};

export const STEM_VALIDATION_MODES: StemValidationMode[] = ['fast_dj', 'studio_master'];

/** Auswahlmöglichkeiten für das Rechengerät inklusive Beschriftung. */
export const STEM_DEVICE_CHOICES: { id: StemComputeDevice; label: string; hint: string }[] = [
  { id: 'auto', label: 'Automatisch', hint: 'DirectML → CUDA/TensorRT → CoreML → CPU, je nach verfügbarer Runtime.' },
  { id: 'directml', label: 'DirectML (Windows GPU)', hint: 'DX12-GPU unter Windows (AMD, NVIDIA, Intel).' },
  { id: 'cuda', label: 'CUDA / TensorRT (NVIDIA)', hint: 'NVIDIA-GPU; TensorRT wird bevorzugt, wenn vorhanden.' },
  { id: 'coreml', label: 'CoreML (macOS)', hint: 'Apple-GPU/Neural Engine.' },
  { id: 'cpu', label: 'CPU erzwingen', hint: 'Immer korrekt, aber deutlich langsamer – gut zum Vergleich.' },
];

export function modeLabel(mode: StemValidationMode): string {
  return MODE_LABEL[mode];
}

/** Was das Einstellungsmenü über die Engine weiß (Transport + ONNX-Runtime). */
export interface StemArchitectureViewState {
  transport: 'desktop-ipc' | 'http' | 'unavailable';
  reason?: string;
  onnx?: StemServiceStatus['onnx'];
}

export interface StemDeviceChoice {
  id: StemComputeDevice;
  label: string;
  hint: string;
  available: boolean;
  reason?: string;
}

/** Gerät -> Provider-Namen, wie die ONNX-Runtime sie ausgibt. */
const DEVICE_PROVIDERS: Record<StemComputeDevice, string[]> = {
  auto: ['cpu'],
  cpu: ['cpu'],
  cuda: ['cuda', 'tensorrt'],
  directml: ['dml', 'directml'],
  coreml: ['coreml'],
  vulkan: ['vulkan'],
  metal: ['metal'],
};

/**
 * Geräteliste für die UI. Ohne Runtime-Info bleibt alles wählbar (die Engine
 * fällt intern auf CPU zurück); mit Runtime-Info werden Geräte, deren Provider
 * die installierte Runtime nicht mitbringt, als nicht verfügbar markiert –
 * inklusive Grund, statt eines Knopfes, der nie greift.
 */
export function deviceChoices(onnx?: StemServiceStatus['onnx']): StemDeviceChoice[] {
  const supported = onnx?.supported?.map((entry) => entry.name) ?? [];
  return STEM_DEVICE_CHOICES.map((choice) => {
    if (!onnx || choice.id === 'auto') {
      return { ...choice, available: true };
    }
    if (!onnx.runtimeAvailable) {
      return { ...choice, available: choice.id === 'cpu', reason: onnx.reason ?? 'ONNX-Runtime nicht verfügbar.' };
    }
    const providers = DEVICE_PROVIDERS[choice.id] ?? [];
    const hits = providers.filter((provider) => supported.includes(provider));
    if (hits.length) return { ...choice, available: true };
    return {
      ...choice,
      available: false,
      reason: `Runtime bringt ${providers.join('/')} nicht mit (vorhanden: ${supported.join(', ') || '—'}).`,
    };
  });
}

function labelForArchitecture(model: StemServiceStatus['models'][number]): string {
  const family = FAMILY_LABEL[model.family] ?? model.family;
  if (model.family === 'htdemucs' && model.format === 'onnx') return `${family} · Live (ONNX, in-process)`;
  if (model.family === 'htdemucs') return `${family} FT · Demucs (PyTorch)`;
  if (model.family === 'pipeline_double') return `${family} (nur Tests)`;
  const only = model.stems.length === 1 ? ` · ${model.stems[0]}` : '';
  return `${family}${only}`;
}

/**
 * Baut die Liste für das Einstellungsmenü. `auto` steht immer oben und ist
 * genau dann „installiert", wenn irgendein Modell benutzbar ist – so sieht der
 * Nutzer sofort, ob die Voreinstellung überhaupt greifen kann.
 */
export function describeArchitectures(
  models: StemServiceStatus['models'] = [],
  options: { includeTestDouble?: boolean } = {}
): StemArchitectureOption[] {
  const visible = models.filter((model) => options.includeTestDouble || model.family !== 'pipeline_double');
  const anyInstalled = visible.some((model) => model.installed);
  const list: StemArchitectureOption[] = [
    {
      id: 'auto',
      label: 'Automatisch (Profil entscheidet)',
      family: 'auto',
      detail: 'Je Profil das erste installierte Modell: Studio (BS-RoFormer) vor Vorschau (HT-Demucs).',
      installed: anyInstalled,
      reason: anyInstalled ? undefined : 'Noch kein Modell installiert – npm run stems:bundle (oder In-App-Installer).',
      inProcess: false,
      stems: [],
      serves: [],
    },
  ];
  for (const model of visible) {
    list.push({
      id: model.id,
      modelId: model.id,
      label: labelForArchitecture(model),
      family: model.family,
      detail: [
        model.stems.length ? `Stems: ${model.stems.join(', ')}` : 'Stems: —',
        model.serves.length ? `Profile: ${model.serves.join(', ')}` : undefined,
        model.version,
      ]
        .filter(Boolean)
        .join(' · '),
      installed: model.installed,
      reason: model.reason,
      inProcess: model.format === 'onnx',
      stems: [...model.stems],
      serves: [...model.serves],
    });
  }
  return list;
}

/**
 * Was ein Job aus der Auswahl machen soll.
 *
 * - `auto`: kein `modelId` – die Engine nimmt ihr Profil-Modell.
 * - sonst: genau dieses Modell. Ist es nicht installiert, lässt der Aufrufer
 *   den Nutzer entscheiden (das Menü zeigt den Grund), statt still umzubiegen.
 * - `mode`/`device` gehen immer mit; `device: 'auto'` erzeugt denselben
 *   Einstellungs-Hash wie ein fehlendes Feld, ändert den Cache-Key also nicht.
 */
export function resolveArchitectureJobOptions(
  settings: StemArchitectureSettings,
  options: { requireInstalled?: boolean } = {}
): { modelId?: string; mode: StemValidationMode; device: StemComputeDevice } {
  const { architectureId } = settings;
  if (!architectureId || architectureId === 'auto') {
    return { mode: settings.validationMode, device: settings.device };
  }
  void options;
  return { modelId: architectureId, mode: settings.validationMode, device: settings.device };
}

/** Anzeigename für Deck/Statuszeile, unabhängig vom dynamischen Status. */
export function architectureLabel(settings: StemArchitectureSettings, options: StemArchitectureOption[] = []): string {
  if (!settings.architectureId || settings.architectureId === 'auto') return 'Automatisch';
  return options.find((entry) => entry.id === settings.architectureId)?.label ?? settings.architectureId;
}

export interface SettingsStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const STEM_ARCHITECTURE_STORAGE_KEY = 'airdox.stemArchitecture';
const DEVICES: StemComputeDevice[] = ['auto', 'cpu', 'cuda', 'vulkan', 'metal', 'directml', 'coreml'];

function isMode(value: unknown): value is StemValidationMode {
  return value === 'fast_dj' || value === 'studio_master';
}

function isDevice(value: unknown): value is StemComputeDevice {
  return typeof value === 'string' && (DEVICES as string[]).includes(value);
}

/** Liest die Voreinstellung; kaputte Werte fallen auf den Default zurück. */
export function loadStemArchitectureSettings(storage?: SettingsStorageLike | null): StemArchitectureSettings {
  if (!storage) return { ...DEFAULT_STEM_ARCHITECTURE_SETTINGS };
  try {
    const raw = storage.getItem(STEM_ARCHITECTURE_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_STEM_ARCHITECTURE_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<StemArchitectureSettings>;
    return {
      architectureId:
        typeof parsed.architectureId === 'string' && parsed.architectureId.length > 0
          ? parsed.architectureId
          : DEFAULT_STEM_ARCHITECTURE_SETTINGS.architectureId,
      validationMode: isMode(parsed.validationMode) ? parsed.validationMode : DEFAULT_STEM_ARCHITECTURE_SETTINGS.validationMode,
      device: isDevice(parsed.device) ? parsed.device : DEFAULT_STEM_ARCHITECTURE_SETTINGS.device,
    };
  } catch {
    return { ...DEFAULT_STEM_ARCHITECTURE_SETTINGS };
  }
}

export function saveStemArchitectureSettings(storage: SettingsStorageLike | null | undefined, settings: StemArchitectureSettings): void {
  if (!storage) return;
  try {
    storage.setItem(STEM_ARCHITECTURE_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* Speicher voll/gesperrt: eine Voreinstellung darf den Editor nie stören. */
  }
}
