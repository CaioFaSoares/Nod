// The block 2 person routes of SP03 §3 (SP06): the caller's public keys, the shares they send,
// accept and decline, and the holders of a credential. `host/app.ts` mounts this plugin with one
// `.use(...)` line, exactly like the auth, admin, state and event groups (`host/context.md`).
//
// The file owns the HTTP surface: the body schemas (the shapes of `shared/host-api.ts`, so the Nod
// and the host validate the same fields), the parameters, the statuses, and the clock each write is
// stamped with. Every rule — the scope checks of SP06 §5, who may revoke a holder, which share is
// open, what a seal means — is `host/repo.ts`'s, and so is every typed refusal the app maps.
//
// No secret leaves here. `sealed` is opaque base64url (SP06 §3): the host stores it, hands it to its
// recipient and purges it — it never decodes it, and no value of a body ever reaches a log or an
// error message (SP03 §1).

import { Elysia, status, t } from 'elysia';

import { HOST_ROUTES, type Holder, type OwnKeys, type ShareResponse } from '../../shared/host-api';
import { callerOf, hostOf, personAuth } from '../auth';
import { ForbiddenError, NotFoundError } from '../repo';

// ---------------------------------------------------------------- schemas (SP03 §1–§3)

/** A uuid or a slug id: the bounds every id of a body has, as in `routes/admin.ts`. */
const idSchema = t.String({ minLength: 1, maxLength: 64 });

/** SP03 §3's `:id` and `:personId` of the holder path, one shape per kind of id. */
const idParams = t.Object({ id: idSchema });
const holderParams = t.Object({ id: idSchema, personId: idSchema });

/**
 * SP06 §2: a public key is the raw 32 bytes in base64url without padding — 43 characters, the same
 * pattern `shared/seal.ts` produces and `host/auth.ts` uses for the 32-byte `authKey`.
 */
const publicKeySchema = t.String({ pattern: '^[A-Za-z0-9_-]{43}$' });

/**
 * `docs/canonico.md` §22, SP06 §2: the private halves as a `bv1.` value (SP02 §8) — the prefix, then
 * the base64url nonce and ciphertext. Unlike a share's `sealed` it carries a dot, and it is opaque
 * here either way: the only checks are the prefix and the alphabet of the body. Its size is bounded
 * by the request limit of `host/app.ts` (256 KB), like every other string of a body.
 */
const privateSealedSchema = t.String({ minLength: 1, pattern: '^bv1\\.[A-Za-z0-9_-]+$' });

/** SP03 §3 `PUT /v1/keys`: both halves at once, because a pair with one key is useless (SP06 §2). */
const keysBody = t.Object({
  x25519Public: publicKeySchema,
  ed25519Public: publicKeySchema,
  privateSealed: t.Optional(privateSealedSchema),
});

/**
 * SP06 §3's `sealed` is base64url of `body || sig` and the host never looks inside it: the only
 * check the schema can make is that it is a non-empty string of the alphabet. L7 caps it well below
 * the request body limit (256 KB in `host/app.ts`): a credential payload is a small JSON object, and
 * 64 KB per copy leaves room for the rest of the batch.
 */
const sealedSchema = t.String({
  minLength: 1,
  maxLength: 65_536,
  pattern: '^[A-Za-z0-9_-]+$',
});

const shareItemBody = t.Object({ to: idSchema, sealed: sealedSchema });

/** SP03 §3: one credential, one scope for every holder row. `blocked` is a state, not a share. */
const credentialScopeBody = t.Object({
  scope: t.Union([t.Literal('role'), t.Literal('blocked'), t.Literal('org')]),
});

const shareBody = t.Object({
  credentialId: idSchema,
  toolId: idSchema,
  scope: t.Union([t.Literal('role'), t.Literal('blocked'), t.Literal('org')]),
  kind: t.Union([t.Literal('send'), t.Literal('assign'), t.Literal('update')]),
  items: t.Array(shareItemBody, { minItems: 1, maxItems: 500 }),
});

// ---------------------------------------------------------------- routes

export const shareRoutes = new Elysia({ name: 'host-shares-routes' })
  // SP03 §1: below this line the caller must be a live, non-disabled person.
  .use(personAuth)

  /**
   * SP03 §3: `{ x25519Public, ed25519Public, privateSealed? }` in, `204` out. New public keys
   * replace whatever the person had — a reset, which is what SP06 §2 asks of an activation: a pair
   * sealed to the old key is worthless, and the Nod re-sends those shares. The same public keys
   * move the sealed private halves alone (`docs/canonico.md` §22: a password change re-seals them
   * and the pair does not change), so `created_at` stays.
   */
  .put(HOST_ROUTES.keys, { body: keysBody }, (ctx) => {
    const { person } = callerOf(ctx);
    const { repo, auth } = hostOf(ctx);
    repo.savePersonKeys(
      person.id,
      { x25519Public: ctx.body.x25519Public, ed25519Public: ctx.body.ed25519Public },
      ctx.body.privateSealed ?? null,
      auth.now(),
    );
    return status(204);
  })

  /**
   * SP03 §3, `docs/canonico.md` §22: the caller's own pair, the sealed private halves included, so a
   * second machine of the same person adopts it instead of generating a competing one. The row is
   * the caller's and only the caller's (`personAuth`), so no other person's blob is ever in an
   * answer; `404` says this person has published no pair yet.
   */
  .get(HOST_ROUTES.keysPrivate, (ctx): OwnKeys => {
    const { person } = callerOf(ctx);
    const stored = hostOf(ctx).repo.ownPersonKeys(person.id);
    if (stored === null) throw new NotFoundError('unknown keys');
    return stored;
  })

  /**
   * SP03 §3: one sealed copy per item, `{ ids }` back. The host ids the rows it creates (the Nod's
   * `sealed` is addressed to the recipient, not to a row), and the sender is the session's person —
   * a `from` in the body, which `ShareRequest` does not have, is dropped by the schema.
   */
  .post(HOST_ROUTES.shares, { body: shareBody }, (ctx): ShareResponse => {
    const { person } = callerOf(ctx);
    const { repo, auth } = hostOf(ctx);
    return {
      ids: repo.createShares(
        {
          fromId: person.id,
          credentialId: ctx.body.credentialId,
          toolId: ctx.body.toolId,
          scope: ctx.body.scope,
          kind: ctx.body.kind,
          items: ctx.body.items.map((item) => ({
            id: crypto.randomUUID(),
            to: item.to,
            sealed: item.sealed,
          })),
        },
        auth.now(),
      ),
    };
  })

  /**
   * SP03 §3: the recipient accepts. The expired shares are purged first, so a share that reached its
   * 14 days answers the same `409` as one already accepted or declined (SP06 §4) — and its
   * ciphertext is gone before the answer travels.
   */
  .post(HOST_ROUTES.shareAccept, { params: idParams }, (ctx) => {
    const { person } = callerOf(ctx);
    const { repo, auth } = hostOf(ctx);
    const now = auth.now();
    repo.purgeExpiredShares(now);
    repo.acceptShare(ctx.params.id, person.id, now);
    return status(204);
  })

  /** SP03 §3: the recipient declines: the ciphertext is purged and nothing is added (SP06 §4). */
  .post(HOST_ROUTES.shareDecline, { params: idParams }, (ctx) => {
    const { person } = callerOf(ctx);
    const { repo, auth } = hostOf(ctx);
    const now = auth.now();
    repo.purgeExpiredShares(now);
    repo.declineShare(ctx.params.id, person.id, now);
    return status(204);
  })

  /**
   * SP03 §3, RF-54: who holds that credential, with the date and the scope of each holder. A holder
   * or an admin sees it; anyone else gets the 403 of SP03 §1, and an admin asking about a credential
   * nobody holds gets the 404. Removed holders stay in the list, with their `removedAt`: that is what
   * the owner reads as "this person no longer has it" (SP06 §4).
   */
  .get(HOST_ROUTES.holders, { params: idParams }, (ctx): Holder[] => {
    const { person } = callerOf(ctx);
    const { repo } = hostOf(ctx);
    const rows = repo.holdersOf(ctx.params.id);
    const mine = rows.some((row) => row.personId === person.id && row.removedAt === null);
    if (!person.admin && !mine) throw new ForbiddenError('not yours');
    if (rows.length === 0) throw new NotFoundError('unknown credential');
    return rows;
  })

  /**
   * SP03 §3, RF-48: the credential's owner holder (or an admin) revokes one holder. The holder row
   * keeps its date and gains `removedAt`, which is what puts the credential in the owner's
   * `rotationPending` until they save a new secret (SP06 §4).
   */
  .delete(HOST_ROUTES.holder, { params: holderParams }, (ctx) => {
    const { person } = callerOf(ctx);
    const { repo, auth } = hostOf(ctx);
    repo.removeHolder(
      {
        credentialId: ctx.params.id,
        personId: ctx.params.personId,
        byId: person.id,
        admin: person.admin,
      },
      auth.now(),
    );
    return status(204);
  })

  /**
   * SP03 §3, SP06 §5, `docs/canonico.md` §22: the credential's owner holder (or an admin) sets the
   * scope of the credential, and every holder row takes it. This is the only writer of `blocked`:
   * from then on every `POST /v1/shares` for that credential is refused, and a later share may
   * narrow the stored scope but never widen it. Anyone else gets the `403` of SP03 §1, and a
   * credential no one holds is the `404` `unknown credential`.
   */
  .put(
    HOST_ROUTES.credentialScope,
    { params: idParams, body: credentialScopeBody },
    (ctx) => {
      const { person } = callerOf(ctx);
      const { repo } = hostOf(ctx);
      repo.setCredentialScope({
        credentialId: ctx.params.id,
        byId: person.id,
        admin: person.admin,
        scope: ctx.body.scope,
      });
      return status(204);
    },
  )

  /**
   * RF-48, SP03 §3: the credential's owner holder (or an admin) records that a new secret was saved
   * for a credential that was `rotationPending` — the explicit signal that clears the state when the
   * revoked holder was the last non-owner one and the update fan-out had no recipient. The owner
   * rule is `host/repo.ts`'s, like every other one; anyone else gets the `403` of SP03 §1.
   */
  .post(HOST_ROUTES.credentialRotated, { params: idParams }, (ctx) => {
    const { person } = callerOf(ctx);
    const { repo, auth } = hostOf(ctx);
    repo.markRotated(
      { credentialId: ctx.params.id, byId: person.id, admin: person.admin },
      auth.now(),
    );
    return status(204);
  });
