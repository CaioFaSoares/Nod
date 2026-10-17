// RF-63 (0.5.1): outside the biometric item the backend's `SecretStore` never touches the system
// keychain — every read, write or delete of a keychain item an older build wrote is a password
// prompt on macOS. The keychain here records every call, which is the property under test.
import { describe, expect, test } from 'bun:test';

import { createRepo } from '../backend/repo';
import {
  createSecretStore,
  importLegacySecrets,
  legacyImportedKey,
  legacySkippedKey,
  sealedSecrets,
} from '../backend/secret-store';
import { encryptVaultBytes, isSealedVaultValue } from '../shared/vault-crypto';
import type { Repo } from '../backend/repo';
import type { SecretStore } from '../shared/types';
import { memorySqlite } from './helpers/sqlite-bun';

const CRED = 'nod.cred.p-ana.kanban';
const KEYS = 'nod.keys.p-ana';
const BIO = 'nod.bio.p-ana';
const BEARER = 'nod.host.kid-1.p-ana';

function recordingKeychain() {
  const items = new Map<string, string>();
  const calls: string[] = [];
  const keychain: SecretStore = {
    async get(key) {
      calls.push(`get ${key}`);
      return items.get(key) ?? null;
    },
    async set(key, value) {
      calls.push(`set ${key}`);
      items.set(key, value);
      return true;
    },
    async delete(key) {
      calls.push(`delete ${key}`);
      return items.delete(key);
    },
  };
  return { keychain, items, calls };
}

function scene() {
  const repo: Repo = createRepo(memorySqlite());
  repo.migrate();
  const { keychain, items, calls } = recordingKeychain();
  const store = createSecretStore({ rows: repo, keychain });
  return { repo, rows: repo, keychain, store, items, calls };
}

function vaultKey(fill: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(32).fill(fill);
}

async function sealed(key: string, text: string): Promise<string> {
  return encryptVaultBytes(vaultKey(1), key, new TextEncoder().encode(text));
}

describe('createSecretStore', () => {
  test('outside the biometric item no read, write, miss or delete reaches the keychain', async () => {
    const s = scene();
    // What an older Nod left behind: the store must not even look at it.
    s.items.set(CRED, await sealed(CRED, 'old'));
    s.items.set(KEYS, await sealed(KEYS, 'old'));

    expect(await s.store.get(CRED)).toBeNull();
    expect(await s.store.get('nod.host.kid-1.')).toBeNull();
    const value = await sealed(KEYS, 'new');
    expect(await s.store.set(KEYS, value)).toBe(true);
    expect(await s.store.get(KEYS)).toBe(value);
    expect(await s.store.delete(KEYS)).toBe(true);
    expect(await s.store.delete(CRED)).toBe(false);

    expect(s.calls).toEqual([]);
    expect(s.items.has(CRED)).toBe(true);
  });

  test('a plaintext is never written to the table', async () => {
    const s = scene();

    expect(await s.store.set(CRED, '{"username":"ana","secret":"plain"}')).toBe(false);
    expect(s.repo.secret(CRED)).toBeNull();
  });

  test('the biometric item stays in the system keychain and never in the table', async () => {
    const s = scene();

    expect(await s.store.set(BIO, 'raw-key')).toBe(true);
    expect(s.items.get(BIO)).toBe('raw-key');
    expect(s.repo.secret(BIO)).toBeNull();
    expect(await s.store.get(BIO)).toBe('raw-key');
    expect(await s.store.delete(BIO)).toBe(true);
    expect(s.calls).toEqual([`set ${BIO}`, `get ${BIO}`, `delete ${BIO}`]);
  });
});

describe('importLegacySecrets', () => {
  const sealPlain = async (key: string, plaintext: string): Promise<string | null> =>
    plaintext === 'junk' ? null : encryptVaultBytes(vaultKey(1), key, new TextEncoder().encode(plaintext));

  test('reads each missing key once, copies sealed values, seals plaintexts and never writes or deletes the keychain', async () => {
    const s = scene();
    const cred = await sealed(CRED, 'x');
    s.items.set(CRED, cred);
    s.items.set(BEARER, 'token-old');
    s.items.set(KEYS, 'junk');

    expect(await importLegacySecrets(s, 'p-ana', [CRED, BEARER, KEYS, BIO], sealPlain)).toBe(0);

    expect(s.repo.secret(CRED)).toBe(cred);
    expect(isSealedVaultValue(s.repo.secret(BEARER) ?? '')).toBe(true);
    expect(s.repo.secret(KEYS)).toBeNull();
    // Read-only: the biometric key is not this pass's, and nothing was written or removed.
    expect(s.calls).toEqual([`get ${CRED}`, `get ${BEARER}`, `get ${KEYS}`]);
    expect(s.items.has(CRED)).toBe(true);
  });

  test('a key the table already holds is never read from the keychain', async () => {
    const s = scene();
    const current = await sealed(KEYS, 'adopted from the host');
    s.repo.setSecret(KEYS, current);
    s.items.set(KEYS, await sealed(KEYS, 'stale'));

    expect(await importLegacySecrets(s, 'p-ana', [KEYS], sealPlain)).toBe(0);
    expect(s.calls).toEqual([]);
    expect(s.repo.secret(KEYS)).toBe(current);
  });

  test('one attempt per person ever: a refused read is counted, and the next unlock reads nothing', async () => {
    const s = scene();
    s.items.set(KEYS, await sealed(KEYS, 'pair'));
    // The person denies the prompt for the credential; the pair reads fine.
    const refusing: SecretStore = {
      ...s.keychain,
      get: async (key) => {
        if (key === CRED) {
          s.calls.push(`get ${key}`);
          throw new Error('keychain error');
        }
        return s.keychain.get(key);
      },
    };
    const deps = { rows: s.repo, keychain: refusing };

    expect(await importLegacySecrets(deps, 'p-ana', [CRED, KEYS], sealPlain)).toBe(1);
    expect(s.repo.secret(CRED)).toBeNull();
    expect(s.repo.secret(KEYS)).not.toBeNull();
    expect(s.repo.meta(legacyImportedKey('p-ana'))).toBe('1');
    expect(s.repo.meta(legacySkippedKey('p-ana'))).toBe('1');

    // The next unlock: the marker stops it before a single keychain call.
    s.calls.length = 0;
    expect(await importLegacySecrets(deps, 'p-ana', [CRED, KEYS], sealPlain)).toBe(0);
    expect(s.calls).toEqual([]);
  });
});

describe('sealedSecrets', () => {
  test('the bearer is sealed under the vaultKey, bound to its key, and opens only with that key', async () => {
    const s = scene();
    let key: Uint8Array<ArrayBuffer> | null = vaultKey(1);
    const bearers = sealedSecrets(s.store, () => key);

    expect(await bearers.set(BEARER, 'token-1')).toBe(true);
    const stored = s.repo.secret(BEARER) ?? '';
    expect(isSealedVaultValue(stored)).toBe(true);
    expect(stored.includes('token-1')).toBe(false);
    expect(await bearers.get(BEARER)).toBe('token-1');

    // Moved under another key, the value does not open (the AAD is the key).
    s.repo.setSecret('nod.host.kid-2.p-ana', stored);
    expect(await bearers.get('nod.host.kid-2.p-ana')).toBeNull();
    // Another vaultKey opens nothing, and locked nothing opens or is written.
    key = vaultKey(2);
    expect(await bearers.get(BEARER)).toBeNull();
    key = null;
    expect(await bearers.get(BEARER)).toBeNull();
    expect(await bearers.set(BEARER, 'token-2')).toBe(false);
    expect(s.calls).toEqual([]);
  });
});
