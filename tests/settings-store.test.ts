/**
 * Einstellungen: Speichern, Laden und Verhalten bei defekten Daten.
 *
 * Der Speicher ist hier ein einfaches Objekt-Double; der Test prüft damit die
 * Verträge, die in `App.tsx` zuvor zwischen zwei verstreuten Stellen standen:
 *   - Was geschrieben wird, muss beim nächsten Start wieder herauskommen.
 *   - Unbekannte oder beschädigte Daten dürfen den Start nicht verhindern.
 *   - Die Tonquelle liegt zusätzlich unter ihrem eigenen Schlüssel (Kompatibilität).
 */

import assert from 'node:assert/strict';
import {
  DEFAULT_PERSISTED_SETTINGS,
  RECORDING_SOURCE_STORAGE_KEY,
  SETTINGS_STORAGE_KEY,
  loadPersistedSettings,
  loadRecordingSource,
  savePersistedSettings,
  type PersistedSettings,
  type SettingsStorage,
} from '../src/state/settingsStore.ts';

function createStorage(initial: Record<string, string> = {}): SettingsStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

// 1. Ohne gespeicherte Daten gelten die Standardwerte.
{
  const settings = loadPersistedSettings(createStorage());
  assert.deepEqual(settings, DEFAULT_PERSISTED_SETTINGS);
}

// 2. Speichern und Laden ergibt dieselben Werte (voller Durchlauf).
{
  const storage = createStorage();
  const saved: PersistedSettings = {
    recordingSource: 'SYSTEM_LOOPBACK',
    recordingFormat: 'FLAC',
    recordingSampleRate: 44100,
    recordingBitDepth: 16,
    recordingChannels: 'MONO',
    recordingLimiter: false,
    confirmDestructiveEdits: false,
    autoSaveProject: true,
  };
  savePersistedSettings(storage, saved);

  assert.equal(storage.data[RECORDING_SOURCE_STORAGE_KEY], 'SYSTEM_LOOPBACK');
  assert.deepEqual(loadPersistedSettings(storage), saved);
}

// 3. Die Tonquelle steht zusätzlich im Einzelschlüssel – auch ohne
//    `airdox.settings` (ältere Ablage) bleibt sie erhalten.
{
  const storage = createStorage({ [RECORDING_SOURCE_STORAGE_KEY]: 'AUDIO_INPUT' });
  assert.equal(loadRecordingSource(storage), 'AUDIO_INPUT');
  assert.equal(loadPersistedSettings(storage).recordingSource, 'AUDIO_INPUT');
}

// 4. Beschädigte oder unbekannte Daten fallen auf die Standardwerte zurück,
//    statt den Start zu verhindern.
{
  const kaputt = createStorage({ [SETTINGS_STORAGE_KEY]: '{ das ist kein JSON' });
  assert.deepEqual(loadPersistedSettings(kaputt), DEFAULT_PERSISTED_SETTINGS);

  const fremd = createStorage({ [SETTINGS_STORAGE_KEY]: '{"unbekanntesFeld":42}' });
  const geladen = loadPersistedSettings(fremd);
  assert.equal(geladen.recordingFormat, DEFAULT_PERSISTED_SETTINGS.recordingFormat);
  assert.equal((geladen as Record<string, unknown>).unbekanntesFeld, 42, 'unbekannte Felder werden übernommen');

  const keinSpeicher = loadPersistedSettings(null);
  assert.deepEqual(keinSpeicher, DEFAULT_PERSISTED_SETTINGS);
}

// 5. Ein Speicher, der Ausnahmen wirft (privater Modus, voller Speicher),
//    darf weder Lesen noch Schreiben zum Absturz bringen.
{
  const bockig: SettingsStorage = {
    getItem() {
      throw new Error('Speicher gesperrt');
    },
    setItem() {
      throw new Error('Speicher voll');
    },
  };
  assert.deepEqual(loadPersistedSettings(bockig), DEFAULT_PERSISTED_SETTINGS);
  savePersistedSettings(bockig, DEFAULT_PERSISTED_SETTINGS); // darf nicht werfen
}

console.log('settings store: Laden, Speichern und Fehlerfälle sind vertragskonform');
