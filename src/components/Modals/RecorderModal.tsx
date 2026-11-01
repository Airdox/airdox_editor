import React from 'react';
import { isAudioExportFormatSupported as exportSupported } from '../../audio/audioExporter';
import {
  Activity,
  CheckCircle2,
  CircleStop,
  FileAudio,
  Gauge,
  Headphones,
  Mic2,
  Radio,
  ShieldCheck,
  Timer,
  X,
} from 'lucide-react';

export type RecorderSource = 'EDITOR_MASTER' | 'AUDIO_INPUT' | 'SYSTEM_LOOPBACK';
export type RecorderFormat = 'WAV' | 'FLAC' | 'MP3' | 'WEBM';
export type RecorderStage = 'IDLE' | 'PREROLL' | 'RECORDING' | 'OPTIMIZING' | 'SAVING' | 'DONE' | 'ERROR';

interface RecorderModalProps {
  isOpen: boolean;
  onClose: () => void;
  stage: RecorderStage;
  elapsed: number;
  source: RecorderSource;
  onSetSource: (source: RecorderSource) => void;
  format: RecorderFormat;
  onSetFormat: (format: RecorderFormat) => void;
  sampleRate: 44100 | 48000;
  onSetSampleRate: (rate: 44100 | 48000) => void;
  bitDepth: 16 | 24 | 32;
  onSetBitDepth: (depth: 16 | 24 | 32) => void;
  channels: 'STEREO' | 'MONO';
  onSetChannels: (channels: 'STEREO' | 'MONO') => void;
  limiter: boolean;
  onSetLimiter: (enabled: boolean) => void;
  optimize: boolean;
  onSetOptimize: (enabled: boolean) => void;
  targetLufs: -14 | -12 | -9;
  onSetTargetLufs: (value: -14 | -12 | -9) => void;
  truePeak: -1 | -0.3;
  onSetTruePeak: (value: -1 | -0.3) => void;
  preRoll: 0 | 3 | 5;
  onSetPreRoll: (value: 0 | 3 | 5) => void;
  fileName: string;
  onSetFileName: (name: string) => void;
  onStart: () => void;
  onStop: () => void;
  error: string | null;
  savedPath: string | null;
  stats?: { beforeLufs: number; afterLufs: number; peak: number; duration: number } | null;
}

const formatTime = (seconds: number) => {
  const safe = Math.max(0, Math.floor(seconds));
  return `${Math.floor(safe / 3600).toString().padStart(2, '0')}:${Math.floor((safe % 3600) / 60).toString().padStart(2, '0')}:${(safe % 60).toString().padStart(2, '0')}`;
};

const sourceItems: Array<{ id: RecorderSource; label: string; description: string; icon: React.ReactNode }> = [
  { id: 'EDITOR_MASTER', label: 'Editor Master', description: 'Post-Limiter-Signal aus airdox', icon: <Headphones size={15} /> },
  { id: 'SYSTEM_LOOPBACK', label: 'Rekordbox / System Loopback', description: 'Windows-Systemmix nach Freigabe erfassen', icon: <Radio size={15} /> },
  { id: 'AUDIO_INPUT', label: 'Mikrofon / Line-In', description: 'Audioeingang des Systems', icon: <Mic2 size={15} /> },
];

export const RecorderModal: React.FC<RecorderModalProps> = ({
  isOpen,
  onClose,
  stage,
  elapsed,
  source,
  onSetSource,
  format,
  onSetFormat,
  sampleRate,
  onSetSampleRate,
  bitDepth,
  onSetBitDepth,
  channels,
  onSetChannels,
  limiter,
  onSetLimiter,
  optimize,
  onSetOptimize,
  targetLufs,
  onSetTargetLufs,
  truePeak,
  onSetTruePeak,
  preRoll,
  onSetPreRoll,
  fileName,
  onSetFileName,
  onStart,
  onStop,
  error,
  savedPath,
  stats,
}) => {
  const [meter, setMeter] = React.useState({ peak: 0, rms: 0 });
  const [formats, setFormats] = React.useState<string[]>([]);
  React.useEffect(() => { void window.airdoxRecorder?.formats().then(setFormats).catch(() => setFormats(['WEBM'])); }, []);
  const isAudioExportFormatSupported = (value: RecorderFormat) => window.airdoxRecorder ? formats.includes(value) && typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('audio/webm;codecs=opus') : exportSupported(value);
  const [devices, setDevices] = React.useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = React.useState(() => typeof localStorage === 'undefined' ? '' : localStorage.getItem('airdox.recorderInput') || '');
  const [deviceError, setDeviceError] = React.useState('');
  React.useEffect(() => {
    const listener = (event: Event) => setMeter((event as CustomEvent<{ peak: number; rms: number }>).detail);
    window.addEventListener('airdox-recorder-meter', listener);
    return () => window.removeEventListener('airdox-recorder-meter', listener);
  }, []);
  if (!isOpen) return null;
  const busy = stage === 'PREROLL' || stage === 'RECORDING' || stage === 'OPTIMIZING' || stage === 'SAVING';
  const canEdit = !busy;
  const isDone = stage === 'DONE';

  return (
    <div className={stage === 'RECORDING' ? 'fixed bottom-4 right-4 z-[120] w-[420px] max-w-[95vw] select-none' : 'fixed inset-0 bg-black/75 backdrop-blur-sm flex items-center justify-center z-[120] p-4 select-none'}>
      <div className="w-full max-w-2xl bg-[#111319] border border-[#303441] rounded-md shadow-[0_20px_80px_rgba(0,0,0,.65)] overflow-hidden text-neutral-200">
        <div className="h-12 px-5 bg-gradient-to-r from-[#1b1e29] to-[#151720] border-b border-[#2a2e3a] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={`w-8 h-8 rounded-full flex items-center justify-center ${busy ? 'bg-[#ff3b30]/20 text-[#ff5147] animate-pulse' : 'bg-[#0088ff]/15 text-[#00a2ff]'}`}>
              <CircleStop size={18} />
            </div>
            <div>
              <div className="text-sm font-bold text-white tracking-wide">PRO RECORDER</div>
              <div className="text-[10px] text-neutral-500">Set-Aufnahme · {source === 'SYSTEM_LOOPBACK' ? 'Systemaudio' : source === 'AUDIO_INPUT' ? 'Audiointerface' : 'Editor Master'} · {format}</div>
            </div>
          </div>
          <button onClick={onClose} disabled={busy} className="p-1.5 text-neutral-400 hover:text-white hover:bg-[#2b2e3a] rounded disabled:opacity-30" title="Recorder schließen">
            <X size={16} />
          </button>
        </div>

        <div className="p-5 space-y-4 max-h-[78vh] overflow-y-auto">
          <div className="flex items-center justify-between rounded-md bg-[#0b0d12] border border-[#252936] px-4 py-3">
            <div className="flex items-center gap-3">
              <div className={`w-2.5 h-2.5 rounded-full ${stage === 'RECORDING' ? 'bg-[#ff3b30] shadow-[0_0_12px_#ff3b30]' : isDone ? 'bg-[#00c853]' : 'bg-[#4b5160]'}`} />
              <div>
                <div className="text-[10px] uppercase tracking-[.16em] text-neutral-500">Status</div>
                <div className="text-xs font-semibold text-white">
                  {stage === 'IDLE' && 'Bereit für die Aufnahme'}
                  {stage === 'PREROLL' && `Start in ${preRoll} Sekunden…`}
                  {stage === 'RECORDING' && 'Aufnahme läuft'}
                  {stage === 'OPTIMIZING' && 'Gesamtes Set wird optimiert…'}
                  {stage === 'SAVING' && 'Datei wird gespeichert…'}
                  {stage === 'DONE' && 'Set erfolgreich gespeichert'}
                  {stage === 'ERROR' && 'Aufnahme konnte nicht abgeschlossen werden'}
                </div>
              </div>
            </div>
            <div className={`font-mono text-2xl tabular-nums ${stage === 'RECORDING' ? 'text-[#ff5147]' : 'text-neutral-300'}`}>{formatTime(elapsed)}</div>
          </div>

          {error && <div className="rounded border border-[#ff3b30]/40 bg-[#3a1517] px-3 py-2 text-[11px] text-[#ffaaa5]">{error}</div>}
          {savedPath && (
            <div className="rounded border border-[#00c853]/30 bg-[#0d281b] px-3 py-2 text-[11px] text-[#8af0b1] flex gap-2 items-start">
              <CheckCircle2 size={15} className="shrink-0 mt-0.5" />
              <span className="break-all"><b>{stage === 'RECORDING' ? 'Laufende Sicherung:' : 'Gespeichert:'}</b> {savedPath}{stage === 'DONE' && window.rekordboxDesktop && <button onClick={() => void window.rekordboxDesktop?.openPath(savedPath)} className="block mt-2 underline">Aufnahme öffnen / abspielen</button>}</span>
            </div>
          )}

          {stage === 'RECORDING' && <div className="rounded border border-[#252936] bg-[#0b0d12] p-3" aria-label="Aufnahmepegel">
            <div className="flex justify-between text-xs mb-2"><span>{meter.peak < 0.0001 ? 'Kein Signal – Routing prüfen' : meter.peak >= 0.99 ? 'Übersteuerung' : 'Eingangssignal aktiv'}</span><span>{(20 * Math.log10(Math.max(meter.peak, 0.00001))).toFixed(1)} dBFS</span></div>
            <meter min={0} max={1} value={meter.rms} className="w-full h-4" />
          </div>}
          <section className={stage === 'RECORDING' ? 'hidden' : 'space-y-2'}>
            {source === 'AUDIO_INPUT' && <div className="space-y-2">
              <button disabled={!canEdit} onClick={async () => {
                try {
                  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                  stream.getTracks().forEach((track) => track.stop());
                  setDevices((await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'audioinput'));
                  setDeviceError('');
                } catch (error) { setDeviceError(String(error)); }
              }} className="text-xs text-blue-300">Audioeingänge erkennen</button>
              <select aria-label="Audioeingang" disabled={!canEdit} value={deviceId} onChange={(event) => {
                setDeviceId(event.target.value); localStorage.setItem('airdox.recorderInput', event.target.value);
              }} className="w-full bg-[#171a22] p-2 text-xs"><option value="">System-Standardeingang</option>{devices.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label || device.deviceId}</option>)}</select>
              {deviceError && <p role="alert" className="text-xs text-red-300">{deviceError}</p>}
            </div>}
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-[.14em] text-neutral-500"><Activity size={13} /> Signalquelle</div>
            <div className="grid grid-cols-3 gap-2">
              {sourceItems.map((item) => (
                <button key={item.id} disabled={!canEdit} onClick={() => onSetSource(item.id)} className={`text-left p-3 rounded border transition-colors ${source === item.id ? 'border-[#0088ff] bg-[#0b2540] text-white' : 'border-[#282c38] bg-[#171a22] text-neutral-400 hover:border-[#4b5365]'} disabled:opacity-45`}>
                  <div className="flex items-center gap-2 mb-1.5">{item.icon}<span className="text-[11px] font-bold">{item.label}</span></div>
                  <div className="text-[9px] leading-snug text-neutral-500">{item.description}</div>
                </button>
              ))}
            </div>
            {source === 'SYSTEM_LOOPBACK' && <div className="text-[10px] text-[#9bb8d5] bg-[#102030] border border-[#1d466b] rounded px-3 py-2">Bestätige beim Start die Systemaudio-Freigabe. Erfasst auch andere Systemtöne. Rekordbox mit exklusivem ASIO-Ausgang benötigt einen Treiber-Loopback oder Line-Eingang unter Audioeingang. Prüfe den Pegel vor dem Set.</div>}
          </section>

          <section className={stage === 'RECORDING' ? 'hidden' : 'grid grid-cols-2 gap-4 border-t border-[#242834] pt-4'}>
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-[10px] uppercase tracking-[.14em] text-neutral-500"><FileAudio size={13} /> Dateiformat</div>
              <div className="grid grid-cols-3 gap-1.5">
                {(['WAV', 'FLAC', 'MP3', 'WEBM'] as RecorderFormat[]).map((item) => {
                  const isSupported = isAudioExportFormatSupported(item);
                  return (
                    <button
                      key={item}
                      disabled={!canEdit || !isSupported}
                      aria-disabled={!isSupported}
                      title={isSupported ? undefined : `${item}-Export ist derzeit nicht verfügbar; bitte WAV wählen.`}
                      onClick={() => onSetFormat(item)}
                      className={`py-2 rounded border text-[11px] font-bold ${format === item ? 'border-[#00a2ff] bg-[#09233b] text-white' : 'border-[#2a2e39] bg-[#171a22] text-neutral-500 hover:text-neutral-200'} disabled:opacity-45 disabled:cursor-not-allowed`}
                    >
                      {item}{!isSupported && <span className="block text-[8px] font-normal">nicht verfügbar</span>}
                    </button>
                  );
                })}
              </div>
              <p className="text-[9px] leading-snug text-amber-300/80">
                Desktop: Aufnahme wird laufend unter Musik / AirDox Recordings gesichert. WebM/Opus: ca. 144 MB/h; Samplerate und Kanäle bestimmt die Quelle. WAV, MP3 und FLAC benötigen FFmpeg und werden nach Stop konvertiert. Die Opus-Sicherung bleibt erhalten. Keine nachträgliche Lautheitsanpassung im Streaming-Modus.
              </p>
              <div className="grid grid-cols-2 gap-2">
                <label className="text-[10px] text-neutral-500">Samplerate<select disabled={!canEdit} value={sampleRate} onChange={(e) => onSetSampleRate(Number(e.target.value) as 44100 | 48000)} className="mt-1 w-full bg-[#0c0e13] border border-[#2a2e39] rounded px-2 py-1.5 text-xs text-neutral-200"><option value={48000}>48 kHz</option><option value={44100}>44.1 kHz</option></select></label>
                <label className="text-[10px] text-neutral-500">Bit-Tiefe<select disabled={!canEdit || format === 'MP3'} value={bitDepth} onChange={(e) => onSetBitDepth(Number(e.target.value) as 16 | 24 | 32)} className="mt-1 w-full bg-[#0c0e13] border border-[#2a2e39] rounded px-2 py-1.5 text-xs text-neutral-200"><option value={24}>24 Bit</option><option value={16}>16 Bit</option><option value={32}>32 Bit Float</option></select></label>
              </div>
              <label className="text-[10px] text-neutral-500">Kanäle<select disabled={!canEdit} value={channels} onChange={(e) => onSetChannels(e.target.value as 'STEREO' | 'MONO')} className="mt-1 w-full bg-[#0c0e13] border border-[#2a2e39] rounded px-2 py-1.5 text-xs text-neutral-200"><option value="STEREO">Stereo</option><option value="MONO">Mono</option></select></label>
            </div>

            <div className="space-y-3">
              <div className="flex items-center gap-2 text-[10px] uppercase tracking-[.14em] text-neutral-500"><Gauge size={13} /> Mastering</div>
              <Toggle label="Eingangs-Limiter" detail="Dynamikkompressor · kein garantierter True-Peak-Grenzwert" checked={limiter} disabled={!canEdit} onChange={onSetLimiter} />
              <Toggle label="Set-Loudness optimieren" detail={window.airdoxRecorder ? 'Streaming: keine nachträgliche Lautheitsanpassung' : 'Gesamtdatei · RMS-basierte Schätzung'} checked={window.airdoxRecorder ? false : optimize} disabled={!canEdit || Boolean(window.airdoxRecorder)} onChange={onSetOptimize} />
              <div className="grid grid-cols-2 gap-2">
                <label className="text-[10px] text-neutral-500">Ziel-Lautheit<select disabled={!canEdit || !optimize} value={targetLufs} onChange={(e) => onSetTargetLufs(Number(e.target.value) as -14 | -12 | -9)} className="mt-1 w-full bg-[#0c0e13] border border-[#2a2e39] rounded px-2 py-1.5 text-xs text-neutral-200"><option value={-14}>-14 LUFS</option><option value={-12}>-12 LUFS</option><option value={-9}>-9 LUFS</option></select></label>
                <label className="text-[10px] text-neutral-500">Ceiling<select disabled={!canEdit || !optimize} value={truePeak} onChange={(e) => onSetTruePeak(Number(e.target.value) as -1 | -0.3)} className="mt-1 w-full bg-[#0c0e13] border border-[#2a2e39] rounded px-2 py-1.5 text-xs text-neutral-200"><option value={-1}>-1.0 dBTP</option><option value={-0.3}>-0.3 dBTP</option></select></label>
              </div>
              <label className="flex items-center gap-2 text-[10px] text-neutral-400"><Timer size={13} className="text-[#00a2ff]" /> Vorlauf<select disabled={!canEdit} value={preRoll} onChange={(e) => onSetPreRoll(Number(e.target.value) as 0 | 3 | 5)} className="ml-auto bg-[#0c0e13] border border-[#2a2e39] rounded px-2 py-1 text-xs text-neutral-200"><option value={0}>Aus</option><option value={3}>3 s</option><option value={5}>5 s</option></select></label>
            </div>
          </section>

          <section className={stage === 'RECORDING' ? 'hidden' : 'border-t border-[#242834] pt-4 space-y-2'}>
            <div className="text-[10px] uppercase tracking-[.14em] text-neutral-500">Zieldatei</div>
            <div className="flex gap-2">
              <input disabled={!canEdit} value={fileName} onChange={(e) => onSetFileName(e.target.value)} className="flex-1 bg-[#0c0e13] border border-[#2a2e39] rounded px-3 py-2 text-xs text-white placeholder:text-neutral-600" placeholder="mein_rekordbox_set" />
              <div className="px-3 py-2 bg-[#181b24] border border-[#2a2e39] rounded text-xs text-neutral-400 self-stretch flex items-center">.{format.toLowerCase()}</div>
            </div>
          </section>

          {stats && stage === 'DONE' && (
            <div className="grid grid-cols-4 gap-2 text-center border-t border-[#242834] pt-4">
              <Metric label="Dauer" value={formatTime(stats.duration)} />
              <Metric label="Vorher (≈ LUFS)" value={stats.beforeLufs.toFixed(1)} />
              <Metric label="Nachher (≈ LUFS)" value={stats.afterLufs.toFixed(1)} />
              <Metric label="Peak" value={`${stats.peak.toFixed(1)} dBTP`} />
            </div>
          )}
        </div>

        <div className="px-5 py-4 bg-[#151821] border-t border-[#2a2e3a] flex items-center justify-between">
          <div className="text-[10px] text-neutral-500 max-w-[55%] flex gap-1.5 items-center"><ShieldCheck size={13} className="text-[#00c853] shrink-0" />{window.airdoxRecorder ? 'Automatische Sicherung jede Sekunde. Stop beendet und speichert das Set.' : 'Originaldateien bleiben unverändert. WAV wird nach Stop gespeichert.'}</div>
          <div className="flex gap-2">
            {stage === 'PREROLL' && <button onClick={onStop} className="px-3 py-2 text-xs text-red-300">Start abbrechen</button>}
            {isDone ? <button onClick={onClose} className="px-4 py-2 rounded bg-[#2a2e3a] hover:bg-[#383d4b] text-xs text-white">Schließen</button> : <button onClick={onClose} disabled={busy} className="px-4 py-2 rounded text-xs text-neutral-400 hover:text-white disabled:opacity-40">Abbrechen</button>}
            {stage === 'RECORDING' ? <button onClick={onStop} className="px-5 py-2 rounded bg-[#c92727] hover:bg-[#e23636] text-white text-xs font-bold flex items-center gap-2"><CircleStop size={14} /> Aufnahme stoppen</button> : <button onClick={onStart} disabled={busy || stage === 'DONE' || !isAudioExportFormatSupported(format)} title={!isAudioExportFormatSupported(format) ? 'Dieses Aufnahmeformat ist derzeit nicht verfügbar; bitte WAV wählen.' : undefined} className="px-5 py-2 rounded bg-[#0088ff] hover:bg-[#1595ff] disabled:opacity-40 text-white text-xs font-bold flex items-center gap-2"><CircleStop size={14} />{stage === 'PREROLL' ? 'Vorbereiten…' : 'Aufnahme starten'}</button>}
          </div>
        </div>
      </div>
    </div>
  );
};

const Toggle: React.FC<{ label: string; detail: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }> = ({ label, detail, checked, disabled, onChange }) => (
  <label className={`flex items-center justify-between gap-2 p-2 rounded border border-[#292d39] bg-[#171a22] ${disabled ? 'opacity-45' : 'cursor-pointer'}`}>
    <span><span className="block text-[11px] font-semibold text-neutral-200">{label}</span><span className="block text-[9px] text-neutral-500">{detail}</span></span>
    <input type="checkbox" disabled={disabled} checked={checked} onChange={(e) => onChange(e.target.checked)} className="accent-[#0088ff]" />
  </label>
);

const Metric: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="rounded bg-[#0d1016] border border-[#252936] py-2"><div className="text-[9px] text-neutral-600">{label}</div><div className="font-mono text-[11px] text-neutral-200 mt-1">{value}</div></div>
);
