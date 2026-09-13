/**
 * @license
 * Rekordbox MIDI Manager & Hardware Controller Engine
 * Real Web MIDI API integration supporting Pioneer DDJ-FLX4, Pioneer DDJ-1000,
 * and standard MIDI devices with automatic detection, Action Pad mapping, and LED feedback.
 */

import {
  ControllerProfile,
  identifyControllerProfile,
  MidiAction,
  parsePioneerMidiMessage,
  getPioneerPadLedMessage,
} from './pioneerMappings';
import { StemType, StemsMixerState, STEM_TYPES } from '../audio/stemEngine';
import { logger } from '../utils/logger';

/**
 * Minimal structural Web MIDI typings. They keep this module compilable in
 * environments whose DOM lib does not ship Web MIDI definitions, and they are
 * structurally compatible with the browser implementation.
 */
interface WebMidiPort {
  id: string;
  name: string | null;
  manufacturer: string | null;
  state: string;
}

interface WebMidiInput extends WebMidiPort {
  onmidimessage: ((event: { data: Uint8Array | null }) => void) | null;
}

interface WebMidiOutput extends WebMidiPort {
  send(data: Uint8Array | number[]): void;
}

interface WebMidiAccess {
  inputs: { values(): IterableIterator<WebMidiInput> };
  outputs: { values(): IterableIterator<WebMidiOutput> };
  onstatechange: ((event: unknown) => void) | null;
}

interface MidiCapableNavigator {
  requestMIDIAccess(options?: { sysex?: boolean }): Promise<WebMidiAccess>;
}

export interface ConnectedMidiDevice {
  id: string;
  name: string;
  manufacturer: string;
  type: 'input' | 'output';
  state: 'connected' | 'disconnected';
  profile: ControllerProfile;
}

export interface MidiLogEntry {
  id: string;
  timestamp: number;
  direction: 'IN' | 'OUT';
  deviceName: string;
  bytes: number[];
  hex: string;
  actionSummary: string;
}

export type MidiActionHandler = (action: MidiAction) => void;

const MAX_LOG_ENTRIES = 50;

class MidiManager {
  private midiAccess: WebMidiAccess | null = null;
  private isInitialized: boolean = false;
  private isSupported: boolean =
    typeof navigator !== 'undefined' && 'requestMIDIAccess' in (navigator as object);

  private connectedInputs: Map<string, WebMidiInput> = new Map();
  private connectedOutputs: Map<string, WebMidiOutput> = new Map();
  private deviceProfiles: Map<string, ControllerProfile> = new Map();

  private actionHandlers: Set<MidiActionHandler> = new Set();
  private stateChangeListeners: Set<() => void> = new Set();
  private eventLog: MidiLogEntry[] = [];

  public async init(): Promise<boolean> {
    if (this.isInitialized) return true;
    if (!this.isSupported) {
      logger.warn('MIDI', 'Web MIDI API wird in diesem Browser/Environment nicht unterstützt.');
      return false;
    }

    try {
      this.midiAccess = await (navigator as unknown as MidiCapableNavigator).requestMIDIAccess({
        sysex: false,
      });
      this.isInitialized = true;

      // Scan existing devices
      this.scanDevices();

      // Listen for connection changes (plug / unplug)
      this.midiAccess.onstatechange = (event) => {
        const port = (event as unknown as { port?: { name?: string; state?: string; type?: string } }).port;
        logger.info('MIDI', `MIDI-Geräteänderung: ${port?.name || 'unbekannt'} (${port?.type || '?'}, ${port?.state || '?'})`);
        this.scanDevices();
        this.notifyStateChange();
      };

      logger.info(
        'MIDI',
        `MIDI initialisiert. Eingänge: ${this.connectedInputs.size}, Ausgänge: ${this.connectedOutputs.size}`,
        {
          inputs: Array.from(this.connectedInputs.values()).map((i) => i.name),
          outputs: Array.from(this.connectedOutputs.values()).map((o) => o.name),
        }
      );
      return true;
    } catch (err) {
      logger.warn('MIDI', `[MIDI] Zugriff verweigert oder Fehler bei Initialisierung: ${err instanceof Error ? err.message : String(err)}`, err);
      return false;
    }
  }

  private scanDevices(): void {
    if (!this.midiAccess) return;

    this.connectedInputs.clear();
    this.connectedOutputs.clear();
    this.deviceProfiles.clear();

    for (const input of this.midiAccess.inputs.values()) {
      if (input.state === 'connected') {
        this.connectedInputs.set(input.id, input);
        const profile = identifyControllerProfile(input.name || '');
        this.deviceProfiles.set(input.id, profile);

        // Bind listener
        input.onmidimessage = (event) => {
          if (event.data) {
            this.handleMidiMessage(input.name || 'MIDI-In', event.data, profile);
          }
        };
      }
    }

    for (const output of this.midiAccess.outputs.values()) {
      if (output.state === 'connected') {
        this.connectedOutputs.set(output.id, output);
      }
    }

    const detected = Array.from(this.deviceProfiles.entries()).map(([id, profile]) => {
      const input = this.connectedInputs.get(id);
      return { name: input?.name || id, profile: profile.id };
    });
    logger.debug('MIDI', `MIDI-Scan: ${this.connectedInputs.size} Eingang/Eingänge, ${this.connectedOutputs.size} Ausgang/Ausgänge`, {
      devices: detected,
    });
  }

  /**
   * Internal message processor & dispatcher.
   */
  public handleMidiMessage(
    deviceName: string,
    data: Uint8Array,
    profile?: ControllerProfile
  ): MidiAction | null {
    const prof = profile || identifyControllerProfile(deviceName);
    const action = parsePioneerMidiMessage(data, prof);

    const hex = Array.from(data)
      .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
      .join(' ');

    const actionSummary = action
      ? `${action.type}${action.stem ? ` [${action.stem.toUpperCase()}]` : ''}${
          action.value !== undefined ? ` val=${action.value}` : ''
        }`
      : 'Unmapped';

    this.addLog({
      id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now(),
      direction: 'IN',
      deviceName,
      bytes: Array.from(data),
      hex,
      actionSummary,
    });

    if (action && action.type !== 'UNKNOWN') {
      logger.debug('MIDI', `MIDI-Aktion empfangen: ${actionSummary} von ${deviceName}`, {
        deviceName,
        hex,
        action,
      });
      for (const handler of this.actionHandlers) {
        try {
          handler(action);
        } catch (e) {
          logger.error('MIDI', `[MIDI] Fehler im Action-Handler (${action.type}): ${e instanceof Error ? e.message : String(e)}`, e);
        }
      }
    }

    return action;
  }

  /**
   * Sends LED feedback to connected Pioneer DDJ controllers to reflect the Stems state.
   */
  public updateStemPadLeds(mixerState: StemsMixerState, deckIndex: number = 0): void {
    if (this.connectedOutputs.size === 0) return;

    const stemPadMap: Record<StemType, number> = {
      vocals: 1,
      drums: 2,
      bass: 3,
      other: 4,
    };

    const hasAnySolo = STEM_TYPES.some((s) => mixerState[s].solo);

    for (const stem of STEM_TYPES) {
      const padNum = stemPadMap[stem];
      const state = mixerState[stem];
      const isLit = hasAnySolo ? state.solo : !state.muted;

      const msg = getPioneerPadLedMessage(padNum, isLit, stem, deckIndex);

      for (const output of this.connectedOutputs.values()) {
        try {
          output.send(msg);
        } catch (e) {
          // Output might be closed
          logger.warn('MIDI', `LED-Feedback an ${output.name || 'Ausgang'} konnte nicht gesendet werden: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  }

  /**
   * Returns the list of currently active devices and their identified profiles.
   */
  public getConnectedDevices(): ConnectedMidiDevice[] {
    const list: ConnectedMidiDevice[] = [];
    for (const input of this.connectedInputs.values()) {
      const profile =
        this.deviceProfiles.get(input.id) || identifyControllerProfile(input.name || '');
      list.push({
        id: input.id,
        name: input.name || 'Unbekanntes MIDI-Gerät',
        manufacturer: input.manufacturer || 'Pioneer DJ',
        type: 'input',
        state: input.state === 'connected' ? 'connected' : 'disconnected',
        profile,
      });
    }
    return list;
  }

  /** Checks whether a Pioneer DDJ-FLX4 is connected. */
  public isFlx4Connected(): boolean {
    return Array.from(this.deviceProfiles.values()).some((p) => p.id === 'PIONEER_DDJ_FLX4');
  }

  /** Checks whether a Pioneer DDJ-1000 is connected. */
  public isDdj1000Connected(): boolean {
    return Array.from(this.deviceProfiles.values()).some((p) => p.id === 'PIONEER_DDJ_1000');
  }

  /**
   * Returns the active controller summary label (e.g. "Pioneer DDJ-FLX4 aktiv").
   */
  public getStatusLabel(): string {
    if (this.isFlx4Connected()) return 'Pioneer DDJ-FLX4 aktiv';
    if (this.isDdj1000Connected()) return 'Pioneer DDJ-1000 aktiv';
    if (this.connectedInputs.size > 0) {
      const first = this.connectedInputs.values().next().value;
      return `${first?.name || 'MIDI-Controller'} aktiv`;
    }
    return 'Kein MIDI-Controller verbunden';
  }

  public subscribe(handler: MidiActionHandler): () => void {
    this.actionHandlers.add(handler);
    return () => {
      this.actionHandlers.delete(handler);
    };
  }

  public onStateChange(listener: () => void): () => void {
    this.stateChangeListeners.add(listener);
    return () => {
      this.stateChangeListeners.delete(listener);
    };
  }

  private notifyStateChange(): void {
    for (const listener of this.stateChangeListeners) {
      try {
        listener();
      } catch (e) {
        logger.error('MIDI', `[MIDI] Fehler im StateChange-Listener: ${e instanceof Error ? e.message : String(e)}`, e);
      }
    }
  }

  private addLog(entry: MidiLogEntry): void {
    this.eventLog.push(entry);
    if (this.eventLog.length > MAX_LOG_ENTRIES) {
      this.eventLog.shift();
    }
  }

  public getEventLog(): MidiLogEntry[] {
    return [...this.eventLog];
  }

  public clearEventLog(): void {
    this.eventLog = [];
  }

  /**
   * Simulation helper for the test harness and UI simulation of hardware pad presses.
   */
  public simulateHardwareAction(action: MidiAction): void {
    for (const handler of this.actionHandlers) {
      handler(action);
    }
  }
}

export const midiManager = new MidiManager();
