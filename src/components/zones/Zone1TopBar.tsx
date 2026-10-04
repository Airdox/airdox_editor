/**
 * @license
 * airdox_SMART_Editor – ZONE 1: Globale System-, Transport- & Fokus-Leiste.
 *
 * Die permanente Top-Bar der Drei-Zonen-Architektur (UI v2.0). Sie ist immer
 * sichtbar und enthält ausschließlich Werkzeuge:
 *
 *   Links    – native App-Steuerung (Fensterknöpfe), Menüleiste
 *              (Datei / Bearbeiten / Betrachten / Hilfe), kompakter
 *              Transport-Player und der aktive Track („Artist – Titel").
 *   Rechts   – globale Werkzeuge (KI-Copilot, DB-Extraktor, Recorder,
 *              Einstellungen), die Systemzeit und der permanente Umschalter
 *              „Max. Platz / Alles einklappen".
 *
 * AUSSCHLUSSKRITERIUM (harte Regel, docs/UI_V2_DREI_ZONEN.md):
 *   In Zone 1 gibt es NIE temporäre Prozessstatus, Fortschrittsbalken oder
 *   redundante Import-Schaltflächen. Das ist hier nicht bloß Konvention,
 *   sondern in der Signatur verankert: dieser Bauteil nimmt keine
 *   Fortschritts-/Lade-Props entgegen. Wer einen Status anzeigen will, muss
 *   ihn außerhalb von Zone 1 rendern (TransientStatusToast) oder in die Zeile
 *   des Stem-Centers in Zone 2 integrieren.
 */

import React from 'react';
import { Minus, Square, X, Sparkles, Database, CircleStop, Settings, ChevronsRightLeft, Music2 } from 'lucide-react';
import type { TrackModel } from '../../types/rekordbox';
import { MenuBar } from '../MenuBar';
import type { MenuBarProps } from '../MenuBar';
import { Zone1Transport, useSystemClock } from './Zone1Transport';
import { UI_ACTION, UI_TEXT, ZONE_SHELL } from '../../ui/theme';

export interface Zone1TopBarProps {
  /** Aktives Projekt (dauerhafte Anzeige, kein Prozessstatus). */
  projectName: string;
  /** Aktiver Track für die persistente Anzeige in der Mitte. */
  activeTrack: TrackModel | null;
  /** Transport-Player. */
  isPlaying: boolean;
  onTogglePlay: () => void;
  onStop: () => void;
  onReturnToStart: () => void;
  loopActive: boolean;
  onToggleLoop: () => void;
  quantizeActive: boolean;
  onToggleQuantize: () => void;
  masterVolume: number;
  onMasterVolumeChange: (volume: number) => void;
  /** Menüleiste (Inhalt unverändert; sie ist Teil von Zone 1, keine eigene Zeile). */
  menuProps: MenuBarProps;
  /** Fokus-Modus: „Max. Platz / Alles einklappen". */
  focusMode: boolean;
  onToggleFocusMode: () => void;
  /** Globale Werkzeuge. */
  chatbotOpen: boolean;
  onToggleChatbot: () => void;
  onOpenDatabaseInspector: () => void;
  onOpenRecorder: () => void;
  recorderActive: boolean;
  onOpenSettings: () => void;
  onShowInfo: () => void;
}

export const Zone1TopBar: React.FC<Zone1TopBarProps> = ({
  projectName,
  activeTrack,
  isPlaying,
  onTogglePlay,
  onStop,
  onReturnToStart,
  loopActive,
  onToggleLoop,
  quantizeActive,
  onToggleQuantize,
  masterVolume,
  onMasterVolumeChange,
  menuProps,
  focusMode,
  onToggleFocusMode,
  chatbotOpen,
  onToggleChatbot,
  onOpenDatabaseInspector,
  onOpenRecorder,
  recorderActive,
  onOpenSettings,
  onShowInfo,
}) => {
  const clock = useSystemClock();
  const trackLabel = activeTrack ? `${formatArtist(activeTrack.artist)} – ${activeTrack.title}` : 'Kein Track geladen';

  return (
    <header
      className={`h-11 flex items-stretch gap-2 px-2 select-none z-40 flex-shrink-0 overflow-hidden ${ZONE_SHELL.zone1}`}
      data-zone="1"
      data-zone1="true"
      aria-label="Globale Systemleiste"
    >
      {/* ── Linke Sektion: App-Steuerung, Menüs, Transport, aktiver Track ──── */}
      <div className="flex items-center gap-2 min-w-0 flex-1">
        {/* Native App-Steuerung + Fensterknöpfe */}
        <div className="flex items-center gap-2 pr-2 border-r border-[#1c1e26] flex-shrink-0" data-zone1-cluster="app">
          <div className="flex items-center gap-1.5" title="airdox_SMART_Editor">
            <div className="w-3.5 h-3.5 rounded-full border border-neutral-300 flex items-center justify-center p-[2px]">
              <div className="w-1.5 h-1.5 rounded-full bg-white" />
            </div>
            <span className="hidden md:inline font-semibold text-neutral-300 tracking-tight text-[11px]">airdox</span>
          </div>
          <div className="flex items-center" data-window-controls="decorative">
            <WindowButton label="Minimieren">
              <Minus size={11} strokeWidth={2} />
            </WindowButton>
            <WindowButton label="Maximieren">
              <Square size={9} strokeWidth={2} />
            </WindowButton>
            <WindowButton label="Schließen" danger>
              <X size={11} strokeWidth={2} />
            </WindowButton>
          </div>
        </div>

        {/* Menüleiste (Datei, Bearbeiten, Betrachten, Hilfe) – Inhalt in MenuBar */}
        <MenuBar {...menuProps} />

        <span className="w-px h-6 bg-[#1c1e26] flex-shrink-0" aria-hidden="true" />

        {/* Kompakter Transport-Player (immer sichtbar; in sehr schmalen
            Fenstern entfallen nur Pegelanzeige und Zusatzbeschriftungen) */}
        <div className="flex-shrink-0">
          <Zone1Transport
            isPlaying={isPlaying}
            onTogglePlay={onTogglePlay}
            onStop={onStop}
            onReturnToStart={onReturnToStart}
            loopActive={loopActive}
            onToggleLoop={onToggleLoop}
            quantizeActive={quantizeActive}
            onToggleQuantize={onToggleQuantize}
            masterVolume={masterVolume}
            onMasterVolumeChange={onMasterVolumeChange}
          />
        </div>

        {/* Persistente Anzeige des aktiven Tracks */}
        <div
          className="flex items-center gap-2 min-w-0 flex-1 px-2.5 py-1 rounded border bg-[#12141c] border-[#1f2230]"
          data-zone1-cluster="active-track"
          title={activeTrack ? `Aktiv: ${trackLabel}` : 'Noch kein Track geladen'}
        >
          <Music2 size={12} className="text-[#00a2ff] flex-shrink-0" />
          <span className={`truncate text-[11.5px] ${activeTrack ? 'text-neutral-100 font-medium' : 'text-neutral-500 italic'}`}>
            {trackLabel}
          </span>
          {activeTrack && (
            <>
              <span className="text-[10px] font-mono text-neutral-500 flex-shrink-0">
                {activeTrack.bpm.toFixed(2)} BPM
              </span>
              <span className="text-[10px] font-mono text-neutral-500 flex-shrink-0">{activeTrack.key}</span>
            </>
          )}
          <span
            className="ml-auto hidden 2xl:inline text-[9.5px] font-mono text-neutral-600 flex-shrink-0 truncate max-w-[140px]"
            title={`Projekt: ${projectName}`}
          >
            {projectName}
          </span>
        </div>
      </div>

      {/* ── Rechte Sektion: Werkzeuge, Systemzeit, Fokus-Umschalter ────────── */}
      <div className="flex items-center gap-1.5 flex-shrink-0" data-zone1-cluster="tools">
        <button
          type="button"
          onClick={onToggleChatbot}
          data-zone1-tool="ai-copilot"
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-[10.5px] font-mono font-bold transition-all border ${
            chatbotOpen
              ? 'bg-gradient-to-r from-[#0088ff] to-[#7c3aed] text-white border-blue-400/50'
              : 'bg-[#161922] border-[#232738] text-neutral-300 hover:border-[#0088ff]/60 hover:text-white'
          }`}
          title="KI-Copilot-Palette öffnen/schließen (Mix-Analysen, Cue- und Schnittvorschläge)"
          aria-pressed={chatbotOpen}
        >
          <Sparkles size={11} className="text-[#00a2ff]" />
          <span className="hidden xl:inline tracking-wider">AI COPILOT</span>
        </button>

        <button
          type="button"
          onClick={onOpenDatabaseInspector}
          data-zone1-tool="db-extractor"
          className="flex items-center gap-1.5 px-2.5 py-1 rounded text-[10.5px] font-semibold transition-colors border bg-[#0088ff]/12 border-[#0088ff]/30 text-[#00a2ff] hover:bg-[#0088ff] hover:text-white"
          title="Rekordbox-Datenbank & ANLZ-Wellenform-Extraktor öffnen (read-only)"
        >
          <Database size={11} />
          <span className="hidden xl:inline tracking-wide">DB-Extraktor</span>
        </button>

        {onOpenRecorder && (
          <button
            type="button"
            onClick={onOpenRecorder}
            data-zone1-tool="recorder"
            className={`flex items-center gap-1.5 px-2 py-1 rounded text-[10.5px] font-bold tracking-wide border transition-colors ${
              recorderActive
                ? 'border-[#ff3b30] bg-[#3a1517] text-[#ff625b] animate-pulse'
                : 'border-[#3b2830] bg-[#21151a] text-[#ff5147] hover:bg-[#3a1517] hover:text-white'
            }`}
            title="Pro-Recorder für DJ-Set- und Mikrofonaufnahmen öffnen (Taste: F9)"
          >
            <CircleStop size={11} /> REC
          </button>
        )}

        <button
          type="button"
          onClick={onOpenSettings}
          data-zone1-tool="settings"
          className="w-7 h-7 flex items-center justify-center rounded text-neutral-400 hover:text-white hover:bg-[#1b1d26] transition-colors"
          title="Workspace-Einstellungen (Modelle, Pfade, Verhalten) öffnen"
          aria-label="Einstellungen"
        >
          <Settings size={14} />
        </button>

        <button
          type="button"
          onClick={onShowInfo}
          className="hidden xl:inline px-2 py-1 rounded text-[10.5px] text-neutral-400 hover:text-white hover:bg-[#1b1d26] transition-colors"
          title="Rekordbox-Datenquellen und Non-Destructive-Originalschutz erklären"
        >
          Hilfe
        </button>

        <span className="w-px h-6 bg-[#1c1e26]" aria-hidden="true" />

        {/* Systemzeit */}
        <span className="font-mono text-[11.5px] font-semibold px-1" style={{ color: UI_TEXT.secondary }} title="Systemzeit">
          {clock}
        </span>

        <span className="w-px h-6 bg-[#1c1e26]" aria-hidden="true" />

        {/*
          Der Workspace-Anker: permanent sichtbar, optisch hervorgehoben,
          zwei aufeinander zubewegende Pfeile. Ein Klick schließt ALLE Panels in
          Zone 2 und Zone 3 und gibt der Wellenform die volle Höhe.
        */}
        <button
          type="button"
          onClick={onToggleFocusMode}
          data-zone1-focus-toggle="true"
          aria-pressed={focusMode}
          className={`flex items-center gap-2 px-3 py-1.5 rounded text-[10.5px] font-bold tracking-wide border-2 transition-all ${
            focusMode
              ? `${UI_ACTION.toggleOn} shadow-[0_0_14px_rgba(0,162,255,0.35)]`
              : 'bg-[#161922] border-[#2d3144] text-neutral-200 hover:border-[#00a2ff] hover:text-white'
          }`}
          title={
            focusMode
              ? 'Fokus-Modus ist AKTIV: alle Panels sind eingeklappt, die Wellenform füllt die volle Höhe. Klick stellt das Standard-Layout wieder her.'
              : 'Max. Platz: schließt alle Panel in Zone 2 und Zone 3 synchron und skaliert die Wellenform auf die maximale vertikale Höhe (Taste: M)'
          }
        >
          <ChevronsRightLeft size={15} className={focusMode ? 'text-[#00e5ff]' : 'text-[#00a2ff]'} />
          {/*
            Die Beschriftung ist Teil der Spezifikation und wird ab 1280 px
            Fensterbreite immer gezeigt. In sehr schmalen Fenstern (z. B. der
            eingebetteten Vorschau) bleibt die Schaltfläche mit Icon und
            vollständigem Tooltip sichtbar, damit die Leiste nicht überläuft.
          */}
          <span className="hidden xl:inline whitespace-nowrap">Max. Platz / Alles einklappen</span>
        </button>
      </div>
    </header>
  );
};

const WindowButton: React.FC<{ label: string; danger?: boolean; children: React.ReactNode }> = ({
  label,
  danger = false,
  children,
}) => (
  <button
    type="button"
    tabIndex={-1}
    aria-label={label}
    title={label}
    className={`w-6 h-6 flex items-center justify-center rounded text-neutral-500 transition-colors ${
      danger ? 'hover:bg-[#e81123] hover:text-white' : 'hover:bg-[#202228] hover:text-white'
    }`}
  >
    {children}
  </button>
);

/** Interpret-Anzeige: „La Roux" statt „La Roux " oder leerem Feld. */
function formatArtist(artist: string | null | undefined): string {
  const value = (artist ?? '').trim();
  return value.length > 0 ? value : 'Unbekannter Interpret';
}
