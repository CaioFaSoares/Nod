// Local session (`backend/session.ts`) against in-memory SQLite, in-memory keychain and `store`, a
// fixed clock and PBKDF2 with 1000 iterations. Proves this slice's acceptance criteria: account and
// invite, unlock with backoff and a single error, password change, refresh, biometrics and lock.
import { describe, expect, test } from 'bun:test';

import { createRepo } from '../backend/repo';
import { createSession } from '../backend/session';
import { createVault } from '../backend/vault';
import { HostError } from '../backend/host-client';
import { deriveKeys, hashInviteCode, hashPassword, passwordCheck } from '../shared/auth';
import { fromBase64url, toBase64url } from '../shared/encoding';
import { memorySqlite } from './helpers/sqlite-bun';
import type { PasswordHashV2 } from '../shared/auth';
import type { PasswordChangeRequest } from '../shared/host-api';
import type { Repo } from '../backend/repo';
import type { Session } from '../backend/session';
import type { Entry, SecretStore, SqlDb } from '../shared/types';

// PBKDF2 with 600 000 iterations costs hundreds of ms per derivation; the tests use 1000 (§3).
const ITERATIONS = 1000;
const PASSWORD = 'nod-password';
const NEW_PASSWORD = 'nod-password-new';
const WRONG_PASSWORD = 'nod-password-wrong';
const EMAIL = 'ana@example.test';
const NOW = '2026-10-15T12:00:00.000Z';
const EXPIRES = '2026-11-01T00:00:00.000Z';
// The host of SP02 §4 gives a salt as 16 bytes of base64url; this one is 0x00..0x0f.
const HOST_SALT = 'AAECAwQFBgcICQoLDA0ODw';
const HOST_PERSON_ID = 'host-person-1';
const GUILD_EMAIL = 'ana@guild.test';
const GUILD_PASSWORD = 'guild-password';

function memoryKeychain() {
  const items = new Map<string, string>();
  const keychain: SecretStore = {
    async get(key) {
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
  return { keychain, items };
}

function memoryStore() {
  const items = new Map<string, unknown>();
  return {
    items,
    store: {
      async get(key: string): Promise<unknown> {
        return items.get(key) ?? null;
      },
      async set(key: string, value: unknown): Promise<boolean> {
        items.set(key, value);
        return true;
      },
    },
  };
}

function fixedClock(start: string) {
  let instant = new Date(start);
  return {
    now: (): Date => new Date(instant),
    advance(ms: number): void {
      instant = new Date(instant.getTime() + ms);
    },
  };
}

/** Everything a session test needs, with the runtime seams replaced by in-memory doubles. */
interface SessionScene {
  repo: Repo;
  db: SqlDb;
  session: Session;
  keychain: SecretStore;
  secrets: Map<string, string>;
  saved: Map<string, unknown>;
  clock: { now(): Date; advance(ms: number): void };
  /** Reason the OS biometric dialog was asked with, in order. */
  reasons: string[];
  setAuthentication(answer: boolean): void;
}

function scene(options: { biometricAvailable?: boolean } = {}): SessionScene {
  const db = memorySqlite();
  const repo = createRepo(db);
  repo.migrate();
  repo.ensureAdminRole();

  const { keychain, items: secrets } = memoryKeychain();
  const { store, items: saved } = memoryStore();
  const clock = fixedClock(NOW);
  const reasons: string[] = [];
  let authenticationAnswer = true;

  const session = createSession({
    repo,
    keychain,
    store,
    authenticate: async (reason: string): Promise<boolean> => {
      reasons.push(reason);
      return authenticationAnswer;
    },
    biometricAvailable: options.biometricAvailable ?? false,
    iterations: ITERATIONS,
    now: clock.now,
  });

  return {
    repo,
    db,
    session,
    keychain,
    secrets,
    saved,
    clock,
    reasons,
    setAuthentication: (answer: boolean): void => {
      authenticationAnswer = answer;
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

async function messageOf(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return 'did not throw';
}

async function firstAccount(s: SessionScene): Promise<string> {
  const state = await s.session.createAccount({ email: EMAIL, name: 'Ana', password: PASSWORD });
  return state.person?.id ?? '';
}

/** The role has to exist before the invite: `person_role` has a foreign key to `role`. */
async function openInvite(s: SessionScene, code: string, roles: string[] = []): Promise<void> {
  for (const id of roles) s.repo.saveRole({ id, name: id, admin: false });
  s.repo.saveInvite({
    codeHash: await hashInviteCode(code),
    roles,
    expiresAt: EXPIRES,
    createdBy: null,
  });
}

function eventTypes(s: SessionScene): string[] {
  return s.repo.listEvents({}).map((event) => event.type);
}

/** Adopts the connected account of these tests: the host person id, the host salt and the password. */
async function adoptConnected(
  s: SessionScene,
  overrides: Partial<Parameters<Session['adoptConnectedAccount']>[0]> = {},
) {
  return s.session.adoptConnectedAccount({
    personId: HOST_PERSON_ID,
    email: GUILD_EMAIL,
    name: 'Ana',
    password: GUILD_PASSWORD,
    salt: HOST_SALT,
    iterations: ITERATIONS,
    admin: true,
    ...overrides,
  });
}

/** The keys the session holds, base64url, or a clear failure when it holds none (SP02 §6). */
function keysOf(s: SessionScene): { authKey: string; vaultKey: string } {
  const keys = s.session.keys();
  if (keys === null) throw new Error('the session holds no keys');
  return { authKey: toBase64url(keys.authKey), vaultKey: toBase64url(keys.vaultKey) };
}

describe('state', () => {
  test('a new machine: no account, no invite needed, nothing to wait for and no biometrics', async () => {
    const s = scene({ biometricAvailable: true });

    expect(await s.session.state()).toEqual({
      hasAccount: false,
      requiresInvite: false,
      unlocked: false,
      person: null,
      biometric: false,
      waitMs: 0,
    });
  });
});

describe('createAccount', () => {
  test('the first account without invites becomes the administrator and is already unlocked', async () => {
    const s = scene();

    const state = await s.session.createAccount({
      email: ' Ana@Example.Test ',
      name: '  Ana  ',
      password: PASSWORD,
    });

    expect(state.hasAccount).toBe(true);
    expect(state.requiresInvite).toBe(true);
    expect(state.unlocked).toBe(true);
    expect(state.person?.email).toBe(EMAIL);
    expect(state.person?.name).toBe('Ana');
    expect(state.person?.admin).toBe(true);
    expect(state.person?.roles).toEqual(['admin']);
    expect(s.session.current()?.id).toBe(state.person?.id);
    expect(s.saved.get('last_person')).toBe(state.person?.id);
    expect(eventTypes(s)).toEqual(['account_created']);
    // The password never reaches the database in the clear: the PBKDF2 hash with the test
    // iterations does.
    expect(s.repo.personByEmail(EMAIL)?.password.iterations).toBe(ITERATIONS);
    expect(JSON.stringify(s.repo.listEvents({}))).not.toContain(PASSWORD);
    expect(JSON.stringify([...s.saved.entries()])).not.toContain(PASSWORD);
  });

  test('an email without @, an empty name and a short password are refused before any write', async () => {
    const s = scene();

    expect(
      await messageOf(() => s.session.createAccount({ email: 'ana', name: 'Ana', password: PASSWORD })),
    ).toBe('enter a valid email');
    expect(
      await messageOf(() => s.session.createAccount({ email: EMAIL, name: '   ', password: PASSWORD })),
    ).toBe('name is required');
    expect(
      await messageOf(() => s.session.createAccount({ email: EMAIL, name: 'Ana', password: 'short' })),
    ).toBe('password must be at least 8 characters');
    expect(s.repo.countPeople()).toBe(0);
  });

  test('the second account needs an invite and takes the invite roles', async () => {
    const s = scene();
    await firstAccount(s);
    await openInvite(s, 'team-code', ['team']);

    expect(
      await messageOf(() =>
        s.session.createAccount({ email: 'bruno@example.test', name: 'Bruno', password: PASSWORD }),
      ),
    ).toBe('invalid invite');

    const state = await s.session.createAccount({
      email: 'Bruno@Example.Test',
      name: 'Bruno',
      password: PASSWORD,
      code: 'team-code',
    });
    expect(state.unlocked).toBe(true);
    expect(state.person?.roles).toEqual(['team']);
    expect(state.person?.admin).toBe(false);

    // The invite is single use (RF-07).
    s.session.lock();
    expect(
      await messageOf(() =>
        s.session.createAccount({
          email: 'carla@example.test',
          name: 'Carla',
          password: PASSWORD,
          code: 'team-code',
        }),
      ),
    ).toBe('invalid invite');
    expect(s.repo.countPeople()).toBe(2);
  });

  test('an expired, an unknown and a missing invite give the same message', async () => {
    const s = scene();
    await firstAccount(s);
    s.repo.saveInvite({
      codeHash: await hashInviteCode('expired-code'),
      roles: [],
      expiresAt: '2026-10-01T00:00:00.000Z',
      createdBy: null,
    });

    const create = (code?: string) =>
      s.session.createAccount({ email: 'new@example.test', name: 'New', password: PASSWORD, code });

    expect(await messageOf(() => create('expired-code'))).toBe('invalid invite');
    expect(await messageOf(() => create('code-that-does-not-exist'))).toBe('invalid invite');
    expect(await messageOf(() => create())).toBe('invalid invite');
    expect(s.repo.countPeople()).toBe(1);
  });

  test('an open invite with zero people already demands the code and keeps the first account out of admin', async () => {
    const s = scene();
    await openInvite(s, 'seed-code', ['team']);

    const before = await s.session.state();
    expect(before.hasAccount).toBe(false);
    expect(before.requiresInvite).toBe(true);

    expect(
      await messageOf(() =>
        s.session.createAccount({ email: EMAIL, name: 'Ana', password: PASSWORD }),
      ),
    ).toBe('invalid invite');
    expect(s.repo.countPeople()).toBe(0);

    const state = await s.session.createAccount({
      email: EMAIL,
      name: 'Ana',
      password: PASSWORD,
      code: 'seed-code',
    });
    expect(state.person?.roles).toEqual(['team']);
    expect(state.person?.admin).toBe(false);
  });

  test('a database with revoked people only still requires an invite', async () => {
    const s = scene();
    const revoked = s.repo.createPerson({
      email: EMAIL,
      name: 'Ana',
      password: await hashPassword(PASSWORD, ITERATIONS),
      roles: ['admin'],
    });
    s.repo.revokePerson(revoked.id);

    const state = await s.session.state();
    expect(state.hasAccount).toBe(true);
    expect(state.requiresInvite).toBe(true);

    expect(
      await messageOf(() =>
        s.session.createAccount({ email: 'bruno@example.test', name: 'Bruno', password: PASSWORD }),
      ),
    ).toBe('invalid invite');
    expect(s.repo.countPeople()).toBe(1);

    await openInvite(s, 'bruno-code', ['team']);
    const created = await s.session.createAccount({
      email: 'bruno@example.test',
      name: 'Bruno',
      password: PASSWORD,
      code: 'bruno-code',
    });
    expect(created.person?.roles).toEqual(['team']);
    expect(s.repo.countPeople()).toBe(2);
  });

  test('an email already registered is refused and the invite stays whole', async () => {
    const s = scene();
    await firstAccount(s);
    await openInvite(s, 'repeated-code');

    expect(
      await messageOf(() =>
        s.session.createAccount({
          email: EMAIL,
          name: 'Another Ana',
          password: PASSWORD,
          code: 'repeated-code',
        }),
      ),
    ).toBe('email already registered');
    expect(s.repo.countPeople()).toBe(1);

    // The refused attempt did not consume the invite: it still serves someone else.
    const state = await s.session.createAccount({
      email: 'bruno@example.test',
      name: 'Bruno',
      password: PASSWORD,
      code: 'repeated-code',
    });
    expect(state.person?.email).toBe('bruno@example.test');
  });
});

describe('unlock', () => {
  test('the right password opens the session and records the unlock', async () => {
    const s = scene();
    const id = await firstAccount(s);
    s.session.lock();

    const state = await s.session.unlock({ email: ' ANA@Example.Test ', password: PASSWORD });

    expect(state.unlocked).toBe(true);
    expect(state.person?.id).toBe(id);
    expect(state.waitMs).toBe(0);
    expect(s.saved.get('last_person')).toBe(id);
    expect(eventTypes(s)).toEqual(['unlocked', 'locked', 'account_created']);
    expect(s.repo.listEvents({}).find((event) => event.type === 'unlocked')?.result).toBe('password');
  });

  test('a wrong password and an unknown email give the same message, with no hint in the event', async () => {
    const s = scene();
    await firstAccount(s);
    s.session.lock();

    const known = await messageOf(() => s.session.unlock({ email: EMAIL, password: WRONG_PASSWORD }));
    const unknown = await messageOf(() =>
      s.session.unlock({ email: 'nobody@example.test', password: WRONG_PASSWORD }),
    );

    expect(known).toBe('invalid credentials');
    expect(unknown).toBe('invalid credentials');
    expect(s.repo.meta('unlock_failures')).toBe('2');
    expect(s.repo.meta('unlock_last_failure')).toBe(NOW);

    const failures = s.repo.listEvents({}).filter((event) => event.type === 'unlock_failed');
    expect(failures).toHaveLength(2);
    for (const failure of failures) {
      expect(failure.personId).toBeNull();
      expect(failure.detail).toBeNull();
      expect(failure.url).toBeNull();
    }
    // Neither the typed email nor the password shows up in the audit trail.
    const json = JSON.stringify(s.repo.listEvents({}));
    expect(json).not.toContain('@example.test');
    expect(json).not.toContain(WRONG_PASSWORD);
  });

  test('four failures do not wait; the fifth waits 1000 ms and the clock releases it', async () => {
    const s = scene();
    await firstAccount(s);
    s.session.lock();

    for (let attempt = 1; attempt <= 4; attempt++) {
      expect(
        await messageOf(() => s.session.unlock({ email: EMAIL, password: WRONG_PASSWORD })),
      ).toBe('invalid credentials');
      expect((await s.session.state()).waitMs).toBe(0);
    }

    // The fifth failure is the one that arms the 1 s wait.
    expect(await messageOf(() => s.session.unlock({ email: EMAIL, password: WRONG_PASSWORD }))).toBe(
      'invalid credentials',
    );
    expect(s.repo.meta('unlock_failures')).toBe('5');
    expect((await s.session.state()).waitMs).toBe(1000);

    // Inside the wait not even the right password goes through, and an unknown email gets the very
    // same message: the guard runs before the lookup.
    expect(await messageOf(() => s.session.unlock({ email: EMAIL, password: PASSWORD }))).toBe(
      'wait before trying again',
    );
    expect(
      await messageOf(() => s.session.unlock({ email: 'nobody@example.test', password: PASSWORD })),
    ).toBe('wait before trying again');
    expect((await s.session.state()).unlocked).toBe(false);

    s.clock.advance(1000);
    expect((await s.session.state()).waitMs).toBe(0);

    // The sixth failure doubles the wait to 2 s.
    expect(await messageOf(() => s.session.unlock({ email: EMAIL, password: WRONG_PASSWORD }))).toBe(
      'invalid credentials',
    );
    expect((await s.session.state()).waitMs).toBe(2000);
    expect(await messageOf(() => s.session.unlock({ email: EMAIL, password: PASSWORD }))).toBe(
      'wait before trying again',
    );

    s.clock.advance(2000);
    const state = await s.session.unlock({ email: EMAIL, password: PASSWORD });
    expect(state.unlocked).toBe(true);
    // A hit resets the counter: the wait goes back to zero without the clock moving.
    expect(s.repo.meta('unlock_failures')).toBe('0');
    expect((await s.session.state()).waitMs).toBe(0);
  });
});

describe('changePassword', () => {
  test('the old password stops working, the new one works and the vault stays readable (RF-24)', async () => {
    const s = scene();
    const id = await firstAccount(s);
    // The vault item points at a tool: the row has to exist (foreign key).
    s.repo.saveEntry(tool('kanban'));
    const vault = createVault({ repo: s.repo, keychain: s.keychain, iterations: ITERATIONS });
    await vault.save(id, { toolId: 'kanban', username: 'ana', secret: 'kanban-secret' });

    await s.session.changePassword(PASSWORD, NEW_PASSWORD);
    s.session.lock();

    expect(await messageOf(() => s.session.unlock({ email: EMAIL, password: PASSWORD }))).toBe(
      'invalid credentials',
    );
    expect((await s.session.unlock({ email: EMAIL, password: NEW_PASSWORD })).unlocked).toBe(true);
    // Changing the password does not touch the keychain: the vault item is still there.
    expect(await vault.read(id, 'kanban')).toEqual({ username: 'ana', secret: 'kanban-secret' });
    expect(eventTypes(s)).toContain('password_changed');
  });

  test('a wrong current password, a short new password and a locked session are refused', async () => {
    const s = scene();
    await firstAccount(s);

    expect(await messageOf(() => s.session.changePassword(WRONG_PASSWORD, NEW_PASSWORD))).toBe(
      'invalid credentials',
    );
    expect(await messageOf(() => s.session.changePassword(PASSWORD, 'short'))).toBe(
      'password must be at least 8 characters',
    );

    s.session.lock();
    expect(await messageOf(() => s.session.changePassword(PASSWORD, NEW_PASSWORD))).toBe(
      'session is locked',
    );

    // None of the refusals changed the password.
    expect((await s.session.unlock({ email: EMAIL, password: PASSWORD })).unlocked).toBe(true);
  });
});

describe('refresh', () => {
  test('reloads the current person from the repository and locks it when it was revoked (A23)', async () => {
    const s = scene();
    const id = await firstAccount(s);
    s.repo.saveRole({ id: 'operator', name: 'Operator', admin: false });

    // Roles changed by another window: the session picks the new set up.
    s.repo.setRoles(id, ['operator']);
    s.session.refresh();
    expect(s.session.current()?.roles).toEqual(['operator']);
    expect(s.session.current()?.admin).toBe(false);

    // Revoked by another window: the session lets go of the person.
    s.repo.revokePerson(id);
    s.session.refresh();

    expect(s.session.current()).toBeNull();
    const state = await s.session.state();
    expect(state.unlocked).toBe(false);
    expect(state.person).toBeNull();
    expect(state.hasAccount).toBe(true);
    expect(eventTypes(s)).toContain('locked');
  });

  test('a locked session stays locked', async () => {
    const s = scene();
    await firstAccount(s);
    s.session.lock();

    s.session.refresh();

    expect(s.session.current()).toBeNull();
    expect((await s.session.state()).unlocked).toBe(false);
  });
});

describe('biometrics', () => {
  test('without biometrics on the system, enabling and unlocking by biometrics fail', async () => {
    const s = scene({ biometricAvailable: false });
    const id = await firstAccount(s);

    expect(await messageOf(() => s.session.enableBiometric(PASSWORD))).toBe(
      'biometrics are not available on this system',
    );
    // The password is checked first: with a wrong password the error is the usual one.
    expect(await messageOf(() => s.session.enableBiometric(WRONG_PASSWORD))).toBe('invalid credentials');
    expect(s.secrets.has(`nod.bio.${id}`)).toBe(false);

    s.session.lock();
    expect(await messageOf(() => s.session.unlockBiometric())).toBe(
      'biometrics are not available on this system',
    );
    expect(s.reasons).toEqual([]);
    expect((await s.session.state()).biometric).toBe(false);
  });

  test('enabled, biometrics stores the person key and unlocks the session', async () => {
    const s = scene({ biometricAvailable: true });
    const id = await firstAccount(s);

    expect((await s.session.enableBiometric(PASSWORD)).biometric).toBe(true);
    expect(s.secrets.get(`nod.bio.${id}`)).toBe(id);
    expect(s.saved.get('last_person')).toBe(id);

    const locked = s.session.lock();
    expect(locked.unlocked).toBe(false);
    expect(locked.biometric).toBe(true);

    const state = await s.session.unlockBiometric();
    expect(s.reasons).toEqual(['Unlock Nod']);
    expect(state.unlocked).toBe(true);
    expect(state.person?.id).toBe(id);
    expect(state.biometric).toBe(true);
    expect(s.repo.listEvents({}).find((event) => event.type === 'unlocked')?.result).toBe('biometric');
  });

  test('a refusal from the system leaves the session closed', async () => {
    const s = scene({ biometricAvailable: true });
    const id = await firstAccount(s);
    await s.session.enableBiometric(PASSWORD);
    s.session.lock();
    s.setAuthentication(false);

    expect(await messageOf(() => s.session.unlockBiometric())).toBe('biometrics were declined');
    expect((await s.session.state()).unlocked).toBe(false);
    expect(s.secrets.get(`nod.bio.${id}`)).toBe(id);
  });

  test('without a key in the keychain or with a revoked person, biometrics opens nothing', async () => {
    const s = scene({ biometricAvailable: true });
    const id = await firstAccount(s);
    s.session.lock();

    // Never enabled: `last_person` exists, the `nod.bio.<person>` key does not.
    expect(await messageOf(() => s.session.unlockBiometric())).toBe('biometrics are not enabled');

    // `unlock` is asynchronous: without the `await`, `enableBiometric` would find a locked session.
    await s.session.unlock({ email: EMAIL, password: PASSWORD });
    await s.session.enableBiometric(PASSWORD);
    s.session.lock();
    s.repo.revokePerson(id);

    expect(await messageOf(() => s.session.unlockBiometric())).toBe('biometrics are not enabled');
    expect((await s.session.state()).unlocked).toBe(false);
  });
});

describe('lock', () => {
  test('forgets the current person, records the event once and keeps the rest of the state', async () => {
    const s = scene();
    await firstAccount(s);

    const state = s.session.lock();
    s.session.lock();

    expect(state.unlocked).toBe(false);
    expect(state.person).toBeNull();
    expect(state.hasAccount).toBe(true);
    expect(state.requiresInvite).toBe(true);
    expect(state.waitMs).toBe(0);
    expect(s.session.current()).toBeNull();
    expect(eventTypes(s).filter((type) => type === 'locked')).toHaveLength(1);
  });
});

describe('adoptConnectedAccount (SP02 §6, SP05 §2)', () => {
  test('creates the local person with the host id, the host salt and the keys in memory', async () => {
    const s = scene();

    const state = await adoptConnected(s, { email: ' Ana@Guild.Test ', name: '  Ana  ' });

    expect(state.unlocked).toBe(true);
    expect(state.person?.id).toBe(HOST_PERSON_ID);
    expect(state.person?.email).toBe(GUILD_EMAIL);
    expect(state.person?.name).toBe('Ana');
    expect(state.person?.admin).toBe(true);
    expect(state.person?.roles).toEqual(['admin']);
    expect(s.saved.get('last_person')).toBe(HOST_PERSON_ID);
    expect(eventTypes(s)).toEqual(['account_created']);

    // The row verifies with the V2 check over the HOST salt and holds no v1 hash at all.
    const hostKeys = await deriveKeys(GUILD_PASSWORD, fromBase64url(HOST_SALT), ITERATIONS);
    expect(s.repo.personAuthByEmail(GUILD_EMAIL)?.password).toEqual({
      algorithm: 'BOND-KDF-V1',
      salt: HOST_SALT,
      iterations: ITERATIONS,
      check: await passwordCheck(hostKeys.localKey),
    });
    expect(s.db.all('SELECT password_hash, password_algorithm FROM person')).toEqual([
      { password_hash: '', password_algorithm: 'BOND-KDF-V1' },
    ]);

    // The keys of the session are the host's keys: the same derivation, so the same bytes.
    expect(keysOf(s)).toEqual({
      authKey: toBase64url(hostKeys.authKey),
      vaultKey: toBase64url(hostKeys.vaultKey),
    });
  });

  test('the host salt unlocks offline, with no host row and no host call', async () => {
    const s = scene();
    await adoptConnected(s);
    s.session.lock();

    // Nothing about a host lives here: the salt is cached on the person row (SP02 §6), and the
    // session has no network seam at all.
    expect(s.repo.hostRecord()).toBeNull();
    const state = await s.session.unlock({ email: GUILD_EMAIL, password: GUILD_PASSWORD });

    expect(state.unlocked).toBe(true);
    const hostKeys = await deriveKeys(GUILD_PASSWORD, fromBase64url(HOST_SALT), ITERATIONS);
    expect(keysOf(s)).toEqual({
      authKey: toBase64url(hostKeys.authKey),
      vaultKey: toBase64url(hostKeys.vaultKey),
    });
    expect(s.repo.meta('unlock_failures')).toBe('0');
  });

  test('the unlock backoff stays for a V2 account (RF-23)', async () => {
    const s = scene();
    await adoptConnected(s);
    s.session.lock();

    for (let attempt = 1; attempt <= 5; attempt++) {
      expect(
        await messageOf(() => s.session.unlock({ email: GUILD_EMAIL, password: WRONG_PASSWORD })),
      ).toBe('invalid credentials');
    }
    expect(s.repo.meta('unlock_failures')).toBe('5');
    expect((await s.session.state()).waitMs).toBe(1000);
    // Inside the wait not even the right password goes through.
    expect(await messageOf(() => s.session.unlock({ email: GUILD_EMAIL, password: GUILD_PASSWORD }))).toBe(
      'wait before trying again',
    );

    s.clock.advance(1000);
    const state = await s.session.unlock({ email: GUILD_EMAIL, password: GUILD_PASSWORD });

    expect(state.unlocked).toBe(true);
    expect(s.repo.meta('unlock_failures')).toBe('0');
  });

  test('a second adoption of the same host person updates the row in place', async () => {
    const s = scene();
    const first = await adoptConnected(s);

    const second = await adoptConnected(s, {
      email: 'ana.renamed@guild.test',
      name: 'Ana Renamed',
      password: NEW_PASSWORD,
      admin: false,
    });

    expect(s.repo.countPeople()).toBe(1);
    expect(second.person?.id).toBe(HOST_PERSON_ID);
    expect(second.person?.createdAt).toBe(first.person?.createdAt);
    expect(second.person?.name).toBe('Ana Renamed');
    expect(second.person?.admin).toBe(false);
    expect(second.person?.roles).toEqual([]);
    expect(eventTypes(s)).toEqual(['unlocked', 'account_created']);
    expect(s.repo.personAuthByEmail(GUILD_EMAIL)).toBeNull();

    // The new verifier took over: the old password stopped working.
    s.session.lock();
    expect(
      await messageOf(() => s.session.unlock({ email: 'ana.renamed@guild.test', password: GUILD_PASSWORD })),
    ).toBe('invalid credentials');
    expect(
      (await s.session.unlock({ email: 'ana.renamed@guild.test', password: NEW_PASSWORD })).unlocked,
    ).toBe(true);
  });

  test('a bad email, an empty name and a short password are refused before any write', async () => {
    const s = scene();

    expect(await messageOf(() => adoptConnected(s, { email: 'ana' }))).toBe('enter a valid email');
    expect(await messageOf(() => adoptConnected(s, { name: '   ' }))).toBe('name is required');
    expect(await messageOf(() => adoptConnected(s, { password: 'short' }))).toBe(
      'password must be at least 8 characters',
    );

    expect(s.repo.countPeople()).toBe(0);
  });

  test('an email another local person holds is refused', async () => {
    const s = scene();
    await firstAccount(s);

    expect(await messageOf(() => adoptConnected(s, { email: EMAIL }))).toBe('email already registered');
    expect(s.repo.countPeople()).toBe(1);
  });

  test('no password and no derived key reaches any row of the database', async () => {
    const s = scene();
    await adoptConnected(s);
    const adoptedKeys = keysOf(s);
    await s.session.changePassword(GUILD_PASSWORD, NEW_PASSWORD, async () => {});
    const changedKeys = keysOf(s);

    const dump = s.db
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .map((table) => JSON.stringify(s.db.all(`SELECT * FROM ${table.name}`)))
      .join('\n');

    for (const secret of [
      GUILD_PASSWORD,
      NEW_PASSWORD,
      adoptedKeys.authKey,
      adoptedKeys.vaultKey,
      changedKeys.authKey,
      changedKeys.vaultKey,
    ]) {
      expect(dump).not.toContain(secret);
    }
  });
});

describe('keys and deriveFor (SP02 §6)', () => {
  test('deriveFor is the SP02 §1 derivation over a base64url salt, with no session state', async () => {
    const s = scene();

    const keys = await s.session.deriveFor(GUILD_PASSWORD, HOST_SALT, ITERATIONS);
    const expected = await deriveKeys(GUILD_PASSWORD, fromBase64url(HOST_SALT), ITERATIONS);

    expect(toBase64url(keys.authKey)).toBe(toBase64url(expected.authKey));
    expect(toBase64url(keys.vaultKey)).toBe(toBase64url(expected.vaultKey));
    expect(toBase64url(keys.localKey)).toBe(toBase64url(expected.localKey));
    // Pure: it unlocked nothing and kept nothing.
    expect(s.session.keys()).toBeNull();
    expect((await s.session.state()).unlocked).toBe(false);
    // A salt that is not base64url is refused by the encoding, never derived from a guess.
    expect(await messageOf(() => s.session.deriveFor(GUILD_PASSWORD, 'not base64url!', ITERATIONS))).toBe(
      'invalid base64url',
    );
  });

  test('the keys live in memory while unlocked and are gone after lock', async () => {
    const s = scene();
    expect(s.session.keys()).toBeNull();

    await adoptConnected(s);
    const unlocked = keysOf(s);

    const locked = s.session.lock();
    expect(locked.unlocked).toBe(false);
    expect(s.session.keys()).toBeNull();

    await s.session.unlock({ email: GUILD_EMAIL, password: GUILD_PASSWORD });
    expect(keysOf(s)).toEqual(unlocked);
  });

  test('a biometric unlock leaves no keys: no password was typed', async () => {
    const s = scene({ biometricAvailable: true });
    await adoptConnected(s);
    await s.session.enableBiometric(GUILD_PASSWORD);
    s.session.lock();

    const state = await s.session.unlockBiometric();

    expect(state.unlocked).toBe(true);
    expect(s.session.keys()).toBeNull();
  });

  test('a locally created account has no keys until its first unlock migrates it', async () => {
    const s = scene();
    await firstAccount(s); // createAccount writes a v1 row: nothing was derived
    expect(s.session.keys()).toBeNull();

    s.session.lock();
    await s.session.unlock({ email: EMAIL, password: PASSWORD });

    expect(s.repo.personAuthByEmail(EMAIL)?.password.algorithm).toBe('BOND-KDF-V1');
    expect(s.session.keys()).not.toBeNull();
  });

  test('creating another account forgets the keys of the one that was unlocked', async () => {
    const s = scene();
    await firstAccount(s);
    s.session.lock();
    await s.session.unlock({ email: EMAIL, password: PASSWORD });
    expect(s.session.keys()).not.toBeNull();
    await openInvite(s, 'bruno-code');

    await s.session.createAccount({
      email: 'bruno@example.test',
      name: 'Bruno',
      password: PASSWORD,
      code: 'bruno-code',
    });

    // The session is Bruno's now, and Bruno's row is v1: no key of Ana's is left over.
    expect(s.session.current()?.email).toBe('bruno@example.test');
    expect(s.session.keys()).toBeNull();
  });
});

describe('changePassword against the host (SP02 §7)', () => {
  test('sends the old and the new authKey to the host and keeps the vault working (RF-24)', async () => {
    const s = scene();
    const id = (await adoptConnected(s)).person?.id ?? '';
    // The connected row and its cached snapshot, as B2 leaves them after a sign-in.
    s.repo.saveHost({
      address: 'https://guild.test',
      guild: 'Guild',
      kid: 'kid-1',
      publicKey: 'cHVibGljLWtleQ',
      personId: HOST_PERSON_ID,
      salt: HOST_SALT,
      addedAt: NOW,
    });
    s.repo.saveHostSnapshot({ snapshot: '{"api":1}', version: 'v1', issuedAt: NOW, syncedAt: NOW });
    // The vault item points at a tool: the row has to exist (foreign key).
    s.repo.saveEntry(tool('kanban'));
    const vault = createVault({ repo: s.repo, keychain: s.keychain, iterations: ITERATIONS });
    await vault.save(id, { toolId: 'kanban', username: 'ana', secret: 'kanban-secret' });

    const requests: PasswordChangeRequest[] = [];
    await s.session.changePassword(GUILD_PASSWORD, NEW_PASSWORD, async (request) => {
      requests.push(request);
    });

    expect(requests).toHaveLength(1);
    const request = requests[0];
    const oldKeys = await deriveKeys(GUILD_PASSWORD, fromBase64url(HOST_SALT), ITERATIONS);
    expect(request.currentAuthKey).toBe(toBase64url(oldKeys.authKey));
    expect(request.newSalt).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(request.newSalt).not.toBe(HOST_SALT);
    const newKeys = await deriveKeys(NEW_PASSWORD, fromBase64url(request.newSalt), ITERATIONS);
    expect(request.newAuthKey).toBe(toBase64url(newKeys.authKey));
    // Derived keys, not the password: 32 bytes of base64url, and one is not the other.
    expect(request.currentAuthKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(request.newAuthKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(request.newAuthKey).not.toBe(request.currentAuthKey);

    // RF-42: only derived keys travel, and the request holds no password at all.
    expect(JSON.stringify(request)).not.toContain(GUILD_PASSWORD);
    expect(JSON.stringify(request)).not.toContain(NEW_PASSWORD);

    // The row verifies the new password over the new salt, and the session keeps the new keys.
    const stored = s.repo.personAuthByEmail(GUILD_EMAIL)?.password as PasswordHashV2;
    expect(stored.algorithm).toBe('BOND-KDF-V1');
    expect(stored.salt).toBe(request.newSalt);
    expect(stored.check).toBe(await passwordCheck(newKeys.localKey));
    expect(keysOf(s)).toEqual({
      authKey: request.newAuthKey,
      vaultKey: toBase64url(newKeys.vaultKey),
    });

    s.session.lock();
    expect(await messageOf(() => s.session.unlock({ email: GUILD_EMAIL, password: GUILD_PASSWORD }))).toBe(
      'invalid credentials',
    );
    expect((await s.session.unlock({ email: GUILD_EMAIL, password: NEW_PASSWORD })).unlocked).toBe(true);

    // The OS keychain was not touched: the autofill keeps working after the change (RF-24).
    expect(s.repo.listVault(id)).toHaveLength(1);
    expect(s.secrets.has(`nod.cred.${id}.kanban`)).toBe(true);
    expect(await vault.read(id, 'kanban')).toEqual({ username: 'ana', secret: 'kanban-secret' });
    expect(eventTypes(s)).toContain('password_changed');

    // The salt the `host` row caches for offline unlock moved with the password (SP02 §6), so B2's
    // next sign-in does not read a reset — which would wipe the vault just kept above (SP02 §7).
    const host = s.repo.hostRecord();
    expect(host?.salt).toBe(request.newSalt);
    expect(host?.snapshot).toBe('{"api":1}'); // and the cached org catalog is still there (RF-37)
    expect(host?.version).toBe('v1');
  });

  test('a host refusal leaves the local verifier on the old password', async () => {
    const s = scene();
    await adoptConnected(s);
    const before = s.repo.personAuthByEmail(GUILD_EMAIL)?.password;

    expect(
      await messageOf(() =>
        s.session.changePassword(GUILD_PASSWORD, NEW_PASSWORD, async () => {
          throw new Error('the host refused the change');
        }),
      ),
    ).toBe('the host refused the change');

    expect(s.repo.personAuthByEmail(GUILD_EMAIL)?.password).toEqual(before);
    s.session.lock();
    expect((await s.session.unlock({ email: GUILD_EMAIL, password: GUILD_PASSWORD })).unlocked).toBe(true);
    expect(await messageOf(() => s.session.unlock({ email: GUILD_EMAIL, password: NEW_PASSWORD }))).toBe(
      'invalid credentials',
    );
  });

  test('a wrong current password and a short new password never reach the host', async () => {
    const s = scene();
    await adoptConnected(s);
    const requests: PasswordChangeRequest[] = [];
    const host = async (request: PasswordChangeRequest): Promise<void> => {
      requests.push(request);
    };

    expect(await messageOf(() => s.session.changePassword(WRONG_PASSWORD, NEW_PASSWORD, host))).toBe(
      'invalid credentials',
    );
    expect(await messageOf(() => s.session.changePassword(GUILD_PASSWORD, 'short', host))).toBe(
      'password must be at least 8 characters',
    );

    expect(requests).toEqual([]);
  });

  test('a v1 local account has no host password to change', async () => {
    const s = scene();
    await firstAccount(s);

    expect(await messageOf(() => s.session.changePassword(PASSWORD, NEW_PASSWORD, async () => {}))).toBe(
      'this account has no host password to change',
    );
    // Nothing changed locally either: the v1 row still verifies the old password.
    expect(s.repo.personAuthByEmail(EMAIL)?.password.algorithm).toBe('PBKDF2-SHA256');
  });

  test('without a host callback the local verifier is rewritten as V2 with a fresh salt', async () => {
    const s = scene();
    await firstAccount(s);
    const before = s.repo.personAuthByEmail(EMAIL)?.password;

    await s.session.changePassword(PASSWORD, NEW_PASSWORD);

    const stored = s.repo.personAuthByEmail(EMAIL)?.password as PasswordHashV2;
    expect(stored.algorithm).toBe('BOND-KDF-V1');
    expect(stored.salt).not.toBe(before?.salt);
    expect(stored.iterations).toBe(ITERATIONS);
    const newKeys = await deriveKeys(NEW_PASSWORD, fromBase64url(stored.salt), ITERATIONS);
    expect(stored.check).toBe(await passwordCheck(newKeys.localKey));
    expect(keysOf(s).authKey).toBe(toBase64url(newKeys.authKey));

    s.session.lock();
    expect((await s.session.unlock({ email: EMAIL, password: NEW_PASSWORD })).unlocked).toBe(true);
    expect(await messageOf(() => s.session.unlock({ email: EMAIL, password: PASSWORD }))).toBe(
      'invalid credentials',
    );
  });
});

describe('v1 migration to V2 (SP02 §6)', () => {
  test('the first unlock of a v1 account rewrites the row as V2 with a fresh salt', async () => {
    const s = scene();
    const person = s.repo.createPerson({
      email: EMAIL,
      name: 'Ana',
      password: await hashPassword(PASSWORD, ITERATIONS),
      roles: ['admin'],
    });
    const v1Salt = s.repo.personAuthByEmail(EMAIL)?.password.salt ?? '';

    const state = await s.session.unlock({ email: EMAIL, password: PASSWORD });

    expect(state.unlocked).toBe(true);
    expect(state.person?.id).toBe(person.id);
    const stored = s.repo.personAuthByEmail(EMAIL)?.password as PasswordHashV2;
    expect(stored.algorithm).toBe('BOND-KDF-V1');
    expect(stored.salt).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(stored.salt).not.toBe(v1Salt);
    expect(stored.iterations).toBe(ITERATIONS);
    // The keys of that salt are the ones the session keeps.
    const keys = await deriveKeys(PASSWORD, fromBase64url(stored.salt), ITERATIONS);
    expect(stored.check).toBe(await passwordCheck(keys.localKey));
    expect(keysOf(s).authKey).toBe(toBase64url(keys.authKey));

    // The v1 hash is gone: the row has nothing to verify with but the check.
    expect(s.db.all('SELECT password_hash, password_check, password_algorithm FROM person')).toEqual([
      { password_hash: '', password_check: stored.check, password_algorithm: 'BOND-KDF-V1' },
    ]);

    // It unlocks again with the same password, now through V2.
    s.session.lock();
    expect((await s.session.unlock({ email: EMAIL, password: PASSWORD })).unlocked).toBe(true);
    expect(await messageOf(() => s.session.unlock({ email: EMAIL, password: WRONG_PASSWORD }))).toBe(
      'invalid credentials',
    );
  });

  test('after the migration the check decides: the old hash no longer opens the row', async () => {
    const s = scene();
    s.repo.createPerson({
      email: EMAIL,
      name: 'Ana',
      password: await hashPassword(PASSWORD, ITERATIONS),
      roles: [],
    });
    await s.session.unlock({ email: EMAIL, password: PASSWORD });
    s.session.lock();

    // The v1 verifier is put back by hand, a valid PBKDF2 hash of the right password, and the check
    // is spoiled: the v1 path is dead, so the right password must not open the row any more.
    const v1 = await hashPassword(PASSWORD, ITERATIONS);
    s.db.run('UPDATE person SET password_hash = ? WHERE email = ?', [v1.hash, EMAIL]);
    s.db.run('UPDATE person SET password_check = ? WHERE email = ?', [
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      EMAIL,
    ]);

    expect(await messageOf(() => s.session.unlock({ email: EMAIL, password: PASSWORD }))).toBe(
      'invalid credentials',
    );
  });

  test('a failed unlock leaves a v1 row alone', async () => {
    const s = scene();
    s.repo.createPerson({
      email: EMAIL,
      name: 'Ana',
      password: await hashPassword(PASSWORD, ITERATIONS),
      roles: [],
    });
    const before = s.repo.personAuthByEmail(EMAIL)?.password;

    expect(await messageOf(() => s.session.unlock({ email: EMAIL, password: WRONG_PASSWORD }))).toBe(
      'invalid credentials',
    );

    expect(s.repo.personAuthByEmail(EMAIL)?.password).toEqual(before);
  });
});

describe('wipeVault (SP02 §7)', () => {
  test("removes one person's keychain items and index rows and leaves everybody else's", async () => {
    const s = scene();
    const ana = await firstAccount(s);
    await openInvite(s, 'bruno-code', ['team']);
    const bruno =
      (
        await s.session.createAccount({
          email: 'bruno@example.test',
          name: 'Bruno',
          password: PASSWORD,
          code: 'bruno-code',
        })
      ).person?.id ?? '';
    s.repo.saveEntry(tool('kanban'));
    s.repo.saveEntry(tool('figma'));
    const vault = createVault({ repo: s.repo, keychain: s.keychain, iterations: ITERATIONS });
    await vault.save(ana, { toolId: 'kanban', username: 'ana', secret: 'ana-secret' });
    await vault.save(bruno, { toolId: 'figma', username: 'bruno', secret: 'bruno-secret' });
    s.session.lock();

    // The reset of SP02 §7 needs no session: the salt changed before anyone could unlock.
    await s.session.wipeVault(ana);

    expect(s.repo.listVault(ana)).toEqual([]);
    expect(s.secrets.has(`nod.cred.${ana}.kanban`)).toBe(false);
    expect(s.repo.listVault(bruno)).toHaveLength(1);
    expect(s.secrets.has(`nod.cred.${bruno}.figma`)).toBe(true);
    expect(await vault.read(bruno, 'figma')).toEqual({ username: 'bruno', secret: 'bruno-secret' });
    // Nobody was locked out: a wipe is not a revocation.
    expect((await s.session.unlock({ email: EMAIL, password: PASSWORD })).unlocked).toBe(true);
  });
});

// ---------------------------------------------------------------- the Block 1 review fixes (F1, F2, F3, F7)

/** A host call of these tests: it counts the times it was reached and answers what it was given. */
function countedHost(answer: string | Error = 'opened') {
  const calls: number[] = [];
  return {
    calls,
    host: async (): Promise<string> => {
      calls.push(calls.length);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

/** The join of a Nod whose session is unlocked where it matters (F1/F3's own rules aside). */
function joinAs(
  s: SessionScene,
  host: () => Promise<string>,
  overrides: Partial<Parameters<Session['joinGate']>[0]> = {},
) {
  return s.session.joinGate({
    email: GUILD_EMAIL,
    adoptLocal: false,
    hostPinned: false,
    signIn: false,
    host,
    ...overrides,
  });
}

describe('the local half of a join: joinGate (F1, F3, F7)', () => {
  test('a first run joins with no session at all, and only then is the host asked', async () => {
    const s = scene();
    const checked = countedHost();

    const gate = await joinAs(s, checked.host);

    expect(gate).toEqual({ kind: 'join', local: null, answer: 'opened' });
    expect(checked.calls).toHaveLength(1);
  });

  test('a Nod that already has an account refuses a locked join before the host is asked (F3)', async () => {
    const s = scene();
    await firstAccount(s);
    s.session.lock();
    const checked = countedHost();

    // The refusal is the same for both handlers, and the host is not reached once: the answer is
    // about this machine's accounts, not about the guild's.
    for (const signIn of [false, true]) {
      expect(await messageOf(() => joinAs(s, checked.host, { signIn }))).toBe(
        'unlock this Nod first, then join the guild',
      );
    }
    expect(checked.calls).toHaveLength(0);

    // With a host row the session may stay locked: that is the signed-out sign-in F3 keeps working.
    const gate = await joinAs(s, checked.host, { signIn: true, hostPinned: true });
    expect(gate.kind).toBe('join');
    expect(checked.calls).toHaveLength(1);
  });

  test('a local account holding the join email answers the choice, and nothing is sent (F1)', async () => {
    const s = scene();
    const local = await firstAccount(s);
    const checked = countedHost();

    const answer = await joinAs(s, checked.host, { email: EMAIL });

    expect(answer).toEqual({ kind: 'choose', person: s.repo.personById(local) });
    expect(checked.calls).toHaveLength(0);

    // The decision the page sends back: the host is asked, and the local account is what the
    // adoption will take over.
    const decided = await joinAs(s, checked.host, { email: EMAIL, adoptLocal: true });
    expect(decided).toEqual({ kind: 'join', local: s.repo.personById(local), answer: 'opened' });
    expect(checked.calls).toHaveLength(1);
  });

  test('the email of another local account is refused, and its owner is the one to unlock it (F1)', async () => {
    const s = scene();
    await firstAccount(s);
    const other = s.repo.createPerson({
      email: GUILD_EMAIL,
      name: 'Ana',
      password: await hashPassword(PASSWORD, ITERATIONS),
      roles: [],
    });
    const checked = countedHost();

    expect(await messageOf(() => joinAs(s, checked.host, { adoptLocal: true }))).toBe(
      'this email belongs to another account of this Nod — unlock it, then join',
    );
    expect(checked.calls).toHaveLength(0);

    // Unlocked as that person, the very same join goes out with their account to adopt.
    s.session.lock();
    await s.session.unlock({ email: GUILD_EMAIL, password: PASSWORD });
    const gate = await joinAs(s, checked.host, { adoptLocal: true });
    expect(gate).toMatchObject({ kind: 'join', local: { id: other.id } });
    expect(checked.calls).toHaveLength(1);
  });

  test('a revoked local row with the join email is adopted by an unlocked session (F1)', async () => {
    const s = scene();
    await firstAccount(s);
    const gone = s.repo.createPerson({
      email: GUILD_EMAIL,
      name: 'Ana',
      password: await hashPassword(PASSWORD, ITERATIONS),
      roles: [],
    });
    s.repo.revokePerson(gone.id);
    const checked = countedHost();

    // Nothing of the live reads sees it, so the choice is what is answered — not a spent code.
    const answer = await joinAs(s, checked.host);
    expect(answer).toEqual({ kind: 'choose', person: s.repo.personByEmailAnyState(GUILD_EMAIL)?.person });
    expect(checked.calls).toHaveLength(0);

    const decided = await joinAs(s, checked.host, { adoptLocal: true });
    expect(decided).toMatchObject({ kind: 'join', local: { id: gone.id } });
    expect(checked.calls).toHaveLength(1);

    // A revoked row can never be unlocked, so the machine's owner is the one who decides — and
    // locked, there is nobody to decide and the join stops before the host.
    s.session.lock();
    expect(await messageOf(() => joinAs(s, checked.host, { adoptLocal: true }))).toBe(
      'unlock this Nod first, then join the guild',
    );
    expect(checked.calls).toHaveLength(1);
  });

  test('a 401 of the host is one sentence, and a sign-in pays the unlock backoff (F3, F7)', async () => {
    const s = scene();
    const refused = new HostError('signed-out', 'signed out', 401);
    const checked = countedHost(refused);

    for (let attempt = 1; attempt <= 5; attempt++) {
      expect(await messageOf(() => joinAs(s, checked.host, { signIn: true }))).toBe('invalid code or password');
    }
    expect(s.repo.meta('unlock_failures')).toBe('5');
    expect((await s.session.state()).waitMs).toBe(1000);

    // The counter is the one `unlock` pays (RF-23), and inside the wait the join does not even
    // reach the host.
    expect(await messageOf(() => s.session.unlock({ email: GUILD_EMAIL, password: GUILD_PASSWORD }))).toBe(
      'wait before trying again',
    );
    const reached = checked.calls.length;
    expect(await messageOf(() => joinAs(s, checked.host, { signIn: true }))).toBe('wait before trying again');
    expect(checked.calls).toHaveLength(reached);

    // Past the wait, a host that answers clears the failures.
    s.clock.advance(1000);
    const gate = await joinAs(s, countedHost().host, { signIn: true });
    expect(gate).toMatchObject({ kind: 'join', answer: 'opened' });
    expect(s.repo.meta('unlock_failures')).toBe('0');
    expect((await s.session.state()).waitMs).toBe(0);

    // Only the 401 is F7's sentence: a host that was not reached keeps its own words.
    const offline = new HostError('offline', 'could not reach the host');
    expect(await messageOf(() => joinAs(s, countedHost(offline).host, { signIn: true }))).toBe(
      'could not reach the host',
    );
    expect(s.repo.meta('unlock_failures')).toBe('0');
  });
});

describe('adopting a local account (F1)', () => {
  test('the account, its roles, its vault and its keychain items move to the host person', async () => {
    const s = scene();
    const local = await firstAccount(s);
    s.repo.saveEntry(tool('kanban'));
    s.repo.saveRole({ id: 'team', name: 'Team', admin: false });
    s.repo.setRoles(local, ['admin', 'team']);
    const vault = createVault({ repo: s.repo, keychain: s.keychain, iterations: ITERATIONS });
    await vault.save(local, { toolId: 'kanban', username: 'ana', secret: 'kanban-secret' });
    // An event of that person, recorded before the join: the audit is that person's own history.
    s.repo.addEvent({ personId: local, toolId: 'kanban', type: 'tool_opened', url: null, result: null, detail: null });
    expect(s.secrets.has(`nod.cred.${local}.kanban`)).toBe(true);

    const state = await s.session.adoptConnectedAccount({
      personId: HOST_PERSON_ID,
      email: EMAIL,
      name: 'Ana',
      password: PASSWORD,
      salt: HOST_SALT,
      iterations: ITERATIONS,
      admin: true,
      adoptLocalId: local,
    });

    // The row is the host's person now, and the roles survived it.
    expect(state.unlocked).toBe(true);
    expect(state.person?.id).toBe(HOST_PERSON_ID);
    expect(state.person?.roles).toEqual(['admin', 'team']);
    expect(s.repo.personById(local)).toBeNull();
    // The credential works under the new id: the index and the keychain item moved together.
    expect(s.secrets.has(`nod.cred.${local}.kanban`)).toBe(false);
    expect(s.secrets.has(`nod.cred.${HOST_PERSON_ID}.kanban`)).toBe(true);
    expect(s.repo.listVault(HOST_PERSON_ID).map((item) => item.keychainKey)).toEqual([
      `nod.cred.${HOST_PERSON_ID}.kanban`,
    ]);
    expect(await vault.read(HOST_PERSON_ID, 'kanban')).toEqual({ username: 'ana', secret: 'kanban-secret' });
    // The history moved with the person, and nothing stayed under the old id.
    const history = s.repo.listEvents({ personId: HOST_PERSON_ID }).map((event) => event.type);
    expect(history).toContain('account_created');
    expect(history).toContain('tool_opened');
    expect(history).toContain('unlocked');
    expect(s.repo.listEvents({ personId: local })).toEqual([]);
    // The verifier is the host's: the same password over the host salt opens the row offline.
    s.session.lock();
    expect((await s.session.unlock({ email: EMAIL, password: PASSWORD })).person?.id).toBe(HOST_PERSON_ID);
  });

  test('the roles of the adopted account survive, and the host decides the admin flag (F1)', async () => {
    const s = scene();
    const local = s.repo.createPerson({
      email: GUILD_EMAIL,
      name: 'Ana',
      password: await hashPassword(PASSWORD, ITERATIONS),
      roles: [],
    });
    s.repo.saveRole({ id: 'team', name: 'Team', admin: false });
    s.repo.setRoles(local.id, ['admin', 'team']);

    const state = await adoptConnected(s, { email: GUILD_EMAIL, adoptLocalId: local.id, admin: false });

    // The host says this person is not an admin: the flag goes, the other local role stays.
    expect(state.person?.roles).toEqual(['team']);
    expect(state.person?.admin).toBe(false);
  });

  test('the biometric item moves with the row (F1)', async () => {
    const s = scene({ biometricAvailable: true });
    const local = await firstAccount(s);
    await s.session.enableBiometric(PASSWORD);
    expect(s.secrets.has(`nod.bio.${local}`)).toBe(true);

    await adoptConnected(s, { email: EMAIL, adoptLocalId: local });

    expect(s.secrets.has(`nod.bio.${local}`)).toBe(false);
    expect(s.secrets.get(`nod.bio.${HOST_PERSON_ID}`)).toBe(HOST_PERSON_ID);
    // And it still opens this session, which is now the host person's.
    s.session.lock();
    expect((await s.session.unlockBiometric()).person?.id).toBe(HOST_PERSON_ID);
  });

  test('a revoked local row of the join email comes back as the host person (F1)', async () => {
    const s = scene();
    await firstAccount(s);
    const gone = s.repo.createPerson({
      email: GUILD_EMAIL,
      name: 'Ana',
      password: await hashPassword(PASSWORD, ITERATIONS),
      roles: [],
    });
    s.repo.saveEntry(tool('kanban'));
    s.repo.saveVaultItem({
      personId: gone.id,
      toolId: 'kanban',
      label: 'kanban',
      username: 'ana',
      keychainKey: `nod.cred.${gone.id}.kanban`,
      origin: 'https://kanban.example.test/app',
    });
    await s.keychain.set(`nod.cred.${gone.id}.kanban`, 'kanban-value');
    s.repo.revokePerson(gone.id);

    const state = await adoptConnected(s, { email: GUILD_EMAIL, adoptLocalId: gone.id });

    expect(state.person?.id).toBe(HOST_PERSON_ID);
    expect(s.repo.personById(HOST_PERSON_ID)).toMatchObject({ email: GUILD_EMAIL, name: 'Ana' });
    expect(s.secrets.has(`nod.cred.${gone.id}.kanban`)).toBe(false);
    expect(s.secrets.get(`nod.cred.${HOST_PERSON_ID}.kanban`)).toBe('kanban-value');
    expect(s.repo.listVault(HOST_PERSON_ID)).toHaveLength(1);
  });

  test('a host person this Nod already holds is refused, and nothing moved (F1)', async () => {
    const s = scene();
    const local = await firstAccount(s);
    const other = s.repo.createPerson({
      email: GUILD_EMAIL,
      name: 'Bia',
      password: await hashPassword(PASSWORD, ITERATIONS),
      roles: [],
    });

    expect(
      await messageOf(() => adoptConnected(s, { email: EMAIL, adoptLocalId: local, personId: other.id })),
    ).toBe('this Nod already holds an account of that guild person');

    // Both rows as they were: two people are not merged into one.
    expect(s.repo.personById(local)?.email).toBe(EMAIL);
    expect(s.repo.personById(other.id)?.email).toBe(GUILD_EMAIL);
    expect(s.session.current()?.id).toBe(local);
  });

  test('an email of this Nod that nothing adopts is still refused as registered (F1)', async () => {
    const s = scene();
    await firstAccount(s);
    s.session.lock();

    expect(await messageOf(() => adoptConnected(s, { email: EMAIL }))).toBe('email already registered');

    // A revoked row of that email, with nothing adopting it, is the same clear refusal — never the
    // raw `UNIQUE constraint failed` the email column would answer.
    const gone = s.repo.createPerson({
      email: GUILD_EMAIL,
      name: 'Ana',
      password: await hashPassword(PASSWORD, ITERATIONS),
      roles: [],
    });
    s.repo.revokePerson(gone.id);
    expect(await messageOf(() => adoptConnected(s, { email: GUILD_EMAIL }))).toBe('email already registered');
    expect(s.repo.countPeople()).toBe(2);
  });

  test('a keychain that refuses the new key leaves the old item where it is (F1)', async () => {
    const s = scene();
    const local = await firstAccount(s);
    s.repo.saveEntry(tool('kanban'));
    s.repo.saveVaultItem({
      personId: local,
      toolId: 'kanban',
      label: 'kanban',
      username: 'ana',
      keychainKey: `nod.cred.${local}.kanban`,
      origin: 'https://kanban.example.test/app',
    });
    await s.keychain.set(`nod.cred.${local}.kanban`, 'kanban-value');
    const real = s.keychain;
    // The read goes through; the write of the new key is what a full keychain would refuse.
    const refusing: SecretStore = {
      get: (key) => real.get(key),
      set: async (key, value) => (key === `nod.cred.${HOST_PERSON_ID}.kanban` ? false : real.set(key, value)),
      delete: (key) => real.delete(key),
    };
    const session = createSession({
      repo: s.repo,
      keychain: refusing,
      store: memoryStore().store,
      authenticate: async () => true,
      biometricAvailable: false,
      iterations: ITERATIONS,
      now: s.clock.now,
    });

    expect(
      await messageOf(() =>
        session.adoptConnectedAccount({
          personId: HOST_PERSON_ID,
          email: EMAIL,
          name: 'Ana',
          password: PASSWORD,
          salt: HOST_SALT,
          iterations: ITERATIONS,
          admin: true,
          adoptLocalId: local,
        }),
      ),
    ).toBe('the system keychain refused to move the credential of kanban');

    // The report is what the person sees; the value itself is not lost — it is still under the key it
    // was written with, and the index row moved with the id.
    expect(s.secrets.get(`nod.cred.${local}.kanban`)).toBe('kanban-value');
    expect(s.repo.personById(local)).toBeNull();
    expect(s.repo.listVault(HOST_PERSON_ID).map((item) => item.keychainKey)).toEqual([
      `nod.cred.${HOST_PERSON_ID}.kanban`,
    ]);
  });
});

describe('reconcileConnectedIdentity (F2)', () => {
  test('the name and the admin flag of the unlocked person follow the snapshot', async () => {
    const s = scene();
    // An access-code activation: the host creates the person and the local row starts with no admin.
    await adoptConnected(s, { admin: false });
    expect(s.session.current()?.admin).toBe(false);

    expect(s.session.reconcileConnectedIdentity({ id: HOST_PERSON_ID, name: 'Ana Silva', admin: true })).toBe(true);
    expect(s.session.current()).toMatchObject({ id: HOST_PERSON_ID, name: 'Ana Silva', admin: true });

    // The same snapshot again is nothing to push.
    expect(s.session.reconcileConnectedIdentity({ id: HOST_PERSON_ID, name: 'Ana Silva', admin: true })).toBe(false);

    // Demoted on the host: the admin screens leave with the next snapshot.
    expect(s.session.reconcileConnectedIdentity({ id: HOST_PERSON_ID, name: 'Ana Silva', admin: false })).toBe(true);
    expect(s.session.current()?.admin).toBe(false);
    expect(s.repo.personById(HOST_PERSON_ID)?.roles).toEqual([]);

    // The snapshot of somebody else is nobody's to write here.
    expect(s.session.reconcileConnectedIdentity({ id: 'another-person', name: 'Other', admin: true })).toBe(false);
    expect(s.repo.countPeople()).toBe(1);
  });

  test('a locked session reconciles nothing', async () => {
    const s = scene();
    await adoptConnected(s, { admin: false });
    s.session.lock();

    expect(s.session.reconcileConnectedIdentity({ id: HOST_PERSON_ID, name: 'Ana Silva', admin: true })).toBe(false);
    expect(s.repo.personById(HOST_PERSON_ID)?.name).toBe('Ana');
    expect(s.repo.personById(HOST_PERSON_ID)?.admin).toBe(false);
  });
});
