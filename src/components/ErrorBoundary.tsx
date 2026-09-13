/**
 * @license
 * Rekordbox DJ Editor - Crash Prevention & Diagnostic Error Boundary
 * 
 * Prevents black screens by catching React render exceptions, logging the incident
 * with full telemetry, and rendering an authoritative Pioneer DJ diagnostic UI.
 */

import React, { Component, ErrorInfo, ReactNode } from 'react';
import { AlertOctagon, RefreshCw, Copy, Download, Terminal, ShieldAlert } from 'lucide-react';
import { logger } from '../utils/logger';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
  copied: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
    errorInfo: null,
    copied: false,
  };

  public static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      error,
      errorInfo: null,
      copied: false,
    };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    this.setState({ errorInfo });
    logger.fatal('SYSTEM', `React Render-Absturz verhindert: ${error.message}`, {
      error: error.message,
      stack: error.stack,
      componentStack: errorInfo.componentStack,
    });
  }

  private handleCopyDiagnostic = () => {
    const report = logger.generateDiagnosticReport({
      crashError: this.state.error?.message,
      crashStack: this.state.error?.stack,
      componentStack: this.state.errorInfo?.componentStack,
    });

    navigator.clipboard.writeText(report).then(() => {
      this.setState({ copied: true });
      setTimeout(() => this.setState({ copied: false }), 2500);
    });
  };

  private handleDownloadReport = () => {
    logger.downloadReport(
      {
        crashError: this.state.error?.message,
        crashStack: this.state.error?.stack,
        componentStack: this.state.errorInfo?.componentStack,
      },
      `rekordbox_crash_incident_${Date.now()}.json`
    );
  };

  private handleReload = () => {
    window.location.reload();
  };

  public render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      const errorMsg = this.state.error?.message || 'Unbekannter Systemfehler aufgetreten';
      const recentLogs = logger.getEntries().slice(-10);

      return (
        <div className="fixed inset-0 z-50 bg-[#07080a] flex items-center justify-center p-6 text-neutral-200 select-none">
          <div className="w-full max-w-3xl bg-[#0f1118] border border-[#ff3333]/50 rounded shadow-[0_0_50px_rgba(255,0,0,0.2)] flex flex-col overflow-hidden">
            {/* Header */}
            <div className="h-12 bg-[#1a0e10] border-b border-[#3d1a1c] px-4 flex items-center justify-between">
              <div className="flex items-center space-x-3">
                <div className="w-7 h-7 rounded bg-[#ff2222]/20 border border-[#ff2222]/50 flex items-center justify-center text-[#ff4444]">
                  <AlertOctagon size={16} />
                </div>
                <div>
                  <h2 className="text-sm font-bold text-white tracking-wide uppercase">
                    Rekordbox System-Schutz: Absturz abgefangen
                  </h2>
                  <p className="text-[10px] text-[#ff8888] font-mono">
                    Schwarzer Bildschirm verhindert • Maximale Transparenz aktiv
                  </p>
                </div>
              </div>
              <span className="text-[10px] px-2 py-0.5 rounded bg-[#ff2222]/15 border border-[#ff2222]/30 text-[#ff6666] font-mono font-bold">
                INCIDENT TELEMETRY
              </span>
            </div>

            {/* Content Body */}
            <div className="p-5 space-y-4 max-h-[75vh] overflow-y-auto">
              {/* Error summary */}
              <div className="bg-[#141620] border border-[#232738] p-3 rounded">
                <div className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider mb-1">
                  Fehlermeldung (Incident Detail):
                </div>
                <div className="font-mono text-xs text-[#ff5555] font-bold break-words">
                  {errorMsg}
                </div>
              </div>

              {/* Stack Trace / Component Stack */}
              {this.state.error?.stack && (
                <div className="bg-[#0b0c10] border border-[#1b1e2a] p-3 rounded">
                  <div className="text-[10px] font-semibold text-neutral-400 uppercase tracking-wider mb-1 flex items-center space-x-1.5">
                    <Terminal size={12} className="text-[#00a2ff]" />
                    <span>Aufruf-Stacktrace (Stack Trace):</span>
                  </div>
                  <pre className="text-[10px] font-mono text-neutral-300 overflow-x-auto whitespace-pre-wrap leading-relaxed max-h-36">
                    {this.state.error.stack}
                  </pre>
                </div>
              )}

              {/* Live Logger Entries */}
              <div className="bg-[#0b0c10] border border-[#1b1e2a] p-3 rounded">
                <div className="text-[10px] font-semibold text-neutral-400 uppercase tracking-wider mb-1 flex items-center space-x-1.5">
                  <ShieldAlert size={12} className="text-[#f59e0b]" />
                  <span>Letzte Log-Einträge vor dem Vorfall (Audit Trail):</span>
                </div>
                <div className="space-y-1 font-mono text-[10px] max-h-32 overflow-y-auto divide-y divide-[#161824]">
                  {recentLogs.map((log) => (
                    <div key={log.id} className="pt-1 pb-1 flex space-x-2">
                      <span className="text-neutral-500">[{log.timeString}]</span>
                      <span
                        className={`font-bold ${
                          log.level === 'ERROR' || log.level === 'FATAL'
                            ? 'text-[#ff4444]'
                            : log.level === 'WARN'
                            ? 'text-[#f59e0b]'
                            : 'text-[#00a2ff]'
                        }`}
                      >
                        [{log.category}]
                      </span>
                      <span className="text-neutral-300">{log.message}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Footer Buttons */}
            <div className="h-14 bg-[#12141c] border-t border-[#232738] px-5 flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <button
                  onClick={this.handleCopyDiagnostic}
                  className="flex items-center space-x-1.5 px-3 py-1.5 bg-[#1b1e2b] hover:bg-[#252a3d] border border-[#2d3247] text-xs text-neutral-200 rounded transition-colors"
                >
                  <Copy size={13} />
                  <span>{this.state.copied ? '✓ Kopiert!' : 'Protokoll kopieren'}</span>
                </button>
                <button
                  onClick={this.handleDownloadReport}
                  className="flex items-center space-x-1.5 px-3 py-1.5 bg-[#1b1e2b] hover:bg-[#252a3d] border border-[#2d3247] text-xs text-neutral-200 rounded transition-colors"
                >
                  <Download size={13} />
                  <span>Diagnosebericht (.json)</span>
                </button>
              </div>

              <button
                onClick={this.handleReload}
                className="flex items-center space-x-1.5 px-4 py-1.5 bg-[#0088ff] hover:bg-[#0077ee] text-white text-xs font-bold rounded shadow transition-colors"
              >
                <RefreshCw size={13} />
                <span>Anwendung neu starten</span>
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
