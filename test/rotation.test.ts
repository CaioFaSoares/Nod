// K9 of SP06 §4 — share with updates and rotation pending — over `backend/shares.ts`,
// `backend/vault.ts` (the save call-out), `backend/host-client.ts` (`removeHolder`) and the **real**
// host app (`host/app.ts` booted on a temp data dir and served by `Bun.serve`).
//
// The e2e proves the two acceptance lines of issue #37: the owner edits a shared credential and the
// holder's Nod holds the new value after its next sync; removing a holder marks the credential
// `rotationPending` until a new secret is saved. The focused tests cover what the e2e cannot force:
// a holder whose pinned key changed is skipped with a warning, a save with no host leaves a pending
// marker that the next sync delivers, and an incoming `update` of a held credential is applied with
// no gate and replaces the value without duplicating the item.
//
// Nothing is mocked where the product has a real seam: the host, its guards, the client, the vault,
// the key pairs and the seal are the shipped code. Only the gate is a test stand-in, as in
// `test/shares.test.ts`.
import { afterEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createConnectedCatalog, type ConnectedCatalog } from '../backend/connected-catalog';
import { createKeys, type Keys, type OwnPrivatePair } from '../backend/keys';
import { createHostClient, type HostClient, type HostConnection } from '../backend/host-client';
import { createHostAdmin, type HostAdmin } from '../backend/host-admin';
import { createRepo as createNodRepo, type Repo as NodRepo } from '../backend/repo';
import { createSession, type Session } from '../backend/session';
import {
  createShares,
  UPDATE_KEY_CHANGED,
  UPDATE_PENDING,
  type Shares,
} from '../backend/shares';
import { createVault, type Vault } from '../backend/vault';
import { toBase64url } from '../shared/encoding';
import {
  HOST_ROUTES,
  type Device,
  type Holder,
  type SaltResponse,
  type ShareRequest,
  type Snapshot,
  type SnapshotPerson,
  type TokenResponse,
} from '../shared/host-api';
import {
  generateEd25519KeyPair,
  generateX25519KeyPair,
  open as openSealed,
  personFingerprint,
  seal,
  SEAL_VERSION,
} from '../shared/seal';
import type { SealKeyPair, SealPayload } from '../shared/seal';
import type { Entry, Id, SecretStore, VaultItem } from '../shared/types';
import { createApp } from '../host/app';
import { createRepo as createHostRepo, type Repo as HostRepo } from '../host/repo';
import { issueSetupCode } from '../host/cli/setup-code';
import { DEFAULT_PORT, type HostConfig } from '../host/config';
import { bootHost, type Host } from '../host/main';
import { GUILD_NAME_ENV } from '../host/routes/state';
import { memorySqlite } from './helpers/sqlite-bun';

const AT = '2026-10-17T10:00:00.000Z';
const EXPIRES = '2026-10-31T10:00:00.000Z';
const PASSWORD = 'nod-password-123';
const ITERATIONS = 1_000;
const DEVICE: Device = { name: 'nod-rotation-test', os: 'macos', appVersion: '0.3.5' };
const TOOL_ORIGIN = 'https://figma.example.test';
const CREDENTIAL_USER = 'credentialuserrot7';
const CREDENTIAL_SECRET = 'secretvalueone';
const ROTATED_SECRET = 'secretvaluetwo';
const ROTATED_AGAIN = 'secretvaluethree';

// ---------------------------------------------------------------- fixtures

function memoryKeychain(): SecretStore {
  const items = new Map<string, string>();
  return {
    get: async (key) => items.get(key) ?? null,
    set: async (key, value) => {
      items.set(key, value);
      return true;
    },
    delete: async (key) => items.delete(key),
  };
}

function memoryStore(): {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<boolean>;
} {
  const items = new Map<string, unknown>();
  return {
    get: async (key) => items.get(key) ?? null,
    set: async (key, value) => {
      items.set(key, value);
      return true;
    },
  };
}

function tool(id: string, overrides: Partial<Entry> = {}): Entry {
  return {
    id,
    title: `Tool ${id}`,
    url: `https://${id}.example.test`,
    icon: null,
    order: 1,
    roles: [],
    views: [],
    auth: null,
    active: true,
    ...overrides,
  };
}

/** One Nod's backend, with the K9 vault call-out wired to its own `shares`. */
interface Nod {
  repo: NodRepo;
  session: Session;
  vault: Vault;
  keys: Keys;
  secrets: SecretStore;
  catalog: ConnectedCatalog;
  entry: (id: Id) => Entry | null;
  link: { current: HostConnection | null };
  shares: Shares;
}

function newNod(): Nod {
  const secrets = memoryKeychain();
  const repo = createNodRepo(memorySqlite());
  repo.migrate();
  repo.ensureAdminRole();
  const session = createSession({
    repo,
    keychain: secrets,
    store: memoryStore(),
    authenticate: async () => true,
    biometricAvailable: false,
    iterations: ITERATIONS,
  });
  const catalog = createConnectedCatalog({ now: () => Date.parse(AT) });
  const entry = (id: Id): Entry | null =>
    catalog.entries().find((item) => item.id === id) ?? repo.entry(id);
  const link: { current: HostConnection | null } = { current: null };
  // K9/SP06 §4: the same call-out `backend/main.ts` wires — a save of a shared credential re-seals
  // the new value to its holders through `shares.update`.
  let sharesRef: Shares | null = null;
  const vault = createVault({
    repo: { ...repo, entry },
    keychain: secrets,
    iterations: ITERATIONS,
    vaultKey: () => session.vaultKey(),
    afterSave: async (personId, item) =>
      sharesRef === null ? null : await sharesRef.update(personId, item),
  });
  const keys = createKeys({
    repo,
    keychain: secrets,
    session: { current: () => session.current(), vaultKey: () => session.vaultKey() },
  });
  const shares = createShares({
    repo,
    session: { current: () => session.current() },
    vault,
    keys,
    entry,
    connection: () => link.current,
    gate: async () => {},
    onChanged: () => {},
  });
  sharesRef = shares;
  return { repo, session, vault, keys, secrets, catalog, entry, link, shares };
}

/** A local account, unlocked (which is what gives it a `vaultKey`). */
async function openAccount(nod: Nod, roles: Id[] = []): Promise<Id> {
  const state = await nod.session.createAccount({
    email: 'me@example.test',
    name: 'Me',
    password: PASSWORD,
  });
  const id = state.person?.id ?? '';
  if (roles.length > 0) {
    nod.repo.setRoles(id, roles);
    nod.session.refresh();
  }
  await nod.keys.ensure(null);
  return id;
}

/**
 * RF-65: the tool's default credential on the session's Nod — the item every single-credential test
 * of this file speaks of.
 */
function itemOf(nod: Nod, toolId: Id): VaultItem {
  const person = nod.session.current();
  if (person === null) throw new Error('the test needs an unlocked session');
  const item = nod.repo.defaultVaultItem(person.id, toolId);
  if (item === null) throw new Error(`no credential of ${toolId}`);
  return item;
}

/** The value of the tool's default credential — what a reveal of it would return. */
async function readDefault(
  nod: Nod,
  toolId: Id,
): Promise<{ username: string; secret: string } | null> {
  const person = nod.session.current();
  if (person === null) throw new Error('the test needs an unlocked session');
  const item = nod.repo.defaultVaultItem(person.id, toolId);
  return item === null ? null : await nod.vault.read(person.id, item.id);
}

/** A host row plus the cached snapshot the share flow reads (`backend/shares.ts`). */
function installSnapshot(
  nod: Nod,
  body: {
    people?: SnapshotPerson[];
    incomingShares?: Snapshot['incomingShares'];
    holders?: Record<string, Holder[]>;
    rotationPending?: Id[];
    meRoles?: Id[];
  } = {},
): void {
  const me = nod.session.current();
  if (me === null) throw new Error('the test snapshot needs an unlocked session');
  if (nod.repo.hostRecord() === null) {
    nod.repo.saveHost({
      address: 'https://host.example.test',
      guild: 'Guild',
      kid: 'kid',
      publicKey: 'public',
      personId: me.id,
      salt: 'salt',
      addedAt: AT,
    });
  }
  const snapshot = {
    api: 1,
    version: 'v1',
    issuedAt: AT,
    me: {
      id: me.id,
      email: me.email,
      name: me.name,
      roles: body.meRoles ?? me.roles,
      admin: me.admin,
      kind: 'member',
    },
    roles: [],
    orgTools: [],
    personalTools: [],
    personalViews: [],
    favorites: [],
    guildIcon: null,
    people: body.people ?? [],
    incomingShares: body.incomingShares ?? [],
    holders: body.holders ?? {},
    rotationPending: body.rotationPending ?? [],
  };
  nod.repo.saveHostSnapshot({
    snapshot: JSON.stringify(snapshot),
    version: snapshot.version,
    issuedAt: snapshot.issuedAt,
    syncedAt: AT,
  });
}

/** A `HostConnection` double: the calls the flow makes, recorded, and nothing on the wire. */
interface FakeConnection extends HostConnection {
  calls: string[];
  sent: ShareRequest[];
}

function fakeConnection(): FakeConnection {
  const calls: string[] = [];
  const sent: ShareRequest[] = [];
  return {
    host: { address: 'https://host.example.test', kid: 'kid', publicKey: 'public', personId: 'me' },
    calls,
    sent,
    tokenKey: () => 'token',
    saveToken: async () => {},
    forgetToken: async () => {},
    request: async () => {
      throw new Error('request is not part of the share flow');
    },
    getBytes: async () => new Uint8Array(),
    snapshot: async () => ({ notModified: true }),
    sessions: async () => [],
    revokeSession: async () => true,
    presence: async () => [],
    putKeys: async () => {},
    appMeta: async () => ({ minAppVersion: '0.0.0', update: null }),
    async sendShares(request) {
      sent.push(request);
      return { ids: request.items.map(() => crypto.randomUUID()) };
    },
    async acceptShare(id) {
      calls.push(`accept:${id}`);
      return true;
    },
    async declineShare(id) {
      calls.push(`decline:${id}`);
      return true;
    },
    async removeHolder(credentialId, personId) {
      calls.push(`remove:${credentialId}:${personId}`);
      return true;
    },
    async markRotated(credentialId) {
      calls.push(`rotated:${credentialId}`);
      return true;
    },
    // M4: `backend/shares.setScope` calls this for a credential that already has holder rows.
    async setCredentialScope(credentialId, scope) {
      calls.push(`scope:${credentialId}:${scope}`);
      return true;
    },
  };
}

/** SP06 §3: one payload, sealed to `recipient` and signed by `sender`. */
async function sealedShare(p: {
  credentialId: string;
  toolId: string;
  toolOrigin: string;
  from: string;
  to: string;
  sender: SealKeyPair;
  recipient: SealKeyPair;
  kind?: 'send' | 'assign' | 'update';
  username?: string;
  secret?: string;
}): Promise<string> {
  const payload: SealPayload = {
    v: SEAL_VERSION,
    credentialId: p.credentialId,
    toolId: p.toolId,
    toolOrigin: p.toolOrigin,
    label: `Tool ${p.toolId}`,
    username: p.username ?? 'ana',
    secret: p.secret ?? 's3cret',
    scope: 'role',
    from: p.from,
    to: p.to,
    kind: p.kind ?? 'send',
    issuedAt: AT,
  };
  return await seal(payload, p.recipient.publicKey, p.sender.privateKey);
}

/** A credential the Nod owns whose snapshot already lists `holders`. */
async function ownedCredential(
  nod: Nod,
  holders: Holder[],
): Promise<{ meId: Id; credentialId: string }> {
  const meId = await openAccount(nod);
  nod.repo.saveRole({ id: 'team', name: 'Team', admin: false });
  nod.repo.saveEntry(tool('figma', { url: `${TOOL_ORIGIN}/app`, roles: ['team'] }));
  await nod.vault.save(meId, {
    toolId: 'figma',
    username: CREDENTIAL_USER,
    secret: CREDENTIAL_SECRET,
    label: 'Figma',
  });
  nod.repo.setVaultCredential(meId, itemOf(nod, 'figma').id, 'c1');
  installSnapshot(nod, { holders: { c1: holders } });
  return { meId, credentialId: 'c1' };
}

// ---------------------------------------------------------------- update (K9, SP06 §4)

describe('the owner edit re-seals the new value (K9, SP06 §4)', () => {
  test('a save of a shared credential posts an update to every live holder', async () => {
    const nod = newNod();
    const { meId } = await ownedCredential(nod, []);
    const bobX = await generateX25519KeyPair();
    const bobEd = await generateEd25519KeyPair();
    nod.repo.pinPeerKey({
      personId: 'bob',
      x25519: toBase64url(bobX.publicKey),
      ed25519: toBase64url(bobEd.publicKey),
      fingerprint: await personFingerprint(bobX.publicKey, bobEd.publicKey),
      firstSeen: AT,
      confirmedAt: AT,
    });
    installSnapshot(nod, {
      holders: {
        c1: [
          { personId: meId, name: 'Me', owner: true, scope: 'role', since: AT, toolId: 'figma', removedAt: null },
          { personId: 'bob', name: 'Bob', owner: false, scope: 'role', since: AT, toolId: 'figma', removedAt: null },
        ],
      },
    });
    const connection = fakeConnection();
    nod.link.current = connection;

    const saved = await nod.vault.save(meId, {
      // RF-65: the edit names the credential it replaces; without `itemId` the save adds a new one.
      itemId: itemOf(nod, 'figma').id,
      toolId: 'figma',
      username: CREDENTIAL_USER,
      secret: ROTATED_SECRET,
      label: 'Figma',
    });

    expect(saved.updateWarning ?? null).toBeNull();
    expect(connection.sent).toHaveLength(1);
    expect(connection.sent[0]).toMatchObject({ credentialId: 'c1', toolId: 'figma', kind: 'update' });
    expect(connection.sent[0].items.map((item) => item.to)).toEqual(['bob']);
    const opened = await openSealed(connection.sent[0].items[0].sealed, {
      recipientPrivateKey: bobX.privateKey,
      recipientPublicKey: bobX.publicKey,
      senderPublicKey: (await nod.keys.ownPrivate())?.ed25519Public ?? new Uint8Array(),
      credentialId: 'c1',
      to: 'bob',
    });
    expect(opened).toMatchObject({ kind: 'update', secret: ROTATED_SECRET });
  });

  test('a holder whose pinned key changed is skipped, warned about and not sent to', async () => {
    const nod = newNod();
    const { meId } = await ownedCredential(nod, []);
    nod.repo.markPeerKeyChanged({
      personId: 'bob',
      x25519: toBase64url((await generateX25519KeyPair()).publicKey),
      ed25519: toBase64url((await generateEd25519KeyPair()).publicKey),
      fingerprint: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ',
      since: AT,
    });
    installSnapshot(nod, {
      holders: {
        c1: [
          { personId: meId, name: 'Me', owner: true, scope: 'role', since: AT, toolId: 'figma', removedAt: null },
          { personId: 'bob', name: 'Bob', owner: false, scope: 'role', since: AT, toolId: 'figma', removedAt: null },
        ],
      },
    });
    const connection = fakeConnection();
    nod.link.current = connection;

    const saved = await nod.vault.save(meId, {
      // RF-65: the edit names the credential it replaces; without `itemId` the save adds a new one.
      itemId: itemOf(nod, 'figma').id,
      toolId: 'figma',
      username: CREDENTIAL_USER,
      secret: ROTATED_SECRET,
      label: 'Figma',
    });

    expect(saved.updateWarning).toBe(UPDATE_KEY_CHANGED);
    expect(connection.sent).toEqual([]);
  });

  test('a save with no host keeps a pending marker and retries at the next sync', async () => {
    const nod = newNod();
    const { meId } = await ownedCredential(nod, []);
    const bobX = await generateX25519KeyPair();
    const bobEd = await generateEd25519KeyPair();
    nod.repo.pinPeerKey({
      personId: 'bob',
      x25519: toBase64url(bobX.publicKey),
      ed25519: toBase64url(bobEd.publicKey),
      fingerprint: await personFingerprint(bobX.publicKey, bobEd.publicKey),
      firstSeen: AT,
      confirmedAt: AT,
    });
    installSnapshot(nod, {
      holders: {
        c1: [
          { personId: meId, name: 'Me', owner: true, scope: 'role', since: AT, toolId: 'figma', removedAt: null },
          { personId: 'bob', name: 'Bob', owner: false, scope: 'role', since: AT, toolId: 'figma', removedAt: null },
        ],
      },
    });
    nod.link.current = null;

    const saved = await nod.vault.save(meId, {
      // RF-65: the edit names the credential it replaces; without `itemId` the save adds a new one.
      itemId: itemOf(nod, 'figma').id,
      toolId: 'figma',
      username: CREDENTIAL_USER,
      secret: ROTATED_SECRET,
      label: 'Figma',
    });

    expect(saved.updateWarning).toBe(UPDATE_PENDING);
    expect(nod.repo.meta('shares.pendingUpdates')).toContain('c1');

    const connection = fakeConnection();
    nod.link.current = connection;
    await nod.shares.retryPending();

    expect(connection.sent).toHaveLength(1);
    expect(connection.sent[0].kind).toBe('update');
    expect(nod.repo.meta('shares.pendingUpdates')).toBe('{}');
  });

  test('a save by somebody who is not the owner holder sends nothing', async () => {
    const nod = newNod();
    const { meId } = await ownedCredential(nod, []);
    installSnapshot(nod, {
      holders: {
        c1: [
          { personId: 'alice', name: 'Alice', owner: true, scope: 'role', since: AT, toolId: 'figma', removedAt: null },
          { personId: meId, name: 'Me', owner: false, scope: 'role', since: AT, toolId: 'figma', removedAt: null },
        ],
      },
    });
    const connection = fakeConnection();
    nod.link.current = connection;

    await nod.vault.save(meId, {
      itemId: itemOf(nod, 'figma').id,
      toolId: 'figma',
      username: CREDENTIAL_USER,
      secret: ROTATED_SECRET,
      label: 'Figma',
    });

    expect(connection.sent).toEqual([]);
  });
});

// ---------------------------------------------------------------- revoke (K9, SP06 §4)

describe('revoking a holder (K9, SP06 §4)', () => {
  test('removeHolder calls the host and answers the item', async () => {
    const nod = newNod();
    const { meId } = await ownedCredential(nod, []);
    installSnapshot(nod, {
      holders: {
        c1: [{ personId: meId, name: 'Me', owner: true, scope: 'role', since: AT, toolId: 'figma', removedAt: null }],
      },
    });
    const connection = fakeConnection();
    nod.link.current = connection;

    const item = await nod.shares.removeHolder(itemOf(nod, 'figma').id, 'carol');

    expect(connection.calls).toEqual(['remove:c1:carol']);
    expect(item).toMatchObject({ toolId: 'figma', credentialId: 'c1' });
  });

  test('a credential that never travelled has no holder to revoke', async () => {
    const nod = newNod();
    const meId = await openAccount(nod);
    nod.repo.saveEntry(tool('figma', { url: `${TOOL_ORIGIN}/app` }));
    await nod.vault.save(meId, {
      toolId: 'figma',
      username: CREDENTIAL_USER,
      secret: CREDENTIAL_SECRET,
      label: 'Figma',
    });
    const connection = fakeConnection();
    nod.link.current = connection;

    await expect(nod.shares.removeHolder(itemOf(nod, 'figma').id, 'carol')).rejects.toThrow('unknown credential');
    expect(connection.calls).toEqual([]);
  });

  test('an offline save of a revoked credential keeps a marker and retries the signal (RF-48)', async () => {
    const nod = newNod();
    const { meId } = await ownedCredential(nod, []);
    installSnapshot(nod, {
      holders: {
        c1: [
          { personId: meId, name: 'Me', owner: true, scope: 'role', since: AT, toolId: 'figma', removedAt: null },
          { personId: 'bob', name: 'Bob', owner: false, scope: 'role', since: AT, toolId: 'figma', removedAt: AT },
        ],
      },
    });
    nod.link.current = null;

    const saved = await nod.vault.save(meId, {
      // RF-65: the edit names the credential it replaces; without `itemId` the save adds a new one.
      itemId: itemOf(nod, 'figma').id,
      toolId: 'figma',
      username: CREDENTIAL_USER,
      secret: ROTATED_SECRET,
      label: 'Figma',
    });

    // No connection: the save is itself the rotation, but the host cannot hear it yet.
    expect(saved.updateWarning).toBe(UPDATE_PENDING);
    expect(nod.repo.meta('shares.pendingUpdates')).toContain('c1');

    // The next sync retries the whole save — with no live holder, the explicit signal alone.
    const connection = fakeConnection();
    nod.link.current = connection;
    await nod.shares.retryPending();

    expect(connection.calls).toEqual(['rotated:c1']);
    expect(connection.sent).toEqual([]);
    expect(nod.repo.meta('shares.pendingUpdates')).toBe('{}');
  });
});

// ---------------------------------------------------------------- auto-accept (K9, SP06 §4)

describe('an incoming update of a held credential (K9, SP06 §4)', () => {
  async function heldFixture(): Promise<{ nod: Nod; meId: Id; own: OwnPrivatePair }> {
    const nod = newNod();
    const meId = await openAccount(nod);
    nod.repo.saveEntry(tool('figma', { url: `${TOOL_ORIGIN}/app` }));
    const own = await nod.keys.ownPrivate();
    if (own === null) throw new Error('the fixture needs the Nod key pair');
    return { nod, meId, own };
  }

  test('applyUpdates replaces the value, keeps the origin and never duplicates the item', async () => {
    const { nod, meId, own } = await heldFixture();
    await nod.vault.save(meId, {
      toolId: 'figma',
      username: 'old',
      secret: 'old-secret',
      label: 'Figma',
    });
    nod.repo.setVaultCredential(meId, itemOf(nod, 'figma').id, 'c1');
    nod.repo.setVaultScope(meId, itemOf(nod, 'figma').id, 'role');

    const aliceX = await generateX25519KeyPair();
    const aliceEd = await generateEd25519KeyPair();
    nod.repo.pinPeerKey({
      personId: 'alice',
      x25519: toBase64url(aliceX.publicKey),
      ed25519: toBase64url(aliceEd.publicKey),
      fingerprint: await personFingerprint(aliceX.publicKey, aliceEd.publicKey),
      firstSeen: AT,
      confirmedAt: AT,
    });
    const sealed = await sealedShare({
      credentialId: 'c1',
      toolId: 'figma',
      toolOrigin: TOOL_ORIGIN,
      from: 'alice',
      to: meId,
      sender: aliceEd,
      recipient: { publicKey: own.x25519Public, privateKey: own.x25519Private },
      kind: 'update',
      username: 'new',
      secret: 'new-secret',
    });
    installSnapshot(nod, {
      people: [{ id: 'alice', name: 'Alice', roles: ['team'], kind: 'member' }],
      // H1: the update is applied silently only because `alice` is the credential's live owner holder.
      holders: {
        c1: [{ personId: 'alice', name: 'Alice', owner: true, scope: 'role', since: AT, toolId: 'figma', removedAt: null }],
      },
      incomingShares: [
        {
          id: 'share-1',
          credentialId: 'c1',
          toolId: 'figma',
          from: 'alice',
          scope: 'role',
          kind: 'update',
          sealed,
          createdAt: AT,
          expiresAt: EXPIRES,
        },
      ],
    });
    const connection = fakeConnection();
    nod.link.current = connection;

    await nod.shares.applyUpdates();

    expect(connection.calls).toEqual(['accept:share-1']);
    expect(nod.repo.listVault(meId)).toHaveLength(1);
    expect(await readDefault(nod, 'figma')).toEqual({ username: 'new', secret: 'new-secret' });
    expect(nod.repo.vaultOrigin(meId, 'figma')).toBe(TOOL_ORIGIN);
  });

  test('a send of a credential this Nod does not hold stays in the inbox', async () => {
    const { nod, meId, own } = await heldFixture();
    const aliceEd = await generateEd25519KeyPair();
    const aliceX = await generateX25519KeyPair();
    nod.repo.pinPeerKey({
      personId: 'alice',
      x25519: toBase64url(aliceX.publicKey),
      ed25519: toBase64url(aliceEd.publicKey),
      fingerprint: await personFingerprint(aliceX.publicKey, aliceEd.publicKey),
      firstSeen: AT,
      confirmedAt: AT,
    });
    const sealed = await sealedShare({
      credentialId: 'c9',
      toolId: 'figma',
      toolOrigin: TOOL_ORIGIN,
      from: 'alice',
      to: meId,
      sender: aliceEd,
      recipient: { publicKey: own.x25519Public, privateKey: own.x25519Private },
      kind: 'send',
    });
    installSnapshot(nod, {
      incomingShares: [
        {
          id: 'share-2',
          credentialId: 'c9',
          toolId: 'figma',
          from: 'alice',
          scope: 'role',
          kind: 'send',
          sealed,
          createdAt: AT,
          expiresAt: EXPIRES,
        },
      ],
    });
    const connection = fakeConnection();
    nod.link.current = connection;

    await nod.shares.applyUpdates();

    expect(connection.calls).toEqual([]);
    expect(nod.shares.inbox()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- end to end against the host

interface Running {
  address: string;
  db: Database;
  repo: HostRepo;
  pin: { kid: string; ed25519Public: string };
  client: HostClient;
  keychain: SecretStore;
  call(method: string, path: string, body?: unknown, token?: string | null): Promise<Response>;
  close(): void;
}

const runningHosts: Running[] = [];
const dirs: string[] = [];

async function startHost(): Promise<Running> {
  const dir = mkdtempSync(join(tmpdir(), 'nod-rotation-'));
  dirs.push(dir);
  const config: HostConfig = {
    dataDir: dir,
    publicUrl: 'https://nod.example',
    port: DEFAULT_PORT,
    dev: false,
  };
  const previousGuild = process.env[GUILD_NAME_ENV];
  process.env[GUILD_NAME_ENV] = 'Nod test guild';
  const booted: Host = await bootHost(config);
  const app = createApp({ config, db: booted.db });
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request: Request) => app.handle(request),
  });
  const address = `http://127.0.0.1:${server.port}`;
  const keychain = memoryKeychain();
  const client = createHostClient({ fetch, keychain });
  const pin = (await client.discover(address)).pin;
  const running: Running = {
    address,
    db: booted.db,
    repo: createHostRepo(booted.db),
    pin,
    client,
    keychain,
    call: async (method, path, body, token = null) =>
      await fetch(`${address}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    close: () => {
      server.stop(true);
      booted.close();
      if (previousGuild === undefined) delete process.env[GUILD_NAME_ENV];
      else process.env[GUILD_NAME_ENV] = previousGuild;
    },
  };
  runningHosts.push(running);
  return running;
}

afterEach(() => {
  for (const running of runningHosts.splice(0)) running.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const randomSalt = (): string => toBase64url(crypto.getRandomValues(new Uint8Array(16)));
const randomAuthKey = (): string => toBase64url(crypto.getRandomValues(new Uint8Array(32)));

async function body<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function connectionFor(running: Running, person: { id: string }): HostConnection {
  return running.client.connect({
    address: running.address,
    kid: running.pin.kid,
    publicKey: running.pin.ed25519Public,
    personId: person.id,
  });
}

async function adminOf(running: Running): Promise<HostAdmin> {
  const issued = await issueSetupCode(running.repo, new Date().toISOString());
  if (!issued.issued) throw new Error('the setup command refused to issue a code');
  const response = await running.call('POST', HOST_ROUTES.authSetup, {
    email: 'ada@nod.test',
    name: 'Ada',
    code: issued.code,
    salt: randomSalt(),
    authKey: randomAuthKey(),
    device: DEVICE,
  });
  const opened = await body<TokenResponse>(response);
  const connection = connectionFor(running, { id: opened.personId });
  await connection.saveToken(opened.token);
  return createHostAdmin(connection);
}

/**
 * A person of the guild with an access code for them (0.5.0, RF-59): they join through a guild
 * invite — the People tab's create route is an invite now — and the code is the reissue for a person
 * who already exists (`POST /v1/admin/people/:id/code`, SP02 §3).
 */
async function memberWithCode(
  running: Running,
  admin: HostAdmin,
  input: { email: string; name: string; roles: Id[] },
): Promise<{ id: string; code: string; expiresAt: string }> {
  const invited = await admin.createInvite(
    { roles: input.roles, maxUses: 1, expiresInMinutes: 60 },
    input.roles,
  );
  const authKey = randomAuthKey();
  const joined = await running.call('POST', HOST_ROUTES.authJoin, {
    email: input.email,
    name: input.name,
    code: invited.code,
    salt: randomSalt(),
    authKey,
    device: DEVICE,
  });
  if (joined.status !== 200) throw new Error(`the join answered ${joined.status}`);
  const opened = (await joined.json()) as TokenResponse;
  const issued = await admin.issueCode(opened.personId);
  return { id: opened.personId, code: issued.code, expiresAt: issued.expiresAt };
}

async function joinNod(
  running: Running,
  nod: Nod,
  input: { email: string; name: string; code: string; password: string },
): Promise<{ id: Id; token: string }> {
  const pre = running.client.connect({
    address: running.address,
    kid: running.pin.kid,
    publicKey: running.pin.ed25519Public,
    personId: '',
  });
  const published = await pre.request<SaltResponse>('POST', HOST_ROUTES.authSalt, {
    email: input.email,
  });
  const salt = randomSalt();
  const derived = await nod.session.deriveFor(input.password, salt, published.iterations);
  const opened = await pre.request<TokenResponse>('POST', HOST_ROUTES.authActivate, {
    email: input.email,
    code: input.code,
    salt,
    authKey: toBase64url(derived.authKey),
    device: DEVICE,
  });
  await nod.session.adoptConnectedAccount({
    personId: opened.personId,
    email: input.email,
    name: input.name,
    password: input.password,
    salt,
    iterations: published.iterations,
    admin: false,
  });
  nod.repo.saveHost({
    address: running.address,
    guild: 'Nod test guild',
    kid: running.pin.kid,
    publicKey: running.pin.ed25519Public,
    personId: opened.personId,
    salt,
    addedAt: AT,
  });
  const connection = connectionFor(running, { id: opened.personId });
  await connection.saveToken(opened.token);
  nod.link.current = connection;
  await nod.keys.ensure(connection);
  return { id: opened.personId, token: opened.token };
}

/** One verified snapshot (real signature check, real body), stored and applied as a sync would. */
async function syncNod(nod: Nod): Promise<Snapshot> {
  const connection = nod.link.current;
  if (connection === null) throw new Error('the Nod is not connected');
  const result = await connection.snapshot();
  if (result.notModified) throw new Error('the host answered 304 to a Nod with no cached version');
  nod.repo.saveHostSnapshot({
    snapshot: result.raw,
    version: result.snapshot.version,
    issuedAt: result.snapshot.issuedAt,
    syncedAt: AT,
  });
  nod.catalog.refresh(nod.repo.hostRecord());
  await nod.keys.observe();
  return result.snapshot;
}

function vaultItemOf(nod: Nod, personId: Id): VaultItem {
  const listed = nod.shares.decorate(nod.vault.list(personId));
  const item = listed.find((row) => row.toolId === 'figma');
  if (item === undefined) throw new Error('the vault holds no figma credential');
  return item;
}

describe('the rotation acceptance against the real host (K9)', () => {
  test('an edited shared credential reaches the holders, and a revoked holder stays pending', async () => {
    const running = await startHost();
    const admin = await adminOf(running);
    await admin.saveRole({ id: 'team', name: 'Team', admin: false });
    await admin.saveRole({ id: 'finance', name: 'Finance', admin: false });
    await admin.saveTool(tool('figma', { title: 'Figma', url: `${TOOL_ORIGIN}/app`, roles: ['team', 'finance'] }));
    await admin.grant('team', 'figma', true);
    await admin.grant('finance', 'figma', true);

    const aliceCreated = await memberWithCode(running, admin, { email: 'alice@nod.test', name: 'Alice', roles: ['team'] });
    const bobCreated = await memberWithCode(running, admin, { email: 'bob@nod.test', name: 'Bob', roles: ['team'] });
    const carolCreated = await memberWithCode(running, admin, { email: 'carol@nod.test', name: 'Carol', roles: ['finance'] });

    const aliceNod = newNod();
    const bobNod = newNod();
    const carolNod = newNod();
    const alice = await joinNod(running, aliceNod, { email: 'alice@nod.test', name: 'Alice', code: aliceCreated.code, password: PASSWORD });
    const bob = await joinNod(running, bobNod, { email: 'bob@nod.test', name: 'Bob', code: bobCreated.code, password: PASSWORD });
    const carol = await joinNod(running, carolNod, { email: 'carol@nod.test', name: 'Carol', code: carolCreated.code, password: PASSWORD });

    await syncNod(aliceNod);
    await syncNod(bobNod);
    await syncNod(carolNod);

    // Alice saves the credential of the guild tool and shares it with both holders (scope `org`).
    await aliceNod.vault.save(alice.id, {
      toolId: 'figma',
      username: CREDENTIAL_USER,
      secret: CREDENTIAL_SECRET,
      label: 'Figma',
    });
    expect((await aliceNod.shares.setScope(itemOf(aliceNod, 'figma').id, 'org')).scope).toBe('org');
    const sent = await aliceNod.shares.send(itemOf(aliceNod, 'figma').id, [bob.id, carol.id]);
    expect(sent).toEqual({ sent: 2 });
    const credentialId = itemOf(aliceNod, 'figma').credentialId;
    expect(credentialId).not.toBeNull();

    for (const [nod, person] of [
      [bobNod, bob],
      [carolNod, carol],
    ] as const) {
      await syncNod(nod);
      const inbox = nod.shares.inbox();
      expect(inbox).toHaveLength(1);
      await nod.shares.accept(inbox[0].id);
    }
    await syncNod(aliceNod);
    expect(vaultItemOf(aliceNod, alice.id).holders.map((holder) => holder.name).sort()).toEqual([
      'Alice',
      'Bob',
      'Carol',
    ]);
    expect(vaultItemOf(aliceNod, alice.id).rotationPending).toBe(false);

    // Acceptance 1: the owner edits the shared credential; the holders get it at their next sync.
    const saved = await aliceNod.vault.save(alice.id, {
      // RF-65: the owner's edit names the shared credential; without `itemId` it would add a new one.
      itemId: itemOf(aliceNod, 'figma').id,
      toolId: 'figma',
      username: CREDENTIAL_USER,
      secret: ROTATED_SECRET,
      label: 'Figma',
    });
    expect(saved.updateWarning ?? null).toBeNull();

    await syncNod(bobNod);
    const update = bobNod.shares.inbox().find((share) => share.kind === 'update');
    if (update === undefined) throw new Error('the holder did not receive the update');
    await bobNod.shares.applyUpdates();
    expect(await readDefault(bobNod, 'figma')).toEqual({
      username: CREDENTIAL_USER,
      secret: ROTATED_SECRET,
    });
    expect(bobNod.repo.listVault(bob.id)).toHaveLength(1);

    // Acceptance 2: removing a holder marks the credential rotation pending for the owner until a
    // new secret is saved — which is what triggers the update that clears it.
    await aliceNod.shares.removeHolder(itemOf(aliceNod, 'figma').id, carol.id);
    await syncNod(aliceNod);
    const pending = vaultItemOf(aliceNod, alice.id);
    expect(pending.rotationPending).toBe(true);
    expect(pending.holders.find((holder) => holder.personId === carol.id)?.removedAt).not.toBeNull();

    await aliceNod.vault.save(alice.id, {
      itemId: itemOf(aliceNod, 'figma').id,
      toolId: 'figma',
      username: CREDENTIAL_USER,
      secret: ROTATED_AGAIN,
      label: 'Figma',
    });
    await syncNod(aliceNod);
    expect(vaultItemOf(aliceNod, alice.id).rotationPending).toBe(false);

    // The remaining holder got the rotated value, and the host never saw a plaintext byte of it.
    await syncNod(bobNod);
    await bobNod.shares.applyUpdates();
    expect(await readDefault(bobNod, 'figma')).toEqual({
      username: CREDENTIAL_USER,
      secret: ROTATED_AGAIN,
    });
  });

  test('the only holder is revoked and the owner’s save clears the rotation (RF-48)', async () => {
    const running = await startHost();
    const admin = await adminOf(running);
    await admin.saveRole({ id: 'team', name: 'Team', admin: false });
    await admin.saveTool(tool('figma', { title: 'Figma', url: `${TOOL_ORIGIN}/app`, roles: ['team'] }));
    await admin.grant('team', 'figma', true);

    const aliceCreated = await memberWithCode(running, admin, { email: 'alice@nod.test', name: 'Alice', roles: ['team'] });
    const bobCreated = await memberWithCode(running, admin, { email: 'bob@nod.test', name: 'Bob', roles: ['team'] });

    const aliceNod = newNod();
    const bobNod = newNod();
    const alice = await joinNod(running, aliceNod, { email: 'alice@nod.test', name: 'Alice', code: aliceCreated.code, password: PASSWORD });
    const bob = await joinNod(running, bobNod, { email: 'bob@nod.test', name: 'Bob', code: bobCreated.code, password: PASSWORD });

    await syncNod(aliceNod);
    await syncNod(bobNod);

    await aliceNod.vault.save(alice.id, {
      toolId: 'figma',
      username: CREDENTIAL_USER,
      secret: CREDENTIAL_SECRET,
      label: 'Figma',
    });
    expect((await aliceNod.shares.setScope(itemOf(aliceNod, 'figma').id, 'org')).scope).toBe('org');
    expect(await aliceNod.shares.send(itemOf(aliceNod, 'figma').id, [bob.id])).toEqual({ sent: 1 });

    await syncNod(bobNod);
    await bobNod.shares.accept(bobNod.shares.inbox()[0].id);
    await syncNod(aliceNod);

    // Alice revokes Bob — her only other holder — and the credential turns rotation pending.
    await aliceNod.shares.removeHolder(itemOf(aliceNod, 'figma').id, bob.id);
    await syncNod(aliceNod);
    expect(vaultItemOf(aliceNod, alice.id).rotationPending).toBe(true);

    // Nobody is left to fan an update out to, so the explicit rotation signal is the only witness;
    // the owner's save still ends the state (RF-48, `docs/handovers/k10-smoke.md` finding 1).
    const saved = await aliceNod.vault.save(alice.id, {
      // RF-65: the owner's edit names the shared credential; without `itemId` it would add a new one.
      itemId: itemOf(aliceNod, 'figma').id,
      toolId: 'figma',
      username: CREDENTIAL_USER,
      secret: ROTATED_SECRET,
      label: 'Figma',
    });
    expect(saved.updateWarning ?? null).toBeNull();
    await syncNod(aliceNod);
    expect(vaultItemOf(aliceNod, alice.id).rotationPending).toBe(false);
  });
});
