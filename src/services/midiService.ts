import { MidiMappingEntry } from "../types";
import { FACTORY_MIDI_MAPPINGS } from "../data/initialTracks";

export interface IncomingMidiEvent {
  timestamp: number;
  channel: number;
  messageType: "noteon" | "noteoff" | "cc";
  controlNumber: number;
  value: number; // 0 to 127
  rawBytes: number[];
}

export type MidiActionHandler = (actionId: string, value: number, rawEvent: IncomingMidiEvent) => void;

class MidiControllerService {
  private midiAccess: any = null;
  private isSupported = false;
  private connectedDevices: string[] = [];
  private mappings: MidiMappingEntry[] = [...FACTORY_MIDI_MAPPINGS];
  private activePreset: "ddj-flx4" | "ddj-1000" | "custom" = "ddj-flx4";

  // Learn state
  public isLearning = false;
  public learningActionId: string | null = null;

  // Listeners
  private actionHandlers: Set<MidiActionHandler> = new Set();
  private eventLogHandlers: Set<(event: IncomingMidiEvent) => void> = new Set();
  private deviceChangeHandlers: Set<(devices: string[]) => void> = new Set();
  private mappingChangeHandlers: Set<(mappings: MidiMappingEntry[]) => void> = new Set();

  constructor() {
    // Load persisted mappings if any
    try {
      const saved = localStorage.getItem("airdox_midi_mappings");
      if (saved) {
        this.mappings = JSON.parse(saved);
      }
      const savedPreset = localStorage.getItem("airdox_midi_preset");
      if (savedPreset === "ddj-flx4" || savedPreset === "ddj-1000" || savedPreset === "custom") {
        this.activePreset = savedPreset;
      }
    } catch {
      // ignore
    }
  }

  async init(): Promise<boolean> {
    if (typeof navigator === "undefined" || !("requestMIDIAccess" in navigator)) {
      console.warn("Web MIDI API is not supported in this environment.");
      this.isSupported = false;
      return false;
    }

    try {
      this.midiAccess = await navigator.requestMIDIAccess({ sysex: false });
      this.isSupported = true;
      this.updateConnectedDevices();

      this.midiAccess.onstatechange = () => {
        this.updateConnectedDevices();
      };

      // Attach message listeners to all available inputs
      this.bindInputs();
      return true;
    } catch (err) {
      console.warn("MIDI access request rejected or failed:", err);
      this.isSupported = false;
      return false;
    }
  }

  private bindInputs() {
    if (!this.midiAccess) return;
    for (const input of this.midiAccess.inputs.values()) {
      input.onmidimessage = (event: any) => {
        this.handleRawMidi(event.data);
      };
    }
  }

  private updateConnectedDevices() {
    if (!this.midiAccess) return;
    const names: string[] = [];
    for (const input of this.midiAccess.inputs.values()) {
      if (input.name) names.push(input.name);
    }
    this.connectedDevices = names;
    this.deviceChangeHandlers.forEach((h) => h(names));
    this.bindInputs();
  }

  public handleRawMidi(data: Uint8Array | number[]) {
    if (!data || data.length < 3) return;
    const statusByte = data[0];
    const controlNumber = data[1];
    const value = data[2];

    const command = statusByte >> 4;
    const channel = (statusByte & 0x0f) + 1;

    let messageType: "noteon" | "noteoff" | "cc" | null = null;
    if (command === 0x9) {
      messageType = value > 0 ? "noteon" : "noteoff";
    } else if (command === 0x8) {
      messageType = "noteoff";
    } else if (command === 0xb) {
      messageType = "cc";
    }

    if (!messageType) return;

    const event: IncomingMidiEvent = {
      timestamp: Date.now(),
      channel,
      messageType,
      controlNumber,
      value,
      rawBytes: Array.from(data),
    };

    // Broadcast raw event to listeners (e.g. MIDI Monitor)
    this.eventLogHandlers.forEach((h) => h(event));

    // Handle MIDI Learn mode
    if (this.isLearning && this.learningActionId) {
      this.bindLearningAction(this.learningActionId, event);
      return;
    }

    // Lookup matching action in mapping table
    // Match based on channel, messageType, and controlNumber
    const mapping = this.mappings.find(
      (m) =>
        m.channel === event.channel &&
        m.controlNumber === event.controlNumber &&
        (m.messageType === event.messageType ||
          (m.messageType === "noteon" && event.messageType === "noteoff"))
    );

    if (mapping) {
      this.actionHandlers.forEach((h) => h(mapping.actionId, event.value, event));
    }
  }

  // MIDI Learn mechanism (Rekordbox style)
  startLearn(actionId: string) {
    this.isLearning = true;
    this.learningActionId = actionId;
  }

  cancelLearn() {
    this.isLearning = false;
    this.learningActionId = null;
  }

  private bindLearningAction(actionId: string, event: IncomingMidiEvent) {
    // Determine behavior based on message type
    const isCC = event.messageType === "cc";
    const newMappings = this.mappings.map((m) => {
      if (m.actionId === actionId) {
        return {
          ...m,
          channel: event.channel,
          messageType: event.messageType,
          controlNumber: event.controlNumber,
          behavior: isCC ? ("fader" as const) : ("toggle" as const),
          hardwareController: "custom" as const,
        };
      }
      return m;
    });

    this.mappings = newMappings;
    this.activePreset = "custom";
    this.isLearning = false;
    this.learningActionId = null;
    this.persist();
    this.mappingChangeHandlers.forEach((h) => h(this.mappings));
  }

  setPreset(preset: "ddj-flx4" | "ddj-1000") {
    this.activePreset = preset;
    this.mappings = FACTORY_MIDI_MAPPINGS.filter(
      (m) => m.hardwareController === preset || m.hardwareController === "ddj-flx4"
    );
    this.persist();
    this.mappingChangeHandlers.forEach((h) => h(this.mappings));
  }

  resetFactory() {
    this.setPreset("ddj-flx4");
  }

  private persist() {
    try {
      localStorage.setItem("airdox_midi_mappings", JSON.stringify(this.mappings));
      localStorage.setItem("airdox_midi_preset", this.activePreset);
    } catch {
      // ignore
    }
  }

  // Simulation test helper (for users testing without real hardware plugged in)
  simulateMidiEvent(actionId: string, value = 127) {
    const mapping = this.mappings.find((m) => m.actionId === actionId);
    if (mapping) {
      const isCC = mapping.messageType === "cc";
      const statusByte = isCC ? 0xb0 | (mapping.channel - 1) : 0x90 | (mapping.channel - 1);
      this.handleRawMidi([statusByte, mapping.controlNumber, value]);
    } else {
      // Trigger action directly
      const dummyEvent: IncomingMidiEvent = {
        timestamp: Date.now(),
        channel: 1,
        messageType: "noteon",
        controlNumber: 99,
        value,
        rawBytes: [0x90, 99, value],
      };
      this.actionHandlers.forEach((h) => h(actionId, value, dummyEvent));
    }
  }

  // Subscriptions
  onAction(handler: MidiActionHandler) {
    this.actionHandlers.add(handler);
    return () => this.actionHandlers.delete(handler);
  }

  onEventLog(handler: (event: IncomingMidiEvent) => void) {
    this.eventLogHandlers.add(handler);
    return () => this.eventLogHandlers.delete(handler);
  }

  onDeviceChange(handler: (devices: string[]) => void) {
    this.deviceChangeHandlers.add(handler);
    handler(this.connectedDevices);
    return () => this.deviceChangeHandlers.delete(handler);
  }

  onMappingChange(handler: (mappings: MidiMappingEntry[]) => void) {
    this.mappingChangeHandlers.add(handler);
    handler(this.mappings);
    return () => this.mappingChangeHandlers.delete(handler);
  }

  getMappings() {
    return this.mappings;
  }

  getActivePreset() {
    return this.activePreset;
  }

  getConnectedDevices() {
    return this.connectedDevices;
  }

  getIsSupported() {
    return this.isSupported;
  }
}

export const midiService = new MidiControllerService();
