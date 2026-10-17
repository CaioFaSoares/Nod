// Credential sharing of the Nod — K4, K6 and K7 of `docs/specs/SP06-credential-sharing.md`
// (§3 the sealed share, §4 the flows, §5 the scope).
//
// The host knows the metadata of a share and never its content: this file seals one copy per
// recipient (`shared/seal.ts`), writes the copy into the vault of the receiver and asks the host to
// record the accept. The scope of SP06 §5 is decided twice — here, against the verified snapshot,
// and again by the host on its own data — and both sides refuse with the same English reason.
//
// Ordering of an accept (SP06 §3: "any failure declines with `invalid share`; no partial state"):
//   1. find the share in the snapshot and decide whether the gate is needed;
//   2. open and validate every SP06 §3 step (1–5) — nothing is written anywhere yet;
//   3. write the vault copy (the keychain value and the index row);
//   4. `POST /v1/shares/:id/accept`;
//   5. on a failed accept, restore the previous item (or remove the new one) and rethrow.
// A share that fails step 2 is declined on the host and answers `invalid share`; a share whose
// accept the host refuses leaves the vault exactly as it was.
//
// Nothing here imports `tjs` or `tiny`: the repository, the vault, the key pairs, the catalog and
// the connection arrive through `deps`, so `bun test` drives the whole module against a real
// database, real crypto and the real host app. No secret, username, sealed body or key reaches an
// error message, a log or a row.
import { originOf } from '../shared/catalog';
import { fromBase64url } from '../shared/encoding';
import { open as openSealed, seal, SEAL_VERSION } from '../shared/seal';
import type { SealPayload } from '../shared/seal';
import type { Holder, IncomingShare, ShareScope, Snapshot, SnapshotPerson } from '../shared/host-api';
import type {
  Entry,
  Id,
  InboxShare,
  Person,
  ShareRecipient,
  VaultItem,
} from '../shared/types';
import type { HostConnection } from './host-client';
import type { Keys } from './keys';
import type { Repo } from './repo';
import type { Vault } from './vault';

// ---------------------------------------------------------------- reasons (English, no values)

/** SP06 §3: any check of the sealed share failed. */
export const INVALID_SHARE = 'invalid share';
/** The id is not an open share of this Nod's inbox. */
export const UNKNOWN_SHARE = 'unknown share';
/** SP06 §5: a `blocked` credential never travels. */
export const BLOCKED_CREDENTIAL = 'blocked credential';
/** SP06 §5/RF-45: the pinned key of that person is not the one the host publishes. */
export const RECIPIENT_KEY_CHANGED = 'recipient key changed';
/** SP06 §2: without a pinned pair there is nothing to seal to. */
export const NO_PINNED_KEY = 'recipient has no pinned key';
/** SP06 §5: `role` needs a role in common with the sender. */
export const NO_COMMON_ROLE = 'no role in common';
/** SP06 §5: both scopes need the org tool granted to one of the recipient's roles. */
export const TOOL_NOT_VISIBLE = 'tool not visible to recipient';
/** SP06 §5: clients never receive an `org` share. */
export const ORG_MEMBERS_ONLY = 'org shares go to members only';
/** A send to oneself is not a share. */
export const CANNOT_SHARE_SELF = 'cannot share with yourself';
/** No vault item of that tool on this Nod. */
export const UNKNOWN_CREDENTIAL = 'unknown credential';
/** The person named as a recipient is not in the snapshot's roster. */
export const UNKNOWN_RECIPIENT = 'unknown recipient';
/** SP06 §5: the scope belongs to the credential's owner holder. */
export const OWNER_ONLY = 'only the owner can change the scope';
export const INVALID_SCOPE = 'invalid scope';
/** SP06 §5: a personal tool has no guild credential to share. */
export const NOT_SHAREABLE = 'only org tools can be shared';
/** The share flows talk to the host; without one there is nothing to send or accept. */
export const NOT_CONNECTED = 'Nod is not connected to a host';
/** A send with no recipient is a call the page should not have made. */
export const NO_RECIPIENTS = 'no recipients';
/** The sender's or the opener's E02 pair is not available (locked, never generated, unreadable). */
export const NO_KEY_PAIR = 'the key pair is not available';
/** The credential is in the index but its keychain value does not open. */
export const CREDENTIAL_NOT_FOUND = 'credential not found';
/** The session went away between the gate and the write. */
export const SESSION_LOCKED = 'session is locked';

/** The reason the operating system shows in each gate's dialog (K5, SP02 §9). */
export const GATE_REASON = {
  reveal: 'Authenticate to reveal a credential',
  copy: 'Authenticate to copy a credential',
  send: 'Authenticate to send a credential',
  accept: 'Authenticate to accept a shared credential',
} as const;

// ---------------------------------------------------------------- scope decision (SP06 §5)

/** One person as the scope decision sees them (`SnapshotPerson`, reduced to what matters). */
export interface ScopePerson {
  id: Id;
  roles: Id[];
  /** `PersonKind` on the wire: a newer host may add a kind this build does not know. */
  kind: string;
}

/** One tool as the scope decision sees it (`Entry`, reduced to what matters). */
export interface ScopeTool {
  scope?: 'org' | 'personal';
  /** The roles the tool is granted to (`Entry.roles` in the effective catalog). */
  roles: Id[];
}

export interface ScopeInput {
  scope: ShareScope;
  meId: Id;
  meRoles: Id[];
  recipient: ScopePerson;
  /** The effective catalog's entry, or `null` when this Nod cannot see the tool at all. */
  tool: ScopeTool | null;
}

export interface ScopeDecision {
  allowed: boolean;
  /** Why the scope leaves them out; `null` when it does not. */
  reason: string | null;
}

/**
 * SP06 §5 on the Nod's side, pure: `role` is a common role with the sender **and** the org tool
 * granted to one of the recipient's roles; `org` is the grant and a `member`; `blocked` allows no
 * one. The host repeats every one of these checks against its own rows, so a snapshot this side
 * believes cannot turn an ineligible recipient into a share.
 */
export function scopeDecision(input: ScopeInput): ScopeDecision {
  if (input.scope === 'blocked') return { allowed: false, reason: BLOCKED_CREDENTIAL };
  const { tool, recipient } = input;
  if (tool === null || tool.scope === 'personal') return { allowed: false, reason: TOOL_NOT_VISIBLE };
  if (recipient.id === input.meId) return { allowed: false, reason: CANNOT_SHARE_SELF };
  const granted = tool.roles.some((role) => recipient.roles.includes(role));
  if (!granted) return { allowed: false, reason: TOOL_NOT_VISIBLE };
  if (input.scope === 'org') {
    return recipient.kind === 'member'
      ? { allowed: true, reason: null }
      : { allowed: false, reason: ORG_MEMBERS_ONLY };
  }
  const common = recipient.roles.some((role) => input.meRoles.includes(role));
  return common ? { allowed: true, reason: null } : { allowed: false, reason: NO_COMMON_ROLE };
}

/** What the host's metadata says about one share (`IncomingShare`, reduced to what it must match). */
export interface ShareMeta {
  credentialId: string;
  toolId: string;
  scope: ShareScope;
  kind: 'send' | 'assign' | 'update';
  fromId: Id;
  toId: Id;
}

/**
 * SP06 §3 step 4 (and the scope of §5 that travels inside the payload): the opened payload must
 * name exactly the credential, tool, scope, kind, sender and recipient the host holds. A payload
 * that opens but says something else is still not this share.
 */
export function shareMatches(payload: SealPayload, meta: ShareMeta): boolean {
  return (
    payload.v === SEAL_VERSION &&
    payload.credentialId === meta.credentialId &&
    payload.toolId === meta.toolId &&
    payload.scope === meta.scope &&
    payload.kind === meta.kind &&
    payload.from === meta.fromId &&
    payload.to === meta.toId
  );
}

// ---------------------------------------------------------------- the module

export interface SharesDeps {
  repo: Repo;
  /** The unlocked person: whose vault, whose keys and whose inbox this is. */
  session: { current(): Person | null };
  /** The vault index and the keychain value of a credential (`backend/vault.ts`). */
  vault: Vault;
  /** The E02 pairs and the pin table (`backend/keys.ts`). */
  keys: Keys;
  /** The effective catalog entry (`backend/main.ts`'s `catalogEntryOf`): visibility and origin. */
  entry: (toolId: Id) => Entry | null;
  /** The pinned host connection, `null` when disconnected — or when the O2 gate is up. */
  connection: () => HostConnection | null;
  /**
   * K5: the biometric-or-password gate. It throws `authentication required` when this machine has
   * no biometrics and no password came in, and `authentication cancelled` when the person declined;
   * in both cases nothing is shown, copied, sent or accepted.
   */
  gate: (reason: string, password?: string) => Promise<void>;
  /** Called after an accepted share or a send, so the sync loop picks up the new holders. */
  onChanged?: () => void;
  now?: () => Date;
}

/** The K4/K6/K7 surface, as `backend/main.ts` wires it into the RPCs. */
export interface Shares {
  /** SP06 §5: every person the credential's scope could reach, with their key state. */
  recipients(toolId: Id): ShareRecipient[];
  /** SP06 §4: seals one copy per recipient and sends them. Gated. */
  send(toolId: Id, to: Id[], password?: string): Promise<{ sent: number }>;
  /** SP04 §2's `incomingShares`: the metadata of the open shares addressed to me. */
  inbox(): InboxShare[];
  /** SP06 §4: opens, validates, stores and accepts one share. Gated except an update already held. */
  accept(id: Id, password?: string): Promise<VaultItem>;
  /** SP06 §4: the recipient declines; the host purges the ciphertext. */
  decline(id: Id): Promise<true>;
  /** K6/SP06 §5: the owner (or an admin, for an assignment) sets the sharing scope. */
  setScope(toolId: Id, scope: ShareScope): VaultItem;
  /** K7/RF-54: the vault list with `holders` and `rotationPending` from the snapshot. */
  decorate(items: VaultItem[]): VaultItem[];
  /** K7: the holders of one credential, as the snapshot carries them (`[]` without a host). */
  holdersOf(credentialId: string): Holder[];
}

/** The JSON body of the cached snapshot, or `null` when there is none this side can read. */
function readSnapshot(repo: Repo): Snapshot | null {
  const row = repo.hostRecord();
  if (row === null || row.snapshot === null) return null;
  try {
    const body = JSON.parse(row.snapshot) as unknown;
    return typeof body === 'object' && body !== null ? (body as Snapshot) : null;
  } catch {
    return null;
  }
}

/** One roster entry with the fields the scope decision needs, or `null` for anything else. */
function readPerson(value: unknown): SnapshotPerson | null {
  if (typeof value !== 'object' || value === null) return null;
  if (!('id' in value) || typeof value.id !== 'string' || value.id === '') return null;
  if (!('name' in value) || typeof value.name !== 'string') return null;
  if (!('kind' in value) || typeof value.kind !== 'string') return null;
  if (!('roles' in value) || !Array.isArray(value.roles)) return null;
  const roles: string[] = [];
  for (const role of value.roles) {
    if (typeof role !== 'string') return null;
    roles.push(role);
  }
  return {
    id: value.id,
    name: value.name,
    roles,
    kind: value.kind,
    ...('x25519Public' in value && typeof value.x25519Public === 'string'
      ? { x25519Public: value.x25519Public }
      : {}),
    ...('ed25519Public' in value && typeof value.ed25519Public === 'string'
      ? { ed25519Public: value.ed25519Public }
      : {}),
  };
}

/** One open share with every field the accept path checks, or `null` for anything else. */
function readIncoming(value: unknown): IncomingShare | null {
  if (typeof value !== 'object' || value === null) return null;
  if (!('id' in value) || typeof value.id !== 'string' || value.id === '') return null;
  if (!('credentialId' in value) || typeof value.credentialId !== 'string' || value.credentialId === '') {
    return null;
  }
  if (!('toolId' in value) || typeof value.toolId !== 'string' || value.toolId === '') return null;
  if (!('from' in value) || typeof value.from !== 'string' || value.from === '') return null;
  if (!('sealed' in value) || typeof value.sealed !== 'string' || value.sealed === '') return null;
  if (!('createdAt' in value) || typeof value.createdAt !== 'string' || value.createdAt === '') {
    return null;
  }
  if (!('expiresAt' in value) || typeof value.expiresAt !== 'string' || value.expiresAt === '') {
    return null;
  }
  if (!('scope' in value) || (value.scope !== 'role' && value.scope !== 'blocked' && value.scope !== 'org')) {
    return null;
  }
  if (!('kind' in value) || (value.kind !== 'send' && value.kind !== 'assign' && value.kind !== 'update')) {
    return null;
  }
  return {
    id: value.id,
    credentialId: value.credentialId,
    toolId: value.toolId,
    from: value.from,
    sealed: value.sealed,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    scope: value.scope,
    kind: value.kind,
  };
}

export function createShares(deps: SharesDeps): Shares {
  const now = deps.now ?? (() => new Date());

  // ---------------------------------------------------------------- snapshot reads

  function roster(): SnapshotPerson[] {
    const people = readSnapshot(deps.repo)?.people;
    if (!Array.isArray(people)) return [];
    const rows: SnapshotPerson[] = [];
    for (const item of people) {
      const person = readPerson(item);
      if (person !== null) rows.push(person);
    }
    return rows;
  }

  function openShares(): IncomingShare[] {
    const shares = readSnapshot(deps.repo)?.incomingShares;
    if (!Array.isArray(shares)) return [];
    const rows: IncomingShare[] = [];
    for (const item of shares) {
      const share = readIncoming(item);
      if (share !== null) rows.push(share);
    }
    return rows;
  }

  function holdersOf(credentialId: string): Holder[] {
    const holders = readSnapshot(deps.repo)?.holders;
    if (holders === undefined || holders === null) return [];
    const rows = holders[credentialId];
    return Array.isArray(rows) ? rows : [];
  }

  function rotationPending(credentialId: string | null): boolean {
    if (credentialId === null) return false;
    const pending = readSnapshot(deps.repo)?.rotationPending;
    return Array.isArray(pending) && pending.includes(credentialId);
  }

  function requirePerson(): Person {
    const person = deps.session.current();
    if (person === null) throw new Error(SESSION_LOCKED);
    return person;
  }

  /**
   * SP06 §5: the roles the scope compares are the guild's. While connected they are `Snapshot.me`'s
   * (SP05 §2: the local row of a connected member carries none), and the local person's own only
   * without a host or for a snapshot of somebody else.
   */
  function myRoles(me: Person): Id[] {
    const meRow = readSnapshot(deps.repo)?.me;
    if (meRow !== undefined && meRow.id === me.id && Array.isArray(meRow.roles)) return meRow.roles;
    return me.roles;
  }

  function requireConnection(): HostConnection {
    const connection = deps.connection();
    if (connection === null) throw new Error(NOT_CONNECTED);
    return connection;
  }

  // ---------------------------------------------------------------- recipients (SP06 §5)

  function recipients(toolId: Id): ShareRecipient[] {
    const me = requirePerson();
    const item = deps.repo.vaultItem(me.id, toolId);
    if (item === null) throw new Error(UNKNOWN_CREDENTIAL);
    const entry = deps.entry(toolId);
    const tool = entry === null ? null : { scope: entry.scope, roles: entry.roles };
    const listed: ShareRecipient[] = [];
    for (const person of roster()) {
      if (person.id === me.id) continue;
      const pinned = deps.keys.peerKeyFor(person.id);
      const decision = scopeDecision({
        scope: item.scope,
        meId: me.id,
        meRoles: myRoles(me),
        recipient: { id: person.id, roles: person.roles, kind: person.kind },
        tool,
      });
      const keyStatus: ShareRecipient['keyStatus'] =
        pinned === null ? 'unknown' : pinned.status;
      const keyReason =
        keyStatus === 'changed' ? RECIPIENT_KEY_CHANGED : keyStatus === 'unknown' ? NO_PINNED_KEY : null;
      listed.push({
        personId: person.id,
        name: person.name,
        fingerprint: pinned === null ? null : pinned.fingerprint,
        keyStatus,
        allowed: decision.allowed && keyStatus === 'pinned',
        reason: decision.reason ?? keyReason,
      });
    }
    return listed;
  }

  // ---------------------------------------------------------------- send (SP06 §4)

  async function send(toolId: Id, to: Id[], password?: string): Promise<{ sent: number }> {
    const me = requirePerson();
    // K5/SP06 §4: the gate comes before the credential is read.
    await deps.gate(GATE_REASON.send, password);
    if (to.length === 0) throw new Error(NO_RECIPIENTS);
    const connection = requireConnection();
    const item = deps.repo.vaultItem(me.id, toolId);
    if (item === null) throw new Error(UNKNOWN_CREDENTIAL);
    // SP06 §5: `blocked` has no send action, and the host refuses the same credential.
    if (item.scope === 'blocked') throw new Error(BLOCKED_CREDENTIAL);
    const entry = deps.entry(toolId);
    if (entry === null || entry.scope === 'personal') throw new Error(NOT_SHAREABLE);
    const credential = await deps.vault.read(me.id, toolId);
    if (credential === null) throw new Error(CREDENTIAL_NOT_FOUND);

    const own = await deps.keys.ownPrivate();
    if (own === null) throw new Error(NO_KEY_PAIR);

    // K4/SP06 §4: the uuid is generated at the first share and kept on the item forever.
    const credentialId = item.credentialId ?? crypto.randomUUID();
    if (item.credentialId === null) deps.repo.setVaultCredential(me.id, toolId, credentialId);

    const tool = { scope: entry.scope, roles: entry.roles };
    const rosterRows = roster();
    const issuedAt = now().toISOString();
    const items: { to: Id; sealed: string }[] = [];
    for (const personId of to) {
      const person = rosterRows.find((row) => row.id === personId);
      if (person === undefined) throw new Error(UNKNOWN_RECIPIENT);
      const decision = scopeDecision({
        scope: item.scope,
        meId: me.id,
        meRoles: myRoles(me),
        recipient: { id: person.id, roles: person.roles, kind: person.kind },
        tool,
      });
      if (!decision.allowed) throw new Error(decision.reason ?? TOOL_NOT_VISIBLE);
      // SP06 §2/RF-45: seal to the pair this machine pinned, never to the snapshot's newer one.
      const pinned = deps.keys.peerKeyFor(personId);
      if (pinned === null) throw new Error(NO_PINNED_KEY);
      if (pinned.status !== 'pinned') throw new Error(RECIPIENT_KEY_CHANGED);
      const payload: SealPayload = {
        v: SEAL_VERSION,
        credentialId,
        toolId,
        toolOrigin: originOf(entry.url),
        label: item.label,
        username: credential.username,
        secret: credential.secret,
        // K6: the receiver stores this scope and can never re-send wider (SP06 §5).
        scope: item.scope === 'org' ? 'org' : 'role',
        from: me.id,
        to: personId,
        kind: 'send',
        issuedAt,
      };
      const sealed = await seal(payload, fromBase64url(pinned.x25519), own.ed25519Private);
      items.push({ to: personId, sealed });
    }

    await connection.sendShares({
      credentialId,
      toolId,
      scope: item.scope,
      kind: 'send',
      items,
    });
    deps.onChanged?.();
    return { sent: items.length };
  }

  // ---------------------------------------------------------------- inbox (SP04 §2)

  function inbox(): InboxShare[] {
    const me = requirePerson();
    const people = roster();
    return openShares().map((share) => {
      const from = people.find((person) => person.id === share.from);
      const entry = deps.entry(share.toolId);
      return {
        id: share.id,
        credentialId: share.credentialId,
        toolId: share.toolId,
        toolTitle: entry === null ? null : entry.title,
        fromId: share.from,
        fromName: from === undefined ? share.from : from.name,
        scope: share.scope,
        kind: share.kind,
        createdAt: share.createdAt,
        expiresAt: share.expiresAt,
      };
    });
  }

  // ---------------------------------------------------------------- accept (SP06 §3–§4)

  /** SP06 §3: any failure declines with `invalid share`; a decline that fails changes nothing. */
  async function declineInvalid(connection: HostConnection | null, id: Id): Promise<never> {
    try {
      await connection?.declineShare(id);
    } catch {
      // The local verdict stands: the share is not valid, whether or not the host heard the decline.
    }
    throw new Error(INVALID_SHARE);
  }

  async function accept(id: Id, password?: string): Promise<VaultItem> {
    const me = requirePerson();
    const share = openShares().find((row) => row.id === id);
    if (share === undefined) throw new Error(UNKNOWN_SHARE);

    const existing = deps.repo.vaultItem(me.id, share.toolId);
    const held = existing !== null && existing.credentialId === share.credentialId;
    // SP06 §4: accepting an update to a credential already held shows nothing, so no gate.
    if (share.kind !== 'update' || !held) await deps.gate(GATE_REASON.accept, password);

    // The verdict of SP06 §3 is local: it is decided (and the share declined, when there is a host
    // to hear it) before the connection is required for the accept itself.
    const connection = deps.connection();
    const own = await deps.keys.ownPrivate();
    if (own === null) return await declineInvalid(connection, id);
    const pinned = deps.keys.peerKeyFor(share.from);
    if (pinned === null || pinned.status !== 'pinned') return await declineInvalid(connection, id);

    let payload: SealPayload | null = null;
    try {
      payload = await openSealed(share.sealed, {
        recipientPrivateKey: own.x25519Private,
        recipientPublicKey: own.x25519Public,
        senderPublicKey: fromBase64url(pinned.ed25519),
        credentialId: share.credentialId,
        to: me.id,
      });
    } catch {
      payload = null;
    }
    if (payload === null) return await declineInvalid(connection, id);

    const entry = deps.entry(payload.toolId);
    // SP06 §3 steps 4–5: the metadata of the host, the visibility of the tool in my catalog and
    // the origin the credential will be bound to.
    if (
      !shareMatches(payload, {
        credentialId: share.credentialId,
        toolId: share.toolId,
        scope: share.scope,
        kind: share.kind,
        fromId: share.from,
        toId: me.id,
      }) ||
      entry === null ||
      entry.scope === 'personal' ||
      originOf(entry.url) !== payload.toolOrigin
    ) {
      return await declineInvalid(connection, id);
    }

    // The value is in memory, every check passed and the share is valid: the accept needs the host,
    // so a missing connection refuses here — after the verdict, before any write.
    const host = requireConnection();
    const previousCredential = existing === null ? null : await deps.vault.read(me.id, share.toolId);
    await deps.vault.save(me.id, {
      toolId: share.toolId,
      username: payload.username,
      secret: payload.secret,
      label: payload.label,
      credentialId: payload.credentialId,
      // SP06 §5: the scope travels inside the payload, never wider than the sender's.
      scope: payload.scope,
    });
    try {
      await host.acceptShare(id);
    } catch (error) {
      if (existing === null || previousCredential === null) {
        await deps.vault.remove(me.id, share.toolId);
      } else {
        await deps.vault.save(me.id, {
          toolId: share.toolId,
          username: previousCredential.username,
          secret: previousCredential.secret,
          label: existing.label,
        });
        deps.repo.setVaultSharing(me.id, share.toolId, {
          credentialId: existing.credentialId,
          scope: existing.scope,
        });
      }
      throw error;
    }
    deps.onChanged?.();
    const stored = deps.repo.vaultItem(me.id, share.toolId);
    if (stored === null) throw new Error(UNKNOWN_CREDENTIAL);
    return decorateOne(stored);
  }

  async function decline(id: Id): Promise<true> {
    requirePerson();
    const connection = requireConnection();
    await connection.declineShare(id);
    deps.onChanged?.();
    return true;
  }

  // ---------------------------------------------------------------- scope and the vault view

  function setScope(toolId: Id, scope: ShareScope): VaultItem {
    const me = requirePerson();
    if (scope !== 'role' && scope !== 'blocked' && scope !== 'org') throw new Error(INVALID_SCOPE);
    const item = deps.repo.vaultItem(me.id, toolId);
    if (item === null) throw new Error(UNKNOWN_CREDENTIAL);
    // SP06 §5: the owner of the credential sets the scope. An item that never travelled has no
    // holder row yet, so its person is its owner by definition.
    if (item.credentialId !== null) {
      const owner = holdersOf(item.credentialId).some(
        (holder) => holder.personId === me.id && holder.owner && holder.removedAt === null,
      );
      if (!owner) throw new Error(OWNER_ONLY);
    }
    deps.repo.setVaultScope(me.id, toolId, scope);
    const stored = deps.repo.vaultItem(me.id, toolId);
    if (stored === null) throw new Error(UNKNOWN_CREDENTIAL);
    return decorateOne(stored);
  }

  function decorateOne(item: VaultItem): VaultItem {
    return {
      ...item,
      holders: item.credentialId === null ? [] : holdersOf(item.credentialId),
      rotationPending: rotationPending(item.credentialId),
    };
  }

  function decorate(items: VaultItem[]): VaultItem[] {
    return items.map(decorateOne);
  }

  return { recipients, send, inbox, accept, decline, setScope, decorate, holdersOf };
}
