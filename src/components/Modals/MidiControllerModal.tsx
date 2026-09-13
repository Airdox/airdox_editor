/**
 * @license
 * Pioneer DJ Hardware Controller & MIDI Mapping Modal
 * Real-time monitoring, Action Pad configuration, and test interface for Pioneer DDJ-FLX4 & DDJ-1000.
 */

import React, { useState, useEffect } from 'react';
import {
  Radio,
  CheckCircle2,
  XCircle,
  RefreshCw,
  X,
  Layers,
  Terminal,
} from 'lucide-react';
import { midiManager, ConnectedMidiDevice, MidiLogEntry } from '../../midi/midiManager';
import { ControllerModel, CONTROLLER_PROFILES } from '../../midi/pioneerMappings';
import { StemType, StemsMixerState } from '../../audio/stemEngine';

interface MidiControllerModalProps {
  isOpen: boolean;
  onClose: () => void;
  stemsMixerState: StemsMixerState;
  /**
   * Kept for API symmetry with the deck controls. Simulated pad presses are
   * deliberately routed through the MIDI manager instead, so a test press takes
   * exactly the same code path as physical hardware and cannot toggle twice.
   */
  onToggleStemMute?: (stem: StemType) => void;
  onToggleStemSolo?: (stem: StemType) => void;
}

export const MidiControllerModal: React.FC<MidiControllerModalProps> = ({
  isOpen,
  onClose,
  stemsMixerState,
}) => {
  const [devices, setDevices] = useState<ConnectedMidiDevice[]>([]);
  const [selectedProfile, setSelectedProfile] = useState<ControllerModel>('PIONEER_DDJ_FLX4');
  const [midiLogs, setMidiLogs] = useState<MidiLogEntry[]>([]);
  const [lastTriggeredPad, setLastTriggeredPad] = useState<number | null>(null);

  useEffect(() => {
    if (!isOpen) return;

    // Refresh devices
    midiManager.init().then(() => {
      setDevices(midiManager.getConnectedDevices());
      if (midiManager.isDdj1000Connected()) {
        setSelectedProfile('PIONEER_DDJ_1000');
      } else if (midiManager.isFlx4Connected()) {
        setSelectedProfile('PIONEER_DDJ_FLX4');
      }
    });

    const unsubState = midiManager.onStateChange(() => {
      setDevices(midiManager.getConnectedDevices());
    });

    const interval = setInterval(() => {
      setMidiLogs(midiManager.getEventLog().slice(-8));
    }, 250);

    return () => {
      unsubState();
      clearInterval(interval);
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const handleTestPadPress = (padNumber: number) => {
    setLastTriggeredPad(padNumber);
    setTimeout(() => setLastTriggeredPad(null), 300);

    // The simulated hardware packet is the single source of truth: the manager
    // parses it and dispatches the resulting action to all subscribers, exactly
    // as a physical pad press would.
    midiManager.handleMidiMessage(
      'Pioneer Controller (Test)',
      new Uint8Array([0x90, padNumber - 1, 127])
    );
  };

  const padConfigs = [
    { num: 1, label: 'VOCALS', sub: 'Mute/Aktiv', color: 'border-[#00a2ff] text-[#00c8ff]', active: !stemsMixerState.vocals.muted },
    { num: 2, label: 'DRUMS', sub: 'Mute/Aktiv', color: 'border-[#ffaa00] text-[#ffbb33]', active: !stemsMixerState.drums.muted },
    { num: 3, label: 'BASS', sub: 'Mute/Aktiv', color: 'border-[#ff3b30] text-[#ff5549]', active: !stemsMixerState.bass.muted },
    { num: 4, label: 'OTHER', sub: 'Mute/Aktiv', color: 'border-[#00e676] text-[#33ff99]', active: !stemsMixerState.other.muted },
    { num: 5, label: 'SOLO VOC', sub: 'Solo Toggle', color: 'border-[#00a2ff] text-[#00c8ff]', active: stemsMixerState.vocals.solo },
    { num: 6, label: 'SOLO DRM', sub: 'Solo Toggle', color: 'border-[#ffaa00] text-[#ffbb33]', active: stemsMixerState.drums.solo },
    { num: 7, label: 'SOLO BAS', sub: 'Solo Toggle', color: 'border-[#ff3b30] text-[#ff5549]', active: stemsMixerState.bass.solo },
    { num: 8, label: 'SOLO OTH', sub: 'Solo Toggle', color: 'border-[#00e676] text-[#33ff99]', active: stemsMixerState.other.solo },
  ];

  return (
    <div
      className="fixed inset-0 z-[110] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full max-w-2xl bg-[#12141a] border border-[#2d303f] rounded-lg shadow-2xl overflow-hidden flex flex-col text-neutral-200 select-none">
        {/* Modal Header */}
        <div className="h-11 px-4 flex items-center justify-between border-b border-[#232634] bg-[#0c0e13]">
          <div className="flex items-center space-x-2">
            <Radio size={16} className="text-[#00e5ff] animate-pulse" />
            <h2 className="text-sm font-bold text-white tracking-wide">
              PIONEER DJ HARDWARE CONTROLLER &amp; STEMS PAD MAPPING
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-neutral-400 hover:text-white transition-colors"
            title="Schließen"
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-4 space-y-4 max-h-[85vh] overflow-y-auto text-xs">
          {/* Controller Model Selector & Hardware Status */}
          <div className="flex items-center justify-between bg-[#171922] p-3 rounded border border-[#252838]">
            <div className="flex items-center space-x-3">
              <span className="font-semibold text-neutral-300">Profil:</span>
              <div className="flex space-x-1.5">
                {CONTROLLER_PROFILES.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => setSelectedProfile(p.id)}
                    className={`px-2.5 py-1 rounded text-[11px] font-medium border transition-all ${
                      selectedProfile === p.id
                        ? 'bg-[#0088ff] border-[#0088ff] text-white shadow-sm'
                        : 'bg-[#101217] border-[#2b2e3e] text-neutral-400 hover:text-white'
                    }`}
                  >
                    {p.displayName}
                  </button>
                ))}
              </div>
            </div>

            <button
              onClick={() => {
                midiManager.init().then(() => setDevices(midiManager.getConnectedDevices()));
              }}
              className="flex items-center space-x-1 px-2 py-1 rounded bg-[#1f2230] hover:bg-[#2b2f42] text-neutral-300 hover:text-white border border-[#33374d] text-[10.5px] transition-colors"
              title="Neu nach angeschlossenen USB-MIDI Controllern scannen"
            >
              <RefreshCw size={11} />
              <span>Geräte scannen</span>
            </button>
          </div>

          {/* Connected Hardware Device Readout */}
          <div className="bg-[#101217] p-2.5 rounded border border-[#1f2230] flex items-center justify-between">
            <div className="flex items-center space-x-2">
              {devices.length > 0 ? (
                <CheckCircle2 size={15} className="text-[#00e676]" />
              ) : (
                <XCircle size={15} className="text-amber-400" />
              )}
              <span className="text-white font-medium">
                {devices.length > 0
                  ? `Erkanntes Gerät: ${devices.map((d) => d.name).join(', ')}`
                  : 'Kein physischer MIDI-Controller angeschlossen (Web MIDI aktiv & Test-Simulation bereit)'}
              </span>
            </div>
            <span className="text-[10px] font-mono text-neutral-400">Web MIDI API v1.0</span>
          </div>

          {/* 8 Action Pads Visual Layout (Interactive Test) */}
          <div className="bg-[#151822] p-3.5 rounded border border-[#262a3c]">
            <div className="flex items-center justify-between mb-2.5">
              <div className="flex items-center space-x-2">
                <Layers size={13} className="text-[#00a2ff]" />
                <span className="font-bold text-white text-[11.5px]">
                  {selectedProfile === 'PIONEER_DDJ_1000'
                    ? 'Pioneer DDJ-1000 • Performance Pads (Deck 1 / Deck A)'
                    : selectedProfile === 'PIONEER_DDJ_FLX4'
                      ? 'Pioneer DDJ-FLX4 • Action Pads (Deck 1 / Deck A)'
                      : 'Standard MIDI Controller • Pads (Deck 1 / Deck A)'}
                </span>
              </div>
              <span className="text-[10px] text-neutral-400">
                Klicke auf ein Pad, um den Hardware-Druck zu simulieren
              </span>
            </div>

            <div className="grid grid-cols-4 gap-2.5">
              {padConfigs.map((pad) => {
                const isTriggered = lastTriggeredPad === pad.num;
                return (
                  <button
                    key={pad.num}
                    onClick={() => handleTestPadPress(pad.num)}
                    className={`p-3 rounded flex flex-col items-center justify-center border transition-all cursor-pointer ${
                      pad.active
                        ? `bg-[#1c2233] ${pad.color} shadow-md`
                        : 'bg-[#101117] border-[#222533] text-neutral-500 opacity-60'
                    } ${isTriggered ? 'scale-95 brightness-150 ring-2 ring-white' : 'hover:scale-[1.02]'}`}
                  >
                    <span className="text-[9px] font-mono text-neutral-400">PAD {pad.num}</span>
                    <span className="font-bold text-xs mt-0.5">{pad.label}</span>
                    <span className="text-[9px] mt-0.5 opacity-80">{pad.sub}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Standard DJ Deck Mapping Overview */}
          <div className="grid grid-cols-2 gap-3 text-[11px]">
            <div className="bg-[#101217] p-2.5 rounded border border-[#1f2230]">
              <span className="text-white font-bold block mb-1">Pads 1–4: Stems Mute / Aktiv</span>
              <ul className="space-y-0.5 text-neutral-400 font-mono text-[10px]">
                <li>• Pad 1: <span className="text-[#00c8ff]">VOCALS</span> Mute / Unmute</li>
                <li>• Pad 2: <span className="text-[#ffaa00]">DRUMS</span> Mute / Unmute</li>
                <li>• Pad 3: <span className="text-[#ff3b30]">BASS</span> Mute / Unmute</li>
                <li>• Pad 4: <span className="text-[#00e676]">OTHER</span> Mute / Unmute</li>
              </ul>
            </div>

            <div className="bg-[#101217] p-2.5 rounded border border-[#1f2230]">
              <span className="text-white font-bold block mb-1">Pads 5–8: Stems Solo</span>
              <ul className="space-y-0.5 text-neutral-400 font-mono text-[10px]">
                <li>• Pad 5: Solo <span className="text-[#00c8ff]">VOCALS</span> (Acapella)</li>
                <li>• Pad 6: Solo <span className="text-[#ffaa00]">DRUMS</span></li>
                <li>• Pad 7: Solo <span className="text-[#ff3b30]">BASS</span></li>
                <li>• Pad 8: Solo <span className="text-[#00e676]">OTHER</span></li>
              </ul>
            </div>
          </div>

          {/* Live MIDI Event Monitor */}
          <div className="bg-[#0b0c10] p-2.5 rounded border border-[#1e212d]">
            <div className="flex items-center justify-between mb-1 text-[10.5px]">
              <div className="flex items-center space-x-1.5 text-neutral-400">
                <Terminal size={12} className="text-[#00e5ff]" />
                <span className="font-mono font-semibold">Live MIDI Event Monitor</span>
              </div>
              <button
                onClick={() => {
                  midiManager.clearEventLog();
                  setMidiLogs([]);
                }}
                className="text-[9.5px] text-neutral-500 hover:text-white"
              >
                Log leeren
              </button>
            </div>

            <div className="h-20 overflow-y-auto space-y-1 font-mono text-[9.5px] text-neutral-400">
              {midiLogs.length === 0 ? (
                <div className="text-neutral-600 italic py-2">
                  Warte auf eingehende MIDI-Befehle von DDJ-FLX4 / DDJ-1000...
                </div>
              ) : (
                midiLogs.map((log) => (
                  <div key={log.id} className="flex items-center space-x-2">
                    <span className="text-neutral-500">
                      [{new Date(log.timestamp).toLocaleTimeString()}]
                    </span>
                    <span className="text-[#00e5ff]">{log.direction}</span>
                    <span className="text-amber-300">{log.hex}</span>
                    <span className="text-white font-semibold">{log.actionSummary}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {/* Modal Footer */}
        <div className="h-10 px-4 flex items-center justify-end border-t border-[#232634] bg-[#0c0e13]">
          <button
            onClick={onClose}
            className="px-3 py-1 rounded bg-[#0088ff] hover:bg-[#0099ff] text-white font-semibold text-xs transition-colors"
          >
            Schließen
          </button>
        </div>
      </div>
    </div>
  );
};
