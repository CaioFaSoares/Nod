// RF-63 (0.5.1): the backend's `SecretStore` keeps only the biometric item in the system keychain,
// every `bv1.` value in the `secret` table, and moves what an older Nod left in the keychain on its
// first read. The keychain here counts its reads, which is the whole point of the change: after the
// move, nothing but `nod.bio.*` ever reaches it.
import { describe, expect, test } from 'bun:test';

import { createRepo } from '../backend/repo';
import { createSecretStore, sealedSecrets } from '../backend/secret-store';
import { encryptVaultBytes, isSealedVaultValue } from '../shared/vault-crypto';
import type { Repo } from '../backend/repo';
import type { SecretStore } from '../shared/types';
import { memorySqlite } from './helpers/sqlite-bun';

const CRED = 'nod.cred.p-ana.kanban';
const BIO = 'nod.bio.p-ana';
const BEARER = 'nod.host.kid-1.p-ana';

function countingKeychain() {
  const items = new Map<string, string>();
  const reads: string[] = [];
  const keychain: SecretStore = {
    async get(key) {
      reads.push(key);
      return items.get(key) ?? null;
    },
    async set(key, value) {
      items.set(key, value);
      return true;
    },
    async delete(key) {
      return items.delete(key);
    },
  };
  return { keychain, items, reads };
}

function scene() {
  const repo: Repo = createRepo(memorySqlite());
  repo.migrate();
  const { keychain, items, reads } = countingKeychain();
  const store = createSecretStore({ rows: repo, keychain });
  return { repo, store, items, reads };
}

function vaultKey(fill: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(32).fill(fill);
}

async function sealed(key: string, text: string): Promise<string> {
  return encryptVaultBytes(vaultKey(1), key, new TextEncoder().encode(text));
}

describe('createSecretStore', () => {
  test('a sealed value lives in the table and is read without touching the keychain', async () => {
    const s = scene();
    const value = await sealed(CRED, 'x');

    expect(await s.store.set(CRED, value)).toBe(true);
    expect(s.repo.secret(CRED)).toBe(value);
    expect(s.items.has(CRED)).toBe(false);
    s.reads.length = 0;
    expect(await s.store.get(CRED)).toBe(value);
    expect(s.reads).toEqual([]);
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
    expect(s.items.has(BIO)).toBe(false);
  });

  test('a sealed value an older Nod left in the keychain moves to the table on its first read', async () => {
    const s = scene();
    const value = await sealed(CRED, 'x');
    s.items.set(CRED, value);

    expect(await s.store.get(CRED)).toBe(value);
    expect(s.repo.secret(CRED)).toBe(value);
    expect(s.items.has(CRED)).toBe(false);
    // The keychain was asked once, and is never asked again for that key.
    s.reads.length = 0;
    expect(await s.store.get(CRED)).toBe(value);
    expect(s.reads).toEqual([]);
  });

  test('a legacy plaintext is answered as it is and leaves the keychain with its first sealed write', async () => {
    const s = scene();
    s.items.set(CRED, '{"username":"ana","secret":"plain"}');

    expect(await s.store.get(CRED)).toBe('{"username":"ana","secret":"plain"}');
    expect(s.repo.secret(CRED)).toBeNull();

    const value = await sealed(CRED, 'x');
    expect(await s.store.set(CRED, value)).toBe(true);
    expect(s.items.has(CRED)).toBe(false);
    expect(s.repo.secret(CRED)).toBe(value);
  });

  test('a keychain that refuses to drop the old item does not fail the move', async () => {
    const repo = createRepo(memorySqlite());
    repo.migrate();
    const value = await sealed(CRED, 'x');
    const keychain: SecretStore = {
      get: async () => value,
      set: async () => true,
      delete: async () => {
        throw new Error('keychain error');
      },
    };
    const store = createSecretStore({ rows: repo, keychain });

    expect(await store.get(CRED)).toBe(value);
    expect(repo.secret(CRED)).toBe(value);
  });

  test('delete removes the row and whatever an older Nod left under the same key', async () => {
    const s = scene();
    await s.store.set(CRED, await sealed(CRED, 'x'));
    s.items.set(CRED, 'stale');

    expect(await s.store.delete(CRED)).toBe(true);
    expect(s.repo.secret(CRED)).toBeNull();
    expect(s.items.has(CRED)).toBe(false);
    expect(await s.store.delete(CRED)).toBe(false);
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
  });

  test("a 0.5.0 bearer in the keychain is answered, then sealed into the table and dropped", async () => {
    const s = scene();
    s.items.set(BEARER, 'token-old');
    const bearers = sealedSecrets(s.store, () => vaultKey(1));

    expect(await bearers.get(BEARER)).toBe('token-old');
    expect(s.items.has(BEARER)).toBe(false);
    expect(isSealedVaultValue(s.repo.secret(BEARER) ?? '')).toBe(true);
    s.reads.length = 0;
    expect(await bearers.get(BEARER)).toBe('token-old');
    expect(s.reads).toEqual([]);
  });
});
