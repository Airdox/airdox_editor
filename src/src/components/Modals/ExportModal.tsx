/**
 * @license
 * Rekordbox ExportModal Component
 * Export master audio to standard 16-bit WAV, Rekordbox XML, or Project JSON.
 */

import React, { useState } from 'react';
import { X, Download, FileAudio, FileCode, CheckCircle2, Layers } from 'lucide-react';
import { TrackModel, PaletteClip } from '../../types/rekordbox';
import { audioEngine } from '../../audio/audioEngine';
import { exportToRekordboxXml } from '../../rekordbox/xmlParser';
import { OperationTelemetry } from './OperationFeedbackModal';
import { MultiLayerRenderInspector } from './MultiLayerRenderInspector';

interface ExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  track: TrackModel;
  clips?: PaletteClip[];
  workingAudioBuffer: AudioBuffer | null;
  protectedPaths?: string[];
  onExportComplete?: (telemetry: OperationTelemetry) => void;
}

export const ExportModal: React.FC<ExportModalProps> = ({
  isOpen,
  onClose,
  track,
  clips = [],
  workingAudioBuffer,
  protectedPaths,
  onExportComplete,
}) => {
  const [format, setFormat] = useState<'WAV' | 'XML' | 'JSON'>('WAV');
  const [isExporting, setIsExporting] = useState(false);
  const [showLayerInspector, setShowLayerInspector] = useState(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  if (!isOpen) return null;

  const triggerActualDownload = async () => {
    setShowLayerInspector(false);
    setIsExporting(true);
    setSuccessMsg(null);

    try {
      let defaultName = '';
      let kind: 'WAV' | 'XML' | 'JSON' = 'WAV';
      let bytes: Uint8Array;

      if (format === 'WAV') {
        const bufferToExport = workingAudioBuffer || track.audioBuffer;
        if (!bufferToExport) {
          alert('Keine Audiodaten für Export vorhanden.');
          setIsExporting(false);
          return;
        }
        const wavBlob = audioEngine.exportToWavBlob(bufferToExport);
        bytes = new Uint8Array(await wavBlob.arrayBuffer());
        const cleanTitle = track.title.replace(/[^a-zA-Z0-9_-]/g, '_');
        defaultName = `${cleanTitle}_EDIT_MASTER.wav`;
        kind = 'WAV';
      } else if (format === 'XML') {
        const xmlString = exportToRekordboxXml(track);
        bytes = new TextEncoder().encode(xmlString);
        const cleanTitle = track.title.replace(/[^a-zA-Z0-9_-]/g, '_');
        defaultName = `${cleanTitle}_rekordbox.xml`;
        kind = 'XML';
      } else {
        const projectData = {
          version: '2.0.0',
          track: {
            title: track.title,
            artist: track.artist,
            bpm: track.bpm,
            key: track.key,
            duration: track.duration,
            cues: track.cues,
            loops: track.loops,
            originalSha256: track.originalSha256,
          },
          exportedAt: new Date().toISOString(),
        };
        bytes = new TextEncoder().encode(JSON.stringify(projectData, null, 2));
        defaultName = 'rekordbox_project_state.json';
        kind = 'JSON';
      }

      // Desktop: save through the native dialog, which only writes to a NEW
      // file and refuses to overwrite an original Rekordbox source.
      if (window.rekordboxDesktop) {
        const res = await window.rekordboxDesktop.saveExportFile({
          kind,
          data: bytes,
          defaultName,
          protectedPaths,
        });
        if (res.saved) {
          setSuccessMsg(`${kind} erfolgreich als "${res.path?.split(/[\\\\/]/).pop() || defaultName}" gespeichert.`);
        } else {
          setIsExporting(false);
          return;
        }
      } else {
        // Browser fallback download.
        const mime = kind === 'WAV' ? 'audio/wav' : kind === 'XML' ? 'text/xml' : 'application/json';
        const blob = new Blob([bytes as BlobPart], { type: mime });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = defaultName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        setSuccessMsg(
          kind === 'WAV'
            ? `Master-Audio erfolgreich als "${defaultName}" exportiert.`
            : kind === 'XML'
            ? `Rekordbox XML erfolgreich als "${defaultName}" exportiert.`
            : 'Projektzustand erfolgreich gespeichert.'
        );
      }

      onExportComplete?.({
        title: `Export erfolgreich (${format})`,
        operationType: 'EXPORT',
        description: `Master-Datei erfolgreich als ${format} exportiert. Die Originalquelle verbleibt unberührt mit Prüfsumme ${track.originalSha256.slice(0, 12)}...`,
        originalSha256: track.originalSha256,
        timestamp: Date.now(),
      });
    } catch (err) {
      console.error(err);
      alert(`Fehler beim Exportieren: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsExporting(false);
    }
  };

  const handleStartRenderFlow = () => {
    // Open multi-layer timeline inspection animation first
    setShowLayerInspector(true);
  };

  return (
    <div className="fixed inset-0 bg-black/75 backdrop-blur-xs flex items-center justify-center z-50 select-none p-4">
      <div className="w-full max-w-md bg-[#12141a] border border-[#272935] rounded-xs shadow-2xl overflow-hidden flex flex-col text-neutral-200 text-xs">
        {/* Header */}
        <div className="h-9 bg-[#171922] border-b border-[#252834] flex items-center justify-between px-3">
          <div className="flex items-center space-x-2">
            <Download size={15} className="text-[#0088ff]" />
            <span className="font-bold text-white text-xs tracking-wide">
              Master Audio & Rekordbox Export
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1 hover:text-white text-neutral-400 hover:bg-[#252834] rounded transition-colors"
          >
            <X size={14} />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 space-y-4">
          <div className="text-[11px] text-neutral-400 leading-relaxed">
            Wähle das gewünschte Zielformat. Die Originaldatei bleibt dabei garantiert unberührt (Non-destructive).
          </div>

          {/* Format Radio Selection */}
          <div className="space-y-2">
            <label
              onClick={() => setFormat('WAV')}
              className={`flex items-start space-x-3 p-3 rounded-xs border cursor-pointer transition-colors ${
                format === 'WAV'
                  ? 'bg-[#181d2a] border-[#0088ff] text-white'
                  : 'bg-[#0f1015] border-[#22242f] text-neutral-400 hover:bg-[#14161e]'
              }`}
            >
              <FileAudio size={20} className={format === 'WAV' ? 'text-[#0088ff]' : 'text-neutral-500'} />
              <div className="flex-1">
                <span className="font-bold text-xs block text-white">
                  Master Audio (WAV - 16-Bit PCM / 44.1 kHz)
                </span>
                <span className="text-[10.5px] text-neutral-400 block mt-0.5">
                  Verlustfreie Studioqualität mit allen Schnitten, Inserts und Overdubs gerendert.
                </span>
              </div>
            </label>

            <label
              onClick={() => setFormat('XML')}
              className={`flex items-start space-x-3 p-3 rounded-xs border cursor-pointer transition-colors ${
                format === 'XML'
                  ? 'bg-[#181d2a] border-[#0088ff] text-white'
                  : 'bg-[#0f1015] border-[#22242f] text-neutral-400 hover:bg-[#14161e]'
              }`}
            >
              <FileCode size={20} className={format === 'XML' ? 'text-[#00c853]' : 'text-neutral-500'} />
              <div className="flex-1">
                <span className="font-bold text-xs block text-white">
                  Rekordbox XML (Pioneer DJ Format)
                </span>
                <span className="text-[10.5px] text-neutral-400 block mt-0.5">
                  Beinhaltet transformiertes Beatgrid, Memory Cues, Hot Cues und Loops.
                </span>
              </div>
            </label>
          </div>

          {successMsg && (
            <div className="p-2.5 bg-[#0e2718] border border-[#1b5e32] rounded-xs text-[#4ade80] text-[11px] flex items-center space-x-2">
              <CheckCircle2 size={15} />
              <span>{successMsg}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="h-11 bg-[#151720] border-t border-[#232532] px-3 flex items-center justify-between">
          <button
            onClick={onClose}
            className="px-3 py-1 text-neutral-400 hover:text-white text-xs transition-colors"
          >
            Abbrechen
          </button>

          <button
            onClick={handleStartRenderFlow}
            disabled={isExporting}
            className="px-4 py-1.5 bg-[#0088ff] hover:bg-[#0070d6] text-white rounded-xs font-semibold text-xs flex items-center space-x-1.5 transition-colors disabled:opacity-50 shadow-md hover:shadow-[#0088ff]/20"
          >
            <Layers size={13} className="text-[#99d5ff]" />
            <span>{isExporting ? 'Exportiere...' : 'Rendern & Schichten prüfen'}</span>
          </button>
        </div>
      </div>

      {/* Multi-Layer Composition Animation & Inspector Modal */}
      <MultiLayerRenderInspector
        isOpen={showLayerInspector}
        track={track}
        clips={clips}
        format={format}
        onStartDownload={triggerActualDownload}
        onCancel={() => setShowLayerInspector(false)}
      />
    </div>
  );
};
