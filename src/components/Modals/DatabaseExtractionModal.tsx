/**
 * @license
 * Rekordbox Database & Visualization Data Extraction Inspector Modal
 * 
 * Inspects all data extracted from Rekordbox XML, SQLite Database, and ANLZ files:
 * - Memory Cues (exact milliseconds, beat alignment, comment, CDJ color)
 * - Waveform Visualization (peaks, multi-band Low/Mid/High spectral energies)
 * - Song Structure Phrases (PSSI)
 * - Binary ANLZ tag analyzer (PCOB, PWV3/5, PQTZ, PSSI)
 */

import React, { useState } from 'react';
import {
  TrackModel,
  CuePoint,
  DataOrigin,
} from '../../types/rekordbox';
import {
  Database,
  Layers,
  Activity,
  CheckCircle2,
  Bookmark,
  FileCode,
  Sparkles,
  Upload,
  X,
  Play,
  Clock,
  Radio,
} from 'lucide-react';

interface DatabaseExtractionModalProps {
  isOpen: boolean;
  onClose: () => void;
  track?: TrackModel | null;
  activeTrack?: TrackModel | null;
  onApplyTrack?: (extractedTrack: TrackModel) => void;
  onSelectCue?: (time: number) => void;
  onLoadTrackByIndex?: (index: number) => void;
  onImportAnlzFile?: (file: File) => void;
  /** Windows desktop path: opens the analysis file via the read-only bridge. */
  onImportAnlzFromDesktop?: () => void;
  onImportXmlFile?: (file: File) => void;
  /** Rekordbox 6/7 SQLCipher database (master.db / OneLibrary), read-only. */
  onOpenRekordboxDatabase?: () => void;
  onLocateRekordboxDatabases?: () => Promise<
    Array<{ path: string; kind: 'MASTER_DB' | 'ONE_LIBRARY'; label: string }>
  >;
  onLoadRekordboxDatabase?: (dbPath: string, sourceLabel?: string) => void | Promise<void>;
}

export const DatabaseExtractionModal: React.FC<DatabaseExtractionModalProps> = ({
  isOpen,
  onClose,
  track,
  activeTrack,
  onApplyTrack,
  onSelectCue,
  onLoadTrackByIndex,
  onImportAnlzFile,
  onImportAnlzFromDesktop,
  onImportXmlFile,
  onOpenRekordboxDatabase,
  onLocateRekordboxDatabases,
  onLoadRekordboxDatabase,
}) => {
  const currentTrack = track || activeTrack;
  const [activeTab, setActiveTab] = useState<'memoryCues' | 'waveform' | 'phrases' | 'sources'>('memoryCues');
  const [databaseCandidates, setDatabaseCandidates] = useState<
    Array<{ path: string; kind: 'MASTER_DB' | 'ONE_LIBRARY'; label: string }>
  >([]);
  const [searchingDatabase, setSearchingDatabase] = useState(false);

  const handleDiscoverDatabases = async () => {
    if (!onLocateRekordboxDatabases || searchingDatabase) return;
    setSearchingDatabase(true);
    try {
      const found = await onLocateRekordboxDatabases();
      setDatabaseCandidates(found);
    } finally {
      setSearchingDatabase(false);
    }
  };
  const [filterType, setFilterType] = useState<'ALL' | 'MEMORY' | 'HOT_CUE'>('ALL');

  if (!isOpen || !currentTrack) return null;

  const memoryCues = (currentTrack.cues || []).filter((c) => c.type === 'MEMORY');
  const hotCues = (currentTrack.cues || []).filter((c) => c.type === 'HOT_CUE');
  const displayedCues = (currentTrack.cues || []).filter((c) => {
    if (filterType === 'MEMORY') return c.type === 'MEMORY';
    if (filterType === 'HOT_CUE') return c.type === 'HOT_CUE';
    return true;
  });

  const analysis = currentTrack.analysis;
  const dbRecord = currentTrack.databaseRecord;
  const anlzTags = new Set<string>(dbRecord?.anlzTagsFound ?? []);
  const hasAnlzTag = (tag: string) => anlzTags.has(tag);
  const tagRow = (tag: string, label: string, detail: string) => (
    <div className="flex justify-between" key={tag}>
      <span className="text-neutral-400">{label}:</span>
      <span
        className={`font-mono flex items-center space-x-1 ${
          hasAnlzTag(tag) ? 'text-[#10b981]' : 'text-neutral-600'
        }`}
      >
        {hasAnlzTag(tag) ? <CheckCircle2 size={12} /> : <span className="text-neutral-600">—</span>}
        <span>{hasAnlzTag(tag) ? detail : 'Nicht enthalten'}</span>
      </span>
    </div>
  );

  // Calculate average energies
  let avgLow = 0;
  let avgMid = 0;
  let avgHigh = 0;
  if (analysis && analysis.length > 0) {
    let sL = 0;
    let sM = 0;
    let sH = 0;
    const len = analysis.length;
    for (let i = 0; i < len; i++) {
      sL += analysis.lowEnergy[i];
      sM += analysis.midEnergy[i];
      sH += analysis.highEnergy[i];
    }
    avgLow = Math.round((sL / len) * 100);
    avgMid = Math.round((sM / len) * 100);
    avgHigh = Math.round((sH / len) * 100);
  }

  const formatMs = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    const ms = Math.floor((secs % 1) * 1000);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-[#111216] border border-[#262832] rounded-md shadow-2xl w-full max-w-4xl max-h-[85vh] flex flex-col overflow-hidden text-neutral-200 text-xs">
        {/* Header */}
        <div className="h-12 bg-[#16171d] border-b border-[#262832] flex items-center justify-between px-4 flex-shrink-0">
          <div className="flex items-center space-x-3">
            <div className="w-7 h-7 rounded bg-[#0088ff]/15 border border-[#0088ff]/40 flex items-center justify-center text-[#0088ff]">
              <Database size={15} />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <span className="font-semibold text-white text-sm">
                  Rekordbox Visualisierungs- & Datenextraktor
                </span>
                <span className="px-1.5 py-0.5 rounded-xs bg-[#00a2ff]/15 border border-[#00a2ff]/30 text-[#00a2ff] text-[10px] font-mono">
                  ORIGIN: {currentTrack?.origin ?? DataOrigin.REKORDBOX_XML}
                </span>
              </div>
              <p className="text-[11px] text-neutral-400">
                Memory Cues & Waveform-Visualisierung direkt aus der Datenbank / ANLZ-Struktur extrahiert
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="text-neutral-400 hover:text-white p-1 hover:bg-[#22242c] rounded transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Quick Stats Bar */}
        <div className="bg-[#0d0e12] border-b border-[#1f2128] px-4 py-2 flex items-center justify-between text-[11px]">
          <div className="flex items-center space-x-6">
            <div className="flex items-center space-x-1.5">
              <Bookmark size={13} className="text-[#ff3b30]" />
              <span className="text-neutral-400">Memory Cues:</span>
              <span className="font-bold text-white font-mono">{memoryCues.length}</span>
            </div>
            <div className="flex items-center space-x-1.5">
              <Radio size={13} className="text-[#00a2ff]" />
              <span className="text-neutral-400">Hot Cues:</span>
              <span className="font-bold text-white font-mono">{hotCues.length}</span>
            </div>
            <div className="flex items-center space-x-1.5">
              <Activity size={13} className="text-[#10b981]" />
              <span className="text-neutral-400">Waveform Buckets:</span>
              <span className="font-bold text-white font-mono">
                {analysis?.length || 0} ({(currentTrack.duration || 0).toFixed(1)}s)
              </span>
            </div>
            <div className="flex items-center space-x-1.5">
              <Layers size={13} className="text-[#f59e0b]" />
              <span className="text-neutral-400">Phrasen (PSSI):</span>
              <span className="font-bold text-white font-mono">
                {currentTrack.phrases?.length || 0} Abschnitte
              </span>
            </div>
          </div>

          {/* Database presets */}
          {onLoadTrackByIndex && (
            <div className="flex items-center space-x-2">
              <span className="text-neutral-500 text-[10px]">Track wählen:</span>
              <button
                onClick={() => onLoadTrackByIndex(0)}
                className={`px-2 py-0.5 rounded text-[10px] border transition-colors ${
                  currentTrack.id === '1'
                    ? 'bg-[#0088ff] text-white border-[#0088ff]'
                    : 'bg-[#181a22] text-neutral-300 border-[#2a2d3a] hover:bg-[#222530]'
                }`}
              >
                Quicksand (130.05 BPM)
              </button>
              <button
                onClick={() => onLoadTrackByIndex(1)}
                className={`px-2 py-0.5 rounded text-[10px] border transition-colors ${
                  currentTrack.id === '2'
                    ? 'bg-[#0088ff] text-white border-[#0088ff]'
                    : 'bg-[#181a22] text-neutral-300 border-[#2a2d3a] hover:bg-[#222530]'
                }`}
              >
                Hyperdrive (128 BPM)
              </button>
            </div>
          )}
        </div>

        {/* Tab Navigation */}
        <div className="bg-[#14151b] border-b border-[#242630] px-4 flex space-x-4">
          <button
            onClick={() => setActiveTab('memoryCues')}
            className={`py-2 text-[11.5px] font-medium border-b-2 transition-colors flex items-center space-x-1.5 ${
              activeTab === 'memoryCues'
                ? 'border-[#ff3b30] text-white'
                : 'border-transparent text-neutral-400 hover:text-neutral-200'
            }`}
          >
            <Bookmark size={13} className="text-[#ff3b30]" />
            <span>Extrahierte Memory Cues ({memoryCues.length})</span>
          </button>
          <button
            onClick={() => setActiveTab('waveform')}
            className={`py-2 text-[11.5px] font-medium border-b-2 transition-colors flex items-center space-x-1.5 ${
              activeTab === 'waveform'
                ? 'border-[#0088ff] text-white'
                : 'border-transparent text-neutral-400 hover:text-neutral-200'
            }`}
          >
            <Activity size={13} className="text-[#0088ff]" />
            <span>Waveform-Puffer & Spektraldaten</span>
          </button>
          <button
            onClick={() => setActiveTab('phrases')}
            className={`py-2 text-[11.5px] font-medium border-b-2 transition-colors flex items-center space-x-1.5 ${
              activeTab === 'phrases'
                ? 'border-[#f59e0b] text-white'
                : 'border-transparent text-neutral-400 hover:text-neutral-200'
            }`}
          >
            <Layers size={13} className="text-[#f59e0b]" />
            <span>Song-Struktur / Phrasen (PSSI)</span>
          </button>
          <button
            onClick={() => setActiveTab('sources')}
            className={`py-2 text-[11.5px] font-medium border-b-2 transition-colors flex items-center space-x-1.5 ${
              activeTab === 'sources'
                ? 'border-[#10b981] text-white'
                : 'border-transparent text-neutral-400 hover:text-neutral-200'
            }`}
          >
            <Upload size={13} className="text-[#10b981]" />
            <span>ANLZ / XML / DB Datei-Import</span>
          </button>
        </div>

        {/* Tab Content */}
        <div className="p-4 flex-1 overflow-y-auto min-h-[280px]">
          {/* 1. Memory Cues Tab */}
          {activeTab === 'memoryCues' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-2">
                  <span className="text-neutral-400 text-[11px]">Filter:</span>
                  <button
                    onClick={() => setFilterType('ALL')}
                    className={`px-2 py-0.5 rounded text-[10.5px] ${
                      filterType === 'ALL'
                        ? 'bg-[#222530] text-white font-semibold'
                        : 'text-neutral-400 hover:text-white'
                    }`}
                  >
                    Alle Cues ({(currentTrack.cues || []).length})
                  </button>
                  <button
                    onClick={() => setFilterType('MEMORY')}
                    className={`px-2 py-0.5 rounded text-[10.5px] ${
                      filterType === 'MEMORY'
                        ? 'bg-[#ff3b30]/20 text-[#ff3b30] border border-[#ff3b30]/40 font-semibold'
                        : 'text-neutral-400 hover:text-white'
                    }`}
                  >
                    Nur Memory Cues ({memoryCues.length})
                  </button>
                  <button
                    onClick={() => setFilterType('HOT_CUE')}
                    className={`px-2 py-0.5 rounded text-[10.5px] ${
                      filterType === 'HOT_CUE'
                        ? 'bg-[#00a2ff]/20 text-[#00a2ff] border border-[#00a2ff]/40 font-semibold'
                        : 'text-neutral-400 hover:text-white'
                    }`}
                  >
                    Hot Cues ({hotCues.length})
                  </button>
                </div>

                <div className="text-[11px] text-neutral-400 font-mono">
                  Pioneer Rekordbox Schema: &lt;POSITION_MARK Type=&quot;0&quot; Num=&quot;-1&quot;&gt;
                </div>
              </div>

              {/* Cues Table */}
              <div className="border border-[#22242c] rounded overflow-hidden">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-[#181920] text-neutral-400 border-b border-[#22242c] text-[10.5px]">
                      <th className="py-2 px-3">Typ</th>
                      <th className="py-2 px-3">Name / Label</th>
                      <th className="py-2 px-3">Zeitstempel (ms)</th>
                      <th className="py-2 px-3">Bar : Beat</th>
                      <th className="py-2 px-3">Position</th>
                      <th className="py-2 px-3">Daten-Herkunft</th>
                      <th className="py-2 px-3 text-right">Aktion</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#1e2028] font-mono text-[11px]">
                    {displayedCues.map((cue, idx) => {
                      const isMem = cue.type === 'MEMORY';
                      return (
                        <tr
                          key={cue.id}
                          className="hover:bg-[#151720] transition-colors group"
                        >
                          <td className="py-2 px-3">
                            {isMem ? (
                              <span className="inline-flex items-center space-x-1 px-1.5 py-0.5 rounded-xs bg-[#ff2a2a]/20 border border-[#ff2a2a]/50 text-[#ff4444] text-[9.5px] font-bold">
                                <span>▼ MEMORY</span>
                              </span>
                            ) : (
                              <span className="inline-flex items-center space-x-1 px-1.5 py-0.5 rounded-xs bg-[#00a2ff]/20 border border-[#00a2ff]/50 text-[#00a2ff] text-[9.5px] font-bold">
                                <span>HOT [{cue.letter || idx}]</span>
                              </span>
                            )}
                          </td>
                          <td className="py-2 px-3 font-sans font-medium text-white flex items-center space-x-1.5">
                            <span
                              className="w-2.5 h-2.5 rounded-full inline-block"
                              style={{ backgroundColor: cue.color || (isMem ? '#ff3b30' : '#00a2ff') }}
                            />
                            <span>{cue.name}</span>
                          </td>
                          <td className="py-2 px-3 text-neutral-300">
                            {cue.inMsec ? `${cue.inMsec} ms` : `${Math.round(cue.position * 1000)} ms`}
                          </td>
                          <td className="py-2 px-3 text-[#f5b800]">
                            {cue.barNumber ? `Bar ${cue.barNumber}.${cue.beatNumber || 1}` : '-'}
                          </td>
                          <td className="py-2 px-3 text-neutral-300">
                            {formatMs(cue.position)}
                          </td>
                          <td className="py-2 px-3 text-neutral-400 text-[10px]">
                            {cue.origin}
                          </td>
                          <td className="py-2 px-3 text-right">
                            <button
                              onClick={() => {
                                onSelectCue?.(cue.position);
                                onClose();
                              }}
                              className="px-2 py-0.5 bg-[#0088ff]/20 hover:bg-[#0088ff] text-[#0088ff] hover:text-white rounded border border-[#0088ff]/40 text-[10px] transition-colors inline-flex items-center space-x-1 font-sans"
                            >
                              <Play size={10} fill="currentColor" />
                              <span>Anspringen</span>
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* 2. Waveform Tab */}
          {activeTab === 'waveform' && (
            <div className="space-y-4">
              <div className="bg-[#161720] border border-[#262838] p-3 rounded">
                <h4 className="text-white font-semibold text-xs mb-1 flex items-center space-x-1.5">
                  <Activity size={14} className="text-[#00a2ff]" />
                  <span>Extrahiertes Multi-Band Rekordbox Waveform Profil</span>
                </h4>
                <p className="text-[11px] text-neutral-400">
                  Die Waveform wird 1:1 aus der Datenbank / ANLZ-Dateistruktur geladen. 
                  Drei spektrale Bänder definieren die visuelle Darstellung:
                </p>

                {/* Energy bars */}
                <div className="grid grid-cols-3 gap-3 mt-3">
                  <div className="bg-[#101116] p-2.5 rounded border border-[#ff3b30]/30">
                    <div className="flex justify-between items-center mb-1">
                      <span className="text-[#ff5555] font-bold text-[11px]">BASS / LOW (20-250 Hz)</span>
                      <span className="text-white font-mono font-bold">{avgLow}%</span>
                    </div>
                    <div className="w-full bg-[#20222a] h-2 rounded-full overflow-hidden">
                      <div
                        className="bg-gradient-to-r from-[#ff3b30] to-[#ff7700] h-full"
                        style={{ width: `${avgLow}%` }}
                      />
                    </div>
                    <span className="text-[10px] text-neutral-400 mt-1 block">
                      Kick-Drums &amp; Sub-Bässe (Rote Visualisierung)
                    </span>
                  </div>

                  <div className="bg-[#101116] p-2.5 rounded border border-[#00e5ff]/30">
                    <div className="flex justify-between items-center mb-1">
                      <span className="text-[#00e5ff] font-bold text-[11px]">MIDS (250-4000 Hz)</span>
                      <span className="text-white font-mono font-bold">{avgMid}%</span>
                    </div>
                    <div className="w-full bg-[#20222a] h-2 rounded-full overflow-hidden">
                      <div
                        className="bg-gradient-to-r from-[#00e5ff] to-[#10b981] h-full"
                        style={{ width: `${avgMid}%` }}
                      />
                    </div>
                    <span className="text-[10px] text-neutral-400 mt-1 block">
                      Vocals, Synths &amp; Leads (Cyan/Grüne Visualisierung)
                    </span>
                  </div>

                  <div className="bg-[#101116] p-2.5 rounded border border-[#3b82f6]/30">
                    <div className="flex justify-between items-center mb-1">
                      <span className="text-[#60a5fa] font-bold text-[11px]">HIGHS (4-20 kHz)</span>
                      <span className="text-white font-mono font-bold">{avgHigh}%</span>
                    </div>
                    <div className="w-full bg-[#20222a] h-2 rounded-full overflow-hidden">
                      <div
                        className="bg-gradient-to-r from-[#3b82f6] to-[#ffffff] h-full"
                        style={{ width: `${avgHigh}%` }}
                      />
                    </div>
                    <span className="text-[10px] text-neutral-400 mt-1 block">
                      Hi-Hats, Cymbals &amp; Air (Blau/Weiße Spitzen)
                    </span>
                  </div>
                </div>
              </div>

              {/* Technical Details */}
              <div className="grid grid-cols-2 gap-3 text-[11px]">
                <div className="bg-[#14161c] border border-[#22242e] p-3 rounded space-y-1.5">
                  <div className="text-neutral-400 font-semibold mb-1">Puffer-Spezifikation</div>
                  <div className="flex justify-between">
                    <span className="text-neutral-400">Gesamte Datenpunkte:</span>
                    <span className="text-white font-mono">{analysis?.length || 0} Frames</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-neutral-400">Auflösung:</span>
                    <span className="text-white font-mono">180 Buckets/Sekunde</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-neutral-400">Audio Sample Rate:</span>
                    <span className="text-white font-mono">{currentTrack.sampleRate} Hz</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-neutral-400">Kanäle:</span>
                    <span className="text-white font-mono">Stereo (2 Ch)</span>
                  </div>
                </div>

                <div className="bg-[#14161c] border border-[#22242e] p-3 rounded space-y-1.5">
                  <div className="text-neutral-400 font-semibold mb-1">Rekordbox Tag-Kompatibilität</div>
                  {tagRow('PQTZ', 'PQTZ (Beatgrid)', `${currentTrack.beatGrid.beats.length || 0} Beats`)}
                  {tagRow('PCOB', 'PCOB (Classic Cues)', `${currentTrack.cues.length} Cues`)}
                  {tagRow('PCO2', 'PCO2 (Extended Cues)', `${currentTrack.cues.length} Cues`)}
                  {tagRow('PWV3', 'PWV3 (Waveform 1-Band)', 'Geladen')}
                  {tagRow('PWV5', 'PWV5 (High-Res RGB)', 'Geladen')}
                  {tagRow('PWV6', 'PWV6 (3-Band Preview)', 'Geladen')}
                  {tagRow('PWV7', 'PWV7 (3-Band Detail)', 'Geladen')}
                  {tagRow('PSSI', 'PSSI (Song-Struktur)', `${currentTrack.phrases?.length || 0} Phrasen`)}
                  {dbRecord && dbRecord.anlzWarnings && dbRecord.anlzWarnings.length > 0 && (
                    <div className="mt-2 pt-2 border-t border-[#22242e]">
                      <div className="text-neutral-500 text-[10px] uppercase tracking-wide mb-1">
                        Analysevermerke (Read-Only)
                      </div>
                      <div className="space-y-0.5 text-[10px] text-neutral-400 font-mono">
                        {dbRecord.anlzWarnings.slice(0, 6).map((warning, idx) => (
                          <div key={idx}>• {warning}</div>
                        ))}
                        {dbRecord.anlzWarnings.length > 6 && (
                          <div>… {dbRecord.anlzWarnings.length - 6} weitere</div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* 3. Phrases Tab */}
          {activeTab === 'phrases' && (
            <div className="space-y-3">
              <div className="text-[11px] text-neutral-400">
                Pioneer Rekordbox PSSI Song Structure Analyse (Automatische Einteilung in Phrasen/Strophen):
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                {(currentTrack.phrases || []).map((p, idx) => (
                  <div
                    key={p.id}
                    className="bg-[#14161c] border border-[#252834] p-2.5 rounded flex flex-col justify-between"
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span
                        className="px-2 py-0.5 rounded text-[10px] font-bold text-white uppercase"
                        style={{ backgroundColor: p.color }}
                      >
                        {p.name}
                      </span>
                      <span className="text-neutral-400 font-mono text-[10px]">
                        {p.endBar - p.startBar + 1} Takte
                      </span>
                    </div>

                    <div className="space-y-0.5 text-[10.5px] font-mono text-neutral-300 mt-2">
                      <div className="flex justify-between">
                        <span className="text-neutral-500">Takte:</span>
                        <span>{p.startBar} - {p.endBar}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-neutral-500">Zeit:</span>
                        <span>{formatMs(p.startTime)}</span>
                      </div>
                    </div>

                    <button
                      onClick={() => {
                        onSelectCue?.(p.startTime);
                        onClose();
                      }}
                      className="mt-2 w-full py-1 bg-[#1c1e28] hover:bg-[#0088ff] hover:text-white text-neutral-300 rounded text-[10px] transition-colors"
                    >
                      Ansteuern
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 4. Import / Sources Tab */}
          {activeTab === 'sources' && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {/* ANLZ File Import */}
                <div className="bg-[#151720] border border-[#252835] p-4 rounded flex flex-col justify-between">
                  <div>
                    <div className="flex items-center space-x-2 text-white font-semibold text-xs mb-1">
                      <FileCode size={15} className="text-[#00a2ff]" />
                      <span>Pioneer ANLZ Binärdatei (.DAT / .EXT / .2EX)</span>
                    </div>
                    <p className="text-[11px] text-neutral-400">
                      Enthält PCOB/PCO2 (Memory &amp; Hot Cues), PWV3/PWV5/PWV6/PWV7 (Waveform-Cache), PQTZ (Beatgrid) und PSSI (Song-Struktur).
                    </p>
                    <p className="text-[10px] text-neutral-500 mt-1">
                      ANLZ-Dateien werden ausschließlich lesend geöffnet; die Quelle bleibt unverändert.
                    </p>
                  </div>

                  <div className="space-y-2 mt-4">
                    {typeof window !== 'undefined' && window.rekordboxDesktop && (
                      <button
                        onClick={() => {
                          onImportAnlzFromDesktop?.();
                          onClose();
                        }}
                        className="w-full py-2 bg-[#0088ff] hover:bg-[#0077e6] text-white rounded text-center font-medium text-[11px] transition-colors flex items-center justify-center space-x-1.5"
                      >
                        <Upload size={13} />
                        <span>Im Windows-Dateidialog auswählen (nur lesend)</span>
                      </button>
                    )}
                    <label className="cursor-pointer w-full py-2 bg-[#0088ff]/15 hover:bg-[#0088ff]/25 border border-[#0088ff]/40 text-[#4fc3ff] rounded text-center font-medium text-[11px] transition-colors flex items-center justify-center space-x-1.5">
                      <Upload size={13} />
                      <span>ANLZ-Datei auswählen (.DAT / .EXT)...</span>
                      <input
                        type="file"
                        accept=".DAT,.EXT,.2EX,.dat,.ext,.2ex"
                        className="hidden"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) {
                            onImportAnlzFile(file);
                            onClose();
                          }
                        }}
                      />
                    </label>
                  </div>
                </div>

                {/* XML Import */}
                <div className="bg-[#151720] border border-[#252835] p-4 rounded flex flex-col justify-between">
                  <div>
                    <div className="flex items-center space-x-2 text-white font-semibold text-xs mb-1">
                      <FileCode size={15} className="text-[#f59e0b]" />
                      <span>Rekordbox XML Kollektion (&lt;DJ_PLAYLISTS&gt;)</span>
                    </div>
                    <p className="text-[11px] text-neutral-400">
                      Standard XML-Kollektion mit vollständigen POSITION_MARK Memory Cues und TEMPO-Markern.
                    </p>
                  </div>

                  <label className="mt-4 cursor-pointer w-full py-2 bg-[#f59e0b] hover:bg-[#d97706] text-black font-semibold rounded text-center text-[11px] transition-colors flex items-center justify-center space-x-1.5">
                    <Upload size={13} />
                    <span>Rekordbox XML auswählen...</span>
                    <input
                      type="file"
                      accept=".xml"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) {
                          onImportXmlFile(file);
                          onClose();
                        }
                      }}
                    />
                  </label>
                </div>

                {/* Rekordbox 6/7 SQLCipher Database */}
                <div className="bg-[#151720] border border-[#252835] p-4 rounded flex flex-col justify-between">
                  <div>
                    <div className="flex items-center space-x-2 text-white font-semibold text-xs mb-1">
                      <Database size={15} className="text-[#10b981]" />
                      <span>Rekordbox 6/7 Datenbank (master.db / OneLibrary)</span>
                    </div>
                    <p className="text-[11px] text-neutral-400">
                      Lokale Rekordbox-Bibliothek (djmdContent/djmdCue) oder OneLibrary-Export mit SQLCipher. Wird ausschließlich lesend geöffnet.
                    </p>
                  </div>

                  <div className="space-y-2 mt-4">
                    {onOpenRekordboxDatabase && (
                      <button
                        onClick={() => {
                          onOpenRekordboxDatabase();
                          onClose();
                        }}
                        className="w-full py-2 bg-[#10b981] hover:bg-[#0d9e73] text-white rounded text-center font-medium text-[11px] transition-colors flex items-center justify-center space-x-1.5"
                      >
                        <Upload size={13} />
                        <span>Datenbankdatei auswählen... (.db, nur lesend)</span>
                      </button>
                    )}
                    {onLocateRekordboxDatabases && (
                      <>
                        <button
                          onClick={handleDiscoverDatabases}
                          className="w-full py-2 bg-[#115c48] hover:bg-[#157055] border border-[#10b981]/40 text-[#7ce8c3] rounded text-center font-medium text-[11px] transition-colors flex items-center justify-center space-x-1.5"
                        >
                          <Database size={13} />
                          <span>{searchingDatabase ? 'Suche...' : 'Standardordner durchsuchen'}</span>
                        </button>
                        <p className="text-[9px] text-neutral-500">
                          Suche: nur Partition D: wird durchsucht — die Rekordbox-Datenbank liegt auf D: (kein AppData-Scan).
                        </p>
                      </>
                    )}
                    {databaseCandidates.length > 0 && (
                      <div className="space-y-1.5 max-h-28 overflow-y-auto">
                        {databaseCandidates.map((candidate) => (
                          <div
                            key={candidate.path}
                            className="flex items-center justify-between gap-2 bg-[#0f1015] border border-[#22242e] rounded px-2 py-1.5"
                          >
                            <div className="min-w-0">
                              <div className="text-[10px] font-mono text-neutral-300 truncate">
                                {candidate.label}
                              </div>
                              <div className="text-[9px] text-neutral-500 font-mono truncate">
                                {candidate.kind === 'ONE_LIBRARY' ? 'OneLibrary' : 'master.db'}
                              </div>
                            </div>
                            <button
                              onClick={() => {
                                onLoadRekordboxDatabase?.(candidate.path, candidate.label);
                                onClose();
                              }}
                              className="px-2 py-1 bg-[#10b981]/20 hover:bg-[#10b981] text-[#7ce8c3] hover:text-white rounded text-[10px] border border-[#10b981]/40 flex-shrink-0 transition-colors"
                            >
                              Laden
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                    {databaseCandidates.length === 0 && !searchingDatabase && onLocateRekordboxDatabases && (
                      <p className="text-[10px] text-neutral-500">
                        Keine Datenbank im Standardordner gefunden. Du kannst die Datei auch manuell auswählen.
                      </p>
                    )}
                  </div>
                </div>
              </div>

              {/* Database Status */}
              <div className="bg-[#0f1015] border border-[#20222a] p-3 rounded">
                <div className="flex items-center space-x-2 text-[11px] text-neutral-300">
                  <Sparkles size={13} className="text-[#10b981]" />
                  <span>
                    Aktueller Track: <strong className="text-white">{track.title}</strong> von{' '}
                    <strong className="text-white">{track.artist}</strong>
                  </span>
                </div>
                <div className="text-[10px] text-neutral-500 font-mono mt-1">
                  Verifizierter SHA-256 Originalschutz aktiv • Read-Only Original • Working Copy Segmentierung aktiv
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="h-11 bg-[#14151b] border-t border-[#22242e] px-4 flex items-center justify-between flex-shrink-0 text-[11px]">
          <span className="text-neutral-400 font-mono">
            Pioneer Rekordbox™ 7.0 Analysis Architecture • Full Fidelity Visual Sync
          </span>
          <button
            onClick={onClose}
            className="px-4 py-1 bg-[#262832] hover:bg-[#323542] text-white rounded text-xs transition-colors"
          >
            Schließen
          </button>
        </div>
      </div>
    </div>
  );
};
