// The host side of auth (SP02 §2, §4, §5; SP03 §1): argon2id over the `authKey` the Nod derived,
// the salt lookup that cannot enumerate emails, the session tokens and their sliding expiry, the
// in-memory rate limits, and the two guards every route file mounts.
//
// Nothing here stores or logs a secret. The wire value `authKey` is hashed as it arrives (SP02 §2);
// a session token is returned once and only its hex SHA-256 is stored (SP02 §5); the fake salt of an
// unknown email is the HMAC of `host-secret` (SP02 §4), so no request can tell who exists.
//
// `host/app.ts` builds one service and decorates the request context with it and with the repo; the
// route files read those two through `hostOf` and get the caller through the guards' derived
// context. The value type of a guard is declared here (`Caller`), because Elysia cannot type a
// decoration a plugin does not itself make.

import { Elysia, status } from 'elysia';

import { PBKDF2_ITERATIONS } from '../shared/auth';
import { sha256Hex, toBase64url } from '../shared/encoding';
import { normalizeEmail, type SaltResponse } from '../shared/host-api';
import type { HostPerson, Repo, SessionRecord } from './repo';

// ---------------------------------------------------------------- constants

/** SP02 §2: algorithm as Bun writes and verifies it, with Bun's own defaults. */
const ARGON2ID = { algorithm: 'argon2id' } as const;

/** SP02 §5: 32 random bytes, base64url — 43 characters, returned once. */
export const SESSION_TOKEN_BYTES = 32;

/** SP02 §4: the fake salt is the first 16 bytes of the HMAC, base64url — 22 characters. */
export const SALT_BYTES = 16;

/** What `shared/host-api.ts` puts on the wire: `authKey` is 32 bytes (43 chars), a salt 16 (22). */
export const AUTH_KEY_PATTERN = '^[A-Za-z0-9_-]{43}$';
export const SALT_PATTERN = '^[A-Za-z0-9_-]{22}$';

/** SP02 §5: one message per auth failure, and one per rate limit. */
export const INVALID_CREDENTIALS = 'invalid credentials';
export const INVALID_CODE = 'invalid code';
export const TOO_MANY_ATTEMPTS = 'too many attempts';

/** SP02 §5 is not the only place a message is fixed: SP03 §1 gives "authenticated but not allowed". */
export const ADMIN_ONLY = 'admin only';

/** SP03 §2: `setup` gives the first admin this role, `admin = 1`. */
export const ADMIN_ROLE = 'admin';

/** SP02 §5: 30 auth requests per address per minute. */
export const REQUESTS_PER_ADDRESS = 30;
export const ADDRESS_WINDOW_MS = 60_000;

/** SP02 §5: 10 failed attempts per email per 15 minutes. */
export const FAILURES_PER_EMAIL = 10;
export const EMAIL_WINDOW_MS = 15 * 60_000;

/** SP02 §4: what an unknown email is verified against, so a sign-in takes the same time either way. */
// frozen protocol label (kept 'bond' on purpose: changing it changes every derived key)
const DUMMY_AUTH_KEY = 'bond/auth/dummy/v1';

/** Past this many tracked addresses or emails the stale windows are dropped (one process, SP07 §2). */
const TRACKED_KEYS = 10_000;

// ---------------------------------------------------------------- rate limits (SP02 §5)

export interface RateLimiter {
  /** One auth request from this address; false once the minute's budget is spent. */
  allowAddress(address: string): boolean;
  /** Whether that email may still try: false inside its fifteen-minute failure window. */
  allowEmail(email: string): boolean;
  /** One failed sign-in of that email. */
  failEmail(email: string): void;
}

interface Window {
  /** Start of the fixed window, in the clock's milliseconds. */
  start: number;
  count: number;
}

/**
 * SP02 §5's two budgets, in memory: a restart forgets both, which is what the spec asks for (no
 * table). The clock is a parameter so a test can move it instead of waiting fifteen minutes.
 */
export function createRateLimiter(now: () => number = Date.now): RateLimiter {
  const addresses = new Map<string, Window>();
  const emails = new Map<string, Window>();

  function prune(map: Map<string, Window>, windowMs: number): void {
    const at = now();
    for (const [key, entry] of map) if (at - entry.start >= windowMs) map.delete(key);
  }

  return {
    allowAddress(address: string): boolean {
      const at = now();
      const entry = addresses.get(address);
      if (entry === undefined || at - entry.start >= ADDRESS_WINDOW_MS) {
        if (addresses.size >= TRACKED_KEYS) prune(addresses, ADDRESS_WINDOW_MS);
        addresses.set(address, { start: at, count: 1 });
        return true;
      }
      if (entry.count >= REQUESTS_PER_ADDRESS) return false;
      entry.count += 1;
      return true;
    },

    allowEmail(email: string): boolean {
      const entry = emails.get(normalizeEmail(email));
      if (entry === undefined) return true;
      return now() - entry.start >= EMAIL_WINDOW_MS || entry.count < FAILURES_PER_EMAIL;
    },

    failEmail(email: string): void {
      const key = normalizeEmail(email);
      const at = now();
      const entry = emails.get(key);
      if (entry === undefined || at - entry.start >= EMAIL_WINDOW_MS) {
        if (emails.size >= TRACKED_KEYS) prune(emails, EMAIL_WINDOW_MS);
        emails.set(key, { start: at, count: 1 });
        return;
      }
      entry.count += 1;
    },
  };
}

// ---------------------------------------------------------------- service

export type AuthDeps = {
  repo: Repo;
  /** The 32 bytes of `host-secret` (SP01 §1): the HMAC key behind every fake salt (SP02 §4). */
  hostSecret: Uint8Array;
  /** ISO 8601 UTC; the caller owns the clock, exactly as `repo.ts` does. */
  now?: () => string;
};

export interface AuthService {
  readonly repo: Repo;
  readonly limiter: RateLimiter;
  /** The instant of this request: one value for the salt lookup, the row and the session. */
  now(): string;
  /** `argon2id(base64url(authKey))` as Bun writes it (SP02 §2). */
  hashAuthKey(authKey: string): Promise<string>;
  /** Whether a stored hash accepts that `authKey`. */
  verifyAuthKey(authKey: string, hash: string): Promise<boolean>;
  /** SP02 §4: `{ salt, iterations }`, answered for every email and never a signal of who exists. */
  saltFor(email: string): Promise<SaltResponse>;
  /** The person whose stored hash accepts that `authKey`, or null — one argon2 verify either way. */
  verify(email: string, authKey: string): Promise<HostPerson | null>;
  /** A fresh token: 32 random bytes, base64url (SP02 §5). */
  newToken(): string;
  /** The hex SHA-256 the `sessions` row keeps instead of the token (SP02 §5). */
  tokenHash(token: string): Promise<string>;
  /** The caller of a bearer token, or null; every live session it answers for is slid forward. */
  authenticate(token: string): Promise<Caller | null>;
}

/** One authenticated caller: the person and the session the guard derived (SP03 §1's person level). */
export interface Caller {
  person: HostPerson;
  session: SessionRecord;
}

export function createAuthService(deps: AuthDeps): AuthService {
  const repo = deps.repo;
  const clock = deps.now ?? (() => new Date().toISOString());
  const limiter = createRateLimiter(() => Date.parse(clock()));

  // A copy, so WebCrypto gets a plain `ArrayBuffer`-backed view whatever the caller read the file
  // into. The key is imported once: a fake salt costs one HMAC and no key material leaves here.
  const secret = new Uint8Array(deps.hostSecret);
  let fakeSaltKey: Promise<CryptoKey> | null = null;
  const hmacKey = (): Promise<CryptoKey> =>
    (fakeSaltKey ??= crypto.subtle.importKey(
      'raw',
      secret,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    ));

  // The dummy of SP02 §4, made once per process: the first unknown email pays one extra hash.
  let dummy: Promise<string> | null = null;

  async function hashAuthKey(authKey: string): Promise<string> {
    return await Bun.password.hash(authKey, ARGON2ID);
  }

  async function verifyAuthKey(authKey: string, hash: string): Promise<boolean> {
    return await Bun.password.verify(authKey, hash);
  }

  const dummyHash = (): Promise<string> => (dummy ??= hashAuthKey(DUMMY_AUTH_KEY));

  async function fakeSalt(email: string): Promise<string> {
    const mac = new Uint8Array(
      await crypto.subtle.sign(
        'HMAC',
        await hmacKey(),
        new TextEncoder().encode(`fake-salt/${normalizeEmail(email)}`),
      ),
    );
    return toBase64url(mac.subarray(0, SALT_BYTES));
  }

  return {
    repo,
    limiter,
    now: () => clock(),

    hashAuthKey,
    verifyAuthKey,

    async saltFor(email: string): Promise<SaltResponse> {
      const found = repo.personAuthByEmail(email);
      // SP02 §4: an activated person's own salt, and a stable fake for anyone else. Both answers
      // carry the same `iterations`, so the reply says nothing about who exists.
      const salt = found?.salt ?? (await fakeSalt(email));
      return { salt, iterations: PBKDF2_ITERATIONS };
    },

    async verify(email: string, authKey: string): Promise<HostPerson | null> {
      const found = repo.personAuthByEmail(email);
      // The dummy keeps a sign-in for an email that exists nowhere as expensive as one for a
      // person who is there (SP02 §4): the argon2 verify happens either way.
      const hash = found?.authHash ?? (await dummyHash());
      const ok = await verifyAuthKey(authKey, hash);
      return ok && found !== null && found.authHash !== null ? found.person : null;
    },

    newToken(): string {
      return toBase64url(crypto.getRandomValues(new Uint8Array(SESSION_TOKEN_BYTES)));
    },

    async tokenHash(token: string): Promise<string> {
      return await sha256Hex(token);
    },

    async authenticate(token: string): Promise<Caller | null> {
      const at = clock();
      // A revoked, expired or unknown token all answer null (SP01 §2's `sessionByTokenHash`).
      const session = repo.sessionByTokenHash(await sha256Hex(token), at);
      if (session === null) return null;
      const person = repo.personById(session.personId);
      // SP03 §1: a disabled person does not sign anything, and disabling revoked their sessions.
      if (person === null || person.disabledAt !== null) return null;
      // SP02 §5: every authenticated request slides the window by fourteen days.
      repo.touchSession(session.id, at);
      return { person, session };
    },
  };
}

// ---------------------------------------------------------------- the guards (SP03 §1)

/**
 * What `host/app.ts` puts on the request context, read inside a route handler or a guard. Elysia
 * types only the decorations an instance makes itself, so the shape is declared once here and the
 * cast stays inside `hostOf`: everything below is typed by the interface, never by `any`.
 */
export type HostContext = {
  request: Request;
  repo: Repo;
  auth: AuthService;
};

export function hostOf(ctx: unknown): HostContext {
  return ctx as HostContext;
}

/** What the `personAuth` guard derived — the same cast rule as `hostOf`. */
export function callerOf(ctx: unknown): Caller {
  return ctx as Caller;
}

/** `Authorization: Bearer <token>` → the token, or null (SP02 §5). */
export function bearerToken(header: string | null | undefined): string | null {
  if (typeof header !== 'string') return null;
  const parts = header.trim().split(/\s+/);
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer' || parts[1] === '') return null;
  return parts[1];
}

/**
 * The address SP02 §5 counts a rate limit against. The proxy in front of the container writes the hop
 * it saw into `X-Forwarded-For` (SP07 §2), and its **last** entry is the one the nearest proxy
 * observed — a client cannot mint budgets by prefixing the header. `socket` (Bun's peer address) is
 * the fallback; `app.handle` in a test has neither, and every such request shares `unknown`.
 */
export function clientAddress(request: Request, socket: string | null): string {
  const forwarded = request.headers.get('x-forwarded-for');
  const hops = forwarded?.split(',').map((hop) => hop.trim()).filter((hop) => hop !== '') ?? [];
  if (hops.length > 0) return hops[hops.length - 1];
  return socket ?? 'unknown';
}

/**
 * SP03 §1's **person** level: a valid session of a person who is not disabled. Mounted before the
 * routes it guards — a route file writes `new Elysia().use(personAuth).get(...)`, and the guard
 * derives `person` and `session` on every request that follows it.
 */
export const personAuth = new Elysia({ name: 'host-auth-person' }).derive('plugin', async (ctx) => {
  const { auth, request } = hostOf(ctx);
  const token = bearerToken(request.headers.get('authorization'));
  const caller = token === null ? null : await auth.authenticate(token);
  // A missing token and a dead one answer alike, so nothing tells an attacker which it was (SP02 §5).
  if (caller === null) return status(401, { error: INVALID_CREDENTIALS });
  return { person: caller.person, session: caller.session };
});

/**
 * SP03 §1's **admin** level: the person of `personAuth` with an admin role. It carries `personAuth`
 * itself, so mounting this one is enough, and it derives `admin: true` for the route that needs it.
 */
export const adminAuth = new Elysia({ name: 'host-auth-admin' })
  .use(personAuth)
  .derive('plugin', (ctx) => {
    const { person } = callerOf(ctx);
    if (!person.admin) return status(403, { error: ADMIN_ONLY });
    return { admin: true as const };
  });
