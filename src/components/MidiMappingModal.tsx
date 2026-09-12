import React, { useState, useEffect } from "react";
import {
  X,
  Sliders,
  Radio,
  RotateCcw,
  Download,
  Upload,
  Check,
  Zap,
  Volume2,
  Disc3,
  Search,
} from "lucide-react";
import { MidiMappingEntry } from "../types";
import {
  midiService,
  IncomingMidiEvent,
} from "../services/midiService";

interface MidiMappingModalProps {
  onClose: () => void;
  activePreset: "ddj-flx4" | "ddj-1000" | "custom";
  onSelectPreset: (preset: "ddj-flx4" | "ddj-1000") => void;
  connectedDevices: string[];
}

export const MidiMappingModal: React.FC<MidiMappingModalProps> = ({
  onClose,
  activePreset,
  onSelectPreset,
  connectedDevices,
}) => {
  const [mappings, setMappings] = useState<MidiMappingEntry[]>(midiService.getMappings());
  const [isLearning, setIsLearning] = useState(false);
  const [learningActionId, setLearningActionId] = useState<string | null>(null);
  const [searchFilter, setSearchFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [recentEvents, setRecentEvents] = useState<IncomingMidiEvent[]>([]);

  useEffect(() => {
    const unsubLog = midiService.onEventLog((event) => {
      setRecentEvents((prev) => [event, ...prev.slice(0, 15)]);
    });

    const unsubMapping = midiService.onMappingChange((newMappings) => {
      setMappings(newMappings);
      setIsLearning(midiService.isLearning);
      setLearningActionId(midiService.learningActionId);
    });

    return () => {
      unsubLog();
      unsubMapping();
      midiService.cancelLearn();
    };
  }, []);

  const handleStartLearn = (actionId: string) => {
    setIsLearning(true);
    setLearningActionId(actionId);
    midiService.startLearn(actionId);
  };

  const handleCancelLearn = () => {
    setIsLearning(false);
    setLearningActionId(null);
    midiService.cancelLearn();
  };

  const handleResetFactory = () => {
    midiService.resetFactory();
    onSelectPreset("ddj-flx4");
  };

  const handleExport = () => {
    const dataStr =
      "data:text/json;charset=utf-8," +
      encodeURIComponent(JSON.stringify(mappings, null, 2));
    const downloadAnchor = document.createElement("a");
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", `airdox_${activePreset}_mapping.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  };

  // Filtered mappings
  const filteredMappings = mappings.filter((m) => {
    const matchesSearch =
      m.actionLabel.toLowerCase().includes(searchFilter.toLowerCase()) ||
      m.actionId.toLowerCase().includes(searchFilter.toLowerCase());
    const matchesCategory =
      categoryFilter === "all" || m.category === categoryFilter;
    return matchesSearch && matchesCategory;
  });

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 select-none">
      <div className="bg-zinc-950 border border-zinc-800 rounded-2xl w-full max-w-5xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="px-6 py-4 border-b border-zinc-800 flex items-center justify-between bg-zinc-900/60">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center shadow-lg shadow-cyan-950/50">
              <Sliders className="w-5 h-5 text-zinc-950" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-extrabold text-zinc-100">
                  DJ Hardware Mapping &amp; MIDI Learn Hub
                </h2>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-cyan-950 border border-cyan-800 text-cyan-300 font-bold">
                  PIONEER DDJ-FLX4 &amp; DDJ-1000
                </span>
              </div>
              <p className="text-xs text-zinc-400">
                Passe Steuerbefehle an deinen Workflow an und lerne Hardware-Tasten per Rekordbox Learn-Modus an.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* Connected Hardware Device Pill */}
            <div className="flex items-center gap-2 px-3 py-1 rounded-lg bg-zinc-900 border border-zinc-800 text-xs">
              <Radio
                className={`w-3.5 h-3.5 ${
                  connectedDevices.length > 0 ? "text-emerald-400 animate-pulse" : "text-zinc-500"
                }`}
              />
              <span className="text-zinc-400">
                {connectedDevices.length > 0
                  ? `Hardware: ${connectedDevices.join(", ")}`
                  : "Web MIDI: Bereit (Controller anstecken)"}
              </span>
            </div>

            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Preset Selector & Learn Mode Banner */}
        <div className="px-6 py-3 border-b border-zinc-800/80 bg-zinc-900/30 flex flex-wrap items-center justify-between gap-3">
          {/* Preset Buttons */}
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono text-zinc-400 font-bold">PRESET:</span>
            <button
              onClick={() => {
                midiService.setPreset("ddj-flx4");
                onSelectPreset("ddj-flx4");
              }}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold font-mono transition-all ${
                activePreset === "ddj-flx4"
                  ? "bg-cyan-500 text-zinc-950 shadow-md shadow-cyan-500/20"
                  : "bg-zinc-900 hover:bg-zinc-800 text-zinc-300 border border-zinc-800"
              }`}
            >
              Pioneer DDJ-FLX4
            </button>

            <button
              onClick={() => {
                midiService.setPreset("ddj-1000");
                onSelectPreset("ddj-1000");
              }}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold font-mono transition-all ${
                activePreset === "ddj-1000"
                  ? "bg-amber-500 text-zinc-950 shadow-md shadow-amber-500/20"
                  : "bg-zinc-900 hover:bg-zinc-800 text-zinc-300 border border-zinc-800"
              }`}
            >
              Pioneer DDJ-1000 (4 Decks)
            </button>
          </div>

          {/* Quick Actions */}
          <div className="flex items-center gap-2">
            <button
              onClick={handleResetFactory}
              className="px-2.5 py-1.5 rounded-lg text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900 border border-zinc-800 flex items-center gap-1.5"
              title="Auf Pioneer Werkseinstellungen zurücksetzen"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Werkseinstellungen</span>
            </button>

            <button
              onClick={handleExport}
              className="px-2.5 py-1.5 rounded-lg text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900 border border-zinc-800 flex items-center gap-1.5"
              title="Mapping als JSON exportieren"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Export JSON</span>
            </button>
          </div>
        </div>

        {/* ACTIVE LEARN NOTIFICATION BANNER */}
        {isLearning && (
          <div className="bg-cyan-950 border-b border-cyan-800 px-6 py-2.5 flex items-center justify-between animate-pulse">
            <div className="flex items-center gap-2">
              <Zap className="w-4 h-4 text-cyan-400" />
              <span className="text-xs font-bold text-cyan-200">
                MIDI LEARN AKTIV: Drücke die gewünschte Taste oder bewege den Fader an deiner DJ-Hardware...
              </span>
              <span className="text-[11px] font-mono text-cyan-300 px-2 py-0.5 rounded bg-cyan-900 border border-cyan-700">
                Aktion: {learningActionId}
              </span>
            </div>

            <button
              onClick={handleCancelLearn}
              className="px-3 py-1 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-xs font-bold text-zinc-200 border border-zinc-700"
            >
              Learn abbrechen
            </button>
          </div>
        )}

        {/* Modal Main Content: Split View */}
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_300px] flex-1 overflow-hidden divide-y lg:divide-y-0 lg:divide-x divide-zinc-800">
          {/* Mapping Table & Search */}
          <div className="flex flex-col overflow-hidden p-4">
            {/* Filter Bar */}
            <div className="flex items-center justify-between gap-3 mb-3">
              <div className="relative flex-1">
                <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-2.5 top-2.5" />
                <input
                  type="text"
                  placeholder="Befehl suchen (z.B. Play, Cue, Crossfader, EQ)..."
                  value={searchFilter}
                  onChange={(e) => setSearchFilter(e.target.value)}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg pl-8 pr-3 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-cyan-500"
                />
              </div>

              <div className="flex items-center gap-1 text-xs">
                {["all", "deck1", "deck2", "mixer"].map((cat) => (
                  <button
                    key={cat}
                    onClick={() => setCategoryFilter(cat)}
                    className={`px-2.5 py-1 rounded-lg font-mono capitalize text-[11px] transition-colors ${
                      categoryFilter === cat
                        ? "bg-zinc-800 text-cyan-400 font-bold border border-zinc-700"
                        : "text-zinc-400 hover:text-zinc-200"
                    }`}
                  >
                    {cat}
                  </button>
                ))}
              </div>
            </div>

            {/* Mappings Table */}
            <div className="flex-1 overflow-y-auto border border-zinc-800 rounded-xl divide-y divide-zinc-900 bg-zinc-950">
              <div className="px-4 py-2 bg-zinc-900/80 text-[10px] font-mono text-zinc-400 font-bold grid grid-cols-[2fr_1fr_1fr_1fr_80px] gap-2">
                <span>AKTION / FUNKTION</span>
                <span>KANAL</span>
                <span>SIGNALTYP</span>
                <span>NOTE / CC</span>
                <span className="text-right">LEARN</span>
              </div>

              {filteredMappings.map((entry) => {
                const isTargetOfLearn = learningActionId === entry.actionId;
                return (
                  <div
                    key={entry.id}
                    className={`px-4 py-2.5 grid grid-cols-[2fr_1fr_1fr_1fr_80px] gap-2 items-center text-xs transition-colors ${
                      isTargetOfLearn
                        ? "bg-cyan-950/40 border-l-2 border-cyan-400"
                        : "hover:bg-zinc-900/40"
                    }`}
                  >
                    <div>
                      <span className="font-semibold text-zinc-200 block">
                        {entry.actionLabel}
                      </span>
                      <span className="text-[10px] font-mono text-zinc-500">
                        {entry.actionId} • {entry.behavior}
                      </span>
                    </div>

                    <div className="font-mono text-zinc-300">
                      Ch {entry.channel}
                    </div>

                    <div>
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase ${
                          entry.messageType === "noteon"
                            ? "bg-emerald-950 text-emerald-400 border border-emerald-800"
                            : "bg-blue-950 text-blue-400 border border-blue-800"
                        }`}
                      >
                        {entry.messageType}
                      </span>
                    </div>

                    <div className="font-mono text-zinc-300 font-bold">
                      {entry.controlNumber} (0x{entry.controlNumber.toString(16).toUpperCase().padStart(2, "0")})
                    </div>

                    <div className="text-right">
                      {isTargetOfLearn ? (
                        <button
                          onClick={handleCancelLearn}
                          className="px-2 py-1 rounded bg-red-950 text-red-300 border border-red-800 text-[10px] font-bold"
                        >
                          Stop
                        </button>
                      ) : (
                        <button
                          onClick={() => handleStartLearn(entry.actionId)}
                          className="px-2.5 py-1 rounded bg-zinc-800 hover:bg-cyan-950 hover:text-cyan-300 border border-zinc-700 text-zinc-300 text-[10px] font-mono font-bold transition-colors"
                          title="Rekordbox Learn: Klicke hier und drücke die Controller-Taste"
                        >
                          Learn
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Right Sidebar: Hardware Test Simulator & Live MIDI Monitor */}
          <div className="p-4 flex flex-col gap-4 overflow-y-auto bg-zinc-900/30">
            {/* Hardware Test Simulator */}
            <div className="bg-zinc-950 border border-zinc-800 rounded-xl p-3 flex flex-col gap-2">
              <span className="text-[11px] font-bold font-mono text-zinc-300">
                HARDWARE-SIMULATOR (TEST)
              </span>
              <p className="text-[10px] text-zinc-500">
                Klicke um Hardware-Signale zu simulieren, falls kein DDJ angeschlossen ist.
              </p>
              <div className="grid grid-cols-2 gap-1.5 pt-1">
                <button
                  onClick={() => midiService.simulateMidiEvent("deck1_play_pause")}
                  className="px-2 py-1.5 rounded bg-zinc-900 hover:bg-cyan-950 hover:text-cyan-300 text-[11px] font-mono text-zinc-300 border border-zinc-800"
                >
                  FLX4 Play D1
                </button>
                <button
                  onClick={() => midiService.simulateMidiEvent("deck2_play_pause")}
                  className="px-2 py-1.5 rounded bg-zinc-900 hover:bg-amber-950 hover:text-amber-300 text-[11px] font-mono text-zinc-300 border border-zinc-800"
                >
                  FLX4 Play D2
                </button>
                <button
                  onClick={() => midiService.simulateMidiEvent("mixer_crossfader", 0)}
                  className="px-2 py-1.5 rounded bg-zinc-900 hover:bg-zinc-800 text-[11px] font-mono text-zinc-300 border border-zinc-800"
                >
                  Crossfader Links
                </button>
                <button
                  onClick={() => midiService.simulateMidiEvent("mixer_crossfader", 64)}
                  className="px-2 py-1.5 rounded bg-zinc-900 hover:bg-zinc-800 text-[11px] font-mono text-zinc-300 border border-zinc-800"
                >
                  Crossfader Mitte
                </button>
                <button
                  onClick={() => midiService.simulateMidiEvent("mixer_crossfader", 127)}
                  className="px-2 py-1.5 rounded bg-zinc-900 hover:bg-zinc-800 text-[11px] font-mono text-zinc-300 border border-zinc-800"
                >
                  Crossfader Rechts
                </button>
                <button
                  onClick={() => midiService.simulateMidiEvent("deck1_cue")}
                  className="px-2 py-1.5 rounded bg-zinc-900 hover:bg-zinc-800 text-[11px] font-mono text-zinc-300 border border-zinc-800"
                >
                  CUE D1
                </button>
              </div>
            </div>

            {/* Live MIDI Monitor */}
            <div className="bg-zinc-950 border border-zinc-800 rounded-xl p-3 flex flex-col gap-2 flex-1 min-h-[220px]">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold font-mono text-zinc-300">
                  LIVE MIDI MONITOR
                </span>
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              </div>

              <div className="flex-1 overflow-y-auto font-mono text-[10px] space-y-1 bg-zinc-900/60 p-2 rounded-lg border border-zinc-800/80 max-h-56">
                {recentEvents.length === 0 ? (
                  <span className="text-zinc-600 block text-center py-4">
                    Warte auf MIDI-Events...
                  </span>
                ) : (
                  recentEvents.map((ev, i) => (
                    <div
                      key={i}
                      className="flex items-center justify-between text-zinc-400 border-b border-zinc-800/40 pb-0.5"
                    >
                      <span className="text-cyan-400">{ev.messageType.toUpperCase()}</span>
                      <span>Ch:{ev.channel}</span>
                      <span>#{ev.controlNumber}</span>
                      <span className="text-amber-400">Val:{ev.value}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
