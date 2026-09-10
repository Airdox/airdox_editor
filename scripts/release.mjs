#!/usr/bin/env node
/**
 * @license
 * Unified version bump for airdox_SMART_Editor (see docs/VERSIONIERUNG.md).
 *
 * Usage:
 *   node scripts/release.mjs <patch|minor|major> [--no-tag] [--message "…"]
 *
 *   patch   Bugfixes / kleine Anpassungen            (0.5.0 → 0.5.1)
 *   minor   Neue Funktionen                          (0.5.0 → 0.6.0)
 *   major   Grundlegende Änderungen / Brüche         (0.5.0 → 1.0.0)
 *
 * What this script guarantees (the rules of the unified schema):
 *   1. Exactly ONE version change per release commit.
 *   2. Strict semver format MAJOR.MINOR.PATCH in package.json — the single
 *      source of truth (UI via Vite define, exe names via ${version}).
 *   3. A new version number for every release — never reuses an existing
 *      tag (vX.Y.Z must not exist yet).
 *   4. Release commit "chore(release): vX.Y.Z" + git tag vX.Y.Z in one step.
 *
 * Afterwards: `git push origin <branch> && git push origin vX.Y.Z` —
 * the tag triggers the Windows build + GitHub Release in CI.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = (args) =>
  execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
    .toString()
    .trim();

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

// ─── Argument parsing ──────────────────────────────────────────────────────
const args = process.argv.slice(2);
const bump = args[0];
const noTag = args.includes('--no-tag');
const messageIndex = args.indexOf('--message');
const message = messageIndex >= 0 ? args[messageIndex + 1] : null;

if (!['patch', 'minor', 'major'].includes(bump)) {
  fail('Usage: node scripts/release.mjs <patch|minor|major> [--no-tag] [--message "…"]');
}
if (messageIndex >= 0 && !message) {
  fail('--message requires a value');
}

// ─── Read + validate current version ───────────────────────────────────────
const pkgPath = path.join(root, 'package.json');
const raw = fs.readFileSync(pkgPath, 'utf8');
let pkg;
try {
  pkg = JSON.parse(raw);
} catch (err) {
  fail(`package.json is not valid JSON: ${err.message}`);
}
const current = pkg.version;
if (typeof current !== 'string' || !/^\d+\.\d+\.\d+$/.test(current)) {
  fail(
    `Current version ${JSON.stringify(current)} is not strict semver MAJOR.MINOR.PATCH — ` +
      'fix package.json before releasing (docs/VERSIONIERUNG.md).',
  );
}
const [major, minor, patch] = current.split('.').map(Number);
const next =
  bump === 'major' ? `${major + 1}.0.0`
  : bump === 'minor' ? `${major}.${minor + 1}.0`
  : `${major}.${minor}.${patch + 1}`;
const tag = `v${next}`;

// ─── Never reuse a released version number ─────────────────────────────────
if (!noTag) {
  try {
    git(['rev-parse', '-q', '--verify', `refs/tags/${tag}`]);
    fail(
      `Tag ${tag} exists already — version numbers are never reused. ` +
        'Bump again (or remove the tag if it was a mistake: git tag -d ' + tag + ' && git push origin :refs/tags/' + tag + ').',
    );
  } catch {
    // Tag does not exist — good, we may use the number.
  }
}

// ─── Write the single version change ───────────────────────────────────────
pkg.version = next;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
console.log(`✓ Version bumped: ${current} → ${next} (${bump})`);

// ─── Release commit ────────────────────────────────────────────────────────
git(['add', 'package.json']);
const commitMessage = `chore(release): ${tag}` + (message ? ` — ${message}` : '');
git(['commit', '-m', commitMessage]);
console.log(`✓ Release commit: ${commitMessage}`);

// ─── Tag ───────────────────────────────────────────────────────────────────
if (noTag) {
  console.log('ℹ No tag created (--no-tag).');
} else {
  git(['tag', tag]);
  console.log(`✓ Tag created: ${tag}`);
}

// ─── Next steps ────────────────────────────────────────────────────────────
console.log('\nNext steps:');
console.log('  git push origin <branch>');
if (!noTag) {
  console.log(`  git push origin ${tag}   # triggers Windows build + GitHub Release in CI`);
}
