/**
 * Eingabequelle eines Fern-Jobs: Container, Endung und Geometrie.
 *
 * Warum diese Datei existiert
 * ---------------------------
 * Der Fernpfad hat lange angenommen, die Arbeitskopie sei **immer** eine vom
 * Renderer gerenderte 32-Bit-Float-WAV. Das ist teuer: ein 4-Minuten-Track wird
 * dabei zu ~130 MB, die über Google Drive synchronisiert werden müssen, obwohl
 * dieselbe Musik als FLAC bereits mit ~40 MB auf der Platte liegt.
 *
 * Deshalb darf die Arbeitskopie jetzt **bitgenau die Originaldatei** sein
 * (`fs.copyFile`, keine Neukodierung) – und dafür muss der Editor zwei Dinge
 * können, die er vorher nicht brauchte:
 *
 *   1. die Endung der Quelle behalten (`.flac` bleibt `.flac`), damit der
 *      Colab-Worker einen ehrlichen Container vorfindet, und
 *   2. die Geometrie (Samplerate, Kanäle, Dauer) aus dem Container lesen statt
 *      aus einem RIFF-Header – sonst steht im Manifest eine erfundene Dauer und
 *      die Längenprüfung der Ergebnisse (§34 J) schlägt fehl.
 *
 * Bewusst keine Dekodierung: hier werden nur Kopfbytes gelesen. FLAC trägt in
 * STREAMINFO die exakte Sample-Anzahl, WAV im data-Chunk die exakte Byte-Zahl –
 * beides reicht für eine exakte Dauer, ohne auch nur ein Sample zu entpacken.
 */
import path from 'node:path';
import { parseWavLayout } from '../wavIo';

/** Container, die der Worker nativ lädt (`colab/remote_worker.py::load_input_track`). */
export const REMOTE_INPUT_EXTENSIONS = ['.flac', '.wav', '.mp3', '.aif', '.aiff'] as const;

export type RemoteInputExtension = (typeof REMOTE_INPUT_EXTENSIONS)[number];

export type RemoteInputContainer = 'wav' | 'flac' | 'unknown';

export interface AudioGeometry {
  container: RemoteInputContainer;
  sampleRate: number;
  channels: number;
  /** Exakte Sample-Anzahl pro Kanal; 0, wenn der Container sie nicht verrät. */
  frames: number;
  durationSeconds: number;
}

export function isSupportedInputExtension(extension: string): extension is RemoteInputExtension {
  return (REMOTE_INPUT_EXTENSIONS as readonly string[]).includes(extension.toLowerCase());
}

/**
 * Macht aus einem beliebigen Dateinamen eine sichere Arbeitskopie-Endung.
 * Unbekanntes fällt auf `.wav` zurück – nicht auf „keine Endung“, denn der
 * Worker sucht seine Eingabe über die Endung.
 */
export function inputExtensionFor(fileNameOrPath: string): RemoteInputExtension {
  const extension = path.extname(String(fileNameOrPath ?? '')).toLowerCase();
  return isSupportedInputExtension(extension) ? extension : '.wav';
}

/** Menschlicher Container-Name für Manifest und Laufzettel. */
export function containerLabel(extension: string): string {
  switch (extension.toLowerCase()) {
    case '.flac':
      return 'FLAC';
    case '.mp3':
      return 'MP3';
    case '.aif':
    case '.aiff':
      return 'AIFF';
    case '.wav':
      return 'WAV';
    default:
      return extension.replace('.', '').toUpperCase() || 'AUDIO';
  }
}

/** Wie viel Kopfbytes zum Bestimmen der Geometrie gelesen werden. */
export const AUDIO_HEADER_READ_BYTES = 64 * 1024;

/**
 * Liest FLAC-STREAMINFO (Metadatenblock Typ 0).
 *
 * Layout hinter „fLaC“ + Blockkopf: 16/16 Bit Blockgrößen, 24/24 Bit
 * Framegrößen, dann **64 Bit gepackt**: 20 Bit Samplerate, 3 Bit (Kanäle − 1),
 * 5 Bit (Bits pro Sample − 1), 36 Bit Sample-Anzahl. Genau diese 36 Bit sind
 * der Grund, FLAC durchzuschleifen: die Dauer ist exakt, ohne zu dekodieren.
 */
export function parseFlacStreamInfo(head: Uint8Array): AudioGeometry | null {
  if (head.length < 4) return null;
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const magic = String.fromCharCode(head[0], head[1], head[2], head[3]);
  if (magic !== 'fLaC') return null;

  let offset = 4;
  while (offset + 4 <= head.length) {
    const headerByte = head[offset];
    const isLast = (headerByte & 0x80) !== 0;
    const blockType = headerByte & 0x7f;
    const blockSize = (head[offset + 1] << 16) | (head[offset + 2] << 8) | head[offset + 3];
    const body = offset + 4;
    if (blockType === 0) {
      if (body + 18 > head.length) return null;
      // 8 gepackte Bytes ab body+10 tragen Samplerate/Kanäle/Bittiefe/Länge.
      const packed =
        Number(view.getUint32(body + 10, false)) * 2 ** 32 + view.getUint32(body + 14, false);
      const sampleRate = Math.floor(packed / 2 ** 44);
      const channels = (Math.floor(packed / 2 ** 41) & 0x7) + 1;
      const frames = packed % 2 ** 36;
      if (!Number.isFinite(sampleRate) || sampleRate <= 0) return null;
      return {
        container: 'flac',
        sampleRate,
        channels,
        frames,
        durationSeconds: sampleRate > 0 ? frames / sampleRate : 0,
      };
    }
    if (isLast) return null;
    offset = body + blockSize;
  }
  return null;
}

/**
 * Geometrie einer Datei aus ihren Kopfbytes.
 *
 * `fileSize` ist die **echte** Dateigröße: ein WAV-Header darf eine größere
 * Datenlänge behaupten, als vorhanden ist (abgeschnittene Datei), und wir
 * lesen nur einen Kopf-Ausschnitt – die Dauer muss trotzdem stimmen.
 */
export function parseAudioGeometry(head: Uint8Array, fileSize: number, fileName: string): AudioGeometry {
  const flac = parseFlacStreamInfo(head);
  if (flac) return flac;

  try {
    // Der Kopf-Ausschnitt darf die Datenlänge nicht verkürzen: die echte
    // Dateigröße entscheidet, sonst stimmt die Dauer im Manifest nicht.
    const layout = parseWavLayout(head, fileSize);
    const bytesPerFrame = Math.max(1, layout.blockAlign);
    const dataBytes = Math.min(layout.dataSize, Math.max(0, fileSize - layout.dataOffset));
    const frames = Math.floor(dataBytes / bytesPerFrame);
    return {
      container: 'wav',
      sampleRate: layout.sampleRate,
      channels: layout.channels,
      frames,
      durationSeconds: layout.sampleRate > 0 ? frames / layout.sampleRate : 0,
    };
  } catch {
    // MP3/AIFF/u. a.: kein Kopf, den wir hier ehrlich auslegen könnten. Dauer
    // und Geometrie bleiben 0 – der Worker meldet die echten Werte zurück, und
    // die Längenprüfung greift erst ab einem bekannten Erwartungswert.
    return { container: 'unknown', sampleRate: 0, channels: 0, frames: 0, durationSeconds: 0 };
  }
}

/**
 * Erwartete Geometrie der **Ergebnisse**.
 *
 * Die Engine normalisiert jede Eingabe vor der Inferenz auf 44,1 kHz Stereo
 * (`src/stems/preprocessor.ts`: `TARGET_SAMPLE_RATE`/`TARGET_CHANNELS`) und der
 * Python-Adapter schreibt seine Stems mit der Modell-Samplerate. Beide liefern
 * also 44,1 kHz/2 – unabhängig davon, ob die Arbeitskopie eine 48-kHz-FLAC oder
 * eine WAV war. Diese Konstante ist deshalb bewusst **nicht** die
 * Eingabe-Geometrie: sie ist der Maßstab, an dem `§34 J` die Ergebnisse misst.
 */
export const ENGINE_OUTPUT_SAMPLE_RATE = 44100;
export const ENGINE_OUTPUT_CHANNELS = 2;
