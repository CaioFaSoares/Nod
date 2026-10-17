// Credential sharing of the Nod — K4, K6 and K7 of `docs/specs/SP06-credential-sharing.md`
// (§3 the sealed share, §4 the flows, §5 the scope).
//
// The host knows the metadata of a share and never its content: this file seals one copy per
// recipient (`shared/seal.ts`), writes the copy into the vault of the receiver and asks the host to
// record the accept. The scope of SP06 §5 is decided twice — here, against the verified snapshot,
// and again by the host on its own data — and both sides refuse with the same English reason.
//
// Ordering of an accept (SP06 §3: "any failure declines with `invalid share`; no partial state"):
//   1. find the share in the snapshot and decide whether the gate is needed (M2: an own key that did
//      not open, or a sender with no pin yet, refuses without declining; H1: an `update` is silent
//      only when its sender is the credential's live owner holder);
//   2. open and validate every SP06 §3 step (1–5) — nothing is written anywhere yet; L1: an `update`
//      not newer than the last applied payload is a replay and declines here;
//   3. write the vault copy (the keychain value and the index row);
//   4. `POST /v1/shares/:id/accept`;
//   5. on a failed accept, restore the previous item (or remove the new one) and rethrow.
// A share that fails step 2 is declined on the host and answers `invalid share`; a share whose
// accept the host refuses leaves the vault exactly as it was. L4: accepts of one share id are run
// one at a time; L3: a settled share drops its ciphertext from the cached snapshot at once.
//
// Nothing here imports `tjs` or `tiny`: the repository, the vault, the key pairs, the catalog and
// the connection arrive through `deps`, so `bun test` drives the whole module against a real
// database, real crypto and the real host app. No secret, username, sealed body or key reaches an
// error message, a log or a row.
import { originOf } from '../shared/catalog';
import { fromBase64url } from '../shared/encoding';
import { open as openSealed, seal, SEAL_VERSION } from '../shared/seal';
import type { SealPayload } from '../shared/seal';
import type { Holder, IncomingShare, MissingCopy, ShareScope, Snapshot, SnapshotPerson } from '../shared/host-api';
import type {
  Entry,
  EventType,
  Id,
  InboxShare,
  MissingCopyView,
  Person,
  ShareRecipient,
  VaultItem,
} from '../shared/types';
import { HostError, type HostConnection } from './host-client';
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
/**
 * K9/SP06 §4: the saved value could not be re-sealed — offline, a missing key or a host that
 * refused the update. The credential is saved; the holders get it at the next sync.
 */
export const UPDATE_PENDING = 'saved — holders get the new value at the next sync';
/** K9/RF-45: a holder's pinned key is not the snapshot's, so the new value was not sealed to them. */
export const UPDATE_KEY_CHANGED = 'saved — a holder\'s key changed and was skipped';
/** K8/SP06 §4: an assignment is an admin's, and the host refuses anybody else the same way. */
export const ADMIN_ONLY = 'admin only';
/** K8: an assignment names a role or a person; without either there is nothing to assign to. */
export const NO_ASSIGNMENT_TARGET = 'assign to a role or to a person';

/**
 * K9: the one `meta` row that remembers the updates a save could not deliver — a JSON map of
 * `credentialId → toolId`. No schema change: it is a `meta` key like the rest.
 */
const PENDING_UPDATES_KEY = 'shares.pendingUpdates';

/**
 * L1: the second `meta` row of the share flow — a JSON map of `credentialId → issuedAt` of the last
 * payload this Nod applied to that credential. An `update` whose `issuedAt` is not newer is a replay
 * and is refused. No schema change: a `meta` key like the rest.
 */
const APPLIED_ISSUED_AT_KEY = 'shares.appliedIssuedAt';

/**
 * F4/M4: the third `meta` row of the share flow — a JSON map of `credentialId → { toolId, scope }`
 * of the scope changes a set could not deliver (no connection, or a host that could not be
 * reached). The next sync's `retryPending` carries them, exactly as it does the pending updates. A
 * credential the host has no holder row for answers `404 unknown credential` and its scope stays
 * local: there the scope travels with the first send. No schema change: a `meta` key like the rest.
 */
const PENDING_SCOPES_KEY = 'shares.scope.pending';

/** The reason the operating system shows in each gate's dialog (K5, SP02 §9). */
export const GATE_REASON = {
  reveal: 'Authenticate to reveal a credential',
  copy: 'Authenticate to copy a credential',
  send: 'Authenticate to send a credential',
  accept: 'Authenticate to accept a shared credential',
  /** K8/SP06 §4: the admin's Nod seals the assigned copies behind the same gate. */
  assign: 'Authenticate to send the assigned copies',
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
  /** K6/SP06 §5: the owner (or an admin, for an assignment) sets the sharing scope. M4: async — a
   * credential with holder rows carries the scope on the host first. */
  setScope(toolId: Id, scope: ShareScope): Promise<VaultItem>;
  /**
   * K9/SP06 §4: the owner's save re-seals the new value to every live holder with `kind: 'update'`.
   * The person typed the secret, so the save is the gate (SP06 gates the send, not the edit); a
   * holder whose key changed is skipped, an unreachable host leaves a pending marker. Answers a
   * warning (`UPDATE_*`) or `null`.
   */
  update(personId: Id, item: VaultItem): Promise<string | null>;
  /** K9: retries, at a sync, the updates a save could not deliver. Nothing without a connection. */
  retryPending(): Promise<void>;
  /** K9/SP06 §4: applies the incoming `update` shares of a credential this Nod already holds. */
  applyUpdates(): Promise<void>;
  /** K9/SP06 §4: the owner (or an admin) revokes one holder over the host; the snapshot carries it. */
  removeHolder(toolId: Id, personId: Id): Promise<VaultItem>;
  /**
   * K8/SP06 §4, RF-47: the admin assigns one credential to a role (`roleId`) or to one person
   * (`personId`) and, in the same gated step, seals a copy to every member still without one.
   * `assigned: false` takes the role's assignment away and seals nothing. Gated only when it seals.
   * M6: answers what was sealed and skipped; a direct `personId` whose copy reached nobody throws the
   * key-state reason instead of reporting a success that never happened.
   */
  assign(
    input: { toolId: Id; roleId: Id | null; personId: Id | null; assigned: boolean },
    password?: string,
  ): Promise<{ sent: number; skipped: number }>;
  /** K8/RF-47: the members of the assigned roles still without a copy, as the last read left them. */
  missing(): MissingCopyView[];
  /** K8/SP06 §4: seals one `assign` copy to every reachable member of the missing list. Gated. */
  sealMissing(password?: string): Promise<{ sent: number; skipped: number }>;
  /** K8/RF-47: one `GET /v1/admin/assignments/missing` for the admin's Nod. Best effort. */
  refreshAssignments(): Promise<void>;
  /** K8: how many members the last missing-copy read found (`host.state` carries it). */
  missingCount(): number;
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

  /**
   * E02 §6, canonico §13: one audit event per share action, on the Nod's existing path — the row is
   * local and the normal Sync push carries it to the host (SP04 §5). The detail of an event never
   * holds content: no username, secret, label, sealed body or key, only an id and the scope/kind
   * (RF-44, canonico §13's "credencial nunca é parâmetro de evento").
   */
  function record(
    type: EventType,
    personId: Id,
    toolId: Id | null,
    detail: string | null,
    result: string | null = null,
  ): void {
    deps.repo.addEvent({ personId, toolId, type, url: null, result, detail });
  }

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

  /**
   * H1: whether `personId` is the live owner holder of `credentialId` in the verified snapshot. Only
   * the owner's `update` is applied silently; any other sender's stays in the inbox for the gate.
   */
  function isLiveOwner(credentialId: string, personId: Id): boolean {
    return holdersOf(credentialId).some(
      (holder) => holder.personId === personId && holder.owner && holder.removedAt === null,
    );
  }

  /** L1: the `meta` map of the last payload this Nod applied per credential — credentialId → issuedAt. */
  function readAppliedIssuedAt(): Record<string, string> {
    const raw = deps.repo.meta(APPLIED_ISSUED_AT_KEY);
    if (raw === null) return {};
    try {
      const value = JSON.parse(raw) as unknown;
      if (typeof value !== 'object' || value === null) return {};
      const map: Record<string, string> = {};
      for (const [credentialId, issuedAt] of Object.entries(value)) {
        if (typeof issuedAt === 'string' && issuedAt !== '') map[credentialId] = issuedAt;
      }
      return map;
    } catch {
      return {};
    }
  }

  /** L1: records the payload just applied; an older or equal `issuedAt` never moves the mark back. */
  function recordAppliedIssuedAt(credentialId: string, issuedAt: string): void {
    const map = readAppliedIssuedAt();
    const last = map[credentialId];
    if (last !== undefined && !(issuedAt > last)) return;
    deps.repo.setMeta(APPLIED_ISSUED_AT_KEY, JSON.stringify({ ...map, [credentialId]: issuedAt }));
  }

  /**
   * L3: removes the ciphertext of the shares this Nod already settled from the cached snapshot, so
   * an accepted or declined `sealed` body does not linger in the `host` row until the next snapshot.
   * The row is written through `saveHostSnapshot` — nothing re-verifies the cached body (the
   * signature is checked on receipt in `backend/host-client.ts`), and every reader here needs only
   * the metadata — and `last_error` is restored so this local edit never masks a sync failure.
   */
  function stripSettledSealed(ids: Id[]): void {
    if (ids.length === 0) return;
    const record = deps.repo.hostRecord();
    if (record === null || record.snapshot === null || record.version === null || record.issuedAt === null) {
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(record.snapshot) as unknown;
    } catch {
      return;
    }
    if (typeof body !== 'object' || body === null || !('incomingShares' in body)) return;
    const shares = body.incomingShares;
    if (!Array.isArray(shares)) return;
    const settled = new Set(ids);
    let changed = false;
    for (const share of shares) {
      if (typeof share !== 'object' || share === null) continue;
      if (!('id' in share) || typeof share.id !== 'string' || !settled.has(share.id)) continue;
      if (!('sealed' in share) || typeof share.sealed !== 'string' || share.sealed === '') continue;
      share.sealed = '';
      changed = true;
    }
    if (!changed) return;
    deps.repo.saveHostSnapshot({
      snapshot: JSON.stringify(body),
      version: record.version,
      issuedAt: record.issuedAt,
      syncedAt: record.lastSyncAt ?? record.issuedAt,
    });
    if (record.lastError !== null) deps.repo.saveHostError(record.lastError);
  }

  /** L4: one in-flight accept/applyUpdates per share id, so a second run cannot double-apply. */
  const acceptInFlight = new Map<Id, Promise<unknown>>();
  function serialized<T>(id: Id, run: () => Promise<T>): Promise<T> {
    const previous = acceptInFlight.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(run);
    acceptInFlight.set(id, next);
    const clear = (): void => {
      if (acceptInFlight.get(id) === next) acceptInFlight.delete(id);
    };
    void next.then(clear, clear);
    return next;
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

    // K4/SP06 §4: the uuid is generated at the first share and kept on the item forever; M6/L6: it is
    // persisted only after the host took the copies, so a refused first send leaves no orphan id.
    const credentialId = item.credentialId ?? crypto.randomUUID();

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
    // M6/L6: the host accepted the copies, so the generated uuid is safe to keep on the item now.
    if (item.credentialId === null) deps.repo.setVaultCredential(me.id, toolId, credentialId);
    // E02 §6: one `share.sent` per recipient, after the host took the copies; the detail names the
    // recipient and the scope/kind, never a value of the credential.
    const scope = item.scope === 'org' ? 'org' : 'role';
    for (const sent of items) record('share.sent', me.id, toolId, `${sent.to} scope=${scope} kind=send`);
    deps.onChanged?.();
    return { sent: items.length };
  }

  // ---------------------------------------------------------------- update and revoke (K9, SP06 §4)

  /** K9: the `meta` map of updates a save could not deliver — credentialId → toolId. */
  function readPendingUpdates(): Record<string, Id> {
    const raw = deps.repo.meta(PENDING_UPDATES_KEY);
    if (raw === null) return {};
    try {
      const value = JSON.parse(raw) as unknown;
      if (typeof value !== 'object' || value === null) return {};
      const map: Record<string, Id> = {};
      for (const [credentialId, toolId] of Object.entries(value)) {
        if (typeof toolId === 'string' && toolId !== '') map[credentialId] = toolId;
      }
      return map;
    } catch {
      return {};
    }
  }

  /** The pending marker, rewritten whole (one small JSON row; clearing the last key leaves `{}`). */
  function writePendingUpdates(map: Record<string, Id>): void {
    deps.repo.setMeta(PENDING_UPDATES_KEY, JSON.stringify(map));
  }

  /**
   * K9/SP06 §4: seals the stored value of `item` to the live holders and posts one `update` share
   * per holder. The owner typed the secret, so the save is the gate — SP06 §4 gates the send, and
   * an edit of an already-held credential shows nothing on either side. A holder whose pinned key
   * changed is skipped and warned about (RF-45); a value or a host that cannot be reached leaves a
   * pending marker for the next sync.
   */
  async function sealUpdate(
    personId: Id,
    item: VaultItem,
    credentialId: string,
    live: Holder[],
  ): Promise<string | null> {
    const connection = deps.connection();
    const entry = deps.entry(item.toolId);
    const own = connection === null ? null : await deps.keys.ownPrivate();
    const credential = connection === null ? null : await deps.vault.read(personId, item.toolId);
    if (
      connection === null ||
      entry === null ||
      entry.scope === 'personal' ||
      own === null ||
      credential === null
    ) {
      writePendingUpdates({ ...readPendingUpdates(), [credentialId]: item.toolId });
      return UPDATE_PENDING;
    }
    const issuedAt = now().toISOString();
    const items: { to: Id; sealed: string }[] = [];
    let skipped = 0;
    for (const holder of live) {
      // SP06 §2/RF-45: seal to the pair this machine pinned, never to a newer snapshot key.
      const pinned = deps.keys.peerKeyFor(holder.personId);
      if (pinned === null || pinned.status !== 'pinned') {
        skipped += 1;
        continue;
      }
      const payload: SealPayload = {
        v: SEAL_VERSION,
        credentialId,
        toolId: item.toolId,
        toolOrigin: originOf(entry.url),
        label: item.label,
        username: credential.username,
        secret: credential.secret,
        // K6/SP06 §5: the receiver stores this scope and can never re-send wider.
        scope: item.scope === 'org' ? 'org' : 'role',
        from: personId,
        to: holder.personId,
        kind: 'update',
        issuedAt,
      };
      items.push({
        to: holder.personId,
        sealed: await seal(payload, fromBase64url(pinned.x25519), own.ed25519Private),
      });
    }
    try {
      if (items.length > 0) {
        await connection.sendShares({
          credentialId,
          toolId: item.toolId,
          scope: item.scope,
          kind: 'update',
          items,
        });
        // E02 §6: an update fan-out is a `share.sent` per holder, kind `update` in the detail.
        const scope = item.scope === 'org' ? 'org' : 'role';
        for (const sent of items) {
          record('share.sent', personId, item.toolId, `${sent.to} scope=${scope} kind=update`);
        }
      }
    } catch {
      writePendingUpdates({ ...readPendingUpdates(), [credentialId]: item.toolId });
      return UPDATE_PENDING;
    }
    const pending = { ...readPendingUpdates() };
    delete pending[credentialId];
    writePendingUpdates(pending);
    return skipped === 0 ? null : UPDATE_KEY_CHANGED;
  }

  /**
   * RF-48: the explicit "I saved a new secret" signal (`POST /v1/credentials/:id/rotated`), for a
   * credential the owner revoked a holder from. It is what clears the host's `rotationPending` when
   * the fan-out has no recipient — but it is sent whenever a revoked holder exists, whether or not
   * update shares went out (an owner's save after a revocation is a rotation). Offline or a refused
   * host leaves the pending marker, so the next sync's `retryPending` retries the whole save.
   */
  async function signalRotated(credentialId: string, toolId: Id): Promise<string | null> {
    const connection = deps.connection();
    if (connection === null) {
      writePendingUpdates({ ...readPendingUpdates(), [credentialId]: toolId });
      return UPDATE_PENDING;
    }
    try {
      await connection.markRotated(credentialId);
    } catch {
      writePendingUpdates({ ...readPendingUpdates(), [credentialId]: toolId });
      return UPDATE_PENDING;
    }
    const pending = { ...readPendingUpdates() };
    delete pending[credentialId];
    writePendingUpdates(pending);
    return null;
  }

  /**
   * K9/SP06 §4: a save of an item the owner already shared re-seals the new value to the live
   * holders. A credential that never travelled (no `credentialId`), a `blocked` one and a save by
   * somebody other than the owner holder are none of this flow's business.
   */
  async function update(personId: Id, item: VaultItem): Promise<string | null> {
    const credentialId = item.credentialId;
    if (credentialId === null || item.scope === 'blocked') return null;
    const holders = holdersOf(credentialId);
    if (!isLiveOwner(credentialId, personId)) return null;
    const live = holders.filter(
      (holder) => holder.personId !== personId && holder.removedAt === null,
    );
    // RF-48: a removed holder means the credential is `rotationPending` and this save rotates it.
    const revoked = holders.some(
      (holder) => holder.personId !== personId && holder.removedAt !== null,
    );
    if (live.length === 0) {
      if (!revoked) {
        const pending = { ...readPendingUpdates() };
        delete pending[credentialId];
        writePendingUpdates(pending);
        return null;
      }
      // Nobody to fan out to, so the `update` share the host clears on can never exist: the explicit
      // signal is the only witness that the owner saved a new secret (`docs/handovers/k10-smoke.md`
      // finding 1).
      return await signalRotated(credentialId, item.toolId);
    }
    const warning = await sealUpdate(personId, item, credentialId, live);
    if (warning === UPDATE_PENDING) return warning;
    if (revoked) {
      // The fan-out is host-side proof when it went out, but it does not when every holder was
      // skipped (RF-45), so the explicit signal is sent beside it — idempotent, and the owner's save
      // is the rotation.
      const signal = await signalRotated(credentialId, item.toolId);
      if (signal !== null) return signal;
    }
    return warning;
  }

  /** F4/M4: the `meta` map of scope changes a set could not deliver — credentialId → its target. */
  function readPendingScopes(): Record<string, { toolId: Id; scope: ShareScope }> {
    const raw = deps.repo.meta(PENDING_SCOPES_KEY);
    if (raw === null) return {};
    try {
      const value = JSON.parse(raw) as unknown;
      if (typeof value !== 'object' || value === null) return {};
      const map: Record<string, { toolId: Id; scope: ShareScope }> = {};
      for (const [credentialId, entry] of Object.entries(value)) {
        if (typeof entry !== 'object' || entry === null) continue;
        const { toolId, scope } = entry as { toolId?: unknown; scope?: unknown };
        if (typeof toolId !== 'string' || toolId === '') continue;
        if (scope !== 'role' && scope !== 'org' && scope !== 'blocked') continue;
        map[credentialId] = { toolId, scope };
      }
      return map;
    } catch {
      return {};
    }
  }

  /** The scope marker, rewritten whole (one small JSON row; clearing the last key leaves `{}`). */
  function writePendingScopes(map: Record<string, { toolId: Id; scope: ShareScope }>): void {
    deps.repo.setMeta(PENDING_SCOPES_KEY, JSON.stringify(map));
  }

  /** F4: the marker of one credential — `pushScope` sets it on a failure and clears it on success. */
  function clearPendingScope(credentialId: string): void {
    const pending = { ...readPendingScopes() };
    delete pending[credentialId];
    writePendingScopes(pending);
  }

  /**
   * M4/F4/SP06 §5: carries one scope change to the host. The route is `PUT /v1/credentials/:id/scope`
   * and answers `404 unknown credential` for a credential the host has no holder row for — the scope
   * then stays local, because a credential that never travelled carries its scope on the first send.
   * Any other refusal is the host's own and is rethrown; a network failure (a `HostError` with no
   * status, or no connection at all) leaves the `shares.scope.pending` marker that the next sync's
   * `retryPending` retries.
   */
  async function pushScope(credentialId: string, toolId: Id, scope: ShareScope): Promise<void> {
    const connection = deps.connection();
    if (connection === null) {
      writePendingScopes({ ...readPendingScopes(), [credentialId]: { toolId, scope } });
      return;
    }
    try {
      await connection.setCredentialScope(credentialId, scope);
    } catch (error) {
      if (error instanceof HostError && error.status === 404) {
        clearPendingScope(credentialId);
        return;
      }
      if (!(error instanceof HostError) || error.status !== null) throw error;
      writePendingScopes({ ...readPendingScopes(), [credentialId]: { toolId, scope } });
      return;
    }
    clearPendingScope(credentialId);
  }

  /**
   * K9/F4: one retry of every pending update and every pending scope, on a sync. Nothing without a
   * connection. A scope the host refuses outright is dropped — retrying it would never help — while
   * a network failure leaves the marker for the next run.
   */
  async function retryPending(): Promise<void> {
    if (deps.connection() === null) return;
    const me = deps.session.current();
    if (me === null) return;
    for (const [credentialId, toolId] of Object.entries(readPendingUpdates())) {
      const item = deps.repo.vaultItem(me.id, toolId);
      if (item === null || item.credentialId !== credentialId) {
        const cleared = { ...readPendingUpdates() };
        delete cleared[credentialId];
        writePendingUpdates(cleared);
        continue;
      }
      await update(me.id, item);
    }
    for (const [credentialId, entry] of Object.entries(readPendingScopes())) {
      const item = deps.repo.vaultItem(me.id, entry.toolId);
      if (item === null || item.credentialId !== credentialId) {
        clearPendingScope(credentialId);
        continue;
      }
      try {
        await pushScope(credentialId, entry.toolId, entry.scope);
      } catch {
        clearPendingScope(credentialId);
      }
    }
  }

  /**
   * K9/SP06 §4, E02 M3: an `update` of a credential this Nod already holds is applied without a
   * gate and without showing anything — the receiver has the item, only its value moved. Every
   * other share (a `send`, an `assign`, an `update` of a credential not held here) stays in the
   * inbox for the person to answer. Runs on each applied snapshot (`backend/main.ts`).
   *
   * H1: silent only when the sender is the credential's live owner holder in the verified snapshot;
   * any other sender's `update` stays in the inbox for the gated accept, so a member who guessed a
   * `credentialId` cannot overwrite every holder without a prompt.
   */
  async function applyUpdates(): Promise<void> {
    const me = deps.session.current();
    if (me === null || deps.connection() === null) return;
    for (const share of openShares()) {
      if (share.kind !== 'update') continue;
      if (!isLiveOwner(share.credentialId, share.from)) continue;
      const existing = deps.repo.vaultItem(me.id, share.toolId);
      if (existing === null || existing.credentialId !== share.credentialId) continue;
      try {
        await accept(share.id);
      } catch {
        // The share stays in the inbox; the host's next snapshot says what is left of it.
      }
    }
  }

  /**
   * K9/SP06 §4: the owner revokes one holder (`DELETE /v1/credentials/:id/holders/:personId`). The
   * host sets `removed_at`, and the owner's next snapshot marks the credential `rotationPending`
   * until a new secret is saved. The owner check is the host's; the answer is the fresh item.
   */
  async function removeHolder(toolId: Id, personId: Id): Promise<VaultItem> {
    const me = requirePerson();
    const item = deps.repo.vaultItem(me.id, toolId);
    if (item === null || item.credentialId === null) throw new Error(UNKNOWN_CREDENTIAL);
    const connection = requireConnection();
    await connection.removeHolder(item.credentialId, personId);
    deps.onChanged?.();
    const stored = deps.repo.vaultItem(me.id, toolId);
    if (stored === null) throw new Error(UNKNOWN_CREDENTIAL);
    return decorateOne(stored);
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

  /**
   * SP06 §3: any failure declines with `invalid share`; a decline that fails changes nothing. E02 §6:
   * the refusal is a `share.declined` event with `result` = `invalid share`, the only place that
   * reason is carried; the detail is the share id and never a value.
   */
  async function declineInvalid(me: Person, connection: HostConnection | null, id: Id): Promise<never> {
    try {
      await connection?.declineShare(id);
    } catch {
      // The local verdict stands: the share is not valid, whether or not the host heard the decline.
    }
    const share = openShares().find((row) => row.id === id);
    // L3: the share is settled; its ciphertext does not stay in the cached row until the next sync.
    stripSettledSealed([id]);
    record('share.declined', me.id, share?.toolId ?? null, id, INVALID_SHARE);
    throw new Error(INVALID_SHARE);
  }

  /** L4: one accept per share id at a time; a concurrent run waits for the first instead of racing it. */
  async function accept(id: Id, password?: string): Promise<VaultItem> {
    return await serialized(id, () => acceptOnce(id, password));
  }

  async function acceptOnce(id: Id, password?: string): Promise<VaultItem> {
    const me = requirePerson();
    const share = openShares().find((row) => row.id === id);
    if (share === undefined) throw new Error(UNKNOWN_SHARE);

    const existing = deps.repo.vaultItem(me.id, share.toolId);
    const held = existing !== null && existing.credentialId === share.credentialId;
    // SP06 §4: accepting an update to a credential already held shows nothing, so no gate.
    // H1: that holds only when the sender is the credential's live owner holder in the verified
    // snapshot; any other `update` is gated like a fresh share and can never be applied silently.
    const silent = share.kind === 'update' && held && isLiveOwner(share.credentialId, share.from);
    if (!silent) await deps.gate(GATE_REASON.accept, password);

    // The verdict of SP06 §3 is local: it is decided (and the share declined, when there is a host
    // to hear it) before the connection is required for the accept itself.
    const connection = deps.connection();
    const own = await deps.keys.ownPrivate();
    // M2: a keychain value that does not open (locked, missing) is transient, not a verdict — refuse
    // and leave the share in the inbox instead of destroying it.
    if (own === null) throw new Error(NO_KEY_PAIR);
    const pinned = deps.keys.peerKeyFor(share.from);
    // M2: without a pinned pair there is nothing to verify the sender's signature against; leave the
    // share in the inbox so a later pin can still open it.
    if (pinned === null) throw new Error(NO_PINNED_KEY);
    // M2/SP06 §3 step 2: a sender flagged `changed` is still verified with the PINNED (old) key, so a
    // share signed before the rotation still opens; only a real open failure declines.

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
    if (payload === null) return await declineInvalid(me, connection, id);

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
      return await declineInvalid(me, connection, id);
    }

    // L1: an `update` must carry an `issuedAt` newer than the last payload applied to this
    // credential; an older or equal one is a replay that would roll the value back.
    if (share.kind === 'update') {
      const last = readAppliedIssuedAt()[share.credentialId];
      if (last !== undefined && !(payload.issuedAt > last)) {
        return await declineInvalid(me, connection, id);
      }
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
    // E02 §6: the accept landed on the host and in the vault; the event names the share, never a value.
    record('share.accepted', me.id, share.toolId, share.id);
    // L1: remember the payload just applied, so a replayed `update` is refused.
    recordAppliedIssuedAt(payload.credentialId, payload.issuedAt);
    // L3: the share is settled; its ciphertext does not stay in the cached row until the next sync.
    stripSettledSealed([id]);
    deps.onChanged?.();
    const stored = deps.repo.vaultItem(me.id, share.toolId);
    if (stored === null) throw new Error(UNKNOWN_CREDENTIAL);
    return decorateOne(stored);
  }

  async function decline(id: Id): Promise<true> {
    const me = requirePerson();
    const connection = requireConnection();
    await connection.declineShare(id);
    // E02 §6: the recipient's own decline; the detail is the share id, never a value.
    const share = openShares().find((row) => row.id === id);
    // L3: the share is settled; its ciphertext does not stay in the cached row until the next sync.
    stripSettledSealed([id]);
    record('share.declined', me.id, share?.toolId ?? null, id);
    deps.onChanged?.();
    return true;
  }

  // ---------------------------------------------------------------- assignments (K8, SP06 §4)

  /**
   * K8/RF-47: the host's missing-copy rows, as the last `GET /v1/admin/assignments/missing` left
   * them. Memory only — the host is the source of truth and every sync rebuilds it, so nothing of
   * it lands in a row. Empty for a member, for a Nod without a host and for a locked session.
   */
  let missingRows: MissingCopy[] = [];

  /** One member an `assign` copy has to reach (`MissingCopy` reduced to what the seal needs). */
  interface AssignTarget {
    credentialId: string;
    toolId: Id;
    personId: Id;
  }

  /**
   * K8: whether this session's person is the guild's admin. The verified snapshot's `me` is the
   * last word (SP04 §2, F2) when it is this person's; the local row is the fallback for a Nod whose
   * session is not the snapshot's.
   */
  function amAdmin(me: Person): boolean {
    const row = readSnapshot(deps.repo)?.me;
    if (row !== undefined && row.id === me.id && typeof row.admin === 'boolean') return row.admin;
    return me.admin;
  }

  async function refreshAssignments(): Promise<void> {
    const me = deps.session.current();
    if (me === null || !amAdmin(me)) {
      missingRows = [];
      return;
    }
    const connection = deps.connection();
    if (connection === null) return;
    try {
      missingRows = await connection.missingCopies();
    } catch {
      // K8/SP04 §3: the read is best effort. A host that cannot be reached leaves the list of the
      // last sync in place, and the state it feeds keeps its count.
    }
  }

  function missing(): MissingCopyView[] {
    requirePerson();
    const people = roster();
    return missingRows.map((row) => {
      const person = people.find((entry) => entry.id === row.personId);
      const tool = deps.entry(row.toolId);
      const pinned = deps.keys.peerKeyFor(row.personId);
      return {
        credentialId: row.credentialId,
        toolId: row.toolId,
        toolTitle: tool === null ? null : tool.title,
        roleId: row.roleId,
        personId: row.personId,
        personName: person === undefined ? row.personId : person.name,
        keyStatus: pinned === null ? 'unknown' : pinned.status,
      };
    });
  }

  function missingCount(): number {
    return missingRows.length;
  }

  /**
   * M6: why one assignment target could not be sealed to, mirroring `sealAssigned`'s skip tests. It
   * is what a direct `personId` assignment throws when nothing was sent, so the dialog reports the
   * key-state reason (`recipient key changed`, `recipient has no pinned key`) instead of a success.
   */
  function sealSkipReason(me: Person, target: AssignTarget): string {
    const item = deps.repo.vaultItem(me.id, target.toolId);
    if (item === null || (item.credentialId !== null && item.credentialId !== target.credentialId)) {
      return UNKNOWN_CREDENTIAL;
    }
    const tool = deps.entry(target.toolId);
    if (tool === null || tool.scope === 'personal') return NOT_SHAREABLE;
    if (item.scope === 'blocked') return BLOCKED_CREDENTIAL;
    const pinned = deps.keys.peerKeyFor(target.personId);
    if (pinned === null) return NO_PINNED_KEY;
    if (pinned.status !== 'pinned') return RECIPIENT_KEY_CHANGED;
    // Every other skip is a keychain value `sealAssigned` reads; the credential is the honest answer.
    return CREDENTIAL_NOT_FOUND;
  }

  /**
   * K8/SP06 §4: seals one `assign` copy per target and posts one request per credential (SP03 §3's
   * body is one credential and a list of copies). A target whose credential this Nod does not hold,
   * whose tool left the catalog, whose credential is `blocked`, or whose pinned pair is missing or
   * changed is skipped and counted — `changed` and `unknown` are the RF-45 cases the UI shows. F1:
   * a request the host refuses (one member it will not take) is skipped and counted too, and the
   * other credentials of the same action still travel.
   */
  async function sealAssigned(
    me: Person,
    targets: AssignTarget[],
  ): Promise<{ sent: number; skipped: number }> {
    const connection = deps.connection();
    if (connection === null) throw new Error(NOT_CONNECTED);
    const own = await deps.keys.ownPrivate();
    if (own === null) throw new Error(NO_KEY_PAIR);
    const issuedAt = now().toISOString();
    const groups = new Map<
      string,
      { credentialId: string; toolId: Id; scope: 'role' | 'org'; items: { to: Id; sealed: string }[] }
    >();
    let sent = 0;
    let skipped = 0;
    for (const target of targets) {
      const item = deps.repo.vaultItem(me.id, target.toolId);
      const tool = deps.entry(target.toolId);
      const pinned = deps.keys.peerKeyFor(target.personId);
      if (
        item === null ||
        // M6/L6: a never-shared item carries no credentialId yet; the generated one is accepted.
        (item.credentialId !== null && item.credentialId !== target.credentialId) ||
        tool === null ||
        tool.scope === 'personal' ||
        item.scope === 'blocked' ||
        pinned === null ||
        pinned.status !== 'pinned'
      ) {
        skipped += 1;
        continue;
      }
      const credential = await deps.vault.read(me.id, target.toolId);
      if (credential === null) {
        skipped += 1;
        continue;
      }
      // SP06 §5: the scope of the copy is the credential's, never wider; `blocked` is skipped above.
      const scope: 'role' | 'org' = item.scope === 'org' ? 'org' : 'role';
      const payload: SealPayload = {
        v: SEAL_VERSION,
        credentialId: target.credentialId,
        toolId: target.toolId,
        toolOrigin: originOf(tool.url),
        label: item.label,
        username: credential.username,
        secret: credential.secret,
        scope,
        from: me.id,
        to: target.personId,
        kind: 'assign',
        issuedAt,
      };
      const sealed = await seal(payload, fromBase64url(pinned.x25519), own.ed25519Private);
      const key = `${target.credentialId}|${target.toolId}|${scope}`;
      let group = groups.get(key);
      if (group === undefined) {
        group = { credentialId: target.credentialId, toolId: target.toolId, scope, items: [] };
        groups.set(key, group);
      }
      group.items.push({ to: target.personId, sealed });
    }
    for (const group of groups.values()) {
      try {
        await connection.sendShares({
          credentialId: group.credentialId,
          toolId: group.toolId,
          scope: group.scope,
          kind: 'assign',
          items: group.items,
        });
      } catch (error) {
        // F1: the host validates every item of a request before it writes any row, so one refused
        // member (an un-granted recipient, a credential the host no longer knows) fails the whole
        // request. That refusal — a typed `HostError` with a status — is this group's, not the
        // action's: count it as skipped and keep sealing the other groups. A network failure has no
        // status and still aborts, so the admin can retry the seal.
        if (!(error instanceof HostError) || error.status === null) throw error;
        skipped += group.items.length;
        continue;
      }
      sent += group.items.length;
      // E02 §6: an assignment fan-out is a `share.sent` per member, kind `assign` in the detail.
      for (const copy of group.items) {
        record('share.sent', me.id, group.toolId, `${copy.to} scope=${group.scope} kind=assign`);
      }
    }
    return { sent, skipped };
  }

  /**
   * K8/SP06 §4: the admin's one action. `assigned: true` with a `roleId` writes the assignment
   * (`PUT /v1/admin/assignments`) and then seals to the members the host lists as missing; with a
   * `personId` it is the direct person assignment — one copy, no assignment row (the host accepts
   * it for a credential with no row). `assigned: false` deletes the role's row and seals nothing.
   *
   * The gate covers the sealing only: a removal and a person-less removal read no secret, so the
   * person is asked for a password exactly when a copy is about to travel.
   *
   * M6: answers `{ sent, skipped }`; a direct `personId` that reached nobody throws the key-state
   * reason. L6: a credentialId generated here is persisted only after the host accepted it — the role
   * assignment row, or the sealed copy itself — so a refused action leaves no orphan id.
   */
  async function assign(
    input: { toolId: Id; roleId: Id | null; personId: Id | null; assigned: boolean },
    password?: string,
  ): Promise<{ sent: number; skipped: number }> {
    const me = requirePerson();
    if (!amAdmin(me)) throw new Error(ADMIN_ONLY);
    const roleId = input.roleId;
    const personId = input.personId;
    if (roleId === null && personId === null) throw new Error(NO_ASSIGNMENT_TARGET);
    const item = deps.repo.vaultItem(me.id, input.toolId);
    if (item === null) throw new Error(UNKNOWN_CREDENTIAL);
    const connection = requireConnection();
    // K4/SP06 §4: the uuid is generated at the first share and kept on the item forever — an
    // assignment is keyed by it as much as a send is, and the owner holder row follows the seal.
    const newCredentialId = item.credentialId === null;
    const credentialId = item.credentialId ?? crypto.randomUUID();

    if (!input.assigned) {
      if (roleId !== null) {
        await connection.putAssignment({
          credentialId,
          roleId,
          toolId: input.toolId,
          assigned: false,
        });
        await refreshAssignments();
      }
      return { sent: 0, skipped: 0 };
    }

    // K5: the gate comes before a copy is sealed (SP06 §4). A `blocked` credential has no send of
    // any kind, and an assignment is a send (SP06 §5).
    if (item.scope === 'blocked') throw new Error(BLOCKED_CREDENTIAL);
    await deps.gate(GATE_REASON.assign, password);
    let result: { sent: number; skipped: number };
    if (roleId !== null) {
      await connection.putAssignment({
        credentialId,
        roleId,
        toolId: input.toolId,
        assigned: true,
      });
      // L6: the host took the assignment, so the id is safe to keep on the item now.
      if (newCredentialId) deps.repo.setVaultCredential(me.id, input.toolId, credentialId);
      // The list the assignment just changed is the host's answer to it, so it is read again before
      // the seal: every current member without a copy gets one in this same gated step.
      await refreshAssignments();
      result = await sealAssigned(
        me,
        missingRows
          .filter((row) => row.credentialId === credentialId)
          .map((row) => ({
            credentialId: row.credentialId,
            toolId: row.toolId,
            personId: row.personId,
          })),
      );
    } else {
      // The direct person assignment: the admin addresses one person, with no assignment row.
      if (personId === null) throw new Error(NO_ASSIGNMENT_TARGET);
      const target: AssignTarget = { credentialId, toolId: input.toolId, personId };
      result = await sealAssigned(me, [target]);
      // M6: nothing was sent, so the action did not happen; report the reason and persist nothing.
      if (result.sent === 0) throw new Error(sealSkipReason(me, target));
      // L6: the host took the copy, so the id is safe to keep on the item now.
      if (newCredentialId) deps.repo.setVaultCredential(me.id, input.toolId, credentialId);
    }
    await refreshAssignments();
    deps.onChanged?.();
    return result;
  }

  /** K8/SP06 §4: seals a copy to every member of the missing list this Nod can reach. Gated once. */
  async function sealMissing(password?: string): Promise<{ sent: number; skipped: number }> {
    const me = requirePerson();
    if (!amAdmin(me)) throw new Error(ADMIN_ONLY);
    // K5: one gate for the whole action, before the credential is read.
    await deps.gate(GATE_REASON.assign, password);
    requireConnection();
    if (missingRows.length === 0) await refreshAssignments();
    const result = await sealAssigned(
      me,
      missingRows.map((row) => ({
        credentialId: row.credentialId,
        toolId: row.toolId,
        personId: row.personId,
      })),
    );
    await refreshAssignments();
    deps.onChanged?.();
    return result;
  }

  // ---------------------------------------------------------------- scope and the vault view

  /**
   * K6/SP06 §5: the owner of a credential sets its scope. M4/F4: a credential that has a
   * `credentialId` carries the scope on the host (`PUT /v1/credentials/:id/scope`) whenever there is
   * a connection — so `blocked` is reachable and every later share derives its allowed scope from
   * the owner row — then locally. The cached snapshot is the cheap first check for the owner rule,
   * but it is not the last word: a credential that travelled without a byte from the host to this
   * Nod carries no holder row in the cache, and the host's own `404 unknown credential` is what says
   * "not there yet" — its scope then stays local, and it travels on the first send. A network
   * failure marks the change pending for the next sync (`retryPending`); a credential with no
   * `credentialId` has never travelled and is local only.
   */
  async function setScope(toolId: Id, scope: ShareScope): Promise<VaultItem> {
    const me = requirePerson();
    if (scope !== 'role' && scope !== 'blocked' && scope !== 'org') throw new Error(INVALID_SCOPE);
    const item = deps.repo.vaultItem(me.id, toolId);
    if (item === null) throw new Error(UNKNOWN_CREDENTIAL);
    const credentialId = item.credentialId;
    if (credentialId !== null) {
      // M4: the scope belongs to the credential's owner holder. A stale cache that still shows the
      // row is worth the local refusal; a cache without any row is not, so the host decides.
      if (holdersOf(credentialId).length > 0 && !isLiveOwner(credentialId, me.id)) {
        throw new Error(OWNER_ONLY);
      }
      await pushScope(credentialId, toolId, scope);
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

  return {
    recipients,
    send,
    inbox,
    accept,
    decline,
    setScope,
    update,
    retryPending,
    applyUpdates,
    removeHolder,
    assign,
    missing,
    sealMissing,
    refreshAssignments,
    missingCount,
    decorate,
    holdersOf,
  };
}
