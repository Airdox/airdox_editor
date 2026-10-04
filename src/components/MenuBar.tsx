/**
 * @license
 * airdox_SMART_Editor – Menüleiste (Teil von ZONE 1).
 *
 * Seit UI v2.0 ist dies KEINE eigene Zeile mehr: die vier Menüs
 * (Datei, Bearbeiten, Betrachten, Hilfe) sitzen als Cluster in der globalen
 * Top-Bar (Zone1TopBar). Damit gibt es keine dritte Leiste zwischen
 * Fenstertitelleiste und Wellenform – Zone 1 ist genau eine Leiste.
 *
 * Was hier bewusst NICHT mehr steht:
 *   - der frühere rechte Schnellzugriff (AI COPILOT / TRACK-IMPORT /
 *     DB-Extraktor): „TRACK-IMPORT" war die redundante Import-Schaltfläche, die
 *     das Ausschlusskriterium von Zone 1 verbietet. Track-Import liegt im Menü
 *     „Datei"; Copilot und DB-Extraktor sind globale Werkzeuge und stehen
 *     rechts in Zone1TopBar.
 *   - ein Prozessstatus im Menüpunkt („Sammlung wird geladen…"): Zone 1 kennt
 *     keinen temporären Status. Ist die Sammlung am Laden, bleibt der Eintrag
 *     schlicht deaktiviert; den Fortschritt meldet die flüchtige Statuskarte
 *     (TransientStatusToast) außerhalb der Zonen.
 */

import React, { useState, useRef, useEffect } from 'react';
import {
  Trash2,
  ShieldCheck,
  Scissors,
  Copy,
  ClipboardPaste,
  Sparkles,
  Radio,
  Plus,
  Wand2,
  FolderOpen,
  Save,
  BrainCircuit,
} from 'lucide-react';
import { WaveformMode } from '../types/rekordbox';
import type { Zone3SectionId } from '../ui/workspaceLayout';

export interface MenuBarProps {
  onNewProject: () => void;
  onSaveProject: () => void;
  onOpenProject: () => void;
  onImportTracks: () => void;
  /** Nur zum Deaktivieren des Menüpunkts – kein Status in Zone 1. */
  trackImportLoading?: boolean;
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
  /** Offene Sektion in Zone 3 (Reiter). `null` = alles eingeklappt. */
  zone3Section?: Zone3SectionId | null;
  onToggleZone3Section?: (section: Zone3SectionId) => void;
  /** Fokus-Modus „Max. Platz / Alles einklappen". */
  focusMode?: boolean;
  onToggleFocusMode?: () => void;
  browserOpen: boolean;
  onToggleBrowser: () => void;
  chatbotOpen?: boolean;
  onToggleChatbot?: () => void;
  onShowInfo: () => void;
  onOpenDatabaseInspector?: () => void;
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
  /** Modell-Editor öffnen („Modelle & Architekturen"). */
  onOpenStemModels?: () => void;
}

const MENU_ITEM =
  'w-full text-left px-3 py-1.5 hover:bg-[#0088ff] hover:text-white disabled:opacity-40 disabled:hover:bg-transparent flex justify-between items-center gap-3';

export const MenuBar: React.FC<MenuBarProps> = ({
  onNewProject,
  onSaveProject,
  onOpenProject,
  onImportTracks,
  trackImportLoading = false,
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
  zone3Section = null,
  onToggleZone3Section,
  focusMode = false,
  onToggleFocusMode,
  browserOpen,
  onToggleBrowser,
  chatbotOpen,
  onToggleChatbot,
  onShowInfo,
  onOpenDatabaseInspector,
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
  onOpenStemModels,
}) => {
  const [activeMenu, setActiveMenu] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setActiveMenu(null);
      }
    };
    window.addEventListener('mousedown', handleClickOutside);
    return () => window.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const toggleMenu = (name: string) => setActiveMenu(activeMenu === name ? null : name);
  const runAndClose = (action: () => void) => () => {
    action();
    setActiveMenu(null);
  };
  const triggerClass = (name: string) =>
    `px-2.5 py-1 rounded text-[11.5px] transition-colors ${
      activeMenu === name ? 'bg-[#25272e] text-white' : 'text-neutral-300 hover:bg-[#1b1d26] hover:text-white'
    }`;
  const dropdownClass = 'absolute left-0 top-full mt-1 bg-[#16171b] border border-[#2b2d35] rounded-sm shadow-2xl py-1 z-50 text-[11.5px]';

  return (
    <div ref={menuRef} className="flex items-center gap-0.5 text-xs select-none relative flex-shrink-0" data-zone1-cluster="menu">
      {/* ── Datei ─────────────────────────────────────────────────────────── */}
      <div className="relative">
        <button type="button" onClick={() => toggleMenu('datei')} className={triggerClass('datei')} title="Projekt- und Dateioperationen (Neu, Öffnen, Speichern, Import, Export)">
          Datei
        </button>
        {activeMenu === 'datei' && (
          <div className={`${dropdownClass} w-64`}>
            <button type="button" onClick={runAndClose(onNewProject)} className={MENU_ITEM} title="Erstellt ein neues, leeres Editor-Projekt">
              <span className="flex items-center gap-1.5"><Plus size={11} /><span>Neues Projekt</span></span>
              <span className="text-neutral-500">Ctrl+N</span>
            </button>
            <button type="button" onClick={runAndClose(onOpenProject)} className={MENU_ITEM} title="Öffnet ein bestehendes .airdox.json Projekt">
              <span className="flex items-center gap-1.5"><FolderOpen size={11} /><span>Projekt öffnen…</span></span>
              <span className="text-neutral-500">Ctrl+Shift+O</span>
            </button>
            <button type="button" onClick={runAndClose(onSaveProject)} className={MENU_ITEM} title="Speichert den aktuellen Bearbeitungsstand nicht-destruktiv">
              <span className="flex items-center gap-1.5"><Save size={11} /><span>Projekt speichern…</span></span>
              <span className="text-neutral-500">Ctrl+S</span>
            </button>
            <div className="h-px bg-[#262830] my-1" />
            {onOpenDatabaseInspector && (
              <button type="button" onClick={runAndClose(onOpenDatabaseInspector)} className={`${MENU_ITEM} text-[#00a2ff] font-medium`} title="Rekordbox SQLite-Datenbank & ANLZ-Wellenformen direkt analysieren">
                <span>Daten- &amp; Waveform-Extraktor (DB/ANLZ)…</span>
              </button>
            )}
            <button type="button" onClick={runAndClose(onImportTracks)} disabled={trackImportLoading} className={MENU_ITEM} title="Die eingebettete Rekordbox-Sammlung öffnen und einen Originaltrack auswählen">
              <span>Track-Import…</span>
              <span className="text-neutral-500">Ctrl+O</span>
            </button>
            <button type="button" onClick={runAndClose(onImportAudio)} className={MENU_ITEM} title="Eigenständige Audiodatei (WAV, MP3, FLAC, AIFF) in Deck A laden">
              <span>Audiodatei laden (WAV, MP3, FLAC)…</span>
            </button>
            {onOpenRecorder && (
              <button type="button" onClick={runAndClose(onOpenRecorder)} className={`${MENU_ITEM} text-[#ff5147] font-semibold`} title="Professionellen DJ-Set- und Mikrofon-Recorder öffnen">
                <span className="flex items-center gap-1.5"><Radio size={12} /><span>Pro Recorder öffnen…</span></span>
                <span className="text-neutral-500">F9</span>
              </button>
            )}
            <div className="h-px bg-[#262830] my-1" />
            <button type="button" onClick={runAndClose(onExportWav)} className={MENU_ITEM} title="Gemasterte WAV-Audiodatei in voller 24-Bit/32-Bit-Qualität exportieren">
              <span>Master als WAV exportieren…</span>
              <span className="text-neutral-500">Ctrl+E</span>
            </button>
            <button type="button" onClick={runAndClose(onExportXml)} className={MENU_ITEM} title="Aktualisierte XML-Metadaten für Pioneer Rekordbox exportieren">
              <span>Rekordbox XML exportieren…</span>
            </button>
          </div>
        )}
      </div>

      {/* ── Bearbeiten ────────────────────────────────────────────────────── */}
      <div className="relative">
        <button type="button" onClick={() => toggleMenu('bearbeiten')} className={triggerClass('bearbeiten')} title="Schnitt- und Bearbeitungsoperationen (Undo, Redo, Cut, Copy, Paste, Stems)">
          Bearbeiten
        </button>
        {activeMenu === 'bearbeiten' && (
          <div className={`${dropdownClass} w-60`}>
            <button type="button" onClick={runAndClose(onUndo)} disabled={!canUndo} className={MENU_ITEM} title="Macht die letzte Audio-Bearbeitung rückgängig">
              <span>Rückgängig (Undo)</span>
              <span className="text-neutral-500">Ctrl+Z</span>
            </button>
            <button type="button" onClick={runAndClose(onRedo)} disabled={!canRedo} className={MENU_ITEM} title="Wiederholt den zuletzt rückgängig gemachten Schritt">
              <span>Wiederholen (Redo)</span>
              <span className="text-neutral-500">Ctrl+Y</span>
            </button>
            <div className="h-px bg-[#262830] my-1" />
            {onCopy && (
              <button type="button" onClick={runAndClose(onCopy)} disabled={!hasSelection} className={MENU_ITEM} title="Kopiert den markierten Wellenformbereich in die verlustfreie Zwischenablage">
                <span className="flex items-center gap-1.5"><Copy size={11} /><span>Kopieren (Copy)</span></span>
                <span className="text-neutral-500">Ctrl+C</span>
              </button>
            )}
            {onCut && (
              <button type="button" onClick={runAndClose(onCut)} disabled={!hasSelection} className={MENU_ITEM} title="Schneidet die Auswahl aus und legt sie in der Zwischenablage ab">
                <span className="flex items-center gap-1.5"><Scissors size={11} /><span>Ausschneiden (Cut)</span></span>
                <span className="text-neutral-500">Ctrl+X</span>
              </button>
            )}
            {onPaste && (
              <button type="button" onClick={runAndClose(onPaste)} disabled={!hasClipboard} className={MENU_ITEM} title="Fügt den Clip an der aktuellen Cursorposition ein">
                <span className="flex items-center gap-1.5"><ClipboardPaste size={11} /><span>Einfügen (Paste)</span></span>
                <span className="text-neutral-500">Ctrl+V</span>
              </button>
            )}
            {onDelete && (
              <button type="button" onClick={runAndClose(onDelete)} disabled={!hasSelection} className={`${MENU_ITEM} text-[#ff5549]`} title="Auswahl löschen (Standard-Löschen oder Ripple Delete)">
                <span className="flex items-center gap-1.5"><Trash2 size={11} /><span>Löschen (Delete)…</span></span>
                <span className="text-neutral-500">Del</span>
              </button>
            )}
            <div className="h-px bg-[#262830] my-1" />
            {onOpenStemModels && (
              <button type="button" onClick={runAndClose(onOpenStemModels)} className={`${MENU_ITEM} text-[#00c8ff]`} title="Modelle und Architekturen der Stem-Separation verwalten (ausgelagerte Modell-Auswahl)">
                <span className="flex items-center gap-1.5"><BrainCircuit size={12} /><span>Stem-Modelle &amp; Architekturen…</span></span>
              </button>
            )}
            {onSeparateStems && (
              <button type="button" onClick={runAndClose(onSeparateStems)} className={`${MENU_ITEM} text-[#00c8ff] font-medium`} title="Öffnet das Stem-Center in Zone 2 und startet die Separation mit dem gewählten Modell">
                <span className="flex items-center gap-1.5"><Sparkles size={12} /><span>Stem-Separation starten…</span></span>
                <span className="text-[9px] bg-[#0088ff]/30 text-[#00c8ff] px-1 rounded font-mono">KI</span>
              </button>
            )}
            {onOpenEditAssistant && (
              <button type="button" onClick={runAndClose(onOpenEditAssistant)} className={`${MENU_ITEM} text-[#00e5ff]`} title="Prüft die Integrität von Zwischenablage und Auswahlbereich">
                <span className="flex items-center gap-1.5"><ShieldCheck size={12} /><span>Edit Assistant prüfen…</span></span>
              </button>
            )}
            {onClearHistory && hasHistory && (
              <button type="button" onClick={runAndClose(onClearHistory)} className={`${MENU_ITEM} text-[#ff8a80] hover:!bg-[#ff3b30] hover:!text-white`} title="Löscht den Undo/Redo-Verlauf zur Freigabe von Arbeitsspeicher">
                <span className="flex items-center gap-1.5"><Trash2 size={11} /><span>Bearbeitungsverlauf leeren…</span></span>
              </button>
            )}
            {onOpenMidiModal && (
              <button type="button" onClick={runAndClose(onOpenMidiModal)} className={`${MENU_ITEM} text-[#00e676]`} title="Pioneer DDJ-FLX4 & DDJ-1000 MIDI Controller und Action-Pad-Mapping öffnen">
                <span className="flex items-center gap-1.5"><Radio size={12} /><span>Pioneer MIDI Controller (DDJ-FLX4 / 1000)…</span></span>
                <span className="text-[9px] bg-emerald-500/20 text-[#00e676] px-1 rounded font-mono">PADS</span>
              </button>
            )}
          </div>
        )}
      </div>

      {/* ── Betrachten ────────────────────────────────────────────────────── */}
      <div className="relative">
        <button type="button" onClick={() => toggleMenu('betrachten')} className={triggerClass('betrachten')} title="Ansichten, Farbpaletten, Wellenform-Modi und Fokus-Modus einstellen">
          Betrachten
        </button>
        {activeMenu === 'betrachten' && (
          <div className={`${dropdownClass} w-60`}>
            <div className="px-3 py-1 text-[10px] text-neutral-500 uppercase tracking-wider">Waveform-Modus</div>
            {(
              [
                ['BLUE', 'BLUE (Monochrom)', 'Monochrome blaue Rekordbox-Wellenform'],
                ['RGB', 'RGB (Frequenzfarben)', 'RGB-Farben nach Frequenzbändern (Rot=Bass, Grün=Mitten, Blau=Höhen)'],
                ['3BAND', '3BAND (Low / Mid / High)', '3 getrennte Frequenzbänder (Pioneer 3-Band Waveform)'],
              ] as const
            ).map(([mode, label, hint]) => (
              <button
                key={mode}
                type="button"
                onClick={runAndClose(() => onSetWaveformMode(mode as WaveformMode))}
                className={`w-full text-left px-3 py-1.5 hover:bg-[#0088ff] hover:text-white flex items-center justify-between ${
                  waveformMode === mode ? 'text-[#00a2ff] font-medium' : ''
                }`}
                title={hint}
              >
                <span>{label}</span>
                {waveformMode === mode && <span>✓</span>}
              </button>
            ))}
            <div className="h-px bg-[#262830] my-1" />
            {onToggleFocusMode && (
              <button type="button" onClick={runAndClose(onToggleFocusMode)} className={`${MENU_ITEM} ${focusMode ? 'text-[#00e5ff]' : ''}`} title="Max. Platz: alle Panels in Zone 2 und Zone 3 schließen und die Wellenform auf die volle Höhe skalieren">
                <span>Max. Platz / Alles einklappen</span>
                <span className="flex items-center gap-2">
                  <span className="text-neutral-500 text-[10px]">M</span>
                  <span>{focusMode ? '✓' : ''}</span>
                </span>
              </button>
            )}
            {onToggleZone3Section && (
              <button type="button" onClick={runAndClose(() => onToggleZone3Section('EDIT'))} className={MENU_ITEM} title="Untere Bearbeitungs-Palette (BEAT SELECT, SELECT, EDIT) ein-/ausklappen">
                <span>Editierpalette (Unten)</span>
                <span className="flex items-center gap-2">
                  <span className="text-neutral-500 text-[10px]">E</span>
                  <span>{zone3Section === 'EDIT' ? '✓' : ''}</span>
                </span>
              </button>
            )}
            <button type="button" onClick={runAndClose(onTogglePalette)} className={MENU_ITEM} title="Rechte Clip-Palette für geschnittene Audioschnipsel ein-/ausblenden">
              <span>Clip-Palette (Rechts)</span>
              <span className="flex items-center gap-2">
                <span className="text-neutral-500 text-[10px]">P</span>
                <span>{paletteOpen ? '✓' : ''}</span>
              </span>
            </button>
            <button type="button" onClick={runAndClose(onToggleBrowser)} className={MENU_ITEM} title="Sammlungsleiste (Browser) am unteren Rand ein-/ausblenden">
              <span>Browser &amp; Multi-Track</span>
              <span>{browserOpen ? '✓' : ''}</span>
            </button>
            {onToggleChatbot && (
              <button type="button" onClick={runAndClose(onToggleChatbot)} className={`${MENU_ITEM} text-[#00a2ff] font-medium`} title="KI-gestützten DJ-Copiloten für Mix-Analysen und Cue-Vorschläge öffnen">
                <span className="flex items-center gap-1.5"><Sparkles size={11} /><span>AI Smart Copilot Palette</span></span>
                <span>{chatbotOpen ? '✓' : ''}</span>
              </button>
            )}
            {onAnalyzeMixIn && (
              <button type="button" onClick={runAndClose(onAnalyzeMixIn)} className={MENU_ITEM} title="Mix-In-Analyse mit dem Copiloten starten">
                <span>Mix-In-Analyse starten…</span>
              </button>
            )}
          </div>
        )}
      </div>

      {/* ── Hilfe ─────────────────────────────────────────────────────────── */}
      <div className="relative">
        <button type="button" onClick={() => toggleMenu('hilfe')} className={triggerClass('hilfe')} title="Hilfe, Ersteinrichtung und System-Diagnose">
          Hilfe
        </button>
        {activeMenu === 'hilfe' && (
          <div className={`${dropdownClass} w-64`}>
            {onOpenInitialSetup && (
              <button type="button" onClick={runAndClose(onOpenInitialSetup)} className={`${MENU_ITEM} text-[#00c8ff] font-semibold`} title="Ersteinrichtungs- und Installationsassistenten öffnen">
                <span className="flex items-center gap-1.5"><Wand2 size={12} /><span>Ersteinrichtung &amp; KI-Installer…</span></span>
                <span className="text-[9px] bg-[#0088ff]/20 text-[#00c8ff] px-1 rounded font-mono">SETUP</span>
              </button>
            )}
            <button type="button" onClick={runAndClose(onShowInfo)} className={MENU_ITEM} title="Informationen zu Rekordbox-Datenquellen und Non-Destructive-Originalschutz">
              <span>Rekordbox-Daten &amp; Originalschutz…</span>
            </button>
            <div className="h-px bg-[#262830] my-1" />
            <button type="button" onClick={runAndClose(() => onOpenSystemLogs?.())} className={MENU_ITEM} title="System-Diagnoseprotokoll für Fehler und Inferenzzeiten öffnen">
              <span>System-Protokoll…</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
