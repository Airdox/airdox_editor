/**
 * @license
 * Rekordbox XML Importer & Exporter
 * Handles official Pioneer Rekordbox XML schema (<DJ_PLAYLISTS>, <COLLECTION>, <TRACK>, <TEMPO>, <POSITION_MARK>)
 * preserving Beatgrids, Hot Cues, Memory Cues, and Loops.
 */

import { BeatGrid, BeatNode, CuePoint, DataOrigin, LoopPoint, TrackModel } from '../types/rekordbox';

export function buildBeatGridFromTempo(
  firstBeatSec: number,
  bpm: number,
  totalDurationSec: number,
  meter: number = 4,
  origin: DataOrigin = DataOrigin.REKORDBOX_XML
): BeatGrid {
  const secondsPerBeat = 60.0 / bpm;
  const totalBeats = Math.max(1, Math.ceil((totalDurationSec - firstBeatSec) / secondsPerBeat) + 4);
  const beats: BeatNode[] = [];

  for (let i = 0; i < totalBeats; i++) {
    const time = firstBeatSec + i * secondsPerBeat;
    const isBarStart = i % meter === 0;
    const barNumber = Math.floor(i / meter) + 1;
    const beatInBar = (i % meter) + 1;

    beats.push({
      index: i,
      time,
      isBarStart,
      barNumber,
      beatInBar,
    });
  }

  return {
    firstBeat: firstBeatSec,
    bpm,
    meter,
    beats,
    origin,
  };
}

// Helper to unescape XML entities
export function unescapeXml(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

interface SimpleXmlElement {
  tagName: string;
  attributes: Record<string, string>;
  children: SimpleXmlElement[];
  getAttribute(name: string): string | null;
  querySelector(tag: string): SimpleXmlElement | null;
  querySelectorAll(tag: string): SimpleXmlElement[];
}

function parseXmlFallback(xmlString: string): SimpleXmlElement {
  // Regex to match XML tags and self-closing tags
  const tagRegex = /<([a-zA-Z0-9_]+)([^>]*?)(\/?)>|([a-zA-Z0-9_]+)/g;
  const attrRegex = /([a-zA-Z0-9_]+)=["']([^"']*)["']/g;

  const root: SimpleXmlElement = {
    tagName: '__ROOT__',
    attributes: {},
    children: [],
    getAttribute: () => null,
    querySelector(tag: string) {
      return this.children.find((c) => c.tagName === tag) || null;
    },
    querySelectorAll(tag: string) {
      const results: SimpleXmlElement[] = [];
      const traverse = (node: SimpleXmlElement) => {
        for (const ch of node.children) {
          if (ch.tagName === tag) results.push(ch);
          traverse(ch);
        }
      };
      traverse(this);
      return results;
    },
  };

  // Stack of open elements
  const stack: SimpleXmlElement[] = [root];

  // Tokenize XML
  const tokens = xmlString.match(/<[^>]+>/g) || [];
  for (const token of tokens) {
    if (token.startsWith('<?') || token.startsWith('<!')) {
      continue; // Skip declaration or comments
    }

    if (token.startsWith('</')) {
      // Closing tag
      if (stack.length > 1) {
        stack.pop();
      }
      continue;
    }

    // Opening or self-closing tag
    const isSelfClosing = token.endsWith('/>');
    const tagContent = token.slice(1, isSelfClosing ? -2 : -1).trim();
    const spaceIdx = tagContent.indexOf(' ');
    const tagName = spaceIdx > 0 ? tagContent.slice(0, spaceIdx) : tagContent;
    const attrString = spaceIdx > 0 ? tagContent.slice(spaceIdx) : '';

    const attrs: Record<string, string> = {};
    let attrMatch;
    const localAttrRegex = /([a-zA-Z0-9_]+)=["']([^"']*)["']/g;
    while ((attrMatch = localAttrRegex.exec(attrString)) !== null) {
      attrs[attrMatch[1]] = unescapeXml(attrMatch[2]);
    }

    const elem: SimpleXmlElement = {
      tagName,
      attributes: attrs,
      children: [],
      getAttribute(name: string) {
        return this.attributes[name] !== undefined ? this.attributes[name] : null;
      },
      querySelector(tag: string) {
        return this.children.find((c) => c.tagName === tag) || null;
      },
      querySelectorAll(tag: string) {
        const results: SimpleXmlElement[] = [];
        const traverse = (node: SimpleXmlElement) => {
          for (const ch of node.children) {
            if (ch.tagName === tag) results.push(ch);
            traverse(ch);
          }
        };
        traverse(this);
        return results;
      },
    };

    const parent = stack[stack.length - 1];
    parent.children.push(elem);

    if (!isSelfClosing) {
      stack.push(elem);
    }
  }

  return root;
}

export interface XmlImportProgress {
  phase: 'READING' | 'PARSING_XML' | 'EXTRACTING_TRACKS' | 'BUILDING_GRIDS' | 'VALIDATING' | 'COMPLETE' | 'ERROR';
  phaseText: string;
  processedTracks: number;
  totalTracks: number;
  percent: number;
  currentTrackName?: string;
  memoryCuesFound: number;
  hotCuesFound: number;
  loopsFound: number;
  logMessages: string[];
}

function parseSingleTrackNode(
  el: {
    getAttribute: (name: string) => string | null;
    attributes?: Record<string, string> | NamedNodeMap | any;
    querySelector: (tag: string) => any;
    querySelectorAll: (tag: string) => any;
  },
  index: number,
  buildDenseBeatGrid: boolean = true
): Partial<TrackModel> {
  const id = el.getAttribute('TrackID') || `rb-track-${index + 1}`;
  const title = el.getAttribute('Name') || 'Untitled Track';
  const artist = el.getAttribute('Artist') || 'Unknown Artist';
  const album = el.getAttribute('Album') || '';
  const genre = el.getAttribute('Genre') || 'Electronic';
  const bpm = parseFloat(el.getAttribute('AverageBpm') || '130.00');
  const key = el.getAttribute('Tonality') || '2A';
  const duration = parseFloat(el.getAttribute('TotalTime') || '300.0');
  const comments = el.getAttribute('Comments') || '';
  const year = el.getAttribute('Year') || '';
  const dateAdded = el.getAttribute('DateAdded') || '';
  const remixer = el.getAttribute('Remixer') || '';
  const location = el.getAttribute('Location') || '';

  // Rekordbox Rating: 0..255 or 0..5
  let rating = 0;
  const rawRatingStr = el.getAttribute('Rating');
  if (rawRatingStr) {
    const rawNum = parseInt(rawRatingStr, 10);
    if (!isNaN(rawNum)) {
      if (rawNum > 5) {
        rating = Math.min(5, Math.max(0, Math.round((rawNum / 255) * 5)));
      } else {
        rating = Math.min(5, Math.max(0, rawNum));
      }
    }
  }

  const playCountStr = el.getAttribute('PlayCount');
  const playCount = playCountStr ? Math.max(0, parseInt(playCountStr, 10) || 0) : 0;

  // Collect raw attributes to prevent data loss
  const rawAttrs: Record<string, string> = {};
  if (el.attributes) {
    if (typeof el.attributes.length === 'number') {
      for (let i = 0; i < el.attributes.length; i++) {
        const attr = el.attributes[i];
        if (attr && attr.name) {
          rawAttrs[attr.name] = attr.value;
        }
      }
    } else {
      Object.assign(rawAttrs, el.attributes);
    }
  }

  // Parse TEMPO (Beatgrid)
  const tempoEl = el.querySelector('TEMPO');
  let firstBeat = 0.0;
  let tempoBpm = bpm;
  if (tempoEl) {
    firstBeat = parseFloat(tempoEl.getAttribute('Inizio') || '0.0');
    tempoBpm = parseFloat(tempoEl.getAttribute('Bpm') || bpm.toString());
  }

  // A complete grid contains hundreds of objects per song.  Keep collection
  // imports compact; the full grid is reconstructed only for the track loaded
  // into a deck.
  const beatGrid = buildDenseBeatGrid
    ? buildBeatGridFromTempo(firstBeat, tempoBpm, duration, 4, DataOrigin.REKORDBOX_XML)
    : {
        firstBeat,
        bpm: tempoBpm,
        meter: 4,
        beats: [],
        origin: DataOrigin.REKORDBOX_XML,
      };

  // Parse POSITION_MARK
  const cues: CuePoint[] = [];
  const loops: LoopPoint[] = [];

  const markElements = el.querySelectorAll('POSITION_MARK');
  markElements.forEach((mEl: any, mIdx: number) => {
    const type = mEl.getAttribute('Type') || '0';
    const start = parseFloat(mEl.getAttribute('Start') || '0.0');
    const name = mEl.getAttribute('Name') || `Cue ${mIdx + 1}`;
    const numStr = mEl.getAttribute('Num') || '-1';
    const num = parseInt(numStr, 10);
    const r = mEl.getAttribute('Red') || '255';
    const g = mEl.getAttribute('Green') || '120';
    const b = mEl.getAttribute('Blue') || '0';
    const color = `rgb(${r}, ${g}, ${b})`;

    if (type === '0') {
      const inMsec = Math.round(start * 1000);
      const spb = 60.0 / tempoBpm;
      const beatIndex = Math.round((start - firstBeat) / spb);
      const barNumber = Math.floor(beatIndex / 4) + 1;
      const beatNumber = (beatIndex % 4) + 1;

      if (num >= 0) {
        const letters = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
        cues.push({
          id: `hot-cue-${num}`,
          name,
          type: 'HOT_CUE',
          hotCueNum: num,
          letter: letters[num] || `${num}`,
          position: start,
          inMsec,
          cueIndex: mIdx + 1,
          barNumber,
          beatNumber,
          color: color || '#00a2ff',
          origin: DataOrigin.REKORDBOX_XML,
        });
      } else {
        cues.push({
          id: `mem-cue-${mIdx}`,
          name,
          type: 'MEMORY',
          position: start,
          inMsec,
          cueIndex: mIdx + 1,
          barNumber,
          beatNumber,
          color: '#ff3b30',
          origin: DataOrigin.REKORDBOX_XML,
        });
      }
    } else if (type === '4') {
      const end = parseFloat(mEl.getAttribute('End') || `${start + 4}`);
      loops.push({
        id: `loop-${mIdx}`,
        name: name || 'Loop',
        start,
        end,
        length: Math.max(0.1, end - start),
        color: '#ff9500',
        origin: DataOrigin.REKORDBOX_XML,
      });
    }
  });

  return {
    id,
    title,
    artist,
    album,
    genre,
    bpm: tempoBpm,
    key,
    duration,
    rating,
    playCount,
    comments,
    year,
    dateAdded,
    remixer,
    ...(location
      ? {
          originalMedia: {
            location,
            accessMode: 'READ_ONLY' as const,
            status: 'UNVERIFIED' as const,
          },
        }
      : {}),
    beatGrid,
    cues,
    loops,
    origin: DataOrigin.REKORDBOX_XML,
    rawXmlAttributes: rawAttrs,
  };
}

export function parseRekordboxXml(xmlString: string): { tracks: Partial<TrackModel>[]; rawVersion: string } {
  let djPlaylists: any = null;
  let trackElements: any[] = [];

  if (typeof DOMParser !== 'undefined') {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlString, 'text/xml');

    const parserError = xmlDoc.querySelector('parsererror');
    if (parserError) {
      throw new Error('Invalid Rekordbox XML structure: ' + parserError.textContent);
    }

    djPlaylists = xmlDoc.querySelector('DJ_PLAYLISTS');
    trackElements = Array.from(xmlDoc.querySelectorAll('COLLECTION > TRACK'));
  } else {
    // Node.js fallback
    const root = parseXmlFallback(xmlString);
    djPlaylists = root.querySelector('DJ_PLAYLISTS');
    const collection = djPlaylists ? djPlaylists.querySelector('COLLECTION') : root.querySelector('COLLECTION');
    trackElements = collection ? collection.querySelectorAll('TRACK') : root.querySelectorAll('TRACK');
  }

  const rawVersion = djPlaylists?.getAttribute('Version') || '1.0.0';
  const tracks: Partial<TrackModel>[] = trackElements.map((el, idx) => parseSingleTrackNode(el, idx));

  return { tracks, rawVersion };
}

/**
 * Asynchronous, non-blocking chunked Rekordbox XML parser.
 * Yields control to the event loop every 30 tracks so the UI never hangs,
 * while streaming real-time status and telemetry for maximum transparency.
 */
export async function parseRekordboxXmlAsync(
  xmlString: string,
  onProgress?: (progress: XmlImportProgress) => void
): Promise<{ tracks: Partial<TrackModel>[]; rawVersion: string }> {
  const logs: string[] = ['[Start] Starte Rekordbox XML-Verarbeitung...'];
  
  onProgress?.({
    phase: 'READING',
    phaseText: 'Lese XML-Dokument ein & prüfe Wurzelelemente...',
    processedTracks: 0,
    totalTracks: 0,
    percent: 10,
    memoryCuesFound: 0,
    hotCuesFound: 0,
    loopsFound: 0,
    logMessages: [...logs],
  });

  // Yield to render progress modal
  await new Promise((r) => setTimeout(r, 20));

  let djPlaylists: any = null;
  let trackElements: any[] = [];

  if (typeof DOMParser !== 'undefined') {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlString, 'text/xml');
    const parserError = xmlDoc.querySelector('parsererror');
    if (parserError) {
      throw new Error('Ungültige Rekordbox-XML-Struktur: ' + parserError.textContent);
    }
    djPlaylists = xmlDoc.querySelector('DJ_PLAYLISTS');
    trackElements = Array.from(xmlDoc.querySelectorAll('COLLECTION > TRACK'));
  } else {
    const root = parseXmlFallback(xmlString);
    djPlaylists = root.querySelector('DJ_PLAYLISTS');
    const collection = djPlaylists ? djPlaylists.querySelector('COLLECTION') : root.querySelector('COLLECTION');
    trackElements = collection ? collection.querySelectorAll('TRACK') : root.querySelectorAll('TRACK');
  }

  const rawVersion = djPlaylists?.getAttribute('Version') || '1.0.0';
  const total = trackElements.length;
  logs.push(`[Schema] Rekordbox Version ${rawVersion} erkannt.`);
  logs.push(`[Collection] ${total} Tracks in der Bibliothek gefunden.`);

  onProgress?.({
    phase: 'PARSING_XML',
    phaseText: `Verarbeite ${total} Tracks mit phasenstarrer Rekordbox-Analyse...`,
    processedTracks: 0,
    totalTracks: total,
    percent: 20,
    memoryCuesFound: 0,
    hotCuesFound: 0,
    loopsFound: 0,
    logMessages: [...logs],
  });

  await new Promise((r) => setTimeout(r, 20));

  const tracks: Partial<TrackModel>[] = [];
  let totalMemoryCues = 0;
  let totalHotCues = 0;
  let totalLoops = 0;

  // A larger chunk limits React progress updates for multi-thousand-track
  // libraries, while still yielding regularly to keep the interface usable.
  const chunkSize = 100;
  for (let i = 0; i < total; i += chunkSize) {
    const end = Math.min(i + chunkSize, total);
    for (let j = i; j < end; j++) {
      const parsed = parseSingleTrackNode(trackElements[j], j, false);
      tracks.push(parsed);

      const memCount = (parsed.cues || []).filter((c) => c.type === 'MEMORY').length;
      const hotCount = (parsed.cues || []).filter((c) => c.type === 'HOT_CUE').length;
      const loopCount = (parsed.loops || []).length;
      totalMemoryCues += memCount;
      totalHotCues += hotCount;
      totalLoops += loopCount;
    }

    const currentTrackName = tracks[tracks.length - 1]?.title;
    const progressPercent = Math.min(95, 20 + Math.round((end / total) * 75));

    if (end % 50 === 0 || end === total) {
      logs.push(`[Progress] Track ${end}/${total} analysiert: "${currentTrackName}" (${totalMemoryCues} Memory Cues, ${totalHotCues} Hot Cues)`);
    }

    onProgress?.({
      phase: 'EXTRACTING_TRACKS',
      phaseText: `Extrahiere Beatgrids & Cues: ${end} von ${total} Tracks (${progressPercent}%)`,
      processedTracks: end,
      totalTracks: total,
      percent: progressPercent,
      currentTrackName,
      memoryCuesFound: totalMemoryCues,
      hotCuesFound: totalHotCues,
      loopsFound: totalLoops,
      logMessages: [...logs.slice(-15)],
    });

    // Yield control to UI thread so render loop stays fluid
    await new Promise((r) => setTimeout(r, 0));
  }

  logs.push(`[Erfolg] ${tracks.length} Tracks vollständig importiert.`);
  logs.push(`[Garantie] Originaldateien bleiben 100% unverändert (Read-Only).`);

  onProgress?.({
    phase: 'COMPLETE',
    phaseText: `Import erfolgreich abgeschlossen (${tracks.length} Tracks)`,
    processedTracks: total,
    totalTracks: total,
    percent: 100,
    memoryCuesFound: totalMemoryCues,
    hotCuesFound: totalHotCues,
    loopsFound: totalLoops,
    logMessages: [...logs.slice(-15)],
  });

  return { tracks, rawVersion };
}

/**
 * Serializes Track Model and edits to Pioneer Rekordbox XML format
 */
export function exportToRekordboxXml(track: TrackModel): string {
  const bg = track.beatGrid;
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0">
  <PRODUCT Name="rekordbox" Version="7.0.0" Company="AlphaTheta"/>
  <COLLECTION Entries="1">
    <TRACK TrackID="${escapeXml(track.id)}" Name="${escapeXml(track.title)}" Artist="${escapeXml(track.artist)}" Album="${escapeXml(track.album)}" TotalTime="${Math.round(track.duration)}" AverageBpm="${track.bpm.toFixed(2)}" Tonality="${escapeXml(track.key)}">
      <TEMPO Inizio="${bg.firstBeat.toFixed(3)}" Bpm="${bg.bpm.toFixed(2)}" Metro="4/4" Battito="1"/>
${track.cues
  .map((c) => {
    const isHotCue = c.type === 'HOT_CUE';
    const num = isHotCue ? (c.hotCueNum ?? 0) : -1;
    return `      <POSITION_MARK Name="${escapeXml(c.name)}" Type="0" Start="${c.position.toFixed(3)}" Num="${num}" Red="0" Green="162" Blue="255"/>`;
  })
  .join('\n')}
${track.loops
  .map(
    (l) =>
      `      <POSITION_MARK Name="${escapeXml(l.name)}" Type="4" Start="${l.start.toFixed(3)}" End="${l.end.toFixed(3)}" Num="-1"/>`
  )
  .join('\n')}
    </TRACK>
  </COLLECTION>
</DJ_PLAYLISTS>`;
  return xml;
}

function escapeXml(unsafe: string): string {
  return unsafe.replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
      default: return c;
    }
  });
}

/**
 * Bundled default Rekordbox XML dataset representing "Terminator (Original Mix)"
 * exactly as presented in the authoritative screenshots.
 */
export const DEFAULT_REKORDBOX_XML = `<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0">
  <PRODUCT Name="rekordbox" Version="7.0.0" Company="AlphaTheta"/>
  <COLLECTION Entries="2">
    <TRACK TrackID="1" Name="Terminator (Original Mix)" Artist="Sound Beats" Album="Terminator EP" TotalTime="326" AverageBpm="130.00" Tonality="2A" BitRate="320" SampleRate="44100" Comments="Visual Locked Reference Track" DateAdded="2026-09-04">
      <TEMPO Inizio="0.000" Bpm="130.00" Metro="4/4" Battito="1"/>
      <POSITION_MARK Name="First Beat" Type="0" Start="0.000" Num="-1" Red="255" Green="120" Blue="0"/>
      <POSITION_MARK Name="Intro Beat" Type="0" Start="0.000" Num="0" Red="0" Green="162" Blue="255"/>
      <POSITION_MARK Name="Drop 1" Type="0" Start="14.769" Num="1" Red="255" Green="50" Blue="50"/>
      <POSITION_MARK Name="Breakdown" Type="0" Start="44.307" Num="-1" Red="255" Green="200" Blue="0"/>
      <POSITION_MARK Name="Main Drop" Type="0" Start="59.076" Num="2" Red="0" Green="230" Blue="100"/>
      <POSITION_MARK Name="Loop 8 Bars" Type="4" Start="14.769" End="29.538" Num="-1"/>
    </TRACK>
    <TRACK TrackID="2" Name="Hyperdrive (Club Edit)" Artist="Cyber Pulse" Album="Pulse Sessions" TotalTime="284" AverageBpm="128.00" Tonality="4A" BitRate="320" SampleRate="44100" Comments="High energy club remix" DateAdded="2026-09-04">
      <TEMPO Inizio="0.000" Bpm="128.00" Metro="4/4" Battito="1"/>
      <POSITION_MARK Name="Intro Kick" Type="0" Start="0.000" Num="0" Red="0" Green="162" Blue="255"/>
      <POSITION_MARK Name="Synth Hook" Type="0" Start="15.000" Num="1" Red="255" Green="200" Blue="0"/>
      <POSITION_MARK Name="Vocal Outro" Type="0" Start="60.000" Num="-1" Red="255" Green="50" Blue="50"/>
    </TRACK>
  </COLLECTION>
</DJ_PLAYLISTS>`;
