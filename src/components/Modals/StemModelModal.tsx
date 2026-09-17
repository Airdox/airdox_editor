/**
 * Stem-Modellverwaltung (Desktop-App).
 *
 * Zeigt ehrlich, welche Engine verfügbar ist:
 *  - Status der Separator-CLI (`audio-separator`) inkl. Installationshinweis,
 *  - kuratierter Modell-Katalog + die von der CLI gemeldeten Modelle,
 *  - welche Gewichte tatsächlich im Modell-Ordner liegen (Größe, Prüfsumme),
 *  - Download/Import/Entfernen von Gewichten und die Wahl des aktiven Modells.
 *
 * Ohne Desktop-Bridge (Browser/Dev-Preview) läuft ausschließlich die eingebaute
 * DSP-Heuristik – das wird hier klar gesagt, nicht versteckt.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { X, Cpu, Download, FolderOpen, RefreshCw, Trash2, Upload, CheckCircle2, AlertTriangle, Layers, HardDriveDownload } from 'lucide-react';
import { STEM_MODEL_CATALOG, mergeRuntimeModels, type StemModelEntry } from '../../stems/modelCatalog';

// DesktopModelProgress / DesktopSeparatorStatus / DesktopStemModelEntry sind
// globale Typen aus src/types/desktop.d.ts (declare global) und werden hier
// bewusst nicht importiert.

interface StemModelModalProps {
  isOpen: boolean;
  onClose: () => void;
  selectedModelId: string | null;
  onSelectModel: (modelId: string | null) => void;
}

type ModelRow = DesktopStemModelEntry & { catalogEntry?: StemModelEntry };

function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return '–';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} kB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export const StemModelModal: React.FC<StemModelModalProps> = ({ isOpen, onClose, selectedModelId, onSelectModel }) => {
  const desktop = window.rekordboxDesktop;
  const [status, setStatus] = useState<DesktopSeparatorStatus | null>(null);
  const [rows, setRows] = useState<ModelRow[]>([]);
  const [modelDir, setModelDir] = useState<string>('');
  const [busy, setBusy] = useState<boolean>(false);
  const [progress, setProgress] = useState<DesktopModelProgress | null>(null);
  const [message, setMessage] = useState<{ kind: 'info' | 'warn' | 'error'; text: string } | null>(null);
  const [runtimeCount, setRuntimeCount] = useState<number>(0);

  const refresh = useCallback(
    async (options: { force?: boolean } = {}) => {
      if (!desktop) return;
      setBusy(true);
      setMessage(null);
      try {
        const [separatorStatus, runtimeCatalog] = await Promise.all([
          desktop.separatorStatus?.({ force: Boolean(options.force) }) ?? Promise.resolve(null),
          desktop.fetchStemModelCatalog?.({ force: Boolean(options.force) }) ?? Promise.resolve(null),
        ]);
        setStatus(separatorStatus ?? null);
        setRuntimeCount(runtimeCatalog?.models.length ?? 0);
        const catalog = mergeRuntimeModels(runtimeCatalog?.models ?? [], STEM_MODEL_CATALOG);
        const list = (await desktop.listStemModels?.(catalog)) ?? null;
        setModelDir(list?.modelDir ?? '');
        const byId = new Map((list?.models ?? []).map((entry) => [entry.id, entry]));
        setRows(
          catalog.map((entry) => {
            const local = byId.get(entry.id) ?? null;
            return {
              ...(local ?? {
                id: entry.id,
                label: entry.label,
                fileName: entry.fileName,
                architecture: entry.architecture,
                stemOrder: entry.stemOrder,
                trainedModel: entry.trainedModel,
                requiresExternalRuntime: entry.requiresExternalRuntime,
                recommended: entry.recommended,
                qualityHint: entry.qualityHint,
                license: entry.license ?? null,
                downloadUrl: entry.downloadUrl ?? null,
                approximateSizeMb: entry.approximateSizeMb ?? null,
                profile: entry.profile,
                installed: false,
                downloading: false,
                localPath: null,
                sizeBytes: null,
                sha256: null,
                source: null,
                delegateToRuntime: Boolean(entry.requiresExternalRuntime && !entry.downloadUrl),
              }),
              catalogEntry: entry,
            } as ModelRow;
          })
        );
      } catch (error) {
        setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
      } finally {
        setBusy(false);
      }
    },
    [desktop]
  );

  useEffect(() => {
    if (!isOpen) return;
    void refresh({ force: true });
  }, [isOpen, refresh]);

  useEffect(() => {
    const subscribe = desktop?.onStemModelProgress;
    if (!subscribe) return;
    const unsubscribe = subscribe((payload) => setProgress(payload));
    return () => {
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [desktop]);

  const activeRow = useMemo(() => rows.find((row) => row.id === selectedModelId) ?? null, [rows, selectedModelId]);

  const download = async (row: ModelRow): Promise<void> => {
    if (!desktop?.downloadStemModel || !row.fileName) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await desktop.downloadStemModel({
        id: row.id,
        fileName: row.fileName,
        label: row.label,
        downloadUrl: row.downloadUrl ?? null,
      });
      setMessage({ kind: 'info', text: `Gewichte installiert: ${result.fileName} (${formatBytes(result.sizeBytes)})` });
      await refresh();
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setProgress(null);
      setBusy(false);
    }
  };

  const removeModel = async (row: ModelRow): Promise<void> => {
    if (!desktop?.removeStemModel || !row.fileName) return;
    if (!window.confirm(`Gewichte "${row.fileName}" wirklich aus dem Modell-Ordner entfernen?`)) return;
    setBusy(true);
    try {
      await desktop.removeStemModel(row.fileName);
      setMessage({ kind: 'info', text: `Entfernt: ${row.fileName}` });
      await refresh();
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  const importModels = async (): Promise<void> => {
    if (!desktop?.importStemModels) return;
    setBusy(true);
    try {
      const result = await desktop.importStemModels();
      const count = result?.imported?.length ?? 0;
      setMessage({
        kind: count ? 'info' : 'warn',
        text: count
          ? `${count} Checkpoint(s) importiert.`
          : `Kein Checkpoint importiert.${result?.failures?.length ? ` ${result.failures[0].message}` : ''}`,
      });
      await refresh();
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  const openFolder = async (): Promise<void> => {
    if (!desktop?.openStemModelFolder) return;
    try {
      await desktop.openStemModelFolder();
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
    }
  };

  if (!isOpen) return null;

  const trainedRows = rows.filter((row) => row.requiresExternalRuntime);
  const builtinRows = rows.filter((row) => !row.requiresExternalRuntime);

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-[120] p-4 select-none">
      <div className="bg-[#12141a] border border-[#272935] rounded-sm shadow-2xl w-full max-w-4xl max-h-[85vh] flex flex-col overflow-hidden text-neutral-200">
        {/* Kopf */}
        <div className="h-11 bg-[#171922] border-b border-[#252834] flex items-center justify-between px-4">
          <div className="flex items-center space-x-2">
            <Layers size={16} className="text-indigo-300" />
            <span className="font-bold text-white text-xs tracking-wide">Stem-Modelle &amp; Gewichte</span>
            <span className="text-[10px] font-mono text-neutral-500">audio-separator · interner DSP-Fallback</span>
          </div>
          <button onClick={onClose} className="p-1 hover:text-white text-neutral-400 hover:bg-[#252834] rounded transition-colors cursor-pointer">
            <X size={14} />
          </button>
        </div>

        {/* Statuszeile */}
        <div className="px-4 py-3 border-b border-[#252834] bg-[#14161d] space-y-2">
          {!desktop ? (
            <div className="flex items-start space-x-2 text-[11.5px] text-amber-300">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>
                Keine Desktop-Bridge: Im Browser/Dev-Preview läuft ausschließlich die eingebaute DSP-Heuristik. Modell-Gewichte
                (BS-RoFormer, Demucs, MDX-Net) verwaltet nur die Desktop-App (Electron).
              </span>
            </div>
          ) : status?.available ? (
            <div className="flex items-start space-x-2 text-[11.5px] text-emerald-300">
              <CheckCircle2 size={14} className="mt-0.5 shrink-0" />
              <span>
                Separator-CLI verfügbar: <span className="font-mono">{status.command}</span>
                {runtimeCount > 0 && ` · ${runtimeCount} Modelle von der CLI gemeldet`}
                {modelDir && (
                  <>
                    {' '}· Modell-Ordner: <span className="font-mono text-neutral-400">{modelDir}</span>
                  </>
                )}
              </span>
            </div>
          ) : (
            <div className="flex items-start space-x-2 text-[11.5px] text-amber-300">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>
                {status?.reason ?? 'Separator-CLI nicht gefunden.'} Ohne CLI trennt die App mit der internen Heuristik.
                {status?.hint && <span className="block text-neutral-400 mt-1 font-mono text-[10.5px]">{status.hint}</span>}
              </span>
            </div>
          )}

          <div className="flex items-center space-x-2">
            <button
              onClick={() => void refresh({ force: true })}
              disabled={busy || !desktop}
              className="flex items-center space-x-1 px-2 py-1 rounded border border-[#2f3342] bg-[#1a1d26] hover:bg-[#222633] text-[10.5px] font-semibold disabled:opacity-50 cursor-pointer"
            >
              <RefreshCw size={11} className={busy ? 'animate-spin' : ''} />
              <span>Status aktualisieren</span>
            </button>
            <button
              onClick={() => void importModels()}
              disabled={busy || !desktop?.importStemModels}
              className="flex items-center space-x-1 px-2 py-1 rounded border border-[#2f3342] bg-[#1a1d26] hover:bg-[#222633] text-[10.5px] font-semibold disabled:opacity-50 cursor-pointer"
            >
              <Upload size={11} />
              <span>Checkpoint importieren</span>
            </button>
            <button
              onClick={() => void openFolder()}
              disabled={busy || !desktop?.openStemModelFolder}
              className="flex items-center space-x-1 px-2 py-1 rounded border border-[#2f3342] bg-[#1a1d26] hover:bg-[#222633] text-[10.5px] font-semibold disabled:opacity-50 cursor-pointer"
            >
              <FolderOpen size={11} />
              <span>Modell-Ordner öffnen</span>
            </button>
            {activeRow && (
              <span className="ml-auto text-[10.5px] font-mono text-indigo-300">Aktiv: {activeRow.label}</span>
            )}
          </div>

          {progress && progress.phase !== 'done' && (
            <div className="space-y-1">
              <div className="h-1.5 bg-[#222633] rounded overflow-hidden">
                <div
                  className="h-full bg-indigo-400 transition-all"
                  style={{ width: `${Math.round((progress.ratio ?? 0) * 100)}%` }}
                />
              </div>
              <div className="text-[10px] font-mono text-neutral-400">
                {progress.fileName}: {progress.message} ({formatBytes(progress.transferredBytes)} / {formatBytes(progress.totalBytes)})
              </div>
            </div>
          )}

          {message && (
            <div
              className={`text-[11px] px-2 py-1 rounded border ${
                message.kind === 'error'
                  ? 'border-red-500/40 bg-red-500/10 text-red-300'
                  : message.kind === 'warn'
                  ? 'border-amber-500/40 bg-amber-500/10 text-amber-300'
                  : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
              }`}
            >
              {message.text}
            </div>
          )}
        </div>

        {/* Liste */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
          <section>
            <h3 className="text-[10.5px] uppercase tracking-wider text-neutral-500 font-bold mb-2">Trainierte Modelle (externe Inferenz)</h3>
            <div className="space-y-1.5">
              {trainedRows.map((row) => (
                <div
                  key={row.id}
                  className={`border rounded px-3 py-2 flex items-start space-x-3 ${
                    selectedModelId === row.id ? 'border-indigo-500/60 bg-indigo-500/10' : 'border-[#262a36] bg-[#15171f]'
                  }`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center space-x-2">
                      <span className="text-[12px] font-semibold text-white truncate">{row.label}</span>
                      <span className="text-[9px] font-mono px-1 py-px rounded border border-[#2f3342] text-neutral-400">{row.architecture}</span>
                      {row.recommended && (
                        <span className="text-[9px] font-mono px-1 py-px rounded border border-emerald-500/40 bg-emerald-500/10 text-emerald-300">
                          EMPFOHLEN
                        </span>
                      )}
                      {row.installed ? (
                        <span className="text-[9px] font-mono px-1 py-px rounded border border-emerald-500/40 bg-emerald-500/10 text-emerald-300">
                          INSTALLIERT {row.sizeBytes ? `· ${formatBytes(row.sizeBytes)}` : ''}
                        </span>
                      ) : row.downloading ? (
                        <span className="text-[9px] font-mono px-1 py-px rounded border border-indigo-500/40 bg-indigo-500/10 text-indigo-300">LÄDT …</span>
                      ) : (
                        <span className="text-[9px] font-mono px-1 py-px rounded border border-neutral-600/50 text-neutral-400">
                          {row.delegateToRuntime ? 'CLI LÄDT BEIM ERSTEN LAUF' : 'NICHT INSTALLIERT'}
                        </span>
                      )}
                    </div>
                    <div className="text-[10.5px] text-neutral-400 mt-1">{row.qualityHint}</div>
                    <div className="text-[10px] font-mono text-neutral-500 mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                      {row.fileName && <span>Datei: {row.fileName}</span>}
                      <span>
                        Stems:{' '}
                        {row.stemOrder && row.stemOrder.length ? row.stemOrder.join(' · ') : 'meldet die Laufzeit'}
                      </span>
                      {row.approximateSizeMb ? <span>~{row.approximateSizeMb} MB</span> : null}
                      {row.sha256 ? <span>sha256 {row.sha256.slice(0, 12)}…</span> : null}
                      {row.license ? <span>Lizenz: {row.license}</span> : null}
                    </div>
                  </div>
                  <div className="flex flex-col items-end space-y-1 shrink-0">
                    <button
                      onClick={() => onSelectModel(row.id)}
                      className={`flex items-center space-x-1 px-2 py-1 rounded border text-[10px] font-semibold cursor-pointer ${
                        selectedModelId === row.id
                          ? 'border-indigo-400 bg-indigo-500/25 text-white'
                          : 'border-[#2f3342] bg-[#1a1d26] hover:bg-[#222633] text-neutral-300'
                      }`}
                    >
                      <Cpu size={11} />
                      <span>{selectedModelId === row.id ? 'Aktiv' : 'Auswählen'}</span>
                    </button>
                    {row.downloadUrl && !row.installed && (
                      <button
                        onClick={() => void download(row)}
                        disabled={busy || !desktop?.downloadStemModel}
                        className="flex items-center space-x-1 px-2 py-1 rounded border border-[#2f3342] bg-[#1a1d26] hover:bg-[#222633] text-[10px] font-semibold disabled:opacity-50 cursor-pointer"
                      >
                        <Download size={11} />
                        <span>Laden</span>
                      </button>
                    )}
                    {!row.downloadUrl && !row.installed && (
                      <span className="flex items-center space-x-1 text-[9.5px] text-neutral-500">
                        <HardDriveDownload size={11} />
                        <span>via CLI</span>
                      </span>
                    )}
                    {row.installed && (
                      <button
                        onClick={() => void removeModel(row)}
                        disabled={busy || !desktop?.removeStemModel}
                        className="flex items-center space-x-1 px-2 py-1 rounded border border-red-500/30 bg-red-500/10 hover:bg-red-500/20 text-[10px] font-semibold text-red-300 disabled:opacity-50 cursor-pointer"
                      >
                        <Trash2 size={11} />
                        <span>Entfernen</span>
                      </button>
                    )}
                  </div>
                </div>
              ))}
              {!trainedRows.length && <div className="text-[11px] text-neutral-500">Keine trainierten Modelle im Katalog.</div>}
            </div>
          </section>

          <section>
            <h3 className="text-[10.5px] uppercase tracking-wider text-neutral-500 font-bold mb-2">Eingebaute Engine (ohne Gewichte)</h3>
            <div className="space-y-1.5">
              {builtinRows.map((row) => (
                <div
                  key={row.id}
                  className={`border rounded px-3 py-2 flex items-start space-x-3 ${
                    selectedModelId === row.id ? 'border-amber-500/60 bg-amber-500/10' : 'border-[#262a36] bg-[#15171f]'
                  }`}
                >
                  <div className="flex-1">
                    <div className="flex items-center space-x-2">
                      <span className="text-[12px] font-semibold text-white">{row.label}</span>
                      <span className="text-[9px] font-mono px-1 py-px rounded border border-amber-500/40 bg-amber-500/10 text-amber-300">
                        HEURISTIK · KEIN KI-MODELL
                      </span>
                    </div>
                    <div className="text-[10.5px] text-neutral-400 mt-1">{row.qualityHint}</div>
                    <div className="text-[10px] font-mono text-neutral-500 mt-1">
                      Stems: {row.stemOrder?.join(' · ') ?? '–'} · läuft in Browser und Desktop, ohne Installation
                    </div>
                  </div>
                  <button
                    onClick={() => onSelectModel(row.id)}
                    className={`flex items-center space-x-1 px-2 py-1 rounded border text-[10px] font-semibold cursor-pointer ${
                      selectedModelId === row.id
                        ? 'border-amber-400 bg-amber-500/25 text-white'
                        : 'border-[#2f3342] bg-[#1a1d26] hover:bg-[#222633] text-neutral-300'
                    }`}
                  >
                    <Cpu size={11} />
                    <span>{selectedModelId === row.id ? 'Aktiv' : 'Auswählen'}</span>
                  </button>
                </div>
              ))}
            </div>
          </section>
        </div>

        {/* Fuß */}
        <div className="px-4 py-2.5 border-t border-[#252834] bg-[#14161d] flex items-center justify-between text-[10.5px] text-neutral-500">
          <span>
            Originaldateien werden nie verändert. Fehlt ein trainiertes Modell, springt sichtbar die interne Heuristik ein
            (kein stiller Fallback).
          </span>
          <button
            onClick={onClose}
            className="px-3 py-1 rounded border border-[#2f3342] bg-[#1a1d26] hover:bg-[#222633] text-neutral-200 font-semibold cursor-pointer"
          >
            Schließen
          </button>
        </div>
      </div>
    </div>
  );
};
