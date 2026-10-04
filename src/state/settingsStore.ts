/**
 * Anwendungs-Einstellungen: Aufnahme-Voreinstellungen und Bearbeitungsverhalten.
 *
 * Warum diese Datei existiert:
 *   Die Einstellungen lagen als einzelne `useState`-Zeilen zwischen Recorder-,
 *   Stem- und Ansichts-Zustand in `App.tsx`, und die Persistenz hing als
 *   Effekt mitten im JSX-Text. Schlüsselnamen und Feldliste waren dort zweimal
 *   aufgeführt (Lesen und Schreiben) – ein Tippfehler hätte still eine
 *   Einstellung verloren. Hier stehen Schlüssel und Feldliste an einer Stelle.
 *
 *   Zerlegung WP-06, Schritt 2. Übertragen, nicht umgeschrieben: Standardwerte,
 *   Speicherformat und Verhalten sind unverändert; die Setter behalten ihre
 *   Namen, damit die Aufrufstellen in `App.tsx` unangetastet bleiben.
 */

import { useEffect, useState } from 'react';
import type { RecorderFormat } from '../components/Modals/RecorderModal';

/** Tonquelle der Aufnahme. */
export type RecordingSource = 'EDITOR_MASTER' | 'AUDIO_INPUT' | 'SYSTEM_LOOPBACK';

/** Speicher, wie ihn Browser/Electron im Renderer bereitstellen. */
export interface SettingsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const SETTINGS_STORAGE_KEY = 'airdox.settings';
export const RECORDING_SOURCE_STORAGE_KEY = 'airdox.recordingSource';

/** Teil der Einstellungen, der in `airdox.settings` landet. */
export interface PersistedSettings {
  recordingSource: RecordingSource;
  recordingFormat: RecorderFormat;
  recordingSampleRate: 44100 | 48000;
  recordingBitDepth: 16 | 24 | 32;
  recordingChannels: 'STEREO' | 'MONO';
  recordingLimiter: boolean;
  confirmDestructiveEdits: boolean;
  autoSaveProject: boolean;
}

export const DEFAULT_PERSISTED_SETTINGS: PersistedSettings = {
  recordingSource: 'EDITOR_MASTER',
  recordingFormat: 'WAV',
  recordingSampleRate: 48000,
  recordingBitDepth: 24,
  recordingChannels: 'STEREO',
  recordingLimiter: true,
  confirmDestructiveEdits: true,
  autoSaveProject: false,
};

/** Liest die zuletzt gespeicherte Tonquelle (eigener Schlüssel, s. u.). */
export function loadRecordingSource(storage: SettingsStorage | null | undefined): RecordingSource {
  try {
    const raw = storage?.getItem(RECORDING_SOURCE_STORAGE_KEY);
    if (raw === 'EDITOR_MASTER' || raw === 'AUDIO_INPUT' || raw === 'SYSTEM_LOOPBACK') return raw;
  } catch {
    /* Privater Modus o. Ä. – Standardwert ist richtig. */
  }
  return DEFAULT_PERSISTED_SETTINGS.recordingSource;
}

/** Liest die gespeicherten Einstellungen und ergänzt fehlende Felder. */
export function loadPersistedSettings(storage: SettingsStorage | null | undefined): PersistedSettings {
  const settings: PersistedSettings = {
    ...DEFAULT_PERSISTED_SETTINGS,
    recordingSource: loadRecordingSource(storage),
  };
  try {
    const raw = storage?.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return settings;
    const parsed = JSON.parse(raw) as Partial<PersistedSettings>;
    return { ...settings, ...parsed, recordingSource: settings.recordingSource };
  } catch {
    return settings;
  }
}

/**
 * Schreibt beide Schlüssel.
 *
 * Die Tonquelle liegt bewusst zusätzlich in einem eigenen Schlüssel: sie wird
 * auch von anderen Teilen gelesen (u. a. beim Start der Aufnahme), und das
 * bisherige Format bleibt so kompatibel.
 */
export function savePersistedSettings(
  storage: SettingsStorage | null | undefined,
  settings: PersistedSettings
): void {
  try {
    storage?.setItem(RECORDING_SOURCE_STORAGE_KEY, settings.recordingSource);
    storage?.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        recordingSource: settings.recordingSource,
        recordingFormat: settings.recordingFormat,
        recordingSampleRate: settings.recordingSampleRate,
        recordingBitDepth: settings.recordingBitDepth,
        recordingChannels: settings.recordingChannels,
        recordingLimiter: settings.recordingLimiter,
        confirmDestructiveEdits: settings.confirmDestructiveEdits,
        autoSaveProject: settings.autoSaveProject,
      })
    );
  } catch {
    /* Persistenz ist Komfort, kein Pfand. */
  }
}

export interface AppSettings extends PersistedSettings {
  /** Ansicht folgt dem Playhead. */
  autoScroll: boolean;
  /** Hochwertige Zeichnung (Antialiasing/Filter) statt schneller Darstellung. */
  highQualityRendering: boolean;
  /** Auswahl rastet am Beatgrid ein. */
  snapToBeatgrid: boolean;
}

export interface AppSettingsControls extends AppSettings {
  setRecordingSource: (value: RecordingSource) => void;
  setRecordingFormat: (value: RecorderFormat) => void;
  setRecordingSampleRate: (value: 44100 | 48000) => void;
  setRecordingBitDepth: (value: 16 | 24 | 32) => void;
  setRecordingChannels: (value: 'STEREO' | 'MONO') => void;
  setRecordingLimiter: (value: boolean) => void;
  setConfirmDestructiveEdits: (value: boolean) => void;
  setAutoSaveProject: (value: boolean) => void;
  setAutoScroll: (value: boolean) => void;
  setHighQualityRendering: (value: boolean) => void;
  setSnapToBeatgrid: (value: boolean) => void;
}

/**
 * Hält die Einstellungen und schreibt sie bei jeder Änderung weg.
 *
 * Zuvor stand das in `App.tsx`: sechs `useState`-Zeilen für die Aufnahme, zwei
 * für das Bearbeitungsverhalten und ein Effekt, der beide Schlüssel schrieb.
 */
export function useAppSettings(storage?: SettingsStorage | null): AppSettingsControls {
  const target = storage === undefined && typeof window !== 'undefined' ? window.localStorage : storage ?? null;
  const [initial] = useState(() => loadPersistedSettings(target));

  const [recordingSource, setRecordingSource] = useState<RecordingSource>(initial.recordingSource);
  const [recordingFormat, setRecordingFormat] = useState<RecorderFormat>(initial.recordingFormat);
  const [recordingSampleRate, setRecordingSampleRate] = useState<44100 | 48000>(initial.recordingSampleRate);
  const [recordingBitDepth, setRecordingBitDepth] = useState<16 | 24 | 32>(initial.recordingBitDepth);
  const [recordingChannels, setRecordingChannels] = useState<'STEREO' | 'MONO'>(initial.recordingChannels);
  const [recordingLimiter, setRecordingLimiter] = useState<boolean>(initial.recordingLimiter);
  const [confirmDestructiveEdits, setConfirmDestructiveEdits] = useState<boolean>(initial.confirmDestructiveEdits);
  const [autoSaveProject, setAutoSaveProject] = useState<boolean>(initial.autoSaveProject);
  const [autoScroll, setAutoScroll] = useState<boolean>(true);
  const [highQualityRendering, setHighQualityRendering] = useState<boolean>(true);
  const [snapToBeatgrid, setSnapToBeatgrid] = useState<boolean>(true);

  useEffect(() => {
    savePersistedSettings(target, {
      recordingSource,
      recordingFormat,
      recordingSampleRate,
      recordingBitDepth,
      recordingChannels,
      recordingLimiter,
      confirmDestructiveEdits,
      autoSaveProject,
    });
  }, [
    target,
    recordingSource,
    recordingFormat,
    recordingSampleRate,
    recordingBitDepth,
    recordingChannels,
    recordingLimiter,
    confirmDestructiveEdits,
    autoSaveProject,
  ]);

  return {
    recordingSource,
    setRecordingSource,
    recordingFormat,
    setRecordingFormat,
    recordingSampleRate,
    setRecordingSampleRate,
    recordingBitDepth,
    setRecordingBitDepth,
    recordingChannels,
    setRecordingChannels,
    recordingLimiter,
    setRecordingLimiter,
    confirmDestructiveEdits,
    setConfirmDestructiveEdits,
    autoSaveProject,
    setAutoSaveProject,
    autoScroll,
    setAutoScroll,
    highQualityRendering,
    setHighQualityRendering,
    snapToBeatgrid,
    setSnapToBeatgrid,
  };
}
