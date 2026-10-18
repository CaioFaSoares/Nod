// Repository against in-memory SQLite (bun:sqlite): proves the visible behaviour of every method of
// the contract (`backend/repo.ts`) and its boundaries — schema versioning, revocation, rewrite of
// views/grants, used and expired invites, atomic invite consumption, vault upsert and the origin a
// credential is bound to, event filters and JSONL, the event push of SP04 §5 (client ids, the unsent
// batch, the ack and the counters), login results, meta.
import { describe, expect, test } from 'bun:test';
import { createRepo, LegacyDatabaseError, SCHEMA_VERSION } from '../backend/repo';
import type { Repo } from '../backend/repo';
import { memorySqlite } from './helpers/sqlite-bun';
import type { PasswordHashV2 } from '../shared/auth';
import type { Entry, PasswordHash, Probe, SqlDb } from '../shared/types';

// A fake hash: the repository stores and returns the `PasswordHash`; it never computes PBKDF2.
const PASSWORD: PasswordHash = {
  algorithm: 'PBKDF2-SHA256',
  hash: 'aGFzaC1hbnRpZ28=',
  salt: 'c2FsdC1hbnRpZ28=',
  iterations: 1000,
};

function newRepo() {
  const repo = createRepo(memorySqlite());
  repo.migrate();
  repo.ensureAdminRole();
  return repo;
}

/** The schema version SQLite keeps in the database header (`PRAGMA user_version`). */
function userVersion(db: SqlDb): number {
  return db.all<{ user_version: number }>('PRAGMA user_version')[0]?.user_version ?? -1;
}

/** Every table of the database, by name: what a migration created and what it left alone. */
function tableNames(db: SqlDb): string[] {
  return db
    .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .map((row) => row.name);
}

/** The columns of a table as SQLite describes them: name, type, nullability, default and key. */
function shapeOf(db: SqlDb, table: string): unknown[] {
  return db.all(`PRAGMA table_info(${table})`);
}

/** The foreign keys of a table, by the table they point at: what a rebuild has to keep or drop. */
function foreignKeysOf(db: SqlDb, table: string): { table: string; from: string; to: string }[] {
  return db
    .all<{ table: string; from: string; to: string }>(`PRAGMA foreign_key_list(${table})`)
    .map((row) => ({ table: row.table, from: row.from, to: row.to }))
    .sort((a, b) => a.table.localeCompare(b.table));
}

/** Whether the connection has `PRAGMA foreign_keys = ON` (what `openSqlite` sets, B9). */
function foreignKeysOn(db: SqlDb): boolean {
  return db.all<{ foreign_keys: number }>('PRAGMA foreign_keys')[0]?.foreign_keys === 1;
}

function entry(id: string, fields: Partial<Entry> = {}): Entry {
  return {
    id,
    title: `Tool ${id}`,
    url: `https://${id}.example.test/app`,
    icon: null,
    order: 1,
    roles: [],
    views: [],
    auth: null,
    active: true,
    ...fields,
  };
}

describe('schema', () => {
  test('migrate() twice does not throw', () => {
    const repo = createRepo(memorySqlite());
    repo.migrate();
    expect(() => repo.migrate()).not.toThrow();
  });

  test('ensureAdminRole is idempotent and always returns the canonical name', () => {
    const repo = newRepo();
    expect(repo.ensureAdminRole()).toEqual({ id: 'admin', name: 'Admin', admin: true });
    expect(repo.listRoles()).toHaveLength(1);
    repo.saveRole({ id: 'admin', name: 'Some other name', admin: false });
    expect(repo.ensureAdminRole().name).toBe('Admin');
    expect(repo.listRoles()).toHaveLength(1);
  });
});

describe('schema versioning', () => {
  test('an empty database is created and stamped with the current version; migrate stays idempotent', () => {
    const db = memorySqlite();
    const repo = createRepo(db);
    expect(userVersion(db)).toBe(0);

    repo.migrate();
    expect(userVersion(db)).toBe(SCHEMA_VERSION);
    expect(repo.listRoles()).toEqual([]);

    repo.migrate();
    expect(userVersion(db)).toBe(SCHEMA_VERSION);
  });

  test('a database from an earlier v2 build has no version: it is completed and stamped, not refused', () => {
    const db = memorySqlite();
    const repo = createRepo(db);
    repo.migrate();
    repo.ensureAdminRole();

    // What a v2 build before the versioning left behind: the schema, and no `user_version`.
    db.exec('PRAGMA user_version = 0');

    expect(() => repo.migrate()).not.toThrow();
    expect(userVersion(db)).toBe(SCHEMA_VERSION);
    expect(repo.listRoles().map((r) => r.id)).toEqual(['admin']);
  });

  test('a v2 database from before the vault origin column is completed and its items are backfilled', () => {
    const db = memorySqlite();
    const before = createRepo(db);
    before.migrate();
    before.saveEntry(entry('alpha', { url: 'https://alpha.example.test/app' }));
    const person = before.createPerson({
      email: 'ana@example.test',
      name: 'Ana',
      password: PASSWORD,
      roles: [],
    });
    // What that build left behind: `user_version = 2` and a `vault_item` with no `origin` column,
    // so the `CREATE TABLE IF NOT EXISTS` of this build is skipped and the ALTER has to add it.
    db.exec('ALTER TABLE vault_item DROP COLUMN origin');
    db.run(
      `INSERT INTO vault_item (id, person_id, tool_id, label, username, keychain_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        person.id,
        'alpha',
        'Alpha',
        'ana',
        `nod.cred.${person.id}.alpha`,
        '2026-10-15T10:00:00.000Z',
        '2026-10-15T10:00:00.000Z',
      ],
    );
    expect(() => db.all('SELECT origin FROM vault_item')).toThrow();

    const repo = createRepo(db);
    repo.migrate();

    // The item written before the column existed takes the origin of its tool.
    expect(repo.vaultOrigin(person.id, 'alpha')).toBe('https://alpha.example.test');
    expect(repo.listVault(person.id)).toHaveLength(1);
    expect(userVersion(db)).toBe(SCHEMA_VERSION);

    // The migrated table and a fresh one hold the same columns. `ALTER TABLE … ADD COLUMN` appends,
    // so the order differs by construction; every read names its columns.
    const fresh = memorySqlite();
    createRepo(fresh).migrate();
    const migrated = db.all<{ name: string }>('PRAGMA table_info(vault_item)').map((row) => row.name);
    const created = fresh.all<{ name: string }>('PRAGMA table_info(vault_item)').map((row) => row.name);
    expect([...migrated].sort()).toEqual([...created].sort());

    // A second migrate neither throws nor loses what the backfill wrote.
    repo.migrate();
    expect(repo.vaultOrigin(person.id, 'alpha')).toBe('https://alpha.example.test');
  });

  test('a v1 database (meta with chave/valor) is refused as legacy, with nothing written', () => {
    const db = memorySqlite();
    db.exec('CREATE TABLE meta (chave TEXT PRIMARY KEY, valor TEXT NOT NULL)');

    expect(() => createRepo(db).migrate()).toThrow(LegacyDatabaseError);
    expect(userVersion(db)).toBe(0);
    const tables = db
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .map((row) => row.name);
    expect(tables).toEqual(['meta']);
  });

  test('a database holding a v1 table is refused as legacy', () => {
    const db = memorySqlite();
    db.exec('CREATE TABLE pessoa (id TEXT PRIMARY KEY)');

    expect(() => createRepo(db).migrate()).toThrow(LegacyDatabaseError);
    const tables = db
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .map((row) => row.name);
    expect(tables).toEqual(['pessoa']);
  });

  test('a version this build does not know is refused by name', () => {
    // The versioning started at 2, so `1` was never written by any build; the one after this
    // build's is a database from the future. Neither is completed — the database is refused whole.
    for (const version of [1, SCHEMA_VERSION + 1]) {
      const db = memorySqlite();
      db.exec(`PRAGMA user_version = ${version}`);
      expect(() => createRepo(db).migrate()).toThrow(`unsupported database version: ${version}`);
      expect(userVersion(db)).toBe(version);
    }
  });
});

describe('people', () => {
  test('admin is derived from the roles; e-mail is normalized and looked up case-insensitively', () => {
    const repo = newRepo();
    const person = repo.createPerson({ email: ' X@Y.com ', name: 'X', password: PASSWORD, roles: ['admin'] });

    expect(person.email).toBe('x@y.com');
    expect(person.admin).toBe(true);
    expect(person.roles).toEqual(['admin']);
    expect(repo.personByEmail('X@Y.com')).toEqual({ person, password: PASSWORD });
    expect(repo.personByEmail('x@y.COM')?.person.id).toBe(person.id);
    expect(repo.personByEmail('other@y.com')).toBeNull();

    repo.saveRole({ id: 'reader', name: 'Reader', admin: false });
    const noAdmin = repo.createPerson({ email: 'ana@example.test', name: 'Ana', password: PASSWORD, roles: ['reader'] });
    expect(noAdmin.admin).toBe(false);
    expect(repo.personById(noAdmin.id)?.roles).toEqual(['reader']);

    const promoted = repo.setRoles(noAdmin.id, ['reader', 'admin', 'reader']);
    expect(promoted.roles).toEqual(['admin', 'reader']);
    expect(promoted.admin).toBe(true);
    expect(repo.countAdmins()).toBe(2);
  });

  test('changePassword swaps hash, salt and iterations', () => {
    const repo = newRepo();
    const person = repo.createPerson({ email: 'p@example.test', name: 'P', password: PASSWORD, roles: [] });

    repo.changePassword(person.id, { ...PASSWORD, hash: 'b3V0cm8=', iterations: 2000 });

    expect(repo.personByEmail('p@example.test')?.password).toEqual({ ...PASSWORD, hash: 'b3V0cm8=', iterations: 2000 });
  });

  test('a revoked person disappears from the reads but is still counted', () => {
    const repo = newRepo();
    const person = repo.createPerson({ email: 'rev@example.test', name: 'Rev', password: PASSWORD, roles: ['admin'] });
    expect(repo.listPeople().map((p) => p.id)).toEqual([person.id]);
    expect(repo.countPeople()).toBe(1);
    expect(repo.countAdmins()).toBe(1);

    repo.revokePerson(person.id);

    expect(repo.personByEmail('rev@example.test')).toBeNull();
    expect(repo.personById(person.id)).toBeNull();
    expect(repo.listPeople()).toEqual([]);
    // The row stays: the first-account rule (P6) and the admin count read the table.
    expect(repo.countPeople()).toBe(1);
    expect(repo.countAdmins()).toBe(0);
  });
});

describe('roles', () => {
  test('removeRole deletes grants and links; the admin role does not go', () => {
    const repo = newRepo();
    repo.saveRole({ id: 'team-x', name: 'Team X', admin: false });
    const person = repo.createPerson({
      email: 'bia@example.test',
      name: 'Bia',
      password: PASSWORD,
      roles: ['admin', 'team-x'],
    });
    repo.saveEntry(entry('alpha', { roles: ['team-x'] }));

    expect(() => repo.removeRole('admin')).toThrow('the admin role cannot be removed');
    expect(repo.listRoles().map((r) => r.id)).toContain('admin');
    expect(repo.personById(person.id)?.admin).toBe(true);

    repo.removeRole('team-x');

    expect(repo.listRoles().map((r) => r.id)).toEqual(['admin']);
    expect(repo.personById(person.id)?.roles).toEqual(['admin']);
    expect(repo.entry('alpha')?.roles).toEqual([]);
  });
});

describe('catalog', () => {
  test('saveEntry rewrites views and grants on every write', () => {
    const repo = newRepo();
    repo.saveRole({ id: 'team-x', name: 'Team X', admin: false });

    const saved = repo.saveEntry(
      entry('my-tool', {
        roles: ['admin', 'team-x'],
        views: [
          { label: 'Dashboard', url: 'https://my-tool.example.test/dashboard', mode: 'window' },
          { label: 'Reports', url: 'https://my-tool.example.test/reports', mode: 'navigate' },
        ],
      }),
    );

    expect(saved.icon).toBeNull();
    expect(saved.roles).toEqual(['admin', 'team-x']);
    expect(saved.views).toEqual([
      { label: 'Dashboard', url: 'https://my-tool.example.test/dashboard', mode: 'window' },
      { label: 'Reports', url: 'https://my-tool.example.test/reports', mode: 'navigate' },
    ]);

    const again = repo.saveEntry(
      entry('my-tool', {
        title: 'My tool v2',
        roles: ['team-x'],
        views: [{ label: 'Dashboard', url: 'https://my-tool.example.test/dashboard', mode: 'navigate' }],
      }),
    );

    expect(again.title).toBe('My tool v2');
    expect(again.roles).toEqual(['team-x']);
    expect(again.views).toEqual([
      { label: 'Dashboard', url: 'https://my-tool.example.test/dashboard', mode: 'navigate' },
    ]);
    expect(repo.entry('my-tool')?.views).toHaveLength(1);
    expect(repo.listEntries()).toHaveLength(1);

    repo.grant('team-x', 'my-tool', false);
    expect(repo.entry('my-tool')?.roles).toEqual([]);
    repo.grant('team-x', 'my-tool', true);
    expect(repo.entry('my-tool')?.roles).toEqual(['team-x']);
  });

  test('icon hash and probe only change when they come in extras', () => {
    const repo = newRepo();
    const e = entry('with-icon');
    const probe: Probe = {
      url: e.url,
      origin: 'https://with-icon.example.test',
      finalUrl: e.url,
      title: 'With icon',
      icon: null,
      hasLoginForm: true,
      provider: null,
    };

    repo.saveEntry(e, { iconHash: 'abc123', probe });
    expect(repo.iconHash('with-icon')).toBe('abc123');
    expect(repo.probe('with-icon')).toEqual(probe);

    repo.saveEntry(entry('with-icon', { title: 'With icon v2' }));
    expect(repo.iconHash('with-icon')).toBe('abc123');
    expect(repo.probe('with-icon')?.title).toBe('With icon');
    expect(repo.entry('with-icon')?.title).toBe('With icon v2');

    // An explicit `null` clears; a missing key preserves.
    repo.saveEntry(entry('with-icon'), { probe: null });
    expect(repo.probe('with-icon')).toBeNull();
    expect(repo.iconHash('with-icon')).toBe('abc123');

    repo.saveEntry(entry('with-icon'), { iconHash: null });
    expect(repo.iconHash('with-icon')).toBeNull();

    repo.saveEntry(entry('no-icon'), {});
    expect(repo.iconHash('no-icon')).toBeNull();
    expect(repo.probe('no-icon')).toBeNull();
    expect(repo.iconHash('missing')).toBeNull();
    expect(repo.probe('missing')).toBeNull();
  });

  test('auth override round-trips through the entry', () => {
    const repo = newRepo();
    repo.saveEntry(entry('no-fill', { auth: { noFill: true } }));
    expect(repo.entry('no-fill')?.auth).toEqual({ noFill: true });

    repo.saveEntry(entry('no-fill'));
    expect(repo.entry('no-fill')?.auth).toBeNull();
  });

  test('listEntries orders by order and title; removeEntry takes views, grants and vault with it', () => {
    const repo = newRepo();
    repo.saveRole({ id: 'team-x', name: 'Team X', admin: false });
    repo.saveEntry(
      entry('zebra', {
        title: 'Zebra',
        order: 2,
        roles: ['team-x'],
        views: [{ label: 'Z', url: 'https://zebra.example.test/z', mode: 'window' }],
      }),
    );
    repo.saveEntry(entry('alpha', { title: 'Alpha', order: 1, roles: ['team-x'] }));

    expect(repo.listEntries().map((e) => e.id)).toEqual(['alpha', 'zebra']);

    const person = repo.createPerson({ email: 'ana@example.test', name: 'Ana', password: PASSWORD, roles: ['team-x'] });
    repo.saveVaultItem({
      personId: person.id,
      toolId: 'zebra',
      label: 'Zebra',
      username: 'ana',
      keychainKey: `nod.cred.${person.id}.zebra`,
      origin: 'https://zebra.example.test',
    });

    repo.removeEntry('zebra');

    expect(repo.entry('zebra')).toBeNull();
    expect(repo.listEntries().map((e) => e.id)).toEqual(['alpha']);
    expect(repo.listVault(person.id)).toEqual([]);
    expect(repo.listRoles().map((r) => r.id)).toContain('team-x');
    expect(repo.personById(person.id)?.roles).toEqual(['team-x']);
  });
});

describe('invites', () => {
  test('a repeated code_hash returns the existing invite; activeInvite respects use and validity', () => {
    const repo = newRepo();
    const now = new Date('2026-10-15T12:00:00.000Z');
    const codeHash = 'a'.repeat(64);

    const invite = repo.saveInvite({
      codeHash,
      roles: ['admin'],
      expiresAt: '2026-10-20T12:00:00.000Z',
      createdBy: null,
    });
    expect(invite.usedAt).toBeNull();
    expect(invite.roles).toEqual(['admin']);
    expect(
      repo.saveInvite({ codeHash, roles: [], expiresAt: '2026-10-14T12:00:00.000Z', createdBy: 'someone' }),
    ).toEqual(invite);

    expect(repo.activeInvite(codeHash, now)?.id).toBe(invite.id);

    const expired = repo.saveInvite({
      codeHash: 'b'.repeat(64),
      roles: ['admin'],
      expiresAt: '2026-10-14T12:00:00.000Z',
      createdBy: null,
    });
    expect(repo.activeInvite(expired.codeHash, now)).toBeNull();

    // Expiring exactly now is already out of validity.
    const onTheLine = repo.saveInvite({
      codeHash: 'c'.repeat(64),
      roles: [],
      expiresAt: now.toISOString(),
      createdBy: null,
    });
    expect(repo.activeInvite(onTheLine.codeHash, now)).toBeNull();

    expect(repo.listInvites()).toHaveLength(3);
  });

  test('createPersonWithInvite consumes the code and creates the person with the invite roles', () => {
    const repo = newRepo();
    repo.saveRole({ id: 'team-x', name: 'Team X', admin: false });
    const now = new Date('2026-10-15T12:00:00.000Z');
    const codeHash = 'd'.repeat(64);
    repo.saveInvite({ codeHash, roles: ['team-x'], expiresAt: '2026-10-20T12:00:00.000Z', createdBy: null });

    const person = repo.createPersonWithInvite({ email: 'new@example.test', name: 'New', password: PASSWORD }, codeHash, now);

    expect(person?.email).toBe('new@example.test');
    expect(person?.roles).toEqual(['team-x']);
    expect(person?.admin).toBe(false);
    expect(repo.countPeople()).toBe(1);
    // Consumed: the invite leaves the active list and keeps the instant of the consumption.
    expect(repo.activeInvite(codeHash, now)).toBeNull();
    expect(repo.listInvites()[0]?.usedAt).toBe(now.toISOString());

    // Second call with the same code: no person, no consumption.
    const second = repo.createPersonWithInvite({ email: 'other@example.test', name: 'Other', password: PASSWORD }, codeHash, now);
    expect(second).toBeNull();
    expect(repo.countPeople()).toBe(1);
    expect(repo.personByEmail('other@example.test')).toBeNull();
  });

  test('an admin invite creates an admin person; an unknown code creates nobody', () => {
    const repo = newRepo();
    const now = new Date('2026-10-15T12:00:00.000Z');
    const codeHash = 'e'.repeat(64);
    repo.saveInvite({ codeHash, roles: ['admin'], expiresAt: '2026-10-20T12:00:00.000Z', createdBy: null });

    const person = repo.createPersonWithInvite({ email: 'boss@example.test', name: 'Boss', password: PASSWORD }, codeHash, now);
    expect(person?.admin).toBe(true);
    expect(repo.countAdmins()).toBe(1);

    expect(
      repo.createPersonWithInvite({ email: 'ghost@example.test', name: 'Ghost', password: PASSWORD }, 'f'.repeat(64), now),
    ).toBeNull();
    expect(repo.countPeople()).toBe(1);
  });

  test('an expired invite is not consumed and creates nobody', () => {
    const repo = newRepo();
    const now = new Date('2026-10-15T12:00:00.000Z');
    const codeHash = 'a'.repeat(64);
    repo.saveInvite({ codeHash, roles: ['admin'], expiresAt: '2026-10-14T12:00:00.000Z', createdBy: null });

    expect(repo.createPersonWithInvite({ email: 'late@example.test', name: 'Late', password: PASSWORD }, codeHash, now)).toBeNull();

    expect(repo.countPeople()).toBe(0);
    expect(repo.personByEmail('late@example.test')).toBeNull();
    expect(repo.listInvites()[0]?.usedAt).toBeNull();
  });

  test('a failure while creating the person rolls the consumption back (D7)', () => {
    const repo = newRepo();
    repo.createPerson({ email: 'taken@example.test', name: 'Taken', password: PASSWORD, roles: [] });
    const now = new Date('2026-10-15T12:00:00.000Z');
    const codeHash = 'b'.repeat(64);
    repo.saveInvite({ codeHash, roles: [], expiresAt: '2026-10-20T12:00:00.000Z', createdBy: null });

    // The e-mail is already registered: the insert fails and the whole transaction goes back.
    expect(() =>
      repo.createPersonWithInvite({ email: 'taken@example.test', name: 'Duplicate', password: PASSWORD }, codeHash, now),
    ).toThrow();

    expect(repo.countPeople()).toBe(1);
    expect(repo.listInvites()[0]?.usedAt).toBeNull();
    expect(repo.activeInvite(codeHash, now)?.codeHash).toBe(codeHash);
  });
});

describe('vault', () => {
  test('saving with the itemId updates that credential; saving without one adds another', () => {
    const repo = newRepo();
    const person = repo.createPerson({ email: 'caio@example.test', name: 'Caio', password: PASSWORD, roles: ['admin'] });
    const other = repo.createPerson({ email: 'bia@example.test', name: 'Bia', password: PASSWORD, roles: [] });
    repo.saveEntry(entry('alpha'));
    repo.saveEntry(entry('beta'));

    const first = repo.saveVaultItem({
      personId: person.id,
      toolId: 'alpha',
      label: 'Alpha',
      username: 'ana',
      keychainKey: `nod.cred.${person.id}.alpha.one`,
      origin: 'https://alpha.example.test',
    });
    // RF-65: the same id is the same credential, rewritten in place.
    const second = repo.saveVaultItem({
      id: first.id,
      personId: person.id,
      toolId: 'alpha',
      label: 'Alpha (new)',
      username: 'bia',
      keychainKey: `nod.cred.${person.id}.alpha.one`,
      origin: 'https://alpha.example.test',
    });

    expect(second.id).toBe(first.id);
    expect(second.username).toBe('bia');
    expect(second.label).toBe('Alpha (new)');
    expect(second.createdAt).toBe(first.createdAt);
    expect(repo.listVault(person.id)).toHaveLength(1);
    expect(repo.vaultOrigin(person.id, 'alpha')).toBe('https://alpha.example.test');

    // No id: a second credential of the same tool, beside the first.
    const third = repo.saveVaultItem({
      personId: person.id,
      toolId: 'alpha',
      label: 'Alpha — ops',
      username: 'ops',
      keychainKey: `nod.cred.${person.id}.alpha.two`,
      origin: 'https://alpha.example.test',
    });
    expect(third.id).not.toBe(first.id);
    expect(
      repo
        .vaultItemsOfTool(person.id, 'alpha')
        .map((item) => item.label)
        .sort(),
    ).toEqual(['Alpha (new)', 'Alpha — ops']);

    repo.saveVaultItem({
      personId: other.id,
      toolId: 'alpha',
      label: 'Alpha',
      username: 'ana',
      keychainKey: `nod.cred.${other.id}.alpha`,
      origin: 'https://alpha.example.test',
    });
    repo.saveVaultItem({
      personId: person.id,
      toolId: 'beta',
      label: 'Beta',
      username: 'ana',
      keychainKey: `nod.cred.${person.id}.beta`,
      origin: 'https://beta.example.test',
    });

    expect(repo.vaultItemsByTool('alpha').map((i) => i.personId).sort()).toEqual(
      [person.id, person.id, other.id].sort(),
    );
    expect(repo.vaultItemsByTool('beta').map((i) => i.toolId)).toEqual(['beta']);
    expect(repo.vaultItemsOfTool(person.id, 'beta')[0]?.username).toBe('ana');
    expect(repo.vaultOrigin(person.id, 'beta')).toBe('https://beta.example.test');

    // One credential goes by its own id; the other two stay.
    repo.removeVaultItem(person.id, third.id);
    expect(repo.vaultItemById(person.id, third.id)).toBeNull();
    expect(repo.listVault(person.id)).toHaveLength(2);
  });

  test('the origin belongs to the credential: saving again rewrites it, a moved tool does not', () => {
    const repo = newRepo();
    const person = repo.createPerson({ email: 'ana@example.test', name: 'Ana', password: PASSWORD, roles: [] });
    repo.saveEntry(entry('alpha', { url: 'https://alpha.example.test/app' }));

    expect(repo.vaultOrigin(person.id, 'alpha')).toBeNull();

    const item = repo.saveVaultItem({
      personId: person.id,
      toolId: 'alpha',
      label: 'Alpha',
      username: 'ana',
      keychainKey: `nod.cred.${person.id}.alpha`,
      origin: 'https://alpha.example.test',
    });
    expect(repo.vaultOrigin(person.id, 'alpha')).toBe('https://alpha.example.test');

    // The tool moved: the credential the person saved stays bound to the origin it was saved for.
    repo.saveEntry(entry('alpha', { url: 'https://moved.example.test/app' }));
    expect(repo.vaultOrigin(person.id, 'alpha')).toBe('https://alpha.example.test');

    // Saved again on the new address, it follows the entry.
    repo.saveVaultItem({
      id: item.id,
      personId: person.id,
      toolId: 'alpha',
      label: 'Alpha',
      username: 'ana',
      keychainKey: `nod.cred.${person.id}.alpha`,
      origin: 'https://moved.example.test',
    });
    expect(repo.vaultOrigin(person.id, 'alpha')).toBe('https://moved.example.test');
  });

  /**
   * RF-65's default rule: exactly one `is_default` per (person, tool) whenever the tool has items —
   * the first credential of a tool gets it, `setVaultDefault` moves it and the removal of the default
   * hands it to the oldest credential left. The partial index `vault_item_default` is what makes a
   * second one impossible at the table's level.
   */
  test('the default: the first credential of a tool, moved by setVaultDefault, promoted on removal', () => {
    const db = memorySqlite();
    const repo = createRepo(db);
    repo.migrate();
    repo.ensureAdminRole();
    const person = repo.createPerson({ email: 'ana@example.test', name: 'Ana', password: PASSWORD, roles: [] });
    const other = repo.createPerson({ email: 'bia@example.test', name: 'Bia', password: PASSWORD, roles: [] });
    repo.saveEntry(entry('alpha'));

    expect(repo.defaultVaultItem(person.id, 'alpha')).toBeNull();

    const first = repo.saveVaultItem({
      personId: person.id,
      toolId: 'alpha',
      label: 'First',
      username: 'ana',
      keychainKey: `nod.cred.${person.id}.alpha.first`,
      origin: 'https://alpha.example.test',
    });
    const second = repo.saveVaultItem({
      personId: person.id,
      toolId: 'alpha',
      label: 'Second',
      username: 'ana',
      keychainKey: `nod.cred.${person.id}.alpha.second`,
      origin: 'https://alpha.example.test',
    });
    const third = repo.saveVaultItem({
      personId: person.id,
      toolId: 'alpha',
      label: 'Third',
      username: 'ana',
      keychainKey: `nod.cred.${person.id}.alpha.third`,
      origin: 'https://alpha.example.test',
    });
    // Another person's credential of the same tool has a default of its own.
    const hers = repo.saveVaultItem({
      personId: other.id,
      toolId: 'alpha',
      label: 'Hers',
      username: 'bia',
      keychainKey: `nod.cred.${other.id}.alpha`,
      origin: 'https://alpha.example.test',
    });

    expect(first.isDefault).toBe(true);
    expect(second.isDefault).toBe(false);
    expect(third.isDefault).toBe(false);
    expect(hers.isDefault).toBe(true);
    expect(repo.defaultVaultItem(person.id, 'alpha')?.id).toBe(first.id);

    // Distinct instants, so "the oldest" is a fact of the test and not of the clock: the promotion
    // reads `created_at` and breaks its ties on the id.
    for (const [at, item] of [
      ['2026-10-18T10:00:00.000Z', first],
      ['2026-10-18T10:01:00.000Z', second],
      ['2026-10-18T10:02:00.000Z', third],
    ]) {
      db.run('UPDATE vault_item SET created_at = ? WHERE id = ?', [at, item.id]);
    }

    repo.setVaultDefault(person.id, third.id);
    expect(repo.vaultItemById(person.id, first.id)?.isDefault).toBe(false);
    expect(repo.defaultVaultItem(person.id, 'alpha')?.id).toBe(third.id);
    expect(repo.setVaultDefault(person.id, third.id).isDefault).toBe(true);
    // A migrate of the same database leaves the choice where the person put it: the repair only
    // touches a group that carries several defaults, and the one chosen here is not the oldest item.
    repo.migrate();
    expect(repo.defaultVaultItem(person.id, 'alpha')?.id).toBe(third.id);
    expect(repo.vaultItemById(person.id, first.id)?.isDefault).toBe(false);
    expect(() => repo.setVaultDefault(person.id, 'no-such-item')).toThrow('unknown credential');
    expect(() => repo.setVaultDefault(other.id, third.id)).toThrow('unknown credential');

    // Removing the default hands the flag to the oldest credential left.
    repo.removeVaultItem(person.id, third.id);
    expect(repo.defaultVaultItem(person.id, 'alpha')?.id).toBe(first.id);
    repo.removeVaultItem(person.id, first.id);
    expect(repo.defaultVaultItem(person.id, 'alpha')?.id).toBe(second.id);
    // Removing an id that is not there, or one that is not the default, leaves the flag alone.
    repo.removeVaultItem(person.id, third.id);
    expect(repo.defaultVaultItem(person.id, 'alpha')?.id).toBe(second.id);
    // And a tool with no credential left has no default.
    repo.removeVaultItem(person.id, second.id);
    expect(repo.defaultVaultItem(person.id, 'alpha')).toBeNull();
    expect(repo.defaultVaultItem(other.id, 'alpha')?.id).toBe(hers.id);
  });

  test('a person holds one local copy of a shared credential (SP06 §3)', () => {
    const repo = newRepo();
    const person = repo.createPerson({ email: 'ana@example.test', name: 'Ana', password: PASSWORD, roles: [] });
    const other = repo.createPerson({ email: 'bia@example.test', name: 'Bia', password: PASSWORD, roles: [] });
    repo.saveEntry(entry('alpha'));
    repo.saveEntry(entry('beta'));

    const item = repo.saveVaultItem({
      personId: person.id,
      toolId: 'alpha',
      label: 'Alpha',
      username: 'ana',
      keychainKey: `nod.cred.${person.id}.alpha`,
      origin: 'https://alpha.example.test',
      credentialId: 'c-1',
    });
    expect(repo.vaultItemByCredential(person.id, 'c-1')?.id).toBe(item.id);
    expect(repo.vaultItemByCredential(person.id, 'c-2')).toBeNull();
    expect(repo.vaultItemByCredential(other.id, 'c-1')).toBeNull();

    // The partial index is on the pair: another person's copy of the same credential is fine, and a
    // second copy of it in this vault is not.
    repo.saveVaultItem({
      personId: other.id,
      toolId: 'alpha',
      label: 'Alpha',
      username: 'ana',
      keychainKey: `nod.cred.${other.id}.alpha`,
      origin: 'https://alpha.example.test',
      credentialId: 'c-1',
    });
    expect(() =>
      repo.saveVaultItem({
        personId: person.id,
        toolId: 'beta',
        label: 'Beta',
        username: 'ana',
        keychainKey: `nod.cred.${person.id}.beta`,
        origin: 'https://beta.example.test',
        credentialId: 'c-1',
      }),
    ).toThrow();
    // An item that never travelled carries no group at all, and many of those live side by side.
    repo.saveVaultItem({
      personId: person.id,
      toolId: 'beta',
      label: 'Beta',
      username: 'ana',
      keychainKey: `nod.cred.${person.id}.beta`,
      origin: 'https://beta.example.test',
    });
    expect(repo.vaultItemsOfTool(person.id, 'beta')).toHaveLength(1);
  });

  test('removeVaultOf returns what it removed and cleans the index', () => {
    const repo = newRepo();
    const person = repo.createPerson({ email: 'caio@example.test', name: 'Caio', password: PASSWORD, roles: ['admin'] });
    repo.saveEntry(entry('alpha'));
    repo.saveEntry(entry('beta'));

    for (const toolId of ['alpha', 'beta']) {
      repo.saveVaultItem({
        personId: person.id,
        toolId,
        label: toolId,
        username: 'ana',
        keychainKey: `nod.cred.${person.id}.${toolId}`,
        origin: `https://${toolId}.example.test`,
      });
    }

    const removed = repo.removeVaultOf(person.id);

    expect(removed.map((i) => i.toolId).sort()).toEqual(['alpha', 'beta']);
    expect(removed.map((i) => i.keychainKey).sort()).toEqual([
      `nod.cred.${person.id}.alpha`,
      `nod.cred.${person.id}.beta`,
    ]);
    expect(repo.listVault(person.id)).toEqual([]);
    expect(repo.removeVaultOf(person.id)).toEqual([]);
  });
});

describe('events', () => {
  test('addEvent returns the id; filter by tool, result and limit', () => {
    const repo = newRepo();
    const first = repo.addEvent({
      personId: null,
      toolId: 'alpha',
      type: 'tool_opened',
      url: 'https://alpha.example.test/app',
      result: null,
      detail: null,
      at: '2026-10-15T10:00:00.000Z',
    });
    repo.addEvent({
      personId: null,
      toolId: 'beta',
      type: 'tool_opened',
      url: null,
      result: null,
      detail: 'second',
      at: '2026-10-15T11:00:00.000Z',
    });
    repo.addEvent({
      personId: null,
      toolId: 'beta',
      type: 'login',
      url: null,
      result: 'manual',
      detail: null,
      at: '2026-10-15T12:00:00.000Z',
    });

    expect(first.id).toBe(1);
    expect(first.at).toBe('2026-10-15T10:00:00.000Z');
    expect(first.type).toBe('tool_opened');

    expect(repo.listEvents({ toolId: 'alpha' }).map((e) => e.id)).toEqual([1]);
    expect(repo.listEvents({ toolId: 'beta', result: 'manual' }).map((e) => e.type)).toEqual(['login']);
    expect(repo.listEvents({ result: 'manual' })).toHaveLength(1);
    expect(repo.listEvents({})).toHaveLength(3);
    expect(repo.listEvents({ personId: 'nobody' })).toEqual([]);

    // Newest first.
    expect(repo.listEvents({}).map((e) => e.id)).toEqual([3, 2, 1]);
    expect(repo.listEvents({ limit: 1 }).map((e) => e.id)).toEqual([3]);
    expect(repo.listEvents({ toolId: 'none' })).toEqual([]);
  });

  test('without `at`, the event enters with the recording instant in ISO 8601 UTC', () => {
    const repo = newRepo();
    const event = repo.addEvent({
      personId: null,
      toolId: null,
      type: 'locked',
      url: null,
      result: null,
      detail: null,
    });
    expect(event.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(repo.listEvents({}).map((e) => e.id)).toEqual([event.id]);
  });

  test('eventsJsonl: one JSON line per event, in chronological order', () => {
    const repo = newRepo();
    repo.addEvent({
      personId: 'p1',
      toolId: 'alpha',
      type: 'tool_opened',
      url: 'https://alpha.example.test/app',
      result: null,
      detail: null,
      at: '2026-10-15T10:00:00.000Z',
    });
    repo.addEvent({
      personId: null,
      toolId: 'beta',
      type: 'login',
      url: null,
      result: 'filled',
      detail: 'second',
      at: '2026-10-15T11:00:00.000Z',
    });

    const jsonl = repo.eventsJsonl();
    expect(jsonl.endsWith('\n')).toBe(true);

    const lines = jsonl.split('\n');
    expect(lines.at(-1)).toBe('');
    expect(lines).toHaveLength(3);

    const events = lines.slice(0, -1).map((line) => JSON.parse(line));
    expect(events.map((e) => e.id)).toEqual([1, 2]);
    expect(events.map((e) => e.type)).toEqual(['tool_opened', 'login']);
    expect(events[0].url).toBe('https://alpha.example.test/app');
    expect(events[1].detail).toBe('second');
    expect(events[0].at < events[1].at).toBe(true);
  });

  test('with no events, eventsJsonl returns an empty string', () => {
    const repo = newRepo();
    expect(repo.eventsJsonl()).toBe('');
  });

  test('loginResults: newest first, only the valid results of the login events of that tool', () => {
    const repo = newRepo();
    const at = (hour: number) => `2026-10-15T${String(hour).padStart(2, '0')}:00:00.000Z`;
    const event = (toolId: string, type: 'login' | 'tool_opened', result: string | null, hour: number) =>
      repo.addEvent({ personId: null, toolId, type, url: null, result, detail: null, at: at(hour) });

    event('alpha', 'login', 'failed', 10);
    event('alpha', 'login', 'session', 11);
    event('alpha', 'login', 'manual', 12);
    // Not a login event, another tool's login, and a result that is not a `LoginResult`.
    event('alpha', 'tool_opened', 'failed', 13);
    event('beta', 'login', 'provider', 14);
    event('alpha', 'login', 'junk', 15);

    expect(repo.loginResults('alpha', 10)).toEqual(['manual', 'session', 'failed']);
    expect(repo.loginResults('alpha', 2)).toEqual(['manual', 'session']);
    expect(repo.loginResults('alpha', 0)).toEqual([]);
    expect(repo.loginResults('beta', 10)).toEqual(['provider']);
    expect(repo.loginResults('gamma', 10)).toEqual([]);
  });
});

describe('event push (SP04 §5)', () => {
  /** The events as inserted, with the instant the batch order is read from. */
  function seed(repo: Repo, count: number): void {
    for (let index = 0; index < count; index += 1) {
      repo.addEvent({
        personId: null,
        toolId: 'alpha',
        type: 'tool_opened',
        url: 'https://alpha.example.test/app',
        result: null,
        detail: null,
        at: new Date(Date.parse('2026-10-15T10:00:00.000Z') + index * 1000).toISOString(),
      });
    }
  }

  test('addEvent stamps a fresh client id and leaves the event unsent', () => {
    const repo = newRepo();
    const first = repo.addEvent({
      personId: null,
      toolId: null,
      type: 'unlocked',
      url: null,
      result: null,
      detail: null,
      at: '2026-10-15T10:00:00.000Z',
    });
    const second = repo.addEvent({
      personId: null,
      toolId: null,
      type: 'locked',
      url: null,
      result: null,
      detail: null,
      at: '2026-10-15T10:01:00.000Z',
    });

    expect(first.clientId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(second.clientId).not.toBe(first.clientId);
    expect(first.sentAt).toBeNull();
    // The id is the row's, not the answer's: a read returns the same one.
    expect(repo.listEvents({}).map((e) => e.clientId)).toEqual([second.clientId, first.clientId]);
    expect(repo.eventSyncCounts()).toEqual({ sent: 0, pending: 2 });
  });

  test('unsentEvents answers oldest first, at most the limit, and never a sent one', () => {
    const repo = newRepo();
    seed(repo, 5);
    const all = repo.unsentEvents(10);
    expect(all.map((e) => e.id)).toEqual([1, 2, 3, 4, 5]);
    expect(repo.unsentEvents(2).map((e) => e.id)).toEqual([1, 2]);

    repo.markEventsSent([all[1]!.clientId, all[3]!.clientId], '2026-10-15T12:00:00.000Z');
    expect(repo.unsentEvents(10).map((e) => e.id)).toEqual([1, 3, 5]);
    expect(repo.eventSyncCounts()).toEqual({ sent: 2, pending: 3 });
  });

  test('a row recorded before the push existed gets a client id when it is first offered', () => {
    const db = memorySqlite();
    const repo = createRepo(db);
    repo.migrate();
    // What a database of the previous block holds: an event with no client id and no sent time.
    db.run(
      `INSERT INTO event (at, person_id, tool_id, type, url, result, detail) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['2026-10-15T10:00:00.000Z', 'p1', 'alpha', 'unlocked', null, null, null],
    );
    expect(repo.listEvents({})[0]?.clientId).toBeUndefined();

    const first = repo.unsentEvents(10);
    expect(first).toHaveLength(1);
    expect(first[0]?.clientId).toMatch(/^[0-9a-f]{8}-/);
    // The backfill is stable: the same row answers the same id, so a retry cannot duplicate it.
    expect(repo.unsentEvents(10)[0]?.clientId).toBe(first[0]?.clientId);
    expect(repo.listEvents({})[0]?.clientId).toBe(first[0]?.clientId);
    expect(repo.eventSyncCounts()).toEqual({ sent: 0, pending: 1 });
  });

  test('markEventsSent marks the given ids only, keeps the first receipt and ignores the rest', () => {
    const repo = newRepo();
    seed(repo, 3);
    const pending = repo.unsentEvents(10);
    const ids = pending.map((e) => e.clientId);

    repo.markEventsSent([ids[0]!, 'not-an-id'], '2026-10-15T12:00:00.000Z');
    expect(repo.eventSyncCounts()).toEqual({ sent: 1, pending: 2 });
    // A second ack of the same id — the host answers every id it holds — keeps the first time.
    repo.markEventsSent(ids, '2026-10-15T13:00:00.000Z');
    const marked = repo.listEvents({}).filter((e) => e.sentAt !== null);
    expect(marked).toHaveLength(3);
    expect(marked.map((e) => e.sentAt)).toEqual([
      '2026-10-15T13:00:00.000Z',
      '2026-10-15T13:00:00.000Z',
      '2026-10-15T12:00:00.000Z',
    ]);
    expect(repo.eventSyncCounts()).toEqual({ sent: 3, pending: 0 });
    expect(repo.unsentEvents(10)).toEqual([]);
    // Nothing to mark is not a query.
    repo.markEventsSent([], '2026-10-15T14:00:00.000Z');
    expect(repo.eventSyncCounts()).toEqual({ sent: 3, pending: 0 });
  });

  test('with no events the counters are zero and nothing is unsent', () => {
    const repo = newRepo();
    expect(repo.eventSyncCounts()).toEqual({ sent: 0, pending: 0 });
    expect(repo.unsentEvents(500)).toEqual([]);
  });
});

describe('meta', () => {
  test('get/set with overwrite', () => {
    const repo = newRepo();
    expect(repo.meta('seed_version')).toBeNull();

    repo.setMeta('seed_version', '3');
    expect(repo.meta('seed_version')).toBe('3');

    repo.setMeta('seed_version', '4');
    expect(repo.meta('seed_version')).toBe('4');
  });
});

/** The columns SP05 §2, block 2 and RF-65 add to tables that already existed in v2. */
const LATER_COLUMNS: ReadonlyArray<readonly [table: string, column: string]> = [
  ['vault_item', 'origin'],
  ['vault_item', 'credential_id'],
  ['vault_item', 'scope'],
  // RF-65 (0.5.5): the credential of a tool the login cascade fills with.
  ['vault_item', 'is_default'],
  ['person', 'password_check'],
  ['person', 'password_algorithm'],
  ['tool', 'scope'],
  ['tool', 'owner_id'],
  // RF-62 (0.5.0): the display category of a local org tool.
  ['tool', 'category'],
  ['event', 'client_id'],
  ['event', 'sent_at'],
];

/**
 * RF-65's two partial indexes are as new as `is_default` and the dropped constraint: a database of an
 * earlier build has neither, and SQLite refuses to drop a column an index mentions, so a test that
 * takes the table back to that shape drops them first.
 */
function dropVaultIndexes(db: SqlDb): void {
  db.exec('DROP INDEX IF EXISTS vault_item_credential');
  db.exec('DROP INDEX IF EXISTS vault_item_default');
}

describe('schema version 8 — the sealed `secret` table (RF-63) over the connected and shared schema (SP05 §2, SP06)', () => {
  test('a fresh database is v8, with the two host tables, `peer_keys`, `secret` and every column of SP05 §2 and K4', () => {
    const db = memorySqlite();
    createRepo(db).migrate();

    expect(SCHEMA_VERSION).toBe(8);
    expect(userVersion(db)).toBe(8);
    expect(tableNames(db)).toEqual([
      'event',
      'host',
      'host_outbox',
      'invite',
      'meta',
      'peer_keys',
      'person',
      'person_role',
      'role',
      'secret',
      'tool',
      'tool_grant',
      'tool_view',
      'vault_item',
    ]);
    for (const [table, column] of LATER_COLUMNS) {
      const columns = db.all<{ name: string }>(`PRAGMA table_info(${table})`).map((row) => row.name);
      expect(columns).toContain(column);
    }
  });

  test('a v2 database keeps its people, tools and vault rows and gains the rest', () => {
    // What a v2 build left behind: the schema it wrote, its rows, no host tables, `user_version = 2`.
    const db = memorySqlite();
    const v2 = createRepo(db);
    v2.migrate();
    v2.ensureAdminRole();
    v2.saveEntry(entry('alpha', { url: 'https://alpha.example.test/app' }));
    const person = v2.createPerson({ email: 'ana@example.test', name: 'Ana', password: PASSWORD, roles: ['admin'] });
    v2.saveVaultItem({
      personId: person.id,
      toolId: 'alpha',
      label: 'Alpha',
      username: 'ana',
      keychainKey: `nod.cred.${person.id}.alpha`,
      origin: 'https://alpha.example.test',
    });
    v2.addEvent({
      personId: person.id,
      toolId: 'alpha',
      type: 'tool_opened',
      url: 'https://alpha.example.test/app',
      result: null,
      detail: null,
      at: '2026-10-15T10:00:00.000Z',
    });
    v2.setMeta('seed_version', '2');

    // Back to the shape of that build: SP05 §2's columns gone, the host tables never created.
    dropVaultIndexes(db);
    for (const [table, column] of LATER_COLUMNS) db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    db.exec('DROP TABLE host');
    db.exec('DROP TABLE host_outbox');
    db.exec('PRAGMA user_version = 2');
    expect(tableNames(db)).not.toContain('host');

    const repo = createRepo(db);
    repo.migrate();

    // Stamped, completed, and every row of local mode still there, value for value.
    expect(userVersion(db)).toBe(8);
    expect(tableNames(db)).toContain('host');
    expect(tableNames(db)).toContain('host_outbox');
    expect(repo.listPeople().map((p) => p.email)).toEqual(['ana@example.test']);
    expect(repo.listPeople()[0].roles).toEqual(['admin']);
    expect(repo.listEntries().map((e) => e.id)).toEqual(['alpha']);
    expect(repo.listEntries()[0].url).toBe('https://alpha.example.test/app');
    expect(repo.listVault(person.id)).toHaveLength(1);
    expect(repo.vaultOrigin(person.id, 'alpha')).toBe('https://alpha.example.test');
    expect(repo.listEvents({}).map((e) => e.type)).toEqual(['tool_opened']);
    expect(repo.meta('seed_version')).toBe('2');
    expect(repo.hostRecord()).toBeNull();

    // The new defaults took on the rows that were already there, and nothing invented an owner.
    expect(db.all('SELECT scope, owner_id FROM tool')).toEqual([{ scope: 'org', owner_id: null }]);
    expect(db.all('SELECT password_algorithm, password_check FROM person')).toEqual([
      { password_algorithm: 'PBKDF2-SHA256', password_check: null },
    ]);

    // A migrated database and a fresh one answer the same schema, table for table, column for column.
    const fresh = memorySqlite();
    createRepo(fresh).migrate();
    expect(tableNames(db)).toEqual(tableNames(fresh));
    for (const table of tableNames(db)) expect(shapeOf(db, table)).toEqual(shapeOf(fresh, table));

    // And migrate stays idempotent on the migrated database.
    repo.migrate();
    expect(userVersion(db)).toBe(8);
    expect(repo.listEntries().map((e) => e.id)).toEqual(['alpha']);
  });

  test('a v2 database with no version at all is completed and stamped the same way', () => {
    const db = memorySqlite();
    createRepo(db).migrate();
    db.exec('PRAGMA user_version = 0');

    createRepo(db).migrate();

    expect(userVersion(db)).toBe(8);
    expect(tableNames(db)).toContain('host_outbox');
  });

  test('a v3 database gains `peer_keys` and is stamped 8, keeping its rows (SP06 §2, K1–K2)', () => {
    const db = memorySqlite();
    const v3 = createRepo(db);
    v3.migrate();
    v3.saveEntry(entry('alpha', { url: 'https://alpha.example.test/app' }));
    v3.setMeta('seed_version', '2');
    // What a v3 build left behind: this schema without `peer_keys`, `user_version = 3`.
    db.exec('DROP TABLE peer_keys');
    db.exec('PRAGMA user_version = 3');

    const repo = createRepo(db);
    repo.migrate();

    expect(userVersion(db)).toBe(8);
    expect(tableNames(db)).toContain('peer_keys');
    expect(repo.listEntries().map((e) => e.id)).toEqual(['alpha']);
    expect(repo.meta('seed_version')).toBe('2');
    expect(repo.peerKey('p-anyone')).toBeNull();
  });

  test('a v4 database gains the sharing columns of K4 and keeps its items, unshared and `role`', () => {
    const db = memorySqlite();
    const v4 = createRepo(db);
    v4.migrate();
    v4.saveEntry(entry('alpha', { url: 'https://alpha.example.test/app' }));
    const person = v4.createPerson({
      email: 'ana@example.test',
      name: 'Ana',
      password: PASSWORD,
      roles: [],
    });
    const saved = v4.saveVaultItem({
      personId: person.id,
      toolId: 'alpha',
      label: 'Alpha',
      username: 'ana',
      keychainKey: `nod.cred.${person.id}.alpha`,
      origin: 'https://alpha.example.test',
    });

    // What the K1–K2 build left behind: the two block 2 columns absent, `user_version = 4`.
    dropVaultIndexes(db);
    db.exec('ALTER TABLE vault_item DROP COLUMN credential_id');
    db.exec('ALTER TABLE vault_item DROP COLUMN scope');
    db.exec('PRAGMA user_version = 4');

    const repo = createRepo(db);
    repo.migrate();

    expect(userVersion(db)).toBe(8);
    const item = repo.vaultItemById(person.id, saved.id);
    expect(item).not.toBeNull();
    // SP06 §3–§5: an item that never travelled has no credential group and the default scope.
    expect(item?.credentialId).toBeNull();
    expect(item?.scope).toBe('role');
    // RF-65: it is the only credential of its tool, so it is the one the fill reads.
    expect(item?.isDefault).toBe(true);
    expect(repo.vaultOrigin(person.id, 'alpha')).toBe('https://alpha.example.test');

    // A later write of the sharing fields is what turns it into a shared copy.
    repo.setVaultCredential(person.id, saved.id, 'c-1');
    repo.setVaultScope(person.id, saved.id, 'org');
    expect(repo.vaultItemById(person.id, saved.id)).toMatchObject({
      credentialId: 'c-1',
      scope: 'org',
      username: 'ana',
    });
  });

  test('a v5 database gains `tool.category` and reads its tools as uncategorized (RF-62)', () => {
    const db = memorySqlite();
    const v5 = createRepo(db);
    v5.migrate();
    v5.ensureAdminRole();
    v5.saveRole({ id: 'team', name: 'Team', admin: false });
    v5.saveEntry(entry('alpha', { url: 'https://alpha.example.test/app', roles: ['team'] }));
    v5.saveEntry(
      entry('p-mine00000', {
        url: 'https://mine.example.test/app',
        scope: 'personal',
        ownerId: 'p-ana',
      }),
    );

    // What a v5 build left behind: the column absent (and never dropped by a write), `user_version = 5`.
    db.exec('ALTER TABLE tool DROP COLUMN category');
    db.exec('PRAGMA user_version = 5');

    const repo = createRepo(db);
    repo.migrate();

    expect(userVersion(db)).toBe(8);
    // Every row written before the column is uncategorized, and both scopes survive.
    expect(repo.listEntries().map((e) => [e.id, e.category])).toEqual([
      ['alpha', null],
      ['p-mine00000', null],
    ]);
    // And the column is live: an org row takes a name, a personal one stays `null` whatever it is sent.
    repo.saveEntry(entry('alpha', { url: 'https://alpha.example.test/app', roles: ['team'], category: 'Support' }));
    repo.saveEntry(
      entry('p-mine00000', {
        url: 'https://mine.example.test/app',
        scope: 'personal',
        ownerId: 'p-ana',
        category: 'Support',
      }),
    );
    expect(repo.entry('alpha')?.category).toBe('Support');
    expect(repo.entry('p-mine00000')?.category).toBeNull();
  });

  test('a v6 database gains the `secret` table and keeps its rows (RF-63)', () => {
    const db = memorySqlite();
    const v6 = createRepo(db);
    v6.migrate();
    v6.saveEntry(entry('alpha', { url: 'https://alpha.example.test/app' }));
    // What a v6 build left behind: this schema without `secret`, `user_version = 6`.
    db.exec('DROP TABLE secret');
    db.exec('PRAGMA user_version = 6');

    const repo = createRepo(db);
    repo.migrate();

    expect(userVersion(db)).toBe(8);
    expect(repo.listEntries().map((e) => e.id)).toEqual(['alpha']);
    expect(repo.secret('nod.cred.p-ana.alpha')).toBeNull();
    repo.setSecret('nod.cred.p-ana.alpha', 'bv1.first');
    repo.setSecret('nod.cred.p-ana.alpha', 'bv1.second');
    expect(repo.secret('nod.cred.p-ana.alpha')).toBe('bv1.second');
    repo.deleteSecret('nod.cred.p-ana.alpha');
    expect(repo.secret('nod.cred.p-ana.alpha')).toBeNull();
  });

  test('`saveEntry` writes and clears the category of an org row (RF-62)', () => {
    const repo = newRepo();
    repo.saveEntry(entry('alpha', { url: 'https://alpha.example.test/app', category: 'Support' }));
    expect(repo.entry('alpha')?.category).toBe('Support');

    // An entry that carries no `category` at all keeps what the row has, like the scope and the icon.
    repo.saveEntry(entry('alpha', { url: 'https://alpha.example.test/app', title: 'Alpha' }));
    expect(repo.entry('alpha')?.category).toBe('Support');
    // `null` is a value, not an absence: it is how the admin takes the tool out of its category.
    repo.saveEntry(entry('alpha', { url: 'https://alpha.example.test/app', category: null }));
    expect(repo.entry('alpha')?.category).toBeNull();
  });
});

/**
 * SP05 §2: `vault_item.tool_id` stops pointing at `tool (id)`, because a credential may belong to a
 * tool that exists only on the host — a connected entry has no local `tool` row, and the insert used
 * to fail with `FOREIGN KEY constraint failed`. 0.5.5 (RF-65) rebuilds the same table once more:
 * `UNIQUE (person_id, tool_id)` goes, because a person holds several credentials of one tool from
 * then on, and `is_default` arrives with the removal.
 */
describe('the `vault_item` rebuilds: the tool foreign key (SP05 §2) and the one-per-tool constraint (RF-65)', () => {
  /** The vault_item of the builds before this one: the same columns, the FK to `tool` in place. */
  function writeLegacyVaultItemTable(db: SqlDb): void {
    db.exec('ALTER TABLE vault_item RENAME TO vault_item_legacy');
    db.exec(`
CREATE TABLE vault_item (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person (id) ON DELETE CASCADE,
  tool_id TEXT NOT NULL REFERENCES tool (id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  username TEXT NOT NULL,
  keychain_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  origin TEXT,
  UNIQUE (person_id, tool_id)
);`);
    db.exec(
      'INSERT INTO vault_item (id, person_id, tool_id, label, username, keychain_key, created_at, updated_at, origin) ' +
        'SELECT id, person_id, tool_id, label, username, keychain_key, created_at, updated_at, origin FROM vault_item_legacy',
    );
    db.exec('DROP TABLE vault_item_legacy');
  }

  /**
   * The vault_item of 0.5.3 (schema version `7`): SP05 §2's table, without the FK to `tool` and
   * without `is_default`, and still one credential per tool by `UNIQUE (person_id, tool_id)`.
   */
  function writeV53VaultItemTable(db: SqlDb): void {
    db.exec('ALTER TABLE vault_item RENAME TO vault_item_v53');
    db.exec(`
CREATE TABLE vault_item (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person (id) ON DELETE CASCADE,
  tool_id TEXT NOT NULL,
  label TEXT NOT NULL,
  username TEXT NOT NULL,
  keychain_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  origin TEXT,
  credential_id TEXT,
  scope TEXT NOT NULL DEFAULT 'role',
  UNIQUE (person_id, tool_id)
);`);
    db.exec(
      'INSERT INTO vault_item (id, person_id, tool_id, label, username, keychain_key, created_at, updated_at, origin, credential_id, scope) ' +
        'SELECT id, person_id, tool_id, label, username, keychain_key, created_at, updated_at, origin, credential_id, scope FROM vault_item_v53',
    );
    db.exec('DROP TABLE vault_item_v53');
  }

  /** A database of an earlier build: its people, its tool, its credential, and the FK in place. */
  function legacyDatabase(version: number): { db: SqlDb; personId: string } {
    const db = memorySqlite();
    const before = createRepo(db);
    before.migrate();
    before.saveEntry(entry('alpha', { url: 'https://alpha.example.test/app' }));
    const person = before.createPerson({
      email: 'ana@example.test',
      name: 'Ana',
      password: PASSWORD,
      roles: [],
    });
    before.saveVaultItem({
      personId: person.id,
      toolId: 'alpha',
      label: 'Alpha',
      username: 'ana',
      keychainKey: `nod.cred.${person.id}.alpha`,
      origin: 'https://alpha.example.test',
    });
    writeLegacyVaultItemTable(db);
    db.exec(`PRAGMA user_version = ${version}`);
    return { db, personId: person.id };
  }

  /**
   * One credential row, written by hand, so `saveVaultItem` is not what is being measured. It is the
   * only credential of its tool, so it carries the default of that tool (`is_default`, RF-65) — the
   * rule the repository would have applied, and what the fill reads (`vaultOrigin`).
   */
  function insertVaultItem(db: SqlDb, personId: string, toolId: string): void {
    db.run(
      `INSERT INTO vault_item (id, person_id, tool_id, label, username, keychain_key, created_at, updated_at, origin, is_default)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        crypto.randomUUID(),
        personId,
        toolId,
        toolId,
        'ana',
        `nod.cred.${personId}.${toolId}`,
        '2026-10-15T10:00:00.000Z',
        '2026-10-15T10:00:00.000Z',
        `https://${toolId}.example.test`,
      ],
    );
  }

  /**
   * The same row for a table of a build before this one: `writeLegacyVaultItemTable` and
   * `writeV53VaultItemTable` leave a `vault_item` without `is_default`, and an insert of this build
   * would be refused by the column alone instead of by the constraint under test.
   */
  function insertVaultItemOfAnOlderBuild(db: SqlDb, personId: string, toolId: string): void {
    db.run(
      `INSERT INTO vault_item (id, person_id, tool_id, label, username, keychain_key, created_at, updated_at, origin)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        personId,
        toolId,
        toolId,
        'ana',
        `nod.cred.${personId}.${toolId}`,
        '2026-10-15T10:00:00.000Z',
        '2026-10-15T10:00:00.000Z',
        `https://${toolId}.example.test`,
      ],
    );
  }

  test('a fresh database has the FK to person only, and a credential needs no tool row', () => {
    const db = memorySqlite();
    const repo = createRepo(db);
    repo.migrate();

    expect(foreignKeysOf(db, 'vault_item')).toEqual([
      { table: 'person', from: 'person_id', to: 'id' },
    ]);

    const person = repo.createPerson({
      email: 'ana@example.test',
      name: 'Ana',
      password: PASSWORD,
      roles: [],
    });
    // No `tool` row for this entry: that is a tool of the guild that only the host knows (SP05 §2).
    insertVaultItem(db, person.id, 'host-only');
    expect(repo.vaultItemsOfTool(person.id, 'host-only')[0]?.label).toBe('host-only');
    expect(repo.vaultOrigin(person.id, 'host-only')).toBe('https://host-only.example.test');

    // The constraint that stayed is still enforced.
    expect(() => insertVaultItem(db, 'no-such-person', 'host-only')).toThrow(/FOREIGN KEY/);
  });

  test('a database of an earlier build is rebuilt: every row kept, the FK to tool dropped', () => {
    for (const version of [2, 3, 4]) {
      const { db, personId } = legacyDatabase(version);
      // What the build before this one did with a host-only entry: the insert is refused.
      expect(() => insertVaultItemOfAnOlderBuild(db, personId, 'host-only')).toThrow(/FOREIGN KEY/);
      expect(foreignKeysOf(db, 'vault_item')).toEqual([
        { table: 'person', from: 'person_id', to: 'id' },
        { table: 'tool', from: 'tool_id', to: 'id' },
      ]);

      const repo = createRepo(db);
      repo.migrate();

      // The row that was there is the same row, and the shape is a fresh database's.
      expect(repo.vaultOrigin(personId, 'alpha')).toBe('https://alpha.example.test');
      expect(repo.listVault(personId).map((item) => item.label)).toEqual(['Alpha']);
      expect(foreignKeysOf(db, 'vault_item')).toEqual([
        { table: 'person', from: 'person_id', to: 'id' },
      ]);
      expect(userVersion(db)).toBe(SCHEMA_VERSION);

      // The pragma is back on, and the entry the guild grants saves without a local row.
      expect(foreignKeysOn(db)).toBe(true);
      insertVaultItem(db, personId, 'host-only');
      expect(repo.listVault(personId).map((item) => item.toolId).sort()).toEqual([
        'alpha',
        'host-only',
      ]);
      expect(() => insertVaultItem(db, 'no-such-person', 'host-only')).toThrow(/FOREIGN KEY/);

      // A second migrate neither throws nor rebuilds anything away.
      repo.migrate();
      expect(repo.vaultOrigin(personId, 'alpha')).toBe('https://alpha.example.test');
      expect(userVersion(db)).toBe(SCHEMA_VERSION);
    }
  });

  test('a 0.5.3 database keeps its rows, their keys and their secrets, and admits a second credential', () => {
    const db = memorySqlite();
    const before = createRepo(db);
    before.migrate();
    before.saveEntry(entry('alpha', { url: 'https://alpha.example.test/app' }));
    const person = before.createPerson({
      email: 'ana@example.test',
      name: 'Ana',
      password: PASSWORD,
      roles: [],
    });
    const kept = before.saveVaultItem({
      personId: person.id,
      toolId: 'alpha',
      label: 'Alpha',
      username: 'ana',
      keychainKey: `nod.cred.${person.id}.alpha`,
      origin: 'https://alpha.example.test',
    });
    // What 0.5.3 left behind: the FK to `tool` already gone, `UNIQUE (person_id, tool_id)` still
    // there, no `is_default`, `user_version = 7`.
    writeV53VaultItemTable(db);
    db.exec('PRAGMA user_version = 7');
    // That build refused a second credential of one tool.
    expect(() => insertVaultItemOfAnOlderBuild(db, person.id, 'alpha')).toThrow(/UNIQUE/);

    const repo = createRepo(db);
    repo.migrate();

    expect(userVersion(db)).toBe(SCHEMA_VERSION);
    // The row is the same row — id, keychain key (the AAD of its sealed value, so the credential
    // still opens) and origin — and it is the default of its tool, which is what it was.
    const rows = repo.listVault(person.id);
    expect(rows.map((item) => [item.id, item.label, item.keychainKey, item.isDefault])).toEqual([
      [kept.id, 'Alpha', `nod.cred.${person.id}.alpha`, true],
    ]);
    expect(repo.defaultVaultItem(person.id, 'alpha')?.id).toBe(kept.id);
    expect(repo.vaultOrigin(person.id, 'alpha')).toBe('https://alpha.example.test');

    // The two indexes of the new shape were created after the rebuild (a `DROP TABLE` takes the
    // indexes of the table with it, so one created before it would not have survived).
    const indexes = db.all<{ name: string }>('PRAGMA index_list(vault_item)').map((row) => row.name);
    expect(indexes).toContain('vault_item_credential');
    expect(indexes).toContain('vault_item_default');

    // The constraint is gone: a second credential of the same tool goes in beside the first, and it
    // is not the default (RF-65).
    const second = repo.saveVaultItem({
      personId: person.id,
      toolId: 'alpha',
      label: 'Ops',
      username: 'ops',
      keychainKey: `nod.cred.${person.id}.alpha.ops`,
      origin: 'https://alpha.example.test',
    });
    expect(second.isDefault).toBe(false);
    expect(repo.vaultItemsOfTool(person.id, 'alpha')).toHaveLength(2);
    expect(repo.defaultVaultItem(person.id, 'alpha')?.id).toBe(kept.id);

    // A second migrate neither throws nor rebuilds anything away.
    repo.migrate();
    expect(repo.listVault(person.id)).toHaveLength(2);
    expect(repo.defaultVaultItem(person.id, 'alpha')?.id).toBe(kept.id);
  });

  test('removing a local tool still takes its vault rows with it, with no FK to do it', () => {
    const repo = newRepo();
    repo.saveEntry(entry('alpha'));
    const person = repo.createPerson({
      email: 'ana@example.test',
      name: 'Ana',
      password: PASSWORD,
      roles: [],
    });
    repo.saveVaultItem({
      personId: person.id,
      toolId: 'alpha',
      label: 'Alpha',
      username: 'ana',
      keychainKey: `nod.cred.${person.id}.alpha`,
      origin: 'https://alpha.example.test',
    });

    repo.removeEntry('alpha');

    expect(repo.entry('alpha')).toBeNull();
    expect(repo.listVault(person.id)).toEqual([]);
  });
});

describe('host and outbox (SP05 §2)', () => {
  const PIN = {
    address: 'https://nod.example.test',
    guild: 'Example Guild',
    kid: 'kid-a',
    publicKey: 'cHVibGljLWtleQ',
    personId: 'uuid-person-1',
    salt: 'c2FsdA',
    addedAt: '2026-10-16T10:00:00.000Z',
  };

  test('without a host there is no row and no pending write', () => {
    const repo = newRepo();
    expect(repo.hostRecord()).toBeNull();
    expect(repo.listOutbox()).toEqual([]);
  });

  test('saveHost writes the single row of a guild and replaces it whole', () => {
    const repo = newRepo();
    expect(repo.saveHost(PIN)).toEqual({ ...PIN, snapshot: null, version: null, issuedAt: null, lastSyncAt: null, lastError: null });
    expect(repo.hostRecord()).toEqual(repo.saveHost(PIN));

    repo.saveHostSnapshot({ snapshot: '{"api":1}', version: 'v1', issuedAt: '2026-10-16T10:00:00.000Z', syncedAt: '2026-10-16T10:00:01.000Z' });
    repo.saveHostError('could not reach the host');

    const replaced = repo.saveHost({ ...PIN, guild: 'Another Guild', addedAt: '2026-10-16T12:00:00.000Z' });
    expect(replaced.guild).toBe('Another Guild');
    // What belonged to the host that is gone went with it: no snapshot, no error, one row.
    expect(replaced.snapshot).toBeNull();
    expect(replaced.lastError).toBeNull();
    expect(replaced.lastSyncAt).toBeNull();
  });

  test('the verified snapshot, its version, the sync time and the last error', () => {
    const repo = newRepo();
    repo.saveHost(PIN);
    repo.saveHostError('could not reach the host');
    expect(repo.hostRecord()?.lastError).toBe('could not reach the host');

    const body = '{"api":1,"version":"v1"}';
    repo.saveHostSnapshot({ snapshot: body, version: 'v1', issuedAt: '2026-10-16T10:00:00.000Z', syncedAt: '2026-10-16T10:00:01.000Z' });

    const record = repo.hostRecord();
    expect(record?.snapshot).toBe(body); // verbatim, byte for byte (SP04 §2)
    expect(record?.version).toBe('v1');
    expect(record?.issuedAt).toBe('2026-10-16T10:00:00.000Z');
    expect(record?.lastSyncAt).toBe('2026-10-16T10:00:01.000Z');
    expect(record?.lastError).toBeNull(); // a good sync clears the failure before it

    repo.saveHostError(null);
    expect(repo.hostRecord()?.lastError).toBeNull();
  });

  test('a snapshot for a host that does not exist is a caller bug, not an empty cache', () => {
    const repo = newRepo();
    expect(() =>
      repo.saveHostSnapshot({ snapshot: '{}', version: 'v1', issuedAt: '2026-10-16T10:00:00.000Z', syncedAt: '2026-10-16T10:00:01.000Z' }),
    ).toThrow('host not found');
    expect(() => repo.saveHostError('boom')).toThrow('host not found');
  });

  test('clearHost forgets the host and everything pending for it', () => {
    const repo = newRepo();
    repo.saveHost(PIN);
    repo.enqueueOutbox({ method: 'PUT', path: '/v1/personal/tools/p-a', body: '{"title":"A"}', createdAt: '2026-10-16T10:00:00.000Z' });

    repo.clearHost();

    expect(repo.hostRecord()).toBeNull();
    expect(repo.listOutbox()).toEqual([]);
  });

  test('saveHostSalt moves the cached salt and nothing else (SP02 §6–§7)', () => {
    const repo = newRepo();
    repo.saveHost(PIN);
    repo.saveHostSnapshot({
      snapshot: '{"api":1}',
      version: 'v1',
      issuedAt: '2026-10-16T10:00:00.000Z',
      syncedAt: '2026-10-16T10:00:01.000Z',
    });

    repo.saveHostSalt('AAECAwQFBgcICQoLDA0ODw');

    const record = repo.hostRecord();
    expect(record?.salt).toBe('AAECAwQFBgcICQoLDA0ODw');
    // The cached catalog and the rest of the pin are what they were: a change of password is not a
    // reason to lose the org tools (SP04 §3).
    expect(record).toEqual({ ...PIN, salt: 'AAECAwQFBgcICQoLDA0ODw', snapshot: '{"api":1}', version: 'v1', issuedAt: '2026-10-16T10:00:00.000Z', lastSyncAt: '2026-10-16T10:00:01.000Z', lastError: null });

    // Without a host there is no cache to keep, and no error either.
    repo.clearHost();
    expect(() => repo.saveHostSalt('AAECAwQFBgcICQoLDA0ODw')).not.toThrow();
  });

  test('the outbox keeps its writes in id order and its attempts per write', () => {
    const repo = newRepo();
    const first = repo.enqueueOutbox({
      method: 'PUT',
      path: '/v1/personal/tools/p-a',
      body: '{"title":"A"}',
      createdAt: '2026-10-16T10:00:00.000Z',
    });
    const second = repo.enqueueOutbox({
      method: 'DELETE',
      path: '/v1/personal/views/p-b',
      body: '{"updatedAt":"2026-10-16T10:00:01.000Z"}',
      createdAt: '2026-10-16T10:00:01.000Z',
    });

    expect(second.id).toBeGreaterThan(first.id);
    expect(first).toEqual({
      id: first.id,
      method: 'PUT',
      path: '/v1/personal/tools/p-a',
      body: '{"title":"A"}',
      createdAt: '2026-10-16T10:00:00.000Z',
      attempts: 0,
      lastError: null,
    });
    expect(repo.listOutbox().map((row) => row.id)).toEqual([first.id, second.id]);

    repo.markOutboxAttempt(first.id, 'the host failed to answer');
    expect(repo.listOutbox()[0].attempts).toBe(1);
    expect(repo.listOutbox()[0].lastError).toBe('the host failed to answer');
    repo.markOutboxAttempt(first.id, null);
    expect(repo.listOutbox()[0]).toMatchObject({ attempts: 2, lastError: null });

    // The replay of SP04 §4: a `2xx` (or a `409`, or another `4xx`) drops the row.
    repo.deleteOutbox(first.id);
    expect(repo.listOutbox().map((row) => row.id)).toEqual([second.id]);
    // An id that is not there is a no-op: the loop may race with its own delete.
    repo.markOutboxAttempt(first.id, 'gone');
    repo.deleteOutbox(first.id);
    expect(repo.listOutbox().map((row) => row.id)).toEqual([second.id]);
  });
});

describe('local verifier: v1 and V2 (SP02 §6)', () => {
  /** 16 bytes of base64url: the form the host salt and a V2 salt have (SP02 §4). */
  const HOST_SALT = 'AAECAwQFBgcICQoLDA0ODw';
  /** A real V2 record — the check is `base64url(SHA-256(localKey))` of 32 zero bytes. */
  const V2: PasswordHashV2 = {
    algorithm: 'BOND-KDF-V1',
    salt: HOST_SALT,
    iterations: 600_000,
    check: 'Zmh6rfhivXdsj8GLjp-OIAiXFIVu4jOzkCpZHQ1fKSU',
  };
  /** Another check, of no particular password: 32 zero bytes encoded. */
  const OTHER_CHECK = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

  test('personAuthByEmail answers the v1 verifier of a local account', () => {
    const repo = newRepo();
    const person = repo.createPerson({ email: 'ana@example.test', name: 'Ana', password: PASSWORD, roles: [] });

    expect(repo.personAuthByEmail(' ANA@Example.Test ')?.person.id).toBe(person.id);
    expect(repo.personAuthByEmail('ana@example.test')?.password).toEqual(PASSWORD);
    expect(repo.personAuthByEmail('nobody@example.test')).toBeNull();
    // Revoked people are invisible to both reads.
    repo.revokePerson(person.id);
    expect(repo.personAuthByEmail('ana@example.test')).toBeNull();
  });

  test('saveConnectedPerson creates the row with the host id, the host salt and no v1 hash', () => {
    const db = memorySqlite();
    const repo = createRepo(db);
    repo.migrate();

    const person = repo.saveConnectedPerson({
      id: 'host-person-1',
      email: ' Ana@Guild.Test ',
      name: 'Ana',
      password: V2,
      roles: [],
    });

    expect(person.id).toBe('host-person-1'); // the host person id, stable across machines (SP05 §2)
    expect(person.email).toBe('ana@guild.test');
    expect(person.admin).toBe(false);
    expect(db.all('SELECT password_hash, password_salt, password_iterations, password_check, password_algorithm FROM person')).toEqual([
      {
        password_hash: '',
        password_salt: HOST_SALT,
        password_iterations: 600_000,
        password_check: V2.check,
        password_algorithm: 'BOND-KDF-V1',
      },
    ]);
    expect(repo.personAuthByEmail('ana@guild.test')?.password).toEqual(V2);
    // The v1 read of a V2 row says there is no PBKDF2 verifier: an empty hash.
    expect(repo.personByEmail('ana@guild.test')?.password).toEqual({
      algorithm: 'PBKDF2-SHA256',
      hash: '',
      salt: HOST_SALT,
      iterations: 600_000,
    });
  });

  test('saveConnectedPerson updates in place, replaces the roles and brings a revoked row back', () => {
    const repo = newRepo();
    repo.saveRole({ id: 'operator', name: 'Operator', admin: false });
    const first = repo.saveConnectedPerson({
      id: 'host-person-1',
      email: 'ana@guild.test',
      name: 'Ana',
      password: V2,
      roles: ['operator'],
    });
    repo.revokePerson(first.id);
    expect(repo.personById(first.id)).toBeNull();

    const next = repo.saveConnectedPerson({
      id: 'host-person-1',
      email: 'ana.renamed@guild.test',
      name: 'Ana Renamed',
      password: { ...V2, check: OTHER_CHECK },
      roles: ['admin'],
    });

    expect(repo.countPeople()).toBe(1); // one person, not two: the host id is the row
    expect(next.createdAt).toBe(first.createdAt);
    expect(next.name).toBe('Ana Renamed');
    expect(next.email).toBe('ana.renamed@guild.test');
    expect(next.roles).toEqual(['admin']);
    expect(next.admin).toBe(true);
    expect(repo.personAuthByEmail('ana.renamed@guild.test')?.password.check).toBe(OTHER_CHECK);
    expect(repo.personAuthByEmail('ana.guild.test')).toBeNull(); // the old email is gone
  });

  test('savePasswordCheck rewrites the row as V2 and empties the v1 hash', () => {
    const db = memorySqlite();
    const repo = createRepo(db);
    repo.migrate();
    const person = repo.createPerson({ email: 'ana@example.test', name: 'Ana', password: PASSWORD, roles: [] });

    repo.savePasswordCheck(person.id, V2);

    expect(repo.personAuthByEmail('ana@example.test')?.password).toEqual(V2);
    expect(db.all('SELECT password_hash, password_check, password_algorithm FROM person')).toEqual([
      { password_hash: '', password_check: V2.check, password_algorithm: 'BOND-KDF-V1' },
    ]);
  });

  test('savePasswordCheck writes nothing for an unknown or a revoked person', () => {
    const repo = newRepo();
    const person = repo.createPerson({ email: 'ana@example.test', name: 'Ana', password: PASSWORD, roles: [] });
    repo.revokePerson(person.id);

    repo.savePasswordCheck(person.id, V2);
    repo.savePasswordCheck('nobody-at-all', V2);

    // The revoked row kept its v1 verifier and no other row was invented.
    expect(repo.personAuthByEmail('ana@example.test')).toBeNull();
    expect(repo.countPeople()).toBe(1);
  });
});

describe('the local account an adoption takes over (F1)', () => {
  test('personByEmailAnyState sees the row every live read hides', () => {
    const repo = newRepo();
    const alive = repo.createPerson({ email: 'ana@example.test', name: 'Ana', password: PASSWORD, roles: [] });
    const gone = repo.createPerson({ email: 'rev@example.test', name: 'Rev', password: PASSWORD, roles: [] });
    repo.revokePerson(gone.id);

    expect(repo.personByEmailAnyState(' ana@EXAMPLE.test ')).toEqual({ person: alive, revoked: false });
    expect(repo.personByEmailAnyState('rev@example.test')?.person.id).toBe(gone.id);
    expect(repo.personByEmailAnyState('rev@example.test')?.revoked).toBe(true);
    expect(repo.personByEmailAnyState('nobody@example.test')).toBeNull();
    // The live read is unchanged: the revoked row stays invisible to it.
    expect(repo.personByEmail('rev@example.test')).toBeNull();
  });

  test('adoptPersonId moves the row, its roles, its vault rows and its events in one go', () => {
    // The foreign keys are on, exactly like the runtime (`backend/sqlite.ts`): the re-key below is
    // the ordering that survives them — the children first and the parent's key last.
    const db = memorySqlite();
    const repo = createRepo(db);
    repo.migrate();
    repo.ensureAdminRole();
    expect(foreignKeysOn(db)).toBe(true);

    const local = repo.createPerson({ email: 'ana@example.test', name: 'Ana', password: PASSWORD, roles: ['admin'] });
    repo.saveRole({ id: 'team', name: 'Team', admin: false });
    repo.setRoles(local.id, ['admin', 'team']);
    repo.saveEntry(entry('alpha'));
    repo.saveEntry(entry('beta'));
    for (const toolId of ['alpha', 'beta']) {
      repo.saveVaultItem({
        personId: local.id,
        toolId,
        label: toolId,
        username: 'ana',
        keychainKey: `nod.cred.${local.id}.${toolId}`,
        origin: `https://${toolId}.example.test`,
      });
    }
    repo.addEvent({ personId: local.id, toolId: 'alpha', type: 'tool_opened', url: null, result: null, detail: null });
    repo.addEvent({ personId: 'somebody-else', toolId: 'alpha', type: 'tool_opened', url: null, result: null, detail: null });

    // RF-65: the new key the caller derives names the item, because a tool holds several credentials.
    const moved = repo.adoptPersonId({
      fromId: local.id,
      toId: 'guild-1',
      keychainKeyOf: (item) => `nod.cred.guild-1.${item.toolId}.${item.id}`,
    });

    // The answer carries the items as they were read: their old key is what the caller has to move
    // in the keychain.
    expect(moved.map((i) => i.keychainKey).sort()).toEqual([
      `nod.cred.${local.id}.alpha`,
      `nod.cred.${local.id}.beta`,
    ]);
    expect(repo.personById(local.id)).toBeNull();
    expect(repo.personById('guild-1')).toMatchObject({
      email: 'ana@example.test',
      name: 'Ana',
      roles: ['admin', 'team'],
      admin: true,
    });
    expect(repo.listVault(local.id)).toEqual([]);
    expect(
      repo
        .listVault('guild-1')
        .map((i) => i.keychainKey)
        .sort(),
    ).toEqual(
      moved
        .map((item) => `nod.cred.guild-1.${item.toolId}.${item.id}`)
        .sort(),
    );
    expect(repo.vaultOrigin('guild-1', 'alpha')).toBe('https://alpha.example.test');
    expect(repo.listEvents({ personId: 'guild-1' }).map((event) => event.type)).toEqual(['tool_opened']);
    // Somebody else's history is not this person's to move.
    expect(repo.listEvents({ personId: 'somebody-else' })).toHaveLength(1);
    expect(repo.countPeople()).toBe(1);
  });

  test('adoptPersonId refuses a target this Nod already holds, and moves nothing', () => {
    const repo = newRepo();
    const local = repo.createPerson({ email: 'ana@example.test', name: 'Ana', password: PASSWORD, roles: ['admin'] });
    const other = repo.createPerson({ email: 'bia@example.test', name: 'Bia', password: PASSWORD, roles: [] });
    repo.saveEntry(entry('alpha'));
    repo.saveVaultItem({
      personId: local.id,
      toolId: 'alpha',
      label: 'alpha',
      username: 'ana',
      keychainKey: `nod.cred.${local.id}.alpha`,
      origin: 'https://alpha.example.test',
    });

    expect(() =>
      repo.adoptPersonId({
        fromId: local.id,
        toId: other.id,
        keychainKeyOf: (item) => `nod.cred.${other.id}.${item.toolId}.${item.id}`,
      }),
    ).toThrow('this Nod already holds an account of that guild person');

    // Both rows as they were: no id moved, no role, no vault row, no event.
    expect(repo.personById(local.id)?.email).toBe('ana@example.test');
    expect(repo.personById(other.id)?.email).toBe('bia@example.test');
    expect(repo.listVault(local.id).map((i) => i.keychainKey)).toEqual([`nod.cred.${local.id}.alpha`]);
    expect(repo.listVault(other.id)).toEqual([]);
  });

  test('saveConnectedIdentity follows the snapshot on the name and the admin flag (F2)', () => {
    const repo = newRepo();
    const person = repo.createPerson({ email: 'ana@example.test', name: 'Ana', password: PASSWORD, roles: [] });
    expect(person.admin).toBe(false);

    expect(repo.saveConnectedIdentity(person.id, { name: 'Ana Silva', admin: true })).toBe(true);
    expect(repo.personById(person.id)).toMatchObject({ name: 'Ana Silva', admin: true, roles: ['admin'] });
    // Nothing would move: the same snapshot again is not a change.
    expect(repo.saveConnectedIdentity(person.id, { name: 'Ana Silva', admin: true })).toBe(false);

    // The flag goes both ways, and the other local roles stay where they are.
    repo.saveRole({ id: 'team', name: 'Team', admin: false });
    repo.setRoles(person.id, ['admin', 'team']);
    expect(repo.saveConnectedIdentity(person.id, { name: 'Ana Silva', admin: false })).toBe(true);
    expect(repo.personById(person.id)).toMatchObject({ admin: false, roles: ['team'] });

    // A blank name is not a name to write: the local row keeps the one it has.
    expect(repo.saveConnectedIdentity(person.id, { name: '  ', admin: false })).toBe(false);
    expect(repo.personById(person.id)?.name).toBe('Ana Silva');

    // A revoked or unknown person is a no-op, not an insert.
    repo.revokePerson(person.id);
    expect(repo.saveConnectedIdentity(person.id, { name: 'Other', admin: true })).toBe(false);
    expect(repo.saveConnectedIdentity('nobody-at-all', { name: 'Other', admin: true })).toBe(false);
    expect(repo.countPeople()).toBe(1);
  });
});
