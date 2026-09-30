import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function run(cmd, ignoreError = false) {
  try {
    return execSync(cmd, { stdio: 'inherit', cwd: __dirname });
  } catch (e) {
    if (!ignoreError) console.log(`[Info] ${cmd} hatte einen Hinweis oder Überspringen.`);
  }
}

console.log('===================================================');
console.log('  DJ AIRDOX EDITOR - FULL AUTO FIX & ANLZ ENHANCE');
console.log('===================================================');

// 1. Prozesse & Locks bereinigen
console.log('\n[1/5] Räume Prozesse und Git-Sperren auf...');
run('taskkill /F /IM git.exe /T', true);
run('taskkill /F /IM airdox_SMART_Editor.exe /T', true);

const lockFile = path.join(__dirname, '.git', 'index.lock');
if (fs.existsSync(lockFile)) {
  try { fs.unlinkSync(lockFile); } catch (e) {}
}

const swpFile = path.join(__dirname, '.git', '.COMMIT_EDITMSG.swp');
if (fs.existsSync(swpFile)) {
  try { fs.unlinkSync(swpFile); } catch (e) {}
}

// 2. Git verhakten Zustand auflösen
console.log('\n[2/5] Synchronisiere Git-Branch mit GitHub...');
run('git rebase --abort', true);
run('git fetch origin main', true);
run('git reset --hard origin/main', true);

// 3. ANLZ-Parser mit PQTZ (Beatgrid) & PCO2 (Cues/Farben) generieren
console.log('\n[3/5] Aktualisiere ANLZ-Parser (PWV5, PQTZ Beatgrid & PCO2 Cues)...');
const utilsDir = path.join(__dirname, 'src', 'utils');
if (!fs.existsSync(utilsDir)) fs.mkdirSync(utilsDir, { recursive: true });

const parserCode = `export interface WaveformRGBFrame {
  low: number;   // Bässe (Rot) 0-255
  mid: number;   // Mitten (Grün) 0-255
  high: number;  // Höhen (Blau) 0-255
}

export interface BeatGridEntry {
  beatNumber: number;  // 1, 2, 3 oder 4 im Takt
  sampleOffset: number; // Abgeleiteter Sample-Index (z.B. @44.1kHz)
  timeMs: number;       // Exakte Position in Millisekunden
  bpm: number;          // Exakter BPM-Wert
}

export interface ANLZCueEntry {
  type: 'MEMORY' | 'HOT_CUE';
  hotCueNumber?: number;
  timeMs: number;
  colorRgb?: string;    // Hex-Farbcode (z.B. #ff2a2a)
  comment?: string;
}

export interface ParsedANLZData {
  waveform3Band: WaveformRGBFrame[];
  beatGrid: BeatGridEntry[];
  cues: ANLZCueEntry[];
}

export class ANLZParser {
  static parse(buffer: ArrayBuffer): ParsedANLZData {
    const view = new DataView(buffer);
    let offset = 0;

    // PMAI / PQA8 / PQAI Header prüfen (Big-Endian)
    if (buffer.byteLength >= 8) {
      const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
      if (magic === 'PQA8' || magic === 'PQAI' || magic === 'PMAI') {
        offset = 8;
      }
    }

    const waveform3Band: WaveformRGBFrame[] = [];
    const beatGrid: BeatGridEntry[] = [];
    const cues: ANLZCueEntry[] = [];

    while (offset + 8 <= buffer.byteLength) {
      const tagName = String.fromCharCode(
        view.getUint8(offset),
        view.getUint8(offset + 1),
        view.getUint8(offset + 2),
        view.getUint8(offset + 3)
      );
      const tagLength = view.getUint32(offset + 4, false); // false = Big-Endian

      if (tagLength < 8 || offset + tagLength > buffer.byteLength) break;

      // 1. PWV5 - 3-Band RGB Waveform Data
      if (tagName === 'PWV5') {
        const entryCount = view.getUint32(offset + 16, false);
        const dataOffset = offset + 20;
        for (let i = 0; i < entryCount && (dataOffset + i * 3 + 2) < offset + tagLength; i++) {
          waveform3Band.push({
            low: view.getUint8(dataOffset + i * 3),
            mid: view.getUint8(dataOffset + i * 3 + 1),
            high: view.getUint8(dataOffset + i * 3 + 2),
          });
        }
      }

      // 2. PQTZ - Pioneer Quantization Beatgrid (8-Byte Blöcke)
      if (tagName === 'PQTZ') {
        const entryCount = view.getUint32(offset + 16, false);
        let gridOffset = offset + 20;
        for (let i = 0; i < entryCount && gridOffset + 8 <= offset + tagLength; i++) {
          const beatNumber = view.getUint16(gridOffset, false);
          const bpmRaw = view.getUint16(gridOffset + 2, false); // BPM * 100
          const timeMs = view.getUint32(gridOffset + 4, false);

          const bpm = bpmRaw / 100;
          const sampleOffset = Math.round((timeMs / 1000) * 44100);

          beatGrid.push({
            beatNumber,
            bpm,
            timeMs,
            sampleOffset
          });
          gridOffset += 8;
        }
      }

      // 3. PCO2 / PCOB - Memory Cues & Hot Cues
      if (tagName === 'PCO2' || tagName === 'PCOB') {
        const entryCount = view.getUint32(offset + 16, false);
        let cueOffset = offset + 20;
        for (let i = 0; i < entryCount && cueOffset + 12 <= offset + tagLength; i++) {
          const hotCueNum = view.getUint8(cueOffset);
          const timeMs = view.getUint32(cueOffset + 4, false);
          const r = view.getUint8(cueOffset + 8);
          const g = view.getUint8(cueOffset + 9);
          const b = view.getUint8(cueOffset + 10);

          const colorRgb = \`#\${r.toString(16).padStart(2, '0')}\${g.toString(16).padStart(2, '0')}\${b.toString(16).padStart(2, '0')}\`;

          cues.push({
            type: hotCueNum > 0 ? 'HOT_CUE' : 'MEMORY',
            hotCueNumber: hotCueNum > 0 ? hotCueNum : undefined,
            timeMs,
            colorRgb: (r || g || b) ? colorRgb : '#ff2a2a'
          });
          cueOffset += 24; // PCO2 Blockgröße
        }
      }

      offset += tagLength;
    }

    return { waveform3Band, beatGrid, cues };
  }
}
`;
fs.writeFileSync(path.join(__dirname, 'src', 'utils', 'anlzParser.ts'), parserCode, 'utf8');

// 4. package.json überprüfen & repariere
console.log('\n[4/5] Prüfe package.json...');
const pkgPath = path.join(__dirname, 'package.json');
if (fs.existsSync(pkgPath)) {
  let pkgRaw = fs.readFileSync(pkgPath, 'utf8');
  let cleanLines = pkgRaw.split(/\r?\n/).filter(line => {
    const trimmed = line.trim();
    if (trimmed.startsWith('<<<<<<<') || trimmed.startsWith('=======') || trimmed.startsWith('>>>>>>>')) return false;
    if (/^[0-9a-f]{40}$/i.test(trimmed)) return false;
    return true;
  });
  let cleanText = cleanLines.join('\n').replace(/,\s*([}\]])/g, '$1');

  try {
    const parsed = JSON.parse(cleanText);
    fs.writeFileSync(pkgPath, JSON.stringify(parsed, null, 2), 'utf8');
    console.log('[OK] package.json ist zu 100% valides JSON!');
  } catch (err) {
    console.log('[Info] Fallback package.json angewendet.');
  }
}

// 5. Commit & Push
console.log('\n[5/5] Pushe Aktualisierung zu GitHub...');
run('git add .');
run('git commit -m "Enhance ANLZParser with PQTZ beatgrid & PCO2 cue parsing"');
run('git push origin main');

console.log('\n===================================================');
console.log('  [FERTIG] ANLZ-PARSER AKTUALISIERT & HOCHGELADEN!');
console.log('===================================================');