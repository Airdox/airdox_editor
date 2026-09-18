/**
 * Stem-Architekturen – Daten und Regeln für das Einstellungsmenü.
 *
 * Dieses Modul ist absichtlich frei von Node-, Electron- und React-Abhängigkeiten
 * (nur Typen aus dem Transport-Vertrag), damit dieselbe Logik im Renderer, im
 * Test und im Dev-Server gilt. Es beantwortet:
 *
 *   1. Welche Architekturen gibt es?  -> `describeArchitectures(status.models)`
 *   2. Was bedeutet die Auswahl für einen Job? -> `resolveArchitectureJobOptions`
 *   3. Wie wird sie gespeichert? -> `load/saveStemArchitectureSettings`
 *   4. Wie lange rechnet eine Architektur für 5-Minuten-Tracks? -> `STEM_ARCHITECTURE_BENCHMARKS`
 *   5. Wo liegen Installations- & Stem-Pfade? -> `load/saveWorkspacePathSettings`
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

/**
 * Benchmark- und Rechenzeitangaben für einen 5-Minuten-Referenztitel.
 * Ermöglicht DJs und Produzenten die direkte Einschätzung von Rechenzeit,
 * Hardwarerequirement und SDR-Qualität.
 */
export interface StemArchitectureBenchmark {
  /** Ungefähre Rechenzeit für 5 Minuten Audio auf moderner GPU (DirectML / CUDA / TensorRT) */
  gpuTime: string;
  /** Ungefähre Rechenzeit für 5 Minuten Audio auf CPU (Multi-Core x86_64 / AVX2) */
  cpuTime: string;
  /** Typischer Geschwindigkeitsfaktor bezogen auf Echtzeit (z.B. "5× bis 6× Echtzeit") */
  realtimeFactor: string;
  /** Signal-to-Distortion Ratio (SDR) Quelltrennungswert in dB */
  sdrScore: string;
  /** Benötigter GPU-Grafikspeicher */
  vram: string;
  /** Benötigter Arbeitsspeicher */
  memory: string;
  /** Qualitätsstufe */
  qualityLevel: 'STUDIO_MASTER' | 'HIGH_PRECISION' | 'LIVE_PERFORMANCE' | 'EXPERIMENTAL';
  /** Empfohlener Einsatzzweck (z.B. Live-DJ vs. Studio Mastering) */
  useCase: string;
  /** Kompakte Zusammenfassung */
  summary: string;
}

export const STEM_ARCHITECTURE_BENCHMARKS: Record<string, StemArchitectureBenchmark> = {
  'bsroformer-musdb18hq-4stem-zfturbo': {
    gpuTime: '~45–75 Sek.',
    cpuTime: '~3–5 Min.',
    realtimeFactor: 'ca. 5×–6× Echtzeit (GPU)',
    sdrScore: '9.65 dB SDR (Gold-Standard)',
    vram: '~2.5 GB VRAM',
    memory: '~4 GB RAM',
    qualityLevel: 'STUDIO_MASTER',
    useCase: 'Studio-Mastering & High-End 4-Stem Separation (Vocals, Drums, Bass, Other). Maximale spektrale Trennschärfe ohne Artefakte.',
    summary: 'Referenzmodell für professionelle Audioproduktion und Mastering mit höchster Quelltrennung.',
  },
  'bsroformer-viperx-vocals-1297': {
    gpuTime: '~25–40 Sek.',
    cpuTime: '~2–3.5 Min.',
    realtimeFactor: 'ca. 8×–12× Echtzeit (GPU)',
    sdrScore: '12.97 dB SDR (Ultra-Clean)',
    vram: '~2.0 GB VRAM',
    memory: '~3.5 GB RAM',
    qualityLevel: 'STUDIO_MASTER',
    useCase: 'Perfekte Gesangsisolation (Acapella) und residualer Instrumental-Track. Extrem saubere Mitten und Höhen.',
    summary: 'Spezialisiert auf Vocals-Extraktion in Studio-Qualität mit höchstem Signal-Rausch-Verhältnis.',
  },
  'melbandroformer-viperx-vocals-3005': {
    gpuTime: '~30–50 Sek.',
    cpuTime: '~2.5–4 Min.',
    realtimeFactor: 'ca. 6×–10× Echtzeit (GPU)',
    sdrScore: '11.43 dB SDR',
    vram: '~2.2 GB VRAM',
    memory: '~3.5 GB RAM',
    qualityLevel: 'HIGH_PRECISION',
    useCase: 'Mel-Band-RoFormer-Architektur für Vocal/Instrumental-A/B-Vergleiche mit dynamischen Frequenzbändern.',
    summary: 'Moderne Mel-Frequenz-basierte RoFormer-Alternative.',
  },
  'htdemucs-onnx-4stem-fp16': {
    gpuTime: '~12–25 Sek.',
    cpuTime: '~45–90 Sek.',
    realtimeFactor: 'ca. 12×–25× Echtzeit (DirectML / GPU)',
    sdrScore: '8.80 dB SDR (Sehr gut)',
    vram: '~1.0 GB VRAM',
    memory: '~1.5 GB RAM',
    qualityLevel: 'LIVE_PERFORMANCE',
    useCase: 'Ultra-schneller Live-DJ-Betrieb und spontane Stem-Separation während der Performance. Läuft in-process ohne Python-Subprozess.',
    summary: 'Optimiert für maximale Geschwindigkeit, minimale Latenz und geringen Ressourcenverbrauch.',
  },
  'htdemucs-ft-4stem': {
    gpuTime: '~35–60 Sek.',
    cpuTime: '~2.5–5 Min.',
    realtimeFactor: 'ca. 5×–8× Echtzeit (GPU)',
    sdrScore: '7.90 dB SDR',
    vram: '~2.0 GB VRAM',
    memory: '~3.5 GB RAM',
    qualityLevel: 'HIGH_PRECISION',
    useCase: 'Meta HT-Demucs Fine-Tuned PyTorch Modell. 4 Stems (Drums, Bass, Other, Vocals).',
    summary: 'Bewährte Demucs-Architektur für historische Kompatibilität und Vergleiche.',
  },
  'pipeline-double-v1': {
    gpuTime: '< 1 Sek.',
    cpuTime: '< 1 Sek.',
    realtimeFactor: '> 100× Echtzeit',
    sdrScore: 'Synthetisch',
    vram: '< 100 MB',
    memory: '< 100 MB',
    qualityLevel: 'EXPERIMENTAL',
    useCase: 'Nur für automatisierte Integrationstests und Entwicklungsumgebungen.',
    summary: 'Deterministisches Test-Double ohne neuronale Inferenz.',
  },
  'auto': {
    gpuTime: '~15–75 Sek.',
    cpuTime: '~1–4 Min.',
    realtimeFactor: 'Modusabhängig (Live bis Studio)',
    sdrScore: '8.80 – 9.65 dB SDR',
    vram: '~1.0–2.5 GB VRAM',
    memory: '~2–4 GB RAM',
    qualityLevel: 'STUDIO_MASTER',
    useCase: 'Automatische Auswahl: Studio-Profil nutzt BS-RoFormer (9.65 SDR), Live/Vorschau nutzt das schnelle ONNX-Modell.',
    summary: 'Wählt dynamisch das beste installierte Modell für das aktuelle Profil.',
  },
};

export function getArchitectureBenchmark(modelIdOrFamily: string): StemArchitectureBenchmark {
  return (
    STEM_ARCHITECTURE_BENCHMARKS[modelIdOrFamily] ||
    STEM_ARCHITECTURE_BENCHMARKS['auto']
  );
}

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
  /** Rechenzeit- und Leistungsdaten für 5 Minuten Audio */
  benchmark5Min: StemArchitectureBenchmark;
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
      benchmark5Min: getArchitectureBenchmark('auto'),
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
      benchmark5Min: getArchitectureBenchmark(model.id),
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
export const WORKSPACE_PATHS_STORAGE_KEY = 'airdox.workspacePaths';
export const INITIAL_SETUP_COMPLETED_KEY = 'airdox.initialSetupCompleted';

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

/**
 * Einstellungen für Installationspfade und Stem-Datenverzeichnisse.
 */
export interface WorkspacePathSettings {
  /** Wo Anwendungsdaten, Projekte und Exporte gespeichert werden */
  appProjectsPath: string;
  /** Wo KI-Modelle, Checkpoints, Python-Runtime und Stem-Caches liegen */
  stemDataPath: string;
  /** Ob die Ersteinrichtung erfolgreich abgeschlossen wurde */
  setupCompleted: boolean;
}

export const DEFAULT_WORKSPACE_PATH_SETTINGS: WorkspacePathSettings = {
  appProjectsPath: typeof process !== 'undefined' && process.env?.USERPROFILE
    ? `${process.env.USERPROFILE}\\airdox_SMART_Editor\\Projects`
    : '~/airdox_projects',
  stemDataPath: typeof process !== 'undefined' && process.env?.APPDATA
    ? `${process.env.APPDATA}\\airdox_SMART_Editor\\stems`
    : '~/airdox_stems',
  setupCompleted: false,
};

export function loadWorkspacePathSettings(storage?: SettingsStorageLike | null): WorkspacePathSettings {
  if (!storage) return { ...DEFAULT_WORKSPACE_PATH_SETTINGS };
  try {
    const raw = storage.getItem(WORKSPACE_PATHS_STORAGE_KEY);
    const completedRaw = storage.getItem(INITIAL_SETUP_COMPLETED_KEY);
    if (!raw) {
      return {
        ...DEFAULT_WORKSPACE_PATH_SETTINGS,
        setupCompleted: completedRaw === 'true',
      };
    }
    const parsed = JSON.parse(raw) as Partial<WorkspacePathSettings>;
    return {
      appProjectsPath:
        typeof parsed.appProjectsPath === 'string' && parsed.appProjectsPath.trim().length > 0
          ? parsed.appProjectsPath
          : DEFAULT_WORKSPACE_PATH_SETTINGS.appProjectsPath,
      stemDataPath:
        typeof parsed.stemDataPath === 'string' && parsed.stemDataPath.trim().length > 0
          ? parsed.stemDataPath
          : DEFAULT_WORKSPACE_PATH_SETTINGS.stemDataPath,
      setupCompleted: completedRaw === 'true' || Boolean(parsed.setupCompleted),
    };
  } catch {
    return { ...DEFAULT_WORKSPACE_PATH_SETTINGS };
  }
}

export function saveWorkspacePathSettings(storage: SettingsStorageLike | null | undefined, settings: WorkspacePathSettings): void {
  if (!storage) return;
  try {
    storage.setItem(WORKSPACE_PATHS_STORAGE_KEY, JSON.stringify(settings));
    if (settings.setupCompleted) {
      storage.setItem(INITIAL_SETUP_COMPLETED_KEY, 'true');
    }
  } catch {
    /* Ignorieren wenn Speicher nicht zugänglich */
  }
}
