// Local session of Bond — docs/arquitetura.md §4; concepts in docs/canonico.md §9 and §11.
//
// Nothing here imports `tjs` or `tiny`: repository, keychain, `store` and authenticator come in
// through `deps`, which keeps this slice testable with `bun test`. A secret never reaches an event,
// `store`, log or file: the database holds only a verifier — the v1 PBKDF2 `PasswordHash` or the V2
// `check` of SP02 §6 — and the keychain holds only `bond.bio.<person>`. The keys of an unlock live
// in this module's memory and `lock()` forgets them (SP02 §6).
import {
  PBKDF2_ITERATIONS,
  PASSWORD_V2_ALGORITHM,
  deriveKeys,
  hashInviteCode,
  hashPassword,
  passwordCheck,
  passwordCheckMatches,
  randomSalt,
  unlockWait,
  validateNewPassword,
  verifyPassword,
  verifyStoredPassword,
} from '../shared/auth';
import { fromBase64url, toBase64url } from '../shared/encoding';
import type { DerivedKeys, PasswordHashV2 } from '../shared/auth';
import type { PasswordChangeRequest } from '../shared/host-api';
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
/** A connected change needs the row's `authKey` (SP02 §7): a v1 row has none to send. */
const NOT_CONNECTED = 'this account has no host password to change';

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
  /**
   * Adopts the account of a host (SP02 §6, SP05 §2): creates — or updates in place — the local
   * person whose id is the host person id, writes the V2 verifier over the **host** salt and leaves
   * the session unlocked with the keys of that salt. B2 calls it from `host.activate` / `host.signIn`
   * once the host answered, and calls `wipeVault(id)` first when the salt changed (SP02 §7).
   */
  adoptConnectedAccount(p: {
    personId: Id;
    email: string;
    name: string;
    password: string;
    /** base64url of the host salt (SP02 §4); it is what the row caches for offline unlock. */
    salt: string;
    iterations: number;
    admin: boolean;
  }): Promise<SessionState>;
  unlock(p: { email: string; password: string }): Promise<SessionState>;
  unlockBiometric(): Promise<SessionState>;
  enableBiometric(password: string): Promise<SessionState>;
  /** The keys of the unlocked session (SP02 §6); `null` while locked. */
  keys(): { authKey: Uint8Array; vaultKey: Uint8Array } | null;
  /**
   * SP02 §1 over a base64url salt: the derivation behind activation and sign-in. Pure — no state is
   * read or written, so B2 can call it before there is any session.
   */
  deriveFor(
    password: string,
    salt: string,
    iterations: number,
  ): Promise<{ authKey: Uint8Array; vaultKey: Uint8Array; localKey: Uint8Array }>;
  /**
   * SP02 §7. With `host` (a connected account) the current keys are derived over the current salt
   * and the new ones over a fresh salt; the host is called **first**, so a refusal leaves the local
   * verifier untouched. Without it the local V2 verifier is rewritten. The OS keychain is never
   * touched (RF-24).
   */
  changePassword(
    current: string,
    next: string,
    host?: (request: PasswordChangeRequest) => Promise<void>,
  ): Promise<void>;
  /** SP02 §7: every `bond.cred.<person>.*` item of the keychain and the index rows of that person. */
  wipeVault(personId: Id): Promise<void>;
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
  // The keys of the unlocked session (SP02 §6): `lock()` forgets them, and nothing else writes them.
  let currentKeys: DerivedKeys | null = null;
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

  // ---------------------------------------------------------------- keys and verifiers (SP02 §6)

  /** SP02 §1 over the base64url salt of the wire and of the row: the one entry to `deriveKeys`. */
  async function deriveFor(
    password: string,
    salt: string,
    iterationCount: number,
  ): Promise<DerivedKeys> {
    return deriveKeys(password, fromBase64url(salt), iterationCount);
  }

  /**
   * The V2 record of SP02 §6 over keys that were just derived: the caller already paid the one
   * PBKDF2, and re-deriving them here would pay a second one for the same bytes.
   */
  async function passwordHashV2(
    salt: string,
    iterationCount: number,
    keys: DerivedKeys,
  ): Promise<PasswordHashV2> {
    return {
      algorithm: PASSWORD_V2_ALGORITHM,
      salt,
      iterations: iterationCount,
      check: await passwordCheck(keys.localKey),
    };
  }

  /**
   * The keys of a V2 verifier when the password matches it (SP02 §6), `null` when it does not: one
   * derivation that both verifies the password and hands the session what it keeps.
   */
  async function keysOfV2(password: string, h: PasswordHashV2): Promise<DerivedKeys | null> {
    const keys = await deriveFor(password, h.salt, h.iterations);
    return (await passwordCheckMatches(keys.localKey, h.check)) ? keys : null;
  }

  /**
   * SP02 §6: the keys of the unlocked session. `null` while locked — and after a biometric unlock,
   * which has no password to derive from (SP02 §9 leaves `vaultKey` to the biometric item).
   */
  function keys(): { authKey: Uint8Array; vaultKey: Uint8Array } | null {
    if (currentKeys === null) return null;
    return { authKey: currentKeys.authKey, vaultKey: currentKeys.vaultKey };
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
    // A v1 row: nothing was derived, so there is nothing to keep (SP02 §6 — the keys arrive at the
    // first unlock, which is what migrates the row to V2).
    currentKeys = null;
    return state();
  }

  // ---------------------------------------------------------------- unlock

  async function unlock(p: { email: string; password: string }): Promise<SessionState> {
    if (waitMs() > 0) throw new Error(WAIT_BEFORE_RETRY);

    const found = deps.repo.personAuthByEmail(p.email.trim().toLowerCase());

    // A missing email derives against `fakePassword`: same cost as a real verify, so the response
    // does not tell "does not exist" from "wrong password".
    let matches: boolean;
    let keys: DerivedKeys | null = null;
    if (found === null) {
      matches = await verifyPassword(p.password, fakePassword);
    } else if (found.password.algorithm === PASSWORD_V2_ALGORITHM) {
      // SP02 §6: the salt cached in the row — the host salt when connected — is all an offline
      // unlock needs, and that one derivation is what leaves the keys in memory.
      keys = await keysOfV2(p.password, found.password);
      matches = keys !== null;
    } else {
      matches = await verifyPassword(p.password, found.password);
    }
    if (found === null || !matches) {
      registerFailure();
      // No person and no detail: the event gives a brute force attempt nothing.
      record('unlock_failed', null);
      throw new Error(INVALID_CREDENTIALS);
    }

    // SP02 §6 migration: a v1 account — one written before this format; a connected account is
    // created with V2 at activation — is verified against the old PBKDF2 hash once and rewritten as
    // V2 with a fresh salt, whose keys are the ones the session keeps.
    if (found.password.algorithm !== PASSWORD_V2_ALGORITHM) {
      const salt = randomSalt();
      keys = await deriveFor(p.password, salt, iterations);
      deps.repo.savePasswordCheck(found.person.id, await passwordHashV2(salt, iterations, keys));
    }

    deps.repo.setMeta(META_FAILURES, '0');
    record('unlocked', found.person.id, 'password');
    await deps.store.set(LAST_PERSON_KEY, found.person.id);
    current = found.person;
    currentKeys = keys;
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
    // No password was typed: there is nothing to derive from (SP02 §9 puts `vaultKey` in the
    // biometric item, which is story V1's).
    currentKeys = null;
    return state();
  }

  async function enableBiometric(password: string): Promise<SessionState> {
    const person = requireUnlocked();
    const found = deps.repo.personAuthByEmail(person.email);
    // `person` came from the repository: `found` is null only if it was revoked during this session.
    if (found === null || !(await verifyStoredPassword(password, found.password))) {
      throw new Error(INVALID_CREDENTIALS);
    }
    if (!deps.biometricAvailable) throw new Error(NO_BIOMETRICS);

    await deps.keychain.set(biometricKey(person.id), person.id);
    await deps.store.set(LAST_PERSON_KEY, person.id);
    return state();
  }

  // ---------------------------------------------------------------- connected account (SP02 §6)

  /**
   * SP05 §2: the local person of a connected account is created at activation with the host person
   * id as its id, and SP02 §6 gives it the V2 verifier over the host salt — the same keys the host
   * has, so unlocking works offline afterwards. Being adopted means a host just accepted the
   * password, so the session starts unlocked.
   */
  async function adoptConnectedAccount(p: {
    personId: Id;
    email: string;
    name: string;
    password: string;
    salt: string;
    iterations: number;
    admin: boolean;
  }): Promise<SessionState> {
    const email = p.email.trim().toLowerCase();
    if (!email.includes('@')) throw new Error(INVALID_EMAIL);
    const name = p.name.trim();
    if (name.length === 0) throw new Error(NAME_REQUIRED);
    const problem = validateNewPassword(p.password);
    if (problem !== null) throw new Error(problem);
    const taken = deps.repo.personByEmail(email);
    if (taken !== null && taken.person.id !== p.personId) throw new Error(EMAIL_TAKEN);

    const keys = await deriveFor(p.password, p.salt, p.iterations);
    // `admin` is the host's flag; the local row carries it through the admin role, which is what
    // `Person.admin` derives from. A non-admin gets no local role: while connected, roles and grants
    // come from the snapshot (SP05 §2), not from `role` / `person_role`.
    const roles = p.admin ? [deps.repo.ensureAdminRole().id] : [];
    const isNew = deps.repo.personById(p.personId) === null;
    const person = deps.repo.saveConnectedPerson({
      id: p.personId,
      email,
      name,
      roles,
      password: await passwordHashV2(p.salt, p.iterations, keys),
    });

    record(isNew ? 'account_created' : 'unlocked', person.id);
    await deps.store.set(LAST_PERSON_KEY, person.id);
    current = person;
    currentKeys = keys;
    return state();
  }

  // ---------------------------------------------------------------- password, lock and refresh

  async function changePassword(
    currentPassword: string,
    next: string,
    host?: (request: PasswordChangeRequest) => Promise<void>,
  ): Promise<void> {
    const person = requireUnlocked();
    const found = deps.repo.personAuthByEmail(person.email);
    if (found === null) throw new Error(INVALID_CREDENTIALS);

    // One derivation of the current password: for a V2 row it verifies the check and hands back the
    // `authKey` the host has (SP02 §7) — the password itself never goes anywhere (RF-42).
    let oldKeys: DerivedKeys | null = null;
    let matches: boolean;
    if (found.password.algorithm === PASSWORD_V2_ALGORITHM) {
      oldKeys = await keysOfV2(currentPassword, found.password);
      matches = oldKeys !== null;
    } else {
      matches = await verifyPassword(currentPassword, found.password);
    }
    if (!matches) throw new Error(INVALID_CREDENTIALS);

    const problem = validateNewPassword(next);
    if (problem !== null) throw new Error(problem);
    // A connected change sends the current and the new `authKey`; a v1 row has neither — it was
    // never derived from a host salt, so it has no host password to change.
    if (host !== undefined && oldKeys === null) throw new Error(NOT_CONNECTED);

    const salt = randomSalt();
    const newKeys = await deriveFor(next, salt, iterations);
    if (host !== undefined && oldKeys !== null) {
      // The host first (SP02 §7): a refusal leaves the local verifier on the old password, and the
      // person can still unlock and try again.
      await host({
        currentAuthKey: toBase64url(oldKeys.authKey),
        newSalt: salt,
        newAuthKey: toBase64url(newKeys.authKey),
      });
    }
    // Then the row. The OS keychain stays untouched: the items are the vault's and the autofill
    // keeps working (RF-24); re-encrypting them with the new `vaultKey` is story V1's.
    deps.repo.savePasswordCheck(person.id, await passwordHashV2(salt, iterations, newKeys));
    if (host !== undefined) {
      // The salt the `host` row caches for offline unlock (SP02 §6) is the host's, and the host just
      // moved it: a cache left on the old salt makes the next sign-in read a reset and wipe the
      // vault (SP02 §7, RF-43).
      deps.repo.saveHostSalt(salt);
    }
    currentKeys = newKeys;
    record('password_changed', person.id);
  }

  /**
   * SP02 §7: the vault of one person is wiped — the index rows and every keychain item they point
   * at. The caller runs it when a sign-in finds a salt different from the cached one, before
   * `adoptConnectedAccount`. A `bond.cred.*` item the index does not know cannot be reached:
   * `SecretStore` has no enumeration.
   */
  async function wipeVault(personId: Id): Promise<void> {
    const removed = deps.repo.removeVaultOf(personId);
    for (const item of removed) await deps.keychain.delete(item.keychainKey);
  }

  function lock(): SessionState {
    const id = current === null ? null : current.id;
    current = null;
    currentKeys = null;
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
      currentKeys = null;
      return;
    }
    current = reloaded;
  }

  return {
    state,
    createAccount,
    adoptConnectedAccount,
    unlock,
    unlockBiometric,
    enableBiometric,
    keys,
    deriveFor,
    changePassword,
    wipeVault,
    lock,
    current: currentPerson,
    refresh,
  };
}
