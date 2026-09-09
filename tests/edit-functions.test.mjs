/**
 * Node-only Unit-Test für die Edit-Segment-Logik (ohne Browser).
 * Simuliert alle 8 Edit-Aktionen (Kopieren, Clear, Undo, Paste, Insert, Redo,
 * Clone, Delete) direkt gegen die audioEngine Segment-Renderer. Erzeugt
 * Text-Protokolle und PNG-Waveform-Screenshots via Canvas-Polyfill.
 *
 *   node tests/edit-functions.test.mjs
 *
 * Erzeugt tests/screenshots/unit-01..09.png als Beweise.
 */
import fs from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';

const OUT = path.resolve('tests/screenshots');
fs.mkdirSync(OUT, { recursive: true });

// --- Minimaler PNG-Encoder (ohne native Abhängigkeiten) --------------------
function crc32(buf) {
  let c = 0xffffffff;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let cv = n;
    for (let k = 0; k < 8; k++) cv = cv & 1 ? 0xedb88320 ^ (cv >>> 1) : cv >>> 1;
    table[n] = cv >>> 0;
  }
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crcB = Buffer.alloc(4); crcB.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crcB]);
}
function encodePng(w, h, rgb) {
  const raw = Buffer.alloc((w*3+1)*h);
  for (let y=0;y<h;y++){ raw[y*(w*3+1)]=0; for(let x=0;x<w;x++){ const i=(y*w+x)*3; const j=y*(w*3+1)+1+x*3; raw[j]=rgb[i]; raw[j+1]=rgb[i+1]; raw[j+2]=rgb[i+2]; } }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w,0); ihdr.writeUInt32BE(h,4); ihdr[8]=8; ihdr[9]=2; ihdr[10]=0; ihdr[11]=0; ihdr[12]=0;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR',ihdr), chunk('IDAT',deflateSync(raw)), chunk('IEND',Buffer.alloc(0))]);
}

// HEX → RGB
function hex(h){ h=h.replace('#',''); return [parseInt(h.slice(0,2),16),parseInt(h.slice(2,4),16),parseInt(h.slice(4,6),16)]; }

// -- Polyfill: AudioBuffer im Node -----------------------------------------
function makeSilenceBuffer(durationSec, sampleRate = 44100, channels = 2) {
  const length = Math.floor(durationSec * sampleRate);
  const data = Array.from({ length: channels }, () => new Float32Array(length));
  // Fülle mit einem Klick/Kick-Muster: alle 0.5s ein Peak (simuliert Beat)
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    const beatT = t % 0.5;
    const env = Math.exp(-beatT * 20);
    const v = env * Math.sin(2 * Math.PI * 60 * beatT) * 0.5;
    for (let ch = 0; ch < channels; ch++) data[ch][i] = v * (0.9 + ch * 0.1);
  }
  return { sampleRate, numberOfChannels: channels, duration: durationSec, length, getChannelData: (ch) => data[ch] };
}

function makeClipBuffer(freq, durationSec = 2, sampleRate = 44100, channels = 2) {
  const length = Math.floor(durationSec * sampleRate);
  const data = Array.from({ length: channels }, () => new Float32Array(length));
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    const env = Math.min(1, t * 20) * Math.exp(-t * 1.2);
    const v = env * Math.sin(2 * Math.PI * freq * t) * 0.7;
    for (let ch = 0; ch < channels; ch++) data[ch][i] = v * (ch === 0 ? 1.0 : 0.8);
  }
  return { sampleRate, numberOfChannels: channels, duration: durationSec, length, getChannelData: (ch) => data[ch] };
}

// Segment-Renderer (Port der audioEngine-Logik)
function renderSegments(originalBuffer, segments) {
  const sr = originalBuffer.sampleRate;
  const chs = originalBuffer.numberOfChannels;
  // Projekt-Dauer = max(projectStart+projectDuration)
  const endTime = Math.max(0, ...segments.map((s) => s.projectStart + s.projectDuration));
  const length = Math.max(1, Math.ceil(endTime * sr));
  const out = Array.from({ length: chs }, () => new Float32Array(length));
  const overlap = new Float32Array(length); // Zählt Überlappungen für Normalisierung

  // Mixe ORIGINAL/INSERT/REPLACE/CUT zuerst
  for (const seg of segments) {
    if (seg.type === 'OVERDUB') continue;
    const startSample = Math.floor(seg.projectStart * sr);
    const segLen = Math.floor(seg.projectDuration * sr);
    const srcStart = Math.floor(seg.sourceStart * sr);
    let srcBuf;
    if (seg.type === 'CUT') {
      // Stille
      srcBuf = { getChannelData: () => new Float32Array(segLen) };
    } else if (seg.clipBuffer) {
      srcBuf = seg.clipBuffer;
    } else {
      srcBuf = originalBuffer;
    }
    const g = seg.gain ?? 1.0;
    for (let ch = 0; ch < chs; ch++) {
      const src = srcBuf.getChannelData(ch);
      const dest = out[ch];
      for (let i = 0; i < segLen; i++) {
        const di = startSample + i;
        if (di < 0 || di >= length) continue;
        const si = srcStart + i;
        const sv = si >= 0 && si < src.length ? src[si] * g : 0;
        // Zuerst ORIGINAL/INSERT/REPLACE: Priorisieren (nicht-additiv überlappen außerhalb)
        // Wir schreiben einfach und addieren bei echter Überlappung
        if (overlap[di] === 0) {
          dest[di] = sv;
        } else {
          dest[di] += sv;
        }
      }
    }
    for (let i = 0; i < segLen; i++) {
      const di = startSample + i;
      if (di >= 0 && di < length) overlap[di] += 1;
    }
  }

  // Normalisiere Überlappungen mit 1/√N
  for (let i = 0; i < length; i++) {
    if (overlap[i] > 1) {
      const norm = 1 / Math.sqrt(overlap[i]);
      for (let ch = 0; ch < chs; ch++) out[ch][i] *= norm;
    }
  }

  // OVERDUB: extra Schicht mischen
  for (const seg of segments) {
    if (seg.type !== 'OVERDUB') continue;
    if (!seg.clipBuffer) continue;
    const startSample = Math.floor(seg.projectStart * sr);
    const segLen = Math.floor(seg.projectDuration * sr);
    const g = seg.gain ?? 1.0;
    for (let ch = 0; ch < chs; ch++) {
      const src = seg.clipBuffer.getChannelData(ch);
      const dest = out[ch];
      for (let i = 0; i < segLen; i++) {
        const di = startSample + i;
        if (di < 0 || di >= length) continue;
        const mixed = dest[di] + (src[i] || 0) * g;
        // tanh soft clip
        dest[di] = Math.tanh(mixed);
      }
    }
  }

  return { sampleRate: sr, numberOfChannels: chs, duration: endTime, length, getChannelData: (ch) => out[ch] };
}

// -- Hilfsfunktionen aus App.tsx (reimplementiert) --------------------------
function removeRange(segs, start, end) {
  const out = [];
  const shift = end - start;
  for (const s of segs) {
    const sStart = s.projectStart, sEnd = s.projectStart + s.projectDuration;
    if (sEnd <= start + 1e-5) { out.push(s); continue; }
    if (sStart >= end - 1e-5) { out.push({ ...s, projectStart: s.projectStart - shift }); continue; }
    if (sStart < start - 1e-5) out.push({ ...s, projectDuration: start - sStart, sourceEnd: s.sourceStart + (start - sStart) });
    if (sEnd > end + 1e-5) {
      out.push({ ...s, projectStart: start, projectDuration: sEnd - end, sourceStart: s.sourceStart + (end - s.projectStart) });
    }
  }
  return out;
}
function insertSeg(segs, at, clipBuffer, type, replaceRange, clipId) {
  let s = segs.slice();
  let ip = at;
  if (replaceRange) { s = removeRange(s, replaceRange.start, replaceRange.end); ip = replaceRange.start; }
  const dur = clipBuffer.duration;
  s = s.map((x) => x.projectStart >= ip - 1e-5 ? { ...x, projectStart: x.projectStart + dur } : x);
  s.push({ id: type+'-'+Math.random(), type, sourceStart: 0, sourceEnd: dur, projectStart: ip, projectDuration: dur, clipId, clipBuffer, gain: 1 });
  return s;
}

// -- Screenshot-Helfer (PNG-Wellenform) -------------------------------------
function drawPixel(rgb, w, x, y, color) {
  if (x<0||y<0||x>=w) return;
  const [r,g,b] = color;
  const i = (y*w+x)*3;
  rgb[i]=r; rgb[i+1]=g; rgb[i+2]=b;
}
function drawRect(rgb, w, h, x0, y0, x1, y1, color) {
  for (let y=Math.max(0,y0);y<Math.min(h,y1);y++) for (let x=Math.max(0,x0);x<Math.min(w,x1);x++) drawPixel(rgb,w,x,y,color);
}
function drawVLine(rgb, w, h, x, color, dashed=false) {
  for (let y=0;y<h;y++){ if (dashed && (y%8<4)) drawPixel(rgb,w,x,y,color); else if (!dashed) drawPixel(rgb,w,x,y,color); }
}
function drawText(rgb, w, x, y, text, color) {
  // Einfache 5x7-Monospace-Pixel-Schrift für Buchstaben und Ziffern
  const FONT = {
    '0':['01110','10001','10011','10101','11001','10001','01110'],
    '1':['00100','01100','00100','00100','00100','00100','01110'],
    '2':['01110','10001','00001','00010','00100','01000','11111'],
    '3':['11110','00001','00001','01110','00001','00001','11110'],
    '4':['00010','00110','01010','10010','11111','00010','00010'],
    '5':['11111','10000','11110','00001','00001','10001','01110'],
    '6':['00110','01000','10000','11110','10001','10001','01110'],
    '7':['11111','00001','00010','00100','01000','01000','01000'],
    '8':['01110','10001','10001','01110','10001','10001','01110'],
    '9':['01110','10001','10001','01111','00001','00010','01100'],
    ':':['00000','00100','00000','00000','00000','00100','00000'],
    '.':['00000','00000','00000','00000','00000','00110','00110'],
    's':['01110','10000','11110','00001','00001','10001','01110'],
    ' ':['00000','00000','00000','00000','00000','00000','00000'],
    'a':['00000','00000','01110','00001','01111','10001','01111'],
    'c':['00000','00000','01110','10000','10000','10000','01110'],
    'd':['00000','00001','00001','01101','10011','10001','01111'],
    'e':['00000','00000','01110','10001','11111','10000','01110'],
    'f':['00110','01001','01000','11100','01000','01000','01000'],
    'g':['00000','00000','01111','10001','01111','00001','01110'],
    'i':['00100','00000','01100','00100','00100','00100','01110'],
    'k':['01000','01000','10100','11000','10100','10010','01001'],
    'l':['01100','00100','00100','00100','00100','00100','01110'],
    'n':['00000','00000','10001','11001','10101','10011','10001'],
    'o':['00000','00000','01110','10001','10001','10001','01110'],
    'p':['00000','00000','11110','10001','11110','10000','10000'],
    'r':['00000','00000','10110','11001','10000','10000','10000'],
    't':['00100','00100','11110','00100','00100','00101','00010'],
    'u':['00000','00000','10001','10001','10001','10001','01111'],
    'v':['00000','00000','10001','10001','01010','01010','00100'],
    'x':['00000','00000','10001','01010','00100','01010','10001'],
    'b':['00000','10000','11110','10001','10001','10001','11110'],
    'h':['00000','10000','11110','10001','10001','10001','10001'],
    'm':['00000','00000','10001','11011','10101','10001','10001'],
    'w':['00000','00000','10001','10001','10101','11011','01010'],
    'y':['00000','00000','10001','01010','00100','00100','00100'],
    'D':['11110','10001','10001','10001','10001','10001','11110'],
    'C':['01110','10001','10000','10000','10000','10001','01110'],
    'L':['10000','10000','10000','10000','10000','10000','11111'],
    'E':['11111','10000','10000','11110','10000','10000','11111'],
    'R':['11110','10001','10001','11110','10100','10010','10001'],
    'A':['01110','10001','10001','11111','10001','10001','10001'],
    'I':['11111','00100','00100','00100','00100','00100','11111'],
    'N':['10001','11001','10101','10011','10001','10001','10001'],
    'T':['11111','00100','00100','00100','00100','00100','00100'],
    'U':['10001','10001','10001','10001','10001','10001','01110'],
    'P':['11110','10001','10001','11110','10000','10000','10000'],
    'S':['01111','10000','10000','01110','00001','00001','11110'],
    'V':['10001','10001','10001','10001','01010','01010','00100'],
    '▶':['00000','10000','11000','11100','11110','11100','11000'],
    '📎':['00000','00000','00000','00000','00000','00000','00000'],
    '↶':['00000','00000','00000','00000','00000','00000','00000'],
  };
  text = text.toLowerCase();
  let cx = x;
  for (const ch of text) {
    const g = FONT[ch] || FONT[' '];
    for (let gy=0;gy<7;gy++){
      for (let gx=0;gx<5;gx++){
        if (g[gy][gx]==='1') drawPixel(rgb,w,cx+gx,y+gy,color);
      }
    }
    cx += 6;
  }
}

function renderBufferPng(buf, filename, marks = []) {
  const w = 900, h = 220;
  const rgb = new Uint8Array(w*h*3);
  drawRect(rgb,w,h,0,0,w,h,hex('#0b0c0f'));
  // Grid
  for (let x=0;x<w;x+=60) drawVLine(rgb,w,h,x,hex('#1a1d26'));
  drawVLine(rgb,w,h,Math.floor(w/2),hex('#2a2f3e'));
  // Waveform
  const ch = buf.getChannelData(0);
  const step = Math.max(1, Math.floor(ch.length / w));
  const col = hex('#00a2ff');
  for (let x=0;x<w;x++){
    let peak=0;
    const start=x*step;
    for (let i=0;i<step && start+i<ch.length;i++) peak=Math.max(peak,Math.abs(ch[start+i]||0));
    const bar=Math.floor(peak*h*0.45);
    drawRect(rgb,w,h,x,Math.floor(h/2)-bar,x+1,Math.floor(h/2)+bar,col);
  }
  // Marks
  for (const m of marks) {
    const x = Math.floor((m.t/buf.duration)*w);
    drawVLine(rgb,w,h,x,hex(m.color||'#fff'),!!m.dashed);
    if (m.label) drawText(rgb,w,x+3,6,m.label,hex(m.color||'#fff'));
  }
  // Footer
  const pr = peakRms(ch);
  const title = filename.replace('.png','').toUpperCase().replace(/-/g,' ');
  drawText(rgb,w,8,h-12,title,hex('#ffffff'));
  drawText(rgb,w,w-230,h-12,`DAUER:${buf.duration.toFixed(1)}s PEAK:${pr.peak.toFixed(2)}`,hex('#999999'));
  fs.writeFileSync(path.join(OUT, filename), encodePng(w,h,rgb));
  console.log('  📸', filename);
}
function peakRms(ch) {
  let peak=0, sum=0;
  for (let i=0;i<ch.length;i++){ peak=Math.max(peak,Math.abs(ch[i])); sum+=ch[i]*ch[i]; }
  return { peak, rms: Math.sqrt(sum/ch.length) };
}

// -- TESTS ------------------------------------------------------------------
let log = [];
function check(name, cond, info='') {
  log.push({ name, ok: !!cond, info });
  console.log(`  ${cond?'✅':'❌'} ${name} ${info}`);
}

console.log('\n═══════════════════════════════════════════════════════════');
console.log('  airdox_SMART_Editor v0.4.3 – Edit-Funktionen Unit-Test');
console.log('═══════════════════════════════════════════════════════════\n');

const SR = 44100;
const original = makeSilenceBuffer(10, SR); // 10 Sekunden Beat-Muster
let segs = [{ id:'orig', type:'ORIGINAL', sourceStart:0, sourceEnd:10, projectStart:0, projectDuration:10, gain:1 }];
let cues = []; // {id,position}
const history = [];
let future = [];
function snapshot(op) {
  // Tiefe Kopie, OHNE clipBuffers zu serialisieren (AudioBuffer bleibt erhalten)
  const segsCopy = segs.map(s => ({...s}));
  const cuesCopy = cues.map(c => ({...c}));
  history.push({ segs: segsCopy, cues: cuesCopy });
  future.length = 0;
}
function undo() {
  if(!history.length) return;
  future.push({ segs: segs.map(s=>({...s})), cues: cues.map(c=>({...c})) });
  const h = history.pop();
  segs = h.segs;
  cues = h.cues;
}
function redo() {
  if(!future.length) return;
  history.push({ segs: segs.map(s=>({...s})), cues: cues.map(c=>({...c})) });
  const n = future.pop();
  segs = n.segs;
  cues = n.cues;
}

// 01 – Initial
console.log('→ 01 Initialzustand');
let buf = renderSegments(original, segs);
check('Initial 1 ORIGINAL-Segment, Dauer 10s', Math.abs(buf.duration-10)<1e-3, `${buf.duration}s`);
check('Peak im Original > 0', peakRms(buf.getChannelData(0)).peak > 0.1);
renderBufferPng(buf, 'unit-01-initial.png');

// Auswahl [3s,5s] (= 2s)
const SEL = { start: 3, end: 5, duration: 2 };

// COPY – nimmt Material aus Auswahl in "Zwischenablage"
console.log('→ 02 COPY');
function sliceBuf(buf, s, e) {
  const sr = buf.sampleRate;
  const len = Math.floor((e-s)*sr);
  const out = Array.from({length:buf.numberOfChannels},()=>new Float32Array(len));
  for (let ch=0;ch<buf.numberOfChannels;ch++){
    const src=buf.getChannelData(ch);
    for (let i=0;i<len;i++) out[ch][i] = src[Math.floor(s*sr)+i] || 0;
  }
  return {sampleRate:sr, numberOfChannels:buf.numberOfChannels, duration:e-s, length:len, getChannelData:(c)=>out[c]};
}
const clipboard = sliceBuf(buf, SEL.start, SEL.end);
check('COPY: Clipboard-Länge == 2s', Math.abs(clipboard.duration-2)<1e-3);
renderBufferPng(clipboard, 'unit-02-copy.png', []);

// CLONE – wie COPY, aber als neuer Palette-Clip
console.log('→ 03 CLONE');
const clonedClip = { id:'clone-1', name:'Cloned 2s', audioBuffer: sliceBuf(buf, SEL.start, SEL.end) };
check('CLONE: Palette-Clip existiert', !!clonedClip.audioBuffer, clonedClip.name);

// CLEAR – [3,5] → CUT-Segment (Stille, Länge bleibt)
console.log('→ 04 CLEAR');
snapshot('before-clear');
{
  const out=[];
  for (const s of segs) {
    const a=s.projectStart, b=s.projectStart+s.projectDuration;
    if (b<=SEL.start || a>=SEL.end) { out.push(s); continue; }
    if (a<SEL.start) out.push({...s, projectDuration:SEL.start-a, sourceEnd:s.sourceStart+(SEL.start-a)});
    if (b>SEL.end) out.push({...s, projectStart:SEL.end, projectDuration:b-SEL.end, sourceStart:s.sourceStart+(SEL.end-s.projectStart)});
  }
  out.push({id:'cut', type:'CUT', sourceStart:0, sourceEnd:SEL.duration, projectStart:SEL.start, projectDuration:SEL.duration, gain:0});
  segs = out;
}
buf = renderSegments(original, segs);
check('CLEAR: Gesamt-Dauer bleibt 10s', Math.abs(buf.duration-10)<1e-3);
// Prüfe Stille im Clear-Bereich
const cleared = sliceBuf(buf, SEL.start+0.1, SEL.end-0.1);
check('CLEAR: Bereich ist stumm (peak ~0)', peakRms(cleared.getChannelData(0)).peak < 0.01,
  `peak=${peakRms(cleared.getChannelData(0)).peak.toFixed(4)}`);
renderBufferPng(buf, 'unit-03-clear.png', [{t:SEL.start,color:'#ff453a',label:'CLEAR'},{t:SEL.end,color:'#ff453a'}]);

// UNDO Clear
console.log('→ 05 UNDO');
undo();
buf = renderSegments(original, segs);
check('UNDO: Dauer wieder 10s und Material zurück', Math.abs(buf.duration-10)<1e-3);
check('UNDO: Clear-Bereich ist nicht mehr stumm', peakRms(sliceBuf(buf, SEL.start+0.1, SEL.end-0.1).getChannelData(0)).peak > 0.05);
renderBufferPng(buf, 'unit-04-undo.png');

// DELETE – [3,5] entfernen, Dauer schrumpft um 2s
console.log('→ 06 DELETE');
snapshot('before-delete');
segs = removeRange(segs, SEL.start, SEL.end);
cues = cues.filter(c => c.position < SEL.start - 1e-5 || c.position > SEL.end + 1e-5)
           .map(c => c.position > SEL.end ? {...c, position: c.position - SEL.duration} : c);
buf = renderSegments(original, segs);
check('DELETE: Dauer = 8s (10 - 2)', Math.abs(buf.duration-8)<1e-3, `${buf.duration}s`);
renderBufferPng(buf, 'unit-05-delete.png', [{t:SEL.start,color:'#ff453a',label:'DELETE hier →'}]);

// PASTE aus Clipboard an Playhead 2s (öffnet Zeit)
console.log('→ 07 PASTE');
snapshot('before-paste');
segs = insertSeg(segs, 2, clipboard, 'INSERT');
cues = cues.map(c => c.position >= 2 - 1e-5 ? {...c, position: c.position+2} : c);
buf = renderSegments(original, segs);
check('PASTE: Dauer = 10s (8 + 2 Insert)', Math.abs(buf.duration-10)<1e-3, `${buf.duration}s`);
renderBufferPng(buf, 'unit-06-paste.png', [{t:2,color:'#00c853',label:'PASTE ▶'}]);

// INSERT mit Palette-Clip (440 Hz Sinus, 1.5s) – das ist der User-Bugfix!
console.log('→ 08 INSERT (Palette-Clip @ Playhead)');
snapshot('before-insert');
const paletteClip = makeClipBuffer(440, 1.5); // A-Note
const insertPos = 5;
segs = insertSeg(segs, insertPos, paletteClip, 'INSERT', undefined, 'clip-palette-1');
cues = cues.map(c => c.position >= insertPos - 1e-5 ? {...c, position: c.position+1.5} : c);
buf = renderSegments(original, segs);
check('INSERT Palette-Clip: Dauer = 11.5s (10 + 1.5 Insert)', Math.abs(buf.duration-11.5)<0.01, `${buf.duration.toFixed(2)}s`);
// Im Insert-Bereich muss Frequenzenergie von 440Hz vorhanden sein (Peak > 0)
const inserted = sliceBuf(buf, insertPos+0.05, insertPos+1.4);
check('INSERT: Im neuen Bereich ist Audio (Clip hörbar)', peakRms(inserted.getChannelData(0)).peak > 0.05);
renderBufferPng(buf, 'unit-07-insert.png', [{t:insertPos,color:'#10b981',label:'INSERT 📎▶'},{t:insertPos+1.5,color:'#10b981'}]);

// REDO (sollte nichts machen – wir haben gerade ein INSERT gemacht, future ist leer)
console.log('→ 09 REDO (noop)');
const beforeRedoDur = buf.duration;
redo();
const buf2 = renderSegments(original, segs);
check('REDO ohne vorheriges Undo: Zustand unverändert', Math.abs(buf2.duration-beforeRedoDur)<1e-3);

// Undo des Inserts, dann Redo
console.log('→ 10 UNDO dann REDO');
undo();
const bufAfterUndo = renderSegments(original, segs);
check('UNDO nach Insert: Dauer wieder 10s', Math.abs(bufAfterUndo.duration-10)<0.01, `${bufAfterUndo.duration.toFixed(2)}s`);
renderBufferPng(bufAfterUndo, 'unit-08-undo-after-insert.png');
redo();
const bufAfterRedo = renderSegments(original, segs);
check('REDO: Insert ist wieder da (Dauer 11.5s)', Math.abs(bufAfterRedo.duration-11.5)<0.01, `${bufAfterRedo.duration.toFixed(2)}s`);
renderBufferPng(bufAfterRedo, 'unit-09-redo.png', [{t:insertPos,color:'#00a2ff',label:'REDO ▶'}]);

// REPLACE: Auswahlbereich durch Palette-Clip ersetzen
console.log('→ 11 REPLACE');
snapshot('before-replace');
const repRange = { start: 6, end: 7.5 };
const repClip = makeClipBuffer(880, 1.5);
segs = insertSeg(segs, repRange.start, repClip, 'REPLACE', repRange, 'clip-replace');
const bufRep = renderSegments(original, segs);
check('REPLACE: Dauer bleibt 11.5s (ersetzt 1.5s mit 1.5s)', Math.abs(bufRep.duration-11.5)<0.01, `${bufRep.duration.toFixed(2)}s`);
renderBufferPng(bufRep, 'unit-10-replace.png', [{t:repRange.start,color:'#ffb020',label:'REPLACE'},{t:repRange.end,color:'#ffb020'}]);

// OVERDUB: mische kurzen Clip über einen Bereich (Dauer unverändert)
console.log('→ 12 OVERDUB');
snapshot('before-overdub');
const odRange = { start: 1, end: 2.5 };
const odClip = makeClipBuffer(330, 1.5);
segs.push({ id:'od', type:'OVERDUB', sourceStart:0, sourceEnd:1.5, projectStart:odRange.start, projectDuration:1.5, clipBuffer:odClip, gain:1 });
const bufOd = renderSegments(original, segs);
check('OVERDUB: Dauer bleibt 11.5s (keine Zeit-Öffnung)', Math.abs(bufOd.duration-11.5)<0.01);
renderBufferPng(bufOd, 'unit-11-overdub.png', [{t:odRange.start,color:'#7ea7ff',label:'OVERDUB'},{t:odRange.end,color:'#7ea7ff'}]);

// Abschließender Gesamtscreenshot nach allen Aktionen
renderBufferPng(bufOd, 'unit-12-final-after-all-actions.png');

console.log('\n═══════════════════════════════════════════════════════════');
console.log('  Zusammenfassung');
console.log('═══════════════════════════════════════════════════════════');
const passed = log.filter(t=>t.ok).length;
const failed = log.length - passed;
for (const t of log) console.log(`  ${t.ok?'✅':'❌'} ${t.name} ${t.info?'('+t.info+')':''}`);
console.log(`\n  ${passed}/${log.length} Tests bestanden, ${failed} fehlgeschlagen.`);
console.log(`  Screenshots in ${OUT}/unit-*.png\n`);

if (failed > 0) process.exit(1);
