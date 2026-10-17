// B7: the pure overlay of SP05 §2 (`shared/host-merge.ts`'s `applyOutbox`, `attachPersonalViews`) and
// the local/connected personal layer of `backend/personal.ts` (SP05 §2–§4) against a real SQLite.
import { describe, expect, test } from 'bun:test';
import { createRepo } from '../backend/repo';
import { createPersonal, generatePersonalToolId, PERSONAL_TOOL_ID } from '../backend/personal';
import { applyOutbox, attachPersonalViews } from '../shared/host-merge';
import { HOST_ROUTES } from '../shared/host-api';
import type { OutboxOp, PersonalRows } from '../shared/host-merge';
import type { Personal } from '../backend/personal';
import type { PersonalView } from '../shared/host-api';
import type { Entry, Id, Person, View } from '../shared/types';
import type { Repo } from '../backend/repo';
import { memorySqlite } from './helpers/sqlite-bun';

function entry(id: string, fields: Partial<Entry> = {}): Entry {
  return {
    id,
    title: `Tool ${id}`,
    url: `https://${id}.example.test/app`,
    icon: null,
    order: 1,
    roles: [],
    views: [],
    auth: null,
    active: true,
    ...fields,
  };
}

function view(id: string, entryId: string, fields: Partial<PersonalView> = {}): PersonalView {
  return {
    id,
    entryId,
    label: `View ${id}`,
    url: `https://${entryId}.example.test/${id}`,
    mode: 'window',
    scope: 'personal',
    ownerId: 'p1',
    updatedAt: '2026-10-15T10:00:00.000Z',
    ...fields,
  };
}

function op(method: OutboxOp['method'], path: string, body: unknown): OutboxOp {
  return { method, path, body: JSON.stringify(body) };
}

const seconds = (at: string) => `2026-10-15T10:00:${at}.000Z`;

// ---------------------------------------------------------------- the overlay (SP04 §4)

describe('applyOutbox', () => {
  const empty: PersonalRows = { personalTools: [], personalViews: [], favorites: [] };

  test('a PUT adds the tool and a second one replaces it in place', () => {
    const first = entry('p-aaaaaaaaaa', { scope: 'personal', ownerId: 'p1', title: 'Notes' });
    const afterFirst = applyOutbox(empty, [op('PUT', HOST_ROUTES.personalTool.replace(':id', first.id), first)]);
    expect(afterFirst.personalTools.map((e) => e.id)).toEqual([first.id]);

    const second = { ...first, title: 'Notes v2' };
    const afterSecond = applyOutbox(afterFirst, [
      op('PUT', HOST_ROUTES.personalTool.replace(':id', first.id), second),
    ]);
    expect(afterSecond.personalTools).toHaveLength(1);
    expect(afterSecond.personalTools[0].title).toBe('Notes v2');
  });

  test('a DELETE takes the tool and the personal views hung under it', () => {
    const tool = entry('p-bbbbbbbbbb', { scope: 'personal', ownerId: 'p1' });
    const rows: PersonalRows = {
      personalTools: [tool, entry('jitsi', { scope: 'org', ownerId: null })],
      personalViews: [view('v1', tool.id), view('v2', 'jitsi')],
      favorites: [tool.id, 'jitsi'],
    };
    const after = applyOutbox(rows, [op('DELETE', HOST_ROUTES.personalTool.replace(':id', tool.id), { updatedAt: seconds('01') })]);
    expect(after.personalTools.map((e) => e.id)).toEqual(['jitsi']);
    expect(after.personalViews.map((v) => v.id)).toEqual(['v2']);
    // The favorites are the person's own list: a removed entry keeps its place until they change it.
    expect(after.favorites).toEqual([tool.id, 'jitsi']);
  });

  test('a PUT of a view replaces it and a DELETE removes it', () => {
    const rows: PersonalRows = { personalTools: [], personalViews: [view('v1', 'jitsi')], favorites: [] };
    const renamed = { ...view('v1', 'jitsi'), label: 'Room 2' };
    const after = applyOutbox(rows, [
      op('PUT', HOST_ROUTES.personalView.replace(':id', 'v1'), renamed),
      op('PUT', HOST_ROUTES.personalView.replace(':id', 'v2'), view('v2', 'jitsi')),
    ]);
    expect(after.personalViews.map((v) => v.label)).toEqual(['Room 2', 'View v2']);
    const removed = applyOutbox(after, [op('DELETE', HOST_ROUTES.personalView.replace(':id', 'v2'), { updatedAt: seconds('02') })]);
    expect(removed.personalViews.map((v) => v.id)).toEqual(['v1']);
  });

  test('a PUT of the favorites replaces the whole ordered list', () => {
    const rows: PersonalRows = { personalTools: [], personalViews: [], favorites: ['jitsi'] };
    const after = applyOutbox(rows, [op('PUT', HOST_ROUTES.favorites, { entries: ['figma', 'jitsi'], updatedAt: seconds('03') })]);
    expect(after.favorites).toEqual(['figma', 'jitsi']);
  });

  test('a path, a body or an id the module does not know leaves the rows alone', () => {
    const rows: PersonalRows = {
      personalTools: [entry('p-cccccccccc', { scope: 'personal', ownerId: 'p1' })],
      personalViews: [view('v1', 'jitsi')],
      favorites: ['jitsi'],
    };
    const after = applyOutbox(rows, [
      op('PUT', '/v1/admin/tools/jitsi', entry('jitsi')),
      op('PUT', HOST_ROUTES.personalTool.replace(':id', 'p-cccccccccc'), { id: 'p-dddddddddd' }),
      { method: 'PUT', path: HOST_ROUTES.personalTool.replace(':id', 'p-eeeeeeeeee'), body: 'not json' },
      op('DELETE', HOST_ROUTES.personalView.replace(':id', 'v-nope'), { updatedAt: seconds('04') }),
      op('PUT', HOST_ROUTES.favorites, { entries: 'jitsi' }),
    ]);
    expect(after.personalTools.map((e) => e.id)).toEqual(['p-cccccccccc']);
    expect(after.personalViews.map((v) => v.id)).toEqual(['v1']);
    expect(after.favorites).toEqual(['jitsi']);
  });

  test('no pending write is the snapshot itself', () => {
    const rows: PersonalRows = { personalTools: [], personalViews: [], favorites: ['jitsi'] };
    expect(applyOutbox(rows, [])).toBe(rows);
  });
});

describe('attachPersonalViews', () => {
  test('a view hangs after the entry own views, and one of the same id is never shown twice', () => {
    const own: View = { id: 'v1', label: 'Room', url: 'https://jitsi.example.test/room', mode: 'window' };
    const entries = [entry('jitsi', { views: [own] }), entry('figma')];
    const attached = attachPersonalViews(entries, [
      // the host answers a personal tool's own views inside the entry *and* in `personalViews`
      view('v1', 'jitsi', { scope: 'org' }),
      view('v2', 'jitsi'),
      view('v3', 'nothing-i-see'),
    ]);
    expect(attached[0].views.map((v) => v.id)).toEqual(['v1', 'v2']);
    expect(attached[1].views).toEqual([]);
  });
});

// ---------------------------------------------------------------- the ids (SP03 §2)

describe('generatePersonalToolId', () => {
  test('is `p-` and ten lowercase base32 characters, and two calls differ', () => {
    const ids = new Set<Id>();
    for (let i = 0; i < 50; i += 1) {
      const id = generatePersonalToolId();
      expect(id).toMatch(PERSONAL_TOOL_ID);
      expect(id).toMatch(/^p-[a-z0-9]{10}$/);
      ids.add(id);
    }
    expect(ids.size).toBe(50);
  });
});

// ---------------------------------------------------------------- the layer

interface Harness {
  repo: Repo;
  personal: Personal;
  person: Person;
  queued: () => number;
  connected: (on: boolean) => void;
}

/** The org half of the connected tests: the two entries the person is granted. */
const CONNECTED_BASE: Entry[] = [
  entry('jitsi', { scope: 'org', ownerId: null, roles: ['admin'] }),
  entry('figma', { scope: 'org', ownerId: null, roles: ['admin'] }),
];

/**
 * `mode` decides what `deps.entries()` answers, which is the effective catalog of the mode: the local
 * rows, or — as `backend/connected-catalog.ts` does it — the snapshot's org half plus the personal
 * half the pending outbox rows rewrite (SP05 §2).
 */
function harness(mode: 'local' | 'connected'): Harness {
  const repo = createRepo(memorySqlite());
  repo.migrate();
  repo.ensureAdminRole();
  const person = repo.createPerson({
    email: 'p@example.test',
    name: 'P',
    password: { algorithm: 'PBKDF2-SHA256', hash: 'h', salt: 's', iterations: 1 },
    roles: ['admin'],
  });
  let on = mode === 'connected';
  let writes = 0;
  const personal = createPersonal({
    repo,
    entries: () => {
      if (!on) return repo.listEntries();
      const half = applyOutbox({ personalTools: [], personalViews: [], favorites: [] }, repo.listOutbox());
      return [...CONNECTED_BASE, ...half.personalTools];
    },
    personId: () => person.id,
    connected: () => on,
    now: () => Date.parse('2026-10-15T10:00:00.000Z'),
    removeCredentials: async () => undefined,
    onWrite: () => {
      writes += 1;
    },
  });
  return { repo, personal, person, queued: () => writes, connected: (value) => (on = value) };
}

describe('personal, local mode', () => {
  test('a personal tool is a row with its scope and its owner, and only the person sees it', () => {
    const h = harness('local');
    h.repo.saveEntry(entry('jitsi', { roles: ['admin'] }));
    const saved = h.personal.saveTool({ title: 'Notes', url: 'https://notes.example.test/app' });

    expect(saved.id).toMatch(PERSONAL_TOOL_ID);
    expect(saved.scope).toBe('personal');
    expect(saved.ownerId).toBe(h.person.id);
    const row = h.repo.entry(saved.id);
    expect(row?.scope).toBe('personal');
    expect(row?.ownerId).toBe(h.person.id);
    expect(h.repo.listOutbox()).toEqual([]);
    expect(h.queued()).toBe(1);

    // Another person's catalog never carries it (SP04 §2 says the rows are filtered by owner in SQL;
    // locally the tool is a row, so the filter is the owner column).
    const other: Person = { ...h.person, id: 'p2' };
    expect(h.personal.localCatalog(other).map((e) => e.id)).toEqual(['jitsi']);
  });

  test('the local catalog is favorites → org → personal, with the personal views hung under them', () => {
    const h = harness('local');
    h.repo.saveEntry(entry('jitsi', { roles: ['admin'], order: 1 }));
    h.repo.saveEntry(entry('figma', { roles: ['admin'], order: 2 }));
    const notes = h.personal.saveTool({ title: 'Notes', url: 'https://notes.example.test/app' });
    h.personal.setFavorites(['figma', notes.id]);
    h.personal.saveView({
      entryId: 'jitsi',
      label: 'Room',
      url: 'https://jitsi.example.test/room',
      mode: 'window',
    });

    const catalog = h.personal.localCatalog(h.person);
    expect(catalog.map((e) => e.id)).toEqual(['figma', notes.id, 'jitsi']);
    const jitsi = catalog.find((e) => e.id === 'jitsi');
    expect(jitsi?.views.map((v) => v.label)).toEqual(['Room']);
    expect(h.personal.localFavorites(h.person.id)).toEqual(['figma', notes.id]);
  });

  test('an edit keeps the id, the ownership and the views; a foreign id is refused', () => {
    const h = harness('local');
    const saved = h.personal.saveTool({ title: 'Notes', url: 'https://notes.example.test/app' });
    h.repo.saveEntry(entry('jitsi', { roles: ['admin'] }));
    const edited = h.personal.saveTool({ id: saved.id, title: 'Notes v2', url: saved.url });
    expect(edited.id).toBe(saved.id);
    expect(edited.title).toBe('Notes v2');
    expect(edited.scope).toBe('personal');
    expect(() => h.personal.saveTool({ id: 'jitsi', title: 'x', url: 'https://x.example.test/app' })).toThrow();
  });

  test('the favorites and the views of one person never reach another', () => {
    const h = harness('local');
    h.repo.saveEntry(entry('jitsi', { roles: ['admin'] }));
    h.personal.setFavorites(['jitsi']);
    h.personal.saveView({ entryId: 'jitsi', label: 'Room', url: 'https://jitsi.example.test/room', mode: 'window' });
    expect(h.personal.localFavorites('p2')).toEqual([]);
    expect(h.personal.localCatalog({ ...h.person, id: 'p2' })[0].views).toEqual([]);
  });

  test('removing a tool drops the row, and the credential hook runs first', async () => {
    const repo = createRepo(memorySqlite());
    repo.migrate();
    repo.ensureAdminRole();
    const person = repo.createPerson({
      email: 'p@example.test',
      name: 'P',
      password: { algorithm: 'PBKDF2-SHA256', hash: 'h', salt: 's', iterations: 1 },
      roles: ['admin'],
    });
    const order: string[] = [];
    const personal = createPersonal({
      repo,
      entries: () => repo.listEntries(),
      personId: () => person.id,
      connected: () => false,
      now: () => Date.parse('2026-10-15T10:00:00.000Z'),
      removeCredentials: async (toolId) => {
        order.push(`credentials:${toolId}`);
      },
      onWrite: () => undefined,
    });
    const saved = personal.saveTool({ title: 'Notes', url: 'https://notes.example.test/app' });
    await personal.removeTool(saved.id);
    expect(order).toEqual([`credentials:${saved.id}`]);
    expect(repo.entry(saved.id)).toBeNull();
    await expect(personal.removeTool(saved.id)).rejects.toThrow();
  });

  test('a view of another origin is refused, the rule a tool own view follows', () => {
    const h = harness('local');
    h.repo.saveEntry(entry('jitsi', { roles: ['admin'] }));
    expect(() =>
      h.personal.saveView({ entryId: 'jitsi', label: 'Elsewhere', url: 'https://other.example.test/x', mode: 'window' }),
    ).toThrow();
    expect(() =>
      h.personal.saveView({ entryId: 'unknown', label: 'Room', url: 'https://jitsi.example.test/room', mode: 'window' }),
    ).toThrow();
  });

  test('a saved view is removed by its id', async () => {
    const h = harness('local');
    h.repo.saveEntry(entry('jitsi', { roles: ['admin'] }));
    const saved = h.personal.saveView({
      entryId: 'jitsi',
      label: 'Room',
      url: 'https://jitsi.example.test/room',
      mode: 'window',
    });
    expect(saved.id).not.toBe('');
    await h.personal.removeView(saved.id);
    expect(h.personal.localCatalog(h.person)[0].views).toEqual([]);
    await expect(h.personal.removeView('v-unknown')).rejects.toThrow();
  });
});

describe('personal, connected mode', () => {
  test('a tool write is one outbox row for PUT /v1/personal/tools/:id and no local row', () => {
    const h = harness('connected');
    h.connected(true);
    const saved = h.personal.saveTool({ title: 'Notes', url: 'https://notes.example.test/app' });

    const rows = h.repo.listOutbox();
    expect(rows).toHaveLength(1);
    expect(rows[0].method).toBe('PUT');
    expect(rows[0].path).toBe(HOST_ROUTES.personalTool.replace(':id', saved.id));
    const body = JSON.parse(rows[0].body) as Record<string, unknown>;
    expect(body.id).toBe(saved.id);
    expect(body.title).toBe('Notes');
    expect(body.scope).toBe('personal');
    expect(body.updatedAt).toBe('2026-10-15T10:00:00.000Z');
    // The local tables are not the catalog while connected (SP05 §2).
    expect(h.repo.entry(saved.id)).toBeNull();
    expect(h.queued()).toBe(1);
  });

  test('the removal, the view and the favorites are one row each (SP04 §4)', async () => {
    const h = harness('connected');
    h.connected(true);
    const saved = h.personal.saveTool({ title: 'Notes', url: 'https://notes.example.test/app' });
    await h.personal.removeTool(saved.id);
    const room = h.personal.saveView({
      entryId: 'jitsi',
      label: 'Room',
      url: 'https://jitsi.example.test/room',
      mode: 'window',
    });
    await h.personal.setFavorites([saved.id, 'jitsi']);
    h.personal.setFavorites(['jitsi', 'jitsi', '']);

    const rows = h.repo.listOutbox();
    expect(rows.map((row) => `${row.method} ${row.path}`)).toEqual([
      `PUT ${HOST_ROUTES.personalTool.replace(':id', saved.id)}`,
      `DELETE ${HOST_ROUTES.personalTool.replace(':id', saved.id)}`,
      `PUT ${HOST_ROUTES.personalView.replace(':id', room.id)}`,
      `PUT ${HOST_ROUTES.favorites}`,
      `PUT ${HOST_ROUTES.favorites}`,
    ]);
    // The body is our own row: the two lists are what the host's `PUT /v1/favorites` replaces.
    const first = JSON.parse(rows[3].body) as { entries: Id[] };
    const second = JSON.parse(rows[4].body) as { entries: Id[] };
    expect(first.entries).toEqual([saved.id, 'jitsi']);
    // A repeat keeps its first place and an empty id is dropped.
    expect(second.entries).toEqual(['jitsi']);
  });

  test('an id that is not this person tool is refused before anything is queued', () => {
    const h = harness('connected');
    h.connected(true);
    expect(() => h.personal.saveTool({ id: 'jitsi', title: 'x', url: 'https://x.example.test/app' })).toThrow();
    expect(h.repo.listOutbox()).toEqual([]);
  });
});

describe('adoptSnapshot (host.remove)', () => {
  const body = JSON.stringify({
    api: 1,
    version: 'v1',
    issuedAt: '2026-10-15T10:00:00.000Z',
    me: { id: 'p1', email: 'p@example.test', name: 'P', roles: ['admin'], admin: true, kind: 'member' },
    roles: [],
    orgTools: [],
    personalTools: [entry('p-ffffffffff', { scope: 'personal', ownerId: 'p1', title: 'Notes' })],
    personalViews: [view('v1', 'p-ffffffffff')],
    favorites: ['p-ffffffffff'],
    guildIcon: null,
  });

  test('keeping the personal half makes it local data', () => {
    const h = harness('local');
    h.personal.adoptSnapshot(body, h.person.id, true);
    expect(h.repo.entry('p-ffffffffff')?.scope).toBe('personal');
    expect(h.personal.localFavorites(h.person.id)).toEqual(['p-ffffffffff']);
    expect(h.personal.localCatalog(h.person)[0].views.map((v) => v.id)).toEqual(['v1']);
  });

  test('dropping it leaves nothing behind, and a body that does not read changes nothing', () => {
    const h = harness('local');
    h.personal.adoptSnapshot(body, h.person.id, true);
    h.personal.adoptSnapshot(body, h.person.id, false);
    expect(h.repo.entry('p-ffffffffff')).toBeNull();
    expect(h.personal.localFavorites(h.person.id)).toEqual([]);
    h.personal.adoptSnapshot('not a snapshot', h.person.id, true);
    h.personal.adoptSnapshot(null, h.person.id, true);
    expect(h.repo.listEntries()).toEqual([]);
  });

  test('a personal tool still in the outbox is part of the half that is kept or dropped', () => {
    const pending = {
      method: 'PUT' as const,
      path: '/v1/personal/tools/p-qqqqqqqqqq',
      body: JSON.stringify(entry('p-qqqqqqqqqq', { scope: 'personal', ownerId: 'p1', title: 'Queued' })),
    };
    const kept = harness('connected');
    kept.personal.adoptSnapshot(body, kept.person.id, true, [pending]);
    expect(kept.repo.entry('p-qqqqqqqqqq')?.title).toBe('Queued');
    expect(kept.repo.entry('p-ffffffffff')?.scope).toBe('personal');

    const dropped = harness('connected');
    dropped.personal.adoptSnapshot(body, dropped.person.id, true, [pending]);
    dropped.personal.adoptSnapshot(body, dropped.person.id, false, [pending]);
    expect(dropped.repo.entry('p-qqqqqqqqqq')).toBeNull();
  });
});

describe('adoptLocalTool (RF-40, B8b)', () => {
  test('keeps a local tool as a personal one and turns its views into personal views', () => {
    const h = harness('connected');
    const local = entry('notes', {
      url: 'https://notes.example.test/app',
      scope: 'org',
      roles: ['admin'],
      views: [{ label: 'Inbox', url: 'https://notes.example.test/inbox', mode: 'navigate' }],
    });
    h.repo.saveEntry(local);
    const saved = h.personal.adoptLocalTool(local, 'data:image/png;base64,AAAA');
    expect(saved.id).toMatch(PERSONAL_TOOL_ID);
    expect(saved.scope).toBe('personal');
    expect(saved.ownerId).toBe(h.person.id);
    const tool = h.repo.listOutbox().filter((o) => o.path.startsWith('/v1/personal/tools/'));
    expect(tool).toHaveLength(1);
    const body = JSON.parse(tool[0].body) as Entry & { updatedAt: string };
    expect(body.title).toBe(local.title);
    expect(body.url).toBe(local.url);
    expect(body.icon).toBe('data:image/png;base64,AAAA');
    const views = h.repo.listOutbox().filter((o) => o.path.startsWith('/v1/personal/views/'));
    expect(views).toHaveLength(1);
    const view = JSON.parse(views[0].body) as { entryId: Id; label: string; url: string; mode: string };
    expect(view.entryId).toBe(saved.id);
    expect(view.label).toBe('Inbox');
    expect(view.url).toBe('https://notes.example.test/inbox');
  });

  test('re-keying the vault index moves the tool id and keeps the keychain pointer', () => {
    const h = harness('connected');
    const local = entry('notes', { url: 'https://notes.example.test/app', scope: 'org', roles: ['admin'] });
    h.repo.saveEntry(local);
    h.repo.saveVaultItem({
      personId: h.person.id,
      toolId: 'notes',
      label: 'notes',
      username: 'u',
      keychainKey: 'nod.cred.p.notes',
      origin: 'https://notes.example.test',
    });
    const saved = h.personal.adoptLocalTool(local, null);
    expect(h.repo.rekeyVaultTool('notes', saved.id)).toBe(1);
    expect(h.repo.vaultItem(h.person.id, saved.id)?.keychainKey).toBe('nod.cred.p.notes');
    expect(h.repo.vaultItem(h.person.id, 'notes')).toBeNull();
  });
});
