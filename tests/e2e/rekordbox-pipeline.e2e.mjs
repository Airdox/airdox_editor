/**
 * End-to-end proof for the merged Rekordbox pipeline:
 * real app build served by Vite dev server, a simulated rekordboxDesktop
 * bridge that serves a fake master.db (rows) + REAL binary ANLZ containers
 * (generated with the repo's own Deep-Symmetry-conform fixtures).
 *
 * Verifies (with screenshots):
 *   1. Track 101 (ID contract: XML TrackID == djmdContent.ID + exact path)
 *      → ANLZ waveform buckets rendered.
 *   2. Track 999 (foreign XML TrackID, unique exact path contract from the
 *      restored 52af2dc pipeline) → ANLZ waveform buckets rendered.
 *   3. Track 777 (no DB row at all) → visible pipeline error, NO waveform,
 *      no substitution.
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const APP_URL = 'http://127.0.0.1:3000/';
const OUT = '/home/user/airdox_editor/docs/e2e-proof';
fs.mkdirSync(OUT, { recursive: true });

const datB64 = fs.readFileSync('/tmp/e2e/ANLZ0000.DAT').toString('base64');
const extB64 = fs.readFileSync('/tmp/e2e/ANLZ0000.EXT').toString('base64');
const xmlText = fs.readFileSync('/tmp/e2e/collection.xml', 'utf8');

const browser = await puppeteer.launch({
  headless: 'shell', executablePath: '/tmp/chromium',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--autoplay-policy=no-user-gesture-required'],
  defaultViewport: { width: 1600, height: 900 },
});
const page = await browser.newPage();

const consoleLines = [];
page.on('console', (msg) => consoleLines.push(`[${msg.type()}] ${msg.text()}`));
page.on('dialog', async (dialog) => {
  consoleLines.push(`[ALERT] ${dialog.message()}`);
  await dialog.accept();
});

// ---- Simulated desktop bridge: fake master.db + REAL ANLZ binaries ----
await page.evaluateOnNewDocument((datB64, extB64) => {
  const b64ToU8 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const DAT = b64ToU8(datB64);
  const EXT = b64ToU8(extB64);
  const DB_DIR = 'D:\\PIONEER\\Master';
  const ANLZ_DAT = DB_DIR + '\\share\\PIONEER\\USBANLZ\\0e8\\u1\\ANLZ0000.DAT';
  const ANLZ_EXT = DB_DIR + '\\share\\PIONEER\\USBANLZ\\0e8\\u1\\ANLZ0000.EXT';

  // master.db rows: ID 101 matches XML TrackID 101 (ID contract).
  // ID 555 shares the exact audio path of XML TrackID 999 (path contract).
  const content = [
    {
      ID: 101, Title: 'Obsidian Voltage (Club Mix)', ArtistID: 1, AlbumID: 1,
      BPM: 12800, Length: 240000, FolderPath: 'D:\\Music\\Klangfeld\\Obsidian Voltage.wav',
      FileNameL: 'Obsidian Voltage.wav', AnalysisDataPath: '/PIONEER/USBANLZ/0e8/u1/ANLZ0000.DAT',
      SampleRate: 44100, Rating: 255,
    },
    {
      ID: 555, Title: 'Foreign-ID Roller', ArtistID: 2, AlbumID: 2,
      BPM: 12800, Length: 240000, FolderPath: 'D:\\Music\\Subsonic\\Foreign ID Roller.wav',
      FileNameL: 'Foreign ID Roller.wav', AnalysisDataPath: '/PIONEER/USBANLZ/0e8/u1/ANLZ0000.DAT',
      SampleRate: 44100, Rating: 204,
    },
  ];

  window.rekordboxDesktop = {
    inspectLocation: async (location) => ({
      validLocation: true, exists: false, reason: 'E2E: kein reales Audio nötig', accessMode: 'READ_ONLY',
    }),
    readOriginalAudio: async () => { throw new Error('E2E: Original-Audio absichtlich nicht verfügbar (kein Ersatz erlaubt)'); },
    readAnalysisFile: async (filePath) => {
      const p = String(filePath);
      if (p === ANLZ_DAT) return { data: DAT.slice(), path: p, size: DAT.length, modifiedAt: Date.now(), accessMode: 'READ_ONLY' };
      if (p === ANLZ_EXT) return { data: EXT.slice(), path: p, size: EXT.length, modifiedAt: Date.now(), accessMode: 'READ_ONLY' };
      throw new Error('ENOENT: ' + p);
    },
    appendLog: async () => true,
    getLogFilePath: async () => null,
    revealLogFile: async () => false,
    chooseRekordboxDatabase: async () => null,
    locateRekordboxDatabases: async () => ([
      { path: DB_DIR + '\\master.db', kind: 'MASTER_DB', label: 'master.db (E2E-Fixture)', appVer: '7.2.16' },
    ]),
    readRekordboxDatabase: async (dbPath) => ({
      available: true, dbType: 'MASTER_DB', filePath: dbPath, fileName: 'master.db',
      stats: { tracks: content.length, cues: 0, playlists: 0 },
      warnings: [],
      rows: { content, cues: [], artists: [
        { ID: 1, Name: 'Klangfeld' }, { ID: 2, Name: 'Subsonic Pulse' },
      ], albums: [], genres: [], keys: [], labels: [], playlists: [], songPlaylists: [] },
    }),
    saveExportFile: async () => ({ saved: false }),
    openProjectFile: async () => null,
  };
}, datB64, extB64);

await page.goto(APP_URL, { waitUntil: 'networkidle2', timeout: 120000 });
await new Promise((r) => setTimeout(r, 2500));
await page.screenshot({ path: `${OUT}/01-app-start.png` });

// ---- Import the XML collection via the hidden file input ----
const xmlInput = await page.$('input[type=file][accept=".xml"]');
if (!xmlInput) throw new Error('XML file input not found');
// Create a DataTransfer-backed file directly in the page:
await page.evaluate((text) => {
  const input = document.querySelector('input[type=file][accept=".xml"]');
  const file = new File([text], 'e2e-collection.xml', { type: 'text/xml' });
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}, xmlText);

// Wait for the collection modal to open (auto after import)
await page.waitForFunction(
  () => document.body.innerText.includes('Rekordbox Track-Auswahl'),
  { timeout: 30000 }
);
await new Promise((r) => setTimeout(r, 800));
await page.screenshot({ path: `${OUT}/02-collection-modal.png` });

async function loadTrackByTitle(title) {
  await page.evaluate((t) => {
    const rows = Array.from(document.querySelectorAll('tr, [role=row], div'));
    const el = rows.find((r) => r.textContent && r.textContent.includes(t) && r.tagName === 'TR');
    if (!el) throw new Error('Row not found: ' + t);
    el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  }, title);
  await new Promise((r) => setTimeout(r, 3000));
}

async function openCollection() {
  const open = await page.evaluate(() => document.body.innerText.includes('Rekordbox Track-Auswahl'));
  if (open) return;
  // Re-open via re-dispatching the change event is not needed: the app keeps
  // xmlImportedTracks; reuse the same file input to reopen the modal.
  await page.evaluate((text) => {
    const input = document.querySelector('input[type=file][accept=".xml"]');
    const file = new File([text], 'e2e-collection.xml', { type: 'text/xml' });
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, xmlText);
  await page.waitForFunction(
    () => document.body.innerText.includes('Rekordbox Track-Auswahl'),
    { timeout: 30000 }
  );
  await new Promise((r) => setTimeout(r, 800));
}


async function dismissFeedback() {
  try {
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const ok = btns.find((b) => b.textContent.trim() === 'OK');
      if (ok) ok.click();
    });
    await new Promise((r) => setTimeout(r, 600));
  } catch {}
}

const results = {};

// ---- Case 1: ID contract (TrackID 101 == djmdContent.ID 101 + exact path) ----
await loadTrackByTitle('Obsidian Voltage (Club Mix)');
await dismissFeedback();
results.case1 = await page.evaluate(() => document.body.innerText);
await page.screenshot({ path: `${OUT}/03-track101-id-contract.png` });
const case1Log = consoleLines.filter((l) => l.includes('Track-Link') || l.includes('ANLZ Auto') || l.includes('DB Auto'));

// ---- Case 2: unique exact path contract (foreign TrackID 999 → DB row 555) ----
await openCollection();
await loadTrackByTitle('Foreign-ID Roller');
await dismissFeedback();
results.case2 = await page.evaluate(() => document.body.innerText);
await page.screenshot({ path: `${OUT}/04-track999-path-contract.png` });

// ---- Case 3: no DB row → visible pipeline error, no waveform ----
await openCollection();
await loadTrackByTitle('Unbekannter Track (nicht in master.db)');
results.case3 = await page.evaluate(() => document.body.innerText);
await page.screenshot({ path: `${OUT}/05-track777-pipeline-error.png` });

await browser.close();

// ---- Assertions ----
const errors = [];
const linkLines = consoleLines.filter((l) => l.includes('[Track-Link]'));
const anlzLines = consoleLines.filter((l) => l.includes('[ANLZ Auto]'));
const alertLines = consoleLines.filter((l) => l.startsWith('[ALERT]'));

function expect(cond, label) {
  if (cond) console.log('  [PASS]', label);
  else { console.log('  [FAIL]', label); errors.push(label); }
}

console.log('\n=== E2E ASSERTIONS ===');
expect(linkLines.some((l) => l.includes('ID-Vertrag') && l.includes('101')),
  'Case 1: track 101 linked via ID contract (djmdContent.ID + exact path)');
expect(anlzLines.some((l) => l.includes('ANLZ0000.DAT')),
  'Case 1/2: ANLZ container read through master.db AnalysisDataPath');
expect(results.case1.includes('BUCKETS'),
  'Case 1: DetailWaveform footer shows genuine ANLZ bucket count');
expect(!results.case1.includes('MISSING_REKORDBOX_ANALYSIS'),
  'Case 1: no missing-analysis marker');

expect(linkLines.some((l) => l.includes('Pfadvertrag') && l.includes('555')),
  'Case 2: track 999 linked via unique exact path contract to DB row 555');
expect(results.case2.includes('BUCKETS'),
  'Case 2: DetailWaveform footer shows genuine ANLZ bucket count');

expect(alertLines.some((l) => l.includes('Pipelinefehler') && l.includes('Unbekannter Track')),
  'Case 3: visible pipeline error for the track without a DB row');
expect(results.case3.includes('MISSING_REKORDBOX_ANALYSIS') || !results.case3.includes('Unbekannter Track (nicht in master.db)'),
  'Case 3: no waveform substituted (deck unchanged or honest empty state)');

fs.writeFileSync(`${OUT}/console-log.txt`, consoleLines.join('\n'));
console.log(`\nScreenshots + console log written to ${OUT}`);
if (errors.length) { console.log('\nE2E FAILED:', errors.length, 'assertion(s)'); process.exit(1); }
console.log('\nE2E PASSED: merged pipeline verified end-to-end.');
