// Local session of Bond — docs/arquitetura.md §4; concepts in docs/canonico.md §9 and §11.
//
// Nothing here imports `tjs` or `tiny`: repository, keychain, `store` and authenticator come in
// through `deps`, which keeps this slice testable with `bun test`. A secret never reaches an event,
// `store`, log or file: the database holds only the `PasswordHash` (PBKDF2) and the keychain holds
// only `bond.bio.<person>`.
import {
  PBKDF2_ITERATIONS,
  hashInviteCode,
  hashPassword,
  unlockWait,
  validateNewPassword,
  verifyPassword,
} from '../shared/auth';
import type { EventType, Id, PasswordHash, Person, SecretStore, SessionState } from '../shared/types';
import type { Repo } from './repo';

/** Last person used: only the id; it drives biometrics and the pre-filled sign-in screen. */
const LAST_PERSON_KEY = 'last_person';
/** Unlock backoff, persisted in `meta` (RF-23). */
const META_FAILURES = 'unlock_failures';
const META_LAST_FAILURE = 'unlock_last_failure';
/** Prefix of the OS keychain key that marks a person's biometrics as enabled. */
const BIOMETRIC_PREFIX = 'bond.bio.';
/** Reason shown by the operating system in the biometric dialog (`app.authenticate`). */
const BIOMETRIC_REASON = 'Unlock Bond';

const INVALID_EMAIL = 'enter a valid email';
const NAME_REQUIRED = 'name is required';
const INVALID_INVITE = 'invalid invite';
const EMAIL_TAKEN = 'email already registered';
const INVALID_CREDENTIALS = 'invalid credentials';
const WAIT_BEFORE_RETRY = 'wait before trying again';
const SESSION_LOCKED = 'session is locked';
const NO_BIOMETRICS = 'biometrics are not available on this system';
const BIOMETRICS_DECLINED = 'biometrics were declined';
const BIOMETRICS_DISABLED = 'biometrics are not enabled';

// Fixed hash a single derivation is spent against when the email does not exist. Without it the
// response time would tell which emails have an account — an existence oracle. Salt of 16 zero
// bytes and hash of 32 zero bytes (base64), with the iterations of `deps` so it costs the same as a
// real verify. Not a secret: a derivation target that never matches any password.
const FAKE_PASSWORD: PasswordHash = {
  algorithm: 'PBKDF2-SHA256',
  hash: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  salt: 'AAAAAAAAAAAAAAAAAAAAAA==',
  iterations: PBKDF2_ITERATIONS,
};

export interface SessionDeps {
  repo: Repo;
  keychain: SecretStore;
  /** Runtime `store`: persistent across runs. Here only `last_person`. */
  store: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<boolean>;
  };
  /** `app.authenticate` at runtime; a double in the tests. */
  authenticate: (reason: string) => Promise<boolean>;
  biometricAvailable: boolean;
  /** PBKDF2 iterations (§3). The tests pass 1000; the default is the runtime one. */
  iterations?: number;
  /** Injectable clock (backoff and invite validity in the tests). Default: `new Date()`. */
  now?: () => Date;
}

/** What `createSession` returns (§4). Declared apart so the contract has a name of its own. */
export interface Session {
  /** `SessionState` is synchronous logic against the repository plus one keychain read. */
  state(): Promise<SessionState>;
  createAccount(p: { email: string; name: string; password: string; code?: string }): Promise<SessionState>;
  unlock(p: { email: string; password: string }): Promise<SessionState>;
  unlockBiometric(): Promise<SessionState>;
  enableBiometric(password: string): Promise<SessionState>;
  changePassword(current: string, next: string): Promise<void>;
  lock(): SessionState;
  current(): Person | null;
  refresh(): void;
}

/**
 * Local session (§4): account, invite, unlock with backoff, biometrics and password change. The
 * unlocked person lives only in this memory — `lock()` forgets it.
 */
export function createSession(deps: SessionDeps): Session {
  const iterations = deps.iterations ?? PBKDF2_ITERATIONS;
  const fakePassword: PasswordHash = { ...FAKE_PASSWORD, iterations };

  let current: Person | null = null;
  // `lock()` is synchronous (§4) and the keychain is asynchronous: the `biometric` field of the
  // state it returns comes from this last read. `state()` (called on unlock, on account creation
  // and by `bond.info`) and `enableBiometric` are what refresh it.
  let knownBiometric = false;

  function now(): Date {
    return deps.now === undefined ? new Date() : deps.now();
  }

  function record(type: EventType, personId: Id | null, result: string | null = null): void {
    deps.repo.addEvent({
      personId,
      toolId: null,
      type,
      url: null,
      result,
      detail: null,
    });
  }

  // ---------------------------------------------------------------- biometrics and wait

  function biometricKey(personId: Id): string {
    return `${BIOMETRIC_PREFIX}${personId}`;
  }

  async function lastPerson(): Promise<Id | null> {
    const raw = await deps.store.get(LAST_PERSON_KEY);
    return typeof raw === 'string' && raw.length > 0 ? raw : null;
  }

  async function hasBiometrics(personId: Id): Promise<boolean> {
    if (!deps.biometricAvailable) return false;
    return (await deps.keychain.get(biometricKey(personId))) !== null;
  }

  function failures(): number {
    const raw = deps.repo.meta(META_FAILURES);
    if (raw === null) return 0;
    const count = Number.parseInt(raw, 10);
    return Number.isNaN(count) || count < 0 ? 0 : count;
  }

  /** Remaining wait in ms: the wait of the failure count minus the time already elapsed. */
  function waitMs(): number {
    const wait = unlockWait(failures());
    if (wait === 0) return 0;
    const last = deps.repo.meta(META_LAST_FAILURE);
    if (last === null) return wait;
    const elapsed = now().getTime() - new Date(last).getTime();
    if (Number.isNaN(elapsed)) return wait;
    return Math.max(0, wait - elapsed);
  }

  function registerFailure(): void {
    deps.repo.setMeta(META_FAILURES, String(failures() + 1));
    deps.repo.setMeta(META_LAST_FAILURE, now().toISOString());
  }

  function requireUnlocked(): Person {
    if (current === null) throw new Error(SESSION_LOCKED);
    return current;
  }

  // ---------------------------------------------------------------- state

  /** An unused invite already demands the code, so not even the first account is an administrator. */
  function hasOpenInvite(): boolean {
    return deps.repo.listInvites().some((invite) => invite.usedAt === null);
  }

  /** State without the keychain part: both paths that return a `SessionState` go through here. */
  function localState(unlockedAs: Person | null, biometric: boolean): SessionState {
    const total = deps.repo.countPeople();
    return {
      // Revoked people included (P6): one of them already means the machine is not new.
      hasAccount: total > 0,
      requiresInvite: total > 0 || hasOpenInvite(),
      unlocked: unlockedAs !== null,
      person: unlockedAs,
      biometric,
      waitMs: waitMs(),
    };
  }

  async function state(): Promise<SessionState> {
    const last = await lastPerson();
    knownBiometric = last !== null && (await hasBiometrics(last));
    return localState(current, knownBiometric);
  }

  // ---------------------------------------------------------------- account

  async function createAccount(p: {
    email: string;
    name: string;
    password: string;
    code?: string;
  }): Promise<SessionState> {
    const email = p.email.trim().toLowerCase();
    if (!email.includes('@')) throw new Error(INVALID_EMAIL);
    const name = p.name.trim();
    if (name.length === 0) throw new Error(NAME_REQUIRED);
    const problem = validateNewPassword(p.password);
    if (problem !== null) throw new Error(problem);

    // The first account is the administrator's own machine only when nobody exists yet — revoked
    // included — and the seed brought no open invite (canonico §9, P6).
    const firstAccount = deps.repo.countPeople() === 0 && !hasOpenInvite();

    let inviteCodeHash: string | null = null;
    if (!firstAccount) {
      const code = (p.code ?? '').trim();
      if (code.length === 0) throw new Error(INVALID_INVITE);
      // Uniqueness comes before anything irreversible: a refused attempt never spends the invite.
      if (deps.repo.personByEmail(email) !== null) throw new Error(EMAIL_TAKEN);
      inviteCodeHash = await hashInviteCode(code);
      if (deps.repo.activeInvite(inviteCodeHash, now()) === null) throw new Error(INVALID_INVITE);
    }

    const password = await hashPassword(p.password, iterations);
    // The invite is consumed inside `createPersonWithInvite`, in the same transaction that inserts
    // the person (D7): `null` means the code was used up or expired between the two calls.
    const created =
      inviteCodeHash === null
        ? deps.repo.createPerson({
            email,
            name,
            password,
            roles: [deps.repo.ensureAdminRole().id],
          })
        : deps.repo.createPersonWithInvite({ email, name, password }, inviteCodeHash, now());
    if (created === null) throw new Error(INVALID_INVITE);

    record('account_created', created.id);
    await deps.store.set(LAST_PERSON_KEY, created.id);
    current = created;
    return state();
  }

  // ---------------------------------------------------------------- unlock

  async function unlock(p: { email: string; password: string }): Promise<SessionState> {
    if (waitMs() > 0) throw new Error(WAIT_BEFORE_RETRY);

    const found = deps.repo.personByEmail(p.email.trim().toLowerCase());
    // A missing email derives against `fakePassword`: same cost as a real verify, so the response
    // does not tell "does not exist" from "wrong password".
    const matches = await verifyPassword(p.password, found === null ? fakePassword : found.password);
    if (found === null || !matches) {
      registerFailure();
      // No person and no detail: the event gives a brute force attempt nothing.
      record('unlock_failed', null);
      throw new Error(INVALID_CREDENTIALS);
    }

    deps.repo.setMeta(META_FAILURES, '0');
    record('unlocked', found.person.id, 'password');
    await deps.store.set(LAST_PERSON_KEY, found.person.id);
    current = found.person;
    return state();
  }

  async function unlockBiometric(): Promise<SessionState> {
    if (!deps.biometricAvailable) throw new Error(NO_BIOMETRICS);

    const last = await lastPerson();
    if (!(await deps.authenticate(BIOMETRIC_REASON))) throw new Error(BIOMETRICS_DECLINED);

    const key = last === null ? null : await deps.keychain.get(biometricKey(last));
    const found = last === null ? null : deps.repo.personById(last);
    if (key !== last || found === null) throw new Error(BIOMETRICS_DISABLED);

    record('unlocked', found.id, 'biometric');
    current = found;
    return state();
  }

  async function enableBiometric(password: string): Promise<SessionState> {
    const person = requireUnlocked();
    const found = deps.repo.personByEmail(person.email);
    // `person` came from the repository: `found` is null only if it was revoked during this session.
    if (found === null || !(await verifyPassword(password, found.password))) {
      throw new Error(INVALID_CREDENTIALS);
    }
    if (!deps.biometricAvailable) throw new Error(NO_BIOMETRICS);

    await deps.keychain.set(biometricKey(person.id), person.id);
    await deps.store.set(LAST_PERSON_KEY, person.id);
    return state();
  }

  // ---------------------------------------------------------------- password, lock and refresh

  async function changePassword(currentPassword: string, next: string): Promise<void> {
    const person = requireUnlocked();
    const found = deps.repo.personByEmail(person.email);
    if (found === null || !(await verifyPassword(currentPassword, found.password))) {
      throw new Error(INVALID_CREDENTIALS);
    }
    const problem = validateNewPassword(next);
    if (problem !== null) throw new Error(problem);

    // Nothing else depends on the old password: the OS keychain stays untouched (RF-24).
    deps.repo.changePassword(person.id, await hashPassword(next, iterations));
    record('password_changed', person.id);
  }

  function lock(): SessionState {
    const id = current === null ? null : current.id;
    current = null;
    if (id !== null) record('locked', id);
    return localState(null, knownBiometric);
  }

  function currentPerson(): Person | null {
    return current;
  }

  /** Reloads the current person from the repository (roles changed — A23); locks if revoked. */
  function refresh(): void {
    const person = current;
    if (person === null) return;
    const reloaded = deps.repo.personById(person.id);
    if (reloaded === null) {
      record('locked', person.id);
      current = null;
      return;
    }
    current = reloaded;
  }

  return {
    state,
    createAccount,
    unlock,
    unlockBiometric,
    enableBiometric,
    changePassword,
    lock,
    current: currentPerson,
    refresh,
  };
}
