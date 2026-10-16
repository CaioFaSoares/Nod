// Local session (`backend/session.ts`) against in-memory SQLite, in-memory keychain and `store`, a
// fixed clock and PBKDF2 with 1000 iterations. Proves this slice's acceptance criteria: account and
// invite, unlock with backoff and a single error, password change, refresh, biometrics and lock.
import { describe, expect, test } from 'bun:test';

import { createRepo } from '../backend/repo';
import { createSession } from '../backend/session';
import { createVault } from '../backend/vault';
import { hashInviteCode, hashPassword } from '../shared/auth';
import { memorySqlite } from './helpers/sqlite-bun';
import type { Repo } from '../backend/repo';
import type { Session } from '../backend/session';
import type { Entry, SecretStore } from '../shared/types';

// PBKDF2 with 600 000 iterations costs hundreds of ms per derivation; the tests use 1000 (§3).
const ITERATIONS = 1000;
const PASSWORD = 'bond-password';
const NEW_PASSWORD = 'bond-password-new';
const WRONG_PASSWORD = 'bond-password-wrong';
const EMAIL = 'ana@example.test';
const NOW = '2026-10-15T12:00:00.000Z';
const EXPIRES = '2026-11-01T00:00:00.000Z';

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
  const repo = createRepo(memorySqlite());
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
    expect(s.secrets.has(`bond.bio.${id}`)).toBe(false);

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
    expect(s.secrets.get(`bond.bio.${id}`)).toBe(id);
    expect(s.saved.get('last_person')).toBe(id);

    const locked = s.session.lock();
    expect(locked.unlocked).toBe(false);
    expect(locked.biometric).toBe(true);

    const state = await s.session.unlockBiometric();
    expect(s.reasons).toEqual(['Unlock Bond']);
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
    expect(s.secrets.get(`bond.bio.${id}`)).toBe(id);
  });

  test('without a key in the keychain or with a revoked person, biometrics opens nothing', async () => {
    const s = scene({ biometricAvailable: true });
    const id = await firstAccount(s);
    s.session.lock();

    // Never enabled: `last_person` exists, the `bond.bio.<person>` key does not.
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
