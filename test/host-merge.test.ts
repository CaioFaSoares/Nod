// `shared/host-merge.ts` against the documents of SP04 §2, the outbox verdicts of SP04 §4, the
// sidebar order of SP05 §4 and the cached-org window of `docs/canonico.md` §22 ("Stale cache").
import { describe, expect, test } from 'bun:test';
import {
  clearOrgData,
  ORG_CACHE_DAYS,
  ORG_CACHE_MS,
  orgToolsUsable,
  outboxVerdict,
  parseSnapshot,
  sidebarOrder,
  SnapshotShapeError,
} from '../shared/host-merge';
import type { Snapshot } from '../shared/host-api';
import type { Entry } from '../shared/types';

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

/** A whole snapshot as SP04 §2 defines it: one org tool granted to `team`, one personal tool. */
function snapshot(fields: Partial<Snapshot> = {}): Snapshot {
  return {
    api: 1,
    version: 'v1',
    issuedAt: '2026-10-15T10:00:00.000Z',
    me: { id: 'p1', email: 'p@example.test', name: 'P', roles: ['team'], admin: false, kind: 'member' },
    roles: [{ id: 'team', name: 'Team', admin: false }],
    orgTools: [entry('jitsi', { roles: ['team'], scope: 'org', ownerId: null })],
    personalTools: [entry('mine', { scope: 'personal', ownerId: 'p1' })],
    personalViews: [
      {
        id: 'v-1',
        entryId: 'mine',
        label: 'Inbox',
        url: 'https://mine.example.test/inbox',
        mode: 'navigate',
        scope: 'personal',
        ownerId: 'p1',
        updatedAt: '2026-10-15T09:00:00.000Z',
      },
    ],
    favorites: ['jitsi'],
    guildIcon: null,
    ...fields,
  };
}

describe('parseSnapshot', () => {
  test('reads the org half, the personal half and the favorites', () => {
    const rows = parseSnapshot(snapshot());
    expect(rows.me).toEqual({ id: 'p1', email: 'p@example.test', name: 'P', roles: ['team'], admin: false, kind: 'member' });
    expect(rows.roles).toEqual([{ id: 'team', name: 'Team', admin: false }]);
    expect(rows.orgTools.map((tool) => tool.id)).toEqual(['jitsi']);
    expect(rows.personalTools.map((tool) => tool.id)).toEqual(['mine']);
    expect(rows.personalViews.map((view) => view.id)).toEqual(['v-1']);
    expect(rows.favorites).toEqual(['jitsi']);
  });

  test('keeps what the host sent beside the spine: scope, owner and the view ids', () => {
    const rows = parseSnapshot(snapshot());
    expect(rows.orgTools[0]?.scope).toBe('org');
    expect(rows.orgTools[0]?.ownerId).toBeNull();
    expect(rows.orgTools[0]?.roles).toEqual(['team']);
    expect(rows.personalTools[0]?.scope).toBe('personal');
    expect(rows.personalTools[0]?.ownerId).toBe('p1');
    expect(rows.personalViews[0]?.entryId).toBe('mine');
    expect(rows.personalViews[0]?.updatedAt).toBe('2026-10-15T09:00:00.000Z');
  });

  test('refuses a body that is not the document of SP04 §2', () => {
    expect(() => parseSnapshot(null)).toThrow(SnapshotShapeError);
    expect(() => parseSnapshot('a snapshot')).toThrow(SnapshotShapeError);
    expect(() => parseSnapshot({})).toThrow(SnapshotShapeError);
    expect(() => parseSnapshot({ ...snapshot(), api: 2 })).toThrow(SnapshotShapeError);
    expect(() => parseSnapshot({ ...snapshot(), version: '' })).toThrow(SnapshotShapeError);
    expect(() => parseSnapshot({ ...snapshot(), orgTools: 'jitsi' })).toThrow(SnapshotShapeError);
    expect(() => parseSnapshot({ ...snapshot(), personalViews: [{}] })).toThrow(SnapshotShapeError);
    expect(() => parseSnapshot({ ...snapshot(), me: { id: 'p1' } })).toThrow(SnapshotShapeError);
    expect(() => parseSnapshot({ ...snapshot(), favorites: [7] })).toThrow(SnapshotShapeError);
  });
});

describe('clearOrgData', () => {
  test('drops the org half and keeps the personal half, the caller and the favorites', () => {
    const cleared = clearOrgData(JSON.stringify(snapshot()));
    expect(cleared).not.toBeNull();
    const rows = parseSnapshot(JSON.parse(cleared as string));
    expect(rows.orgTools).toEqual([]);
    expect(rows.roles).toEqual([]);
    expect(rows.me).toEqual({ id: 'p1', email: 'p@example.test', name: 'P', roles: ['team'], admin: false, kind: 'member' });
    expect(rows.personalTools.map((tool) => tool.id)).toEqual(['mine']);
    expect(rows.personalViews.map((view) => view.id)).toEqual(['v-1']);
    expect(rows.favorites).toEqual(['jitsi']);
  });

  test('answers null for a body that is not a snapshot, so nothing is rewritten', () => {
    expect(clearOrgData('not json')).toBeNull();
    expect(clearOrgData(JSON.stringify({ api: 2 }))).toBeNull();
    expect(clearOrgData(JSON.stringify({ ...snapshot(), orgTools: [{}] }))).toBeNull();
  });
});

describe('sidebarOrder', () => {
  const orgTools = [entry('beta', { order: 2 }), entry('alpha', { order: 1 })];
  const personalTools = [entry('zeta', { order: 1 }), entry('mine', { scope: 'personal', ownerId: 'p1' })];

  test('favorites first in their own order, then the org tools, then the personal ones', () => {
    const ordered = sidebarOrder({ orgTools, personalTools, favorites: ['mine', 'beta'] });
    expect(ordered.map((tool) => tool.id)).toEqual(['mine', 'beta', 'alpha', 'zeta']);
  });

  test('skips a favorite that resolves to nothing', () => {
    const ordered = sidebarOrder({ orgTools, personalTools, favorites: ['jitsi', 'zeta'] });
    expect(ordered.map((tool) => tool.id)).toEqual(['zeta', 'alpha', 'beta', 'mine']);
  });

  test('lists a favorite once, and inside a group by order and then title', () => {
    const same = [entry('b', { order: 1, title: 'Tool b' }), entry('a', { order: 1, title: 'Tool a' })];
    const ordered = sidebarOrder({ orgTools: same, personalTools: [], favorites: ['b', 'b'] });
    expect(ordered.map((tool) => tool.id)).toEqual(['b', 'a']);
  });
});

describe('orgToolsUsable', () => {
  const lastSyncAt = '2026-10-01T00:00:00.000Z';
  const at = Date.parse(lastSyncAt);

  test('the window is fourteen days', () => {
    expect(ORG_CACHE_DAYS).toBe(14);
    expect(ORG_CACHE_MS).toBe(14 * 24 * 60 * 60 * 1000);
  });

  test('stays usable up to the day the window completes', () => {
    expect(orgToolsUsable(lastSyncAt, at)).toBe(true);
    expect(orgToolsUsable(lastSyncAt, at + 13 * 24 * 60 * 60 * 1000 + 23 * 60 * 60 * 1000)).toBe(true);
    expect(orgToolsUsable(lastSyncAt, at + ORG_CACHE_MS - 1)).toBe(true);
  });

  test('hides the org half once the window is over', () => {
    expect(orgToolsUsable(lastSyncAt, at + ORG_CACHE_MS)).toBe(false);
    expect(orgToolsUsable(lastSyncAt, at + ORG_CACHE_MS + 1000)).toBe(false);
  });

  test('fails closed with no last sync and with a date it cannot read', () => {
    expect(orgToolsUsable(null, at)).toBe(false);
    expect(orgToolsUsable('yesterday', at)).toBe(false);
    expect(orgToolsUsable('', at)).toBe(false);
  });
});

describe('outboxVerdict', () => {
  test('a 409 is the host version winning and a 403 is a refusal', () => {
    expect(outboxVerdict(409)).toBe('drop');
    expect(outboxVerdict(403)).toBe('rejected');
    expect(outboxVerdict(404)).toBe('rejected');
    expect(outboxVerdict(422)).toBe('rejected');
  });

  test('a 5xx, the host not reached, or a session that ended is a retry', () => {
    expect(outboxVerdict(null)).toBe('retry');
    expect(outboxVerdict(500)).toBe('retry');
    expect(outboxVerdict(503)).toBe('retry');
    expect(outboxVerdict(401)).toBe('retry');
    expect(outboxVerdict(429)).toBe('retry');
  });
});
