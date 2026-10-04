/**
 * Computes a real SHA-256 digest for the complete input byte sequence.
 * Uses Web Crypto in both the browser and the secure Electron renderer.
 */
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('Web Crypto SHA-256 is unavailable in this runtime.');
  }

  const digest = await subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
