// Proves the visible behavior of `shared/catalog.ts` (slice acceptance).
// Run with `bun test test/`.

import { describe, expect, test } from 'bun:test';
import {
  auditUrl,
  categoryOf,
  catalogMode,
  exportSeed,
  groupByCategory,
  originOf,
  planSeed,
  slug,
  validateEntry,
  validateSeed,
  visibleEntries,
} from '../shared/catalog';
import type { Entry, InviteSeed, Role, Seed } from '../shared/types';

function entry(over: Partial<Entry> = {}): Entry {
  return {
    id: 'kanban',
    title: 'Kanban',
    url: 'https://kanban.example.com',
    icon: null,
    order: 10,
    roles: ['team'],
    views: [],
    auth: null,
    active: true,
    ...over,
  };
}

const ROLES: Role[] = [
  { id: 'admin', name: 'Admin', admin: true },
  { id: 'team', name: 'Team', admin: false },
];

function seedBase(over: Partial<Seed> = {}): Seed {
  return {
    version: 1,
    generatedAt: '2026-10-15T00:00:00.000Z',
    roles: ROLES,
    entries: [entry()],
    invites: [],
    update: null,
    ...over,
  };
}

const CODE_HASH = 'a'.repeat(64);
const OTHER_HASH = 'b'.repeat(64);
const INVITE: InviteSeed = { codeHash: CODE_HASH, roles: ['team'], expiresAt: '2026-10-22T00:00:00.000Z' };

describe('originOf', () => {
  test('returns the origin for https', () => {
    expect(originOf('https://kanban.example.com/boards/1?x=2#y')).toBe('https://kanban.example.com');
  });

  test('accepts http on loopback only', () => {
    expect(originOf('http://localhost:3000/dashboard')).toBe('http://localhost:3000');
    expect(originOf('http://app.localhost:8080/')).toBe('http://app.localhost:8080');
    expect(originOf('http://127.0.0.1:5173/index.html')).toBe('http://127.0.0.1:5173');
    expect(originOf('http://127.10.20.30:9000/x')).toBe('http://127.10.20.30:9000');
    expect(originOf('http://[::1]:8080/x')).toBe('http://[::1]:8080');
  });

  test('rejects http outside loopback', () => {
    expect(() => originOf('http://example.com')).toThrow('address must be https');
    expect(() => originOf('http://192.168.0.10:3000')).toThrow('address must be https');
  });

  test('rejects another scheme with the same message', () => {
    expect(() => originOf('ftp://localhost/file')).toThrow('address must be https');
  });

  test('rejects credentials in the address', () => {
    expect(() => originOf('https://user:pw@x.com')).toThrow('address must not contain credentials');
    expect(() => originOf('https://user@x.com/board')).toThrow('address must not contain credentials');
  });

  test('rejects hosts the WHATWG parser accepts', () => {
    expect(() => originOf('https://*.copland.studio')).toThrow('invalid address');
    expect(() => originOf('https://my_host.example.com')).toThrow('invalid address');
  });

  test('rejects garbage', () => {
    expect(() => originOf('junk')).toThrow('invalid address');
    expect(() => originOf('')).toThrow('invalid address');
    expect(() => originOf('kanban.example.com')).toThrow('invalid address');
  });
});

describe('auditUrl', () => {
  test('keeps origin and pathname, never query or fragment', () => {
    expect(auditUrl('https://x.com/a/b?code=1#t=2')).toBe('https://x.com/a/b');
  });

  test('accepts loopback http', () => {
    expect(auditUrl('http://localhost:3000/dashboard?x=1')).toBe('http://localhost:3000/dashboard');
  });

  test('returns null for what originOf refuses', () => {
    expect(auditUrl('http://example.com/a')).toBeNull();
    expect(auditUrl('junk')).toBeNull();
    expect(auditUrl('https://user:pw@x.com/a')).toBeNull();
    expect(auditUrl('https://*.copland.studio/a')).toBeNull();
  });
});

describe('slug', () => {
  test('turns a phrase into an id', () => {
    expect(slug('Kanban da Equipe!')).toBe('kanban-da-equipe');
  });

  test('drops accents', () => {
    expect(slug('Ação Já')).toBe('acao-ja');
  });

  test('collapses and trims separators', () => {
    expect(slug('--Sales  &  Marketing--')).toBe('sales-marketing');
  });

  test('cuts at 40 characters', () => {
    expect(slug('a'.repeat(60))).toBe('a'.repeat(40));
  });

  test('a title without alphanumerics becomes empty', () => {
    expect(slug('!!!')).toBe('');
  });
});

describe('validateEntry', () => {
  test('applies the defaults into a new object', () => {
    const raw = { id: 'kanban', title: 'Kanban', url: 'https://kanban.example.com' };
    const validated = validateEntry(raw);
    expect(validated).toEqual({
      id: 'kanban',
      title: 'Kanban',
      category: null,
      url: 'https://kanban.example.com',
      icon: null,
      order: 0,
      roles: [],
      views: [],
      auth: null,
      active: true,
    });
    expect(validated).not.toBe(raw);
    expect(raw).toEqual({ id: 'kanban', title: 'Kanban', url: 'https://kanban.example.com' });
  });

  test('copies the lists instead of sharing them', () => {
    const roles = ['team'];
    const views = [{ label: 'Sprint', url: 'https://kanban.example.com/boards/42', mode: 'window' as const }];
    const validated = validateEntry({
      id: 'kanban',
      title: 'Kanban',
      url: 'https://kanban.example.com',
      roles,
      views,
    });
    expect(validated.roles).toEqual(['team']);
    expect(validated.roles).not.toBe(roles);
    expect(validated.views).toEqual(views);
    expect(validated.views).not.toBe(views);
    expect(validated.views[0]).not.toBe(views[0]);
  });

  test('rejects an id with an uppercase letter', () => {
    expect(() => validateEntry({ id: 'Kanban', title: 'Kanban', url: 'https://k.example.com' })).toThrow('invalid id');
  });

  test('rejects an id longer than 40 characters', () => {
    expect(() =>
      validateEntry({ id: `a${'b'.repeat(40)}`, title: 'Kanban', url: 'https://k.example.com' }),
    ).toThrow('invalid id');
  });

  test('rejects a blank title', () => {
    expect(() => validateEntry({ id: 'kanban', title: '   ', url: 'https://k.example.com' })).toThrow(
      'title is required',
    );
  });

  test('rejects an address that is not https outside loopback', () => {
    expect(() => validateEntry({ id: 'kanban', title: 'Kanban', url: 'http://example.com' })).toThrow(
      'address must be https',
    );
  });

  test('rejects an address carrying credentials', () => {
    expect(() => validateEntry({ id: 'kanban', title: 'Kanban', url: 'https://user:pw@k.example.com' })).toThrow(
      'address must not contain credentials',
    );
  });

  test('accepts a view on the same origin and completes the mode', () => {
    const validated = validateEntry({
      id: 'kanban',
      title: 'Kanban',
      url: 'https://kanban.example.com',
      views: [{ label: 'Sprint', url: 'https://kanban.example.com/boards/42' }],
    });
    expect(validated.views).toEqual([{ label: 'Sprint', url: 'https://kanban.example.com/boards/42', mode: 'window' }]);
  });

  test('rejects a view on another origin', () => {
    expect(() =>
      validateEntry({
        id: 'kanban',
        title: 'Kanban',
        url: 'https://kanban.example.com',
        views: [{ label: 'Sprint', url: 'https://other.example.com/boards/42' }],
      }),
    ).toThrow('view outside the tool origin');
  });

  test('rejects a view whose address is invalid', () => {
    expect(() =>
      validateEntry({
        id: 'kanban',
        title: 'Kanban',
        url: 'https://kanban.example.com',
        views: [{ label: 'Sprint', url: 'https://*.copland.studio/boards/42' }],
      }),
    ).toThrow('invalid address');
  });

  test('rejects a view with an unknown mode', () => {
    expect(() =>
      validateEntry({
        id: 'kanban',
        title: 'Kanban',
        url: 'https://kanban.example.com',
        views: [{ label: 'Sprint', url: 'https://kanban.example.com/boards/42', mode: 'tab' }],
      }),
    ).toThrow('invalid view mode');
  });

  test('normalizes the auth override', () => {
    const validated = validateEntry({
      id: 'kanban',
      title: 'Kanban',
      url: 'https://k.example.com',
      auth: { noFill: true },
    });
    expect(validated.auth).toEqual({ noFill: true });
    expect(validateEntry({ id: 'kanban', title: 'Kanban', url: 'https://k.example.com', auth: {} }).auth).toEqual({});
  });

  test('rejects a noFill that is not a boolean', () => {
    expect(() =>
      validateEntry({ id: 'kanban', title: 'Kanban', url: 'https://k.example.com', auth: { noFill: 'yes' } }),
    ).toThrow('invalid noFill');
  });

  test('rejects fields of the wrong type', () => {
    expect(() =>
      validateEntry({ id: 'kanban', title: 'Kanban', url: 'https://k.example.com', order: '1' }),
    ).toThrow('invalid order');
    expect(() =>
      validateEntry({ id: 'kanban', title: 'Kanban', url: 'https://k.example.com', active: 'yes' }),
    ).toThrow('invalid active');
    expect(() =>
      validateEntry({ id: 'kanban', title: 'Kanban', url: 'https://k.example.com', roles: ['team', 7] }),
    ).toThrow('invalid roles');
  });

  test('rejects a non-object', () => {
    expect(() => validateEntry('kanban')).toThrow('invalid entry');
    expect(() => validateEntry(null)).toThrow('invalid entry');
    expect(() => validateEntry([])).toThrow('invalid entry');
  });

  // RF-62: the category the guild gives a tool.
  test('trims the category and reads an empty one as none', () => {
    const base = { id: 'kanban', title: 'Kanban', url: 'https://k.example.com' };
    expect(validateEntry({ ...base, category: '  Support  ' }).category).toBe('Support');
    expect(validateEntry({ ...base, category: '' }).category).toBeNull();
    expect(validateEntry({ ...base, category: '   ' }).category).toBeNull();
    expect(validateEntry({ ...base, category: null }).category).toBeNull();
    expect(validateEntry(base).category).toBeNull();
    // 40 characters are the limit, and they are counted after the trim.
    expect(validateEntry({ ...base, category: ` ${'c'.repeat(40)} ` }).category).toBe('c'.repeat(40));
  });

  test('rejects a category longer than 40 characters, a control character or another type', () => {
    const base = { id: 'kanban', title: 'Kanban', url: 'https://k.example.com' };
    expect(() => validateEntry({ ...base, category: 'c'.repeat(41) })).toThrow('invalid category');
    expect(() => validateEntry({ ...base, category: 'Sup\u0000port' })).toThrow('invalid category');
    expect(() => validateEntry({ ...base, category: 7 })).toThrow('invalid category');
    expect(() => validateEntry({ ...base, category: { name: 'Support' } })).toThrow('invalid category');
  });
});

describe('validateSeed', () => {
  test('rejects a key that looks like a secret inside an entry', () => {
    expect(() => validateSeed({ ...seedBase(), entries: [{ ...entry(), password: 'x' }] })).toThrow(
      'the seed must not contain secrets: password',
    );
    expect(() => validateSeed({ ...seedBase(), entries: [{ ...entry(), token: 'x' }] })).toThrow(
      'the seed must not contain secrets: token',
    );
  });

  test('rejects a nested key that looks like a secret', () => {
    expect(() =>
      validateSeed({
        ...seedBase(),
        invites: [{ ...INVITE, meta: { token: 'x' } }],
      }),
    ).toThrow('the seed must not contain secrets: token');
  });

  test('rejects a secret-looking key inside an array', () => {
    expect(() =>
      validateSeed({ ...seedBase(), roles: [{ id: 'team', name: 'Team', admin: false, secret: 'x' }] }),
    ).toThrow('the seed must not contain secrets: secret');
    expect(() =>
      validateSeed({ ...seedBase(), roles: [{ id: 'team', name: 'Team', admin: false, senha: 'x' }] }),
    ).toThrow('the seed must not contain secrets: senha');
  });

  test('rejects an unknown role cited by an entry', () => {
    expect(() => validateSeed({ ...seedBase(), entries: [entry({ roles: ['finance'] })] })).toThrow(
      'unknown role: finance',
    );
  });

  test('rejects an unknown role cited by an invite', () => {
    expect(() => validateSeed({ ...seedBase(), invites: [{ ...INVITE, roles: ['finance'] }] })).toThrow(
      'unknown role: finance',
    );
  });

  test('rejects a version that is not an integer >= 1', () => {
    expect(() => validateSeed({ ...seedBase(), version: 0 })).toThrow('invalid seed version');
    expect(() => validateSeed({ ...seedBase(), version: 1.5 })).toThrow('invalid seed version');
    expect(() => validateSeed({ ...seedBase(), version: '2' })).toThrow('invalid seed version');
  });

  test('rejects a missing generatedAt', () => {
    const seed = { version: 1, roles: ROLES, entries: [entry()], invites: [], update: null };
    expect(() => validateSeed(seed)).toThrow('invalid generatedAt');
  });

  test('rejects a repeated entry id', () => {
    expect(() => validateSeed({ ...seedBase(), entries: [entry(), entry()] })).toThrow('duplicate entry: kanban');
  });

  test('rejects a codeHash that is not 64 hex characters', () => {
    expect(() => validateSeed({ ...seedBase(), invites: [{ ...INVITE, codeHash: 'abc' }] })).toThrow(
      'invalid codeHash',
    );
    expect(() => validateSeed({ ...seedBase(), invites: [{ ...INVITE, codeHash: 'A'.repeat(64) }] })).toThrow(
      'invalid codeHash',
    );
  });

  test('rejects an update that is not https', () => {
    expect(() => validateSeed({ ...seedBase(), update: { url: 'http://example.com' } })).toThrow(
      'address must be https',
    );
    expect(() => validateSeed({ ...seedBase(), update: { url: 'https://*.copland.studio/app' } })).toThrow(
      'invalid address',
    );
  });

  test('fills the absent fields with the defaults', () => {
    const seed = validateSeed({
      version: 2,
      generatedAt: '2026-10-15T00:00:00.000Z',
      roles: ROLES,
      entries: [{ id: 'docs', title: 'Docs', url: 'https://docs.example.com', roles: ['team'] }],
    });
    expect(seed.invites).toEqual([]);
    expect(seed.update).toBeNull();
    expect(seed.entries[0].active).toBe(true);
    expect(seed.entries[0].icon).toBeNull();
    expect(seed.entries[0].auth).toBeNull();
    expect(seed.entries[0].views).toEqual([]);
  });

  test('carries the optional category of an entry (RF-62)', () => {
    const seed = validateSeed({
      ...seedBase(),
      entries: [
        { ...entry(), category: '  Support ' },
        { ...entry({ id: 'docs', title: 'Docs' }) },
      ],
    });
    expect(seed.entries[0].category).toBe('Support');
    expect(seed.entries[1].category).toBeNull();
  });

  test('accepts the content of resources/seed.example.json', async () => {
    const sample: unknown = await Bun.file('resources/seed.example.json').json();
    const seed = validateSeed(sample);
    expect(seed.version).toBe(1);
    expect(seed.roles.map((role) => role.id)).toEqual(['admin', 'team']);
    expect(seed.entries.map((e) => e.id)).toEqual(['kanban', 'docs']);
    expect(seed.entries[0].views).toEqual([
      { label: 'Sprint', url: 'https://kanban.example.com/boards/1', mode: 'window' },
    ]);
    expect(seed.invites).toEqual([]);
    expect(seed.update).toBeNull();
  });
});

describe('visibleEntries', () => {
  const all: Entry[] = [
    entry({ id: 'docs', title: 'Docs', order: 20 }),
    entry({ id: 'kanban', title: 'Kanban', order: 10 }),
    entry({ id: 'finance', title: 'Finance', order: 5, roles: ['finance'] }),
    entry({ id: 'old', title: 'Old', order: 1, active: false }),
  ];

  test('admin sees every active entry, never an inactive one', () => {
    expect(visibleEntries(all, { roles: [], admin: true }).map((e) => e.id)).toEqual(['finance', 'kanban', 'docs']);
  });

  test('a person without a role in common does not see the entry', () => {
    expect(visibleEntries(all, { roles: ['team'], admin: false }).map((e) => e.id)).toEqual(['kanban', 'docs']);
  });

  test('a person with no role sees nothing', () => {
    expect(visibleEntries(all, { roles: [], admin: false })).toEqual([]);
  });

  test('orders by order and breaks ties by title', () => {
    const sorted = visibleEntries(
      [
        entry({ id: 'b', title: 'Beta', order: 1 }),
        entry({ id: 'a', title: 'Alpha', order: 1 }),
        entry({ id: 'c', title: 'Gamma', order: 0 }),
      ],
      { roles: ['team'], admin: false },
    );
    expect(sorted.map((e) => e.id)).toEqual(['c', 'a', 'b']);
  });

  test('leaves the received array alone', () => {
    const copy = [...all];
    visibleEntries(all, { roles: ['team'], admin: false });
    expect(all).toEqual(copy);
  });
});

describe('groupByCategory (RF-62)', () => {
  test('reads an absent, empty or whitespace name as no category', () => {
    expect(categoryOf(entry())).toBeNull();
    expect(categoryOf(entry({ category: null }))).toBeNull();
    expect(categoryOf(entry({ category: '' }))).toBeNull();
    expect(categoryOf(entry({ category: '   ' }))).toBeNull();
    expect(categoryOf(entry({ category: '  Support ' }))).toBe('Support');
  });

  test('a catalog with no category at all is one uncategorized group, unchanged', () => {
    const entries = [entry({ id: 'kanban', order: 10 }), entry({ id: 'docs', order: 20 })];
    const groups = groupByCategory(entries);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.category).toBeNull();
    expect(groups[0]?.entries.map((e) => e.id)).toEqual(['kanban', 'docs']);
  });

  test('groups by the smallest order of their tools, and the uncategorized group comes last', () => {
    const groups = groupByCategory([
      entry({ id: 'a', order: 1, category: 'Support' }),
      entry({ id: 'b', order: 2, category: 'Engineering' }),
      entry({ id: 'c', order: 3, category: 'Support' }),
      entry({ id: 'd', order: 4 }),
    ]);
    expect(groups.map((group) => group.category)).toEqual(['Support', 'Engineering', null]);
    expect(groups[0]?.entries.map((e) => e.id)).toEqual(['a', 'c']);
    expect(groups[1]?.entries.map((e) => e.id)).toEqual(['b']);
    expect(groups[2]?.entries.map((e) => e.id)).toEqual(['d']);
  });

  test('a tie on the smallest order is decided by the category name', () => {
    const groups = groupByCategory([
      entry({ id: 'b', order: 1, category: 'Beta' }),
      entry({ id: 'a', order: 1, category: 'Alpha' }),
      entry({ id: 'z', order: 1, category: 'Zeta' }),
    ]);
    expect(groups.map((group) => group.category)).toEqual(['Alpha', 'Beta', 'Zeta']);
  });

  test('the tools inside a group keep the order they arrived in', () => {
    const groups = groupByCategory([
      entry({ id: 'first', order: 1, category: 'Support' }),
      entry({ id: 'second', order: 5, category: 'Support' }),
      entry({ id: 'third', order: 2, category: 'Support' }),
    ]);
    expect(groups[0]?.entries.map((e) => e.id)).toEqual(['first', 'second', 'third']);
  });

  test('an empty list answers no group', () => {
    expect(groupByCategory([])).toEqual([]);
  });

  test('a group of tools only would still read last, whatever their order', () => {
    const groups = groupByCategory([
      entry({ id: 'unfiled', order: 1 }),
      entry({ id: 'filed', order: 9, category: 'Support' }),
    ]);
    expect(groups.map((group) => group.category)).toEqual(['Support', null]);
  });
});

describe('planSeed', () => {
  test('boot with the same version applies nothing', () => {
    expect(planSeed({ entries: ['kanban'], roles: ['team'], invites: [CODE_HASH], seedVersion: 1 }, seedBase(), 'boot')).toBeNull();
  });

  test('boot with an older version applies nothing', () => {
    expect(
      planSeed({ entries: ['kanban'], roles: ['team'], invites: [], seedVersion: 3 }, seedBase({ version: 2 }), 'boot'),
    ).toBeNull();
  });

  test('boot with no stamped version inserts everything and stamps the version', () => {
    const plan = planSeed({ entries: [], roles: [], invites: [], seedVersion: null }, seedBase({ version: 4 }), 'boot');
    expect(plan?.seedVersion).toBe(4);
    expect(plan?.insertEntries.map((e) => e.id)).toEqual(['kanban']);
    expect(plan?.insertRoles.map((r) => r.id)).toEqual(['admin', 'team']);
  });

  test('boot with a newer version inserts only what is missing and never updates', () => {
    const seed = seedBase({
      version: 2,
      entries: [entry({ title: 'Kanban edited' }), entry({ id: 'docs', title: 'Docs' })],
      invites: [INVITE, { ...INVITE, codeHash: OTHER_HASH }],
    });
    const plan = planSeed(
      { entries: ['kanban'], roles: ['team'], invites: [CODE_HASH], seedVersion: 1 },
      seed,
      'boot',
    );
    expect(plan?.seedVersion).toBe(2);
    expect(plan?.insertEntries.map((e) => e.id)).toEqual(['docs']);
    expect(plan?.updateEntries).toEqual([]);
    expect(plan?.insertRoles.map((r) => r.id)).toEqual(['admin']);
    expect(plan?.updateRoles).toEqual([]);
    expect(plan?.insertInvites.map((i) => i.codeHash)).toEqual([OTHER_HASH]);
  });

  test('merge applies even with an older version and never updates', () => {
    const seed = seedBase({
      version: 2,
      entries: [entry({ title: 'Kanban edited' }), entry({ id: 'docs', title: 'Docs' })],
    });
    const plan = planSeed(
      { entries: ['kanban'], roles: ['admin', 'team'], invites: [], seedVersion: 3 },
      seed,
      'merge',
    );
    expect(plan?.seedVersion).toBe(3);
    expect(plan?.insertEntries.map((e) => e.id)).toEqual(['docs']);
    expect(plan?.updateEntries).toEqual([]);
    expect(plan?.insertRoles).toEqual([]);
    expect(plan?.updateRoles).toEqual([]);
  });

  test('merge raises the stamped version to the seed version', () => {
    const plan = planSeed(
      { entries: [], roles: [], invites: [], seedVersion: 1 },
      seedBase({ version: 7 }),
      'merge',
    );
    expect(plan?.seedVersion).toBe(7);
  });

  test('overwrite inserts the new entries and roles and hands back the existing ones', () => {
    const seed = seedBase({
      version: 5,
      entries: [entry({ title: 'Kanban edited' }), entry({ id: 'docs', title: 'Docs' })],
      roles: [ROLES[0], ROLES[1], { id: 'finance', name: 'Finance', admin: false }],
    });
    const plan = planSeed(
      { entries: ['kanban'], roles: ['admin', 'team'], invites: [], seedVersion: 2 },
      seed,
      'overwrite',
    );
    expect(plan?.insertEntries.map((e) => e.id)).toEqual(['docs']);
    expect(plan?.updateEntries.map((e) => e.id)).toEqual(['kanban']);
    expect(plan?.updateEntries.map((e) => e.title)).toEqual(['Kanban edited']);
    expect(plan?.insertRoles.map((r) => r.id)).toEqual(['finance']);
    expect(plan?.updateRoles.map((r) => r.id)).toEqual(['admin', 'team']);
    expect(plan?.seedVersion).toBe(5);
  });

  test('overwrite keeps the highest version already stamped', () => {
    const plan = planSeed(
      { entries: [], roles: [], invites: [], seedVersion: 9 },
      seedBase({ version: 4 }),
      'overwrite',
    );
    expect(plan?.seedVersion).toBe(9);
  });

  test('inserts only the invite hashes that are missing', () => {
    const seed = seedBase({ version: 2, invites: [INVITE, { ...INVITE, codeHash: OTHER_HASH }] });
    const plan = planSeed({ entries: [], roles: [], invites: [CODE_HASH], seedVersion: 1 }, seed, 'merge');
    expect(plan?.insertInvites.map((i) => i.codeHash)).toEqual([OTHER_HASH]);
  });
});

describe('exportSeed', () => {
  test('builds a seed that passes validateSeed', () => {
    const seed = exportSeed(
      {
        entries: [entry({ icon: 'icons/kanban.png' })],
        roles: ROLES,
        invites: [INVITE],
        update: { url: 'https://updates.example.com/manifest.json' },
        version: 4,
      },
      new Date('2026-10-15T12:30:00.000Z'),
    );
    expect(seed.generatedAt).toBe('2026-10-15T12:30:00.000Z');
    expect(seed.version).toBe(4);
    expect(seed.entries[0].icon).toBeNull();
    expect(seed.update).toEqual({ url: 'https://updates.example.com/manifest.json' });
    expect(validateSeed(seed)).toEqual(seed);
  });

  test('carries the category of an entry out and back (RF-62)', () => {
    const seed = exportSeed(
      { entries: [entry({ category: ' Support ' }), entry({ id: 'docs', title: 'Docs' })], roles: ROLES, invites: [], update: null, version: 2 },
      new Date(0),
    );
    expect(seed.entries.map((e) => e.category)).toEqual(['Support', null]);
    expect(validateSeed(seed).entries.map((e) => e.category)).toEqual(['Support', null]);
  });

  test('does not mutate the received entries', () => {
    const original = entry({ icon: 'icons/kanban.png' });
    exportSeed(
      { entries: [original], roles: ROLES, invites: [], update: null, version: 1 },
      new Date(0),
    );
    expect(original.icon).toBe('icons/kanban.png');
  });

  test('a null update travels as null', () => {
    const seed = exportSeed({ entries: [entry()], roles: ROLES, invites: [], update: null, version: 1 }, new Date(0));
    expect(seed.update).toBeNull();
    expect(seed.invites).toEqual([]);
  });
});

/**
 * O2/SP04 §1, owner decision of 2026-10-17: a Nod older than the guild's `minAppVersion` serves the
 * local catalog. The two halves below are the catalogs the switch chooses between — the `tool` table's
 * rows and what the verified snapshot answers — and `served` is what `backend/main.ts` does with the
 * verdict (`visibleEntriesOf`). The smoke (`test/smoke/ui-driver.ts` #28) proves the wiring.
 */
describe('the catalog a Nod older than its guild serves (O2)', () => {
  const local = [entry({ id: 'local-a', title: 'Local A', roles: [] })];
  const connected = [entry({ id: 'guild-only', title: 'Guild Only', scope: 'org', ownerId: null })];

  function served(hasHostRow: boolean, updateRequired: boolean): Entry[] {
    return catalogMode(hasHostRow, updateRequired) === 'connected' ? connected : local;
  }

  test('at or above the minimum the snapshot is the catalog', () => {
    expect(catalogMode(true, false)).toBe('connected');
    expect(served(true, false)).toBe(connected);
    expect(served(true, false)[0]?.id).toBe('guild-only');
  });

  test('below it the local tables are, while the `host` row stays', () => {
    expect(catalogMode(true, true)).toBe('local');
    expect(served(true, true)).toBe(local);
    expect(served(true, true)[0]?.id).toBe('local-a');
  });

  test('a Nod that never connected serves the local catalog either way', () => {
    expect(catalogMode(false, false)).toBe('local');
    expect(catalogMode(false, true)).toBe('local');
    expect(served(false, true)).toBe(local);
  });

  test('the hosts minimum moving is the only input besides the row', () => {
    // The same row, the same app: the host lowering its minimum (or the app being updated) is the
    // whole of what restores the connected catalog — and the run re-reads it every time.
    expect(catalogMode(true, true)).toBe('local');
    expect(catalogMode(true, false)).toBe('connected');
  });
});
