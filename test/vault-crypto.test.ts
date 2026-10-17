// `shared/vault-crypto.ts` against the SP02 §8 format: the `bv1.` envelope, the AAD that binds a
// value to its keychain key, the fresh nonce of every write, the keychain size limit, and the
// generic byte envelope story K1 uses for the private keys. Pure module, so `bun test` is the whole
// surface — no runtime seam.
import { describe, expect, test } from 'bun:test';

import { fromBase64url, toBase64url } from '../shared/encoding';
import {
  MAX_KEYCHAIN_VALUE_BYTES,
  VAULT_VALUE_PREFIX,
  decodeVaultKey,
  decryptVaultBytes,
  decryptVaultValue,
  encryptVaultBytes,
  encryptVaultValue,
  isSealedVaultValue,
  plainVaultCredential,
} from '../shared/vault-crypto';

/** A 32-byte key of its own per test, so one case cannot pass because of another's bytes. */
function key(byte: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(32).fill(byte);
}

const KEY = key(1);
const OTHER_KEY = key(2);
const KEYCHAIN_KEY = 'nod.cred.ana.kanban';
const SECRET = 'kanban-subscription-secret';
const CREDENTIAL = { username: 'ana', secret: SECRET };

describe('credential envelope (SP02 §8)', () => {
  test('a saved value is the bv1 envelope and opens with the same key and keychain key', async () => {
    const value = await encryptVaultValue(KEY, KEYCHAIN_KEY, CREDENTIAL);

    expect(isSealedVaultValue(value)).toBe(true);
    expect(value.startsWith(VAULT_VALUE_PREFIX)).toBe(true);
    // No secret shows up in the stored string, and the credential round-trips.
    expect(value).not.toContain(SECRET);
    expect(value).not.toContain('ana');
    expect(await decryptVaultValue(KEY, KEYCHAIN_KEY, value)).toEqual(CREDENTIAL);
  });

  test('a value moved to another keychain key does not open (AAD)', async () => {
    const value = await encryptVaultValue(KEY, KEYCHAIN_KEY, CREDENTIAL);

    expect(await decryptVaultValue(KEY, 'nod.cred.ana.affine', value)).toBeNull();
    expect(await decryptVaultValue(OTHER_KEY, KEYCHAIN_KEY, value)).toBeNull();
  });

  test('one flipped bit of the ciphertext is enough to fail the open', async () => {
    const value = await encryptVaultValue(KEY, KEYCHAIN_KEY, CREDENTIAL);
    const bytes = fromBase64url(value.slice(VAULT_VALUE_PREFIX.length));
    bytes[bytes.length - 1] ^= 1;
    const changed = VAULT_VALUE_PREFIX + toBase64url(bytes);

    expect(await decryptVaultValue(KEY, KEYCHAIN_KEY, changed)).toBeNull();
  });

  test('every write draws a fresh nonce: the same credential twice gives two different values', async () => {
    const first = await encryptVaultValue(KEY, KEYCHAIN_KEY, CREDENTIAL);
    const second = await encryptVaultValue(KEY, KEYCHAIN_KEY, CREDENTIAL);

    expect(first).not.toBe(second);
    // Same open, different bytes: the nonce is the only thing that moved.
    expect(await decryptVaultValue(KEY, KEYCHAIN_KEY, second)).toEqual(CREDENTIAL);
    const firstNonce = fromBase64url(first.slice(VAULT_VALUE_PREFIX.length)).slice(0, 12);
    const secondNonce = fromBase64url(second.slice(VAULT_VALUE_PREFIX.length)).slice(0, 12);
    expect(toBase64url(firstNonce)).not.toBe(toBase64url(secondNonce));
  });

  test('a value that is not the bv1 envelope, or is too short, is not a value', async () => {
    expect(await decryptVaultValue(KEY, KEYCHAIN_KEY, 'not json')).toBeNull();
    expect(await decryptVaultValue(KEY, KEYCHAIN_KEY, 'bv1.')).toBeNull();
    expect(await decryptVaultValue(KEY, KEYCHAIN_KEY, 'bv1.!!!!')).toBeNull();
    // Twelve bytes of nonce with no tag cannot be a value either.
    expect(await decryptVaultValue(KEY, KEYCHAIN_KEY, VAULT_VALUE_PREFIX + toBase64url(new Uint8Array(12)))).toBeNull();
    expect(isSealedVaultValue('')).toBe(false);
    expect(isSealedVaultValue('bv2.abc')).toBe(false);
  });

  test('a key that is not 32 bytes is refused instead of silently used', async () => {
    await expect(encryptVaultValue(key(1).slice(0, 16), KEYCHAIN_KEY, CREDENTIAL)).rejects.toThrow(
      'invalid vault key',
    );
    // The open answers the one outcome everything else answers.
    expect(await decryptVaultValue(key(1).slice(0, 16), KEYCHAIN_KEY, VAULT_VALUE_PREFIX + 'abc')).toBeNull();
  });
});

describe('the keychain size limit (SP02 §8)', () => {
  test('a value under the limit is written, one over it is refused before any write', async () => {
    const big = { username: 'ana', secret: 'x'.repeat(1800) };
    const value = await encryptVaultValue(KEY, KEYCHAIN_KEY, big);
    expect(new TextEncoder().encode(value).length).toBeLessThanOrEqual(MAX_KEYCHAIN_VALUE_BYTES);
    expect(await decryptVaultValue(KEY, KEYCHAIN_KEY, value)).toEqual(big);

    await expect(
      encryptVaultValue(KEY, KEYCHAIN_KEY, { username: 'ana', secret: 'x'.repeat(2600) }),
    ).rejects.toThrow('too long for the system keychain');
  });

  test('the limit is counted on the encoded value, not on the plaintext', async () => {
    // A secret that fits the limit in bytes of JSON but not once sealed and base64url-encoded is
    // still refused: the keychain stores what the envelope produced.
    const edge = { username: 'ana', secret: 'x'.repeat(1900) };
    let refused = false;
    try {
      await encryptVaultValue(KEY, KEYCHAIN_KEY, edge);
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
  });
});

describe('byte envelope (story K1)', () => {
  test('arbitrary bytes round-trip over an arbitrary AAD', async () => {
    const plaintext = new TextEncoder().encode('— private key bytes…\u0000\u00ff');
    const aad = 'nod.keys.ana';
    const value = await encryptVaultBytes(KEY, aad, plaintext);

    expect(isSealedVaultValue(value)).toBe(true);
    const opened = await decryptVaultBytes(KEY, aad, value);
    expect(opened).not.toBeNull();
    expect(new TextDecoder().decode(opened as Uint8Array)).toBe('— private key bytes…\u0000\u00ff');
  });

  test('another AAD or another key opens nothing, and the outcome is null', async () => {
    const value = await encryptVaultBytes(KEY, 'nod.keys.ana', new TextEncoder().encode('bytes'));

    expect(await decryptVaultBytes(KEY, 'nod.keys.bruno', value)).toBeNull();
    expect(await decryptVaultBytes(OTHER_KEY, 'nod.keys.ana', value)).toBeNull();
  });
});

describe('legacy plaintext and the biometric item', () => {
  test('a plaintext value is parsed as the legacy form, and junk is null', () => {
    expect(plainVaultCredential('{"username":"ana","secret":"s"}')).toEqual({
      username: 'ana',
      secret: 's',
    });
    for (const junk of ['not json', '42', '"text"', 'null', '{"username":"ana"}', '{"username":1,"secret":"x"}']) {
      expect(plainVaultCredential(junk)).toBeNull();
    }
  });

  test('a biometric item is a key only when it is base64url of 32 bytes', () => {
    expect(decodeVaultKey(toBase64url(key(9)))?.length).toBe(32);
    // The marker format of the builds before V1: the person id, which is not a key.
    expect(decodeVaultKey('ana-person-1')).toBeNull();
    expect(decodeVaultKey(toBase64url(new Uint8Array(31)))).toBeNull();
    expect(decodeVaultKey('not base64url!')).toBeNull();
  });
});
