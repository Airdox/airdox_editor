/**
 * @license
 * Rekordbox MenuBar Component
 * German/English standard menu bar matching the authoritative reference
 */

import React, { useState, useRef, useEffect } from 'react';
import { Disc, Disc2 } from 'lucide-react';
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
  browserOpen: boolean;
  onToggleBrowser: () => void;
  onShowInfo: () => void;
  onOpenDatabaseInspector?: () => void;
  onOpenXmlCollection?: () => void;
  onOpenSystemLogs?: () => void;
  onOpenMixLab?: () => void;
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
  browserOpen,
  onToggleBrowser,
  onShowInfo,
  onOpenDatabaseInspector,
  onOpenXmlCollection,
  onOpenSystemLogs,
  onOpenMixLab,
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
                <span>Projekt öffnen...</span>
                <span className="text-neutral-500 hover:text-neutral-200">Ctrl+Shift+O</span>
              </button>
              <button
                onClick={() => { onSaveProject(); setActiveMenu(null); }}
                className="w-full text-left px-3 py-1.5 hover:bg-[#0088ff] hover:text-white flex justify-between"
              >
                <span>Projekt speichern...</span>
                <span className="text-neutral-500 hover:text-neutral-200">Ctrl+S</span>
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
              <button
                onClick={() => { onSetWaveformMode('BLUE'); setActiveMenu(null); }}
                className={`w-full text-left px-3 py-1.5 hover:bg-[#0088ff] hover:text-white flex items-center justify-between ${
                  waveformMode === 'BLUE' ? 'text-[#00a2ff] font-medium' : ''
                }`}
              >
                <span>BLUE (Monochrom)</span>
                {waveformMode === 'BLUE' && <span>✓</span>}
              </button>
              <button
                onClick={() => { onSetWaveformMode('RGB'); setActiveMenu(null); }}
                className={`w-full text-left px-3 py-1.5 hover:bg-[#0088ff] hover:text-white flex items-center justify-between ${
                  waveformMode === 'RGB' ? 'text-[#00a2ff] font-medium' : ''
                }`}
              >
                <span>RGB (Frequenzfarben)</span>
                {waveformMode === 'RGB' && <span>✓</span>}
              </button>
              <button
                onClick={() => { onSetWaveformMode('3BAND'); setActiveMenu(null); }}
                className={`w-full text-left px-3 py-1.5 hover:bg-[#0088ff] hover:text-white flex items-center justify-between ${
                  waveformMode === '3BAND' ? 'text-[#00a2ff] font-medium' : ''
                }`}
              >
                <span>3BAND (Low / Mid / High)</span>
                {waveformMode === '3BAND' && <span>✓</span>}
              </button>
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
              {onOpenMixLab && (
                <>
                  <div className="h-px bg-[#262830] my-1" />
                  <button
                    onClick={() => { onOpenMixLab(); setActiveMenu(null); }}
                    className="w-full text-left px-3 py-1.5 hover:bg-[#0088ff] hover:text-white text-[#00e5ff] font-medium"
                    title="Mix-Vorschau: zwei Slots, Drop-Ziel, Beat-Sync, Crossfade — ohne Projektänderung"
                  >
                    Mix Lab (Vorschau)…
                  </button>
                </>
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
                Über airdox_SMART_Editor
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
        {onOpenMixLab && (
          <button
            onClick={onOpenMixLab}
            className="flex items-center space-x-1 px-2 py-0.5 rounded bg-[#10b981]/10 hover:bg-[#10b981]/30 text-[#34d399] hover:text-white border border-[#10b981]/30 text-[10px] transition-colors"
            title="Mix Lab öffnen — Mix-Vorschau (zwei Slots, Drop-Ziel, Beat-Sync, Crossfade) ohne Projektänderung"
          >
            <Disc2 size={11} className="text-[#00e5ff]" />
            <span className="font-semibold tracking-wide">Mix Lab</span>
          </button>
        )}
      </div>
    </div>
  );
};
