// Proves the entry screen of the backend (0.4.5, RF-59/60/61): the tiles `session.profiles`
// answers, the disconnected predicate the RPC gate and the guild readers share, the route a typed
// code takes (`host.activate`), the seed import of the first run, and the invite card of a preview.
//
// The four pure pieces are exported from `backend/main.ts` with their runtime injected — like
// `beginAuth` in `test/join.test.ts` — so each rule is pinned without a runtime, a host or a
// database. `test/session.test.ts` covers the target of an unlock where the person rows live.
import { describe, expect, test, mock } from 'bun:test';
import { HOST_ROUTES, generateCode } from '../shared/host-api';
import type * as Backend from '../backend/main';
import type { HostDiscovery } from '../backend/host-client';
import type { HostState, Person } from '../shared/types';

/** The four functions under test, loaded past the `tjs:sqlite` import of `backend/main.ts`. */
interface EntryModule {
  entryProfiles: typeof Backend.entryProfiles;
  disconnectedSession: typeof Backend.disconnectedSession;
  hostWriteRefused: typeof Backend.hostWriteRefused;
  hostReadRefused: typeof Backend.hostReadRefused;
  activateRoute: typeof Backend.activateRoute;
  importSeed: typeof Backend.importSeed;
  inviteView: typeof Backend.inviteView;
  SEED_IMPORT_REFUSED: typeof Backend.SEED_IMPORT_REFUSED;
}

async function backend(): Promise<EntryModule> {
  // `backend/main.ts` reads the `tjs:sqlite` built-in at import time, which only exists in the
  // runtime. A static import would resolve before this stub — the dynamic import is the loading
  // boundary the test has to cross; nothing under test touches SQLite.
  mock.module('tjs:sqlite', () => ({ Database: class {} }));
  return (await import('../backend/main')) as unknown as EntryModule;
}

/** The guild state every profile case starts from, with the fields the tile reads. */
function hostState(over: Partial<HostState> = {}): HostState {
  return {
    status: 'connected',
    guild: 'Guild',
    address: 'https://guild.example.test',
    fingerprint: 'AAAA-BBBB-CCCC-DDDD',
    lastSyncAt: null,
    lastError: null,
    pendingWrites: 0,
    updateRequired: false,
    minAppVersion: null,
    offlineSession: false,
    ...over,
  };
}

function person(over: Partial<Person> = {}): Person {
  return {
    id: 'p-1',
    email: 'ana@example.test',
    name: 'Ana',
    roles: [],
    admin: true,
    activatedAt: '2026-10-15T12:00:00.000Z',
    disabledAt: null,
    ...over,
  };
}

const ADDRESS = 'https://guild.example.test';

describe('session.profiles — the tiles of the entry screen (RF-60)', () => {
  test('a new machine offers the account and the seed import, and no guild', async () => {
    const h = await backend();
    const profiles = await h.entryProfiles({
      countPeople: () => 0,
      hasOpenInvite: () => false,
      lastPerson: async () => null,
      hostRecord: () => null,
      personById: () => null,
      snapshotIconHash: () => undefined,
      guildIcon: async () => null,
      hostState: () => hostState({ status: 'none', guild: null, address: null, fingerprint: null }),
      lastEntry: async () => null,
      biometric: async () => false,
    });

    // RF-61: the seed import is offered exactly while no account exists.
    expect(profiles.offline).toEqual({
      hasAccount: false,
      requiresInvite: false,
      email: null,
      seedImportable: true,
    });
    expect(profiles.guilds).toEqual([]);
    expect(profiles.last).toBeNull();
    expect(profiles.biometric).toBe(false);
  });

  test('an open local invite demands a code, and the last person prefills the email', async () => {
    const h = await backend();
    const profiles = await h.entryProfiles({
      countPeople: () => 2,
      hasOpenInvite: () => true,
      lastPerson: async () => person({ email: 'last@example.test' }),
      hostRecord: () => null,
      personById: () => null,
      snapshotIconHash: () => undefined,
      guildIcon: async () => null,
      hostState: () => hostState({ status: 'none' }),
      lastEntry: async () => ({ kind: 'offline' }),
      biometric: async () => true,
    });

    expect(profiles.offline).toEqual({
      hasAccount: true,
      requiresInvite: true,
      email: 'last@example.test',
      seedImportable: false,
    });
    expect(profiles.last).toEqual({ kind: 'offline' });
    expect(profiles.biometric).toBe(true);
  });

  test('the guild tile carries its address, the account and the verified icon', async () => {
    const h = await backend();
    const profiles = await h.entryProfiles({
      countPeople: () => 1,
      hasOpenInvite: () => false,
      lastPerson: async () => person(),
      hostRecord: () => ({ address: ADDRESS, guild: 'Guild', personId: 'host-person-1', snapshot: '{}' }),
      personById: () => person({ id: 'host-person-1', email: 'ana@guild.test', name: 'Ana Guild' }),
      // The cached body names a digest; the module answers the icon only when the bytes match it.
      snapshotIconHash: () => 'a'.repeat(64),
      guildIcon: async (hash) => (hash === null ? null : 'data:image/png;base64,AAAA'),
      hostState: () => hostState({ updateRequired: true }),
      lastEntry: async () => ({ kind: 'guild', id: ADDRESS }),
      biometric: async () => false,
    });

    expect(profiles.guilds).toHaveLength(1);
    expect(profiles.guilds[0]).toEqual({
      id: ADDRESS,
      guild: 'Guild',
      address: ADDRESS,
      icon: 'data:image/png;base64,AAAA',
      email: 'ana@guild.test',
      name: 'Ana Guild',
      status: 'connected',
      updateRequired: true,
    });
    expect(profiles.last).toEqual({ kind: 'guild', id: ADDRESS });
    // An account exists, so neither the offline setup nor the seed import is offered.
    expect(profiles.offline.seedImportable).toBe(false);
  });

  test('a guild with no icon and no local person answers null and empty fields', async () => {
    const h = await backend();
    const profiles = await h.entryProfiles({
      countPeople: () => 1,
      hasOpenInvite: () => false,
      lastPerson: async () => null,
      hostRecord: () => ({ address: ADDRESS, guild: 'Guild', personId: 'host-person-1', snapshot: null }),
      personById: () => null,
      snapshotIconHash: () => null,
      guildIcon: async () => null,
      hostState: () => hostState(),
      lastEntry: async () => null,
      biometric: async () => false,
    });

    const tile = profiles.guilds[0];
    expect(tile.icon).toBeNull();
    expect(tile.email).toBe('');
    expect(tile.name).toBe('');
  });

  test('a remembered guild this Nod no longer holds preselects nothing', async () => {
    const h = await backend();
    const profiles = await h.entryProfiles({
      countPeople: () => 1,
      hasOpenInvite: () => false,
      lastPerson: async () => person(),
      // No `host` row: the guild the `store` remembers was removed since (`host.remove`).
      hostRecord: () => null,
      personById: () => null,
      snapshotIconHash: () => undefined,
      guildIcon: async () => null,
      hostState: () => hostState({ status: 'none', guild: null, address: null, fingerprint: null }),
      lastEntry: async () => ({ kind: 'guild', id: ADDRESS }),
      biometric: async () => false,
    });

    expect(profiles.guilds).toEqual([]);
    expect(profiles.last).toBeNull();
  });
});

describe('the disconnected predicate (O2 + RF-60)', () => {
  test('the offline session disconnects the guild exactly as being too old does', async () => {
    const h = await backend();

    expect(h.disconnectedSession(false, null, true)).toBe(false);
    expect(h.disconnectedSession(false, 'guild', true)).toBe(false);
    expect(h.disconnectedSession(false, 'offline', true)).toBe(true);
    expect(h.disconnectedSession(true, 'guild', true)).toBe(true);
    expect(h.disconnectedSession(true, 'offline', true)).toBe(true);
  });

  test('a Nod with no guild is never disconnected: its offline session writes its local tables', async () => {
    const h = await backend();

    expect(h.disconnectedSession(false, 'offline', false)).toBe(false);
    expect(h.hostWriteRefused('catalog.save', h.disconnectedSession(false, 'offline', false))).toBe(false);
  });

  test('the guild invite methods are in the two gate tables', async () => {
    const h = await backend();

    expect(h.hostReadRefused('guildInvites.list', true)).toBe(true);
    expect(h.hostWriteRefused('guildInvites.create', true)).toBe(true);
    expect(h.hostWriteRefused('guildInvites.revoke', true)).toBe(true);
    // Nothing of the guild is listing or writing while the guild is reachable.
    expect(h.hostReadRefused('guildInvites.list', false)).toBe(false);
    // The two auth methods the entry screen runs while locked stay outside the tables: the joins
    // refuse themselves over the discovery's minimum instead (`beginAuth`/`discoverFor`).
    expect(h.hostWriteRefused('host.activate', true)).toBe(false);
    expect(h.hostWriteRefused('host.invitePreview', true)).toBe(false);
  });
});

describe('the route of a typed code (RF-59)', () => {
  test('setup, invite and access codes take their own route; a name is needed twice', async () => {
    const h = await backend();

    expect(h.activateRoute(generateCode('setup'))).toEqual({
      kind: 'setup',
      route: HOST_ROUTES.authSetup,
      needsName: true,
    });
    expect(h.activateRoute(generateCode('invite'))).toEqual({
      kind: 'invite',
      route: HOST_ROUTES.authJoin,
      needsName: true,
    });
    expect(h.activateRoute(generateCode('access'))).toEqual({
      kind: 'access',
      route: HOST_ROUTES.authActivate,
      needsName: false,
    });
  });

  test('a grouped code reads as its kind, and anything else is no code at all', async () => {
    const h = await backend();
    const invite = generateCode('invite');
    const grouped = invite.replace(/(.{4})(?=.)/g, '$1-');

    // The kind is the code's own length (SP02 §3), not what the screen was showing: the hyphens a
    // person pastes from the link do not change the route.
    expect(h.activateRoute(grouped)?.kind).toBe('invite');
    expect(h.activateRoute('NOPE')).toBeNull();
    expect(h.activateRoute('')).toBeNull();
  });
});

describe('session.importSeed — the optional seed of the first run (RF-61)', () => {
  test('an account closes the window before the file is even read', async () => {
    const h = await backend();
    let applied = 0;

    await expect(
      h.importSeed(
        {
          countPeople: () => 1,
          apply: async () => {
            applied += 1;
            return null;
          },
        },
        '/tmp/seed.json',
      ),
    ).rejects.toThrow(h.SEED_IMPORT_REFUSED);
    expect(applied).toBe(0);
  });

  test('with nobody on the machine the seed is applied, and the answer may be nothing to do', async () => {
    const h = await backend();
    const seen: string[] = [];

    const first = await h.importSeed(
      {
        countPeople: () => 0,
        apply: async (path) => {
          seen.push(path);
          return { version: 3, counts: { entries: 2, roles: 1, invites: 0 } };
        },
      },
      '/tmp/seed.json',
    );
    // A file already at this version (or one that is not a seed) is applied by nobody's fault.
    const second = await h.importSeed(
      {
        countPeople: () => 0,
        apply: async () => null,
      },
      '/tmp/seed.json',
    );

    expect(seen).toEqual(['/tmp/seed.json']);
    expect(first?.version).toBe(3);
    expect(first?.counts).toEqual({ entries: 2, roles: 1, invites: 0 });
    expect(second).toBeNull();
  });
});

describe('host.invitePreview — the invite card (RF-59)', () => {
  test('the preview becomes the card, and its base64url icon a data URI', async () => {
    const h = await backend();
    const found = {
      address: ADDRESS,
      fingerprint: 'AAAA-BBBB-CCCC-DDDD',
      pin: { kid: 'kid-1', ed25519Public: 'A'.repeat(43) },
      document: { guild: 'Guild', minAppVersion: '0.1.0' },
    } as unknown as HostDiscovery;

    const view = h.inviteView(found, {
      guild: 'Guild',
      roles: [
        { id: 'r-1', name: 'Team' },
        { id: 'r-2', name: 'Guests' },
      ],
      expiresAt: '2026-11-01T00:00:00.000Z',
      usesLeft: 3,
      // `AAD_` is base64url for 0x00 0x01 0x0d (RFC 4648 §5: `-`/`_` replace `+`/`/`).
      icon: 'AAEN',
    });

    expect(view).toEqual({
      guild: 'Guild',
      address: ADDRESS,
      // The address and the fingerprint the person just confirmed are the ones the person sees.
      fingerprint: 'AAAA-BBBB-CCCC-DDDD',
      roles: ['Team', 'Guests'],
      expiresAt: '2026-11-01T00:00:00.000Z',
      usesLeft: 3,
      // Standard base64, because that is what a `data:` URI carries.
      icon: 'data:image/png;base64,AAEN',
    });
  });

  test('an invite with no limit, no expiry and no icon answers nulls', async () => {
    const h = await backend();
    const found = {
      address: ADDRESS,
      fingerprint: 'AAAA',
      pin: { kid: 'kid-1', ed25519Public: 'A'.repeat(43) },
      document: { guild: 'Guild', minAppVersion: '0.1.0' },
    } as unknown as HostDiscovery;

    const view = h.inviteView(found, {
      guild: 'Guild',
      roles: [],
      expiresAt: null,
      usesLeft: null,
      icon: null,
    });

    expect(view.roles).toEqual([]);
    expect(view.expiresAt).toBeNull();
    expect(view.usesLeft).toBeNull();
    expect(view.icon).toBeNull();
  });
});
