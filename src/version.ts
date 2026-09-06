/**
 * @license
 * Application version constants (single source of truth: package.json).
 *
 * The values are injected at build time by Vite (see vite.config.ts). Keep the
 * version number in `package.json` — the CHANGELOG.md documents what changed
 * between versions (Semantic Versioning: MAJOR.MINOR.PATCH).
 */

export const APP_NAME = 'Airdox Smart Editor';
export const APP_VERSION = __APP_VERSION__;
export const APP_BUILD_TIME = __APP_BUILD_TIME__;

/** Short human-readable label, e.g. "v0.2.0". */
export const APP_VERSION_LABEL = `v${APP_VERSION}`;
