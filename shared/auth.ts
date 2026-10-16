// Local password, invites and unlock backoff (canonico §9, §11).
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
