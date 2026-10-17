// `backend/shares.ts` — K4, K6 and K7 of SP06 — plus the end-to-end of a send and an accept over
// the **real** host app (`host/app.ts` booted on a temp data dir and served by `Bun.serve`) and the
// real `backend/host-client.ts`/`backend/vault.ts`/`backend/keys.ts`.
//
// The unit half covers the pure decisions (SP06 §5), the sealed payload of §3 through the real
// `shared/seal.ts`, and every failure that must decline as `invalid share` (a tampered signature, a
// payload addressed to somebody else, a credential the host did not send, a tool whose origin is not
// the catalog's). The end-to-end proves the acceptance of issue #32: Alice sends, Bob accepts after
// the gate, both list both holders, and a dump of the host's database carries neither the username
// nor the secret.
//
// Nothing is mocked where the product has a real seam: the host, its guards, the client, the vault,
// the key pairs and the seal are the shipped code. The gate is the one seam a test supplies — it is
// `app.authenticate` at runtime.
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
  scopeDecision,
  shareMatches,
  type ScopeInput,
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
import type { Entry, Id, SecretStore } from '../shared/types';
import { createApp } from '../host/app';
import { createRepo as createHostRepo, type Repo as HostRepo } from '../host/repo';
import { issueSetupCode } from '../host/cli/setup-code';
import { DEFAULT_PORT, type HostConfig } from '../host/config';
import { bootHost, type Host } from '../host/main';
import { GUILD_NAME_ENV } from '../host/routes/state';
import { memorySqlite } from './helpers/sqlite-bun';

const AT = '2026-10-17T10:00:00.000Z';
const PASSWORD = 'nod-password-123';
const ITERATIONS = 1_000;
const DEVICE: Device = { name: 'nod-shares-test', os: 'macos', appVersion: '0.3.5' };
const TOOL_ORIGIN = 'https://figma.example.test';
const CREDENTIAL_USER = 'credentialuserzq7';
const CREDENTIAL_SECRET = 'secretvaluezq7';

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

/** One Nod's backend: repository, session, vault, key pairs, catalog and the share flow. */
interface Nod {
  repo: NodRepo;
  session: Session;
  vault: Vault;
  keys: Keys;
  secrets: SecretStore;
  catalog: ConnectedCatalog;
  entry: (id: Id) => Entry | null;
  /** The pinned connection, set by a test or by the join helper (`null` until then). */
  link: { current: HostConnection | null };
  shares: Shares;
}

function newNod(gate: (reason: string, password?: string) => Promise<void> = async () => {}): Nod {
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
  const vault = createVault({
    repo: { ...repo, entry },
    keychain: secrets,
    iterations: ITERATIONS,
    vaultKey: () => session.vaultKey(),
  });
  const keys = createKeys({
    repo,
    keychain: secrets,
    session: { current: () => session.current(), vaultKey: () => session.vaultKey() },
  });
  const link: { current: HostConnection | null } = { current: null };
  const shares = createShares({
    repo,
    session: { current: () => session.current() },
    vault,
    keys,
    entry,
    connection: () => link.current,
    gate,
    onChanged: () => {},
  });
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

/** A host row plus the cached snapshot the share flow reads (`shares.inbox`, the scope, holders). */
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

/** A `HostConnection` double: the calls this slice makes, recorded, and nothing on the wire. */
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
  };
}

/**
 * One base64url character changed in the middle of the sealed string: the Ed25519 signature no
 * longer verifies. The middle of the body is used because the last character may carry only padding
 * bits a decoder ignores.
 */
function flipOne(sealed: string): string {
  const at = Math.floor(sealed.length / 2);
  const current = sealed[at] === 'A' ? 'B' : 'A';
  return sealed.slice(0, at) + current + sealed.slice(at + 1);
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
  scope?: 'role' | 'org';
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
    scope: p.scope ?? 'role',
    from: p.from,
    to: p.to,
    kind: p.kind ?? 'send',
    issuedAt: AT,
  };
  return await seal(payload, p.recipient.publicKey, p.sender.privateKey);
}

// ---------------------------------------------------------------- the scope (SP06 §5)

describe('the scope decision (SP06 §5)', () => {
  const me = { id: 'me', roles: ['team'], kind: 'member' };
  const tool = { scope: 'org' as const, roles: ['team', 'finance'] };
  const decision = (input: Partial<ScopeInput> & { recipient: ScopeInput['recipient'] }): ScopeInput => ({
    scope: 'role',
    meId: me.id,
    meRoles: me.roles,
    tool,
    ...input,
  });

  test('role: a common role and the tool granted to one of the recipient roles', () => {
    expect(
      scopeDecision(decision({ recipient: { id: 'bob', roles: ['team'], kind: 'member' } })),
    ).toEqual({ allowed: true, reason: null });
  });

  test('role: no common role is refused even when the tool is granted', () => {
    expect(
      scopeDecision(decision({ recipient: { id: 'carol', roles: ['finance'], kind: 'member' } })),
    ).toEqual({ allowed: false, reason: 'no role in common' });
  });

  test('role: a tool not granted to the recipient is invisible, common role or not', () => {
    expect(
      scopeDecision(
        decision({
          tool: { scope: 'org', roles: ['team'] },
          recipient: { id: 'dave', roles: ['support'], kind: 'member' },
        }),
      ),
    ).toEqual({ allowed: false, reason: 'tool not visible to recipient' });
  });

  test('org: every granted member, never a client', () => {
    expect(
      scopeDecision(
        decision({ scope: 'org', recipient: { id: 'carol', roles: ['finance'], kind: 'member' } }),
      ),
    ).toEqual({ allowed: true, reason: null });
    expect(
      scopeDecision(
        decision({ scope: 'org', recipient: { id: 'client', roles: ['finance'], kind: 'client' } }),
      ),
    ).toEqual({ allowed: false, reason: 'org shares go to members only' });
  });

  test('blocked allows nobody, a personal tool is not shareable, and oneself is not a recipient', () => {
    expect(
      scopeDecision(decision({ scope: 'blocked', recipient: { id: 'bob', roles: ['team'], kind: 'member' } })),
    ).toEqual({ allowed: false, reason: 'blocked credential' });
    expect(
      scopeDecision(
        decision({ tool: { scope: 'personal', roles: ['team'] }, recipient: { id: 'bob', roles: ['team'], kind: 'member' } }),
      ),
    ).toEqual({ allowed: false, reason: 'tool not visible to recipient' });
    expect(
      scopeDecision(decision({ recipient: { id: 'me', roles: ['team'], kind: 'member' } })),
    ).toEqual({ allowed: false, reason: 'cannot share with yourself' });
  });
});

// ---------------------------------------------------------------- the sealed payload (SP06 §3)

describe('the sealed share (SP06 §3)', () => {
  const meta = {
    credentialId: 'c1',
    toolId: 'figma',
    scope: 'role' as const,
    kind: 'send' as const,
    fromId: 'alice',
    toId: 'bob',
  };

  test('seal and open agree on the payload, in both directions of the key pair', async () => {
    const senderX = await generateX25519KeyPair();
    const senderEd = await generateEd25519KeyPair();
    const recipientX = await generateX25519KeyPair();
    const sealed = await sealedShare({
      credentialId: 'c1',
      toolId: 'figma',
      toolOrigin: TOOL_ORIGIN,
      from: 'alice',
      to: 'bob',
      sender: senderEd,
      recipient: recipientX,
    });
    const opened = await openSealed(sealed, {
      recipientPrivateKey: recipientX.privateKey,
      recipientPublicKey: recipientX.publicKey,
      senderPublicKey: senderEd.publicKey,
      credentialId: 'c1',
      to: 'bob',
    });
    expect(opened).not.toBeNull();
    expect(opened?.credentialId).toBe('c1');
    expect(opened?.secret).toBe('s3cret');
    expect(opened === null ? false : shareMatches(opened, meta)).toBe(true);

    // A payload meant for somebody else does not open for Bob (SP06 §3 step 4).
    expect(
      await openSealed(sealed, {
        recipientPrivateKey: recipientX.privateKey,
        recipientPublicKey: recipientX.publicKey,
        senderPublicKey: senderEd.publicKey,
        credentialId: 'c1',
        to: 'carol',
      }),
    ).toBeNull();
    // The sender's key is the one that must verify, not another one.
    expect(
      await openSealed(sealed, {
        recipientPrivateKey: recipientX.privateKey,
        recipientPublicKey: recipientX.publicKey,
        senderPublicKey: senderX.publicKey,
        credentialId: 'c1',
        to: 'bob',
      }),
    ).toBeNull();
  });

  test('a flipped signature bit is not a share', async () => {
    const senderEd = await generateEd25519KeyPair();
    const recipientX = await generateX25519KeyPair();
    const sealed = await sealedShare({
      credentialId: 'c1',
      toolId: 'figma',
      toolOrigin: TOOL_ORIGIN,
      from: 'alice',
      to: 'bob',
      sender: senderEd,
      recipient: recipientX,
    });
    const last = sealed.at(-1) === 'A' ? 'B' : 'A';
    const tampered = sealed.slice(0, -1) + last;
    expect(
      await openSealed(tampered, {
        recipientPrivateKey: recipientX.privateKey,
        recipientPublicKey: recipientX.publicKey,
        senderPublicKey: senderEd.publicKey,
        credentialId: 'c1',
        to: 'bob',
      }),
    ).toBeNull();
  });

  test('metadata the host did not send is refused even when the bytes open', () => {
    const payload: SealPayload = {
      v: SEAL_VERSION,
      credentialId: 'c1',
      toolId: 'figma',
      toolOrigin: TOOL_ORIGIN,
      label: 'Figma',
      username: 'ana',
      secret: 's3cret',
      scope: 'role',
      from: 'alice',
      to: 'bob',
      kind: 'send',
      issuedAt: AT,
    };
    expect(shareMatches(payload, meta)).toBe(true);
    expect(shareMatches({ ...payload, credentialId: 'c2' }, meta)).toBe(false);
    expect(shareMatches({ ...payload, toolId: 'other' }, meta)).toBe(false);
    expect(shareMatches({ ...payload, kind: 'update' }, meta)).toBe(false);
    expect(shareMatches({ ...payload, scope: 'org' }, meta)).toBe(false);
    expect(shareMatches({ ...payload, from: 'carol' }, meta)).toBe(false);
    expect(shareMatches({ ...payload, to: 'carol' }, meta)).toBe(false);
  });
});

// ---------------------------------------------------------------- accept (SP06 §3–§4)

/** The pieces one accept test needs: the Nod, its own pair and the sender's pinned pair. */
interface AcceptFixture {
  nod: Nod;
  meId: Id;
  own: OwnPrivatePair;
  senderX: SealKeyPair;
  senderEd: SealKeyPair;
}

describe('accept (SP06 §3–§4)', () => {
  async function acceptFixture(): Promise<AcceptFixture> {
    const nod = newNod();
    const meId = await openAccount(nod);
    nod.repo.saveEntry(tool('figma', { url: `${TOOL_ORIGIN}/app` }));
    const own = await nod.keys.ownPrivate();
    if (own === null) throw new Error('the fixture needs the Nod key pair');

    const senderX = await generateX25519KeyPair();
    const senderEd = await generateEd25519KeyPair();
    nod.repo.pinPeerKey({
      personId: 'alice',
      x25519: toBase64url(senderX.publicKey),
      ed25519: toBase64url(senderEd.publicKey),
      fingerprint: await personFingerprint(senderX.publicKey, senderEd.publicKey),
      firstSeen: AT,
      confirmedAt: AT,
    });
    return { nod, meId, own, senderX, senderEd };
  }

  /** The share of one fixture, sealed with the sender's real keys. */
  async function share(
    fixture: AcceptFixture,
    overrides: {
      id?: string;
      /** The credential the sealed payload names (default `c1`). */
      credentialId?: string;
      /** The credential the host's row names (default: the payload's). */
      metaCredentialId?: string;
      toolId?: string;
      /** The tool the host's row names (default: the payload's). */
      metaToolId?: string;
      toolOrigin?: string;
      to?: string;
      kind?: 'send' | 'update';
      username?: string;
      secret?: string;
    } = {},
  ): Promise<Snapshot['incomingShares']> {
    const id = overrides.id ?? 'share-1';
    const credentialId = overrides.credentialId ?? 'c1';
    const toolId = overrides.toolId ?? 'figma';
    const sealed =
      overrides.id === 'tampered'
        ? flipOne(
            await sealedShare({
              credentialId,
              toolId,
              toolOrigin: TOOL_ORIGIN,
              from: 'alice',
              to: fixture.meId,
              sender: fixture.senderEd,
              recipient: { publicKey: fixture.own.x25519Public, privateKey: fixture.own.x25519Private },
            }),
          )
        : await sealedShare({
            credentialId,
            toolId,
            toolOrigin: overrides.toolOrigin ?? TOOL_ORIGIN,
            from: 'alice',
            to: overrides.to ?? fixture.meId,
            sender: fixture.senderEd,
            recipient: { publicKey: fixture.own.x25519Public, privateKey: fixture.own.x25519Private },
            kind: overrides.kind ?? 'send',
            username: overrides.username,
            secret: overrides.secret,
          });
    return [
      {
        id,
        credentialId: overrides.metaCredentialId ?? credentialId,
        toolId: overrides.metaToolId ?? toolId,
        from: 'alice',
        scope: 'role',
        kind: overrides.kind ?? 'send',
        sealed,
        createdAt: AT,
        expiresAt: '2026-10-31T10:00:00.000Z',
      },
    ];
  }

  test('a valid share lands in the vault with the origin, the credential id and the scope', async () => {
    const fixture = await acceptFixture();
    const connection = fakeConnection();
    fixture.nod.link.current = connection;
    installSnapshot(fixture.nod, {
      people: [{ id: 'alice', name: 'Alice', roles: ['team'], kind: 'member' }],
      incomingShares: await share(fixture),
    });
    const shares = createSharesFor(fixture.nod, connection);

    const item = await shares.accept('share-1');

    expect(item).toMatchObject({
      toolId: 'figma',
      credentialId: 'c1',
      scope: 'role',
      username: 'ana',
    });
    expect(fixture.nod.repo.vaultOrigin(fixture.meId, 'figma')).toBe(TOOL_ORIGIN);
    expect(await fixture.nod.vault.read(fixture.meId, 'figma')).toEqual({
      username: 'ana',
      secret: 's3cret',
    });
    expect(connection.calls).toEqual(['accept:share-1']);
  });

  test('an origin that is not the catalog tool origin is `invalid share`, and is declined', async () => {
    const fixture = await acceptFixture();
    const connection = fakeConnection();
    fixture.nod.link.current = connection;
    installSnapshot(fixture.nod, {
      people: [{ id: 'alice', name: 'Alice', roles: ['team'], kind: 'member' }],
      incomingShares: await share(fixture, { toolOrigin: 'https://evil.example.test', secret: 'other' }),
    });
    const shares = createSharesFor(fixture.nod, connection);

    await expect(shares.accept('share-1')).rejects.toThrow('invalid share');
    expect(connection.calls).toEqual(['decline:share-1']);
    expect(fixture.nod.repo.listVault(fixture.meId)).toEqual([]);
  });

  test('a tampered signature, a payload for somebody else and a foreign credential all decline', async () => {
    for (const overrides of [
      { id: 'tampered' },
      { to: 'carol' },
      { metaCredentialId: 'c-other' },
      { metaToolId: 'other' },
    ] as const) {
      const fixture = await acceptFixture();
      const connection = fakeConnection();
      fixture.nod.link.current = connection;
      installSnapshot(fixture.nod, {
        people: [{ id: 'alice', name: 'Alice', roles: ['team'], kind: 'member' }],
        incomingShares: await share(fixture, overrides),
      });
      const shares = createSharesFor(fixture.nod, connection);
      await expect(shares.accept(overrides.id ?? 'share-1')).rejects.toThrow('invalid share');
      expect(connection.calls).toEqual([`decline:${overrides.id ?? 'share-1'}`]);
      expect(fixture.nod.repo.listVault(fixture.meId)).toEqual([]);
    }
  });

  test('a changed sender key never opens a share', async () => {
    const fixture = await acceptFixture();
    const connection = fakeConnection();
    fixture.nod.link.current = connection;
    installSnapshot(fixture.nod, { incomingShares: await share(fixture) });
    fixture.nod.repo.markPeerKeyChanged({
      personId: 'alice',
      x25519: toBase64url((await generateX25519KeyPair()).publicKey),
      ed25519: toBase64url((await generateEd25519KeyPair()).publicKey),
      fingerprint: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ',
      since: AT,
    });
    const shares = createSharesFor(fixture.nod, connection);
    await expect(shares.accept('share-1')).rejects.toThrow('invalid share');
    expect(connection.calls).toEqual(['decline:share-1']);
  });

  test('a cancelled gate accepts nothing and declines nothing', async () => {
    const fixture = await acceptFixture();
    const connection = fakeConnection();
    fixture.nod.link.current = connection;
    installSnapshot(fixture.nod, { incomingShares: await share(fixture) });
    const shares = createSharesFor(fixture.nod, connection, async () => {
      throw new Error('authentication cancelled');
    });

    await expect(shares.accept('share-1')).rejects.toThrow('authentication cancelled');
    expect(connection.calls).toEqual([]);
    expect(fixture.nod.repo.listVault(fixture.meId)).toEqual([]);
  });

  test('an update of a credential already held skips the gate and replaces the value', async () => {
    const fixture = await acceptFixture();
    const connection = fakeConnection();
    fixture.nod.link.current = connection;
    await fixture.nod.vault.save(fixture.meId, {
      toolId: 'figma',
      username: 'old',
      secret: 'old-secret',
      label: 'Tool figma',
      credentialId: 'c1',
      scope: 'role',
    });
    installSnapshot(fixture.nod, {
      incomingShares: await share(fixture, { kind: 'update', username: 'new', secret: 'new-secret' }),
    });
    let gated = 0;
    const shares = createSharesFor(fixture.nod, connection, async () => {
      gated += 1;
    });

    const item = await shares.accept('share-1');

    expect(gated).toBe(0);
    expect(item.username).toBe('new');
    expect(await fixture.nod.vault.read(fixture.meId, 'figma')).toEqual({
      username: 'new',
      secret: 'new-secret',
    });
  });

  test('an unknown share id is `unknown share`, with nothing written', async () => {
    const fixture = await acceptFixture();
    const connection = fakeConnection();
    installSnapshot(fixture.nod, {});
    const shares = createSharesFor(fixture.nod, connection);
    await expect(shares.accept('nobody')).rejects.toThrow('unknown share');
    expect(connection.calls).toEqual([]);
    expect(fixture.nod.repo.listVault(fixture.meId)).toEqual([]);
  });

  test('a valid share with no connection refuses before the vault is written', async () => {
    const fixture = await acceptFixture();
    installSnapshot(fixture.nod, { incomingShares: await share(fixture) });
    const shares = createSharesFor(fixture.nod, null);
    await expect(shares.accept('share-1')).rejects.toThrow(
      'Nod is not connected to a host',
    );
    expect(fixture.nod.repo.listVault(fixture.meId)).toEqual([]);
  });

  test('an invalid share with no connection is still `invalid share`', async () => {
    const fixture = await acceptFixture();
    installSnapshot(fixture.nod, { incomingShares: await share(fixture, { metaToolId: 'other' }) });
    const shares = createSharesFor(fixture.nod, null);
    await expect(shares.accept('share-1')).rejects.toThrow('invalid share');
    expect(fixture.nod.repo.listVault(fixture.meId)).toEqual([]);
  });

  test('a failed accept restores the previous item, so the vault never shows it', async () => {
    const fixture = await acceptFixture();
    const connection = fakeConnection();
    fixture.nod.link.current = connection;
    connection.acceptShare = async () => {
      throw new Error('the host refused the request');
    };
    await fixture.nod.vault.save(fixture.meId, {
      toolId: 'figma',
      username: 'old',
      secret: 'old-secret',
      label: 'Tool figma',
    });
    installSnapshot(fixture.nod, { incomingShares: await share(fixture, { secret: 'new-secret' }) });
    const shares = createSharesFor(fixture.nod, connection);

    await expect(shares.accept('share-1')).rejects.toThrow('the host refused the request');

    expect(await fixture.nod.vault.read(fixture.meId, 'figma')).toEqual({
      username: 'old',
      secret: 'old-secret',
    });
    expect(fixture.nod.repo.vaultItem(fixture.meId, 'figma')?.credentialId).toBeNull();
  });
});

/** `createShares` over a nod fixture with a specific gate and connection. */
function createSharesFor(
  nod: Nod,
  connection: HostConnection | null,
  gate: (reason: string, password?: string) => Promise<void> = async () => {},
): Shares {
  nod.link.current = connection;
  return createShares({
    repo: nod.repo,
    session: { current: () => nod.session.current() },
    vault: nod.vault,
    keys: nod.keys,
    entry: nod.entry,
    connection: () => connection,
    gate,
    onChanged: () => {},
  });
}

// ---------------------------------------------------------------- send and recipients (SP06 §4–§5)

describe('send and the recipient list (SP06 §4–§5)', () => {
  async function sendFixture() {
    const nod = newNod();
    nod.repo.saveRole({ id: 'team', name: 'Team', admin: false });
    nod.repo.saveRole({ id: 'finance', name: 'Finance', admin: false });
    const meId = await openAccount(nod, ['team']);
    nod.repo.saveEntry(tool('figma', { url: `${TOOL_ORIGIN}/app`, roles: ['team', 'finance'] }));
    await nod.vault.save(meId, {
      toolId: 'figma',
      username: CREDENTIAL_USER,
      secret: CREDENTIAL_SECRET,
      label: 'Tool figma',
    });
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
    const people: SnapshotPerson[] = [
      { id: 'bob', name: 'Bob', roles: ['team'], kind: 'member' },
      { id: 'carol', name: 'Carol', roles: ['finance'], kind: 'member' },
      { id: 'dave', name: 'Dave', roles: ['team'], kind: 'member' },
      { id: 'client', name: 'Client', roles: ['finance'], kind: 'client' },
    ];
    installSnapshot(nod, { people });
    return { nod, meId, bobX, bobEd };
  }

  test('recipients carries the key state and the scope verdict of everyone', async () => {
    const { nod } = await sendFixture();
    const connection = fakeConnection();
    const shares = createSharesFor(nod, connection);

    const rows = shares.recipients('figma');
    const byId = new Map(rows.map((row) => [row.personId, row]));

    expect(byId.get('bob')).toMatchObject({ allowed: true, keyStatus: 'pinned', reason: null });
    expect(byId.get('carol')).toMatchObject({
      allowed: false,
      keyStatus: 'unknown',
      reason: 'no role in common',
    });
    expect(byId.get('dave')).toMatchObject({
      allowed: false,
      keyStatus: 'unknown',
      reason: 'recipient has no pinned key',
    });
    expect(byId.get('client')).toMatchObject({ allowed: false, reason: 'no role in common' });
  });

  test('send seals to the pinned key and posts one copy per recipient', async () => {
    const { nod, meId, bobX, bobEd } = await sendFixture();
    const connection = fakeConnection();
    const shares = createSharesFor(nod, connection);

    const answer = await shares.send('figma', ['bob']);

    expect(answer).toEqual({ sent: 1 });
    expect(connection.sent).toHaveLength(1);
    const request = connection.sent[0];
    expect(request).toMatchObject({ toolId: 'figma', scope: 'role', kind: 'send' });
    expect(request.items).toHaveLength(1);
    expect(request.items[0].to).toBe('bob');
    // The uuid lives on the item from the first share and never moves.
    const item = nod.repo.vaultItem(meId, 'figma');
    expect(item?.credentialId).toBe(request.credentialId);

    const opened = await openSealed(request.items[0].sealed, {
      recipientPrivateKey: bobX.privateKey,
      recipientPublicKey: bobX.publicKey,
      senderPublicKey: (await nod.keys.ownPrivate())?.ed25519Public ?? new Uint8Array(),
      credentialId: request.credentialId,
      to: 'bob',
    });
    expect(opened).toMatchObject({
      credentialId: request.credentialId,
      toolId: 'figma',
      toolOrigin: TOOL_ORIGIN,
      username: CREDENTIAL_USER,
      secret: CREDENTIAL_SECRET,
      scope: 'role',
      from: meId,
      to: 'bob',
      kind: 'send',
    });
    // The pinned ed25519 key is what signed it.
    expect(
      await openSealed(request.items[0].sealed, {
        recipientPrivateKey: bobX.privateKey,
        recipientPublicKey: bobX.publicKey,
        senderPublicKey: bobEd.publicKey,
        credentialId: request.credentialId,
        to: 'bob',
      }),
    ).toBeNull();
  });

  test('a role share to somebody with no common role is refused before any request', async () => {
    const { nod } = await sendFixture();
    const connection = fakeConnection();
    const shares = createSharesFor(nod, connection);
    await expect(shares.send('figma', ['carol'])).rejects.toThrow('no role in common');
    expect(connection.sent).toEqual([]);
  });

  test('a changed pinned key refuses the send (RF-45)', async () => {
    const { nod } = await sendFixture();
    const connection = fakeConnection();
    const shares = createSharesFor(nod, connection);
    nod.repo.markPeerKeyChanged({
      personId: 'bob',
      x25519: toBase64url((await generateX25519KeyPair()).publicKey),
      ed25519: toBase64url((await generateEd25519KeyPair()).publicKey),
      fingerprint: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ',
      since: AT,
    });
    await expect(shares.send('figma', ['bob'])).rejects.toThrow('recipient key changed');
    expect(connection.sent).toEqual([]);
  });

  test('a blocked credential has no send and a personal tool is not shareable', async () => {
    const { nod } = await sendFixture();
    const connection = fakeConnection();
    const shares = createSharesFor(nod, connection);

    shares.setScope('figma', 'blocked');
    await expect(shares.send('figma', ['bob'])).rejects.toThrow('blocked credential');
    expect(connection.sent).toEqual([]);

    shares.setScope('figma', 'role');
    nod.repo.saveEntry(tool('personal', { scope: 'personal', ownerId: nod.session.current()?.id }));
    await nod.vault.save(nod.session.current()?.id ?? '', {
      toolId: 'personal',
      username: 'me',
      secret: 'mine',
    });
    await expect(shares.send('personal', ['bob'])).rejects.toThrow('only org tools can be shared');
  });

  test('a cancelled gate sends nothing', async () => {
    const { nod } = await sendFixture();
    const connection = fakeConnection();
    const shares = createSharesFor(nod, connection, async () => {
      throw new Error('authentication cancelled');
    });
    await expect(shares.send('figma', ['bob'])).rejects.toThrow('authentication cancelled');
    expect(connection.sent).toEqual([]);
  });

  test('only the owner holder changes the scope of a credential that travelled', async () => {
    const { nod, meId } = await sendFixture();
    const connection = fakeConnection();
    const shares = createSharesFor(nod, connection);
    await shares.send('figma', ['bob']);
    const credentialId = nod.repo.vaultItem(meId, 'figma')?.credentialId ?? '';
    // The host snapshot says Bob is the owner of this credential, not me.
    installSnapshot(nod, {
      people: [{ id: 'bob', name: 'Bob', roles: ['team'], kind: 'member' }],
      holders: {
        [credentialId]: [
          { personId: 'bob', name: 'Bob', owner: true, scope: 'role', since: AT, removedAt: null },
        ],
      },
    });
    expect(() => shares.setScope('figma', 'org')).toThrow('only the owner can change the scope');

    installSnapshot(nod, {
      holders: {
        [credentialId]: [
          { personId: meId, name: 'Me', owner: true, scope: 'role', since: AT, removedAt: null },
        ],
      },
    });
    expect(shares.setScope('figma', 'org')).toMatchObject({ scope: 'org' });
  });

  test('holders and rotationPending come from the snapshot (K7)', async () => {
    const { nod, meId } = await sendFixture();
    const connection = fakeConnection();
    const shares = createSharesFor(nod, connection);
    await shares.send('figma', ['bob']);
    const credentialId = nod.repo.vaultItem(meId, 'figma')?.credentialId ?? '';
    installSnapshot(nod, {
      holders: {
        [credentialId]: [
          { personId: meId, name: 'Me', owner: true, scope: 'role', since: AT, removedAt: null },
          { personId: 'bob', name: 'Bob', owner: false, scope: 'role', since: AT, removedAt: null },
        ],
      },
      rotationPending: [credentialId],
    });

    const listed = shares.decorate(nod.vault.list(meId));
    expect(listed).toHaveLength(1);
    expect(listed[0].holders.map((holder) => holder.name)).toEqual(['Me', 'Bob']);
    expect(listed[0].rotationPending).toBe(true);
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
  const dir = mkdtempSync(join(tmpdir(), 'nod-shares-'));
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

function connectionFor(running: Running, person: { id: string; token?: string }): HostConnection {
  return running.client.connect({
    address: running.address,
    kid: running.pin.kid,
    publicKey: running.pin.ed25519Public,
    personId: person.id,
  });
}

/** The host's admin, activated through the real command and the real setup route. */
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

/** One person activated on the host and adopted into a Nod, with their key pair published. */
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

/** Every table of the host's database, as text: what a dump of `host.db` would show. */
function dumpHost(db: Database): string {
  const tables = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .all();
  return tables
    .map(({ name }) => JSON.stringify(db.query(`SELECT * FROM "${name}"`).all()))
    .join('\n');
}

describe('send and accept against the real host (K4, K6, K7)', () => {
  test('Alice sends, the host keeps no credential value, Bob accepts, both list both holders', async () => {
    const running = await startHost();
    const admin = await adminOf(running);
    await admin.saveRole({ id: 'team', name: 'Team', admin: false });
    await admin.saveRole({ id: 'finance', name: 'Finance', admin: false });
    await admin.saveTool(tool('figma', { title: 'Figma', url: `${TOOL_ORIGIN}/app`, roles: ['team'] }));
    await admin.grant('team', 'figma', true);
    await admin.grant('finance', 'figma', true);

    const aliceCreated = await admin.createPerson({ email: 'alice@nod.test', name: 'Alice', roles: ['team'] });
    const bobCreated = await admin.createPerson({ email: 'bob@nod.test', name: 'Bob', roles: ['team'] });
    await admin.createPerson({ email: 'carol@nod.test', name: 'Carol', roles: ['finance'] });

    const aliceNod = newNod();
    const bobNod = newNod();
    const alice = await joinNod(running, aliceNod, {
      email: 'alice@nod.test',
      name: 'Alice',
      code: aliceCreated.code,
      password: PASSWORD,
    });
    const bob = await joinNod(running, bobNod, {
      email: 'bob@nod.test',
      name: 'Bob',
      code: bobCreated.code,
      password: PASSWORD,
    });

    // The roster and the tool reach both Nods exactly as a sync would deliver them.
    const aliceSnapshot = await syncNod(aliceNod);
    await syncNod(bobNod);
    expect(aliceSnapshot.orgTools.map((entry) => entry.id)).toEqual(['figma']);
    const rosterIds = new Set(aliceSnapshot.people?.map((person) => person.id) ?? []);
    expect(rosterIds.has(alice.id)).toBe(true);
    expect(rosterIds.has(bob.id)).toBe(true);

    // Alice saves the credential of the guild tool and sends it.
    await aliceNod.vault.save(alice.id, {
      toolId: 'figma',
      username: CREDENTIAL_USER,
      secret: CREDENTIAL_SECRET,
      label: 'Figma',
    });
    const recipients = aliceNod.shares.recipients('figma');
    expect(recipients.find((row) => row.personId === bob.id)).toMatchObject({ allowed: true });

    const sent = await aliceNod.shares.send('figma', [bob.id]);
    expect(sent).toEqual({ sent: 1 });
    const credentialId = aliceNod.repo.vaultItem(alice.id, 'figma')?.credentialId;
    expect(credentialId).not.toBeNull();

    // RF-44: the host holds the metadata and the sealed body, never a username or a secret.
    const dump = dumpHost(running.db);
    expect(dump).not.toContain(CREDENTIAL_USER);
    expect(dump).not.toContain(CREDENTIAL_SECRET);
    expect(running.repo.holdersOf(credentialId ?? '').map((holder) => holder.name)).toEqual([
      'Alice',
    ]);

    // Bob sees it in the inbox and accepts.
    await syncNod(bobNod);
    const inbox = bobNod.shares.inbox();
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({
      credentialId: credentialId ?? '',
      toolId: 'figma',
      toolTitle: 'Figma',
      fromId: alice.id,
      fromName: 'Alice',
      scope: 'role',
      kind: 'send',
    });

    const accepted = await bobNod.shares.accept(inbox[0].id);
    expect(accepted).toMatchObject({ toolId: 'figma', credentialId: credentialId ?? '', scope: 'role' });
    expect(bobNod.repo.vaultOrigin(bob.id, 'figma')).toBe(TOOL_ORIGIN);
    expect(await bobNod.vault.read(bob.id, 'figma')).toEqual({
      username: CREDENTIAL_USER,
      secret: CREDENTIAL_SECRET,
    });

    // K7/RF-54: the host's holders, and both Nods' lists, name both people with date and scope.
    const holders = running.repo.holdersOf(credentialId ?? '');
    expect(holders.map((holder) => [holder.name, holder.owner, holder.scope])).toEqual([
      ['Alice', true, 'role'],
      ['Bob', false, 'role'],
    ]);
    await syncNod(aliceNod);
    await syncNod(bobNod);
    for (const [nod, meId] of [
      [aliceNod, alice.id],
      [bobNod, bob.id],
    ] as const) {
      const listed = nod.shares.decorate(nod.vault.list(meId));
      const item = listed.find((row) => row.toolId === 'figma');
      expect(item?.holders.map((holder) => holder.name).sort()).toEqual(['Alice', 'Bob']);
      expect(item?.holders.every((holder) => holder.since !== '')).toBe(true);
      expect(item?.rotationPending).toBe(false);
    }

    // K6: a `role` share to somebody with no role in common is refused on the Nod.
    const carolId = aliceSnapshot.people?.find((person) => person.name === 'Carol')?.id ?? '';
    await expect(aliceNod.shares.send('figma', [carolId])).rejects.toThrow('no role in common');

    // K6: a blocked credential refuses a send, and the host would refuse it too.
    expect(aliceNod.shares.setScope('figma', 'blocked').scope).toBe('blocked');
    await expect(aliceNod.shares.send('figma', [bob.id])).rejects.toThrow('blocked credential');
    expect(aliceNod.shares.setScope('figma', 'role').scope).toBe('role');

    // SP06 §3: a share whose bytes were changed after the host stored it is declined.
    await aliceNod.shares.send('figma', [bob.id]);
    await syncNod(bobNod);
    const open = bobNod.shares.inbox()[0];
    const cached = JSON.parse(bobNod.repo.hostRecord()?.snapshot ?? '{}') as Snapshot;
    const tampered = cached.incomingShares?.[0];
    if (tampered === undefined) throw new Error('the second share did not reach the inbox');
    cached.incomingShares = [{ ...tampered, sealed: flipOne(tampered.sealed) }];
    bobNod.repo.saveHostSnapshot({
      snapshot: JSON.stringify(cached),
      version: cached.version,
      issuedAt: cached.issuedAt,
      syncedAt: AT,
    });
    await expect(bobNod.shares.accept(open.id)).rejects.toThrow('invalid share');
    const declined = running.db
      .query<{ declined_at: string | null }, [string]>('SELECT declined_at FROM shares WHERE id = ?')
      .get(open.id);
    expect(declined?.declined_at).not.toBeNull();
  });
});
