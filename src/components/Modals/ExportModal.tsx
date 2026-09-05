/**
 * @license
 * Rekordbox ExportModal Component
 * Export master audio to standard 16-bit WAV, Rekordbox XML, or Project JSON.
 */

import React, { useState } from 'react';
import { X, Download, FileAudio, FileCode, CheckCircle2 } from 'lucide-react';
import { TrackModel } from '../../types/rekordbox';
import { audioEngine } from '../../audio/audioEngine';
import { exportToRekordboxXml } from '../../rekordbox/xmlParser';
import { OperationTelemetry } from './OperationFeedbackModal';

interface ExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  track: TrackModel;
  workingAudioBuffer: AudioBuffer | null;
  onExportComplete?: (telemetry: OperationTelemetry) => void;
}

export const ExportModal: React.FC<ExportModalProps> = ({
  isOpen,
  onClose,
  track,
  workingAudioBuffer,
  onExportComplete,
}) => {
  const [format, setFormat] = useState<'WAV' | 'XML' | 'JSON'>('WAV');
  const [isExporting, setIsExporting] = useState(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleExport = () => {
    setIsExporting(true);
    setSuccessMsg(null);

    try {
      if (format === 'WAV') {
        const bufferToExport = workingAudioBuffer || track.audioBuffer;
        if (!bufferToExport) {
          alert('Keine Audiodaten für Export vorhanden.');
          setIsExporting(false);
          return;
        }

        const wavBlob = audioEngine.exportToWavBlob(bufferToExport);
        const url = URL.createObjectURL(wavBlob);
        const a = document.createElement('a');
        a.href = url;
        const cleanTitle = track.title.replace(/[^a-zA-Z0-9_-]/g, '_');
        a.download = `${cleanTitle}_EDIT_MASTER.wav`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        setSuccessMsg(`Master-Audio erfolgreich als "${cleanTitle}_EDIT_MASTER.wav" exportiert.`);
      } else if (format === 'XML') {
        const xmlString = exportToRekordboxXml(track);
        const blob = new Blob([xmlString], { type: 'text/xml' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const cleanTitle = track.title.replace(/[^a-zA-Z0-9_-]/g, '_');
        a.download = `${cleanTitle}_rekordbox.xml`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        setSuccessMsg(`Rekordbox XML erfolgreich als "${cleanTitle}_rekordbox.xml" exportiert.`);
      } else if (format === 'JSON') {
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
        const blob = new Blob([JSON.stringify(projectData, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'rekordbox_project_state.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        setSuccessMsg('Projektzustand erfolgreich gespeichert.');
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
      alert('Fehler beim Exportieren.');
    } finally {
      setIsExporting(false);
    }
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
            onClick={handleExport}
            disabled={isExporting}
            className="px-4 py-1.5 bg-[#0088ff] hover:bg-[#0070d6] text-white rounded-xs font-semibold text-xs flex items-center space-x-1.5 transition-colors disabled:opacity-50"
          >
            <Download size={13} />
            <span>{isExporting ? 'Exportiere...' : 'Jetzt Exportieren'}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
