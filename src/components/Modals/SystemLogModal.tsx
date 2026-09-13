/**
 * @license
 * Rekordbox DJ Editor - Live System Diagnostic & Audit Log Modal
 * 
 * Interactive real-time log inspector for maximum operational transparency.
 * Displays filtered event streams, incident details, and diagnostics export.
 */

import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  X,
  Terminal,
  Search,
  Filter,
  Download,
  Copy,
  Trash2,
  CheckCircle2,
  AlertTriangle,
  AlertOctagon,
  Info,
  Layers,
  Pause,
  Play,
  ArrowDownCircle,
  FileSpreadsheet,
  FileText,
} from 'lucide-react';
import { logger, LogEntry, LogLevel, LogCategory } from '../../utils/logger';

interface SystemLogModalProps {
  isOpen: boolean;
  onClose: () => void;
  appContextState?: any;
}

const ALL_CATEGORIES: { id: LogCategory | 'ALL'; label: string }[] = [
  { id: 'ALL', label: 'Alle' },
  { id: 'SYSTEM', label: 'SYSTEM' },
  { id: 'AUDIO_ENGINE', label: 'AUDIO' },
  { id: 'RECORDING', label: 'RECORD' },
  { id: 'PLAYBACK', label: 'PLAYBACK' },
  { id: 'EDITING', label: 'EDIT' },
  { id: 'CUES', label: 'CUES' },
  { id: 'BEATGRID', label: 'BEATGRID' },
  { id: 'DATABASE', label: 'DB' },
  { id: 'XML_IMPORT', label: 'XML' },
  { id: 'CLIP_LIBRARY', label: 'CLIPS' },
  { id: 'CHATBOT', label: 'COPILOT' },
  { id: 'KEYBOARD', label: 'KEYS' },
  { id: 'UI', label: 'UI' },
];

export const SystemLogModal: React.FC<SystemLogModalProps> = ({
  isOpen,
  onClose,
  appContextState,
}) => {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [levelFilter, setLevelFilter] = useState<string>('ALL');
  const [categoryFilter, setCategoryFilter] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [copied, setCopied] = useState<boolean>(false);
  const [isLivePaused, setIsLivePaused] = useState<boolean>(false);
  const [autoScroll, setAutoScroll] = useState<boolean>(true);
  const logContainerRef = useRef<HTMLDivElement>(null);
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;

    // Load initial logs
    setLogs(logger.getEntries());

    // Subscribe to real-time additions
    const unsubscribe = logger.subscribe((entry) => {
      setLogs((prev) => {
        if (isLivePaused) return prev;
        return [...prev, entry];
      });
    });

    return () => unsubscribe();
  }, [isOpen, isLivePaused]);

  useEffect(() => {
    if (autoScroll && logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, autoScroll]);

  const stats = useMemo(() => {
    const counts = {
      total: logs.length,
      INFO: 0,
      WARN: 0,
      ERROR: 0,
      DEBUG: 0,
      byCat: {} as Record<string, number>,
    };
    for (const l of logs) {
      if (l.level === 'FATAL' || l.level === 'ERROR') counts.ERROR++;
      else if (l.level === 'WARN') counts.WARN++;
      else if (l.level === 'INFO') counts.INFO++;
      else if (l.level === 'DEBUG') counts.DEBUG++;
      counts.byCat[l.category] = (counts.byCat[l.category] || 0) + 1;
    }
    return counts;
  }, [logs]);

  const filteredLogs = useMemo(() => {
    return logs.filter((log) => {
      if (levelFilter !== 'ALL') {
        if (levelFilter === 'ERROR') {
          if (log.level !== 'ERROR' && log.level !== 'FATAL') return false;
        } else if (log.level !== levelFilter) {
          return false;
        }
      }
      if (categoryFilter !== 'ALL' && log.category !== categoryFilter) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchMsg = log.message.toLowerCase().includes(q);
        const matchCat = log.category.toLowerCase().includes(q);
        const matchSub = log.subsystem?.toLowerCase().includes(q) || false;
        const matchDetails = log.details ? JSON.stringify(log.details).toLowerCase().includes(q) : false;
        if (!matchMsg && !matchCat && !matchSub && !matchDetails) return false;
      }
      return true;
    });
  }, [logs, levelFilter, categoryFilter, searchQuery]);

  const handleCopy = () => {
    const text = filteredLogs
      .map((l) => {
        const sub = l.subsystem ? ` [${l.subsystem}]` : '';
        const dur = l.durationMs !== undefined ? ` (${l.durationMs}ms)` : '';
        return `[${l.timeString}] [${l.level}] [${l.category}]${sub} ${l.message}${dur}`;
      })
      .join('\n');
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const handleDownloadJson = () => {
    logger.downloadReport(appContextState, `rekordbox_diagnostic_${Date.now()}.json`);
  };

  const handleDownloadCsv = () => {
    logger.downloadCsv(`rekordbox_logs_${Date.now()}.csv`);
  };

  const handleDownloadTxt = () => {
    logger.downloadPlainText(`rekordbox_logs_${Date.now()}.txt`);
  };

  const handleClear = () => {
    logger.clear();
    setLogs([]);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-xs flex items-center justify-center p-3 select-none animate-in fade-in duration-150">
      <div className="w-full max-w-5xl h-[88vh] bg-[#0c0d12] border border-[#232635] rounded-xs shadow-2xl flex flex-col overflow-hidden text-neutral-200 text-xs">
        {/* Header */}
        <div className="h-11 bg-[#12141c] border-b border-[#232635] px-4 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center space-x-2.5">
            <div className="w-6 h-6 rounded bg-[#0088ff]/15 border border-[#0088ff]/40 flex items-center justify-center text-[#00a2ff]">
              <Terminal size={13} />
            </div>
            <div>
              <span className="font-bold text-white text-xs tracking-wide uppercase">
                System Telemetrie &amp; Gesamtes Audit-Protokoll
              </span>
              <span className="text-[10px] text-neutral-400 block -mt-0.5">
                Erfasst alle Hintergrundprozesse, Audio-Puffer, Aufnahmen, Rekordbox-Syncs &amp; Bearbeitungen
              </span>
            </div>
            <span className={`text-[10px] px-2 py-0.5 rounded font-mono font-bold flex items-center space-x-1 ${
              isLivePaused
                ? 'bg-amber-500/15 border border-amber-500/40 text-amber-300'
                : 'bg-[#00c853]/15 border border-[#00c853]/30 text-[#34d399]'
            }`}>
              <span className={`w-1.5 h-1.5 rounded-full mr-1 ${isLivePaused ? 'bg-amber-400' : 'bg-emerald-400 animate-ping'}`} />
              {isLivePaused ? 'ANGEHALTEN' : 'LIVE STREAM'}
            </span>
          </div>

          <div className="flex items-center space-x-2.5">
            {/* Level Quick Badges */}
            <div className="hidden sm:flex items-center space-x-1.5 font-mono text-[10px]">
              <span className="px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20">
                INFO: {stats.INFO}
              </span>
              <span className="px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">
                WARN: {stats.WARN}
              </span>
              <span className="px-1.5 py-0.5 rounded bg-red-500/15 text-red-400 border border-red-500/30 font-bold">
                ERR: {stats.ERROR}
              </span>
            </div>

            <button
              onClick={onClose}
              className="p-1 hover:text-white text-neutral-400 hover:bg-[#1e2230] rounded transition-colors"
            >
              <X size={15} />
            </button>
          </div>
        </div>

        {/* Category Pills Strip */}
        <div className="px-3 py-1.5 bg-[#0e1017] border-b border-[#1b1e2a] flex items-center space-x-1 overflow-x-auto text-[10.5px] flex-shrink-0 scrollbar-none">
          <span className="text-neutral-500 font-mono text-[10px] mr-1 uppercase flex-shrink-0">
            Kategorie:
          </span>
          {ALL_CATEGORIES.map((cat) => {
            const isSelected = categoryFilter === cat.id;
            const count = cat.id === 'ALL' ? logs.length : stats.byCat[cat.id] || 0;
            return (
              <button
                key={cat.id}
                onClick={() => setCategoryFilter(cat.id)}
                className={`px-2 py-0.5 rounded text-[10px] font-mono transition-colors flex items-center space-x-1 flex-shrink-0 ${
                  isSelected
                    ? 'bg-[#0088ff] text-white font-bold shadow-xs'
                    : 'bg-[#151722] hover:bg-[#1f2232] text-neutral-400 hover:text-neutral-200 border border-[#232738]'
                }`}
              >
                <span>{cat.label}</span>
                <span className={`text-[9px] px-1 rounded ${isSelected ? 'bg-blue-900 text-blue-100' : 'bg-[#0e1017] text-neutral-500'}`}>
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        {/* Toolbar / Search & Actions */}
        <div className="p-2 bg-[#101117] border-b border-[#1f222f] flex flex-wrap items-center gap-2 flex-shrink-0">
          {/* Search Input */}
          <div className="relative flex-1 min-w-[200px]">
            <Search size={12} className="absolute left-2.5 top-2 text-neutral-500" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="In Meldungen, Subsystemen & Details filtern..."
              className="w-full bg-[#161822] border border-[#272b3c] rounded px-2 pl-7 py-1 text-xs text-white placeholder-neutral-500 focus:outline-none focus:border-[#0088ff]"
            />
          </div>

          {/* Level Filter */}
          <select
            value={levelFilter}
            onChange={(e) => setLevelFilter(e.target.value)}
            className="bg-[#161822] border border-[#272b3c] rounded px-2 py-1 text-xs text-neutral-300 focus:outline-none focus:border-[#0088ff]"
          >
            <option value="ALL">Alle Schweregrade</option>
            <option value="INFO">Nur INFO</option>
            <option value="WARN">Nur WARN</option>
            <option value="ERROR">Fehler (ERROR &amp; FATAL)</option>
            <option value="DEBUG">Nur DEBUG</option>
          </select>

          {/* Pause / Resume Live Stream */}
          <button
            onClick={() => setIsLivePaused((p) => !p)}
            className={`px-2 py-1 rounded text-[11px] font-mono flex items-center space-x-1 border transition-colors ${
              isLivePaused
                ? 'bg-amber-600/20 border-amber-500 text-amber-300 hover:bg-amber-600/30'
                : 'bg-[#181a24] border-[#2d3144] text-neutral-300 hover:text-white hover:bg-[#222534]'
            }`}
            title={isLivePaused ? 'Live-Stream fortsetzen' : 'Live-Stream vorübergehend anhalten'}
          >
            {isLivePaused ? <Play size={11} /> : <Pause size={11} />}
            <span>{isLivePaused ? 'Fortsetzen' : 'Anhalten'}</span>
          </button>

          {/* Auto-scroll toggle */}
          <button
            onClick={() => setAutoScroll((s) => !s)}
            className={`px-2 py-1 rounded text-[11px] font-mono flex items-center space-x-1 border transition-colors ${
              autoScroll
                ? 'bg-blue-600/20 border-blue-500/50 text-blue-300'
                : 'bg-[#181a24] border-[#2d3144] text-neutral-400 hover:text-neutral-200'
            }`}
            title="Automatisches Nach-Unten-Scrollen bei neuen Einträgen"
          >
            <ArrowDownCircle size={11} />
            <span>Auto-Scroll</span>
          </button>

          {/* Export Dropdown / Actions */}
          <div className="flex items-center space-x-1.5 ml-auto">
            <button
              onClick={handleCopy}
              className="px-2.5 py-1 bg-[#1a1c26] hover:bg-[#252838] border border-[#2c3042] text-neutral-300 hover:text-white rounded text-[11px] flex items-center space-x-1 transition-colors"
              title="Gefilterte Einträge in die Zwischenablage kopieren"
            >
              <Copy size={11} />
              <span>{copied ? 'Kopiert!' : 'Kopieren'}</span>
            </button>

            {/* Download TXT */}
            <button
              onClick={handleDownloadTxt}
              className="px-2 py-1 bg-[#161822] hover:bg-[#202330] border border-[#272b3c] text-neutral-300 hover:text-white rounded text-[11px] flex items-center space-x-1 transition-colors"
              title="Als Textdatei (.txt) herunterladen"
            >
              <FileText size={11} />
              <span>TXT</span>
            </button>

            {/* Download CSV */}
            <button
              onClick={handleDownloadCsv}
              className="px-2 py-1 bg-[#161822] hover:bg-[#202330] border border-[#272b3c] text-neutral-300 hover:text-white rounded text-[11px] flex items-center space-x-1 transition-colors"
              title="Als CSV-Tabelle (.csv) herunterladen"
            >
              <FileSpreadsheet size={11} />
              <span>CSV</span>
            </button>

            {/* Download JSON */}
            <button
              onClick={handleDownloadJson}
              className="px-2.5 py-1 bg-[#0088ff]/15 hover:bg-[#0088ff] border border-[#0088ff]/40 text-[#00a2ff] hover:text-white rounded text-[11px] flex items-center space-x-1 transition-colors"
              title="Vollständigen JSON-Diagnosebericht exportieren"
            >
              <Download size={11} />
              <span>JSON</span>
            </button>

            {/* Clear button */}
            <button
              onClick={handleClear}
              className="p-1 hover:bg-[#331114] text-neutral-400 hover:text-[#ff4444] rounded border border-transparent hover:border-[#55181c] transition-colors ml-1"
              title="Protokoll zurücksetzen"
            >
              <Trash2 size={13} />
            </button>
          </div>
        </div>

        {/* Log Viewer Body */}
        <div
          ref={logContainerRef}
          className="flex-1 p-2.5 overflow-y-auto font-mono text-[11px] space-y-0.5 bg-[#08090d] select-text"
        >
          {filteredLogs.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-neutral-500 space-y-1">
              <Terminal size={26} className="opacity-40" />
              <span>Keine Log-Einträge für den gewählten Filter vorhanden</span>
            </div>
          ) : (
            filteredLogs.map((log) => {
              const levelColor =
                log.level === 'FATAL' || log.level === 'ERROR'
                  ? 'text-[#ff4444] bg-[#ff2222]/10 border-[#ff2222]/30'
                  : log.level === 'WARN'
                  ? 'text-[#f59e0b] bg-[#f59e0b]/10 border-[#f59e0b]/30'
                  : log.level === 'INFO'
                  ? 'text-[#00a2ff] bg-[#00a2ff]/10 border-[#00a2ff]/30'
                  : 'text-neutral-400 bg-neutral-800/20 border-neutral-700/30';

              return (
                <div
                  key={log.id}
                  className="py-1 px-2 rounded hover:bg-[#12141c] border border-transparent hover:border-[#1d202c] flex flex-col space-y-0.5 leading-snug transition-colors"
                >
                  <div className="flex items-start space-x-2">
                    <span className="text-neutral-500 text-[10px] flex-shrink-0 pt-0.5">
                      {log.timeString}
                    </span>
                    <span
                      className={`text-[9px] px-1 py-0.2 rounded border font-bold flex-shrink-0 ${levelColor}`}
                    >
                      {log.level}
                    </span>
                    <span className="text-[#38bdf8] font-semibold text-[10px] flex-shrink-0">
                      [{log.category}]
                    </span>
                    {log.subsystem && (
                      <span className="text-amber-400/90 text-[9.5px] bg-amber-400/10 px-1 rounded flex-shrink-0">
                        {log.subsystem}
                      </span>
                    )}
                    <span
                      className={`flex-1 break-words ${
                        log.level === 'ERROR' || log.level === 'FATAL'
                          ? 'text-[#ff7777] font-semibold'
                          : log.level === 'WARN'
                          ? 'text-amber-200'
                          : 'text-neutral-200'
                      }`}
                    >
                      {log.message}
                    </span>
                    {log.durationMs !== undefined && (
                      <span className="text-neutral-500 text-[9px] font-mono flex-shrink-0">
                        {log.durationMs}ms
                      </span>
                    )}
                  </div>

                  {log.details && (
                    <pre className="ml-14 mt-1 text-[10px] text-neutral-400 bg-[#0e1017] p-1.5 rounded border border-[#1b1e2a] overflow-x-auto max-h-48">
                      {typeof log.details === 'string'
                        ? log.details
                        : JSON.stringify(log.details, null, 2)}
                    </pre>
                  )}

                  {log.stack && (
                    <pre className="ml-14 mt-1 text-[9.5px] text-[#ff8888] bg-[#1a0e10] p-1.5 rounded border border-[#3d1a1c] overflow-x-auto whitespace-pre-wrap">
                      {log.stack}
                    </pre>
                  )}
                </div>
              );
            })
          )}
          <div ref={logEndRef} />
        </div>

        {/* Footer info strip */}
        <div className="h-7 bg-[#101117] border-t border-[#1f222f] px-3 flex items-center justify-between text-[10px] text-neutral-500">
          <div className="flex items-center space-x-3">
            <span>Pioneer Rekordbox DJ Editor Diagnostics Engine</span>
            <span>•</span>
            <span className="font-mono">Puffer: {logs.length} / 5000 Einträge</span>
          </div>
          <span className="font-mono text-neutral-400">
            {filteredLogs.length} gefiltert
          </span>
        </div>
      </div>
    </div>
  );
};

