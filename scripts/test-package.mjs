#!/usr/bin/env node
/**
 * Validates package.json is valid JSON, no duplicate keys, required scripts exist
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

async function main() {
  const path = 'package.json';
  if (!existsSync(path)) {
    console.error('package.json not found');
    process.exit(1);
  }
  const raw = await readFile(path, 'utf8');

  // Check for duplicate keys via regex scanning for "test" key duplicates
  const keyRegex = /"([^"]+)"\s*:/g;
  const seen = new Map();
  let match;
  const duplicates = [];
  // Simple approach: parse lines and track top-level keys in scripts
  // More robust: check for duplicate "test" at top level
  const testKeyCount = (raw.match(/"test"\s*:/g) || []).length;
  if (testKeyCount > 1) {
    console.error(`Duplicate "test" key found ${testKeyCount} times – invalid JSON`);
    process.exit(1);
  }

  // Try JSON parse
  let pkg;
  try {
    pkg = JSON.parse(raw);
  } catch (e) {
    console.error(`package.json invalid JSON: ${e.message}`);
    process.exit(1);
  }

  console.log('package.json valid JSON ✓');

  // Check required scripts
  const requiredScripts = ['build', 'lint', 'test:stems', 'stems:gate:notebook', 'test:package', 'build:stems-bridge'];
  const missing = requiredScripts.filter(s => !(s in (pkg.scripts || {})));
  if (missing.length) {
    console.error(`Missing required scripts: ${missing.join(', ')}`);
    process.exit(1);
  }
  console.log(`Required scripts present: ${requiredScripts.join(', ')} ✓`);

  // Check no duplicate keys in raw via simple stack (detect duplicate at same object level)
  // We already checked "test" duplication, now check overall duplicate detection via JSON parser that throws on duplicate? JS JSON.parse doesn't throw, last wins.
  // So we manually check for duplicate keys in same object using regex with object depth tracking
  // Simplified: ensure file doesn't have two identical keys in scripts section
  const scriptsSection = raw.match(/"scripts"\s*:\s*\{([\s\S]*?)\}/);
  if (scriptsSection) {
    const scriptsContent = scriptsSection[1];
    const scriptKeys = [...scriptsContent.matchAll(/"([^"]+)"\s*:/g)].map(m => m[1]);
    const dupScripts = scriptKeys.filter((k, i) => scriptKeys.indexOf(k) !== i);
    if (dupScripts.length) {
      console.error(`Duplicate keys in scripts: ${[...new Set(dupScripts)].join(', ')}`);
      process.exit(1);
    }
  }

  // Check build includes stems bridge
  if (pkg.scripts.build && !pkg.scripts.build.includes('stems-bridge')) {
    console.warn('Warning: build script should include build:stems-bridge');
  }

  console.log('test:package passed ✓');
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
