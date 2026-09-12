/**
 * @license
 * Component & workflow test runner (vitest + jsdom).
 *
 * The long-standing `tests/*.test.ts` harnesses run as plain scripts through tsx
 * (they stay untouched and keep guarding the Rekordbox data contract). Vitest
 * exists for what a script cannot do: render the real React components in a DOM,
 * drive their events, and measure coverage of the whole renderer.
 */
import react from '@vitejs/plugin-react';

// No `defineConfig` wrapper on purpose: vitest ships its own copy of vite, and
// that duplicate `Plugin` type makes the project's react plugin fail tsc — the
// config object itself is accepted as-is. The shape is asserted by the tests
// running (see `tests/test-registry.test.ts` for the suite inventory guard).
export default {
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify('test'),
  },
  test: {
    environment: 'jsdom',
    // Threads (not forks) on purpose: `npm run coverage` wraps BOTH test styles in
    // one V8 coverage run, and worker threads share the process' coverage output —
    // a forked pool would silently report the component layer as untested.
    pool: 'threads',
    setupFiles: ['tests/setup/ui.ts'],
    include: [
      'tests/ui/**/*.test.tsx',
      'tests/ui/**/*.test.ts',
      'tests/workflow/**/*.test.ts',
      'tests/unit/**/*.test.ts',
    ],
    // The canvas render loops arm requestAnimationFrame continuously; without
    // this, teardown would keep timers pending and the run would hang.
    restoreMocks: true,
    unstubGlobals: true,
    testTimeout: 20000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html', 'lcov'],
      reportsDirectory: 'coverage',
      all: true,
      include: ['src/**'],
      exclude: ['src/**/*.d.ts'],
    },
  },
};
