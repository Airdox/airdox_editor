/**
 * @license
 * Unified versioning schema regression suite (V1–V5).
 *
 * Enforces the single source of truth for the app version
 * (see docs/VERSIONIERUNG.md):
 *   V1  package.json holds the version in strict semver MAJOR.MINOR.PATCH
 *   V2  Vite injects it at build time (__APP_VERSION__ from package.json)
 *   V3  src/utils/appVersion.ts is a pure pass-through (no hardcoded
 *       version literal that could drift)
 *   V4  README.md / BUILD_WINDOWS.md contain no stale version numbers
 *       (only the current version or the <version> placeholder)
 *   V5  electron-builder artifact names derive from ${version}
 *
 * Run with: node tests/version-schema.test.mjs
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const pkgRaw = read('package.json');
const pkg = JSON.parse(pkgRaw);
const CURRENT = pkg.version;

let passed = 0;
let failed = 0;
function check(id, label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${id} ${label}`);
  } catch (err) {
    failed += 1;
    console.error(`  ✗ ${id} ${label}`);
    console.error(`    ${err.message}`);
  }
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('  VERSION SCHEMA CONSISTENCY (V1–V5)                         ');
console.log('═══════════════════════════════════════════════════════════════');
console.log(`  Current version: ${CURRENT}\n`);

// ─── V1: strict semver in package.json ─────────────────────────────────────
check('V1', 'package.json version is strict semver (MAJOR.MINOR.PATCH)', () => {
  assert.ok(
    typeof CURRENT === 'string' && /^\d+\.\d+\.\d+$/.test(CURRENT),
    `Version ${JSON.stringify(CURRENT)} does not match MAJOR.MINOR.PATCH`,
  );
  const [major, minor, patch] = CURRENT.split('.').map(Number);
  assert.ok(
    Number.isInteger(major) && Number.isInteger(minor) && Number.isInteger(patch) &&
      major >= 0 && minor >= 0 && patch >= 0,
    'Version parts must be non-negative integers',
  );
});

// ─── V2: Vite injects the version from package.json ────────────────────────
check('V2', 'vite.config.ts injects __APP_VERSION__ from package.json', () => {
  const vite = read('vite.config.ts');
  assert.ok(
    /__APP_VERSION__\s*:\s*JSON\.stringify/.test(vite),
    'vite.config.ts must define __APP_VERSION__ via JSON.stringify (build-time injection)',
  );
  assert.ok(
    /package\.json/.test(vite),
    'vite.config.ts must read the version from package.json (single source of truth)',
  );
});

// ─── V3: appVersion.ts is a pure pass-through ──────────────────────────────
check('V3', 'src/utils/appVersion.ts uses the injected constant (no literal)', () => {
  const av = read('src/utils/appVersion.ts');
  assert.ok(
    av.includes('__APP_VERSION__'),
    'appVersion.ts must consume the Vite-injected __APP_VERSION__ constant',
  );
  assert.ok(
    !/['"`]\d+\.\d+\.\d+['"`]/.test(av),
    'appVersion.ts must not contain a hardcoded version literal (drift risk)',
  );
});

// ─── V4: no stale version numbers in the public docs ───────────────────────
check('V4', 'README.md / BUILD_WINDOWS.md have no stale version numbers', () => {
  for (const file of ['README.md', 'BUILD_WINDOWS.md']) {
    const text = read(file);
    // Executable names must use the current version or a placeholder.
    const exeMatches = [...text.matchAll(/airdox_SMART_Editor-(\d+\.\d+\.\d+)/g)];
    for (const m of exeMatches) {
      assert.strictEqual(
        m[1],
        CURRENT,
        `${file}: stale executable version ${m[1]} (current: ${CURRENT}) — use the <version> placeholder`,
      );
    }
    // Tag examples must use the current version or a placeholder.
    const tagMatches = [...text.matchAll(/\bv(\d+\.\d+\.\d+)\b/g)];
    for (const m of tagMatches) {
      assert.strictEqual(
        m[1],
        CURRENT,
        `${file}: stale tag example v${m[1]} (current: ${CURRENT}) — use the <version> placeholder`,
      );
    }
  }
});

// ─── V5: artifact names derive from ${version} ─────────────────────────────
check('V5', 'electron-builder artifact names derive from ${version}', () => {
  const eb = JSON.stringify(pkg.build ?? pkg['electron-builder'] ?? {});
  const placeholders = (eb.match(/\$\{version\}/g) || []).length;
  assert.ok(
    placeholders >= 2,
    'Both the NSIS installer and the portable artifact must use ${version} in artifactName',
  );
});

console.log(`\n  Total: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
if (failed > 0) {
  process.exit(1);
}
