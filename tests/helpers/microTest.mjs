/**
 * One micro test engine for the script suites (`tests/*.test.ts`, `tests/*.test.mjs`).
 *
 * Why: every script suite used to carry its own ~15-line `results / runTest /
 * assert / footer` block. Five slightly different variants of the same thing meant
 * a fix (timing output, exit code, failure text) had to be applied five times, and
 * a suite could silently report nothing. Same contract, one implementation — while
 * the suites stay *scripts*: they are deliberately runnable with `npx tsx <suite>`
 * and with plain `node` for the electron `.mjs` suites, no bundler, no test runner
 * daemon, and `tests/run-all.mjs` still decides pass/fail by the exit code.
 *
 * Component and workflow suites keep using vitest (`tests/ui`, `tests/workflow`,
 * `tests/unit`) — they need jsdom, coverage and the react renderer.
 *
 * Usage in a suite:
 *   import { runTest, assert, near, report } from './helpers/microTest.mjs';
 *   runTest('Gruppe', 'K1: was geprüft wird', () => { assert(1 === 1, 'grund'); });
 *   report();                      // prints the summary, sets the exit code
 *
 * `report()` must be called last; `tests/test-registry.test.ts` guards that every
 * script suite does, so a suite cannot degenerate into "0 cases, all green".
 */

/** @typedef {{ group?: string, name: string, fn: () => void | Promise<void> }} TestCase */
/** @typedef {{ name: string, passed: boolean, ms: number, error?: string }} TestOutcome */

/** @type {TestCase[]} */
const cases = [];

let title = 'SKRIPT-SUITE';

/** Optional heading printed above the case list (default: SKRIPT-SUITE). */
export function suite(name) {
  title = String(name);
}

/**
 * Register a case. Two call shapes: `runTest(name, fn)` or `runTest(group, name, fn)`.
 * @overload
 * @param {string} name
 * @param {() => void | Promise<void>} fn
 * @returns {void}
 * @overload
 * @param {string} group
 * @param {string} name
 * @param {() => void | Promise<void>} fn
 * @returns {void}
 */
export function runTest(a, b, c) {
  if (typeof b === 'function') cases.push({ name: String(a), fn: b });
  else cases.push({ group: String(a), name: String(b), fn: /** @type {() => void} */ (c) });
}

/** Alias, same semantics as `runTest`. */
export const test = runTest;

/** @param {unknown} condition @param {string} message */
export function assert(condition, message) {
  if (!condition) throw new Error(`Assertion Failed: ${message}`);
}

/**
 * Float comparison with a tolerance (the audio/second maths is never exact).
 * @param {number} actual @param {number} expected @param {string} message @param {number} [tolerance]
 */
export function near(actual, expected, message, tolerance = 1e-6) {
  if (!(Math.abs(actual - expected) <= tolerance)) {
    throw new Error(`Assertion Failed: ${message} — erwartet ${expected}, erhalten ${actual} (±${tolerance})`);
  }
}

/**
 * Strict identity check (numbers, strings, ids) — the message names both sides.
 * @param {unknown} actual @param {unknown} expected @param {string} message
 */
export function same(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`Assertion Failed [${message}]: erwartet ${expected}, erhalten ${actual}`);
  }
}

/**
 * Deep comparison of plain data (ids, span lists, serialized shapes).
 * @param {unknown} actual @param {unknown} expected @param {string} message
 */
export function eq(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`Assertion Failed: ${message}\n    erwartet: ${b}\n    erhalten: ${a}`);
}

/** @param {() => unknown} fn @param {string} message */
export function throws(fn, message) {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  if (!threw) throw new Error(`Assertion Failed: ${message} — erwarteter Fehler blieb aus`);
}

/** @type {TestOutcome[]} */
const outcomes = [];
let reported = false;

/**
 * Runs every registered case, prints the summary and sets `process.exitCode`.
 * A failing case never stops the others — the report has to show the whole picture.
 */
export async function report(heading) {
  if (heading) title = String(heading);
  reported = true;
  let failures = 0;
  /** Ordered output: group heading, then its cases — never headings first. */
  const out = [];
  let lastGroup;
  for (const testCase of cases) {
    if (testCase.group !== lastGroup) {
      if (testCase.group) out.push(`\n  [${testCase.group}]`);
      lastGroup = testCase.group;
    }
    const started = Date.now();
    try {
      await testCase.fn();
      outcomes.push({ name: displayName(testCase), passed: true, ms: Date.now() - started });
      out.push(`    \x1b[32m✓\x1b[0m ${displayName(testCase)} [${(Date.now() - started).toFixed(1)} ms]`);
    } catch (err) {
      failures += 1;
      const message = err && /** @type {{ message?: string }} */ (err).message
        ? /** @type {{ message: string }} */ (err).message
        : String(err);
      outcomes.push({ name: displayName(testCase), passed: false, ms: Date.now() - started, error: message });
      out.push(`    \x1b[31m✗\x1b[0m ${displayName(testCase)} [${(Date.now() - started).toFixed(1)} ms] — ${message.split('\n').join('\n      ')}`);
    }
  }
  const passed = outcomes.length - failures;
  console.log('\n' + '═'.repeat(70));
  console.log(`  ${title}`);
  console.log('═'.repeat(70));
  for (const line of out) console.log(line);
  console.log('\n' + '─'.repeat(70));
  console.log(`  Total: ${outcomes.length} | Bestanden: ${passed} | Fehlgeschlagen: ${failures}`);
  console.log('─'.repeat(70) + '\n');
  process.exitCode = failures ? 1 : 0;
  return failures;
}

function displayName(testCase) {
  return testCase.group ? `${testCase.group} → ${testCase.name}` : testCase.name;
}

/**
 * Last-resort alarm: a suite that registers cases but never reports them would
 * exit 0 with no output, i.e. look green while testing nothing.
 */
process.on('exit', () => {
  if (!reported && cases.length > 0) {
    console.error('\n  ✗ report() wurde nicht aufgerufen — Fälle registriert, aber nicht ausgeführt.\n');
    process.exitCode = 1;
  }
});
