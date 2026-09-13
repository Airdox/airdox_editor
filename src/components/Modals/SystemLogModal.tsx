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
} from 'lucide-react';
import { logger, LogEntry, LogLevel, LogCategory } from '../../utils/logger';

interface SystemLogModalProps {
  isOpen: boolean;
  onClose: () => void;
  appContextState?: any;
}

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
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;

    // Load initial logs
    setLogs(logger.getEntries());

    // Subscribe to real-time additions
    const unsubscribe = logger.subscribe((entry) => {
      setLogs((prev) => [...prev, entry]);
    });

    return () => unsubscribe();
  }, [isOpen]);

  const filteredLogs = useMemo(() => {
    return logs.filter((log) => {
      if (levelFilter !== 'ALL' && log.level !== levelFilter) return false;
      if (categoryFilter !== 'ALL' && log.category !== categoryFilter) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchMsg = log.message.toLowerCase().includes(q);
        const matchCat = log.category.toLowerCase().includes(q);
        const matchDetails = log.details ? JSON.stringify(log.details).toLowerCase().includes(q) : false;
        if (!matchMsg && !matchCat && !matchDetails) return false;
      }
      return true;
    });
  }, [logs, levelFilter, categoryFilter, searchQuery]);

  const handleCopy = () => {
    const text = filteredLogs
      .map((l) => `[${l.timeString}] [${l.level}] [${l.category}] ${l.message}`)
      .join('\n');
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const handleDownload = () => {
    logger.downloadReport(appContextState, `rekordbox_system_logs_${Date.now()}.json`);
  };

  const handleClear = () => {
    logger.clear();
    setLogs([]);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-xs flex items-center justify-center p-4 select-none animate-in fade-in duration-150">
      <div className="w-full max-w-4xl h-[85vh] bg-[#0c0d12] border border-[#232635] rounded-xs shadow-2xl flex flex-col overflow-hidden text-neutral-200 text-xs">
        {/* Header */}
        <div className="h-10 bg-[#12141c] border-b border-[#232635] px-4 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center space-x-2">
            <div className="w-6 h-6 rounded bg-[#0088ff]/15 border border-[#0088ff]/40 flex items-center justify-center text-[#00a2ff]">
              <Terminal size={13} />
            </div>
            <span className="font-bold text-white text-xs tracking-wide uppercase">
              System Telemetrie &amp; Audit-Protokoll
            </span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#00c853]/15 border border-[#00c853]/30 text-[#34d399] font-mono">
              LIVE STREAM
            </span>
          </div>

          <div className="flex items-center space-x-2">
            <span className="text-[10px] text-neutral-500 font-mono">
              {filteredLogs.length} / {logs.length} Einträge
            </span>
            <button
              onClick={onClose}
              className="p-1 hover:text-white text-neutral-400 hover:bg-[#1e2230] rounded transition-colors"
            >
              <X size={14} />
            </button>
          </div>
        </div>

        {/* Toolbar / Filters */}
        <div className="p-2.5 bg-[#101117] border-b border-[#1f222f] flex flex-wrap items-center gap-2 flex-shrink-0">
          {/* Search Input */}
          <div className="relative flex-1 min-w-[180px]">
            <Search size={12} className="absolute left-2.5 top-2.5 text-neutral-500" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="In Protokollen suchen..."
              className="w-full bg-[#161822] border border-[#272b3c] rounded px-2 pl-7 py-1 text-xs text-white placeholder-neutral-500 focus:outline-none focus:border-[#0088ff]"
            />
          </div>

          {/* Level Filter */}
          <select
            value={levelFilter}
            onChange={(e) => setLevelFilter(e.target.value)}
            className="bg-[#161822] border border-[#272b3c] rounded px-2 py-1 text-xs text-neutral-300 focus:outline-none focus:border-[#0088ff]"
          >
            <option value="ALL">Alle Level</option>
            <option value="INFO">INFO</option>
            <option value="WARN">WARN</option>
            <option value="ERROR">ERROR / FATAL</option>
            <option value="DEBUG">DEBUG</option>
          </select>

          {/* Category Filter */}
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="bg-[#161822] border border-[#272b3c] rounded px-2 py-1 text-xs text-neutral-300 focus:outline-none focus:border-[#0088ff]"
          >
            <option value="ALL">Alle Kategorien</option>
            <option value="XML_IMPORT">XML_IMPORT</option>
            <option value="AUDIO_ENGINE">AUDIO_ENGINE</option>
            <option value="BEATGRID">BEATGRID</option>
            <option value="EDITING">EDITING</option>
            <option value="DATABASE">DATABASE</option>
            <option value="SYSTEM">SYSTEM</option>
          </select>

          {/* Actions */}
          <div className="flex items-center space-x-1.5 ml-auto">
            <button
              onClick={handleCopy}
              className="px-2.5 py-1 bg-[#1a1c26] hover:bg-[#252838] border border-[#2c3042] text-neutral-300 hover:text-white rounded text-[11px] flex items-center space-x-1 transition-colors"
              title="Gefilterte Einträge kopieren"
            >
              <Copy size={11} />
              <span>{copied ? 'Kopiert!' : 'Kopieren'}</span>
            </button>
            <button
              onClick={handleDownload}
              className="px-2.5 py-1 bg-[#0088ff]/15 hover:bg-[#0088ff] border border-[#0088ff]/40 text-[#00a2ff] hover:text-white rounded text-[11px] flex items-center space-x-1 transition-colors"
              title="Vollständigen JSON-Diagnosebericht exportieren"
            >
              <Download size={11} />
              <span>JSON Export</span>
            </button>
            <button
              onClick={handleClear}
              className="p-1 hover:bg-[#331114] text-neutral-400 hover:text-[#ff4444] rounded border border-transparent hover:border-[#55181c] transition-colors"
              title="Protokoll zurücksetzen"
            >
              <Trash2 size={13} />
            </button>
          </div>
        </div>

        {/* Log Viewer Body */}
        <div className="flex-1 p-3 overflow-y-auto font-mono text-[11px] space-y-1 bg-[#08090d] select-text">
          {filteredLogs.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-neutral-500 space-y-1">
              <Terminal size={24} className="opacity-40" />
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
                  className="py-1 px-2 rounded hover:bg-[#12141c] border border-transparent hover:border-[#1d202c] flex flex-col space-y-0.5 leading-snug"
                >
                  <div className="flex items-start space-x-2">
                    <span className="text-neutral-500 text-[10px] flex-shrink-0 pt-0.5">
                      {log.timeString}
                    </span>
                    <span
                      className={`text-[9px] px-1 py-0.5 rounded border font-bold flex-shrink-0 ${levelColor}`}
                    >
                      {log.level}
                    </span>
                    <span className="text-[#a0aec0] font-semibold text-[10px] flex-shrink-0">
                      [{log.category}]
                    </span>
                    <span
                      className={`flex-1 break-words ${
                        log.level === 'ERROR' || log.level === 'FATAL'
                          ? 'text-[#ff7777] font-semibold'
                          : 'text-neutral-200'
                      }`}
                    >
                      {log.message}
                    </span>
                  </div>

                  {log.details && (
                    <pre className="ml-14 mt-1 text-[10px] text-neutral-400 bg-[#0e1017] p-1.5 rounded border border-[#1b1e2a] overflow-x-auto">
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
          <span>Pioneer Rekordbox DJ Editor Diagnostics Engine</span>
          <span className="font-mono">Maximale Transparenz • Non-blocking Logger</span>
        </div>
      </div>
    </div>
  );
};
