/**
 * Executes preload.cjs against a minimal Electron mock to prove its narrow
 * contextBridge API uses the exact channels registered by main.cjs.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const preloadPath = path.resolve('electron/preload.cjs');
const originalLoad = Module._load;
let exposedName = null;
let exposedApi = null;
const invoked = [];

try {
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        contextBridge: {
          exposeInMainWorld(name, api) {
            exposedName = name;
            exposedApi = api;
          },
        },
        ipcRenderer: {
          invoke(channel, ...args) {
            invoked.push({ channel, args });
            return Promise.resolve(channel);
          },
          on() {},
          removeListener() {},
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[preloadPath];
  require(preloadPath);

  assert.equal(exposedName, 'rekordboxDesktop');
  assert.equal(typeof exposedApi.appendLog, 'function');
  assert.equal(typeof exposedApi.getLogFilePath, 'function');
  assert.equal(typeof exposedApi.invoke, 'undefined', 'no generic invoke API is exposed');
  assert.equal(typeof exposedApi.ipcRenderer, 'undefined', 'ipcRenderer itself is not exposed');

  await exposedApi.appendLog({ level: 'INFO', message: 'test' });
  await exposedApi.getLogFilePath();
  assert.deepEqual(invoked.slice(-2), [
    { channel: 'rekordbox:append-log', args: [{ level: 'INFO', message: 'test' }] },
    { channel: 'rekordbox:get-log-file-path', args: [] },
  ]);
  assert.equal(invoked.some((call) => call.channel === 'log:append' || call.channel === 'log:get-path'), false);

  console.log('preload logging bridge: OK');
} finally {
  Module._load = originalLoad;
  delete require.cache[preloadPath];
}
