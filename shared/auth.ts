// Local password, invite codes, key derivation and unlock backoff (canonico §9, §11; SP02).
// Pure logic: only WebCrypto, TextEncoder, btoa/atob. No tjs, tiny or DOM.
// Signatures: docs/arquitetura.md §3.

import type { PasswordHash } from './types';

export const PBKDF2_ITERATIONS = 600_000;

const ALGORITHM = 'PBKDF2-SHA256' as const;
const SALT_LENGTH = 16;
const HASH_BITS = 256;
const CODE_BYTES = 32;
const WAIT_CAP_MS = 15 * 60 * 1000;
const FAILURES_WITHOUT_WAIT = 4;

// ------------------------------------------------------------- base64 (helpers)

// Type note (TypeScript 6): a bare `Uint8Array` is `Uint8Array<ArrayBufferLike>`, which WebCrypto
// does not accept as `BufferSource`. Whoever PRODUCES bytes (decoding, `TextEncoder`,
// `getRandomValues`, `deriveBits`) returns `Uint8Array<ArrayBuffer>`; whoever only reads bytes
// accepts any `Uint8Array`.

function bytesToBinary(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return binary;
}

function binaryToBytes(binary: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}

// ------------------------------------------------------------- derivation

async function derive(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    HASH_BITS,
  );
  return new Uint8Array(bits);
}

/** Constant-time compare: accumulated XOR over every byte. */
function equalInConstantTime(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

// ------------------------------------------------------------- keys (SP02 §1)

/**
 * The three 32-byte keys SP02 §1 derives from one password. Raw bytes on purpose: each side encodes
 * what its own wire or storage needs (`base64url(authKey)` in the host calls, `SHA-256(localKey)` in
 * the local unlock check) and the derivation stays one definition.
 */
export interface DerivedKeys {
  /** Sent to the host on activation and sign-in; there it becomes `argon2id(authKey)` (SP02 §2). */
  authKey: Uint8Array<ArrayBuffer>;
  /** Never leaves the machine: it encrypts each vault value before the keychain (SP02 §8). */
  vaultKey: Uint8Array<ArrayBuffer>;
  /** Offline unlock check: `base64url(SHA-256(localKey))` is the `check` of `PasswordHashV2` (SP02 §6). */
  localKey: Uint8Array<ArrayBuffer>;
}

/** SP02 §1: one HMAC-SHA256 label per key. Changing a label changes every key derived from it. */
const KEY_LABELS = {
  authKey: 'bond/auth/v1',
  vaultKey: 'bond/vault/v1',
  localKey: 'bond/local/v1',
} as const;

/** HMAC-SHA256(key, UTF-8 data) → 32 bytes. */
async function hmac(key: Uint8Array<ArrayBuffer>, data: string): Promise<Uint8Array<ArrayBuffer>> {
  const imported = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', imported, new TextEncoder().encode(data));
  return new Uint8Array(signature);
}

/**
 * `deriveKeys(password, salt, iterations) → { authKey, vaultKey, localKey }` (SP02 §1).
 *
 * One PBKDF2 per unlock or sign-in, then three cheap HMACs over `master`. The password is Unicode
 * NFC before it becomes UTF-8 bytes, so an NFD input derives the same keys as its NFC form. Only
 * `crypto.subtle`, so the bytes are the same in the host (Bun) and in the Bond backend (txiki.js):
 * the pinned vectors of `test/auth.test.ts` are derived again in the Bond runtime by the smoke
 * (`test/smoke/run.ts`).
 */
export async function deriveKeys(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<DerivedKeys> {
  const master = await derive(password.normalize('NFC'), salt, iterations);
  return {
    authKey: await hmac(master, KEY_LABELS.authKey),
    vaultKey: await hmac(master, KEY_LABELS.vaultKey),
    localKey: await hmac(master, KEY_LABELS.localKey),
  };
}

// ------------------------------------------------------------- passwords

export async function hashPassword(
  password: string,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<PasswordHash> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const hash = await derive(password, salt, iterations);
  return {
    algorithm: ALGORITHM,
    hash: btoa(bytesToBinary(hash)),
    salt: btoa(bytesToBinary(salt)),
    iterations,
  };
}

export async function verifyPassword(password: string, h: PasswordHash): Promise<boolean> {
  if (h.algorithm !== ALGORITHM) return false;
  const salt = binaryToBytes(atob(h.salt));
  const expected = binaryToBytes(atob(h.hash));
  const obtained = await derive(password, salt, h.iterations);
  return equalInConstantTime(expected, obtained);
}

export function validateNewPassword(password: string): string | null {
  if (password.length < 8) return 'password must be at least 8 characters';
  return null;
}

// ------------------------------------------------------------- invites

export function generateInviteCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_BYTES));
  return btoa(bytesToBinary(bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export async function hashInviteCode(code: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code));
  return bytesToHex(new Uint8Array(digest));
}

export function inviteIsValid(
  i: { expiresAt: string; usedAt: string | null },
  now: Date,
): boolean {
  return i.usedAt === null && new Date(i.expiresAt) > now;
}

// ------------------------------------------------------------- backoff

export function unlockWait(failures: number): number {
  if (failures <= FAILURES_WITHOUT_WAIT) return 0;
  return Math.min(1000 * 2 ** (failures - 5), WAIT_CAP_MS);
}
