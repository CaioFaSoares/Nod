// Optional encrypted vault export (RF-28; canonico §11; docs/arquitetura.md §3).
// Pure logic: only WebCrypto (`crypto.subtle`, `crypto.getRandomValues`), `TextEncoder`/`TextDecoder`
// and `btoa`/`atob`. No dependency on `tjs`, `tiny` or the DOM.

import { PBKDF2_ITERATIONS } from './auth';
import type { VaultExportItem } from './types';

const ALGORITHM = 'PBKDF2-SHA256+AES-256-GCM';
const INVALID = 'wrong password or invalid file';

/** Bounds for `iter` on import: a forged file must not weaken the derivation, nor hang the backend. */
const MIN_ITERATIONS = 1_000;
const MAX_ITERATIONS = 10_000_000;

const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const BASE64_CHUNK = 0x8000;

/** Base64 of bytes, in chunks so the argument list of `String.fromCharCode` stays small. */
function bytesToBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK)));
  }
  return btoa(chunks.join(''));
}

/** `atob` throws on invalid base64 — the caller decides what to do with the failure. */
function base64ToBytes(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.trim());
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * AES-256-GCM key derived from the password with PBKDF2-SHA256 (the same derivation on export and on
 * import). The salt is `Uint8Array<ArrayBuffer>` because WebCrypto demands a `BufferSource`.
 */
async function deriveKey(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** The decrypted content is only accepted as a list of items with the four string fields. */
function parseItems(value: unknown): VaultExportItem[] {
  if (!Array.isArray(value)) throw new Error(INVALID);
  for (const item of value) {
    if (typeof item !== 'object' || item === null) throw new Error(INVALID);
    const i = item as Record<string, unknown>;
    if (
      typeof i.toolId !== 'string' ||
      typeof i.label !== 'string' ||
      typeof i.username !== 'string' ||
      typeof i.secret !== 'string'
    ) {
      throw new Error(INVALID);
    }
  }
  return value as VaultExportItem[];
}

/**
 * Builds the encrypted vault file: base64 of `{ v: 1, alg, iter, salt, nonce, ct }`, with a 16 B
 * salt, a 12 B nonce and `ct` as well as the first two in base64.
 */
export async function exportVault(
  items: VaultExportItem[],
  password: string,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const key = await deriveKey(password, salt, iterations);
  const plain = new TextEncoder().encode(JSON.stringify(items));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, plain));

  const envelope = {
    v: 1,
    alg: ALGORITHM,
    iter: iterations,
    salt: bytesToBase64(salt),
    nonce: bytesToBase64(nonce),
    ct: bytesToBase64(ct),
  };
  return bytesToBase64(new TextEncoder().encode(JSON.stringify(envelope)));
}

/**
 * Opens the encrypted file. Every failure — base64, JSON, version, algorithm, `iter` out of bounds,
 * derivation or decryption — becomes the same message, and the derivation only runs once `iter` is
 * inside `[MIN_ITERATIONS, MAX_ITERATIONS]`.
 */
export async function importVault(blob: string, password: string): Promise<VaultExportItem[]> {
  let items: unknown;
  try {
    const envelope: unknown = JSON.parse(new TextDecoder().decode(base64ToBytes(blob)));
    if (typeof envelope !== 'object' || envelope === null) throw new Error(INVALID);
    const e = envelope as Record<string, unknown>;
    if (e.v !== 1 || e.alg !== ALGORITHM) throw new Error(INVALID);
    if (
      typeof e.iter !== 'number' ||
      !Number.isInteger(e.iter) ||
      e.iter < MIN_ITERATIONS ||
      e.iter > MAX_ITERATIONS ||
      typeof e.salt !== 'string' ||
      typeof e.nonce !== 'string' ||
      typeof e.ct !== 'string'
    ) {
      throw new Error(INVALID);
    }

    const key = await deriveKey(password, base64ToBytes(e.salt), e.iter);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(e.nonce) },
      key,
      base64ToBytes(e.ct),
    );
    items = JSON.parse(new TextDecoder().decode(plain));
  } catch {
    throw new Error(INVALID);
  }
  return parseItems(items);
}
