/**
 * Golden read-only Rekordbox chain regression.
 *
 * The fixture models the bytes returned after Electron has read one selected
 * `D:\\...\\master.db` row.  It proves ContentID → AnalysisDataPath → exact
 * DAT/EXT/2EX siblings → tagged ANLZ → normalized waveform → render model;
 * no audio buffer or generated metadata is involved.
 */
import { generateRealAnlzDatFixture, generateRealAnlzExtFixture } from './fixtures/testDatasets';
import { applyAnlzExtractionToTrack } from '../src/rekordbox/databaseExtractor';
import {
  decodeRekordboxAnalysisFiles,
  isCurrentTrackAnalysisRequest,
  RekordboxTrackAnalysisReadResult,
} from '../src/rekordbox/analysisPipeline';
import { mapRekordboxDatabaseRows, buildDeckTrackFromDatabase } from '../src/rekordbox/dbParser';
import { selectTrackWaveform } from '../src/waveform/renderModel';
import { DataOrigin } from '../src/types/rekordbox';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

const dbRow = {
  ID: '4242',
  Title: 'Golden D Drive Track',
  ArtistID: '1',
  AlbumID: '2',
  GenreID: '3',
  BPM: 12800,
  Length: 240000,
  FolderPath: 'D:\\Music\\Golden',
  FileNameL: 'Golden D Drive Track.wav',
  AnalysisDataPath: '/PIONEER/USBANLZ/P001/00004242/ANLZ0000.DAT',
  SampleRate: 44100,
};

const rows = {
  content: [dbRow], cues: [],
  artists: [{ ID: '1', Name: 'Fixture Artist' }],
  albums: [{ ID: '2', Name: 'Fixture Album' }],
  genres: [{ ID: '3', Name: 'Techno' }],
  keys: [], labels: [], playlists: [], songPlaylists: [],
};

const goldenResponse: RekordboxTrackAnalysisReadResult = {
  available: true,
  stage: 'COMPLETE',
  root: 'D:\\',
  masterDbPath: 'D:\\PIONEER\\Master\\master.db',
  contentId: '4242',
  analysisDataPath: dbRow.AnalysisDataPath,
  resolvedAnalysisFile: 'D:\\PIONEER\\Master\\share\\PIONEER\\USBANLZ\\P001\\00004242\\ANLZ0000.DAT',
  resolvedAnalysisDirectory: 'D:\\PIONEER\\Master\\share\\PIONEER\\USBANLZ\\P001\\00004242',
  audioPath: 'D:\\Music\\Golden\\Golden D Drive Track.wav',
  files: [
    {
      kind: 'DAT', status: 'FOUND',
      path: 'D:\\PIONEER\\Master\\share\\PIONEER\\USBANLZ\\P001\\00004242\\ANLZ0000.DAT',
      data: generateRealAnlzDatFixture(128),
    },
    {
      kind: 'EXT', status: 'FOUND',
      path: 'D:\\PIONEER\\Master\\share\\PIONEER\\USBANLZ\\P001\\00004242\\ANLZ0000.EXT',
      data: generateRealAnlzExtFixture(128),
    },
    {
      kind: '2EX', status: 'NOT_FOUND',
      path: 'D:\\PIONEER\\Master\\share\\PIONEER\\USBANLZ\\P001\\00004242\\ANLZ0000.2EX',
    },
  ],
  warnings: [],
};

console.log('REKORDBOX GOLDEN D: MASTER.DB → ANLZ PIPELINE');

const mapping = mapRekordboxDatabaseRows(rows, 'MASTER_DB');
assert(mapping.tracks.length === 1, 'master.db djmdContent row maps once');
assert(mapping.tracks[0].id === goldenResponse.contentId, 'ContentID is retained from djmdContent.ID');
assert(mapping.tracks[0].rawXmlAttributes?.analysisDataPath === goldenResponse.analysisDataPath, 'AnalysisDataPath is retained');

const decoded = decodeRekordboxAnalysisFiles(goldenResponse.files);
assert(decoded.decodedFiles.length === 2, 'exact DAT and EXT snapshots decode');
assert(decoded.skippedFiles.length === 1 && decoded.skippedFiles[0].kind === '2EX', 'absent 2EX is explicit');
assert(decoded.extraction?.tagsFound.includes('PQTZ'), 'DAT beat grid tag found');
assert(decoded.extraction?.tagsFound.includes('PWV5'), 'DAT waveform tag found');
assert(decoded.extraction?.tagsFound.includes('PWV7'), 'EXT detail waveform tag found');
assert(decoded.extraction?.waveform?.sourceTag === 'PWV7', 'highest-detail genuine waveform wins');
assert(decoded.extraction?.waveform?.origin === DataOrigin.REKORDBOX_ANLZ, 'source remains ANLZ');

const deck = buildDeckTrackFromDatabase(mapping.tracks[0]);
const enriched = applyAnlzExtractionToTrack(deck, decoded.extraction!);
const waveformForUi = selectTrackWaveform(enriched, enriched.duration, 1280);
assert(enriched.analysis?.origin === DataOrigin.REKORDBOX_ANLZ, 'analysis model receives genuine source');
assert(waveformForUi && waveformForUi.length > 0, 'existing waveform renderer receives visible columns');
assert(waveformForUi?.sourceTag === 'PWV7', 'renderer chooses genuine detailed ANLZ variant');

// The selection guard makes a late Track A result unable to overwrite Track B.
assert(!isCurrentTrackAnalysisRequest(10, 11), 'late Track A result is rejected');
assert(isCurrentTrackAnalysisRequest(11, 11), 'current Track B result is accepted');

const empty = decodeRekordboxAnalysisFiles([{ kind: 'DAT', status: 'NOT_FOUND' }]);
assert(!empty.extraction?.waveform, 'missing ANLZ has no synthetic waveform fallback');

console.log('PASS  ContentID → AnalysisDataPath → DAT/EXT/2EX → FourCC → PWV7 → existing UI');
