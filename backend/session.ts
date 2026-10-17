// Local session of Nod — docs/arquitetura.md §4; concepts in docs/canonico.md §9 and §11.
//
// Nothing here imports `tjs` or `tiny`: repository, keychain, `store` and authenticator come in
// through `deps`, which keeps this slice testable with `bun test`. A secret never reaches an event,
// `store`, log or file: the database holds only a verifier — the v1 PBKDF2 `PasswordHash` or the V2
// `check` of SP02 §6 — and the keychain holds `nod.bio.<person>` with `base64url(vaultKey)`
// (SP02 §9). The keys of an unlock live in this module's memory and `lock()` forgets them (SP02 §6).
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
} from '../shared/auth';
import { fromBase64url, toBase64url } from '../shared/encoding';
import {
  decodeVaultKey,
  decryptVaultValue,
  encryptVaultValue,
  isSealedVaultValue,
  plainVaultCredential,
} from '../shared/vault-crypto';
import { HostError } from './host-client';
import { keysKey } from './keys';
import { reencryptVaultItems } from './vault';
import type { DerivedKeys, PasswordHashV2 } from '../shared/auth';
import type { PasswordChangeRequest } from '../shared/host-api';
import type { EventType, Id, PasswordHash, Person, SecretStore, SessionState, VaultItem } from '../shared/types';
import type { Repo } from './repo';

/** Last person used: only the id; it drives biometrics and the pre-filled sign-in screen. */
const LAST_PERSON_KEY = 'last_person';
/**
 * SP02 §9/V1: the person whose biometric item was dropped because it held the old marker (the
 * person id) instead of a `vaultKey`. The next password unlock writes the item again from the key
 * it derived, without asking the person to enable biometrics a second time.
 */
const BIOMETRIC_PENDING_KEY = 'biometric_pending';
/** Unlock backoff, persisted in `meta` (RF-23). */
const META_FAILURES = 'unlock_failures';
const META_LAST_FAILURE = 'unlock_last_failure';
/** Prefix of the OS keychain key that marks a person's biometrics as enabled. */
const BIOMETRIC_PREFIX = 'nod.bio.';
/** Reason shown by the operating system in the biometric dialog (`app.authenticate`). */
const BIOMETRIC_REASON = 'Unlock Nod';

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
/** A biometric item from before V1 holds the person id, not the key: one password unlock rewrites it. */
const BIOMETRICS_NEED_PASSWORD = 'unlock with your password once to update biometrics';
/** SP02 §9: the keychain refusing the item of the unlock gate. */
const BIOMETRIC_REFUSED = 'the system keychain refused the biometric item';
/** A connected change needs the row's `authKey` (SP02 §7): a v1 row has none to send. */
const NOT_CONNECTED = 'this account has no host password to change';
/**
 * F3: a Nod that already has an account is not connected to a guild from the lock screen — the
 * person who holds this machine's keychain decides what happens to its accounts.
 */
const JOIN_NEEDS_UNLOCK = 'unlock this Nod first, then join the guild';
/** F1: the join's email is an account of this Nod, and not the one the session was unlocked as. */
const JOIN_OTHER_ACCOUNT = 'this email belongs to another account of this Nod — unlock it, then join';
/**
 * F7: the join's own refusal. `preAuthConnection`'s routes answer `401` for a wrong code or password
 * (SP02 §5), and the client reads every `401` as "signed out" — a sentence about a session that was
 * revoked, which is not what a wrong code did.
 */
const INVALID_CODE_OR_PASSWORD = 'invalid code or password';

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

/**
 * F1/F3: what the local side of a join decided before any host call (`Session.joinGate`). `join`
 * means the host may be asked, and `local` is the account of this Nod the host person will replace
 * (`null` when the email is nobody's here); `choose` means a local person holds the join's email and
 * the person has not said which account wins — nothing was sent and the code is not spent.
 */
export type JoinGate<T> =
  | { kind: 'join'; local: Person | null; answer: T }
  | { kind: 'choose'; person: Person };

/**
 * SP02 §7/V1: what `Session.onActivated` hands a subscriber once an activation — or the reset that
 * an activation over an existing local account is — has written the row and the session holds the
 * new keys. `reset` is true when the E02 key pair must be regenerated: this Nod's vault of the
 * person was just wiped, **or** the adoption is an access-code activation (which always derives a
 * fresh `vaultKey`, K1). Either way the subscriber (`backend/main.ts`) regenerates the pair.
 */
export interface ActivationEvent {
  personId: Id;
  reset: boolean;
  vaultKey: Uint8Array<ArrayBuffer>;
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
   *
   * F1: with `adoptLocalId` the local account of that id — the one `joinGate` found holding the
   * email — becomes the host person: the row, its roles, its vault index, its events and its
   * keychain items move to `personId` in one go, before the verifier is written. Its roles survive,
   * with the host's `admin` flag reconciled on top of them.
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
    /** F1: the local person (`JoinGate.local`) this host person replaces, if any. */
    adoptLocalId?: Id;
    /**
     * SP02 §7/K1: this adoption is an **access-code activation** (or the setup of the first admin),
     * which always chooses a fresh salt — so the account's `vaultKey` moved and the E02 key pair
     * must be regenerated even when no local vault was wiped (an F1 adoption, a machine that never
     * held the account). A password sign-in leaves it `false`: there the wipe is the only reset.
     */
    activation?: boolean;
  }): Promise<SessionState>;
  /**
   * F1, F3, F7: the local half of a join, in the one order the rules need. Everything this machine
   * knows is decided before the host hears anything — F1's collision and the choice that follows it,
   * F3's unlocked session — and the host call is `host`, the caller's own (`backend/main.ts` owns the
   * client, the discovery and the `host` row), so a join this side refuses makes no request at all.
   *
   * A `401` out of `host` is F7's one sentence for a wrong code or password, not the `signed-out` of
   * a revoked session; with `signIn` the attempt pays RF-23's backoff, which `unlock` shares (F3).
   * Throws with the sentence the join screen shows when the join must not go out at all.
   */
  joinGate<T>(p: {
    email: string;
    /** F1: the person chose the guild account over the local account of the same email. */
    adoptLocal: boolean;
    /** F3: the caller's own reading of the `host` row — a Nod with an account *and* a host is not
     *  the lock-screen case F3 is about. */
    hostPinned: boolean;
    /** F3: this join is a sign-in, so it pays the unlock backoff like any other password check. */
    signIn: boolean;
    host: () => Promise<T>;
  }): Promise<JoinGate<T>>;
  unlock(p: { email: string; password: string }): Promise<SessionState>;
  unlockBiometric(): Promise<SessionState>;
  enableBiometric(password: string): Promise<SessionState>;
  /**
   * SP02 §9: removes `nod.bio.<person>` — no biometric item, no biometric unlock. The password
   * remains the only way into this machine.
   */
  disableBiometric(): Promise<SessionState>;
  /**
   * The keys of the unlocked session (SP02 §6); `null` while locked. A password unlock gives both;
   * a biometric unlock has no password behind it, so `authKey` is `null` there while `vaultKey` is
   * the key the item carried (SP02 §9). An account created moments ago has no key at all (v1).
   */
  keys(): { authKey: Uint8Array | null; vaultKey: Uint8Array } | null;
  /**
   * SP02 §7/V1: registers a callback that runs after an activation — and after the key reset an
   * access-code activation always is, `reset: true` — once the session holds the new keys. The
   * `vaultKey` is the one the adoption derived; `session.vaultKey()` returns it too.
   * Returns a function that removes the callback. Callbacks run in registration order and are
   * awaited; a callback that throws does not fail the activation (the row is already written) — a
   * retry is the subscriber's own, so callbacks must be idempotent.
   */
  onActivated(cb: (event: ActivationEvent) => void | Promise<void>): () => void;
  /**
   * SP02 §8/§9: the `vaultKey` the unlocked session holds, from the password or from the biometric
   * item (`app.authenticate` + `base64url(vaultKey)`, SP02 §9). `null` while locked — and after an
   * unlock that had no key to keep (an account created moments ago, whose row is still v1).
   * `backend/vault.ts` is what reads it.
   */
  vaultKey(): Uint8Array<ArrayBuffer> | null;
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
   * verifier untouched. Without it the local V2 verifier is rewritten. Before the verifier moves,
   * every vault value and the biometric item are re-sealed under the new `vaultKey` (§8, V1), so
   * the vault stays readable with the new password and the old one opens nothing.
   */
  changePassword(
    current: string,
    next: string,
    host?: (request: PasswordChangeRequest) => Promise<void>,
  ): Promise<void>;
  /**
   * SP02 §7: every `nod.cred.<person>.*` item of the keychain and the index rows of that person —
   * and the biometric item, which holds a `vaultKey` the reset has just made useless (SP02 §9).
   */
  wipeVault(personId: Id): Promise<void>;
  /**
   * F2: the snapshot's `me` (SP04 §2) is the last word on the connected person — its name and its
   * admin flag. The unlocked person follows it, and `true` means the caller has a session state
   * worth pushing to the page (an access-code admin reaches the admin screens, a demoted one leaves
   * them). A snapshot of somebody else, or no unlocked session, is nothing to reconcile.
   */
  reconcileConnectedIdentity(me: { id: Id; name: string; admin: boolean }): boolean;
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
  // SP02 §8/§9: the `vaultKey` alone. A password unlock fills both; a biometric unlock has only
  // this one (the item carries it), and `vaultKey()` is what `backend/vault.ts` reads.
  let currentVaultKey: Uint8Array<ArrayBuffer> | null = null;
  // `lock()` is synchronous (§4) and the keychain is asynchronous: the `biometric` field of the
  // state it returns comes from this last read. `state()` (called on unlock, on account creation
  // and by `nod.info`) and `enableBiometric` are what refresh it.
  let knownBiometric = false;
  // SP02 §7/V1: the person whose vault the last `wipeVault` removed — a reset. The next activation
  // of that account (or of the local row it replaces) is told to subscribers as `reset: true`.
  let lastWiped: Id | null = null;
  // V1/K1: subscribers that need the new keys of an activation, in registration order.
  const activated: ((event: ActivationEvent) => void | Promise<void>)[] = [];

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
   * SP02 §6: the keys of the unlocked session. `null` while locked. A biometric unlock has no
   * password behind it, so its `authKey` is `null` while the item's `vaultKey` is still kept
   * (SP02 §9) — `vaultKey()` answers the same key on its own.
   */
  function keys(): { authKey: Uint8Array | null; vaultKey: Uint8Array } | null {
    if (currentVaultKey === null) return null;
    return {
      authKey: currentKeys === null ? null : currentKeys.authKey,
      vaultKey: currentVaultKey,
    };
  }

  /** SP02 §8: the key the vault seals with, kept in memory by either unlock (SP02 §9). */
  function vaultKey(): Uint8Array<ArrayBuffer> | null {
    return currentVaultKey;
  }

  /** V1/K1: see the contract. */
  function onActivated(cb: (event: ActivationEvent) => void | Promise<void>): () => void {
    activated.push(cb);
    return () => {
      const at = activated.indexOf(cb);
      if (at !== -1) activated.splice(at, 1);
    };
  }

  /** Runs the activation subscribers in registration order, after the session holds the new keys. */
  async function announceActivated(
    personId: Id,
    key: Uint8Array<ArrayBuffer>,
    replaced: Id | null,
    activation: boolean,
  ): Promise<void> {
    // SP02 §7/K1: an activation always chooses a fresh salt, so the account's `vaultKey` moved and
    // any E02 pair sealed under the old one — this machine's value, or the host's blob — is
    // unreadable. The pair must be regenerated even when no local vault was wiped (an F1 adoption,
    // a machine that never held the account): the wipe alone would leave the machine holding keys
    // nothing can open (`keys unavailable — sign in again`, forever). A password sign-in keeps the
    // wipe as the only signal.
    const reset =
      activation || (lastWiped !== null && (lastWiped === personId || lastWiped === replaced));
    lastWiped = null;
    for (const cb of [...activated]) {
      try {
        await cb({ personId, reset, vaultKey: key });
      } catch {
        // A subscriber is not the activation: the host accepted the person and the row is written.
        // Failing the call here would leave the host row and the token unsaved, so a subscriber
        // that needs a retry owns it (and is idempotent by contract).
      }
    }
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

    // SP02 §6: a local account is created with the V2 verifier over a fresh local salt, and the
    // keys of the typed password are kept in memory — an unlocked session that cannot use the vault
    // breaks RF-24. The insert still goes through the v1 path (its transaction is the one that
    // consumes the invite); the V2 record replaces it in place right after, before anyone can see
    // the row. A crash in between leaves a valid v1 verifier of the same password, which the first
    // unlock migrates.
    const password = await hashPassword(p.password, iterations);
    const salt = randomSalt();
    const keys = await deriveFor(p.password, salt, iterations);
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

    deps.repo.savePasswordCheck(created.id, await passwordHashV2(salt, iterations, keys));
    record('account_created', created.id);
    await deps.store.set(LAST_PERSON_KEY, created.id);
    current = created;
    currentKeys = keys;
    currentVaultKey = keys.vaultKey;
    return state();
  }

  // ---------------------------------------------------------------- unlock

  /**
   * SP02 §6 migration: a v1 account — one written before this format; a connected account is
   * created with V2 at activation — is verified against the old PBKDF2 hash once and rewritten as
   * V2 with a fresh salt, whose keys are the ones the session keeps. Those keys are also the first
   * `vaultKey` such an account ever has (SP02 §8).
   */
  async function migrateV1Keys(password: string, personId: Id): Promise<DerivedKeys> {
    const salt = randomSalt();
    const keys = await deriveFor(password, salt, iterations);
    deps.repo.savePasswordCheck(personId, await passwordHashV2(salt, iterations, keys));
    return keys;
  }

  /**
   * SP02 §9 (V1): the biometric item holds `base64url(vaultKey)`. A password unlock is when a key
   * exists, so it is where an item that still holds the old marker (the person id) is rewritten —
   * and where a person whose marker was dropped after a biometric attempt gets the item back, with
   * no second "enable" by their hand. A keychain that refuses is not a reason to refuse the unlock:
   * the next password unlock tries again.
   */
  async function refreshBiometricItem(personId: Id, key: Uint8Array<ArrayBuffer>): Promise<void> {
    if (!deps.biometricAvailable) return;
    const pending = (await deps.store.get(BIOMETRIC_PENDING_KEY)) === personId;
    const existing = await deps.keychain.get(biometricKey(personId));
    if (existing !== null && decodeVaultKey(existing) !== null) return;
    if (existing === null && !pending) return;
    if (!(await deps.keychain.set(biometricKey(personId), toBase64url(key)))) return;
    if (pending) await deps.store.set(BIOMETRIC_PENDING_KEY, null);
    knownBiometric = true;
  }

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
      keys = await migrateV1Keys(p.password, found.person.id);
    }

    deps.repo.setMeta(META_FAILURES, '0');
    record('unlocked', found.person.id, 'password');
    await deps.store.set(LAST_PERSON_KEY, found.person.id);
    current = found.person;
    currentKeys = keys;
    currentVaultKey = keys === null ? null : keys.vaultKey;
    // SP02 §8/§9: with the key in hand, the person's legacy values are sealed and the biometric
    // item that still holds the old marker becomes a key. Both are idempotent.
    if (keys !== null) await refreshBiometricItem(found.person.id, keys.vaultKey);
    return state();
  }

  async function unlockBiometric(): Promise<SessionState> {
    if (!deps.biometricAvailable) throw new Error(NO_BIOMETRICS);

    const last = await lastPerson();
    if (!(await deps.authenticate(BIOMETRIC_REASON))) throw new Error(BIOMETRICS_DECLINED);

    const stored = last === null ? null : await deps.keychain.get(biometricKey(last));
    const found = last === null ? null : deps.repo.personById(last);
    if (last === null || stored === null || found === null) throw new Error(BIOMETRICS_DISABLED);

    const key = decodeVaultKey(stored);
    if (key === null) {
      // SP02 §9: an item from before V1 holds the person id, and an unlock made with it would have
      // no `vaultKey` to open the vault. It goes, and the next password unlock writes the key.
      await deps.keychain.delete(biometricKey(last));
      await deps.store.set(BIOMETRIC_PENDING_KEY, last);
      knownBiometric = false;
      throw new Error(BIOMETRICS_NEED_PASSWORD);
    }

    record('unlocked', found.id, 'biometric');
    current = found;
    // No password was typed, so there is no `authKey` — but the item carries the `vaultKey`
    // (SP02 §9), and the vault of this session is readable with it.
    currentKeys = null;
    currentVaultKey = key;
    return state();
  }

  async function enableBiometric(password: string): Promise<SessionState> {
    const person = requireUnlocked();
    const found = deps.repo.personAuthByEmail(person.email);
    // `person` came from the repository: `found` is null only if it was revoked during this session.
    if (found === null) throw new Error(INVALID_CREDENTIALS);
    // The one derivation of a V2 row also verifies the password and hands the `vaultKey` over:
    // what the item stores is the key, not the person id (SP02 §9, V1).
    let keys: DerivedKeys | null = null;
    let matches: boolean;
    if (found.password.algorithm === PASSWORD_V2_ALGORITHM) {
      keys = await keysOfV2(password, found.password);
      matches = keys !== null;
    } else {
      matches = await verifyPassword(password, found.password);
    }
    if (!matches) throw new Error(INVALID_CREDENTIALS);
    if (!deps.biometricAvailable) throw new Error(NO_BIOMETRICS);

    // The password just opened this row, so these are the session's keys as much as an unlock's: a
    // biometric unlock left no `authKey`, and confirming the password is what brings it back.
    if (keys === null) {
      // A v1 row has no `vaultKey` yet (the account was created moments ago); the same rewrite an
      // unlock would make gives it one, so the item never holds a key that opens nothing.
      keys = await migrateV1Keys(password, person.id);
    }
    currentKeys = keys;
    currentVaultKey = keys.vaultKey;
    if (!(await deps.keychain.set(biometricKey(person.id), toBase64url(keys.vaultKey)))) {
      throw new Error(BIOMETRIC_REFUSED);
    }
    await deps.store.set(LAST_PERSON_KEY, person.id);
    return state();
  }

  /**
   * SP02 §9: disabling biometrics removes `nod.bio.<person>` — the item that holds the `vaultKey`
   * is the whole of the feature, so there is nothing else to revoke. A pending rewrite of a legacy
   * marker is cleared too, or the next password unlock would bring back what was just turned off.
   */
  async function disableBiometric(): Promise<SessionState> {
    const person = requireUnlocked();
    await deps.keychain.delete(biometricKey(person.id));
    if ((await deps.store.get(BIOMETRIC_PENDING_KEY)) === person.id) {
      await deps.store.set(BIOMETRIC_PENDING_KEY, null);
    }
    knownBiometric = false;
    return state();
  }

  // ---------------------------------------------------------------- connected account (SP02 §6)

  /**
   * SP05 §2: the local person of a connected account is created at activation with the host person
   * id as its id, and SP02 §6 gives it the V2 verifier over the host salt — the same keys the host
   * has, so unlocking works offline afterwards. Being adopted means a host just accepted the
   * password, so the session starts unlocked.
   *
   * F1: with `adoptLocalId` the local account of that id is what the host person replaces — the
   * person chose the guild account over their local one at the join, and the row, its roles, its
   * vault index, its events and its keychain items move to the host person id before the verifier is
   * written.
   */
  async function adoptConnectedAccount(p: {
    personId: Id;
    email: string;
    name: string;
    password: string;
    salt: string;
    iterations: number;
    admin: boolean;
    adoptLocalId?: Id;
    activation?: boolean;
  }): Promise<SessionState> {
    const email = p.email.trim().toLowerCase();
    if (!email.includes('@')) throw new Error(INVALID_EMAIL);
    const name = p.name.trim();
    if (name.length === 0) throw new Error(NAME_REQUIRED);
    const problem = validateNewPassword(p.password);
    if (problem !== null) throw new Error(problem);
    // F1: `personByEmail` (revoked rows aside) is not the read here — the row that holds the email
    // decides whether this is an adoption or a refusal, and the adopted one is exactly the row the
    // unique index would refuse to leave behind.
    const holder = deps.repo.personByEmailAnyState(email);
    if (holder !== null && holder.person.id !== p.personId && holder.person.id !== p.adoptLocalId) {
      throw new Error(EMAIL_TAKEN);
    }
    const adopt = p.adoptLocalId !== undefined && p.adoptLocalId !== p.personId ? p.adoptLocalId : null;

    const keys = await deriveFor(p.password, p.salt, p.iterations);
    // F1: the roles of an adopted local account survive the re-key, and the host's flag is
    // reconciled on top of them — the admin of a local Nod that joins as a plain member keeps
    // every other local role, and the snapshot has the last word about the flag anyway (F2).
    const keptLocal = adopt !== null && holder !== null && holder.person.id === adopt ? holder.person.roles : [];
    // `admin` is the host's flag; the local row carries it through the admin role, which is what
    // `Person.admin` derives from. A non-admin gets no local role: while connected, roles and grants
    // come from the snapshot (SP05 §2), not from `role` / `person_role`.
    const roles = adopt === null ? (p.admin ? [deps.repo.ensureAdminRole().id] : []) : withHostAdmin(keptLocal, p.admin);
    // F1: an adopted local account is not a new one — the row exists, under another id, and what
    // just happened to it is an unlock as much as the host's acceptance is.
    const isNew = adopt === null && deps.repo.personById(p.personId) === null;
    if (adopt !== null) {
      const moved = deps.repo.adoptPersonId({
        fromId: adopt,
        toId: p.personId,
        keychainKeyOf: (item) => credentialKey(p.personId, item.toolId),
      });
      // SP02 §8: the AAD of every value is the keychain key that just changed, and the vaultKey
      // of the adopted account is the host's — so the values are opened with the key this session
      // held for the local account and sealed again, never copied.
      await moveCredentials(moved, adopt, p.personId, currentVaultKey, keys.vaultKey);
    }
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
    currentVaultKey = keys.vaultKey;
    // SP02 §7/V1: the row and the session are the host person's now; a subscriber that had to wait
    // for the keys (K1 regenerates the E02 pairs here) runs before the caller is answered.
    await announceActivated(person.id, keys.vaultKey, adopt, p.activation === true);
    return state();
  }

  /** The host's `admin` flag over the local roles of an adopted account (F1). */
  function withHostAdmin(kept: Id[], admin: boolean): Id[] {
    const adminRoleId = deps.repo.ensureAdminRole().id;
    const rest = kept.filter((id) => id !== adminRoleId);
    return admin ? [...rest, adminRoleId] : rest;
  }

  /** The keychain key of one credential: `nod.cred.<person>.<tool>` (`backend/vault.ts`). */
  function credentialKey(personId: Id, toolId: Id): string {
    return `nod.cred.${personId}.${toolId}`;
  }

  /**
   * F1: the credentials of an adopted account keep working under the host person id. The index rows
   * already point at the new key (`Repo.adoptPersonId`); this re-seals the values — the keychain key
   * is the AAD of a `bv1.` value, so a value copied to the new key would not open (SP02 §8). A
   * legacy plaintext value is sealed for the first time here. A value the index knows and the
   * keychain does not (an orphan) is nothing to move, and a keychain that refuses stops this where
   * it is: the old item stays intact and the report names the credential.
   */
  async function moveCredentials(
    items: VaultItem[],
    from: Id,
    to: Id,
    fromVaultKey: Uint8Array<ArrayBuffer> | null,
    toVaultKey: Uint8Array<ArrayBuffer>,
  ): Promise<void> {
    for (const item of items) {
      const raw = await deps.keychain.get(item.keychainKey);
      if (raw === null) continue;
      const keychainKey = credentialKey(to, item.toolId);
      const credential = await openCredential(raw, item.keychainKey, fromVaultKey, toVaultKey);
      if (credential === null) {
        // No key of this session opens it (a locked session, or a value written elsewhere): the old
        // item is left alone rather than overwritten with something that would not open either.
        throw new Error(`the saved login of ${item.toolId} could not be moved`);
      }
      const value = await encryptVaultValue(toVaultKey, keychainKey, credential);
      if (!(await deps.keychain.set(keychainKey, value))) {
        throw new Error(`the system keychain refused to move the credential of ${item.toolId}`);
      }
      if (!(await deps.keychain.delete(item.keychainKey))) {
        throw new Error(`the credential of ${item.toolId} stayed under its old key`);
      }
    }
    // SP02 §9: the biometric item is keyed by person id and holds `base64url(vaultKey)`. It moves
    // with the row and takes the key of the adopted account, or biometrics would go on unlocking
    // this session with a key that opens nothing.
    const marker = await deps.keychain.get(`${BIOMETRIC_PREFIX}${from}`);
    if (marker === null) return;
    if (!(await deps.keychain.set(`${BIOMETRIC_PREFIX}${to}`, toBase64url(toVaultKey)))) {
      throw new Error('the system keychain refused to move the biometric item');
    }
    await deps.keychain.delete(`${BIOMETRIC_PREFIX}${from}`);
  }

  /**
   * The credential of one keychain value of the vault: opened with the old key, or — a value an
   * interrupted run already re-sealed — with the new one, and plaintext values read as they are.
   */
  async function openCredential(
    raw: string,
    keychainKey: string,
    fromVaultKey: Uint8Array<ArrayBuffer> | null,
    toVaultKey: Uint8Array<ArrayBuffer>,
  ): Promise<{ username: string; secret: string } | null> {
    if (!isSealedVaultValue(raw)) return plainVaultCredential(raw);
    if (fromVaultKey !== null) {
      const opened = await decryptVaultValue(fromVaultKey, keychainKey, raw);
      if (opened !== null) return opened;
    }
    return decryptVaultValue(toVaultKey, keychainKey, raw);
  }

  // ---------------------------------------------------------------- the local half of a join (F1, F3, F7)

  /**
   * F1, F3, F7: see the contract. The order is the requirement: the collision, the choice and the
   * unlocked session are decided here, and `host` — the caller's call — runs only after that.
   */
  async function joinGate<T>(p: {
    email: string;
    adoptLocal: boolean;
    hostPinned: boolean;
    signIn: boolean;
    host: () => Promise<T>;
  }): Promise<JoinGate<T>> {
    const email = p.email.trim().toLowerCase();
    if (!email.includes('@')) throw new Error(INVALID_EMAIL);

    // F1: whoever holds the email of this join, in any state.
    const holder = deps.repo.personByEmailAnyState(email);
    // F3: a Nod that already has an account is not connected to a guild from the lock screen —
    // only somebody who can open this Nod's accounts decides that. The first run (no account at
    // all) keeps working without a session, which is what the third path of SP05 §4 is for.
    if (current === null && (holder !== null || (!p.hostPinned && deps.repo.countPeople() > 0))) {
      throw new Error(JOIN_NEEDS_UNLOCK);
    }

    let local: Person | null = null;
    if (holder !== null) {
      // F1: a live local account of another person is not the session's to give away — it is theirs
      // to unlock, exactly like the account of the email itself. A revoked row can never be unlocked
      // again (every read of `person` hides it), so what it holds is dead weight: the host's account
      // takes the email over and the row comes back with it.
      if (current !== null && !holder.revoked && holder.person.id !== current.id) {
        throw new Error(JOIN_OTHER_ACCOUNT);
      }
      // F1: the choice itself. The join answers it without calling the host, so the code the person
      // was given is still whole when they decide.
      if (!p.adoptLocal) return { kind: 'choose', person: holder.person };
      local = holder.person;
    }

    // F3: a sign-in is a password check against the host, and it pays the backoff an unlock pays —
    // the failures are one counter, so a run of wrong passwords cannot be walked around by locking
    // and signing in instead (RF-23).
    if (p.signIn && waitMs() > 0) throw new Error(WAIT_BEFORE_RETRY);
    try {
      const answer = await p.host();
      if (p.signIn) deps.repo.setMeta(META_FAILURES, '0');
      return { kind: 'join', local, answer };
    } catch (error) {
      // F7: a `401` of SP02 §4's auth routes is a wrong code or password, and it is counted like one.
      if (error instanceof HostError && error.status === 401) {
        if (p.signIn) registerFailure();
        throw new Error(INVALID_CODE_OR_PASSWORD);
      }
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /**
   * F2: see the contract. The row is the repository's (only it writes `person`) and the repository
   * decides whether anything moved; what this adds is the unlocked session following it — a revoked
   * person is no name or flag of anybody's, and the repository leaves it alone.
   */
  function reconcileConnectedIdentity(me: { id: Id; name: string; admin: boolean }): boolean {
    if (current === null || current.id !== me.id) return false;
    if (!deps.repo.saveConnectedIdentity(me.id, { name: me.name, admin: me.admin })) return false;
    refresh();
    return true;
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
    // Then the keychain (SP02 §7, V1): every vault value and the biometric item are re-sealed under
    // the new `vaultKey` **before** the verifier moves, so the vault stays readable with the new
    // password. The whole set is opened in memory first: a value that cannot be read aborts with
    // the old values and the old verifier in place.
    const previousVaultKey = oldKeys === null ? currentVaultKey : oldKeys.vaultKey;
    await reencryptVaultItems(
      { repo: deps.repo, keychain: deps.keychain },
      person.id,
      previousVaultKey,
      newKeys.vaultKey,
      // M1/SP02 §7: the E02 pair's keychain value (`backend/keys.ts`, `nod.keys.<person>`, AAD = the
      // same string) is a `bv1.` value under this very key, so it moves in the same batch: a crash
      // after it can no longer leave the pair sealed under a key nothing holds. What is left for
      // `keys.reSeal` afterwards is the host's blob, which its own mark makes republishable.
      [{ key: keysKey(person.id), aad: keysKey(person.id) }],
    );
    const biometric = await deps.keychain.get(biometricKey(person.id));
    if (biometric !== null && !(await deps.keychain.set(biometricKey(person.id), toBase64url(newKeys.vaultKey)))) {
      throw new Error(BIOMETRIC_REFUSED);
    }
    // Then the row: the vault is readable with the new password and the old one opens nothing.
    deps.repo.savePasswordCheck(person.id, await passwordHashV2(salt, iterations, newKeys));
    if (host !== undefined) {
      // The salt the `host` row caches for offline unlock (SP02 §6) is the host's, and the host just
      // moved it: a cache left on the old salt makes the next sign-in read a reset and wipe the
      // vault (SP02 §7, RF-43).
      deps.repo.saveHostSalt(salt);
    }
    currentKeys = newKeys;
    currentVaultKey = newKeys.vaultKey;
    record('password_changed', person.id);
  }

  /**
   * SP02 §7: the vault of one person is wiped — the index rows and every keychain item they point
   * at, and the biometric item, whose `vaultKey` (SP02 §9) is the one this wipe has just made
   * useless. The caller runs it when a sign-in or an activation finds a derived key different from
   * the cached one, before `adoptConnectedAccount`. A `nod.cred.*` item the index does not know
   * cannot be reached: `SecretStore` has no enumeration.
   */
  async function wipeVault(personId: Id): Promise<void> {
    const removed = deps.repo.removeVaultOf(personId);
    for (const item of removed) await deps.keychain.delete(item.keychainKey);
    await deps.keychain.delete(biometricKey(personId));
    // SP02 §7/V1: the next activation of this account (or of the local row it replaces) is a reset,
    // and `onActivated` subscribers hear it as one.
    lastWiped = personId;
  }

  function lock(): SessionState {
    const id = current === null ? null : current.id;
    current = null;
    currentKeys = null;
    currentVaultKey = null;
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
      currentVaultKey = null;
      return;
    }
    current = reloaded;
  }

  return {
    state,
    createAccount,
    adoptConnectedAccount,
    joinGate,
    unlock,
    unlockBiometric,
    enableBiometric,
    disableBiometric,
    keys,
    vaultKey,
    onActivated,
    deriveFor,
    changePassword,
    wipeVault,
    reconcileConnectedIdentity,
    lock,
    current: currentPerson,
    refresh,
  };
}
