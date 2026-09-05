/**
 * @license
 * Airdox_intelligents_Editor – Dateizugriff für Projekt und Exporte
 *
 * Eine Schnittstelle, zwei Umgebungen: In der Desktop-App fragt die App den
 * Betriebssystemdialog über die Electron-Brücke. Im Browser (Vite-Vorschau) wird,
 * wenn vorhanden, die File System Access API genutzt, sonst Download bzw.
 * Datei-Eingabefeld. Der Aufrufer im Editor merkt sich keinen Unterschied.
 *
 * Geschrieben wird ausschließlich an Orte, die der Mensch im Dialog bestätigt hat.
 */

import { PROJECT_EXTENSION, projectFileName } from './projectFormat';

export type SaveKind = 'project' | 'wav' | 'xml' | 'text';

export interface SaveChoice {
  /** Absoluter Pfad in der Desktop-App, Dateiname im Browser. */
  target: string;
  kind: 'desktop' | 'browser-handle';
}

export interface WrittenFile {
  target: string;
  bytes: number;
  channel: 'desktop' | 'browser-download' | 'browser-handle';
}

export interface OpenedText {
  source: string;
  text: string;
}

type DesktopBridge = NonNullable<Window['rekordboxDesktop']>;

export function desktopBridge(): DesktopBridge | undefined {
  return typeof window === 'undefined' ? undefined : window.rekordboxDesktop;
}

export function isDesktopShell(): boolean {
  return desktopBridge() !== undefined;
}

/** Vorschau, wo eine Datei landen würde – für die Statuszeile der Dialoge. */
export function describeSaveMode(): string {
  return isDesktopShell()
    ? 'Desktop: Systemdialog, Schreiben nur an den bestätigten Ort'
    : 'Browser: Download bzw. File System Access API';
}

function sanitizeName(name: string, kind: SaveKind): string {
  const base = name && name.trim().length > 0 ? name.trim() : 'projekt';
  if (kind === 'project') return projectFileName(base);
  const cleaned = base.replace(/[\\/:*?"<>|]+/g, '_');
  const extension = kind === 'wav' ? '.wav' : kind === 'xml' ? '.xml' : '.txt';
  return cleaned.toLowerCase().endsWith(extension) ? cleaned : `${cleaned}${extension}`;
}

async function pickSaveTargetDesktop(fileName: string, kind: SaveKind): Promise<string | null> {
  const bridge = desktopBridge();
  if (!bridge?.chooseSavePath) return null;
  const choice = await bridge.chooseSavePath({ kind, suggestedName: fileName });
  if (!choice || choice.canceled || !choice.filePath) return null;
  return choice.filePath;
}

async function writeDesktopFile(filePath: string, data: string, encoding: 'utf8' | 'base64'): Promise<number> {
  const bridge = desktopBridge();
  if (!bridge?.writeFile) throw new Error('Die Desktop-Bridge ist nicht verfügbar.');
  const result = await bridge.writeFile({ filePath, data, encoding });
  return result.bytes;
}

async function pickSaveTargetBrowserHandle(fileName: string): Promise<FileSystemFileHandle | null> {
  const picker = (window as unknown as { showSaveFilePicker?: (opts: object) => Promise<FileSystemFileHandle> })
    .showSaveFilePicker;
  if (typeof picker !== 'function') return null;
  try {
    return await picker({
      suggestedName: fileName,
      types: [
        {
          description: 'Airdox-Datei',
          accept: fileName.endsWith('.wav')
            ? { 'audio/wav': ['.wav'] }
            : fileName.endsWith('.xml')
              ? { 'application/xml': ['.xml'] }
              : { 'application/json': ['.json', `.${PROJECT_EXTENSION}`] },
        },
      ],
    });
  } catch (err) {
    // Abbruch im Dialog ist kein Fehler.
    if ((err as DOMException)?.name === 'AbortError') return null;
    throw err;
  }
}

function browserDownload(fileName: string, data: Uint8Array | string): void {
  const blob =
    typeof data === 'string'
      ? new Blob([data], { type: 'text/plain;charset=utf-8' })
      : new Blob([data as unknown as BlobPart], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/**
 * Text (Projekt, XML, Log) speichern. Liefert null, wenn der Mensch abbricht.
 */
export async function saveTextFile(options: {
  suggestedName: string;
  text: string;
  kind?: SaveKind;
}): Promise<WrittenFile | null> {
  const kind = options.kind ?? 'project';
  const fileName = sanitizeName(options.suggestedName, kind);

  if (isDesktopShell()) {
    const target = await pickSaveTargetDesktop(fileName, kind);
    if (!target) return null;
    const bytes = await writeDesktopFile(target, options.text, 'utf8');
    return { target, bytes, channel: 'desktop' };
  }

  const handle = await pickSaveTargetBrowserHandle(fileName);
  if (handle) {
    const writable = await handle.createWritable();
    await writable.write(new Blob([options.text], { type: 'text/plain;charset=utf-8' }));
    await writable.close();
    return { target: handle.name || fileName, bytes: options.text.length, channel: 'browser-handle' };
  }

  browserDownload(fileName, options.text);
  return { target: fileName, bytes: options.text.length, channel: 'browser-download' };
}

/** Binärdaten (WAV) speichern. */
export async function saveBinaryFile(options: {
  suggestedName: string;
  bytes: Uint8Array;
  kind?: SaveKind;
}): Promise<WrittenFile | null> {
  const kind = options.kind ?? 'wav';
  const fileName = sanitizeName(options.suggestedName, kind);

  if (isDesktopShell()) {
    const target = await pickSaveTargetDesktop(fileName, kind);
    if (!target) return null;
    const bytes = await writeDesktopFile(target, toBase64(options.bytes), 'base64');
    return { target, bytes, channel: 'desktop' };
  }

  const handle = await pickSaveTargetBrowserHandle(fileName);
  if (handle) {
    const writable = await handle.createWritable();
    await writable.write(new Blob([options.bytes as unknown as BlobPart], { type: 'audio/wav' }));
    await writable.close();
    return { target: handle.name || fileName, bytes: options.bytes.length, channel: 'browser-handle' };
  }

  browserDownload(fileName, options.bytes);
  return { target: fileName, bytes: options.bytes.length, channel: 'browser-download' };
}

/**
 * Mehrere Dateien in einen Ordner schreiben (Clips als einzelne WAVs). In der
 * Desktop-App wird der Ordner einmal bestätigt; im Browser entstehen Downloads.
 */
export async function saveFileSetToDirectory(options: {
  files: Array<{ name: string; bytes: Uint8Array }>;
  directoryTitle?: string;
}): Promise<{ directory: string | null; written: WrittenFile[] }> {
  const bridge = desktopBridge();
  if (bridge?.chooseDirectory && bridge.writeMany) {
    const choice = await bridge.chooseDirectory({ title: options.directoryTitle ?? 'Zielordner für die Dateien' });
    if (!choice || choice.canceled || !choice.directory) return { directory: null, written: [] };
    const result = await bridge.writeMany({
      directory: choice.directory,
      files: options.files.map((file) => ({ name: file.name, data: toBase64(file.bytes), encoding: 'base64' as const })),
    });
    return {
      directory: result.directory,
      written: result.written.map((entry) => ({ target: entry.filePath, bytes: entry.bytes, channel: 'desktop' as const })),
    };
  }

  const written: WrittenFile[] = [];
  for (const file of options.files) {
    browserDownload(file.name, file.bytes);
    written.push({ target: file.name, bytes: file.bytes.length, channel: 'browser-download' });
  }
  return { directory: null, written };
}

/** Projektdatei auswählen und einlesen. null = abgebrochen. */
export async function openTextFile(options: { kind?: SaveKind } = {}): Promise<OpenedText | null> {
  const kind = options.kind ?? 'project';
  const bridge = desktopBridge();
  if (bridge?.chooseOpenPath && bridge.readTextFile) {
    const choice = await bridge.chooseOpenPath({ kind, title: 'Projekt öffnen' });
    if (!choice || choice.canceled || !choice.filePath) return null;
    const file = await bridge.readTextFile({ filePath: choice.filePath });
    return { source: file.filePath, text: file.text };
  }

  const handle = await pickOpenHandleBrowser();
  if (!handle) return null;
  const file = await handle.getFile();
  return { source: file.name, text: await file.text() };
}

async function pickOpenHandleBrowser(): Promise<FileSystemFileHandle | null> {
  const picker = (window as unknown as { showOpenFilePicker?: (opts: object) => Promise<FileSystemFileHandle[]> })
    .showOpenFilePicker;
  if (typeof picker === 'function') {
    try {
      const [handle] = await picker({
        multiple: false,
        types: [{ description: 'Airdox-Projekt', accept: { 'application/json': ['.json', `.${PROJECT_EXTENSION}`] } }],
      });
      return handle ?? null;
    } catch (err) {
      if ((err as DOMException)?.name === 'AbortError') return null;
      throw err;
    }
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,.airdoxproj.json,application/json';
    input.style.display = 'none';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        document.body.removeChild(input);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const text = String(reader.result ?? '');
        // Kein echtes Handle – Quelle ist der Dateiname.
        (window as unknown as { __airdoxOpenedName?: string }).__airdoxOpenedName = file.name;
        resolve({ name: file.name, getFile: async () => ({ text: async () => text }) } as unknown as FileSystemFileHandle);
        document.body.removeChild(input);
      };
      reader.onerror = () => {
        resolve(null);
        document.body.removeChild(input);
      };
      reader.readAsText(file);
    };
    document.body.appendChild(input);
    input.click();
  });
}

function toBase64(bytes: Uint8Array): string {
  if (typeof btoa === 'function') {
    const chunk = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }
  return Buffer.from(bytes).toString('base64');
}

/** Name für die Projektdatei aus Projekt- und Spurnamen. */
export function suggestProjectFileName(projectName: string, trackTitle?: string): string {
  const base = projectName && projectName.trim() && projectName.trim() !== 'New Project'
    ? projectName
    : trackTitle || 'projekt';
  return projectFileName(base);
}
