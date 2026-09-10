/**
 * @license
 * App version injected at build time by Vite (define: __APP_VERSION__),
 * sourced from package.json — never drifts out of sync.
 */
export const APP_VERSION: string =
  typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';

/** Git-Short-Hash des Builds (leer ausserhalb eines Git-Checkouts). */
export const APP_COMMIT: string =
  typeof __APP_COMMIT__ !== 'undefined' ? __APP_COMMIT__ : '';

/** Anzeigefassung: "0.4.20+7fbeb31" – unterscheidet Builds gleicher Version. */
export const APP_BUILD: string = APP_COMMIT ? `${APP_VERSION}+${APP_COMMIT}` : APP_VERSION;
