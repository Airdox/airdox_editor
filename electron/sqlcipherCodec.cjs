/**
 * @license
 * Rekordbox SQLCipher reader – pure JavaScript, read-only, no native dependency.
 *
 * Decrypts the page layout of SQLCipher databases (AES-256-CBC + per-page HMAC)
 * with node:crypto only, so the Windows desktop app can read `master.db` and
 * `exportLibrary.db` without Visual Studio, node-gyp or `electron-rebuild`.
 *
 * The algorithm follows the published SQLCipher sources (sqlcipher.c,
 * crypto_openssl.c) and the "legacy = 4" behaviour of SQLite3MultipleCiphers,
 * which is what Rekordbox 6/7 uses:
 *
 *   salt           = first 16 bytes of the file (they replace the SQLite magic)
 *   encryption key = PBKDF2(kdfAlgorithm, passphrase, salt, kdfIter, 32)
 *   hmac key       = PBKDF2(kdfAlgorithm, encryptionKey, salt ^ 0x3a, 2, 32)
 *   page layout    = payload | IV (16) | HMAC (digest) | padding  -> "reserve"
 *   HMAC input     = page bytes (page 1 without its salt) | IV | page number LE32
 *   payload        = AES-256-CBC, no padding, IV taken from the reserve area
 *
 * The source file is never written to: decryption happens on an in-memory copy
 * that is handed to a pure-JavaScript SQLite engine afterwards.
 */

const crypto = require('node:crypto');

const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1');
const SALT_SIZE = 16;
const KEY_SIZE = 32;
const IV_SIZE = 16;
const BLOCK_SIZE = 16;
const HMAC_SALT_MASK = 0x3a;
const FAST_KDF_ITER = 2;

const DIGEST_SIZE = { sha1: 20, sha256: 32, sha512: 64 };

/**
 * Parameter sets probed in order. Rekordbox 6/7 always matched the first entry
 * so far; the remaining ones keep older libraries and device exports readable.
 * A wrong entry can never decrypt data by accident – the per-page HMAC has to
 * match – so it is safe to probe generously.
 */
const CIPHER_CANDIDATES = [
  // PRAGMA legacy = 4: what Rekordbox 6/7 and OneLibrary use.
  { id: 'SQLCipher v4', pageSize: 4096, kdfIter: 256000, kdfAlgorithm: 'sha512', hmacAlgorithm: 'sha512', hmac: true },
  { id: 'SQLCipher v4 (1 KiB Seiten)', pageSize: 1024, kdfIter: 256000, kdfAlgorithm: 'sha512', hmacAlgorithm: 'sha512', hmac: true },
  { id: 'SQLCipher v4 (8 KiB Seiten)', pageSize: 8192, kdfIter: 256000, kdfAlgorithm: 'sha512', hmacAlgorithm: 'sha512', hmac: true },
  // PRAGMA legacy = 3 (older exports, HMAC-SHA1).
  { id: 'SQLCipher v3', pageSize: 1024, kdfIter: 64000, kdfAlgorithm: 'sha1', hmacAlgorithm: 'sha1', hmac: true },
  { id: 'SQLCipher v3 (4 KiB Seiten)', pageSize: 4096, kdfIter: 64000, kdfAlgorithm: 'sha1', hmacAlgorithm: 'sha1', hmac: true },
  { id: 'SQLCipher v3 mit SHA-512-HMAC', pageSize: 1024, kdfIter: 64000, kdfAlgorithm: 'sha512', hmacAlgorithm: 'sha512', hmac: true },
  { id: 'SQLCipher v3 mit SHA-512-HMAC (4 KiB Seiten)', pageSize: 4096, kdfIter: 64000, kdfAlgorithm: 'sha512', hmacAlgorithm: 'sha512', hmac: true },
  // PRAGMA legacy = 2 (exceedingly old exports). Unencrypted libraries – e.g.
  // from Rekordbox 5 – never reach this list: their SQLite magic is detected
  // first and they are opened directly.
  { id: 'SQLCipher v2', pageSize: 1024, kdfIter: 4000, kdfAlgorithm: 'sha1', hmacAlgorithm: 'sha1', hmac: true },
  { id: 'SQLCipher v2 (4 KiB Seiten)', pageSize: 4096, kdfIter: 4000, kdfAlgorithm: 'sha1', hmacAlgorithm: 'sha1', hmac: true },
];

/** sqlcipher_codec_ctx_reserve_setup(): IV + HMAC, rounded up to cipher blocks. */
function reserveSize(candidate) {
  if (!candidate.hmac) return IV_SIZE;
  const raw = IV_SIZE + DIGEST_SIZE[candidate.hmacAlgorithm];
  return raw % BLOCK_SIZE === 0 ? raw : (Math.floor(raw / BLOCK_SIZE) + 1) * BLOCK_SIZE;
}

/**
 * PBKDF2 for the encryption key. SQLCipher treats `PRAGMA key = 'text'` as a
 * passphrase (only the x'…' form is a raw key), and the Rekordbox constants are
 * plain strings, so the string bytes always go through the KDF.
 */
function deriveEncryptionKey(candidate, passphrase, salt, cache) {
  const cacheKey = `enc:${candidate.kdfIter}:${candidate.kdfAlgorithm}`;
  if (cache && cache.has(cacheKey)) return cache.get(cacheKey);
  const key = crypto.pbkdf2Sync(Buffer.from(passphrase, 'utf-8'), salt, candidate.kdfIter, KEY_SIZE, candidate.kdfAlgorithm);
  if (cache) cache.set(cacheKey, key);
  return key;
}

function deriveHmacKey(candidate, encryptionKey, salt, cache) {
  if (!candidate.hmac) return null;
  const cacheKey = `hmac:${candidate.kdfAlgorithm}:${candidate.kdfIter}:${salt.toString('hex')}`;
  if (cache && cache.has(cacheKey)) return cache.get(cacheKey);
  const hmacSalt = Buffer.allocUnsafe(SALT_SIZE);
  for (let i = 0; i < SALT_SIZE; i += 1) hmacSalt[i] = salt[i] ^ HMAC_SALT_MASK;
  const key = crypto.pbkdf2Sync(encryptionKey, hmacSalt, FAST_KDF_ITER, KEY_SIZE, candidate.kdfAlgorithm);
  if (cache) cache.set(cacheKey, key);
  return key;
}

function hmacOffset(pageSize, reserve) {
  return pageSize - reserve + IV_SIZE;
}

function pageHmac(candidate, hmacKey, page, pageSize, reserve, pageNumber) {
  const digest = crypto.createHmac(candidate.hmacAlgorithm, hmacKey);
  const dataStart = pageNumber === 1 ? SALT_SIZE : 0;
  // payload + initialization vector, then the page number in little endian.
  digest.update(page.subarray(dataStart, pageSize - reserve + IV_SIZE));
  const pgno = Buffer.allocUnsafe(4);
  pgno.writeUInt32LE(pageNumber >>> 0, 0);
  digest.update(pgno);
  return digest.digest();
}

function decryptPage(key, page, pageSize, reserve, dataStart = 0) {
  const payloadEnd = pageSize - reserve;
  const iv = page.subarray(payloadEnd, payloadEnd + IV_SIZE);
  const payload = page.subarray(dataStart, payloadEnd);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(payload), decipher.final()]);
}

function looksLikeSqliteHeader(page) {
  // 16/17: page size (a stored 1 means 65536), 18/19: file format versions,
  // 20: reserved bytes per page, 28: database size in pages.
  const declaredPageSize = page.readUInt16BE(16) === 1 ? 65536 : page.readUInt16BE(16);
  const writeVersion = page[18];
  const readVersion = page[19];
  const reserved = page[20];
  const declaredPageCount = page.readUInt32BE(28);
  return {
    valid:
      (writeVersion === 1 || writeVersion === 2) &&
      (readVersion === 1 || readVersion === 2) &&
      reserved < 128 &&
      declaredPageSize >= 512 &&
      declaredPageSize <= 65536 &&
      declaredPageCount >= 0,
    declaredPageSize,
    reserved,
    declaredPageCount,
  };
}

function allZero(buffer) {
  for (let i = 0; i < buffer.length; i += 1) if (buffer[i] !== 0) return false;
  return true;
}

/**
 * Decrypts a SQLCipher database into a plain SQLite buffer.
 *
 * @param {Buffer} file contents of the encrypted database file
 * @param {string} passphrase SQLCipher passphrase (the PRAGMA key value)
 * @param {{candidates?:object[]}} [options]
 * @returns {{ok:true, data:Buffer, config:object, pageSize:number, pageCount:number} |
 *           {ok:false, reason:string, tried:string[]}}
 */
function decryptDatabase(file, passphrase, options = {}) {
  const candidates = options.candidates || CIPHER_CANDIDATES;
  const keyCache = new Map();
  const tried = [];

  if (!Buffer.isBuffer(file) || file.length <= SALT_SIZE * 2) {
    return { ok: false, reason: 'Die Datei ist zu klein für eine SQLCipher-Datenbank.', tried };
  }

  if (file.subarray(0, SQLITE_MAGIC.length).equals(SQLITE_MAGIC)) {
    // Already plain SQLite: no decryption needed.
    return { ok: true, data: file, config: { id: 'Klartext-SQLite' }, pageSize: 0, pageCount: 0, plaintext: true };
  }

  const salt = Buffer.from(file.subarray(0, SALT_SIZE));

  for (const candidate of candidates) {
    const pageSize = candidate.pageSize;
    const reserve = reserveSize(candidate);
    const pageCount = Math.floor(file.length / pageSize);

    if (pageCount < 2) {
      tried.push(`${candidate.id}: Datei kleiner als zwei Seiten`);
      continue;
    }
    if (file.length % pageSize !== 0) {
      // A SQLite file always fills whole pages; skip impossible layouts before
      // burning a 256 000-iteration PBKDF2 on them.
      tried.push(`${candidate.id}: Dateigröße ist kein Vielfaches von ${pageSize} Bytes`);
      continue;
    }
    if ((pageSize - reserve) % BLOCK_SIZE !== 0 || pageSize - reserve <= SALT_SIZE + BLOCK_SIZE) {
      tried.push(`${candidate.id}: Seitenlayout nicht blockgroß`);
      continue;
    }

    let encryptionKey;
    let hmacKey;
    try {
      encryptionKey = deriveEncryptionKey(candidate, passphrase, salt, keyCache);
      hmacKey = deriveHmacKey(candidate, encryptionKey, salt, keyCache);
    } catch (error) {
      tried.push(`${candidate.id}: Schlüsselableitung fehlgeschlagen (${error.message || error})`);
      continue;
    }

    const firstPage = file.subarray(0, pageSize);
    let decryptedFirst;
    try {
      if (candidate.hmac) {
        const expected = pageHmac(candidate, hmacKey, firstPage, pageSize, reserve, 1);
        const stored = firstPage.subarray(hmacOffset(pageSize, reserve), hmacOffset(pageSize, reserve) + DIGEST_SIZE[candidate.hmacAlgorithm]);
        if (stored.length !== expected.length || !crypto.timingSafeEqual(stored, expected)) {
          tried.push(`${candidate.id}: HMAC-Prüfung von Seite 1 fehlgeschlagen`);
          continue;
        }
      }
      decryptedFirst = Buffer.concat([SQLITE_MAGIC, decryptPage(encryptionKey, firstPage, pageSize, reserve, SALT_SIZE)]);
    } catch (error) {
      tried.push(`${candidate.id}: ${error.message || error}`);
      continue;
    }

    const header = looksLikeSqliteHeader(decryptedFirst);
    if (!header.valid) {
      tried.push(`${candidate.id}: Seitenkopf nach Entschlüsselung unplausibel`);
      continue;
    }

    // Auto-vacuum databases can carry more physical pages than the header uses;
    // the header value is authoritative for what has to be decrypted.
    const lastUsedPage =
      header.declaredPageCount >= 1 && header.declaredPageCount <= pageCount ? header.declaredPageCount : pageCount;
    const out = Buffer.alloc(pageSize * lastUsedPage);
    out.set(decryptedFirst.subarray(0, Math.min(pageSize, out.length)), 0);
    // Byte 20 (reserved bytes per page) is deliberately NOT normalized: it holds
    // the reserve the source was written with, so the SQLite b-tree computes the
    // same usable page size as Rekordbox did. Verified against `sqlcipher_export`
    // output – PRAGMA integrity_check reports "ok" with it untouched.

    let failed = false;
    for (let pageNumber = 2; pageNumber <= lastUsedPage && !failed; pageNumber += 1) {
      const start = (pageNumber - 1) * pageSize;
      const page = file.subarray(start, start + pageSize);
      if (page.length !== pageSize || allZero(page)) continue; // never-written tail page
      try {
        if (candidate.hmac) {
          const expected = pageHmac(candidate, hmacKey, page, pageSize, reserve, pageNumber);
          const stored = page.subarray(hmacOffset(pageSize, reserve), hmacOffset(pageSize, reserve) + DIGEST_SIZE[candidate.hmacAlgorithm]);
          if (stored.length !== expected.length || !crypto.timingSafeEqual(stored, expected)) {
            throw new Error(`HMAC-Prüfung von Seite ${pageNumber} fehlgeschlagen (Datei verändert oder Parameter passen nicht)`);
          }
        }
        out.set(decryptPage(encryptionKey, page, pageSize, reserve), start);
      } catch (error) {
        tried.push(`${candidate.id}: ${error.message || error}`);
        failed = true;
      }
    }
    if (failed) continue;

    return {
      ok: true,
      data: out,
      config: candidate,
      reserve,
      pageSize,
      pageCount: lastUsedPage,
      // Number of whole pages physically present in the file; a difference to
      // pageCount means the source was written incompletely.
      physicalPageCount: pageCount,
      declaredPageSize: header.declaredPageSize,
      declaredReserve: header.reserved,
    };
  }

  return {
    ok: false,
    reason:
      'Die Datenbank konnte mit keinem bekannten SQLCipher-Profil entschlüsselt werden ' +
      '(falscher Schlüssel, beschädigte Datei oder kein Rekordbox-Format).',
    tried,
  };
}

module.exports = {
  CIPHER_CANDIDATES,
  SQLITE_MAGIC,
  DIGEST_SIZE,
  reserveSize,
  deriveEncryptionKey,
  deriveHmacKey,
  pageHmac,
  decryptDatabase,
  looksLikeSqliteHeader,
};
