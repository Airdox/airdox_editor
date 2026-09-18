/**
 * @license
 * Rekordbox MenuBar Component
 * German/English standard menu bar matching the authoritative reference with comprehensive tooltips.
 */

import React, { useState, useRef, useEffect } from 'react';
import {
  Disc,
  Trash2,
  ShieldCheck,
  Scissors,
  Copy,
  ClipboardPaste,
  Sparkles,
  Bot,
  Radio,
  FileAudio,
  FolderOpen,
  Save,
  Plus,
  Wand2,
  Sliders,
} from 'lucide-react';
import { WaveformMode } from '../types/rekordbox';

interface MenuBarProps {
  onNewProject: () => void;
  onSaveProject: () => void;
  onOpenProject: () => void;
  onImportXml: () => void;
  onImportAudio: () => void;
  onExportWav: () => void;
  onExportXml: () => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  waveformMode: WaveformMode;
  onSetWaveformMode: (mode: WaveformMode) => void;
  paletteOpen: boolean;
  onTogglePalette: () => void;
  editPaletteOpen?: boolean;
  onToggleEditPalette?: () => void;
  onMaximizeWaveform?: () => void;
  browserOpen: boolean;
  onToggleBrowser: () => void;
  chatbotOpen?: boolean;
  onToggleChatbot?: () => void;
  onLoadDemoTrack?: () => void;
  onShowInfo: () => void;
  onOpenDatabaseInspector?: () => void;
  onOpenXmlCollection?: () => void;
  onOpenSystemLogs?: () => void;
  onClearHistory?: () => void;
  hasHistory?: boolean;
  onCopy?: () => void;
  onCut?: () => void;
  onPaste?: () => void;
  onDelete?: () => void;
  hasSelection?: boolean;
  hasClipboard?: boolean;
  onOpenEditAssistant?: () => void;
  onAnalyzeMixIn?: () => void;
  onOpenMidiModal?: () => void;
  onSeparateStems?: () => void;
  onOpenRecorder?: () => void;
  onOpenInitialSetup?: () => void;
}

export const MenuBar: React.FC<MenuBarProps> = ({
  onNewProject,
  onSaveProject,
  onOpenProject,
  onImportXml,
  onImportAudio,
  onExportWav,
  onExportXml,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  waveformMode,
  onSetWaveformMode,
  paletteOpen,
  onTogglePalette,
  editPaletteOpen = true,
  onToggleEditPalette,
  onMaximizeWaveform,
  browserOpen,
  onToggleBrowser,
  chatbotOpen,
  onToggleChatbot,
  onLoadDemoTrack,
  onShowInfo,
  onOpenDatabaseInspector,
  onOpenXmlCollection,
  onOpenSystemLogs,
  onClearHistory,
  hasHistory,
  onCopy,
  onCut,
  onPaste,
  onDelete,
  hasSelection,
  hasClipboard,
  onOpenEditAssistant,
  onAnalyzeMixIn,
  onOpenMidiModal,
  onSeparateStems,
  onOpenRecorder,
  onOpenInitialSetup,
}) => {
  const [activeMenu, setActiveMenu] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setActiveMenu(null);
      }
    };
    window.addEventListener('mousedown', handleClickOutside);
    return () => window.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const toggleMenu = (name: string) => {
    setActiveMenu(activeMenu === name ? null : name);
  };

  return (
    <div
      ref={menuRef}
      className="h-6 bg-[#0a0b0d] border-b border-[#18191d] flex items-center justify-between px-2 text-xs select-none z-40 relative"
    >
      <div className="flex items-center space-x-1 text-neutral-300">
        {/* Datei */}
        <div className="relative">
          <button
            onClick={() => toggleMenu('datei')}
            className={`px-2.5 py-0.5 rounded text-[11.5px] hover:bg-[#202228] transition-colors ${
              activeMenu === 'datei' ? 'bg-[#25272e] text-white' : 'text-neutral-300'
            }`}
            title="Projekt- und Dateioperationen (Neu, Öffnen, Speichern, Import, Export)"
          >
            Datei
          </button>
          {activeMenu === 'datei' && (
            <div className="absolute left-0 top-6 w-64 bg-[#16171b] border border-[#2b2d35] rounded-sm shadow-2xl py-1 z-50 text-[11.5px]">
              <button
                onClick={() => { onNewProject(); setActiveMenu(null); }}
                className="w-full text-left px-3 py-1.5 hover:bg-[#0088ff] hover:text-white flex justify-between"
                title="Erstellt ein neues, leeres Editor-Projekt"
              >
                <span>Neues Projekt</span>
                <span className="text-neutral-500 hover:text-neutral-200">Ctrl+N</span>
              </button>
              <button
                onClick={() => { onOpenProject(); setActiveMenu(null); }}
                className="w-full text-left px-3 py-1.5 hover:bg-[#0088ff] hover:text-white flex justify-between"
                title="Öffnet ein bestehendes .airdox.json Projekt"
              >
                <span>Projekt öffnen...</span>
                <span className="text-neutral-500 hover:text-neutral-200">Ctrl+Shift+O</span>
              </button>
              <button
                onClick={() => { onSaveProject(); setActiveMenu(null); }}
                className="w-full text-left px-3 py-1.5 hover:bg-[#0088ff] hover:text-white flex justify-between"
                title="Speichert den aktuellen Bearbeitungsstand nicht-destruktiv"
              >
                <span>Projekt speichern...</span>
                <span className="text-neutral-500 hover:text-neutral-200">Ctrl+S</span>
              </button>
              <div className="h-px bg-[#262830] my-1" />
              {onOpenDatabaseInspector && (
                <button
                  onClick={() => { onOpenDatabaseInspector(); setActiveMenu(null); }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#0088ff] hover:text-white flex justify-between text-[#00a2ff] font-medium"
                  title="Rekordbox SQLite-Datenbank & ANLZ-Wellenformen direkt analysieren"
                >
                  <span>Daten- &amp; Waveform-Extraktor (DB/ANLZ)...</span>
                </button>
              )}
              <button
                onClick={() => { onImportXml(); setActiveMenu(null); }}
                className="w-full text-left px-3 py-1.5 hover:bg-[#0088ff] hover:text-white flex justify-between"
                title="Rekordbox XML-Sammlung mit Beatgrids, Cues und Keys importieren"
              >
                <span>Rekordbox XML importieren...</span>
                <span className="text-neutral-500 hover:text-neutral-200">Ctrl+O</span>
              </button>
              {onOpenXmlCollection && (
                <button
                  onClick={() => { onOpenXmlCollection(); setActiveMenu(null); }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#0088ff] hover:text-white flex justify-between text-[#00e5ff] font-medium"
                  title="Auswahlfenster für Tracks aus der importierten XML-Sammlung öffnen"
                >
                  <span className="flex items-center space-x-1.5">
                    <Disc size={13} className="text-[#00e5ff]" />
                    <span>Rekordbox XML Track-Auswahl...</span>
                  </span>
                  <span className="text-[9px] bg-[#0088ff]/30 text-[#00a2ff] px-1 rounded font-mono">LISTE</span>
                </button>
              )}
              <button
                onClick={() => { onImportAudio(); setActiveMenu(null); }}
                className="w-full text-left px-3 py-1.5 hover:bg-[#0088ff] hover:text-white flex justify-between"
                title="Eigenständige Audiodatei (WAV, MP3, FLAC, AIFF) in Deck A laden"
              >
                <span>Audiodatei laden (WAV, MP3, FLAC)...</span>
              </button>
              {onOpenRecorder && (
                <button
                  onClick={() => { onOpenRecorder(); setActiveMenu(null); }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#0088ff] hover:text-white flex justify-between text-[#ff5147] font-semibold"
                  title="Professionellen DJ-Set- und Mikrofon-Recorder öffnen"
                >
                  <span className="flex items-center gap-2"><Radio size={13} /> Pro Recorder öffnen…</span>
                  <span className="text-neutral-500">F9</span>
                </button>
              )}
              <div className="h-px bg-[#262830] my-1" />
              <button
                onClick={() => { onExportWav(); setActiveMenu(null); }}
                className="w-full text-left px-3 py-1.5 hover:bg-[#0088ff] hover:text-white flex justify-between"
                title="Gemasterte WAV-Audiodatei in voller 24-Bit/32-Bit Qualität exportieren"
              >
                <span>Master als WAV exportieren...</span>
                <span className="text-neutral-500 hover:text-neutral-200">Ctrl+E</span>
              </button>
              <button
                onClick={() => { onExportXml(); setActiveMenu(null); }}
                className="w-full text-left px-3 py-1.5 hover:bg-[#0088ff] hover:text-white flex justify-between"
                title="Aktualisierte XML-Metadaten für Pioneer Rekordbox exportieren"
              >
                <span>Rekordbox XML exportieren...</span>
              </button>
            </div>
          )}
        </div>

        {/* Bearbeiten */}
        <div className="relative">
          <button
            onClick={() => toggleMenu('bearbeiten')}
            className={`px-2.5 py-0.5 rounded text-[11.5px] hover:bg-[#202228] transition-colors ${
              activeMenu === 'bearbeiten' ? 'bg-[#25272e] text-white' : 'text-neutral-300'
            }`}
            title="Schnitt- und Bearbeitungsoperationen (Undo, Redo, Cut, Copy, Paste, Stems)"
          >
            Bearbeiten
          </button>
          {activeMenu === 'bearbeiten' && (
            <div className="absolute left-0 top-6 w-56 bg-[#16171b] border border-[#2b2d35] rounded-sm shadow-2xl py-1 z-50 text-[11.5px]">
              <button
                onClick={() => { onUndo(); setActiveMenu(null); }}
                disabled={!canUndo}
                className="w-full text-left px-3 py-1.5 hover:bg-[#0088ff] hover:text-white disabled:opacity-40 flex justify-between"
                title="Macht die letzte Audio-Bearbeitung rückgängig"
              >
                <span>Rückgängig (Undo)</span>
                <span className="text-neutral-500 hover:text-neutral-200">Ctrl+Z</span>
              </button>
              <button
                onClick={() => { onRedo(); setActiveMenu(null); }}
                disabled={!canRedo}
                className="w-full text-left px-3 py-1.5 hover:bg-[#0088ff] hover:text-white disabled:opacity-40 flex justify-between"
                title="Wiederholt den zuletzt rückgängig gemachten Schritt"
              >
                <span>Wiederholen (Redo)</span>
                <span className="text-neutral-500 hover:text-neutral-200">Ctrl+Y</span>
              </button>

              <div className="h-px bg-[#262830] my-1" />

              {onCopy && (
                <button
                  onClick={() => { onCopy(); setActiveMenu(null); }}
                  disabled={!hasSelection}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#0088ff] hover:text-white disabled:opacity-40 flex justify-between"
                  title="Kopiert den markierten Wellenformbereich in die verlustfreie Zwischenablage"
                >
                  <span className="flex items-center space-x-1.5">
                    <Copy size={11} />
                    <span>Kopieren (Copy)</span>
                  </span>
                  <span className="text-neutral-500">Ctrl+C</span>
                </button>
              )}

              {onCut && (
                <button
                  onClick={() => { onCut(); setActiveMenu(null); }}
                  disabled={!hasSelection}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#0088ff] hover:text-white disabled:opacity-40 flex justify-between"
                  title="Schneidet die Auswahl aus und legt sie in der Zwischenablage ab"
                >
                  <span className="flex items-center space-x-1.5">
                    <Scissors size={11} />
                    <span>Ausschneiden (Cut)</span>
                  </span>
                  <span className="text-neutral-500">Ctrl+X</span>
                </button>
              )}

              {onPaste && (
                <button
                  onClick={() => { onPaste(); setActiveMenu(null); }}
                  disabled={!hasClipboard}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#0088ff] hover:text-white disabled:opacity-40 flex justify-between"
                  title="Fügt den Clip an der aktuellen Cursorposition ein"
                >
                  <span className="flex items-center space-x-1.5">
                    <ClipboardPaste size={11} />
                    <span>Einfügen (Paste)</span>
                  </span>
                  <span className="text-neutral-500">Ctrl+V</span>
                </button>
              )}

              {onDelete && (
                <button
                  onClick={() => { onDelete(); setActiveMenu(null); }}
                  disabled={!hasSelection}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#0088ff] hover:text-white disabled:opacity-40 flex justify-between text-[#ff5549]"
                  title="Auswahl löschen (Standard-Löschen oder Ripple Delete)"
                >
                  <span className="flex items-center space-x-1.5">
                    <Trash2 size={11} />
                    <span>Löschen (Delete)…</span>
                  </span>
                  <span className="text-neutral-500">Del</span>
                </button>
              )}

              <div className="h-px bg-[#262830] my-1" />

              {onSeparateStems && (
                <button
                  onClick={() => { onSeparateStems(); setActiveMenu(null); }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#0088ff] hover:text-white flex justify-between items-center text-[#00c8ff] font-medium"
                  title="Startet die KI-Stem-Separation mit dem in den Einstellungen konfigurierten Modell"
                >
                  <span className="flex items-center space-x-1.5">
                    <Sparkles size={12} className="text-[#00c8ff]" />
                    <span>Stems jetzt trennen...</span>
                  </span>
                  <span className="text-[9px] bg-[#0088ff]/30 text-[#00c8ff] px-1 rounded font-mono">KI</span>
                </button>
              )}

              {onOpenEditAssistant && (
                <button
                  onClick={() => { onOpenEditAssistant(); setActiveMenu(null); }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#0088ff] hover:text-white flex justify-between items-center text-[#00e5ff]"
                  title="Prüft die Integrität von Zwischenablage und Auswahlbereich"
                >
                  <span className="flex items-center space-x-1.5">
                    <ShieldCheck size={12} className="text-[#00e5ff]" />
                    <span>Edit Assistant prüfen...</span>
                  </span>
                </button>
              )}

              {onClearHistory && hasHistory && (
                <button
                  onClick={() => { onClearHistory(); setActiveMenu(null); }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#ff3b30] hover:text-white flex justify-between items-center text-[#ff8a80]"
                  title="Löscht den Undo/Redo-Verlauf zur Freigabe von Arbeitsspeicher"
                >
                  <span className="flex items-center space-x-1.5">
                    <Trash2 size={11} />
                    <span>Bearbeitungsverlauf leeren...</span>
                  </span>
                </button>
              )}

              {onOpenMidiModal && (
                <button
                  onClick={() => { onOpenMidiModal(); setActiveMenu(null); }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#0088ff] hover:text-white flex justify-between items-center text-[#00e676]"
                  title="Pioneer DDJ-FLX4 & DDJ-1000 MIDI Controller und Action Pad Mapping öffnen"
                >
                  <span className="flex items-center space-x-1.5">
                    <Radio size={12} className="text-[#00e676]" />
                    <span>Pioneer MIDI Controller (DDJ-FLX4 / 1000)...</span>
                  </span>
                  <span className="text-[9px] bg-emerald-500/20 text-[#00e676] px-1 rounded font-mono">PADS</span>
                </button>
              )}
            </div>
          )}
        </div>

        {/* Betrachten */}
        <div className="relative">
          <button
            onClick={() => toggleMenu('betrachten')}
            className={`px-2.5 py-0.5 rounded text-[11.5px] hover:bg-[#202228] transition-colors ${
              activeMenu === 'betrachten' ? 'bg-[#25272e] text-white' : 'text-neutral-300'
            }`}
            title="Ansichten, Farbpaletten und Wellenform-Modi einstellen"
          >
            Betrachten
          </button>
          {activeMenu === 'betrachten' && (
            <div className="absolute left-0 top-6 w-52 bg-[#16171b] border border-[#2b2d35] rounded-sm shadow-2xl py-1 z-50 text-[11.5px]">
              <div className="px-3 py-1 text-[10px] text-neutral-500 uppercase tracking-wider">
                Waveform-Modus
              </div>
              <button
                onClick={() => { onSetWaveformMode('BLUE'); setActiveMenu(null); }}
                className={`w-full text-left px-3 py-1.5 hover:bg-[#0088ff] hover:text-white flex items-center justify-between ${
                  waveformMode === 'BLUE' ? 'text-[#00a2ff] font-medium' : ''
                }`}
                title="Monochrome blaue Rekordbox-Wellenform"
              >
                <span>BLUE (Monochrom)</span>
                {waveformMode === 'BLUE' && <span>✓</span>}
              </button>
              <button
                onClick={() => { onSetWaveformMode('RGB'); setActiveMenu(null); }}
                className={`w-full text-left px-3 py-1.5 hover:bg-[#0088ff] hover:text-white flex items-center justify-between ${
                  waveformMode === 'RGB' ? 'text-[#00a2ff] font-medium' : ''
                }`}
                title="RGB-Farben nach Frequenzbändern (Rot=Bass, Grün=Mitten, Blau=Höhen)"
              >
                <span>RGB (Frequenzfarben)</span>
                {waveformMode === 'RGB' && <span>✓</span>}
              </button>
              <button
                onClick={() => { onSetWaveformMode('3BAND'); setActiveMenu(null); }}
                className={`w-full text-left px-3 py-1.5 hover:bg-[#0088ff] hover:text-white flex items-center justify-between ${
                  waveformMode === '3BAND' ? 'text-[#00a2ff] font-medium' : ''
                }`}
                title="3 getrennte Frequenzbänder (Pioneer 3-Band Waveform)"
              >
                <span>3BAND (Low / Mid / High)</span>
                {waveformMode === '3BAND' && <span>✓</span>}
              </button>
              <div className="h-px bg-[#262830] my-1" />
              {onToggleEditPalette && (
                <button
                  onClick={() => { onToggleEditPalette(); setActiveMenu(null); }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#0088ff] hover:text-white flex justify-between items-center"
                  title="Untere Palette für Beat Select, Auswahl und Schnittoperationen ein-/ausblenden"
                >
                  <span>Editierpalette (Unten)</span>
                  <span className="flex items-center space-x-2">
                    <span className="text-neutral-500 text-[10px]">E</span>
                    <span>{editPaletteOpen ? '✓' : ''}</span>
                  </span>
                </button>
              )}
              <button
                onClick={() => { onTogglePalette(); setActiveMenu(null); }}
                className="w-full text-left px-3 py-1.5 hover:bg-[#0088ff] hover:text-white flex justify-between items-center"
                title="Rechte Clip-Palette für geschnittene Audioschnipsel ein-/ausblenden"
              >
                <span>Clip-Palette (Rechts)</span>
                <span className="flex items-center space-x-2">
                  <span className="text-neutral-500 text-[10px]">P</span>
                  <span>{paletteOpen ? '✓' : ''}</span>
                </span>
              </button>
              {onMaximizeWaveform && (
                <button
                  onClick={() => { onMaximizeWaveform(); setActiveMenu(null); }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#0088ff] hover:text-white flex justify-between items-center text-[#00c8ff]"
                  title="Maximiert den Wellenformbereich über die volle Fensterhöhe"
                >
                  <span>Wellenform maximieren (Zen)</span>
                  <span className="text-neutral-400 text-[10px]">M</span>
                </button>
              )}
              <button
                onClick={() => { onToggleBrowser(); setActiveMenu(null); }}
                className="w-full text-left px-3 py-1.5 hover:bg-[#0088ff] hover:text-white flex justify-between"
                title="Browser & Multi-Track Leiste ein-/ausblenden"
              >
                <span>Browser &amp; Multi-Track</span>
                <span>{browserOpen ? '✓' : ''}</span>
              </button>
              {onToggleChatbot && (
                <button
                  onClick={() => { onToggleChatbot(); setActiveMenu(null); }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#0088ff] hover:text-white flex items-center justify-between text-[#00a2ff] hover:text-white font-medium"
                  title="KI-gestützten DJ-Copiloten für Mix-Analysen und Cue-Vorschläge öffnen"
                >
                  <span className="flex items-center space-x-1.5">
                    <Sparkles size={11} />
                    <span>AI Smart Copilot Palette</span>
                  </span>
                  <span>{chatbotOpen ? '✓' : ''}</span>
                </button>
              )}
            </div>
          )}
        </div>

        {/* Hilfe */}
        <div className="relative">
          <button
            onClick={() => toggleMenu('hilfe')}
            className={`px-2.5 py-0.5 rounded text-[11.5px] hover:bg-[#202228] transition-colors ${
              activeMenu === 'hilfe' ? 'bg-[#25272e] text-white' : 'text-neutral-300'
            }`}
            title="Hilfe, Ersteinrichtung, Demotrack und System-Diagnose"
          >
            Hilfe
          </button>
          {activeMenu === 'hilfe' && (
            <div className="absolute left-0 top-6 w-64 bg-[#16171b] border border-[#2b2d35] rounded-sm shadow-2xl py-1 z-50 text-[11.5px]">
              {onOpenInitialSetup && (
                <button
                  onClick={() => { onOpenInitialSetup(); setActiveMenu(null); }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#0088ff] hover:text-white text-[#00c8ff] font-semibold flex items-center justify-between"
                  title="Ersteinrichtungs- und Installationsassistenten öffnen"
                >
                  <span className="flex items-center gap-1.5">
                    <Wand2 size={12} />
                    <span>Ersteinrichtung &amp; KI-Installer…</span>
                  </span>
                  <span className="text-[9px] bg-[#0088ff]/20 text-[#00c8ff] px-1 rounded font-mono">SETUP</span>
                </button>
              )}
              {onLoadDemoTrack && (
                <button
                  onClick={() => { onLoadDemoTrack(); setActiveMenu(null); }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#0088ff] hover:text-white text-[#00a2ff]"
                  title="Lädt den mitgelieferten Demo-Referenztrack mit Beatgrid und Cues"
                >
                  Demo-Referenztrack laden (La Roux)...
                </button>
              )}
              <button
                onClick={() => { onShowInfo(); setActiveMenu(null); }}
                className="w-full text-left px-3 py-1.5 hover:bg-[#0088ff] hover:text-white"
                title="Informationen zu Rekordbox-Datenquellen und Non-Destructive Originalschutz"
              >
                Rekordbox Daten &amp; Originalschutz...
              </button>
              <div className="border-t border-[#2b2d35] my-1" />
              <button
                onClick={() => { onOpenSystemLogs?.(); setActiveMenu(null); }}
                className="w-full text-left px-3 py-1.5 hover:bg-[#0088ff] hover:text-white"
                title="System-Diagnoseprotokoll für Fehler und Inferenzzeiten öffnen"
              >
                System-Protokoll...
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Right side: Quick access triggers */}
      <div className="flex items-center space-x-1.5">
        {onToggleChatbot && (
          <button
            onClick={onToggleChatbot}
            className={`flex items-center space-x-1.5 px-2.5 py-0.5 rounded text-[10.5px] font-mono font-bold transition-all shadow-sm cursor-pointer ${
              chatbotOpen
                ? 'bg-gradient-to-r from-[#0088ff] to-[#7c3aed] text-white border border-blue-400/50 shadow-blue-500/20'
                : 'bg-[#181a24] hover:bg-[#202330] text-neutral-200 border border-[#2d3144] hover:border-[#0088ff]/50'
            }`}
            title="AI Smart Copilot Palette öffnen / schließen (Mix-Analysen &amp; DJ-Tipps)"
          >
            <Sparkles size={11} className={chatbotOpen ? 'text-amber-300 animate-spin' : 'text-[#00a2ff]'} />
            <span className="tracking-wider">AI COPILOT</span>
            <span className={`w-1.5 h-1.5 rounded-full ${chatbotOpen ? 'bg-emerald-400 animate-ping' : 'bg-[#00a2ff]'}`} />
          </button>
        )}
        {onOpenXmlCollection && (
          <button
            onClick={onOpenXmlCollection}
            className="flex items-center space-x-1 px-2 py-0.5 rounded bg-[#181a24] hover:bg-[#0088ff] text-neutral-300 hover:text-white border border-[#2c2f3f] text-[10px] transition-colors"
            title="Rekordbox XML Track-Auswahl Pop-up öffnen (Schnellzugriff auf alle importierten Tracks)"
          >
            <Disc size={11} className="text-[#00e5ff]" />
            <span className="font-semibold tracking-wide">XML Track-Auswahl</span>
          </button>
        )}
        {onOpenDatabaseInspector && (
          <button
            onClick={onOpenDatabaseInspector}
            className="flex items-center space-x-1 px-2 py-0.5 rounded bg-[#0088ff]/15 hover:bg-[#0088ff] text-[#00a2ff] hover:text-white border border-[#0088ff]/30 text-[10px] transition-colors"
            title="Rekordbox Datenbank &amp; ANLZ Wellenform-Extraktor öffnen"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-[#10b981] inline-block animate-pulse" />
            <span className="font-semibold tracking-wide">DB-Extraktor</span>
          </button>
        )}
      </div>
    </div>
  );
};
