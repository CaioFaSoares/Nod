// The two files beside the database (SP01 §1). Both are created on first boot, both live with mode
// 0600, and both are reused untouched on every later boot — a restore that lacks them makes every
// pinned Bond refuse the host (SP07 §4).
//
// Nothing here ever logs or returns a private key: the caller gets the key material in memory.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SIGNING_KEY_FILE = 'signing-key.json';
export const HOST_SECRET_FILE = 'host-secret';
export const KEY_FILE_MODE = 0o600;
export const HOST_SECRET_BYTES = 32;

/** Ed25519 key pair as JWK, plus the id the Bond pins (SP01 §1, SP04 §1). */
export type SigningKey = {
  kid: string;
  publicJwk: JsonWebKey;
  privateJwk: JsonWebKey;
};

/** A key file that exists but cannot be used: names the file, never its content. */
export class KeyFileError extends Error {}

export function signingKeyPath(dataDir: string): string {
  return join(dataDir, SIGNING_KEY_FILE);
}

export function hostSecretPath(dataDir: string): string {
  return join(dataDir, HOST_SECRET_FILE);
}

/** `kid` = first 16 bytes of SHA-256 of the raw 32-byte public key, base64url (SP01 §1). */
export async function kidOf(publicKey: CryptoKey): Promise<string> {
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', publicKey));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', raw));
  return Buffer.from(digest.subarray(0, 16)).toString('base64url');
}

function parseSigningKey(path: string, raw: string): SigningKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new KeyFileError(`${SIGNING_KEY_FILE} is not JSON`);
  }
  const key = parsed as Partial<SigningKey>;
  const ok =
    typeof key.kid === 'string' &&
    key.kid !== '' &&
    typeof key.publicJwk?.x === 'string' &&
    typeof key.privateJwk?.d === 'string';
  if (!ok) throw new KeyFileError(`${SIGNING_KEY_FILE} is missing kid, publicJwk or privateJwk`);
  return { kid: key.kid, publicJwk: key.publicJwk, privateJwk: key.privateJwk };
}

/** Writes a file only this user can read; mode 0600 survives any umask. */
function writePrivateFile(path: string, content: string | Uint8Array): void {
  writeFileSync(path, content, { mode: KEY_FILE_MODE });
  chmodSync(path, KEY_FILE_MODE);
}

export async function loadOrCreateSigningKey(dataDir: string): Promise<SigningKey> {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const path = signingKeyPath(dataDir);
  if (existsSync(path)) return parseSigningKey(path, readFileSync(path, 'utf8'));

  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const key: SigningKey = {
    kid: await kidOf(pair.publicKey),
    publicJwk: await crypto.subtle.exportKey('jwk', pair.publicKey),
    privateJwk: await crypto.subtle.exportKey('jwk', pair.privateKey),
  };
  writePrivateFile(path, `${JSON.stringify(key)}\n`);
  return key;
}

/** The 32-byte HMAC key behind the fake salts of SP02 §4, exactly as stored (raw bytes). */
export function loadOrCreateHostSecret(dataDir: string): Uint8Array {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const path = hostSecretPath(dataDir);
  if (existsSync(path)) {
    const bytes = new Uint8Array(readFileSync(path));
    if (bytes.length !== HOST_SECRET_BYTES) {
      throw new KeyFileError(`${HOST_SECRET_FILE} is not ${HOST_SECRET_BYTES} bytes`);
    }
    return bytes;
  }
  const secret = crypto.getRandomValues(new Uint8Array(HOST_SECRET_BYTES));
  writePrivateFile(path, secret);
  return secret;
}
