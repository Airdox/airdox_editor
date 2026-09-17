# Logging System

## Overview

Main logger `electron/logger.cjs` + renderer `src/utils/logger.ts` merged into same daily file.

Location:
- Production: `%APPDATA%/airdox_SMART_Editor/logs/airdox-editor-YYYY-MM-DD.log`
- Dev: `logs/airdox-editor-YYYY-MM-DD.log`

## Features

- Daily rotation, session header with pid, platform, version
- Retention 14d via `AIRDOX_LOG_RETENTION_DAYS` env (default 14)
- Level via `AIRDOX_LOG_LEVEL` env (debug, info, warn, error)
- Secret redaction: apiKey, GEMINI_API_KEY, password, token, secret, authorization → [REDACTED]
- Binary summarization: Buffer, Uint8Array, ArrayBuffer → {__binary, byteLength}
- IPC audit: logs args as {__binary, byteLength} and redacts secrets
- Renderer ingestion via `logs:write` IPC or POST /api/logs
- Console/fetch/XHR capture in renderer
- Flush on error/pagehide via `before-quit` and `pagehide` events
- Process handlers: uncaughtException, unhandledRejection

## Usage

Main:
```js
const logger = require('./electron/logger.cjs');
logger.configureLogger({ app, level: 'info' });
logger.info('Message', { meta });
logger.error('Error', { error: err.message });
logger.ingestRendererEntries(entries, app);
```

Renderer:
```ts
import { logger } from '../utils/logger';
logger.info('UI event', { detail });
logger.error('Failed', { error });
```

## IPC

- `logs:write` – renderer sends entries
- `logs:get-path` – get current log file path
- Legacy: `log:append`, `log:get-path`

## Audit

All IPC handlers wrapped via `auditIpc` wrapper that logs call, args (summarized), duration, success/failure.
