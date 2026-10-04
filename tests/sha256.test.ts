import assert from 'node:assert/strict';
import { sha256Hex } from '../src/utils/sha256.ts';

async function runSha256Tests() {
  const empty = new Uint8Array(0).buffer;
  const abc = new TextEncoder().encode('abc').buffer as ArrayBuffer;
  const changed = new TextEncoder().encode('abd').buffer as ArrayBuffer;

  assert.equal(
    await sha256Hex(empty),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    'empty byte sequence matches the SHA-256 standard vector'
  );
  assert.equal(
    await sha256Hex(abc),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    'all bytes match the SHA-256 standard vector for "abc"'
  );
  assert.notEqual(await sha256Hex(abc), await sha256Hex(changed), 'changing one source byte changes the digest');

  console.log('sha256: full-byte SHA-256 matches standard vectors');
}

void runSha256Tests();
