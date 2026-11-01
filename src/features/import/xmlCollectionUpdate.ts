import { parseRekordboxXmlAsync, unescapeXml } from '../../rekordbox/xmlParser';
import { buildCollectionTrackModel } from '../project/projectModel';
import { DataOrigin, type TrackModel } from '../../types/rekordbox';

export interface XmlFileSource { data: string; path: string; modifiedAt?: number }
export interface XmlUpdateBridge {
  chooseXmlFile?: () => Promise<{ path: string } | null>;
  readXmlFile?: (path: string) => Promise<XmlFileSource>;
}
export interface XmlCollectionUpdate {
  tracks: TrackModel[];
  sourceLabel: string;
  modifiedAt?: number;
}
export type XmlUpdateCommit = (tracks: TrackModel[], sourceLabel: string) => void | Promise<void>;

export function getXmlTrackIdentity(track: Pick<TrackModel, 'originalSha256' | 'originalMedia'>): string | null {
  if (/^[a-f0-9]{64}$/i.test(track.originalSha256)) return `sha256:${track.originalSha256.toLowerCase()}`;
  let path = track.originalMedia?.location?.trim();
  if (!path) return null;
  try {
    if (/^file:/i.test(path)) {
      const url = new URL(path);
      path = `${url.hostname && url.hostname !== 'localhost' ? `//${url.hostname}` : ''}${decodeURIComponent(url.pathname)}`;
    }
  } catch { return null; }
  path = path.replace(/\\/g, '/').replace(/^\/([a-z]:\/)/i, '$1');
  if (/^[a-z]:\//i.test(path) || path.startsWith('//')) path = path.toLowerCase();
  return `path:${path}`;
}

function validateCollection(xml: string): { xml: string; ids: string[] } {
  const fail = (): never => { throw new Error('Ungültige Rekordbox-XML: DJ_PLAYLISTS/COLLECTION und eindeutige TrackIDs erforderlich.'); };
  if (typeof xml !== 'string' || !xml.trim()) fail();
  if (typeof DOMParser !== 'undefined') {
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    if (doc.querySelector('parsererror')) fail();
  }
  const clean = xml.replace(/^\uFEFF/, '').replace(/<!--[\s\S]*?-->|<\?[\s\S]*?\?>/g, '');
  const tokens = /<\/[A-Za-z_][\w.:-]*\s*>|<[A-Za-z_][\w.:-]*(?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*\s*\/?>/g;
  const stack: string[] = [];
  const ids: string[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let roots = 0;
  let collections = 0;
  for (const match of clean.matchAll(tokens)) {
    if (clean.slice(offset, match.index).trim()) fail();
    offset = match.index! + match[0].length;
    const token = match[0];
    const name = /^<\/?([\w.:-]+)/.exec(token)![1];
    if (token.startsWith('</')) {
      if (stack.pop() !== name) fail();
      continue;
    }
    const attrs = new Map<string, string>();
    for (const attr of token.matchAll(/([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      if (attrs.has(attr[1])) fail();
      const value = attr[2] ?? attr[3];
      if (/&(?!(?:amp|quot|apos|lt|gt|#\d+|#x[\da-fA-F]+);)/.test(value)) fail();
      attrs.set(attr[1], unescapeXml(value).replace(/&#(x[\da-fA-F]+|\d+);/g, (_, n: string) => {
        const code = n.startsWith('x') ? parseInt(n.slice(1), 16) : Number(n);
        if (code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) fail();
        return String.fromCodePoint(code);
      }));
    }
    if (!stack.length && (++roots !== 1 || name !== 'DJ_PLAYLISTS')) fail();
    if (name === 'COLLECTION') {
      if (stack.length !== 1 || stack[0] !== 'DJ_PLAYLISTS' || ++collections !== 1) fail();
    }
    if (stack.includes('COLLECTION') && name === 'TRACK') {
      if (stack.length !== 2 || stack[1] !== 'COLLECTION') fail();
      const id = attrs.get('TrackID')?.trim();
      if (!id || seen.has(id)) fail();
      seen.add(id!);
      ids.push(id!);
    } else if (stack.at(-1) === 'COLLECTION') fail();
    if (!token.endsWith('/>')) stack.push(name);
  }
  if (clean.slice(offset).trim() || stack.length || roots !== 1 || collections !== 1) fail();
  return { xml: clean, ids };
}

export async function prepareXmlCollectionUpdate(source: XmlFileSource): Promise<XmlCollectionUpdate> {
  if (!source?.path?.trim()) throw new Error('Keine XML-Quelle ausgewählt.');
  const validated = validateCollection(source.data);
  const parsed = await parseRekordboxXmlAsync(validated.xml);
  if (parsed.tracks.length !== validated.ids.length) throw new Error('XML-Trackanzahl stimmt nicht überein.');
  const tracks = parsed.tracks.map((track, index) => buildCollectionTrackModel({
    ...track,
    id: validated.ids[index],
    originalSha256: track.originalSha256 || '',
  }, index, DataOrigin.REKORDBOX_XML));
  for (const track of tracks) track.originalSha256 = '';
  return { tracks, sourceLabel: source.path, modifiedAt: source.modifiedAt };
}

export async function readXmlCollectionUpdate(path: string | undefined, bridge: XmlUpdateBridge): Promise<XmlCollectionUpdate> {
  if (!path?.trim()) throw new Error('Keine XML-Quelle ausgewählt.');
  if (!bridge.readXmlFile) throw new Error('XML-Datei kann nicht gelesen werden. Bitte erneut auswählen.');
  const source = await bridge.readXmlFile(path);
  if (!source || source.path !== path) throw new Error('Die gelesene XML-Quelle stimmt nicht mit der Auswahl überein.');
  return prepareXmlCollectionUpdate(source);
}

export async function commitXmlCollectionUpdate(update: XmlCollectionUpdate, onUpdate: XmlUpdateCommit): Promise<void> {
  await onUpdate(update.tracks, update.sourceLabel);
}
