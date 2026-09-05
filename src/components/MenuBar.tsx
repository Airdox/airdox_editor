/**
 * @license
 * Rekordbox MenuBar Component
 * German/English standard menu bar matching the authoritative reference
 */

import React, { useState, useRef, useEffect } from 'react';
import { Disc, FolderOpen, Save, SaveAll, Sparkles, Layers } from 'lucide-react';
import { WaveformMode } from '../types/rekordbox';
import { WAVEFORM_MODES } from '../waveform/colors';

interface MenuBarProps {
  onNewProject: () => void;
  onSaveProject: () => void;
  onSaveProjectAs: () => void;
  onOpenProject: () => void;
  onExportClips: () => void;
  onLoadDemoTrack: () => void;
  projectPath: string | null;
  isDirty: boolean;
  canSaveProject: boolean;
  hasSelection: boolean;
  onCopySelectionToEnd: () => void;
  onMoveSelectionToStart: () => void;
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
  browserOpen: boolean;
  onToggleBrowser: () => void;
  onShowInfo: () => void;
  onOpenDatabaseInspector?: () => void;
  onOpenXmlCollection?: () => void;
  onOpenSystemLogs?: () => void;
}

export const MenuBar: React.FC<MenuBarProps> = ({
  onNewProject,
  onSaveProject,
  onSaveProjectAs,
  onOpenProject,
  onExportClips,
  onLoadDemoTrack,
  projectPath,
  isDirty,
  canSaveProject,
  hasSelection,
  onCopySelectionToEnd,
  onMoveSelectionToStart,
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
  browserOpen,
  onToggleBrowser,
  onShowInfo,
  onOpenDatabaseInspector,
  onOpenXmlCollection,
  onOpenSystemLogs,
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
          >
            Datei
          </button>
          {activeMenu === 'datei' && (
            <div className="absolute left-0 top-6 w-64 bg-[#16171b] border border-[#2b2d35] rounded-sm shadow-2xl py-1 z-50 text-[11.5px]">
              <button
                onClick={() => { onNewProject(); setActiveMenu(null); }}
                className="w-full text-left px-3 py-1.5 hover:bg-[#0088ff] hover:text-white flex justify-between"
              >
                <span>Neues Projekt</span>
                <span className="text-neutral-500 hover:text-neutral-200">Ctrl+N</span>
              </button>
              <button
                onClick={() => { onOpenProject(); setActiveMenu(null); }}
                className="w-full text-left px-3 py-1.5 hover:bg-[#0088ff] hover:text-white flex justify-between"
              >
                <span className="flex items-center space-x-1.5">
                  <FolderOpen size={12} />
                  <span>Projekt öffnen…</span>
                </span>
                <span className="text-neutral-500 hover:text-neutral-200">Ctrl+Shift+O</span>
              </button>
              <div className="h-px bg-[#262830] my-1" />
              {onOpenDatabaseInspector && (
                <button
                  onClick={() => { onOpenDatabaseInspector(); setActiveMenu(null); }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#0088ff] hover:text-white flex justify-between text-[#00a2ff] font-medium"
                >
                  <span>Daten- &amp; Waveform-Extraktor (DB/ANLZ)...</span>
                </button>
              )}
              <button
                onClick={() => { onImportXml(); setActiveMenu(null); }}
                className="w-full text-left px-3 py-1.5 hover:bg-[#0088ff] hover:text-white flex justify-between"
              >
                <span>Rekordbox XML importieren...</span>
                <span className="text-neutral-500 hover:text-neutral-200">Ctrl+O</span>
              </button>
              {onOpenXmlCollection && (
                <button
                  onClick={() => { onOpenXmlCollection(); setActiveMenu(null); }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#0088ff] hover:text-white flex justify-between text-[#00e5ff] font-medium"
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
              >
                <span>Audiodatei laden (WAV, MP3, FLAC)...</span>
              </button>
              <div className="h-px bg-[#262830] my-1" />
              <button
                onClick={() => { onSaveProject(); setActiveMenu(null); }}
                disabled={!canSaveProject}
                className="w-full text-left px-3 py-1.5 hover:bg-[#0088ff] hover:text-white disabled:opacity-40 flex justify-between"
              >
                <span className="flex items-center space-x-1.5">
                  <Save size={12} />
                  <span>Projekt speichern{isDirty ? ' *' : '…'}</span>
                </span>
                <span className="text-neutral-500 hover:text-neutral-200">Ctrl+S</span>
              </button>
              <button
                onClick={() => { onSaveProjectAs(); setActiveMenu(null); }}
                disabled={!canSaveProject}
                className="w-full text-left px-3 py-1.5 hover:bg-[#0088ff] hover:text-white disabled:opacity-40 flex justify-between"
              >
                <span className="flex items-center space-x-1.5">
                  <SaveAll size={12} />
                  <span>Projekt speichern unter…</span>
                </span>
                <span className="text-neutral-500 hover:text-neutral-200">Ctrl+Shift+S</span>
              </button>
              {projectPath && (
                <div
                  className="px-3 py-1 text-[9.5px] text-neutral-500 truncate font-mono"
                  title={projectPath}
                >
                  {projectPath}
                </div>
              )}
              <div className="h-px bg-[#262830] my-1" />
              <button
                onClick={() => { onExportClips(); setActiveMenu(null); }}
                disabled={!canSaveProject}
                className="w-full text-left px-3 py-1.5 hover:bg-[#0088ff] hover:text-white disabled:opacity-40 flex justify-between"
              >
                <span className="flex items-center space-x-1.5">
                  <Layers size={12} />
                  <span>Palette-Clips als WAVs exportieren…</span>
                </span>
              </button>
              <button
                onClick={() => { onExportWav(); setActiveMenu(null); }}
                className="w-full text-left px-3 py-1.5 hover:bg-[#0088ff] hover:text-white flex justify-between"
              >
                <span>Master als WAV exportieren...</span>
                <span className="text-neutral-500 hover:text-neutral-200">Ctrl+E</span>
              </button>
              <button
                onClick={() => { onExportXml(); setActiveMenu(null); }}
                className="w-full text-left px-3 py-1.5 hover:bg-[#0088ff] hover:text-white flex justify-between"
              >
                <span>Rekordbox XML exportieren...</span>
              </button>
              <div className="h-px bg-[#262830] my-1" />
              <button
                onClick={() => { onLoadDemoTrack(); setActiveMenu(null); }}
                className="w-full text-left px-3 py-1.5 hover:bg-[#ff9500] hover:text-black flex justify-between text-[#ffb74d] font-medium"
                title="Deterministisch erzeugte Demospur: 8 Takte, 128 BPM"
              >
                <span className="flex items-center space-x-1.5">
                  <Sparkles size={12} />
                  <span>Demospur laden (8 Takte, 128 BPM)</span>
                </span>
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
          >
            Bearbeiten
          </button>
          {activeMenu === 'bearbeiten' && (
            <div className="absolute left-0 top-6 w-48 bg-[#16171b] border border-[#2b2d35] rounded-sm shadow-2xl py-1 z-50 text-[11.5px]">
              <button
                onClick={() => { onUndo(); setActiveMenu(null); }}
                disabled={!canUndo}
                className="w-full text-left px-3 py-1.5 hover:bg-[#0088ff] hover:text-white disabled:opacity-40 flex justify-between"
              >
                <span>Rückgängig (Undo)</span>
                <span className="text-neutral-500 hover:text-neutral-200">Ctrl+Z</span>
              </button>
              <button
                onClick={() => { onRedo(); setActiveMenu(null); }}
                disabled={!canRedo}
                className="w-full text-left px-3 py-1.5 hover:bg-[#0088ff] hover:text-white disabled:opacity-40 flex justify-between"
              >
                <span>Wiederholen (Redo)</span>
                <span className="text-neutral-500 hover:text-neutral-200">Ctrl+Y</span>
              </button>
              <div className="h-px bg-[#262830] my-1" />
              <button
                onClick={() => { onCopySelectionToEnd(); setActiveMenu(null); }}
                disabled={!hasSelection}
                className="w-full text-left px-3 py-1.5 hover:bg-[#0088ff] hover:text-white disabled:opacity-40 flex justify-between"
                title="Kopiert die Auswahl ans Ende und rastet sie auf den nächsten Taktanfang ein"
              >
                <span>Auswahl ans Ende kopieren</span>
                <span className="text-neutral-500 hover:text-neutral-200">Strg+J</span>
              </button>
              <button
                onClick={() => { onMoveSelectionToStart(); setActiveMenu(null); }}
                disabled={!hasSelection}
                className="w-full text-left px-3 py-1.5 hover:bg-[#0088ff] hover:text-white disabled:opacity-40 flex justify-between"
                title="Setzt die Auswahl an den Taktanfang und entfernt sie aus der Spur"
              >
                <span>Auswahl an den Taktanfang setzen</span>
                <span className="text-neutral-500 hover:text-neutral-200">Strg+M</span>
              </button>
              <div className="h-px bg-[#262830] my-1" />
              <div className="px-3 py-1 text-[10px] text-neutral-500 uppercase tracking-wider">
                Originalschutz aktiv (Read-Only)
              </div>
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
          >
            Betrachten
          </button>
          {activeMenu === 'betrachten' && (
            <div className="absolute left-0 top-6 w-52 bg-[#16171b] border border-[#2b2d35] rounded-sm shadow-2xl py-1 z-50 text-[11.5px]">
              <div className="px-3 py-1 text-[10px] text-neutral-500 uppercase tracking-wider">
                Waveform-Modus
              </div>
              {WAVEFORM_MODES.map((entry) => (
                <button
                  key={entry.mode}
                  onClick={() => { onSetWaveformMode(entry.mode); setActiveMenu(null); }}
                  className={`w-full text-left px-3 py-1.5 hover:bg-[#0088ff] hover:text-white flex items-center justify-between ${
                    waveformMode === entry.mode ? 'text-white' : 'text-neutral-300'
                  }`}
                  title={entry.hint}
                >
                  <span>{entry.label}</span>
                  {waveformMode === entry.mode && <span>✓</span>}
                </button>
              ))}

              <div className="h-px bg-[#262830] my-1" />
              <button
                onClick={() => { onTogglePalette(); setActiveMenu(null); }}
                className="w-full text-left px-3 py-1.5 hover:bg-[#0088ff] hover:text-white flex justify-between"
              >
                <span>Palette ein-/ausblenden</span>
                <span>{paletteOpen ? '✓' : ''}</span>
              </button>
              <button
                onClick={() => { onToggleBrowser(); setActiveMenu(null); }}
                className="w-full text-left px-3 py-1.5 hover:bg-[#0088ff] hover:text-white flex justify-between"
              >
                <span>Browser & Multi-Track</span>
                <span>{browserOpen ? '✓' : ''}</span>
              </button>
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
          >
            Hilfe
          </button>
          {activeMenu === 'hilfe' && (
            <div className="absolute left-0 top-6 w-56 bg-[#16171b] border border-[#2b2d35] rounded-sm shadow-2xl py-1 z-50 text-[11.5px]">
              <button
                onClick={() => { onShowInfo(); setActiveMenu(null); }}
                className="w-full text-left px-3 py-1.5 hover:bg-[#0088ff] hover:text-white"
              >
                Rekordbox Daten & Originalschutz...
              </button>
              <button
                onClick={() => { setActiveMenu(null); }}
                className="w-full text-left px-3 py-1.5 hover:bg-[#0088ff] hover:text-white"
              >
                Über Airdox_intelligents_Editor
              </button>
              <div className="border-t border-[#2b2d35] my-1" />
              <button
                onClick={() => { onOpenSystemLogs?.(); setActiveMenu(null); }}
                className="w-full text-left px-3 py-1.5 hover:bg-[#0088ff] hover:text-white"
              >
                System-Protokoll...
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Right side: Quick access triggers */}
      <div className="flex items-center space-x-1.5">
        {onOpenXmlCollection && (
          <button
            onClick={onOpenXmlCollection}
            className="flex items-center space-x-1 px-2 py-0.5 rounded bg-[#181a24] hover:bg-[#0088ff] text-neutral-300 hover:text-white border border-[#2c2f3f] text-[10px] transition-colors"
            title="Rekordbox XML Track-Auswahl Pop-up öffnen"
          >
            <Disc size={11} className="text-[#00e5ff]" />
            <span className="font-semibold tracking-wide">XML Track-Auswahl</span>
          </button>
        )}
        {onOpenDatabaseInspector && (
          <button
            onClick={onOpenDatabaseInspector}
            className="flex items-center space-x-1 px-2 py-0.5 rounded bg-[#0088ff]/15 hover:bg-[#0088ff] text-[#00a2ff] hover:text-white border border-[#0088ff]/30 text-[10px] transition-colors"
            title="Rekordbox Datenbank & Visualisierungs-Extraktor öffnen"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-[#10b981] inline-block animate-pulse" />
            <span className="font-semibold tracking-wide">DB-Extraktor</span>
          </button>
        )}
      </div>
    </div>
  );
};
