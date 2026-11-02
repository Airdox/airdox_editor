const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MAX_SOURCE_BYTES = 100 * 1024 * 1024;
const MAX_STAGED_SOURCES = 8;
const MAX_STAGED_BYTES = 2 * MAX_SOURCE_BYTES;
const MAX_SNAPSHOT_BYTES = 6 * MAX_SOURCE_BYTES + 64 * 1024;

function validateSource(source) {
  if (!source || typeof source.path !== 'string' || !source.path.trim() || source.path.includes('\0')) {
    throw new Error('Invalid XML source path.');
  }
  if (typeof source.data !== 'string' || !source.data.length) throw new Error('Invalid XML source data.');
  const bytes = Buffer.byteLength(source.data, 'utf8');
  if (bytes > MAX_SOURCE_BYTES) throw new Error('XML source exceeds the 100 MiB limit.');
  if (source.modifiedAt !== undefined && (!Number.isFinite(source.modifiedAt) || source.modifiedAt < 0)) {
    throw new Error('Invalid XML source modification time.');
  }
  return bytes;
}

function hash(data) {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

function result(source, sourceToken) {
  return { data: source.data, path: source.path, modifiedAt: source.modifiedAt, sourceToken };
}

class ActiveXmlLibrary {
  #snapshotPath;
  #staged = new Map();
  #stageOrder = new Map();
  #stagedBytes = 0;
  #activating = false;

  constructor(snapshotPath) {
    if (typeof snapshotPath !== 'string' || !snapshotPath.trim() || snapshotPath.includes('\0')) {
      throw new Error('Invalid active XML snapshot path.');
    }
    this.#snapshotPath = path.resolve(snapshotPath);
  }

  stage(source) {
    const bytes = validateSource(source);
    if (path.resolve(source.path) === this.#snapshotPath) throw new Error('XML source and app snapshot must be separate files.');
    const sourceToken = hash(source.data);
    this.#removeStage(sourceToken, source.path);
    while (this.#stageOrder.size >= MAX_STAGED_SOURCES || this.#stagedBytes + bytes > MAX_STAGED_BYTES) {
      const [oldest, token] = this.#stageOrder.entries().next().value;
      this.#removeStage(token, oldest.path);
    }
    const copy = { data: source.data, path: source.path, modifiedAt: source.modifiedAt, bytes };
    if (!this.#staged.has(sourceToken)) this.#staged.set(sourceToken, new Map());
    this.#staged.get(sourceToken).set(source.path, copy);
    this.#stageOrder.set(copy, sourceToken);
    this.#stagedBytes += bytes;
    return result(copy, sourceToken);
  }

  #removeStage(sourceToken, sourcePath) {
    const byPath = this.#staged.get(sourceToken);
    const source = byPath?.get(sourcePath);
    if (!source) return;
    byPath.delete(sourcePath);
    if (!byPath.size) this.#staged.delete(sourceToken);
    this.#stageOrder.delete(source);
    this.#stagedBytes -= source.bytes;
  }

  activate(sourcePath, sourceToken, beforeCommit) {
    if (this.#activating) throw new Error('An XML snapshot activation is already in progress.');
    if (typeof sourceToken !== 'string' || !/^[a-f0-9]{64}$/.test(sourceToken)) throw new Error('Invalid XML source token.');
    const source = this.#staged.get(sourceToken)?.get(sourcePath);
    if (!source || hash(source.data) !== sourceToken) throw new Error('Unknown or expired staged XML source, or token mismatch. Re-read the XML source.');
    if (beforeCommit !== undefined && (typeof beforeCommit !== 'function' || beforeCommit.constructor?.name === 'AsyncFunction')) {
      throw new Error('beforeCommit must be a synchronous function.');
    }
    this.#activating = true;
    let temporary;
    let descriptor;
    try {
      if (beforeCommit) {
        const returned = beforeCommit();
        if (returned && typeof returned.then === 'function') {
          Promise.resolve(returned).catch(() => {});
          throw new Error('beforeCommit must be synchronous.');
        }
      }
      const snapshot = JSON.stringify({ data: source.data, sourcePath: source.path, hash: sourceToken, mtime: source.modifiedAt ?? null });
      fs.mkdirSync(path.dirname(this.#snapshotPath), { recursive: true });
      temporary = `${this.#snapshotPath}.${randomUUID()}.tmp`;
      descriptor = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(descriptor, snapshot, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporary, this.#snapshotPath);
      temporary = undefined;
      this.#removeStage(sourceToken, sourcePath);
      return result(source, sourceToken);
    } finally {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch {}
      }
      if (temporary) {
        try { fs.unlinkSync(temporary); } catch {}
      }
      this.#activating = false;
    }
  }

  read() {
    let descriptor;
    try {
      try {
        descriptor = fs.openSync(this.#snapshotPath, 'r');
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || stat.size > MAX_SNAPSHOT_BYTES) throw new Error('Invalid active XML snapshot size.');
      const snapshot = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
      if (!snapshot || typeof snapshot !== 'object' || !Object.hasOwn(snapshot, 'mtime') ||
          (snapshot.mtime !== null && (!Number.isFinite(snapshot.mtime) || snapshot.mtime < 0))) {
        throw new Error('Invalid active XML snapshot metadata.');
      }
      const source = { data: snapshot.data, path: snapshot.sourcePath, modifiedAt: snapshot.mtime ?? undefined };
      validateSource(source);
      if (path.resolve(source.path) === this.#snapshotPath || typeof snapshot.hash !== 'string' ||
          !/^[a-f0-9]{64}$/.test(snapshot.hash) || hash(source.data) !== snapshot.hash) {
        throw new Error('Active XML snapshot hash mismatch or invalid source.');
      }
      return result(source, snapshot.hash);
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }
}

module.exports = { ActiveXmlLibrary };
