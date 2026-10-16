// The host's data access against a real migrated database in a temp data dir — no database mock
// (`host/context.md`, SP01 §5). What is proved here: migration 1 holds every block 1 table and
// reports `schema_version = 1`, the rules SP01 §2 keeps out of SQL (grants, owners, favorites, last
// admin), the atomic code redemption with its TTL and wrong tries, idempotent events, owner
// filtering, and that no secret lands in the database.
//
// Run with `bun test host/`.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyMigrations, openDatabase } from './migrations';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  SESSION_TTL_MS,
  createRepo,
  type EntryInput,
  type HostPerson,
  type Repo,
  type ToolInput,
} from './repo';
import type { Role } from '../shared/types';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const NOW = '2026-10-16T12:00:00.000Z';
const ADMIN: Role = { id: 'admin', name: 'Admin', admin: true };
const TEAM: Role = { id: 'team', name: 'Team', admin: false };
const OTHER: Role = { id: 'other', name: 'Other', admin: false };
const DEVICE = { name: 'Ada’s MacBook', os: 'macos', appVersion: '1.0.0' };

const databases: { dir: string; close: () => void }[] = [];

/** A repo on a fresh migrated database of its own, the way the host boots one. */
function newRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'bond-host-repo-'));
  const db = openDatabase(join(dir, 'host.db'));
  applyMigrations(db);
  databases.push({ dir, close: () => db.close() });
  return { db, dir, repo: createRepo(db) };
}

afterEach(() => {
  while (databases.length > 0) {
    const { dir, close } = databases.pop() as { dir: string; close: () => void };
    close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function msAfter(iso: string, ms: number): string {
  return new Date(new Date(iso).getTime() + ms).toISOString();
}

function hoursAfter(iso: string, hours: number): string {
  return msAfter(iso, hours * 3_600_000);
}

function sha256Hex(value: string): string {
  return new Bun.CryptoHasher('sha256').update(value).digest('hex');
}

function tool(id: string, over: Partial<ToolInput> = {}): ToolInput {
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
    ...over,
  };
}

function personal(id: string, over: Partial<EntryInput> = {}): EntryInput {
  return {
    id,
    title: `Mine ${id}`,
    url: 'https://personal.example.test/app',
    icon: null,
    order: 3,
    auth: null,
    active: true,
    ...over,
  };
}

/** An activated person with no role: most rules have nothing to do with the admin flag. */
function activatedMember(repo: Repo, id = 'p1'): HostPerson {
  const person = repo.createPerson({ id, email: `${id}@bond.test`, name: id }, NOW);
  repo.activatePerson(id, { salt: 'c2FsdC1tZW1iZXI', authHash: '$argon2id$member' }, NOW);
  return person;
}

/** An activated person holding the admin role: the state SP01 §2 protects. */
function activatedAdmin(repo: Repo): HostPerson {
  repo.saveRole(ADMIN);
  const person = repo.createPerson(
    { id: 'p-admin', email: 'Admin@Bond.Test', name: 'Ada', roles: ['admin'] },
    NOW,
  );
  repo.activatePerson(person.id, { salt: 'c2FsdC1hZG1pbg', authHash: '$argon2id$admin' }, NOW);
  return person;
}

describe('schema', () => {
  test('migration 1 creates every block 1 table and reports schema_version = 1', () => {
    const { db, repo } = newRepo();

    const tables = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        'meta',
        'people',
        'roles',
        'person_roles',
        'access_codes',
        'sessions',
        'entries',
        'views',
        'grants',
        'favorites',
        'events',
      ]),
    );

    expect(
      db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'events_person_at'",
        )
        .all(),
    ).toHaveLength(1);

    expect(repo.meta('schema_version')).toBe('1');
  });

  test('the schema itself refuses an entry or a view whose scope and owner disagree', () => {
    const { db, repo } = newRepo();
    repo.createPerson({ id: 'p1', email: 'a@bond.test', name: 'Ada' }, NOW);

    const entry = (scope: string, owner: string | null, id: string) =>
      db
        .query(
          `INSERT INTO entries (id, scope, owner_id, title, url, ord, updated_at)
           VALUES (?, ?, ?, 'T', 'https://t.example.test/', 0, ?)`,
        )
        .run(id, scope, owner, NOW);

    // SP01 §5: a personal entry without an owner fails, and so does an org entry with one.
    expect(() => entry('personal', null, 'p-abc1234567')).toThrow();
    expect(() => entry('org', 'p1', 'kanban')).toThrow();
    expect(() => entry('personal', 'p1', 'p-abc1234567')).not.toThrow();
    expect(() => entry('org', null, 'jitsi')).not.toThrow();

    const view = (scope: string, owner: string | null, id: string, entryId = 'p-abc1234567') =>
      db
        .query(
          `INSERT INTO views (id, entry_id, scope, owner_id, label, url, mode, ord, updated_at)
           VALUES (?, ?, ?, ?, 'V', 'https://t.example.test/v', 'window', 0, ?)`,
        )
        .run(id, entryId, scope, owner, NOW);

    expect(() => view('personal', null, 'v-1')).toThrow();
    expect(() => view('org', 'p1', 'v-2')).toThrow();
    expect(() => view('personal', 'p1', 'v-3')).not.toThrow();
    expect(() => view('org', null, 'v-4', 'jitsi')).not.toThrow();

    // SP01 §1: the connection runs with `PRAGMA foreign_keys = ON`.
    expect(() =>
      db.query("INSERT INTO person_roles (person_id, role_id) VALUES ('ghost', 'admin')").run(),
    ).toThrow();
    expect(() =>
      db
        .query(
          `INSERT INTO entries (id, scope, owner_id, title, url, ord, updated_at)
           VALUES ('p-ghostghost', 'personal', 'ghost', 'T', 'https://t.example.test/', 0, ?)`,
        )
        .run(NOW),
    ).toThrow();
  });

  test('only repo.ts and migrations.ts name bun:sqlite, and only the connection loads it', () => {
    const names = readdirSync(HERE).filter((name) => name.endsWith('.ts'));
    const importing = names.filter((name) =>
      /from\s+'bun:sqlite'/.test(readFileSync(join(HERE, name), 'utf8')),
    );
    // `app.ts` and `main.ts` import the `Database` type only; every query lives in `repo.ts`.
    expect(importing.sort()).toEqual(['app.ts', 'main.ts', 'migrations.ts', 'repo.ts']);

    const valueImport = names.filter((name) =>
      /^import(?!\s+type\b)[^\n]*from\s+'bun:sqlite'/m.test(readFileSync(join(HERE, name), 'utf8')),
    );
    expect(valueImport).toEqual(['migrations.ts']);
  });
});

describe('people', () => {
  test('the email is normalized and taken once', () => {
    const { repo } = newRepo();
    const created = repo.createPerson({ id: 'p1', email: '  Ada@Bond.Test ', name: 'Ada' }, NOW);

    expect(created.email).toBe('ada@bond.test');
    expect(created.kind).toBe('member');
    expect(created.createdAt).toBe(NOW);
    expect(created.activatedAt).toBeNull();
    expect(created.disabledAt).toBeNull();
    expect(created.roles).toEqual([]);
    expect(created.admin).toBe(false);
    expect(repo.personByEmail('ADA@bond.test')?.id).toBe('p1');
    expect(repo.personByEmail('nobody@bond.test')).toBeNull();

    expect(() => repo.createPerson({ id: 'p2', email: 'ada@bond.test', name: 'Ada' }, NOW)).toThrow(
      ConflictError,
    );
    expect(repo.listPeople()).toHaveLength(1);
  });

  test('activation stores salt and hash once, and only the auth read returns them', () => {
    const { repo } = newRepo();
    repo.createPerson({ id: 'p1', email: 'a@bond.test', name: 'Ada' }, NOW);
    expect(repo.personAuthByEmail('a@bond.test')).toEqual({
      person: expect.objectContaining({ id: 'p1' }),
      salt: null,
      authHash: null,
    });

    repo.activatePerson('p1', { salt: 'c2FsdA', authHash: '$argon2id$first' }, NOW);
    repo.activatePerson('p1', { salt: 'c2FsdB', authHash: '$argon2id$second' }, hoursAfter(NOW, 1));

    const auth = repo.personAuthByEmail('a@bond.test');
    expect(auth?.salt).toBe('c2FsdB');
    expect(auth?.authHash).toBe('$argon2id$second');
    // The activation stamp is the first one (SP02 §3), and the record never carries them.
    expect(auth?.person.activatedAt).toBe(NOW);
    expect(Object.keys(repo.personById('p1') as HostPerson)).not.toContain('salt');
    expect(Object.keys(repo.personById('p1') as HostPerson)).not.toContain('authHash');
  });

  test('roles are replaced, unknown roles refused, and the admin flag follows the roles', () => {
    const { repo } = newRepo();
    repo.saveRole(ADMIN);
    repo.saveRole(TEAM);
    repo.createPerson({ id: 'p1', email: 'a@bond.test', name: 'Ada', roles: ['team'] }, NOW);

    expect(repo.personById('p1')?.roles).toEqual(['team']);
    expect(repo.personById('p1')?.admin).toBe(false);

    expect(repo.setRoles('p1', ['admin', 'team'])?.roles).toEqual(['admin', 'team']);
    expect(repo.personById('p1')?.admin).toBe(true);
    expect(repo.listPeople().map((person) => person.admin)).toEqual([true]);

    expect(() => repo.setRoles('p1', ['ghost'])).toThrow(NotFoundError);
    expect(() => repo.setRoles('ghost', [])).toThrow(NotFoundError);
    expect(() => repo.renamePerson('ghost', 'Nobody')).toThrow(NotFoundError);
    expect(repo.renamePerson('p1', 'Ada L.')?.name).toBe('Ada L.');

    // A password change keeps the activation and swaps salt and hash (SP02 §7).
    repo.changeAuth('p1', { salt: 'c2FsdC1uZXc', authHash: '$argon2id$new' });
    expect(repo.personAuthByEmail('a@bond.test')?.authHash).toBe('$argon2id$new');
    expect(repo.personAuthByEmail('a@bond.test')?.salt).toBe('c2FsdC1uZXc');
    expect(repo.personById('p1')?.activatedAt).toBeNull();
    expect(() => repo.changeAuth('ghost', { salt: 'x', authHash: 'y' })).toThrow(NotFoundError);
  });
});

describe('access and setup codes', () => {
  test('a code is consumed once, and a setup code is another purpose', () => {
    const { repo } = newRepo();
    repo.createPerson({ id: 'p1', email: 'a@bond.test', name: 'Ada' }, NOW);
    const codeHash = sha256Hex('ABCDEFGH');
    const setupHash = sha256Hex('ABCDEFGHJKLMNPQR');

    const issued = repo.issueCode({ id: 'c1', purpose: 'activate', personId: 'p1', codeHash }, NOW);
    expect(issued.expiresAt).toBe(hoursAfter(NOW, 72));
    expect(issued.attempts).toBe(0);
    expect(issued.usedAt).toBeNull();
    expect(issued.revokedAt).toBeNull();

    const consumed = repo.redeemCode('activate', 'p1', codeHash, NOW);
    expect(consumed?.id).toBe('c1');
    expect(consumed?.usedAt).toBe(NOW);

    // A second use, the same code against the other purpose, and another person: nothing.
    expect(repo.redeemCode('activate', 'p1', codeHash, NOW)).toBeNull();
    repo.issueCode({ id: 'c2', purpose: 'setup', personId: null, codeHash: setupHash }, NOW);
    expect(repo.redeemCode('activate', 'p1', setupHash, NOW)).toBeNull();
    expect(repo.redeemCode('setup', null, setupHash, NOW)?.id).toBe('c2');
    expect(repo.redeemCode('setup', null, setupHash, NOW)).toBeNull();
    expect(repo.redeemCode('activate', 'p2', codeHash, NOW)).toBeNull();
  });

  test('the fifth wrong try kills the code, and so does the expiry', () => {
    const { db, repo } = newRepo();
    repo.createPerson({ id: 'p1', email: 'a@bond.test', name: 'Ada' }, NOW);
    // SP01 §2 makes `code_hash` unique, so every issued code has its own (as its 5 random bytes do).
    const right = sha256Hex('ABCDEFGH');
    const right2 = sha256Hex('JKLMNPQR');
    const right3 = sha256Hex('STVWXYZ0');
    const right4 = sha256Hex('12345678');
    const wrong = sha256Hex('ZZZZZZZZ');
    const attemptsOf = (id: string) =>
      db
        .query<{ attempts: number; usedAt: string | null; revokedAt: string | null }, [string]>(
          `SELECT attempts, used_at AS usedAt, revoked_at AS revokedAt
             FROM access_codes WHERE id = ?`,
        )
        .get(id);

    repo.issueCode({ id: 'c1', purpose: 'activate', personId: 'p1', codeHash: right }, NOW);
    for (let tryNumber = 1; tryNumber <= 4; tryNumber++) {
      expect(repo.redeemCode('activate', 'p1', wrong, NOW)).toBeNull();
    }
    // Four tries in, the right code still works.
    expect(repo.redeemCode('activate', 'p1', right, NOW)?.id).toBe('c1');
    expect(attemptsOf('c1')?.attempts).toBe(4);
    expect(attemptsOf('c1')?.revokedAt).toBeNull();

    // A fresh code: five wrong tries, and then even the right one is dead.
    repo.issueCode({ id: 'c2', purpose: 'activate', personId: 'p1', codeHash: right2 }, NOW);
    for (let tryNumber = 1; tryNumber <= 5; tryNumber++) {
      expect(repo.redeemCode('activate', 'p1', wrong, NOW)).toBeNull();
    }
    expect(repo.redeemCode('activate', 'p1', right2, NOW)).toBeNull();
    expect(attemptsOf('c2')?.attempts).toBe(5);
    expect(attemptsOf('c2')?.revokedAt).toBe(NOW);

    // TTL: an access code lives 72 h, a setup code 24 h.
    repo.issueCode({ id: 'c3', purpose: 'activate', personId: 'p1', codeHash: right3 }, NOW);
    expect(repo.redeemCode('activate', 'p1', right3, hoursAfter(NOW, 71))?.id).toBe('c3');
    repo.issueCode({ id: 'c4', purpose: 'activate', personId: 'p1', codeHash: right4 }, NOW);
    expect(repo.redeemCode('activate', 'p1', right4, hoursAfter(NOW, 73))).toBeNull();
    // An expired code is dead by its own stamp: no attempt is counted and nothing is written.
    expect(attemptsOf('c4')?.attempts).toBe(0);
    expect(attemptsOf('c4')?.usedAt).toBeNull();

    const setup = sha256Hex('ABCDEFGHJKLMNPQR');
    repo.issueCode({ id: 'c5', purpose: 'setup', personId: null, codeHash: setup }, NOW);
    expect(repo.redeemCode('setup', null, setup, hoursAfter(NOW, 25))).toBeNull();
    expect(repo.redeemCode('setup', null, setup, hoursAfter(NOW, 23))?.id).toBe('c5');
  });

  test('issuing a new code revokes the previous unused one', () => {
    const { repo } = newRepo();
    repo.createPerson({ id: 'p1', email: 'a@bond.test', name: 'Ada' }, NOW);
    const first = sha256Hex('AAAA1111');
    const second = sha256Hex('BBBB2222');

    repo.issueCode({ id: 'c1', purpose: 'activate', personId: 'p1', codeHash: first }, NOW);
    repo.issueCode(
      { id: 'c2', purpose: 'activate', personId: 'p1', codeHash: second },
      hoursAfter(NOW, 1),
    );
    expect(repo.redeemCode('activate', 'p1', first, NOW)).toBeNull();
    expect(repo.redeemCode('activate', 'p1', second, NOW)?.id).toBe('c2');

    // The setup code keeps its own slot (`person_id IS NULL`).
    repo.issueCode({ id: 's1', purpose: 'setup', personId: null, codeHash: sha256Hex('CCCC3333') }, NOW);
    repo.issueCode({ id: 's2', purpose: 'setup', personId: null, codeHash: sha256Hex('DDDD4444') }, NOW);
    expect(repo.redeemCode('setup', null, sha256Hex('CCCC3333'), NOW)).toBeNull();
    expect(repo.redeemCode('setup', null, sha256Hex('DDDD4444'), NOW)?.id).toBe('s2');
  });
});

describe('sessions', () => {
  test('a revoked session is not found, and the sliding expiry runs out', () => {
    const { repo } = newRepo();
    activatedMember(repo);
    const tokenHash = sha256Hex('a-token');
    const created = repo.createSession({ id: 's1', personId: 'p1', tokenHash, device: DEVICE }, NOW);

    expect(created.expiresAt).toBe(msAfter(NOW, SESSION_TTL_MS));
    expect(created.device).toEqual(DEVICE);
    expect(repo.sessionByTokenHash(tokenHash, NOW)?.id).toBe('s1');
    expect(repo.sessionByTokenHash(sha256Hex('another-token'), NOW)).toBeNull();

    // Sliding: the touch moves both stamps.
    repo.touchSession('s1', hoursAfter(NOW, 1));
    const touched = repo.sessionByTokenHash(tokenHash, hoursAfter(NOW, 1));
    expect(touched?.lastSeenAt).toBe(hoursAfter(NOW, 1));
    expect(touched?.expiresAt).toBe(msAfter(hoursAfter(NOW, 1), SESSION_TTL_MS));
    expect(repo.sessionByTokenHash(tokenHash, msAfter(touched?.expiresAt as string, 1))).toBeNull();

    // Revoked: not found, while the row stays for the 403/404 of a delete route.
    expect(repo.revokeOwnSession('p1', 's1', NOW)).toBe(true);
    expect(repo.sessionByTokenHash(tokenHash, NOW)).toBeNull();
    expect(repo.sessionById('s1')?.revokedAt).toBe(NOW);
    expect(repo.sessionsOfPerson('p1', NOW)).toEqual([]);
    expect(repo.revokeOwnSession('p1', 's1', NOW)).toBe(false);
  });

  test('sessions belong to their person, and disabling revokes them all', () => {
    const { repo } = newRepo();
    activatedMember(repo, 'p1');
    activatedMember(repo, 'p2');

    repo.createSession({ id: 's1', personId: 'p1', tokenHash: sha256Hex('t1'), device: DEVICE }, NOW);
    repo.createSession(
      { id: 's2', personId: 'p1', tokenHash: sha256Hex('t2'), device: DEVICE },
      hoursAfter(NOW, 1),
    );
    repo.createSession({ id: 's3', personId: 'p2', tokenHash: sha256Hex('t3'), device: DEVICE }, NOW);

    // Most recently seen first, and only that person's.
    expect(repo.sessionsOfPerson('p1', NOW).map((session) => session.id)).toEqual(['s2', 's1']);
    expect(repo.sessionsOfPerson('p2', NOW).map((session) => session.id)).toEqual(['s3']);

    // Another person's session is neither revoked nor listed by this one.
    expect(repo.revokeOwnSession('p2', 's1', NOW)).toBe(false);
    expect(repo.sessionByTokenHash(sha256Hex('t1'), NOW)?.personId).toBe('p1');

    // Disabling revokes every session of that person — and nothing of anyone else's.
    const later = hoursAfter(NOW, 2);
    expect(repo.setDisabled('p1', true, later).disabledAt).toBe(later);
    expect(repo.sessionByTokenHash(sha256Hex('t1'), later)).toBeNull();
    expect(repo.sessionByTokenHash(sha256Hex('t2'), later)).toBeNull();
    expect(repo.sessionByTokenHash(sha256Hex('t3'), later)?.id).toBe('s3');
    expect(repo.revokeSessionsOfPerson('p2', later)).toBe(1);
    expect(repo.revokeSession('s3', later)).toBe(false); // already revoked above
    expect(repo.revokeSession('ghost', later)).toBe(false);
    expect(repo.setDisabled('p1', false, hoursAfter(NOW, 3))?.disabledAt).toBeNull();
    expect(repo.personById('p1')?.disabledAt).toBeNull();
  });

  test('a composed write is one unit of work', () => {
    const { db, repo } = newRepo();
    const codeHash = sha256Hex('SETUP1234');
    repo.issueCode({ id: 'c1', purpose: 'setup', personId: null, codeHash }, NOW);
    const usedAt = () =>
      db
        .query<{ usedAt: string | null }, [string]>(
          'SELECT used_at AS usedAt FROM access_codes WHERE id = ?',
        )
        .get('c1')?.usedAt;

    // What `POST /v1/auth/setup` needs (SP03 §2): redeem the code, create the person and the admin
    // role, open the session — and nothing at all when one step fails.
    expect(() =>
      repo.transaction(() => {
        expect(repo.redeemCode('setup', null, codeHash, NOW)?.id).toBe('c1');
        repo.saveRole(ADMIN);
        repo.createPerson(
          { id: 'p1', email: 'a@bond.test', name: 'Ada', roles: ['admin'] },
          NOW,
        );
        throw new Error('the route changed its mind');
      }),
    ).toThrow('the route changed its mind');
    expect(repo.personByEmail('a@bond.test')).toBeNull();
    expect(repo.listRoles()).toEqual([]);
    // The consumed code came back with the rest of the rollback.
    expect(usedAt()).toBeNull();

    const setup = repo.transaction(() => {
      const code = repo.redeemCode('setup', null, codeHash, NOW);
      repo.saveRole(ADMIN);
      const person = repo.createPerson(
        { id: 'p1', email: 'a@bond.test', name: 'Ada', roles: ['admin'] },
        NOW,
      );
      repo.activatePerson('p1', { salt: 'c2FsdA', authHash: '$argon2id$setup' }, NOW);
      const session = repo.createSession(
        { id: 's1', personId: 'p1', tokenHash: sha256Hex('t1'), device: DEVICE },
        NOW,
      );
      return { code, person, session };
    });
    expect(setup.code?.id).toBe('c1');
    expect(setup.person.email).toBe('a@bond.test');
    expect(setup.session.personId).toBe('p1');
    expect(repo.adminCount()).toBe(1);
    expect(repo.redeemCode('setup', null, codeHash, NOW)).toBeNull();
  });
});

describe('last admin', () => {
  test('nothing that would leave the guild without an admin goes through', () => {
    const { repo } = newRepo();
    const admin = activatedAdmin(repo);
    expect(repo.adminCount()).toBe(1);

    expect(() => repo.setRoles(admin.id, [])).toThrow(ConflictError);
    expect(() => repo.setDisabled(admin.id, true, NOW)).toThrow(ConflictError);
    expect(() => repo.removeRole('admin')).toThrow(ConflictError);
    expect(() => repo.saveRole({ id: 'admin', name: 'Admin', admin: false })).toThrow(ConflictError);

    // Every refusal rolled back: the admin, the role and the activation are as they were.
    expect(repo.adminCount()).toBe(1);
    expect(repo.personById(admin.id)?.roles).toEqual(['admin']);
    expect(repo.personById(admin.id)?.disabledAt).toBeNull();
    expect(repo.personById(admin.id)?.activatedAt).toBe(NOW);
    expect(repo.listRoles()).toEqual([{ id: 'admin', name: 'Admin', admin: true }]);
  });

  test('a second activated admin makes the first one removable', () => {
    const { repo } = newRepo();
    activatedAdmin(repo);
    repo.createPerson({ id: 'p2', email: 'b@bond.test', name: 'Bo', roles: ['admin'] }, NOW);

    // Created but not activated: still one admin, so the guard holds.
    expect(repo.adminCount()).toBe(1);
    expect(() => repo.setRoles('p-admin', [])).toThrow(ConflictError);

    repo.activatePerson('p2', { salt: 'c2FsdA', authHash: '$argon2id$bo' }, NOW);
    expect(repo.adminCount()).toBe(2);
    expect(repo.setRoles('p-admin', [])?.roles).toEqual([]);
    expect(repo.adminCount()).toBe(1);
    expect(() => repo.setDisabled('p2', true, NOW)).toThrow(ConflictError);
  });

  test('an empty host is not guarded: the first admin can be built', () => {
    const { repo } = newRepo();
    repo.saveRole(ADMIN);
    repo.saveRole(TEAM);
    expect(repo.adminCount()).toBe(0);

    repo.removeRole('team');
    repo.createPerson({ id: 'p1', email: 'a@bond.test', name: 'Ada' }, NOW);
    expect(repo.setDisabled('p1', true, NOW).disabledAt).toBe(NOW);

    repo.saveRole(ADMIN);
    repo.setRoles('p1', ['admin']);
    repo.activatePerson('p1', { salt: 'c2FsdA', authHash: '$argon2id$one' }, NOW);
    // Disabled, so not counted; re-enabled, it is the one admin the guard protects.
    expect(repo.adminCount()).toBe(0);
    repo.setDisabled('p1', false, hoursAfter(NOW, 1));
    expect(repo.adminCount()).toBe(1);
    expect(() => repo.removeRole('admin')).toThrow(ConflictError);
  });
});

describe('org tools, grants and favorites', () => {
  test('a grant references an org entry only, and a write replaces grants and views', () => {
    const { repo } = newRepo();
    activatedMember(repo);
    repo.saveRole(TEAM);
    repo.saveRole(OTHER);

    const saved = repo.saveOrgTool(
      tool('kanban', {
        roles: ['team'],
        views: [
          {
            id: 'v-sprint',
            label: 'Sprint',
            url: 'https://kanban.example.test/sprint',
            mode: 'window',
          },
          { id: 'v-docs', label: 'Docs', url: 'https://kanban.example.test/docs', mode: 'navigate' },
        ],
      }),
      NOW,
    );
    expect(saved.scope).toBe('org');
    expect(saved.ownerId).toBeNull();
    expect(saved.roles).toEqual(['team']);
    expect(saved.views.map((view) => view.label)).toEqual(['Sprint', 'Docs']);
    expect(saved.views.map((view) => view.ord)).toEqual([0, 1]);
    expect(saved.updatedAt).toBe(NOW);

    // A second write carries the whole tool: grants and views become exactly what it sends.
    const rewritten = repo.saveOrgTool(
      tool('kanban', {
        title: 'Kanban (new)',
        order: 2,
        roles: ['other'],
        views: [
          { id: 'v-docs', label: 'Docs', url: 'https://kanban.example.test/docs', mode: 'navigate' },
        ],
      }),
      hoursAfter(NOW, 1),
    );
    expect(rewritten.title).toBe('Kanban (new)');
    expect(rewritten.roles).toEqual(['other']);
    expect(rewritten.views.map((view) => view.id)).toEqual(['v-docs']);
    expect(rewritten.views[0]?.ord).toBe(0);
    expect(rewritten.updatedAt).toBe(hoursAfter(NOW, 1));

    // A personal entry is never a grant target, and a grant is idempotent.
    const mine = repo.savePersonalTool('p1', personal('p-abc1234567'), NOW);
    expect(() => repo.grant('team', mine.id, true)).toThrow(ForbiddenError);
    expect(() => repo.grant('ghost', 'kanban', true)).toThrow(NotFoundError);
    expect(() => repo.grant('team', 'ghost', true)).toThrow(NotFoundError);
    repo.grant('team', 'kanban', true);
    repo.grant('team', 'kanban', true);

    expect(repo.orgToolsFor('p1')).toEqual([]);
    repo.setRoles('p1', ['team', 'other']);
    expect(repo.orgToolsFor('p1').map((entry) => entry.id)).toEqual(['kanban']);
    expect(repo.orgToolsFor('p1')[0]?.roles).toEqual(['other', 'team']);
    expect(repo.listOrgTools()).toHaveLength(1);
    expect(repo.hasOrgTools()).toBe(true);

    // An org write never claims a personal id, and a missing tool is a 404.
    expect(() => repo.saveOrgTool(tool('p-abc1234567'), NOW)).toThrow(ForbiddenError);
    expect(() => repo.removeOrgTool('ghost')).toThrow(NotFoundError);
    repo.removeOrgTool('kanban');
    expect(repo.listOrgTools()).toEqual([]);
  });

  test('personal tools are filtered by owner and guarded against a stale write', () => {
    const { repo } = newRepo();
    activatedMember(repo, 'p1');
    activatedMember(repo, 'p2');

    const mine = repo.savePersonalTool('p1', personal('p-abc1234567'), NOW);
    expect(mine.scope).toBe('personal');
    expect(mine.ownerId).toBe('p1');
    expect(repo.personalTool('p1', 'p-abc1234567')?.title).toBe('Mine p-abc1234567');
    expect(repo.listPersonalTools('p1')).toHaveLength(1);

    // Nobody else sees it: another person asking the same id gets nothing.
    expect(repo.personalTool('p2', 'p-abc1234567')).toBeNull();
    expect(repo.listPersonalTools('p2')).toEqual([]);

    // A stale write is refused; a newer one wins.
    expect(() =>
      repo.savePersonalTool(
        'p1',
        personal('p-abc1234567', { title: 'Stale' }),
        msAfter(NOW, -1000),
      ),
    ).toThrow(ConflictError);
    expect(
      repo.savePersonalTool('p1', personal('p-abc1234567', { title: 'Newer' }), hoursAfter(NOW, 1))
        ?.title,
    ).toBe('Newer');
    expect(repo.personalTool('p1', 'p-abc1234567')?.title).toBe('Newer');
    expect(repo.personalTool('p1', 'p-abc1234567')?.updatedAt).toBe(hoursAfter(NOW, 1));

    // Someone else's id, and an org id, are "not yours" — for reads and for writes.
    expect(() => repo.savePersonalTool('p2', personal('p-abc1234567'), NOW)).toThrow(ForbiddenError);
    repo.saveOrgTool(tool('kanban'), NOW);
    expect(() => repo.savePersonalTool('p2', personal('kanban'), NOW)).toThrow(ForbiddenError);
    expect(() => repo.removePersonalTool('p2', 'p-abc1234567', NOW)).toThrow(ForbiddenError);
    expect(() => repo.removePersonalTool('p1', 'ghost', NOW)).toThrow(NotFoundError);
    expect(() => repo.removePersonalTool('p1', 'p-abc1234567', NOW)).toThrow(ConflictError);
    repo.removePersonalTool('p1', 'p-abc1234567', hoursAfter(NOW, 2));
    expect(repo.personalTool('p1', 'p-abc1234567')).toBeNull();
    expect(repo.listPersonalTools('p1')).toEqual([]);
  });

  test('a personal view hangs under an entry its owner can see', () => {
    const { repo } = newRepo();
    activatedMember(repo, 'p1');
    activatedMember(repo, 'p2');
    repo.saveRole(TEAM);
    repo.saveOrgTool(tool('kanban', { roles: ['team'] }), NOW);
    repo.savePersonalTool('p1', personal('p-abc1234567'), NOW);

    const view = {
      id: 'v-1',
      entryId: 'kanban',
      label: 'Sprint',
      url: 'https://kanban.example.test/sprint',
      mode: 'window' as const,
    };
    // Without a grant the org entry is not one this person can see.
    expect(() => repo.savePersonalView('p1', view, NOW)).toThrow(ForbiddenError);
    repo.setRoles('p1', ['team']);
    expect(repo.savePersonalView('p1', view, NOW).scope).toBe('personal');
    expect(repo.listPersonalViews('p1')[0]?.entryId).toBe('kanban');

    // ... and under their own personal entry.
    expect(
      repo.savePersonalView('p1', { ...view, id: 'v-2', entryId: 'p-abc1234567' }, NOW).entryId,
    ).toBe('p-abc1234567');
    expect(repo.listPersonalViews('p1').map((saved) => saved.id)).toEqual(['v-1', 'v-2']);

    // A view id of another person is not writable, and their list stays empty.
    expect(() => repo.savePersonalView('p2', view, NOW)).toThrow(ForbiddenError);
    expect(repo.listPersonalViews('p2')).toEqual([]);
    expect(() => repo.removePersonalView('p2', 'v-1', NOW)).toThrow(ForbiddenError);
    expect(() => repo.removePersonalView('p1', 'v-1', msAfter(NOW, -1))).toThrow(ConflictError);
    repo.removePersonalView('p1', 'v-1', hoursAfter(NOW, 1));
    expect(repo.listPersonalViews('p1').map((saved) => saved.id)).toEqual(['v-2']);
    // The org tool keeps its own views apart from the person's.
    expect(repo.listOrgTools()[0]?.views).toEqual([]);
  });

  test('favorites follow visibility, in order, and are pruned when it goes away', () => {
    const { repo } = newRepo();
    activatedMember(repo, 'p1');
    activatedMember(repo, 'p2');
    repo.saveRole(TEAM);
    repo.saveRole(OTHER);
    repo.saveOrgTool(tool('kanban', { roles: ['team', 'other'], order: 1 }), NOW);
    repo.saveOrgTool(tool('jitsi', { roles: ['other'], order: 2 }), NOW);
    repo.savePersonalTool('p1', personal('p-abc1234567'), NOW);
    repo.setRoles('p2', ['other']);

    // Nothing granted yet: no favorite goes in.
    expect(() => repo.replaceFavorites('p1', ['kanban'], NOW)).toThrow(ForbiddenError);
    expect(() => repo.replaceFavorites('p1', ['ghost'], NOW)).toThrow(ForbiddenError);
    expect(() => repo.replaceFavorites('p1', ['p-abc1234567'], NOW)).not.toThrow();
    expect(repo.favorites('p1')).toEqual(['p-abc1234567']);
    // Someone else's personal entry is invisible, so it cannot be a favorite.
    expect(() => repo.replaceFavorites('p2', ['p-abc1234567'], NOW)).toThrow(ForbiddenError);

    // The ordered list is replaced wholesale, a repeated id collapses, and it is per person.
    repo.setRoles('p1', ['team', 'other']);
    repo.replaceFavorites('p1', ['kanban', 'p-abc1234567', 'jitsi'], hoursAfter(NOW, 1));
    expect(repo.favorites('p1')).toEqual(['kanban', 'p-abc1234567', 'jitsi']);
    repo.replaceFavorites('p1', ['jitsi', 'jitsi', 'kanban'], hoursAfter(NOW, 2));
    expect(repo.favorites('p1')).toEqual(['jitsi', 'kanban']);
    expect(() => repo.replaceFavorites('p1', ['kanban'], NOW)).toThrow(ConflictError);
    repo.replaceFavorites('p2', ['jitsi'], NOW);
    expect(repo.favorites('p2')).toEqual(['jitsi']);

    // Losing the role that carried the grant prunes that person's favorites only (SP01 §2).
    repo.setRoles('p1', ['other']);
    expect(repo.favorites('p1')).toEqual(['jitsi', 'kanban']);
    repo.setRoles('p1', []);
    expect(repo.favorites('p1')).toEqual([]);
    expect(repo.favorites('p2')).toEqual(['jitsi']);
    // The personal tool survived: only the favorites go.
    expect(repo.personalTool('p1', 'p-abc1234567')).not.toBeNull();

    // Revoking a grant prunes the favorites it made possible.
    repo.grant('other', 'jitsi', false);
    expect(repo.favorites('p1')).toEqual([]);
    expect(repo.favorites('p2')).toEqual([]);
  });

  test('bootstrap writes roles and tools once, while the host has no org tool', () => {
    const { repo } = newRepo();
    activatedAdmin(repo);
    expect(repo.hasOrgTools()).toBe(false);

    repo.bootstrap(
      {
        roles: [TEAM],
        tools: [
          tool('kanban', { roles: ['team'] }),
          tool('jitsi', { order: 2 }),
        ],
      },
      NOW,
    );
    expect(repo.listOrgTools().map((entry) => entry.id)).toEqual(['kanban', 'jitsi']);
    expect(repo.listRoles().map((role) => role.id)).toEqual(['admin', 'team']);
    expect(repo.listOrgTools()[0]?.roles).toEqual(['team']);

    expect(() => repo.bootstrap({ roles: [], tools: [tool('affine')] }, NOW)).toThrow(ConflictError);
    expect(repo.listOrgTools()).toHaveLength(2);
  });
});

describe('events', () => {
  test('a duplicate client id is a no-op and every held id is acked once', () => {
    const { db, repo } = newRepo();
    activatedMember(repo);
    repo.createSession({ id: 's1', personId: 'p1', tokenHash: sha256Hex('t1'), device: DEVICE }, NOW);

    const events = [
      {
        id: 'e1',
        at: NOW,
        kind: 'tool_opened',
        toolId: 'kanban',
        url: 'https://kanban.example.test/app?token=secret#x',
      },
      { id: 'e2', at: NOW, kind: 'unlocked' },
    ];
    expect(repo.addEvents('p1', 's1', events, NOW)).toEqual(['e1', 'e2']);

    // Replaying the batch with one new event: the stored rows keep their first receipt.
    const later = hoursAfter(NOW, 1);
    expect(
      repo.addEvents('p1', 's1', [...events, { id: 'e3', at: later, kind: 'locked' }], later),
    ).toEqual(['e1', 'e2', 'e3']);

    const rows = db
      .query<{ id: string; receivedAt: string; url: string | null }, []>(
        'SELECT id, received_at AS receivedAt, url FROM events ORDER BY id',
      )
      .all();
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.receivedAt)).toEqual([NOW, NOW, later]);
    expect(rows[1]?.url).toBeNull();
    // SP01 §2: `url` keeps origin + pathname only — a query string never lands.
    expect(rows[0]?.url).toBe('https://kanban.example.test/app');
  });

  test('events are read newest first, filtered by person, tool and client time', () => {
    const { repo } = newRepo();
    activatedMember(repo);
    repo.createSession({ id: 's1', personId: 'p1', tokenHash: sha256Hex('t1'), device: DEVICE }, NOW);

    repo.addEvents(
      'p1',
      's1',
      [
        { id: 'e1', at: hoursAfter(NOW, -3), kind: 'tool_opened', toolId: 'kanban' },
        { id: 'e2', at: hoursAfter(NOW, -2), kind: 'tool_opened', toolId: 'jitsi', result: 'failed' },
        { id: 'e3', at: hoursAfter(NOW, -1), kind: 'login', toolId: 'kanban' },
      ],
      NOW,
    );

    expect(repo.listEvents().map((event) => event.id)).toEqual(['e3', 'e2', 'e1']);
    expect(repo.listEvents({ toolId: 'kanban' }).map((event) => event.id)).toEqual(['e3', 'e1']);
    expect(repo.listEvents({ personId: 'p1', limit: 1 }).map((event) => event.id)).toEqual(['e3']);
    expect(
      repo
        .listEvents({ from: hoursAfter(NOW, -2), to: hoursAfter(NOW, -1) })
        .map((event) => event.id),
    ).toEqual(['e3', 'e2']);
    expect(repo.listEvents({ personId: 'p2' })).toEqual([]);
    expect(repo.listEvents({ toolId: 'kanban' })[0]?.receivedAt).toBe(NOW);
    expect(repo.listEvents({ toolId: 'kanban' })[0]?.sessionId).toBe('s1');
  });
});

describe('meta', () => {
  test('meta round-trips, and the schema version stays the migrations to write', () => {
    const { repo } = newRepo();
    expect(repo.meta('guild_name')).toBeNull();
    repo.setMeta('guild_name', 'Copland');
    expect(repo.meta('guild_name')).toBe('Copland');
    repo.setMeta('guild_name', 'Copland Studio');
    expect(repo.meta('guild_name')).toBe('Copland Studio');
    repo.setMeta('created_at', NOW);
    expect(repo.meta('created_at')).toBe(NOW);
    expect(() => repo.setMeta('schema_version', '9')).toThrow(ConflictError);
    expect(repo.meta('schema_version')).toBe('1');
  });
});

describe('secrets', () => {
  test('no password, authKey, token or code is stored in clear', async () => {
    const { db, dir, repo } = newRepo();

    const password = 'correct-horse-battery-staple';
    const authKey = 'AUTHKEYc2FsdHktYm9uZC1ob3N0LXRlc3QtdmFsdWU';
    const token = 'TOKENb25kLWhvc3Qtc2Vzc2lvbi12YWx1ZS0wMQ';
    const code = 'ABCD-EFGH';
    const normalizedCode = code.replace('-', '');

    // What the host receives (SP02 §1–§2): the salt in clear, `argon2id(authKey)`, and hashes.
    repo.saveRole(ADMIN);
    repo.createPerson({ id: 'p1', email: 'a@bond.test', name: 'Ada', roles: ['admin'] }, NOW);
    const authHash = await Bun.password.hash(authKey, { algorithm: 'argon2id' });
    repo.activatePerson('p1', { salt: 'c2FsdC1ieXRlcy0xNg', authHash }, NOW);
    repo.issueCode(
      { id: 'c1', purpose: 'activate', personId: 'p1', codeHash: sha256Hex(normalizedCode) },
      NOW,
    );
    repo.redeemCode('activate', 'p1', sha256Hex(normalizedCode), NOW);
    repo.createSession(
      { id: 's1', personId: 'p1', tokenHash: sha256Hex(token), device: DEVICE },
      NOW,
    );

    const stored = db
      .query<{ salt: string | null; authHash: string | null }, [string]>(
        'SELECT salt, auth_hash AS authHash FROM people WHERE id = ?',
      )
      .get('p1');
    expect(stored?.salt).toBe('c2FsdC1ieXRlcy0xNg');
    expect(stored?.authHash).toStartWith('$argon2id$');
    expect(await Bun.password.verify(authKey, stored?.authHash as string)).toBe(true);
    expect(authHash).not.toBe(authKey);

    expect(
      db
        .query<{ tokenHash: string }, [string]>(
          'SELECT token_hash AS tokenHash FROM sessions WHERE id = ?',
        )
        .get('s1')?.tokenHash,
    ).toBe(sha256Hex(token));
    expect(
      db
        .query<{ codeHash: string }, [string]>(
          'SELECT code_hash AS codeHash FROM access_codes WHERE id = ?',
        )
        .get('c1')?.codeHash,
    ).toBe(sha256Hex(normalizedCode));
    // What the repo answers carries no hash either.
    expect(JSON.stringify(repo.sessionByTokenHash(sha256Hex(token), NOW))).not.toContain(
      sha256Hex(token),
    );

    const secrets = [password, authKey, token, code, normalizedCode];
    const tables = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all();
    const rows = tables
      .map((table) => JSON.stringify(db.query(`SELECT * FROM ${table.name}`).all()))
      .join('\n');
    expect(rows).toContain('$argon2id$');
    for (const secret of secrets) expect(rows).not.toContain(secret);

    // The same sweep over the bytes the data dir holds.
    const files = readdirSync(dir);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const bytes = readFileSync(join(dir, file));
      for (const secret of secrets) expect(bytes.includes(secret)).toBe(false);
    }
  });
});
