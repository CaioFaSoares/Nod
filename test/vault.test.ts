// Vault (`backend/vault.ts`) against in-memory SQLite and an in-memory keychain: proves this
// slice's acceptance criteria — index without a secret, value only in the keychain, the `bv1.`
// seal of V1 (SP02 §8) and its legacy migration, a tool that does not exist, the keychain refusing,
// the origin the credential is bound to (RF-38), several credentials of one tool with their own ids,
// keys and secrets and the default the fill reads (RF-65), removal (one item, one person, one tool)
// and the encrypted export/import round trip.
import { describe, expect, test } from 'bun:test';

import { createRepo } from '../backend/repo';
import { createVault } from '../backend/vault';
import { memorySqlite } from './helpers/sqlite-bun';
import { VAULT_VALUE_PREFIX, decryptVaultValue, encryptVaultValue } from '../shared/vault-crypto';
import type { Repo } from '../backend/repo';
import type { Vault } from '../backend/vault';
import type { Entry, Id, PasswordHash, Person, SecretStore, SqlDb, VaultItem } from '../shared/types';

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
  db: SqlDb;
  keychain: SecretStore;
  items: Map<string, string>;
  refuse(): void;
  accept(): void;
  ana: Person;
  bruno: Person;
}

function scene(): VaultScene {
  const db = memorySqlite();
  const repo = createRepo(db);
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
  return { repo, vault, db, keychain, items, refuse, accept, ana, bruno };
}

async function messageOf(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return 'did not throw';
}

/** The credential of one label, out of the list a person's vault answers. */
function itemOf(vault: Vault, personId: Id, label: string): VaultItem {
  const found = vault.list(personId).find((item) => item.label === label);
  if (found === undefined) throw new Error(`no credential labelled ${label}`);
  return found;
}

describe('key and index', () => {
  test('a credential this build creates takes its own keychain key, with its item id in it', async () => {
    const s = scene();
    expect(s.vault.list(s.ana.id)).toEqual([]);

    const item = await s.vault.save(s.ana.id, {
      toolId: 'kanban',
      username: 'ana',
      secret: KANBAN_SECRET,
    });

    // RF-65: the id is part of the key, because one tool holds several credentials.
    expect(item.keychainKey).toBe(`nod.cred.${s.ana.id}.kanban.${item.id}`);
    expect(s.items.has(item.keychainKey)).toBe(true);
  });

  test('save writes the index without the secret and the value as a bv1 value in the keychain', async () => {
    const s = scene();

    const item = await s.vault.save(s.ana.id, {
      toolId: 'kanban',
      username: 'ana',
      secret: KANBAN_SECRET,
    });

    // Default label: the username, so two credentials of one tool read apart.
    expect(item.label).toBe('ana');
    expect(item.username).toBe('ana');
    // The first credential of a tool is the one the fill uses (RF-65).
    expect(item.isDefault).toBe(true);
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
    expect(await s.vault.read(s.ana.id, item.id)).toEqual({
      username: 'ana',
      secret: KANBAN_SECRET,
    });
  });

  test('two credentials of one tool coexist, each with its own key and its own secret', async () => {
    const s = scene();

    const work = await s.vault.save(s.ana.id, {
      toolId: 'kanban',
      username: 'ana',
      secret: 'secret-work',
      label: 'Work',
    });
    const personal = await s.vault.save(s.ana.id, {
      toolId: 'kanban',
      username: 'ana',
      secret: 'secret-personal',
      label: 'Personal',
    });

    expect(personal.id).not.toBe(work.id);
    expect(personal.keychainKey).toBe(`nod.cred.${s.ana.id}.kanban.${personal.id}`);
    expect(s.items.size).toBe(2);
    expect(await s.vault.read(s.ana.id, work.id)).toEqual({ username: 'ana', secret: 'secret-work' });
    expect(await s.vault.read(s.ana.id, personal.id)).toEqual({
      username: 'ana',
      secret: 'secret-personal',
    });
    // The tool holds both of them, and only one is the default.
    expect(
      s.repo
        .vaultItemsOfTool(s.ana.id, 'kanban')
        .map((item) => item.label)
        .sort(),
    ).toEqual(['Personal', 'Work']);
    expect(work.isDefault).toBe(true);
    expect(personal.isDefault).toBe(false);
    // `listVault` is the screen's order: by label.
    expect(s.vault.list(s.ana.id).map((item) => item.label)).toEqual(['Personal', 'Work']);
  });

  test('an explicit label is kept and saving with the itemId replaces that credential', async () => {
    const s = scene();

    const first = await s.vault.save(s.ana.id, {
      toolId: 'affine',
      username: 'ana',
      secret: 'one',
      label: 'Team Affine',
    });
    const second = await s.vault.save(s.ana.id, {
      itemId: first.id,
      toolId: 'affine',
      username: 'ana',
      secret: 'two',
    });

    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);
    // RF-65: the value is rewritten under the key the row already carries — nothing is orphaned.
    expect(second.keychainKey).toBe(first.keychainKey);
    // Without a label on the rewrite, the default goes back to the username.
    expect(second.label).toBe('ana');
    expect(s.vault.list(s.ana.id)).toHaveLength(1);
    expect(s.items.size).toBe(1);
    expect(await s.vault.read(s.ana.id, first.id)).toEqual({ username: 'ana', secret: 'two' });
  });

  test('a save that names an item this person does not hold, or of another tool, is refused', async () => {
    const s = scene();

    const item = await s.vault.save(s.ana.id, {
      toolId: 'kanban',
      username: 'ana',
      secret: 'one',
    });
    expect(
      await messageOf(() =>
        s.vault.save(s.ana.id, {
          itemId: 'no-such-item',
          toolId: 'kanban',
          username: 'ana',
          secret: 'x',
        }),
      ),
    ).toBe('unknown credential');
    // A credential is edited where it is: a save never moves one from a tool to another.
    expect(
      await messageOf(() =>
        s.vault.save(s.ana.id, { itemId: item.id, toolId: 'affine', username: 'ana', secret: 'x' }),
      ),
    ).toBe('invalid credential');
    // Bruno's credential is not Ana's: the id alone is not enough.
    const hers = await s.vault.save(s.bruno.id, {
      toolId: 'kanban',
      username: 'bruno',
      secret: 'his',
    });
    expect(
      await messageOf(() =>
        s.vault.save(s.ana.id, { itemId: hers.id, toolId: 'kanban', username: 'ana', secret: 'x' }),
      ),
    ).toBe('unknown credential');

    expect(s.items.size).toBe(2);
    expect(await s.vault.read(s.ana.id, item.id)).toEqual({ username: 'ana', secret: 'one' });
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
    expect(s.repo.vaultItemsOfTool(s.ana.id, 'no-such-tool')).toEqual([]);
  });

  test('a keychain that refuses the credential: error and no new or changed index row', async () => {
    const s = scene();

    s.refuse();
    expect(
      await messageOf(() => s.vault.save(s.ana.id, { toolId: 'kanban', username: 'ana', secret: 'new' })),
    ).toBe('the system keychain refused the credential');
    expect(s.items.size).toBe(0);
    expect(s.repo.listVault(s.ana.id)).toEqual([]);

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
        s.vault.save(s.ana.id, { itemId: item.id, toolId: 'kanban', username: 'ana', secret: 'newer' }),
      ),
    ).toBe('the system keychain refused the credential');
    expect(s.repo.vaultItemById(s.ana.id, item.id)?.id).toBe(item.id);
    expect(await s.vault.read(s.ana.id, item.id)).toEqual({ username: 'ana', secret: 'old' });
  });

  test('read returns null without an index, without a keychain value or with an unreadable value', async () => {
    const s = scene();

    expect(await s.vault.read(s.ana.id, 'no-such-item')).toBeNull();

    const item = await s.vault.save(s.ana.id, {
      toolId: 'kanban',
      username: 'ana',
      secret: KANBAN_SECRET,
    });
    s.items.delete(item.keychainKey);
    expect(await s.vault.read(s.ana.id, item.id)).toBeNull();

    for (const junk of [
      'not json',
      '42',
      '"text"',
      'null',
      '{"username":"ana"}',
      '{"username":1,"secret":"x"}',
    ]) {
      s.items.set(item.keychainKey, junk);
      expect(await s.vault.read(s.ana.id, item.id)).toBeNull();
    }

    s.items.set(item.keychainKey, JSON.stringify({ username: 'ana', secret: KANBAN_SECRET }));
    expect(await s.vault.read(s.ana.id, item.id)).toEqual({
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
    expect(s.repo.vaultItemsOfTool(s.ana.id, 'affine')).toEqual([]);
    expect(s.items.size).toBe(1);

    // A sealed value is an absent credential without the key; a legacy plaintext one is still read.
    expect(await locked.read(s.ana.id, item.id)).toBeNull();
    s.items.set(item.keychainKey, JSON.stringify({ username: 'ana', secret: 'legacy' }));
    expect(await locked.read(s.ana.id, item.id)).toEqual({ username: 'ana', secret: 'legacy' });
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

    expect(await other.read(s.ana.id, item.id)).toBeNull();
    expect(s.repo.listVault(s.ana.id)).toHaveLength(1);
  });

  /**
   * The keychain key of a row written before 0.5.5 is `nod.cred.<person>.<tool>` — no item id — and
   * it is the AAD of the sealed value, so the row keeps it (RF-65). The vault reads it back by the
   * key the row carries, never by one derived from the tool.
   */
  test('a row of an older build keeps the keychain key it was sealed under and still opens', async () => {
    const s = scene();
    const legacyKey = `nod.cred.${s.ana.id}.kanban`;
    const legacy = s.repo.saveVaultItem({
      personId: s.ana.id,
      toolId: 'kanban',
      label: 'Work',
      username: 'ana',
      keychainKey: legacyKey,
      origin: 'https://kanban.example.test',
    });
    const value = await encryptVaultValue(VAULT_KEY, legacyKey, {
      username: 'ana',
      secret: KANBAN_SECRET,
    });
    s.items.set(legacyKey, value);

    expect(legacy.keychainKey).toBe(legacyKey);
    expect(await s.vault.read(s.ana.id, legacy.id)).toEqual({
      username: 'ana',
      secret: KANBAN_SECRET,
    });
    // Replacing it rewrites the value under that same key: no second slot, no orphan.
    await s.vault.save(s.ana.id, {
      itemId: legacy.id,
      toolId: 'kanban',
      username: 'ana',
      secret: 'secret-after',
    });
    expect(s.items.size).toBe(1);
    expect(s.items.has(legacyKey)).toBe(true);
    expect(await s.vault.read(s.ana.id, legacy.id)).toEqual({
      username: 'ana',
      secret: 'secret-after',
    });
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
    expect(await s.vault.read(s.ana.id, item.id)).toEqual({
      username: 'ana',
      secret: KANBAN_SECRET,
    });

    // Saved again on the new address, the item follows the entry.
    await s.vault.save(s.ana.id, {
      itemId: item.id,
      toolId: 'kanban',
      username: 'ana',
      secret: 'second',
    });
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
    expect(await vault.read(s.ana.id, item.id)).toEqual({
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

describe('several credentials of one tool (RF-65)', () => {
  test('the first credential of a tool is the default and the ones added later are not', async () => {
    const s = scene();

    const first = await s.vault.save(s.ana.id, {
      toolId: 'kanban',
      username: 'ana',
      secret: 'one',
      label: 'Work',
    });
    const second = await s.vault.save(s.ana.id, {
      toolId: 'kanban',
      username: 'ana',
      secret: 'two',
      label: 'Ops',
    });

    expect(first.isDefault).toBe(true);
    expect(second.isDefault).toBe(false);
    expect(s.repo.defaultVaultItem(s.ana.id, 'kanban')?.id).toBe(first.id);
    // Another tool starts its own: the default is a fact of one (person, tool).
    const affine = await s.vault.save(s.ana.id, {
      toolId: 'affine',
      username: 'ana',
      secret: 'three',
    });
    expect(affine.isDefault).toBe(true);
    // And it is the person's own: another person's credential of the same tool is a default of theirs.
    const hers = await s.vault.save(s.bruno.id, {
      toolId: 'kanban',
      username: 'bruno',
      secret: 'his',
    });
    expect(hers.isDefault).toBe(true);
  });

  test('the fill reads the default of the tool; the named read reaches the others', async () => {
    const s = scene();

    const work = await s.vault.save(s.ana.id, {
      toolId: 'kanban',
      username: 'ana',
      secret: 'secret-work',
      label: 'Work',
    });
    const ops = await s.vault.save(s.ana.id, {
      toolId: 'kanban',
      username: 'ops',
      secret: 'secret-ops',
      label: 'Ops',
    });

    // What `backend/main.ts`'s `credentialOf` asks for, with the tool the window is on.
    expect(await s.vault.readDefault(s.ana.id, 'kanban')).toEqual({
      username: 'ana',
      secret: 'secret-work',
    });
    expect(await s.vault.readDefault(s.ana.id, 'affine')).toBeNull();
    // `read` is the one that reaches the credential the person named.
    expect(await s.vault.read(s.ana.id, ops.id)).toEqual({ username: 'ops', secret: 'secret-ops' });
    expect(await s.vault.readDefault(s.ana.id, work.toolId)).toEqual(await s.vault.read(s.ana.id, work.id));
  });

  test('setDefault moves the fill to the chosen credential', async () => {
    const s = scene();

    const work = await s.vault.save(s.ana.id, {
      toolId: 'kanban',
      username: 'ana',
      secret: 'secret-work',
      label: 'Work',
    });
    const ops = await s.vault.save(s.ana.id, {
      toolId: 'kanban',
      username: 'ops',
      secret: 'secret-ops',
      label: 'Ops',
    });

    const moved = s.repo.setVaultDefault(s.ana.id, ops.id);

    expect(moved.id).toBe(ops.id);
    expect(moved.isDefault).toBe(true);
    expect(s.repo.vaultItemById(s.ana.id, work.id)?.isDefault).toBe(false);
    expect(s.repo.defaultVaultItem(s.ana.id, 'kanban')?.id).toBe(ops.id);
    expect(await s.vault.readDefault(s.ana.id, 'kanban')).toEqual({
      username: 'ops',
      secret: 'secret-ops',
    });
    // An id this person does not hold is the refusal every vault write by id gives.
    expect(() => s.repo.setVaultDefault(s.ana.id, 'no-such-item')).toThrow('unknown credential');
    expect(s.repo.defaultVaultItem(s.ana.id, 'kanban')?.id).toBe(ops.id);
  });

  test('the fill origin follows the default credential', async () => {
    const s = scene();

    const work = await s.vault.save(s.ana.id, {
      toolId: 'kanban',
      username: 'ana',
      secret: 'one',
      label: 'Work',
    });
    // The address moves and a second credential is saved on the new one (RF-38 binds each item to
    // the origin it was saved for).
    s.repo.saveEntry({ ...tool('kanban'), url: 'https://moved.example.test/app' });
    const ops = await s.vault.save(s.ana.id, {
      toolId: 'kanban',
      username: 'ops',
      secret: 'two',
      label: 'Ops',
    });
    expect(s.repo.vaultOrigin(s.ana.id, 'kanban')).toBe('https://kanban.example.test');

    s.repo.setVaultDefault(s.ana.id, ops.id);

    // The window fills only on the origin of the credential that fills it.
    expect(s.repo.vaultOrigin(s.ana.id, 'kanban')).toBe('https://moved.example.test');
    expect(work.isDefault).toBe(true);
  });

  test('removing the default promotes the oldest credential left', async () => {
    const s = scene();

    const first = await s.vault.save(s.ana.id, {
      toolId: 'kanban',
      username: 'ana',
      secret: 'one',
      label: 'First',
    });
    const second = await s.vault.save(s.ana.id, {
      toolId: 'kanban',
      username: 'ana',
      secret: 'two',
      label: 'Second',
    });
    const third = await s.vault.save(s.ana.id, {
      toolId: 'kanban',
      username: 'ana',
      secret: 'three',
      label: 'Third',
    });
    // Distinct instants, so "the oldest" is a fact of the test and not of the clock.
    s.db.run('UPDATE vault_item SET created_at = ? WHERE id = ?', ['2026-10-18T10:00:00.000Z', first.id]);
    s.db.run('UPDATE vault_item SET created_at = ? WHERE id = ?', ['2026-10-18T10:01:00.000Z', second.id]);
    s.db.run('UPDATE vault_item SET created_at = ? WHERE id = ?', ['2026-10-18T10:02:00.000Z', third.id]);

    await s.vault.remove(s.ana.id, first.id);

    expect(s.repo.defaultVaultItem(s.ana.id, 'kanban')?.id).toBe(second.id);
    expect(s.repo.vaultItemById(s.ana.id, second.id)?.isDefault).toBe(true);
    expect(await s.vault.readDefault(s.ana.id, 'kanban')).toEqual({ username: 'ana', secret: 'two' });

    // Removing a credential that is not the default leaves the flag where it is.
    await s.vault.remove(s.ana.id, third.id);
    expect(s.repo.defaultVaultItem(s.ana.id, 'kanban')?.id).toBe(second.id);

    // The last credential of the tool gone leaves it with no default at all.
    await s.vault.remove(s.ana.id, second.id);
    expect(s.repo.defaultVaultItem(s.ana.id, 'kanban')).toBeNull();
    expect(await s.vault.readDefault(s.ana.id, 'kanban')).toBeNull();
  });
});

describe('remove', () => {
  test('remove deletes that credential only — its keychain key and its index row', async () => {
    const s = scene();
    const work = await s.vault.save(s.ana.id, {
      toolId: 'kanban',
      username: 'ana',
      secret: 'one',
      label: 'Work',
    });
    const other = await s.vault.save(s.ana.id, {
      toolId: 'kanban',
      username: 'ana',
      secret: 'two',
      label: 'Other',
    });

    await s.vault.remove(s.ana.id, work.id);

    expect(s.items.has(work.keychainKey)).toBe(false);
    expect(s.repo.vaultItemById(s.ana.id, work.id)).toBeNull();
    expect(await s.vault.read(s.ana.id, work.id)).toBeNull();
    // The other credential of the tool is untouched, value and row alike.
    expect(s.items.has(other.keychainKey)).toBe(true);
    expect(await s.vault.read(s.ana.id, other.id)).toEqual({ username: 'ana', secret: 'two' });
  });

  test('an id this person does not hold is refused and removes nothing', async () => {
    const s = scene();
    const item = await s.vault.save(s.ana.id, {
      toolId: 'kanban',
      username: 'ana',
      secret: 'one',
    });
    const hers = await s.vault.save(s.bruno.id, {
      toolId: 'kanban',
      username: 'bruno',
      secret: 'his',
    });

    expect(await messageOf(() => s.vault.remove(s.ana.id, 'no-such-item'))).toBe('unknown credential');
    expect(await messageOf(() => s.vault.remove(s.ana.id, hers.id))).toBe('unknown credential');

    expect(s.items.has(item.keychainKey)).toBe(true);
    expect(s.items.has(hers.keychainKey)).toBe(true);
    expect(s.repo.listVault(s.ana.id)).toHaveLength(1);
  });

  test('removeAllOf clears every credential of the requested person only', async () => {
    const s = scene();
    const work = await s.vault.save(s.ana.id, {
      toolId: 'kanban',
      username: 'ana',
      secret: 'one',
      label: 'Work',
    });
    const personal = await s.vault.save(s.ana.id, {
      toolId: 'kanban',
      username: 'ana',
      secret: 'two',
      label: 'Personal',
    });
    const affine = await s.vault.save(s.ana.id, {
      toolId: 'affine',
      username: 'ana',
      secret: 'three',
    });
    const hers = await s.vault.save(s.bruno.id, {
      toolId: 'kanban',
      username: 'bruno',
      secret: 'four',
    });

    await s.vault.removeAllOf(s.ana.id);

    expect(s.items.has(work.keychainKey)).toBe(false);
    expect(s.items.has(personal.keychainKey)).toBe(false);
    expect(s.items.has(affine.keychainKey)).toBe(false);
    expect(s.repo.listVault(s.ana.id)).toEqual([]);
    expect(s.repo.listVault(s.bruno.id)).toHaveLength(1);
    expect(await decryptVaultValue(VAULT_KEY, hers.keychainKey, s.items.get(hers.keychainKey) ?? '')).toEqual(
      { username: 'bruno', secret: 'four' },
    );
  });

  test('removeAllForTool clears every credential of that tool, of every person (A6)', async () => {
    const s = scene();
    const anaWork = await s.vault.save(s.ana.id, {
      toolId: 'kanban',
      username: 'ana',
      secret: 'one',
      label: 'Work',
    });
    const anaPersonal = await s.vault.save(s.ana.id, {
      toolId: 'kanban',
      username: 'ana',
      secret: 'two',
      label: 'Personal',
    });
    const brunoKanban = await s.vault.save(s.bruno.id, {
      toolId: 'kanban',
      username: 'bruno',
      secret: 'three',
    });
    const anaAffine = await s.vault.save(s.ana.id, {
      toolId: 'affine',
      username: 'ana',
      secret: 'four',
    });

    await s.vault.removeAllForTool('kanban');

    expect(s.items.has(anaWork.keychainKey)).toBe(false);
    expect(s.items.has(anaPersonal.keychainKey)).toBe(false);
    expect(s.items.has(brunoKanban.keychainKey)).toBe(false);
    expect(s.repo.vaultItemsByTool('kanban')).toEqual([]);
    expect(s.repo.listVault(s.ana.id)).toEqual([anaAffine]);
    expect(s.repo.listVault(s.bruno.id)).toEqual([]);
    expect(
      await decryptVaultValue(VAULT_KEY, anaAffine.keychainKey, s.items.get(anaAffine.keychainKey) ?? ''),
    ).toEqual({ username: 'ana', secret: 'four' });
  });
});

describe('export and import', () => {
  test('the encrypted round trip restores every credential in another person keychain', async () => {
    const s = scene();
    await s.vault.save(s.ana.id, {
      toolId: 'kanban',
      username: 'ana',
      secret: 'secret-one',
      label: 'Work',
    });
    await s.vault.save(s.ana.id, {
      toolId: 'kanban',
      username: 'ops',
      secret: 'secret-two',
      label: 'Ops',
    });
    await s.vault.save(s.ana.id, {
      toolId: 'affine',
      username: 'ana',
      secret: 'secret-three',
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
    expect(blob).not.toContain('secret-three');
    expect(JSON.parse(atob(blob)).alg).toBe('PBKDF2-SHA256+AES-256-GCM');

    const total = await s.vault.import(s.bruno.id, blob, 'export-password');

    // Every credential of the person went to the file and came back — both of the one tool.
    expect(total).toBe(3);
    const imported = s.vault.list(s.bruno.id);
    expect(imported.map((item) => item.label).sort()).toEqual(['Affine', 'Ops', 'Work']);
    // Each imported credential got its own keychain key.
    expect(new Set(imported.map((item) => item.keychainKey)).size).toBe(3);
    const work = itemOf(s.vault, s.bruno.id, 'Work');
    const ops = itemOf(s.vault, s.bruno.id, 'Ops');
    const affine = itemOf(s.vault, s.bruno.id, 'Affine');
    expect(await s.vault.read(s.bruno.id, work.id)).toEqual({ username: 'ana', secret: 'secret-one' });
    expect(await s.vault.read(s.bruno.id, ops.id)).toEqual({ username: 'ops', secret: 'secret-two' });
    expect(await s.vault.read(s.bruno.id, affine.id)).toEqual({
      username: 'ana',
      secret: 'secret-three',
    });
    // Each tool of the file has a default: the first credential the import added to it (RF-65).
    expect(affine.isDefault).toBe(true);
    expect(imported.filter((item) => item.toolId === 'kanban' && item.isDefault)).toHaveLength(1);
    // The source vault keeps its own items.
    expect(s.repo.listVault(s.ana.id)).toHaveLength(4);
  });

  test('importing the same file again replaces by tool and username instead of piling copies up', async () => {
    const s = scene();
    const work = await s.vault.save(s.ana.id, {
      toolId: 'kanban',
      username: 'ana',
      secret: 'one',
      label: 'Work',
    });
    const blob = await s.vault.export(s.ana.id, 'export-password');
    const ops = await s.vault.save(s.ana.id, {
      toolId: 'kanban',
      username: 'ops',
      secret: 'two',
      label: 'Ops',
    });

    expect(await s.vault.import(s.ana.id, blob, 'export-password')).toBe(1);

    // The file's credential replaced the one with the same username; the other stayed where it was.
    expect(
      s.vault
        .list(s.ana.id)
        .map((item) => item.id)
        .sort(),
    ).toEqual([ops.id, work.id].sort());
    expect(s.items.size).toBe(2);
    expect(await s.vault.read(s.ana.id, work.id)).toEqual({ username: 'ana', secret: 'one' });
    expect(s.repo.defaultVaultItem(s.ana.id, 'kanban')?.id).toBe(work.id);
  });

  test('importing a credential whose username this tool does not hold adds it beside the others', async () => {
    const s = scene();
    const work = await s.vault.save(s.ana.id, {
      toolId: 'kanban',
      username: 'ana',
      secret: 'one',
      label: 'Work',
    });
    await s.vault.save(s.bruno.id, {
      toolId: 'kanban',
      username: 'bruno',
      secret: 'his',
      label: 'His',
    });
    const blob = await s.vault.export(s.bruno.id, 'export-password');

    expect(await s.vault.import(s.ana.id, blob, 'export-password')).toBe(1);

    const items = s.vault.list(s.ana.id);
    expect(items).toHaveLength(2);
    expect(items.filter((item) => item.toolId === 'kanban').map((item) => item.username).sort()).toEqual([
      'ana',
      'bruno',
    ]);
    // The credential that was already the default of the tool keeps the flag.
    expect(s.repo.defaultVaultItem(s.ana.id, 'kanban')?.id).toBe(work.id);
  });

  test('a wrong password imports nothing and an empty vault exports an importable file', async () => {
    const s = scene();
    const item = await s.vault.save(s.ana.id, {
      toolId: 'kanban',
      username: 'ana',
      secret: 'secret-one',
    });
    const blob = await s.vault.export(s.ana.id, 'export-password');

    expect(await messageOf(() => s.vault.import(s.bruno.id, blob, 'wrong-password'))).toBe(
      'wrong password or invalid file',
    );
    expect(s.repo.listVault(s.bruno.id)).toEqual([]);
    expect(s.items.size).toBe(1);

    const empty = await s.vault.export(s.bruno.id, 'another-password');
    expect(await s.vault.import(s.bruno.id, empty, 'another-password')).toBe(0);
    expect(s.repo.listVault(s.bruno.id)).toEqual([]);
    expect(await s.vault.read(s.ana.id, item.id)).toEqual({
      username: 'ana',
      secret: 'secret-one',
    });
  });
});

describe('a re-keyed credential (B8b)', () => {
  test('it keeps its id and the key it was sealed under, and a save rewrites it in place', async () => {
    const s = scene();
    // A credential saved for the old tool id, then moved to a new id the way
    // `repo.rekeyVaultTool` does it: the index row moves, its `keychain_key` does not.
    const item = await s.vault.save(s.ana.id, {
      toolId: 'kanban',
      username: 'ana',
      secret: KANBAN_SECRET,
    });
    s.repo.saveEntry(tool('kanban-personal'));
    expect(s.repo.rekeyVaultTool('kanban', 'kanban-personal')).toBe(1);
    expect(s.repo.vaultItemById(s.ana.id, item.id)?.toolId).toBe('kanban-personal');
    expect(s.repo.vaultItemById(s.ana.id, item.id)?.keychainKey).toBe(item.keychainKey);
    // The value still opens: its AAD is the key the row kept.
    expect(await s.vault.read(s.ana.id, item.id)).toEqual({
      username: 'ana',
      secret: KANBAN_SECRET,
    });

    const again = await s.vault.save(s.ana.id, {
      itemId: item.id,
      toolId: 'kanban-personal',
      username: 'ana',
      secret: 'secret-after',
    });

    // Same row, same key: one value in the keychain, nothing orphaned under the old tool id.
    expect(again.id).toBe(item.id);
    expect(again.keychainKey).toBe(item.keychainKey);
    expect(s.items.size).toBe(1);
    expect(await s.vault.read(s.ana.id, item.id)).toEqual({
      username: 'ana',
      secret: 'secret-after',
    });
  });
});
