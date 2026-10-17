// Vault (`backend/vault.ts`) against in-memory SQLite and an in-memory keychain: proves this
// slice's acceptance criteria — index without a secret, value only in the keychain, the `bv1.`
// seal of V1 (SP02 §8) and its legacy migration, a tool that does not exist, the keychain refusing,
// the origin the credential is bound to (RF-38), removal (one item, one person, one tool) and the
// encrypted export/import round trip.
import { describe, expect, test } from 'bun:test';

import { createRepo } from '../backend/repo';
import { createVault } from '../backend/vault';
import { memorySqlite } from './helpers/sqlite-bun';
import { VAULT_VALUE_PREFIX, decryptVaultValue } from '../shared/vault-crypto';
import type { Repo } from '../backend/repo';
import type { Vault } from '../backend/vault';
import type { Entry, PasswordHash, Person, SecretStore } from '../shared/types';

// The export's PBKDF2 with 1000 iterations: the runtime cost (600 000) does not fit in a test (§3).
const ITERATIONS = 1000;
const LOCAL_PASSWORD: PasswordHash = {
  algorithm: 'PBKDF2-SHA256',
  hash: 'aGFzaC1ub3QtdXNlZA==',
  salt: 'c2FsdC1ub3QtdXNlZA==',
  iterations: ITERATIONS,
};
const KANBAN_SECRET = 'kanban-subscription-secret';
/** The `vaultKey` of the unlocked session this vault reads from (SP02 §8). */
const VAULT_KEY = new Uint8Array(32).fill(7);

function memoryKeychain() {
  const items = new Map<string, string>();
  let refused = false;
  const keychain: SecretStore = {
    async get(key) {
      return items.get(key) ?? null;
    },
    async set(key, value) {
      if (refused) return false;
      items.set(key, value);
      return true;
    },
    async delete(key) {
      return items.delete(key);
    },
  };
  return {
    keychain,
    items,
    refuse: (): void => {
      refused = true;
    },
    accept: (): void => {
      refused = false;
    },
  };
}

/** Minimal valid entry: a vault item has a foreign key to `tool`. */
function tool(id: string): Entry {
  return {
    id,
    title: id,
    url: `https://${id}.example.test/app`,
    icon: null,
    order: 1,
    roles: [],
    views: [],
    auth: null,
    active: true,
  };
}

interface VaultScene {
  repo: Repo;
  vault: Vault;
  keychain: SecretStore;
  items: Map<string, string>;
  refuse(): void;
  accept(): void;
  ana: Person;
  bruno: Person;
}

function scene(): VaultScene {
  const repo = createRepo(memorySqlite());
  repo.migrate();
  repo.ensureAdminRole();
  // A vault item has a foreign key to `tool`: those rows have to exist.
  for (const id of ['kanban', 'affine', 'orphan']) repo.saveEntry(tool(id));

  const { keychain, items, refuse, accept } = memoryKeychain();
  const vault = createVault({ repo, keychain, iterations: ITERATIONS, vaultKey: () => VAULT_KEY });
  const ana = repo.createPerson({
    email: 'ana@example.test',
    name: 'Ana',
    password: LOCAL_PASSWORD,
    roles: [],
  });
  const bruno = repo.createPerson({
    email: 'bruno@example.test',
    name: 'Bruno',
    password: LOCAL_PASSWORD,
    roles: [],
  });
  return { repo, vault, keychain, items, refuse, accept, ana, bruno };
}

async function messageOf(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return 'did not throw';
}

describe('key and index', () => {
  test('the keychain key is nod.cred.<person>.<tool>', () => {
    const s = scene();

    expect(s.vault.key(s.ana.id, 'kanban')).toBe(`nod.cred.${s.ana.id}.kanban`);
    expect(s.vault.list(s.ana.id)).toEqual([]);
  });

  test('save writes the index without the secret and the value as a bv1 value in the keychain', async () => {
    const s = scene();

    const item = await s.vault.save(s.ana.id, {
      toolId: 'kanban',
      username: 'ana',
      secret: KANBAN_SECRET,
    });

    expect(item.keychainKey).toBe(`nod.cred.${s.ana.id}.kanban`);
    // Default label: the tool id.
    expect(item.label).toBe('kanban');
    expect(item.username).toBe('ana');
    // The index has no secret field, and the value is nowhere in the record.
    expect('secret' in item).toBe(false);
    expect(JSON.stringify(item)).not.toContain(KANBAN_SECRET);
    // SP02 §8: the keychain holds the sealed value, openable only with this key and this keychain key.
    const stored = s.items.get(item.keychainKey) ?? '';
    expect(stored.startsWith(VAULT_VALUE_PREFIX)).toBe(true);
    expect(stored).not.toContain(KANBAN_SECRET);
    expect(await decryptVaultValue(VAULT_KEY, item.keychainKey, stored)).toEqual({
      username: 'ana',
      secret: KANBAN_SECRET,
    });

    expect(s.vault.list(s.ana.id)).toEqual([item]);
    expect(await s.vault.read(s.ana.id, 'kanban')).toEqual({
      username: 'ana',
      secret: KANBAN_SECRET,
    });
  });

  test('an explicit label and saving the same pair again update the same item', async () => {
    const s = scene();

    const first = await s.vault.save(s.ana.id, {
      toolId: 'affine',
      username: 'ana',
      secret: 'one',
      label: 'Team Affine',
    });
    const second = await s.vault.save(s.ana.id, {
      toolId: 'affine',
      username: 'ana',
      secret: 'two',
    });

    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);
    // Without a label on the rewrite, the default goes back to being the tool id.
    expect(second.label).toBe('affine');
    expect(s.vault.list(s.ana.id)).toHaveLength(1);
    expect(await s.vault.read(s.ana.id, 'affine')).toEqual({ username: 'ana', secret: 'two' });
  });

  test('an empty username and an empty secret are refused without touching the keychain or the index', async () => {
    const s = scene();

    expect(
      await messageOf(() => s.vault.save(s.ana.id, { toolId: 'kanban', username: '   ', secret: 'x' })),
    ).toBe('a username is required');
    expect(
      await messageOf(() => s.vault.save(s.ana.id, { toolId: 'kanban', username: 'ana', secret: '' })),
    ).toBe('a secret is required');
    expect(s.items.size).toBe(0);
    expect(s.repo.listVault(s.ana.id)).toEqual([]);
  });

  test('a tool that does not exist is refused before the keychain is written', async () => {
    const s = scene();

    expect(
      await messageOf(() =>
        s.vault.save(s.ana.id, { toolId: 'no-such-tool', username: 'ana', secret: 'x' }),
      ),
    ).toBe('unknown tool');
    expect(s.items.size).toBe(0);
    expect(s.repo.vaultItem(s.ana.id, 'no-such-tool')).toBeNull();
  });

  test('a keychain that refuses the credential: error and no new or changed index row', async () => {
    const s = scene();

    s.refuse();
    expect(
      await messageOf(() => s.vault.save(s.ana.id, { toolId: 'kanban', username: 'ana', secret: 'new' })),
    ).toBe('the system keychain refused the credential');
    expect(s.items.size).toBe(0);
    expect(s.repo.vaultItem(s.ana.id, 'kanban')).toBeNull();

    // With the keychain accepting again the item goes in; a later refusal leaves it untouched.
    s.accept();
    const item = await s.vault.save(s.ana.id, {
      toolId: 'kanban',
      username: 'ana',
      secret: 'old',
    });
    s.refuse();
    expect(
      await messageOf(() =>
        s.vault.save(s.ana.id, { toolId: 'kanban', username: 'ana', secret: 'newer' }),
      ),
    ).toBe('the system keychain refused the credential');
    expect(s.repo.vaultItem(s.ana.id, 'kanban')?.id).toBe(item.id);
    expect(await s.vault.read(s.ana.id, 'kanban')).toEqual({ username: 'ana', secret: 'old' });
  });

  test('read returns null without an index, without a keychain value or with an unreadable value', async () => {
    const s = scene();

    expect(await s.vault.read(s.ana.id, 'kanban')).toBeNull();

    const item = await s.vault.save(s.ana.id, {
      toolId: 'kanban',
      username: 'ana',
      secret: KANBAN_SECRET,
    });
    s.items.delete(item.keychainKey);
    expect(await s.vault.read(s.ana.id, 'kanban')).toBeNull();

    for (const junk of [
      'not json',
      '42',
      '"text"',
      'null',
      '{"username":"ana"}',
      '{"username":1,"secret":"x"}',
    ]) {
      s.items.set(item.keychainKey, junk);
      expect(await s.vault.read(s.ana.id, 'kanban')).toBeNull();
    }

    s.items.set(item.keychainKey, JSON.stringify({ username: 'ana', secret: KANBAN_SECRET }));
    expect(await s.vault.read(s.ana.id, 'kanban')).toEqual({
      username: 'ana',
      secret: KANBAN_SECRET,
    });
  });
});

describe('the vaultKey gate and the legacy migration (SP02 §8, V1)', () => {
  test('without a key the vault refuses to write and does not open a bv1 value', async () => {
    const s = scene();
    const item = await s.vault.save(s.ana.id, {
      toolId: 'kanban',
      username: 'ana',
      secret: KANBAN_SECRET,
    });
    // The same repository and keychain as a session that is locked: the vault has no key.
    const locked = createVault({ repo: s.repo, keychain: s.keychain, iterations: ITERATIONS });

    expect(await messageOf(() => locked.save(s.ana.id, { toolId: 'affine', username: 'a', secret: 'b' }))).toBe(
      'the vault is locked — unlock with your password first',
    );
    // Nothing was written: no index row and no keychain value.
    expect(s.repo.vaultItem(s.ana.id, 'affine')).toBeNull();
    expect(s.items.has(`nod.cred.${s.ana.id}.affine`)).toBe(false);

    // A sealed value is an absent credential without the key; a legacy plaintext one is still read.
    expect(await locked.read(s.ana.id, 'kanban')).toBeNull();
    s.items.set(item.keychainKey, JSON.stringify({ username: 'ana', secret: 'legacy' }));
    expect(await locked.read(s.ana.id, 'kanban')).toEqual({ username: 'ana', secret: 'legacy' });
  });

  test('another vaultKey does not open the value of this one', async () => {
    const s = scene();
    const item = await s.vault.save(s.ana.id, {
      toolId: 'kanban',
      username: 'ana',
      secret: KANBAN_SECRET,
    });
    const other = createVault({
      repo: s.repo,
      keychain: s.keychain,
      iterations: ITERATIONS,
      vaultKey: () => new Uint8Array(32).fill(8),
    });

    expect(await other.read(s.ana.id, 'kanban')).toBeNull();
    expect(s.repo.listVault(s.ana.id)).toHaveLength(1);
  });

  test('migrateLegacy re-encrypts the plaintext values and is idempotent', async () => {
    const s = scene();
    const item = await s.vault.save(s.ana.id, {
      toolId: 'kanban',
      username: 'ana',
      secret: KANBAN_SECRET,
    });
    // The value an earlier build wrote: plaintext, no prefix. A junk value is not a credential and
    // must survive the run as it is.
    s.items.set(item.keychainKey, JSON.stringify({ username: 'ana', secret: KANBAN_SECRET }));
    s.repo.saveVaultItem({
      personId: s.ana.id,
      toolId: 'affine',
      label: 'affine',
      username: 'ana',
      keychainKey: `nod.cred.${s.ana.id}.affine`,
      origin: 'https://affine.example.test',
    });
    s.items.set(`nod.cred.${s.ana.id}.affine`, 'not a credential');

    expect(await s.vault.migrateLegacy(s.ana.id)).toBe(1);
    const migrated = s.items.get(item.keychainKey) ?? '';
    expect(migrated.startsWith(VAULT_VALUE_PREFIX)).toBe(true);
    expect(await decryptVaultValue(VAULT_KEY, item.keychainKey, migrated)).toEqual({
      username: 'ana',
      secret: KANBAN_SECRET,
    });
    expect(s.items.get(`nod.cred.${s.ana.id}.affine`)).toBe('not a credential');
    // Reading is unchanged by the migration, and a second run rewrites nothing.
    expect(await s.vault.read(s.ana.id, 'kanban')).toEqual({
      username: 'ana',
      secret: KANBAN_SECRET,
    });
    expect(await s.vault.migrateLegacy(s.ana.id)).toBe(0);
  });

  test('migrateLegacy refuses without the key instead of writing a value nothing opens', async () => {
    const s = scene();
    const locked = createVault({ repo: s.repo, keychain: s.keychain, iterations: ITERATIONS });

    expect(await messageOf(() => locked.migrateLegacy(s.ana.id))).toBe(
      'the vault is locked — unlock with your password first',
    );
  });
});

describe('origin', () => {
  test('save records the entry origin; a moved tool does not move the saved credential', async () => {
    const s = scene();

    const item = await s.vault.save(s.ana.id, {
      toolId: 'kanban',
      username: 'ana',
      secret: KANBAN_SECRET,
    });

    // The entry's canonical origin, as the tool window compares its own address against (RF-38).
    expect(s.repo.vaultOrigin(s.ana.id, 'kanban')).toBe('https://kanban.example.test');
    expect(await decryptVaultValue(VAULT_KEY, item.keychainKey, s.items.get(item.keychainKey) ?? '')).toEqual(
      { username: 'ana', secret: KANBAN_SECRET },
    );

    // The tool address moves — a local edit or a host snapshot rewriting the entry. The credential
    // the person saved stays bound to the origin it was saved for.
    s.repo.saveEntry({ ...tool('kanban'), url: 'https://moved.example.test/app' });
    expect(s.repo.vaultOrigin(s.ana.id, 'kanban')).toBe('https://kanban.example.test');
    // The value in the keychain is untouched by that: the item did not move either.
    expect(await s.vault.read(s.ana.id, 'kanban')).toEqual({
      username: 'ana',
      secret: KANBAN_SECRET,
    });

    // Saved again on the new address, the item follows the entry.
    await s.vault.save(s.ana.id, { toolId: 'kanban', username: 'ana', secret: 'second' });
    expect(s.repo.vaultOrigin(s.ana.id, 'kanban')).toBe('https://moved.example.test');
  });

  /**
   * While connected the vault reads the entry of a credential from the effective catalog:
   * `backend/main.ts` builds it over `{ ...database, entry: catalogEntryOf }` (SP05 §2). A tool the
   * guild grants that this machine has no `tool` row for is exactly that case — the entry exists,
   * the local row does not — and it has to be able to hold a credential all the same.
   */
  test('a tool that exists only on the host receives a credential, on the host entry origin', async () => {
    const s = scene();
    // The host entry the snapshot brought: `jitsi` has no `tool` row in this database.
    const hostEntry: Entry = {
      ...tool('jitsi'),
      url: 'https://jitsi.example.test/room',
    };
    expect(s.repo.entry('jitsi')).toBeNull();
    const effective: Repo = {
      ...s.repo,
      entry: (id) => (id === 'jitsi' ? hostEntry : s.repo.entry(id)),
    };
    const vault = createVault({
      repo: effective,
      keychain: s.keychain,
      iterations: ITERATIONS,
      vaultKey: () => VAULT_KEY,
    });

    const item = await vault.save(s.ana.id, {
      toolId: 'jitsi',
      username: 'ana',
      secret: KANBAN_SECRET,
    });

    expect(item.toolId).toBe('jitsi');
    // The origin the fill compares a window's address against is the entry's own url — the host
    // entry's, not a local row's (RF-38).
    expect(s.repo.vaultOrigin(s.ana.id, 'jitsi')).toBe('https://jitsi.example.test');
    expect(await vault.read(s.ana.id, 'jitsi')).toEqual({
      username: 'ana',
      secret: KANBAN_SECRET,
    });
    // The index row exists without a `tool` row behind it, and the credential is the keychain's.
    expect(s.repo.listVault(s.ana.id)).toEqual([item]);
    expect(await decryptVaultValue(VAULT_KEY, item.keychainKey, s.items.get(item.keychainKey) ?? '')).toEqual(
      { username: 'ana', secret: KANBAN_SECRET },
    );
  });

  test('a refused keychain writes no origin and a person without an item has none', async () => {
    const s = scene();

    expect(s.repo.vaultOrigin(s.ana.id, 'kanban')).toBeNull();

    s.refuse();
    await expect(
      s.vault.save(s.ana.id, { toolId: 'kanban', username: 'ana', secret: KANBAN_SECRET }),
    ).rejects.toThrow('the system keychain refused the credential');
    expect(s.repo.vaultOrigin(s.ana.id, 'kanban')).toBeNull();
    expect(s.vault.list(s.ana.id)).toEqual([]);
  });
});

describe('remove', () => {
  test('remove deletes the keychain key and the index row', async () => {
    const s = scene();
    const item = await s.vault.save(s.ana.id, {
      toolId: 'kanban',
      username: 'ana',
      secret: KANBAN_SECRET,
    });

    await s.vault.remove(s.ana.id, 'kanban');

    expect(s.items.has(item.keychainKey)).toBe(false);
    expect(s.repo.vaultItem(s.ana.id, 'kanban')).toBeNull();
    expect(await s.vault.read(s.ana.id, 'kanban')).toBeNull();

    // Removing what does not exist does not throw.
    await s.vault.remove(s.ana.id, 'no-such-tool');
  });

  test('removeAllOf clears only the requested person', async () => {
    const s = scene();
    const kanban = await s.vault.save(s.ana.id, { toolId: 'kanban', username: 'ana', secret: 'one' });
    const affine = await s.vault.save(s.ana.id, { toolId: 'affine', username: 'ana', secret: 'two' });
    const hers = await s.vault.save(s.bruno.id, {
      toolId: 'kanban',
      username: 'bruno',
      secret: 'three',
    });

    await s.vault.removeAllOf(s.ana.id);

    expect(s.items.has(kanban.keychainKey)).toBe(false);
    expect(s.items.has(affine.keychainKey)).toBe(false);
    expect(s.repo.listVault(s.ana.id)).toEqual([]);
    expect(s.repo.listVault(s.bruno.id)).toHaveLength(1);
    expect(await decryptVaultValue(VAULT_KEY, hers.keychainKey, s.items.get(hers.keychainKey) ?? '')).toEqual(
      { username: 'bruno', secret: 'three' },
    );
  });

  test('removeAllForTool clears every person item and index row of that tool (A6)', async () => {
    const s = scene();
    const anaKanban = await s.vault.save(s.ana.id, {
      toolId: 'kanban',
      username: 'ana',
      secret: 'one',
    });
    const brunoKanban = await s.vault.save(s.bruno.id, {
      toolId: 'kanban',
      username: 'bruno',
      secret: 'two',
    });
    const anaAffine = await s.vault.save(s.ana.id, {
      toolId: 'affine',
      username: 'ana',
      secret: 'three',
    });

    await s.vault.removeAllForTool('kanban');

    expect(s.items.has(anaKanban.keychainKey)).toBe(false);
    expect(s.items.has(brunoKanban.keychainKey)).toBe(false);
    expect(s.repo.vaultItemsByTool('kanban')).toEqual([]);
    expect(s.repo.listVault(s.ana.id)).toEqual([anaAffine]);
    expect(s.repo.listVault(s.bruno.id)).toEqual([]);
    expect(
      await decryptVaultValue(VAULT_KEY, anaAffine.keychainKey, s.items.get(anaAffine.keychainKey) ?? ''),
    ).toEqual({ username: 'ana', secret: 'three' });
  });
});

describe('export and import', () => {
  test('the encrypted round trip restores the items in another person keychain', async () => {
    const s = scene();
    await s.vault.save(s.ana.id, { toolId: 'kanban', username: 'ana', secret: 'secret-one' });
    await s.vault.save(s.ana.id, {
      toolId: 'affine',
      username: 'ana',
      secret: 'secret-two',
      label: 'Affine',
    });
    // Index without a keychain value: it stays out of the file.
    s.repo.saveVaultItem({
      personId: s.ana.id,
      toolId: 'orphan',
      label: 'orphan',
      username: 'ana',
      keychainKey: `nod.cred.${s.ana.id}.orphan`,
      origin: 'https://orphan.example.test',
    });

    const blob = await s.vault.export(s.ana.id, 'export-password');
    expect(typeof blob).toBe('string');
    // The file is encrypted: no secret shows up in it.
    expect(blob).not.toContain('secret-one');
    expect(blob).not.toContain('secret-two');
    expect(JSON.parse(atob(blob)).alg).toBe('PBKDF2-SHA256+AES-256-GCM');

    const total = await s.vault.import(s.bruno.id, blob, 'export-password');

    expect(total).toBe(2);
    expect(await s.vault.read(s.bruno.id, 'kanban')).toEqual({
      username: 'ana',
      secret: 'secret-one',
    });
    expect(await s.vault.read(s.bruno.id, 'affine')).toEqual({
      username: 'ana',
      secret: 'secret-two',
    });
    expect(
      s.vault
        .list(s.bruno.id)
        .map((item) => item.label)
        .sort(),
    ).toEqual(['Affine', 'kanban']);
    // The source vault keeps its own items.
    expect(s.repo.listVault(s.ana.id)).toHaveLength(3);
  });

  test('a wrong password imports nothing and an empty vault exports an importable file', async () => {
    const s = scene();
    await s.vault.save(s.ana.id, { toolId: 'kanban', username: 'ana', secret: 'secret-one' });
    const blob = await s.vault.export(s.ana.id, 'export-password');

    expect(await messageOf(() => s.vault.import(s.bruno.id, blob, 'wrong-password'))).toBe(
      'wrong password or invalid file',
    );
    expect(s.repo.listVault(s.bruno.id)).toEqual([]);
    expect(s.items.size).toBe(1);

    const empty = await s.vault.export(s.bruno.id, 'another-password');
    expect(await s.vault.import(s.bruno.id, empty, 'another-password')).toBe(0);
    expect(s.repo.listVault(s.bruno.id)).toEqual([]);
  });
});

describe('a re-keyed credential (B8b)', () => {
  test('re-saving it writes the canonical keychain key and leaves no orphan', async () => {
    const s = scene();
    // A credential saved for the old tool id, then moved to a new id the way
    // `repo.rekeyVaultTool` does it: the index row moves, its `keychain_key` does not.
    await s.vault.save(s.ana.id, { toolId: 'kanban', username: 'ana', secret: KANBAN_SECRET });
    s.repo.saveEntry(tool('kanban-personal'));
    expect(s.repo.rekeyVaultTool('kanban', 'kanban-personal')).toBe(1);
    expect(s.repo.vaultItem(s.ana.id, 'kanban-personal')?.keychainKey).toBe(`nod.cred.${s.ana.id}.kanban`);
    expect(s.items.has(`nod.cred.${s.ana.id}.kanban`)).toBe(true);

    const item = await s.vault.save(s.ana.id, {
      toolId: 'kanban-personal',
      username: 'ana',
      secret: 'secret-after',
    });

    expect(item.keychainKey).toBe(`nod.cred.${s.ana.id}.kanban-personal`);
    // The old item is gone: one value, under the canonical key (the bv1 AAD is that same key).
    expect(s.items.has(`nod.cred.${s.ana.id}.kanban`)).toBe(false);
    expect(s.items.has(`nod.cred.${s.ana.id}.kanban-personal`)).toBe(true);
    expect(s.items.size).toBe(1);
    expect(await s.vault.read(s.ana.id, 'kanban-personal')).toEqual({
      username: 'ana',
      secret: 'secret-after',
    });
  });
});
