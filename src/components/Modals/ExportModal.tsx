/**
 * @license
 * Rekordbox ExportModal Component
 * Export master audio to WAV, MP3, FLAC, AAC, OGG, WEBM, Rekordbox XML, or Project JSON.
 */

import React, { useState } from 'react';
import { X, Download, FileAudio, FileCode, CheckCircle2, Layers, HardDrive, Info } from 'lucide-react';
import { TrackModel, PaletteClip } from '../../types/rekordbox';
import { exportAudioBuffer, AudioExportFormat } from '../../audio/audioExporter';
import { exportToRekordboxXml } from '../../rekordbox/xmlParser';
import { OperationTelemetry } from './OperationFeedbackModal';
import { MultiLayerRenderInspector } from './MultiLayerRenderInspector';

export type ExportFormatType = AudioExportFormat | 'XML' | 'JSON';

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
  const [format, setFormat] = useState<ExportFormatType>('WAV');
  const [isExporting, setIsExporting] = useState(false);
  const [showLayerInspector, setShowLayerInspector] = useState(false);
  const [successInfo, setSuccessMsgInfo] = useState<{
    message: string;
    filename: string;
    location: string;
    formatLabel: string;
    bytesSize?: number;
  } | null>(null);

  if (!isOpen) return null;

  const isAudioFormat = (fmt: ExportFormatType): fmt is AudioExportFormat => {
    return fmt === 'WAV' || fmt === 'MP3' || fmt === 'FLAC' || fmt === 'AAC' || fmt === 'OGG' || fmt === 'WEBM';
  };

  const triggerActualDownload = async () => {
    setShowLayerInspector(false);
    setIsExporting(true);
    setSuccessMsgInfo(null);

    try {
      let defaultName = '';
      let kind = format;
      let bytes: Uint8Array;
      let mimeType = 'audio/wav';
      const cleanTitle = track.title.replace(/[^a-zA-Z0-9_-]/g, '_');

      if (isAudioFormat(format)) {
        const bufferToExport = workingAudioBuffer || track.audioBuffer;
        if (!bufferToExport) {
          alert('Keine Audiodaten für den Export vorhanden.');
          setIsExporting(false);
          return;
        }

        const encoded = await exportAudioBuffer(bufferToExport, { format });
        bytes = encoded.bytes;
        mimeType = encoded.mimeType;
        defaultName = `${cleanTitle}_EDIT_MASTER.${encoded.extension}`;
      } else if (format === 'XML') {
        const xmlString = exportToRekordboxXml(track);
        bytes = new TextEncoder().encode(xmlString);
        defaultName = `${cleanTitle}_rekordbox.xml`;
        mimeType = 'text/xml';
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
        mimeType = 'application/json';
      }

      // Desktop App: Save through native save dialog
      if (window.rekordboxDesktop) {
        const res = await window.rekordboxDesktop.saveExportFile({
          kind: isAudioFormat(format) ? 'WAV' : (format as 'XML' | 'JSON'),
          data: bytes,
          defaultName,
          protectedPaths,
        });
        if (res.saved && res.path) {
          const savedFileName = res.path.split(/[\\\\/]/).pop() || defaultName;
          const targetDir = res.path.substring(0, res.path.length - savedFileName.length);
          setSuccessMsgInfo({
            message: `Datei erfolgreich auf der Festplatte gespeichert.`,
            filename: savedFileName,
            location: targetDir || 'Ausgewählter Zielordner',
            formatLabel: format,
            bytesSize: bytes.byteLength,
          });
        } else {
          setIsExporting(false);
          return;
        }
      } else {
        // Browser fallback download: directly initiates file download
        const blob = new Blob([bytes as BlobPart], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = defaultName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        setSuccessMsgInfo({
          message: `Datei erfolgreich in den Browser-Downloadordner exportiert.`,
          filename: defaultName,
          location: 'Standard-Downloadordner Ihres Browsers (z. B. Downloads)',
          formatLabel: format,
          bytesSize: bytes.byteLength,
        });
      }

      onExportComplete?.({
        title: `Export erfolgreich (${format})`,
        operationType: 'EXPORT',
        description: `Master-Datei (${defaultName}) erfolgreich als ${format} exportiert. Die Originalquelle verbleibt unberührt.`,
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
    setShowLayerInspector(true);
  };

  const isDesktop = typeof window !== 'undefined' && Boolean(window.rekordboxDesktop);

  const audioFormatList: {
    id: AudioExportFormat;
    name: string;
    ext: string;
    desc: string;
    tag: string;
    color: string;
  }[] = [
    {
      id: 'WAV',
      name: 'WAV (PCM)',
      ext: '.wav',
      desc: 'Unkomprimierte Studioqualität (16-Bit / 44.1 kHz PCM)',
      tag: 'Studio Master',
      color: 'text-[#0088ff]',
    },
    {
      id: 'MP3',
      name: 'MP3 (MPEG-1 Layer 3)',
      ext: '.mp3',
      desc: 'High-Quality Audio (320 kbps CBR, universell kompatibel)',
      tag: 'Universal',
      color: 'text-[#10b981]',
    },
    {
      id: 'FLAC',
      name: 'FLAC (Lossless Codec)',
      ext: '.flac',
      desc: 'Verlustfreie Kompression (Studio-Standard & DJ-Softwares)',
      tag: 'Lossless HQ',
      color: 'text-[#00e5ff]',
    },
    {
      id: 'AAC',
      name: 'AAC / M4A (MPEG-4)',
      ext: '.m4a',
      desc: 'Advanced Audio Coding (Apple DJ Standard & rekordbox)',
      tag: 'AAC HQ',
      color: 'text-[#f59e0b]',
    },
    {
      id: 'OGG',
      name: 'OGG Vorbis',
      ext: '.ogg',
      desc: 'Open Source Audio Container mit hoher Effizienz',
      tag: 'Ogg Opus',
      color: 'text-[#ec4899]',
    },
    {
      id: 'WEBM',
      name: 'WebM Audio',
      ext: '.webm',
      desc: 'WebM Audio Container mit Opus Codec',
      tag: 'Web Standard',
      color: 'text-[#8b5cf6]',
    },
  ];

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-xs flex items-center justify-center z-50 select-none p-4">
      <div className="w-full max-w-xl bg-[#12141a] border border-[#272935] rounded-xs shadow-2xl overflow-hidden flex flex-col text-neutral-200 text-xs">
        {/* Header */}
        <div className="h-10 bg-[#171922] border-b border-[#252834] flex items-center justify-between px-3.5">
          <div className="flex items-center space-x-2">
            <Download size={16} className="text-[#0088ff]" />
            <span className="font-bold text-white text-xs tracking-wide">
              Master Audio & Rekordbox Export
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1 hover:text-white text-neutral-400 hover:bg-[#252834] rounded transition-colors"
          >
            <X size={15} />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 space-y-4 max-h-[80vh] overflow-y-auto">
          <div className="text-[11px] text-neutral-400 leading-relaxed flex items-center justify-between bg-[#0b0c10] p-2.5 rounded-xs border border-[#1e212b]">
            <div className="flex items-center space-x-2">
              <Info size={14} className="text-[#0088ff] flex-shrink-0" />
              <span>
                Wähle das Zielformat für den Export. Die Original-Audiodatei bleibt dabei 100% unberührt (Non-destructive).
              </span>
            </div>
          </div>

          {/* Section 1: Audio Formats */}
          <div className="space-y-2">
            <div className="text-[10.5px] font-bold text-neutral-300 uppercase tracking-wider flex items-center space-x-1.5">
              <FileAudio size={13} className="text-[#0088ff]" />
              <span>Gängige Audio-Exportformate</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {audioFormatList.map((item) => {
                const isSelected = format === item.id;
                return (
                  <div
                    key={item.id}
                    onClick={() => setFormat(item.id)}
                    className={`p-2.5 rounded-xs border cursor-pointer transition-all flex flex-col justify-between ${
                      isSelected
                        ? 'bg-[#182030] border-[#0088ff] text-white shadow-sm ring-1 ring-[#0088ff]/40'
                        : 'bg-[#0f1015] border-[#22242f] text-neutral-400 hover:bg-[#14161e] hover:border-[#2d3142]'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-bold text-xs text-white flex items-center space-x-1.5">
                        <span className={item.color}>•</span>
                        <span>{item.name}</span>
                      </span>
                      <span className="text-[9px] font-mono px-1.5 py-0.2 bg-[#1b202e] border border-[#2b3345] rounded text-neutral-300">
                        {item.tag}
                      </span>
                    </div>
                    <p className="text-[10px] text-neutral-400 leading-tight">
                      {item.desc}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Section 2: Library & Project Formats */}
          <div className="space-y-2 pt-1">
            <div className="text-[10.5px] font-bold text-neutral-300 uppercase tracking-wider flex items-center space-x-1.5">
              <FileCode size={13} className="text-[#10b981]" />
              <span>Metadaten & Rekordbox Projektformate</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div
                onClick={() => setFormat('XML')}
                className={`p-2.5 rounded-xs border cursor-pointer transition-all ${
                  format === 'XML'
                    ? 'bg-[#182030] border-[#0088ff] text-white ring-1 ring-[#0088ff]/40'
                    : 'bg-[#0f1015] border-[#22242f] text-neutral-400 hover:bg-[#14161e]'
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="font-bold text-xs text-white">Rekordbox XML</span>
                  <span className="text-[9px] font-mono px-1.5 py-0.2 bg-[#10b981]/20 text-[#34d399] border border-[#10b981]/30 rounded">
                    Pioneer DJ
                  </span>
                </div>
                <p className="text-[10px] text-neutral-400 leading-tight">
                  Beinhaltet Beatgrid, Memory Cues, Hot Cues & Loops.
                </p>
              </div>

              <div
                onClick={() => setFormat('JSON')}
                className={`p-2.5 rounded-xs border cursor-pointer transition-all ${
                  format === 'JSON'
                    ? 'bg-[#182030] border-[#0088ff] text-white ring-1 ring-[#0088ff]/40'
                    : 'bg-[#0f1015] border-[#22242f] text-neutral-400 hover:bg-[#14161e]'
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="font-bold text-xs text-white">Projektzustand (JSON)</span>
                  <span className="text-[9px] font-mono px-1.5 py-0.2 bg-[#8b5cf6]/20 text-[#c084fc] border border-[#8b5cf6]/30 rounded">
                    airdox JSON
                  </span>
                </div>
                <p className="text-[10px] text-neutral-400 leading-tight">
                  Vollständiges Backup der Schnittlisten & Cues.
                </p>
              </div>
            </div>
          </div>

          {/* Storage Location Information Box */}
          <div className="p-3 bg-[#0d0e13] border border-[#222634] rounded-xs text-[11px] space-y-1">
            <div className="flex items-center space-x-2 font-bold text-white">
              <HardDrive size={13} className="text-[#0088ff]" />
              <span>Speicherort & Zielverzeichnis</span>
            </div>
            <p className="text-neutral-400 text-[10.5px]">
              {isDesktop
                ? 'Desktop-App: Beim Klick auf Exportieren öffnet sich der native Dateidialog zum Auswählen des Ordners.'
                : 'Web-Browser: Die Datei wird direkt in den Standard-Downloadordner Ihres Browsers (z. B. Downloads) heruntergeladen.'}
            </p>
          </div>

          {/* Success Banner */}
          {successInfo && (
            <div className="p-3 bg-[#0e2718] border border-[#1b5e32] rounded-xs text-[#4ade80] text-[11px] space-y-1 animate-in fade-in duration-150">
              <div className="flex items-center space-x-2 font-bold text-[#4ade80]">
                <CheckCircle2 size={16} className="text-[#4ade80] flex-shrink-0" />
                <span>{successInfo.message}</span>
              </div>
              <div className="pl-6 space-y-0.5 text-[10.5px] text-[#a7f3d0] font-mono">
                <div>• <span className="font-bold">Dateiname:</span> {successInfo.filename}</div>
                <div>• <span className="font-bold">Speicherort:</span> {successInfo.location}</div>
                <div>
                  • <span className="font-bold">Format & Größe:</span> {successInfo.formatLabel}
                  {successInfo.bytesSize ? ` (${(successInfo.bytesSize / (1024 * 1024)).toFixed(2)} MB)` : ''}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="h-12 bg-[#151720] border-t border-[#232532] px-4 flex items-center justify-between">
          <button
            onClick={onClose}
            className="px-3.5 py-1.5 text-neutral-400 hover:text-white text-xs transition-colors rounded hover:bg-[#202534]"
          >
            Abbrechen
          </button>

          <div className="flex items-center space-x-2.5">
            <button
              onClick={handleStartRenderFlow}
              disabled={isExporting}
              className="px-3.5 py-1.5 bg-[#1a2233] hover:bg-[#222c42] text-[#00a2ff] border border-[#2b3a54] rounded-xs font-semibold text-xs flex items-center space-x-1.5 transition-colors disabled:opacity-50"
              title="Öffnet den visuellen Schichten-Inspektor zur Timeline-Analyse vor dem Speichern"
            >
              <Layers size={13} className="text-[#00e5ff]" />
              <span>Schichten anzeigen</span>
            </button>

            <button
              onClick={triggerActualDownload}
              disabled={isExporting}
              className="px-4 py-1.5 bg-[#0088ff] hover:bg-[#0070d6] text-white rounded-xs font-bold text-xs flex items-center space-x-1.5 transition-colors disabled:opacity-50 shadow-md hover:shadow-[#0088ff]/25 cursor-pointer"
            >
              <Download size={13} />
              <span>{isExporting ? 'Exportiere...' : `${format} jetzt exportieren & speichern`}</span>
            </button>
          </div>
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
