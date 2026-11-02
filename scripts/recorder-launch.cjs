// Keep GUI-process output on real file descriptors. PowerShell GUI invocation can
// return early and close pipes; production logging must never inherit that pipe.
const { spawn } = require('node:child_process');
const { openSync, closeSync } = require('node:fs');
const path = require('node:path');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const out = openSync(path.resolve(__dirname, '../reports/recorder-app-stdout.log'), 'a');
const err = openSync(path.resolve(__dirname, '../reports/recorder-app-stderr.log'), 'a');
const child = spawn(require('electron'), [path.resolve(__dirname, 'recorder-real-roundtrip.cjs'), ...process.argv.slice(2)], {
  cwd: path.resolve(__dirname, '..'), env, windowsHide: false, stdio: ['ignore', out, err],
});
console.log(`Production recorder process PID ${child.pid}; stdout/stderr retained in reports/recorder-app-{stdout,stderr}.log`);
child.once('error', error => { console.error(error); process.exitCode=1; });
child.once('exit', code => { closeSync(out); closeSync(err); console.log(`Production recorder process exit ${code}`); process.exitCode=code===0?0:1; });
