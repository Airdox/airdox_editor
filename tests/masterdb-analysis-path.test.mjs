/** D:\ root guard for master.db AnalysisDataPath semantics (pure CJS reader). */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { resolveAnalysisDataPathOnD } = require('../electron/dbReader.cjs');

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}
function equal(actual, expected, message) {
  assert(actual === expected, `${message}; expected ${expected}, got ${actual}`);
}

const db = 'D:\\PIONEER\\Master\\master.db';
const relative = '/PIONEER/USBANLZ/P001/äöü long name/ANLZ0000.DAT';
const expected = 'D:\\PIONEER\\Master\\share\\PIONEER\\USBANLZ\\P001\\äöü long name\\ANLZ0000.DAT';

console.log('MASTER.DB ANALYSISDATAPATH D: ROOT GUARD');
const resolved = resolveAnalysisDataPathOnD(db, relative);
equal(resolved.path, expected, 'relative USBANLZ is derived from selected master.db/share');
equal(resolved.reason, null, 'valid D: path has no diagnostic error');

equal(
  resolveAnalysisDataPathOnD(db, 'D:/PIONEER/Master/share//PIONEER/USBANLZ/P001/ANLZ0000.EXT').path,
  'D:\\PIONEER\\Master\\share\\PIONEER\\USBANLZ\\P001\\ANLZ0000.EXT',
  'absolute D: slash and duplicate separator normalization'
);
assert(!resolveAnalysisDataPathOnD(db, 'C:\\Users\\dj\\ANLZ0000.DAT').path, 'C: never becomes an implicit root');
assert(!resolveAnalysisDataPathOnD('C:\\Pioneer\\master.db', relative).path, 'master.db outside D: is rejected');
assert(!resolveAnalysisDataPathOnD(db, '/PIONEER/USBANLZ/../outside/ANLZ0000.DAT').path, '.. traversal is rejected');
assert(!resolveAnalysisDataPathOnD(db, '/PIONEER/USBANLZ/P001/no-extension').path, 'extension is validated');
assert(!resolveAnalysisDataPathOnD(db, '/not-pioneer/ANLZ0000.DAT').path, 'unrecognised relative path is not guessed');
assert(!resolveAnalysisDataPathOnD(db, '').path, 'missing AnalysisDataPath is explicit');

console.log('PASS  D:\\ only; Unicode, slash variants, traversal and foreign drives covered');
