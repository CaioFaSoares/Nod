// The auth routes of SP03 §2: the four public ones (`salt`, `activate`, `setup`, `login`) and the two
// of the person level (`logout`, `password`). `host/app.ts` mounts this plugin with one `.use(...)`.
//
// The public routes come first, because a guard covers only the routes written after it. The whole
// file speaks SP02 §5's vocabulary: one `invalid credentials` for every sign-in failure, one
// `invalid code` for every code failure, `too many attempts` once a budget of SP02 §5 is spent.
//
// One message is not enough on its own (F4 of the block 1 review): every `invalid code` of `activate`
// and `setup` pays the same argon2id hash, taken before the branch that answers it, so no answer can
// be timed into an email-existence oracle — the rule login already keeps with its dummy verify.
//
// Every failure body is the `ErrorResponse` of SP03 §1 with the status of its table; a body that
// fails its schema is the 400 `host/app.ts` maps from Elysia's validation error.
//
// The code of `activate` and `setup` is normalized and hashed here (`shared/host-api.ts`,
// `shared/encoding.ts`); the repo does the lookup, the attempt counting and the TTL (SP02 §3).

import { Elysia, status, t } from 'elysia';

import { sha256Hex } from '../../shared/encoding';
import {
  CODE_LENGTH,
  HOST_ROUTES,
  normalizeCode,
  normalizeEmail,
  type CodeKind,
  type Device,
} from '../../shared/host-api';
import {
  ADMIN_ROLE,
  AUTH_KEY_PATTERN,
  INVALID_CODE,
  INVALID_CREDENTIALS,
  SALT_PATTERN,
  TOO_MANY_ATTEMPTS,
  callerOf,
  clientAddress,
  hostOf,
  personAuth,
  type AuthService,
} from '../auth';
import type { Repo } from '../repo';

// ---------------------------------------------------------------- schemas (SP03 §1)

const deviceSchema = t.Object({
  name: t.String({ minLength: 1, maxLength: 200 }),
  os: t.Union([t.Literal('macos'), t.Literal('windows'), t.Literal('linux')]),
  appVersion: t.String({ minLength: 1, maxLength: 64 }),
});
const emailSchema = t.String({ minLength: 1, maxLength: 320 });
const nameSchema = t.String({ minLength: 1, maxLength: 200 });
/** The code as typed: `XXXX-XXXX` in any of SP02 §3's spellings, so the shape is the normalizer's. */
const codeSchema = t.String({ minLength: 1, maxLength: 64 });
const saltSchema = t.String({ pattern: SALT_PATTERN });
const authKeySchema = t.String({ pattern: AUTH_KEY_PATTERN });

const saltBody = t.Object({ email: emailSchema });
const activateBody = t.Object({
  email: emailSchema,
  code: codeSchema,
  salt: saltSchema,
  authKey: authKeySchema,
  device: deviceSchema,
});
const setupBody = t.Object({
  email: emailSchema,
  name: nameSchema,
  code: codeSchema,
  salt: saltSchema,
  authKey: authKeySchema,
  device: deviceSchema,
});
const loginBody = t.Object({ email: emailSchema, authKey: authKeySchema, device: deviceSchema });
const passwordBody = t.Object({
  currentAuthKey: authKeySchema,
  newSalt: saltSchema,
  newAuthKey: authKeySchema,
});

// ---------------------------------------------------------------- helpers

/** SP02 §5: a failed attempt answers 401 and spends one of that email's ten tries in fifteen minutes. */
function failure(auth: AuthService, email: string, message: string) {
  auth.limiter.failEmail(email);
  return status(401, { error: message });
}

/** One more 429 of SP02 §5, shared by the address budget and the email budget. */
function rateLimited() {
  return status(429, { error: TOO_MANY_ATTEMPTS });
}

/** SP02 §3: the hex SHA-256 the host stores, or null when the text is not a code of that kind. */
async function storedCodeHash(raw: string, kind: CodeKind): Promise<string | null> {
  const normalized = normalizeCode(raw);
  if (normalized === null || normalized.length !== CODE_LENGTH[kind]) return null;
  return await sha256Hex(normalized);
}

/** The row of a fresh session: a new id, the hash of the token, never the token (SP02 §5). */
function insertSession(
  repo: Repo,
  personId: string,
  device: Device,
  tokenHash: string,
  now: string,
): void {
  repo.createSession({ id: crypto.randomUUID(), personId, tokenHash, device }, now);
}

// ---------------------------------------------------------------- routes

/**
 * SP02 §5's address budget, in a plugin of its own: nested, so the hook reaches this file's routes
 * and stops there — the route groups of H5, H6 and H8 keep their own budgets.
 */
const addressLimit = new Elysia({ name: 'host-auth-address-limit' }).onBeforeHandle(
  'plugin',
  (ctx) => {
    const { auth, request } = hostOf(ctx);
    const address = clientAddress(request, ctx.server?.requestIP(request)?.address ?? null);
    if (!auth.limiter.allowAddress(address)) return rateLimited();
  },
);

export const authRoutes = new Elysia({ name: 'host-auth-routes' })
  // SP02 §5: thirty auth requests per address per minute, counted before anything else.
  .use(addressLimit)

  .post(HOST_ROUTES.authSalt, { body: saltBody }, async (ctx) => {
    const { auth } = hostOf(ctx);
    return await auth.saltFor(ctx.body.email);
  })

  .post(HOST_ROUTES.authActivate, { body: activateBody }, async (ctx) => {
    const { repo, auth } = hostOf(ctx);
    const email = normalizeEmail(ctx.body.email);
    if (!auth.limiter.allowEmail(email)) return rateLimited();

    // F4 of the block 1 review: the hash is computed before the branch below, so an email nobody
    // holds and a code the normalizer refuses pay the same argon2id cost as a wrong code of a person
    // who exists — SP02 §5's one `invalid code` must not be told apart by the clock, exactly as login
    // keeps one sign-in cost through its dummy hash. It also stays before the transaction, which is
    // synchronous: the whole redemption is one unit of work (H2 decision 14).
    const authHash = await auth.hashAuthKey(ctx.body.authKey);

    const codeHash = await storedCodeHash(ctx.body.code, 'access');
    // The code is bound to the person's email (SP02 §3): an email nobody holds is a code failure,
    // which is the one answer that never says whether the person exists.
    const person = codeHash === null ? null : repo.personByEmail(email);
    if (codeHash === null || person === null) return failure(auth, email, INVALID_CODE);

    const token = auth.newToken();
    const tokenHash = await auth.tokenHash(token);
    const now = auth.now();
    const opened = repo.transaction(() => {
      if (repo.redeemCode('activate', person.id, codeHash, now) === null) return null;
      // SP02 §7: activation stores the salt the Nod chose; a reissued code resets it.
      repo.activatePerson(person.id, { salt: ctx.body.salt, authHash }, now);
      insertSession(repo, person.id, ctx.body.device, tokenHash, now);
      return { token, personId: person.id };
    });
    if (opened === null) return failure(auth, email, INVALID_CODE);
    return opened;
  })

  .post(HOST_ROUTES.authSetup, { body: setupBody }, async (ctx) => {
    const { repo, auth } = hostOf(ctx);
    const email = normalizeEmail(ctx.body.email);
    if (!auth.limiter.allowEmail(email)) return rateLimited();

    // F4 of the block 1 review: the hash comes before the branch, as in `activate`, so a code the
    // normalizer refuses costs the same argon2id work as one that reaches `redeemCode`.
    const authHash = await auth.hashAuthKey(ctx.body.authKey);

    const codeHash = await storedCodeHash(ctx.body.code, 'setup');
    if (codeHash === null) return failure(auth, email, INVALID_CODE);

    const token = auth.newToken();
    const tokenHash = await auth.tokenHash(token);
    const now = auth.now();
    const opened = repo.transaction(() => {
      // SP03 §2: the code dies with this redemption. A failure below — a taken email, for one —
      // rolls the whole thing back, so the code stays unspent.
      if (repo.redeemCode('setup', null, codeHash, now) === null) return null;
      repo.saveRole({ id: ADMIN_ROLE, name: ADMIN_ROLE, admin: true });
      const person = repo.createPerson(
        { id: crypto.randomUUID(), email, name: ctx.body.name, roles: [ADMIN_ROLE] },
        now,
      );
      repo.activatePerson(person.id, { salt: ctx.body.salt, authHash }, now);
      insertSession(repo, person.id, ctx.body.device, tokenHash, now);
      return { token, personId: person.id };
    });
    if (opened === null) return failure(auth, email, INVALID_CODE);
    return opened;
  })

  .post(HOST_ROUTES.authLogin, { body: loginBody }, async (ctx) => {
    const { repo, auth } = hostOf(ctx);
    const email = normalizeEmail(ctx.body.email);
    if (!auth.limiter.allowEmail(email)) return rateLimited();

    const person = await auth.verify(email, ctx.body.authKey);
    // SP02 §4: a wrong key and an email that exists nowhere answer the same bytes, and the verify
    // above cost the same either way.
    if (person === null || person.disabledAt !== null) return failure(auth, email, INVALID_CREDENTIALS);

    const token = auth.newToken();
    insertSession(repo, person.id, ctx.body.device, await auth.tokenHash(token), auth.now());
    return { token, personId: person.id };
  })

  // SP03 §1: below this line the caller must be a live, non-disabled person.
  .use(personAuth)

  .post(HOST_ROUTES.authLogout, (ctx) => {
    const { repo, auth } = hostOf(ctx);
    const { session } = callerOf(ctx);
    // SP02 §5: the person ends this session, and only this one.
    repo.revokeOwnSession(session.personId, session.id, auth.now());
    return status(204);
  })

  .post(HOST_ROUTES.authPassword, { body: passwordBody }, async (ctx) => {
    const { repo, auth } = hostOf(ctx);
    const { person } = callerOf(ctx);
    // SP02 §7: the current key is verified before anything is written.
    const current = await auth.verify(person.email, ctx.body.currentAuthKey);
    if (current === null || current.id !== person.id) {
      return status(401, { error: INVALID_CREDENTIALS });
    }
    // The session survives the change and no other session is revoked: SP02 §7 asks for both.
    repo.changeAuth(person.id, {
      salt: ctx.body.newSalt,
      authHash: await auth.hashAuthKey(ctx.body.newAuthKey),
    });
    return status(204);
  });
