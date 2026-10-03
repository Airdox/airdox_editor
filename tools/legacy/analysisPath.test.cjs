'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { resolveAnalysisFiles } = require('./analysisPath.cjs');

// Dein echtes Layout (Windows)
const root = 'D:\\PIONEER\\Master\\share';
let r = resolveAnalysisFiles(root, '/PIONEER/USBANLZ/ab1/23456/ANLZ0000.DAT', path.win32);
assert.equal(r.ok, true);
assert.equal(r.dat, 'D:\\PIONEER\\Master\\share\\PIONEER\\USBANLZ\\ab1\\23456\\ANLZ0000.DAT');
assert.equal(r.ext, 'D:\\PIONEER\\Master\\share\\PIONEER\\USBANLZ\\ab1\\23456\\ANLZ0000.EXT');
assert.equal(r.ex2, 'D:\\PIONEER\\Master\\share\\PIONEER\\USBANLZ\\ab1\\23456\\ANLZ0000.2EX');

// Backslashes in der DB, Kleinschreibung der Endung
r = resolveAnalysisFiles(root, '\\PIONEER\\USBANLZ\\x\\y\\ANLZ0000.dat', path.win32);
assert.equal(r.ok, true);
assert.equal(r.ext, 'D:\\PIONEER\\Master\\share\\PIONEER\\USBANLZ\\x\\y\\ANLZ0000.EXT');

// Fehlerfaelle ohne Fallback
assert.equal(resolveAnalysisFiles(root, '', path.win32).code, 'ANALYSIS_DATA_PATH_MISSING');
assert.equal(resolveAnalysisFiles('', '/a/b.DAT', path.win32).code, 'ANALYSIS_ROOT_MISSING');
assert.equal(resolveAnalysisFiles(root, '/PIONEER/../../Windows/x.DAT', path.win32).code, 'ANALYSIS_DATA_PATH_UNSAFE');

console.log('analysisPath: alle Tests bestanden');
