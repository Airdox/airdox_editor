/**
 * @license
 * App version injected at build time by Vite (define: __APP_VERSION__),
 * sourced from package.json — never drifts out of sync.
 */
export const APP_VERSION: string =
  typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';
