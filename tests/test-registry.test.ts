/**
 * @license
 * Test registry guard.
 *
 * Two runners coexist on purpose: standalone script suites (tsx) for the data
 * contract, and vitest (jsdom) for components and workflow scenarios. The `test`
 * script in package.json lists the script suites by hand, which is exactly the
 * kind of list that silently rots — so this suite fails when a test file exists
 * that no runner executes, and when a runner entry points at a missing file.
 *
 * Run with: npx tsx tests/test-registry.test.ts
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runTest, assert, report } from './helpers/microTest.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const testScript: string = pkg.scripts.test as string;

function walk(dir: string, acc: string[] = []): string[] {
  const abs = join(root, dir);
  if (!existsSync(abs)) return acc;
  for (const entry of readdirSync(abs)) {
    const full = join(abs, entry);
    if (statSync(full).isDirectory()) walk(relative(root, full), acc);
    else if (/\.test\.(ts|mts|mjs|tsx)$/.test(entry)) acc.push(relative(root, full).split('\\').join('/'));
  }
  return acc;
}

const allTests = walk('tests').sort();

/**
 * Which directories vitest owns is read from vitest.config.ts itself, so the
 * guard, the runner and the config can never drift apart again.
 */
const vitestConfig = existsSync(join(root, 'vitest.config.ts'))
  ? readFileSync(join(root, 'vitest.config.ts'), 'utf8')
  : '';
const vitestDirs = [...vitestConfig.matchAll(/'(tests\/[^']+?)\/\*\*/g)].map((m) => m[1]);
assert(vitestDirs.length > 0, 'vitest.config.ts deklariert keine test.include-Verzeichnisse');
const isVitestOwned = (f: string) =>
  f.endsWith('.tsx') || vitestDirs.some((dir) => f.startsWith(dir + '/'));

const scriptTests = allTests.filter((f) => !isVitestOwned(f));
const vitestTests = allTests.filter((f) => isVitestOwned(f));
/** The runner is asked twice (list + vitest dirs); cache it for readable asserts. */
function listed() {
  if (!__listed) {
    const res = spawnSync(process.execPath, [join(root, 'tests', 'run-all.mjs'), '--list'], {
      cwd: root,
      encoding: 'utf8',
    });
    __listed = res.status === 0 ? JSON.parse(res.stdout) : { vitestDirs: [] };
  }
  return __listed;
}
let __listed: any = null;
function listedVitestDirs(payload: any): string[] {
  return (payload?.vitestDirs ?? []).map((f: string) => f.split('\\').join('/'));
}

runTest('T1: npm test delegates to the discovering runner (no hand-maintained suite list)', () => {
  assert(
    /node\s+tests\/run-all\.mjs/.test(testScript),
    'package.json "test" muss tests/run-all.mjs aufrufen — eine von Hand gepflegte Suiten-Kette veraltet genau in dem Moment, in dem eine neue Datei dazukommt'
  );
  for (const key of ['test:script', 'test:ui', 'test:all']) {
    assert(typeof pkg.scripts[key] === 'string', `npm script "${key}" fehlt — die getrennten Messeebenen brauchen eigene Einstiege`);
  }
});

runTest('T2: the runner discovers every script suite on disk', () => {
  const res = spawnSync(process.execPath, [join(root, 'tests', 'run-all.mjs'), '--list'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert(res.status === 0, `tests/run-all.mjs --list lief nicht: ${res.stderr || res.stdout}`);
  const listed = JSON.parse(res.stdout);
  const discovered = new Set<string>(
    (listed.scriptTests as string[]).map((f) => f.split('\\').join('/'))
  );
  const missing = scriptTests.filter((f) => !discovered.has(f));
  assert(
    missing.length === 0,
    `vom Runner nicht entdeckt: ${missing.join(', ')} — die Suite würde bei npm test nie laufen`
  );
  const phantom = [...discovered].filter((f) => !existsSync(join(root, f)));
  assert(phantom.length === 0, `der Runner listet fehlende Dateien: ${phantom.join(', ')}`);
  assert(
    discovered.size === scriptTests.length,
    `Runner-Liste (${discovered.size}) weicht von den Skript-Suiten auf der Platte (${scriptTests.length}) ab — doppelte oder übersehene Datei`
  );
});

runTest('T3: vitest owns the component and workflow suites and its config finds them', () => {
  assert(existsSync(join(root, 'vitest.config.ts')), 'vitest.config.ts fehlt');
  assert(vitestDirs.length >= 3, `vitest-Config erklärt nur ${vitestDirs.length} Verzeichnisse — erwartet werden Komponenten-, Workflow- und Unit-Verzeichnis`);
  for (const dir of vitestDirs) {
    assert(existsSync(join(root, dir)), `vitest-Config verweist auf ein fehlendes Verzeichnis: ${dir}`);
    const found = readdirSync(join(root, dir)).filter((f) => /\.test\.tsx?$/.test(f));
    assert(found.length > 0, `${dir} enthält keine Suite — entweder löschen oder Dateien nachziehen`);
    assert(
      listedVitestDirs(listed()).includes(dir),
      `${dir} wird vom Runner nicht als vitest-Eigentum erkannt — dortige Suiten würden doppelt (als Skript) laufen`
    );
  }
  assert(
    vitestTests.every(isVitestOwned),
    'Komponenten-/Workflow-Suiten gehören in ein von vitest erklärtes Verzeichnis — sonst findet sie kein Runner'
  );
});

runTest('T4: measurement entry points agree with the runner', () => {
  const runner = readFileSync(join(root, 'tests', 'run-all.mjs'), 'utf8');
  const merge = readFileSync(join(root, 'tests', 'coverage-summary.mjs'), 'utf8');
  assert(runner.includes('--import'), 'run-all.mjs muss die Skript-Suiten mit dem tsx-Loader starten');
  assert(runner.includes('--only=script') && runner.includes('--only=vitest'), 'run-all.mjs braucht die beiden Mess-Ebenen');
  for (const mode of ['script', 'vitest']) {
    assert(merge.includes(mode), `coverage-summary.mjs nutzt die Runner-Ebene "${mode}" nicht mehr — die getrennte Messung wäre ausgehöhlt`);
  }
  assert(typeof pkg.scripts['test:all'] === 'string', 'npm run test:all fehlt');
  assert(typeof pkg.scripts['coverage'] === 'string', 'npm run coverage fehlt');
  assert(!/\.test\.(ts|mjs|tsx)/.test(testScript), 'package.json "test" verzeichnet weiterhin Suiten von Hand (Dateinamen in der Kette)');
});

runTest('T5: one micro engine for the script suites (kein privater TestRing mehr)', () => {
  // Why: every script suite used to carry its own ~15-line results/runTest/assert/
  // footer block — five variants of the same thing, so a fix had to be applied five
  // times and a suite could report nothing at all. The shared engine is
  // tests/helpers/microTest.mjs; `.mjs` suites that only use node:assert directly are
  // fine (they define no framework), a hand-rolled ring is not.
  const PRIVATE_RING = /const results: TestResult\[\] = \[\];|^function runTest\(/m;
  const offenders = scriptTests.filter((file) => PRIVATE_RING.test(readFileSync(join(root, file), 'utf8')));
  assert(
    offenders.length === 0,
    `Suiten mit eigenem Test-Ring (bitte tests/helpers/microTest.mjs benutzen): ${offenders.join(', ')}`
  );
  const tsSuites = scriptTests.filter((file) => file.endsWith('.ts'));
  const noEngine = tsSuites.filter((file) => !readFileSync(join(root, file), 'utf8').includes('microTest.mjs'));
  assert(noEngine.length === 0, `.ts-Suiten ohne geteilte Engine (würden ohne report() unsichtbar grün): ${noEngine.join(', ')}`);
  const noReport = tsSuites.filter((file) => !/(^|\n)report\(/.test(readFileSync(join(root, file), 'utf8')));
  assert(noReport.length === 0, `.ts-Suiten ohne report()-Aufruf (Fälle registriert, nie ausgeführt): ${noReport.join(', ')}`);
});

report('TEST REGISTRY GUARD');
