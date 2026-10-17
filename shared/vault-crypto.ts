// Vault values sealed with the person's `vaultKey` before the system keychain sees them
// (SP02 §8, story V1). Wire and storage format:
//
//   "bv1." + base64url( nonce(12) || AES-256-GCM(key = vaultKey, iv = nonce, aad = UTF-8 keychainKey,
//                                plaintext = UTF-8 JSON { "username": "...", "secret": "..." }) )
//
// The AAD binds a value to the keychain key it was written for, so a value copied to another item
// does not open. A fresh nonce is drawn on every write. `bv1.` is the prefix every legacy (plain)
// value lacks; SP02 §8 makes them re-encrypt on the first unlock (the caller's `migrateLegacy`).
//
// `encryptVaultBytes`/`decryptVaultBytes` are the same envelope over arbitrary UTF-8 plaintext and
// AAD: story K1 stores the private keys of the E02 pairs as a `bv1.` value under AAD
// `nod.keys.<person>`, and the format must stay one definition.
//
// Pure, like every other module of `shared/`: only `crypto.subtle`, `crypto.getRandomValues`,
// `TextEncoder`/`TextDecoder` and `btoa`/`atob` (through `shared/encoding.ts`). The same bytes in Bun
// and in txiki.js.
import { fromBase64url, toBase64url } from './encoding';

/** First characters of an encrypted vault value (SP02 §8). A new format gets a new prefix. */
export const VAULT_VALUE_PREFIX = 'bv1.';
/** AES-256-GCM nonce (SP02 §8). */
export const VAULT_NONCE_LENGTH = 12;
/** AES-256 key length: the `vaultKey` of SP02 §1. */
export const VAULT_KEY_LENGTH = 32;
/**
 * SP02 §8, `docs/canonico.md` §11: the Windows keychain limit per value, counted on the **stored**
 * UTF-8 bytes — so about 1.8 KB of JSON. Enforced on every platform, because a vault written on
 * macOS has to open on Windows.
 */
export const MAX_KEYCHAIN_VALUE_BYTES = 2560;

/** AES-GCM tag length in bytes; the ciphertext of the envelope carries it. */
const GCM_TAG_LENGTH = 16;
const TOO_LONG = `the saved value is too long for the system keychain (${MAX_KEYCHAIN_VALUE_BYTES} bytes)`;
const INVALID_KEY = 'invalid vault key';

// Type note (TypeScript 6): a bare `Uint8Array` is `Uint8Array<ArrayBufferLike>`, which WebCrypto
// does not accept as `BufferSource`. Whoever PRODUCES bytes (decoding, `getRandomValues`, `encrypt`)
// returns `Uint8Array<ArrayBuffer>`; whoever only reads bytes accepts any `Uint8Array`.

/** The one credential shape a `bv1.` value holds (SP02 §8), in the key order the JSON is written. */
export interface VaultCredential {
  username: string;
  secret: string;
}

// ------------------------------------------------------------- helpers

function concatBytes(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** The AES-GCM key of the envelope; a length other than 32 bytes is refused before WebCrypto asks. */
async function aesKey(vaultKey: Uint8Array<ArrayBuffer>, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  if (vaultKey.length !== VAULT_KEY_LENGTH) throw new Error(INVALID_KEY);
  return crypto.subtle.importKey('raw', vaultKey, 'AES-GCM', false, [usage]);
}

/** The stored form of the bytes: the prefix, the nonce and the ciphertext, and the size gate. */
function sealedValue(nonce: Uint8Array<ArrayBuffer>, ciphertext: Uint8Array): string {
  const value = VAULT_VALUE_PREFIX + toBase64url(concatBytes([nonce, ciphertext]));
  // The limit is on UTF-8 bytes, not characters: base64url is ASCII today, and the measure is what
  // SP02 §8 fixes rather than a length that happens to match it.
  if (new TextEncoder().encode(value).length > MAX_KEYCHAIN_VALUE_BYTES) throw new Error(TOO_LONG);
  return value;
}

// ------------------------------------------------------------- envelope (SP02 §8)

/** Whether a keychain value carries the `bv1.` envelope; everything else is legacy plaintext. */
export function isSealedVaultValue(value: string): boolean {
  return value.startsWith(VAULT_VALUE_PREFIX);
}

/**
 * Seals arbitrary bytes under `vaultKey` with the SP02 §8 envelope, bound to `aad` (UTF-8). A new
 * nonce per call; the result is the whole keychain value (`bv1.` included). Throws when the value
 * would not fit the keychain limit — before anything is written.
 */
export async function encryptVaultBytes(
  vaultKey: Uint8Array<ArrayBuffer>,
  aad: string,
  plaintext: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const key = await aesKey(vaultKey, 'encrypt');
  const nonce = crypto.getRandomValues(new Uint8Array(VAULT_NONCE_LENGTH));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: new TextEncoder().encode(aad) },
      key,
      plaintext,
    ),
  );
  return sealedValue(nonce, ciphertext);
}

/**
 * Opens a value written by `encryptVaultBytes` over the same `aad`. `null` on any mismatch: not a
 * `bv1.` value, invalid base64url, too short to hold the nonce and the tag, a wrong `vaultKey`, a
 * different `aad`, or bytes that were changed after the write. One outcome only, like `open` in
 * `shared/seal.ts`: a value that cannot be opened is an absent value.
 */
export async function decryptVaultBytes(
  vaultKey: Uint8Array<ArrayBuffer>,
  aad: string,
  value: string,
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!isSealedVaultValue(value)) return null;
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = fromBase64url(value.slice(VAULT_VALUE_PREFIX.length));
  } catch {
    return null;
  }
  if (bytes.length < VAULT_NONCE_LENGTH + GCM_TAG_LENGTH) return null;
  const nonce = bytes.slice(0, VAULT_NONCE_LENGTH);
  const ciphertext = bytes.slice(VAULT_NONCE_LENGTH);
  try {
    const key = await aesKey(vaultKey, 'decrypt');
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: new TextEncoder().encode(aad) },
      key,
      ciphertext,
    );
    return new Uint8Array(plaintext);
  } catch {
    return null;
  }
}

// ------------------------------------------------------------- credentials (SP02 §8)

/**
 * The `bv1.` value of one credential under its own keychain key: the AAD is the key, so the value
 * only opens in the item it was saved for. The JSON is exactly `{ "username", "secret" }` — the
 * order SP02 §8 pins.
 */
export async function encryptVaultValue(
  vaultKey: Uint8Array<ArrayBuffer>,
  keychainKey: string,
  credential: VaultCredential,
): Promise<string> {
  const plaintext = new TextEncoder().encode(
    JSON.stringify({ username: credential.username, secret: credential.secret }),
  );
  return encryptVaultBytes(vaultKey, keychainKey, plaintext);
}

/**
 * The credential of a plaintext value: the legacy keychain form SP02 §8 re-encrypts on the first
 * unlock (`JSON { "username": "…", "secret": "…" }`, no prefix). `null` for junk or another shape —
 * a value that cannot be read is not one to seal.
 */
export function plainVaultCredential(raw: string): VaultCredential | null {
  try {
    return credentialOf(JSON.parse(raw));
  } catch {
    return null;
  }
}

function credentialOf(parsed: unknown): VaultCredential | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as { username?: unknown; secret?: unknown };
  if (typeof record.username !== 'string' || typeof record.secret !== 'string') return null;
  return { username: record.username, secret: record.secret };
}

/**
 * The credential of a `bv1.` value, or `null` when it does not open (wrong key, another item's AAD,
 * a changed byte, a payload that is not `{ username, secret }` both strings).
 */
export async function decryptVaultValue(
  vaultKey: Uint8Array<ArrayBuffer>,
  keychainKey: string,
  value: string,
): Promise<VaultCredential | null> {
  const plaintext = await decryptVaultBytes(vaultKey, keychainKey, value);
  if (plaintext === null) return null;
  try {
    return credentialOf(JSON.parse(new TextDecoder().decode(plaintext)));
  } catch {
    return null;
  }
}

// ------------------------------------------------------------- vaultKey as a keychain value (SP02 §9)

/**
 * The bytes of a biometric item that holds `base64url(vaultKey)` (SP02 §9): a 32-byte key, or
 * `null` for anything else — the marker format old builds wrote (the person id) is not a key, and
 * a biometric unlock made with it would have nothing to open the vault with.
 */
export function decodeVaultKey(encoded: string): Uint8Array<ArrayBuffer> | null {
  try {
    const bytes = fromBase64url(encoded);
    return bytes.length === VAULT_KEY_LENGTH ? bytes : null;
  } catch {
    return null;
  }
}
