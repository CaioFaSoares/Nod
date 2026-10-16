// The connected catalog (`backend/connected-catalog.ts`): story B5's acceptance — SP05 §2's
// "connected catalog" (org tools, roles and grants from the verified snapshot, parsed once per
// change and kept in memory, the local tables untouched) and SP05 §4's sidebar order, over a real
// in-memory repository and, for the tampered body, a real HTTP server signing with a generated key
// the way `test/host-client.test.ts` does.
//
// Behavior, not wording: what is asserted is which entries a person sees, what the local tables hold
// afterwards, and what the module answers at the boundary of the 14-day window.
import { describe, expect, test } from 'bun:test';
import { createConnectedCatalog } from '../backend/connected-catalog';
import type { ConnectedCatalog } from '../backend/connected-catalog';
import { createHostClient } from '../backend/host-client';
import type { HostFailure, PinnedHost } from '../backend/host-client';
import { createRepo } from '../backend/repo';
import type { Repo } from '../backend/repo';
import { toBase64url } from '../shared/encoding';
import { HOST_ROUTES } from '../shared/host-api';
import type { PersonalView, Snapshot } from '../shared/host-api';
import { generateEd25519KeyPair, sign } from '../shared/seal';
import type { Entry, Role, SecretStore, SqlDb } from '../shared/types';
import { memorySqlite } from './helpers/sqlite-bun';

const PERSON = 'uuid-person-1';
const OTHER_PERSON = 'uuid-person-2';
const ISSUED = '2026-10-16T09:00:00.000Z';
/** The instant of the successful sync every fixture starts from. */
const SYNCED = '2026-10-16T10:00:00.000Z';
/** A minute after that sync: inside the 14-day window of `docs/canonico.md` §22. */
const NOW = Date.parse(SYNCED) + 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const TEAM: Role = { id: 'team', name: 'Team', admin: false };
const FINANCE: Role = { id: 'finance', name: 'Finance', admin: false };

/** SP04 §2's `me`, for the person this Nod signs in as unless the case says otherwise. */
function me(patch: Partial<Snapshot['me']> = {}): Snapshot['me'] {
  return {
    id: PERSON,
    email: 'ana@example.test',
    name: 'Ana',
    roles: [TEAM.id],
    admin: false,
    kind: 'member',
    ...patch,
  };
}

/** An entry as the host builds it: granted to `team` unless the case says otherwise. */
function tool(id: string, patch: Partial<Entry> = {}): Entry {
  return {
    id,
    scope: 'org',
    ownerId: null,
    title: id.toUpperCase(),
    url: `https://${id}.example.test`,
    icon: null,
    order: 1,
    roles: [TEAM.id],
    views: [],
    auth: null,
    active: true,
    ...patch,
  };
}

/** One SP04 §2 body, as the bytes the pinned key signed. */
function body(patch: Partial<Omit<Snapshot, 'api'>> = {}): string {
  return JSON.stringify({
    api: 1,
    version: 'v1',
    issuedAt: ISSUED,
    me: me(),
    roles: [TEAM, FINANCE],
    orgTools: [],
    personalTools: [],
    personalViews: [],
    favorites: [],
    ...patch,
  });
}

/** A personal view of SP04 §2, hung under `entryId`. */
function personalView(id: string, entryId: string): PersonalView {
  return {
    id,
    entryId,
    label: id,
    url: `https://${entryId}.example.test/${id}`,
    mode: 'window',
    scope: 'personal',
    ownerId: PERSON,
    updatedAt: ISSUED,
  };
}

interface Nod {
  db: SqlDb;
  repo: Repo;
  catalog: ConnectedCatalog;
  /** The clock the 14-day window is measured against; a case moves it by hand. */
  clock: { at: number };
  /** SP04 §2: the row one successful sync writes, then the catalog layer's read of that row. */
  sync(raw: string, version?: string, syncedAt?: string): boolean;
  /** What `backend/main.ts` does on every trigger: read the row, hand it to the catalog. */
  rederive(): boolean;
}

/** A Nod with a pinned host row and a movable clock. */
function nodWithHost(now = NOW): Nod {
  const db = memorySqlite();
  const repo = createRepo(db);
  repo.migrate();
  repo.saveHost({
    address: 'https://nod.example.test',
    guild: 'Example Guild',
    kid: 'kid-a',
    publicKey: 'cGlu',
    personId: PERSON,
    salt: 'c2FsdA',
    addedAt: ISSUED,
  });
  const clock = { at: now };
  const catalog = createConnectedCatalog({ now: () => clock.at });
  const rederive = (): boolean => catalog.refresh(repo.hostRecord());
  return {
    db,
    repo,
    catalog,
    clock,
    rederive,
    // SP04 §2: the body, its version and the instant of the success land in the row in one write.
    sync(raw, version = 'v1', syncedAt = SYNCED) {
      repo.saveHostSnapshot({ snapshot: raw, version, issuedAt: ISSUED, syncedAt });
      return rederive();
    },
  };
}

function idsOf(catalog: ConnectedCatalog): string[] {
  return catalog.entries().map((entry) => entry.id);
}

/** Every row of the local-mode catalog tables, as text: what a connected Nod may not move. */
function localCatalogText(db: SqlDb): string {
  return ['tool', 'tool_view', 'tool_grant', 'role']
    .map((table) => JSON.stringify(db.all(`SELECT * FROM ${table}`)))
    .join('\n');
}

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

/** The refusal of a call that had to be refused, or a thrown expectation when it resolved. */
async function refusalOf(work: Promise<unknown>): Promise<{ failure: HostFailure; message: string }> {
  try {
    await work;
  } catch (error) {
    const host = error as { failure?: HostFailure; message?: string };
    if (host.failure === undefined) throw error;
    return { failure: host.failure, message: host.message ?? '' };
  }
  throw new Error('expected the call to be refused');
}

interface Signer {
  pin(personId: string): PinnedHost;
  /** What `/v1/state` answers next: the bytes served and the bytes signed (they differ in a tamper). */
  answer(body: string, signed?: string): void;
  stop(): void;
}

/** A loopback host that signs `/v1/state` with a generated Ed25519 pair (SP04 §2). */
async function serveSigner(): Promise<Signer> {
  const pair = await generateEd25519KeyPair();
  const kid = 'kid-a';
  let current = { body: '', signed: '' };
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname !== HOST_ROUTES.state) return new Response('not found', { status: 404 });
      const signature = toBase64url(await sign(new TextEncoder().encode(current.signed), pair.privateKey));
      return new Response(current.body, {
        status: 200,
        headers: { ETag: '"v1"', 'Nod-Signature': `kid=${kid}; sig=${signature}` },
      });
    },
  });
  return {
    pin: (personId) => ({
      address: `http://127.0.0.1:${server.port}`,
      kid,
      publicKey: toBase64url(pair.publicKey),
      personId,
    }),
    answer: (body, signed = body) => {
      current = { body, signed };
    },
    stop: () => {
      server.stop(true);
    },
  };
}

describe('SP05 §2 — the catalog comes from the snapshot', () => {
  test('the org tools and the roles are the snapshot ones, and the local tables stay untouched', () => {
    const nod = nodWithHost();
    nod.repo.saveEntry(tool('local-kanban', { roles: [] }));
    nod.repo.saveRole({ id: 'local-role', name: 'Local', admin: false });
    const before = localCatalogText(nod.db);

    expect(nod.sync(body({ orgTools: [tool('jitsi')] }))).toBe(true);

    expect(idsOf(nod.catalog)).toEqual(['jitsi']);
    expect(nod.catalog.roles().map((role) => role.id)).toEqual(['team', 'finance']);
    expect(nod.catalog.current()?.me.id).toBe(PERSON);

    // SP05 §2: the `tool`/`role` tables keep the local-mode catalog, byte for byte — "removing the
    // host returns to them" — and the local tool is not what the connected Nod shows.
    expect(localCatalogText(nod.db)).toBe(before);
    expect(nod.repo.listEntries().map((entry) => entry.id)).toEqual(['local-kanban']);
    expect(nod.catalog.roles().map((role) => role.id)).not.toContain('local-role');
  });

  test('an entry keeps what the host sent: grants, views, icon, scope, order', () => {
    const nod = nodWithHost();
    const granted = tool('jitsi', {
      icon: 'data:image/png;base64,AA',
      order: 7,
      roles: [TEAM.id, FINANCE.id],
      views: [{ id: 'view-org', label: 'Sprint', url: 'https://jitsi.example.test/sprint', mode: 'window' }],
    });
    nod.sync(body({ orgTools: [granted] }));

    const entry = nod.catalog.entries()[0];
    expect(entry?.roles).toEqual([TEAM.id, FINANCE.id]);
    expect(entry?.views.map((view) => view.label)).toEqual(['Sprint']);
    expect(entry?.icon).toBe('data:image/png;base64,AA');
    expect(entry?.order).toBe(7);
    expect(entry?.scope).toBe('org');
  });

  test('a person with the granted role sees the tool; another role does not', () => {
    const team = nodWithHost();
    team.sync(body({ orgTools: [tool('jitsi')] }));
    expect(idsOf(team.catalog)).toEqual(['jitsi']);

    // The host filters per person; a body that carried a tool no role of mine holds grants nothing.
    const finance = nodWithHost();
    finance.sync(body({ me: me({ roles: [FINANCE.id] }), orgTools: [tool('jitsi')] }));
    expect(idsOf(finance.catalog)).toEqual([]);
    expect(finance.catalog.roles().map((role) => role.id)).toEqual(['team', 'finance']);

    // An admin sees the whole guild catalog, whatever the grants say (SP04 §2).
    const admin = nodWithHost();
    admin.sync(body({ me: me({ roles: [], admin: true }), orgTools: [tool('jitsi')] }));
    expect(idsOf(admin.catalog)).toEqual(['jitsi']);
  });

  test('a grant added on the host shows the tool after the next sync, only for that role', () => {
    const nod = nodWithHost();
    nod.sync(body({ version: 'v1' }));
    expect(idsOf(nod.catalog)).toEqual([]);

    const granted = body({ version: 'v2', issuedAt: '2026-10-16T10:04:00.000Z', orgTools: [tool('jitsi')] });
    expect(nod.sync(granted, 'v2', '2026-10-16T10:05:00.000Z')).toBe(true);
    expect(idsOf(nod.catalog)).toEqual(['jitsi']);
    expect(nod.catalog.current()?.version).toBe('v2');

    // The same new grant, read by a person of another role: still nothing to show.
    const finance = nodWithHost();
    finance.sync(body({ version: 'v1' }));
    finance.sync(body({ version: 'v2', me: me({ roles: [FINANCE.id] }), orgTools: [tool('jitsi')] }), 'v2');
    expect(idsOf(finance.catalog)).toEqual([]);
  });

  test('without a body there is nothing of the guild, and removing the host returns to nothing', () => {
    const nod = nodWithHost();
    expect(nod.rederive()).toBe(false);
    expect(nod.catalog.current()).toBeNull();
    expect(idsOf(nod.catalog)).toEqual([]);
    expect(nod.catalog.roles()).toEqual([]);

    expect(nod.sync(body({ orgTools: [tool('jitsi')] }))).toBe(true);
    expect(idsOf(nod.catalog)).toEqual(['jitsi']);

    nod.repo.clearHost();
    // Losing the host is news like any other: the catalog goes from the guild's entries to none.
    expect(nod.rederive()).toBe(true);
    expect(nod.catalog.current()).toBeNull();
    expect(idsOf(nod.catalog)).toEqual([]);
    expect(nod.catalog.roles()).toEqual([]);
  });
});

describe('SP05 §4 — order and views', () => {
  test('the favorites come first, then the org tools, then the personal ones', () => {
    const nod = nodWithHost();
    const mine = tool('mine', { scope: 'personal', ownerId: PERSON, roles: [], order: 3 });
    nod.sync(
      body({
        orgTools: [tool('alpha', { order: 1 }), tool('beta', { order: 2 })],
        personalTools: [mine],
        favorites: ['beta', 'mine'],
      }),
    );
    expect(idsOf(nod.catalog)).toEqual(['beta', 'mine', 'alpha']);

    // A favorite that resolves to no entry is skipped, wherever it sits in the list.
    nod.sync(
      body({
        orgTools: [tool('alpha', { order: 1 }), tool('beta', { order: 2 })],
        personalTools: [mine],
        favorites: ['ghost', 'beta', 'mine', 'beta'],
      }),
      'v2',
    );
    expect(idsOf(nod.catalog)).toEqual(['beta', 'mine', 'alpha']);
  });

  test('a personal view hangs under its entry, after the entry own views', () => {
    const nod = nodWithHost();
    const jitsi = tool('jitsi', {
      views: [{ id: 'view-org', label: 'Sprint', url: 'https://jitsi.example.test/sprint', mode: 'window' }],
    });
    nod.sync(body({ orgTools: [jitsi], personalViews: [personalView('view-mine', 'jitsi')] }));

    // The index of a view is what `tools.openView` reads, so the order is the contract.
    expect(nod.catalog.entries()[0]?.views.map((view) => view.label)).toEqual(['Sprint', 'view-mine']);
  });

  test('a personal view of an entry I do not see travels nowhere', () => {
    const nod = nodWithHost();
    nod.sync(
      body({ orgTools: [tool('jitsi')], personalViews: [personalView('view-ghost', 'ghost-tool')] }),
    );
    expect(idsOf(nod.catalog)).toEqual(['jitsi']);
    expect(nod.catalog.entries()[0]?.views).toEqual([]);
  });
});

describe('RF-37 — the 14-day cached window', () => {
  test('inside the window the org tools show; past it they hide and the personal ones stay', () => {
    const nod = nodWithHost();
    const mine = tool('mine', { scope: 'personal', ownerId: PERSON, roles: [] });
    nod.sync(body({ orgTools: [tool('jitsi')], personalTools: [mine], favorites: ['jitsi'] }));

    nod.clock.at = Date.parse(SYNCED) + 14 * DAY_MS - 1;
    expect(nod.catalog.current()?.orgUsable).toBe(true);
    expect(idsOf(nod.catalog)).toEqual(['jitsi', 'mine']);

    // The window is the half-open `[lastSyncAt, lastSyncAt + 14d)`: the day it completes, the org
    // half is hidden until a sync succeeds, and a favorite of a hidden tool goes with it.
    nod.clock.at = Date.parse(SYNCED) + 14 * DAY_MS;
    expect(nod.catalog.current()?.orgUsable).toBe(false);
    expect(idsOf(nod.catalog)).toEqual(['mine']);
    expect(nod.catalog.roles().map((role) => role.id)).toEqual(['team', 'finance']);
  });

  test('a sync that changed nothing reopens the window without re-reading the body', () => {
    const nod = nodWithHost();
    const raw = body({ orgTools: [tool('jitsi')] });
    nod.sync(raw);

    nod.clock.at = Date.parse(SYNCED) + 14 * DAY_MS + 1;
    expect(idsOf(nod.catalog)).toEqual([]);

    // The `304` of the same body: the host answered, so the cache is current again.
    expect(nod.sync(raw, 'v1', new Date(nod.clock.at).toISOString())).toBe(true);
    expect(idsOf(nod.catalog)).toEqual(['jitsi']);

    // And the next sync of the same body tells the page nothing new — the signal is what is shown.
    expect(nod.sync(raw, 'v1', new Date(nod.clock.at + 60_000).toISOString())).toBe(false);
    expect(idsOf(nod.catalog)).toEqual(['jitsi']);
  });
});

describe('the verified bytes (SP04 §2, SP05 §2)', () => {
  test('a tampered body is refused by the client, and the previous cache stays', async () => {
    const signer = await serveSigner();
    const nod = nodWithHost();
    const connection = createHostClient({ fetch, keychain: memoryKeychain() }).connect(signer.pin(PERSON));

    const first = body({ orgTools: [tool('jitsi')] });
    signer.answer(first);
    const verified = await connection.snapshot();
    if (verified.notModified) throw new Error('expected a body');
    expect(verified.raw).toBe(first);
    expect(nod.sync(verified.raw)).toBe(true);
    expect(idsOf(nod.catalog)).toEqual(['jitsi']);

    // One byte changed after signing: the client refuses it before anything parses it, so no row
    // and no cache ever sees it.
    const tampered = body({ version: 'v2', orgTools: [tool('jitsi'), tool('stealer')] });
    signer.answer(tampered.replace('STEALER', 'STEALEN'), tampered);
    const refused = await refusalOf(connection.snapshot());
    expect(refused.failure).toBe('signature');
    expect(nod.repo.hostRecord()?.snapshot).toBe(first);

    expect(nod.rederive()).toBe(false);
    expect(idsOf(nod.catalog)).toEqual(['jitsi']);
    signer.stop();
  });

  test('a stored body that is not the document keeps the previous cache', () => {
    const nod = nodWithHost();
    nod.sync(body({ orgTools: [tool('jitsi')] }));
    expect(idsOf(nod.catalog)).toEqual(['jitsi']);

    // Signed and stored — the client checks the signature and the envelope, `shared/host-merge.ts`
    // reads the document — but not a body this Nod can show.
    const refused = [
      'not json',
      '{"api":2,"version":"v2","issuedAt":"2026-10-16T10:05:00.000Z"}',
      body({ version: 'v3', me: me({ id: OTHER_PERSON }), orgTools: [tool('jitsi', { order: 9 })] }),
    ];
    for (const raw of refused) {
      expect(nod.sync(raw, 'v9')).toBe(false);
      expect(idsOf(nod.catalog)).toEqual(['jitsi']);
      // The catalog keeps answering with the body it is showing, not with the row it refused.
      expect(nod.catalog.current()?.version).toBe('v1');
      expect(nod.catalog.entries()[0]?.order).toBe(1);
    }
  });
});
