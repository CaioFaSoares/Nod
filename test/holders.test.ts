// M7 of SP06 §4, RF-54 (finding M7 of `docs/handovers/block2-review.md`) — the admin's holders
// list, over `backend/holders.ts`. The builder is pure, so this file hands it the two snapshot
// fields and the two lookups and asserts the rows the Settings card draws: one per credential, the
// roster's names, owner first and revoked last, and the fallback for a credential this Nod cannot
// name a tool for.
import { describe, expect, test } from 'bun:test';

import { buildCredentialHolders } from '../backend/holders';
import type { Holder } from '../shared/host-api';

const AT = '2026-10-16T12:00:00.000Z';

function holder(over: Partial<Holder> & { personId: string; name: string }): Holder {
  return {
    owner: false,
    scope: 'role',
    since: AT,
    removedAt: null,
    toolId: 'figma',
    ...over,
  };
}

const SOURCE = (over: Partial<Parameters<typeof buildCredentialHolders>[0]> = {}) => ({
  holders: null,
  people: null,
  toolOf: (): string | null => null,
  titleOf: (): string | null => null,
  ...over,
});

describe('the admin holders list (M7, RF-54)', () => {
  test('one row per credential, named by the roster and titled by the catalog', () => {
    const rows = buildCredentialHolders(
      SOURCE({
        holders: {
          c1: [
            holder({ personId: 'alice', name: 'Alice', owner: true }),
            holder({ personId: 'bob', name: 'Bob' }),
          ],
          c2: [holder({ personId: 'carol', name: 'Carol', owner: true, toolId: 'kanban' })],
        },
        people: [
          { id: 'alice', name: 'Alice A.' },
          { id: 'bob', name: 'Bob B.' },
          { id: 'carol', name: 'Carol C.' },
        ],
        toolOf: (credentialId) => (credentialId === 'c1' ? 'figma' : 'kanban'),
        titleOf: (toolId) => (toolId === 'figma' ? 'Figma' : toolId === 'kanban' ? 'Kanban' : null),
      }),
    );

    expect(rows).toHaveLength(2);
    // Sorted by title, so the card reads as a catalog list.
    expect(rows.map((row) => row.toolTitle)).toEqual(['Figma', 'Kanban']);
    expect(rows[0]).toMatchObject({ credentialId: 'c1', toolId: 'figma' });
    expect(rows[0].holders.map((person) => person.name)).toEqual(['Alice A.', 'Bob B.']);
    expect(rows[1].holders.map((person) => person.name)).toEqual(['Carol C.']);
  });

  test('a holder the roster does not carry keeps the name the host sent', () => {
    const rows = buildCredentialHolders(
      SOURCE({
        holders: { c1: [holder({ personId: 'alice', name: 'Alice', owner: true })] },
        people: [{ id: 'someone-else', name: 'Other' }],
        toolOf: () => 'figma',
        titleOf: () => 'Figma',
      }),
    );
    expect(rows[0].holders[0].name).toBe('Alice');
  });

  test('the owner comes first, the revoked holder last, each with its date and scope', () => {
    const rows = buildCredentialHolders(
      SOURCE({
        holders: {
          c1: [
            holder({ personId: 'bob', name: 'Bob', since: '2026-10-15T00:00:00.000Z' }),
            holder({ personId: 'dan', name: 'Dan', removedAt: '2026-10-16T00:00:00.000Z' }),
            holder({ personId: 'alice', name: 'Alice', owner: true, since: AT }),
          ],
        },
        toolOf: () => 'figma',
        titleOf: () => 'Figma',
      }),
    );

    const holders = rows[0].holders;
    expect(holders.map((person) => person.name)).toEqual(['Alice', 'Bob', 'Dan']);
    expect(holders[1]).toMatchObject({ owner: false, scope: 'role', since: '2026-10-15T00:00:00.000Z' });
    expect(holders[2].removedAt).toBe('2026-10-16T00:00:00.000Z');
  });

  test('a credential this Nod cannot name a tool for still lists its holders, under its own id', () => {
    // A row cached before the host sent `toolId`: the local lookup is the fallback.
    const legacy = {
      personId: 'alice',
      name: 'Alice',
      owner: true,
      scope: 'role',
      since: AT,
      removedAt: null,
    } as unknown as Holder;
    const rows = buildCredentialHolders(
      SOURCE({
        holders: { '7f0c-credential': [legacy] },
      }),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      credentialId: '7f0c-credential',
      toolId: '7f0c-credential',
      toolTitle: null,
      holders: [
        holder({ personId: 'alice', name: 'Alice', owner: true, toolId: '7f0c-credential' }),
      ],
    });
  });

  test('a tool the catalog does not carry answers a row with no title', () => {
    const rows = buildCredentialHolders(
      SOURCE({
        holders: {
          c1: [holder({ personId: 'alice', name: 'Alice', owner: true, toolId: 'removed-tool' })],
        },
        toolOf: () => 'removed-tool',
        titleOf: () => null,
      }),
    );
    expect(rows[0]).toMatchObject({ toolId: 'removed-tool', toolTitle: null });
  });

  test('no snapshot, no holders and empty rows answer the empty list', () => {
    expect(buildCredentialHolders(SOURCE())).toEqual([]);
    expect(buildCredentialHolders(SOURCE({ holders: {} }))).toEqual([]);
    expect(buildCredentialHolders(SOURCE({ holders: { c1: [] } }))).toEqual([]);
  });

  test('a row that is not a holder is dropped; a credential left with none is dropped whole', () => {
    const rows = buildCredentialHolders(
      SOURCE({
        holders: {
          good: [holder({ personId: 'alice', name: 'Alice', owner: true })],
          // A newer host could still add fields; a value that is not a row must not reach the page.
          broken: [{ personId: 'bob' }, { personId: 'carol', name: 'Carol', owner: 'yes' }, null],
        } as unknown as Record<string, Holder[]>,
        toolOf: (credentialId) => (credentialId === 'good' ? 'figma' : 'kanban'),
        titleOf: (toolId) => (toolId === 'figma' ? 'Figma' : 'Kanban'),
      }),
    );
    expect(rows.map((row) => row.credentialId)).toEqual(['good']);
  });

  test('two credentials of one tool are told apart by their ids', () => {
    const rows = buildCredentialHolders(
      SOURCE({
        holders: {
          aaa: [holder({ personId: 'alice', name: 'Alice', owner: true })],
          bbb: [holder({ personId: 'bob', name: 'Bob', owner: true })],
        },
        toolOf: () => 'figma',
        titleOf: () => 'Figma',
      }),
    );
    expect(rows.map((row) => row.credentialId)).toEqual(['aaa', 'bbb']);
  });
});
