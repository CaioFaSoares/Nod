// Proves the library's models (RF-79, `shared/library.ts`): what the search reads, the cards'
// order, the groups, the org chart's nodes and the isometric stacks' ground. The two surfaces'
// DOM is not this module's business — the models they both feed on are.
// Run with `bun test test/`.

import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_LIBRARY_VIEW,
  blockStacks,
  hostOf,
  libraryCards,
  libraryGroups,
  librarySearch,
  libraryViewOf,
  orgChart,
  rosterOf,
  type LibraryInput,
} from '../shared/library';
import type { Entry, Role } from '../shared/types';

function tool(id: string, overrides: Partial<Entry> = {}): Entry {
  return {
    id,
    title: id.replace(/(^|-)([a-z])/g, (_, dash: string, letter: string) => (dash === '' ? letter.toUpperCase() : ` ${letter.toUpperCase()}`)),
    category: null,
    url: `https://${id}.example.test/app`,
    icon: null,
    order: 0,
    roles: [],
    views: [],
    auth: null,
    active: true,
    ...overrides,
  };
}

const JITSI = tool('jitsi', {
  title: 'Jitsi Meet',
  category: 'Calls',
  tags: ['video', 'meetings'],
  orgAccount: 'team@guild.example',
  roles: ['team'],
  order: 20,
});
const KANBAN = tool('kanban', { title: 'Kanban', category: 'Boards', roles: ['team'], order: 10 });
const WIKI = tool('wiki', { title: 'Wiki', roles: [], order: 30 });
const MINE = tool('p-mine', { title: 'Mine', scope: 'personal', order: 5 });

const ROLES: Role[] = [
  { id: 'admin', name: 'Admin', admin: true },
  { id: 'team', name: 'Team', admin: false },
];

const INPUT: LibraryInput = {
  orgTools: [JITSI, KANBAN, WIKI],
  personalTools: [MINE],
  favorites: ['jitsi'],
  roles: ROLES,
  people: [
    { id: 'p-ada', name: 'Ada', roles: ['admin'], admin: true },
    { id: 'p-bob', name: 'Bob', roles: ['team'], admin: false },
    { id: 'p-eva', name: 'Eva', roles: [], admin: false },
  ],
};

describe('the library (RF-79)', () => {
  test('the view a machine never chose is cards, and an unread choice reads as the default', () => {
    expect(DEFAULT_LIBRARY_VIEW).toBe('cards');
    expect(libraryViewOf(null)).toBe('cards');
    expect(libraryViewOf('bogus')).toBe('cards');
    expect(libraryViewOf('blocks')).toBe('blocks');
  });

  test('the host of an address, for the search and the card', () => {
    expect(hostOf('https://kanban.example.test/boards/42')).toBe('kanban.example.test');
    expect(hostOf('not a url')).toBe('not a url');
  });

  test('the search reads the title, the category, the tags, the org account and the host', () => {
    expect(librarySearch(JITSI, 'jitsi')).toBe(true);
    expect(librarySearch(JITSI, 'CALLS')).toBe(true);
    expect(librarySearch(JITSI, ' video ')).toBe(true);
    expect(librarySearch(JITSI, 'team@guild')).toBe(true);
    expect(librarySearch(KANBAN, 'kanban.example')).toBe(true);
    expect(librarySearch(JITSI, 'nowhere')).toBe(false);
    // An empty box matches everything.
    expect(librarySearch(WIKI, '   ')).toBe(true);
  });

  test('the cards read favorites first, then the org tools in catalog order, then the personal ones', () => {
    const ids = libraryCards(INPUT, '').map((card) => card.entry.id);
    expect(ids).toEqual(['jitsi', 'kanban', 'wiki', 'p-mine']);
    // A card carries the library's own fields, read once.
    const jitsi = libraryCards(INPUT, '')[0];
    expect(jitsi).toMatchObject({ favorite: true, tags: ['video', 'meetings'], orgAccount: 'team@guild.example' });
    expect(libraryCards(INPUT, '')[1]).toMatchObject({ favorite: false, tags: [], orgAccount: null });
  });

  test('a query filters every view the same way', () => {
    expect(libraryCards(INPUT, 'wiki').map((card) => card.entry.id)).toEqual(['wiki']);
    expect(libraryGroups(INPUT, 'wiki')).toHaveLength(1);
    expect(blockStacks(INPUT, 'wiki')).toHaveLength(1);
    // The chart follows: `team` reaches nothing (the wiki is granted to nobody), and the admin
    // still carries the one category the match is filed nowhere under.
    const chart = orgChart(INPUT, 'wiki');
    expect(chart.find((node) => node.role?.id === 'team')?.categories).toEqual([]);
    expect(chart.find((node) => node.role?.id === 'admin')?.categories).toEqual(['']);
  });

  test('the groups carry the category, and a favorite org tool stays inside its own group', () => {
    const groups = libraryGroups(INPUT, '');
    expect(groups.map((group) => [group.category, group.kind])).toEqual([
      ['Boards', 'org'],
      ['Calls', 'org'],
      // The uncategorized org tools (Wiki) and the person's own are two different groups, both
      // nameless — `kind` is what keeps the surfaces from labelling them the same.
      [null, 'org'],
      [null, 'personal'],
    ]);
    // Kanban's group is Boards; Jitsi — a favorite — is still in Calls, marked, not moved.
    expect(groups[1]?.cards.map((card) => card.entry.id)).toEqual(['jitsi']);
    expect(groups[1]?.cards[0]?.favorite).toBe(true);
    // The last group is the person's own tools.
    expect(groups[3]?.cards.map((card) => card.entry.id)).toEqual(['p-mine']);
  });

  test('the org chart: one node per role with its people and the categories it reaches', () => {
    const nodes = orgChart(INPUT, '');
    const admin = nodes.find((node) => node.role?.id === 'admin');
    expect(admin?.people.map((person) => person.name)).toEqual(['Ada']);
    // An admin reaches every category, whatever their roles are granted — the uncategorized
    // tools' group included.
    expect(admin?.categories).toEqual(['Boards', 'Calls', '']);
    const team = nodes.find((node) => node.role?.id === 'team');
    expect(team?.people.map((person) => person.name)).toEqual(['Bob']);
    expect(team?.categories).toEqual(['Boards', 'Calls']);
    // The roleless person is the last node, and reaches nothing.
    const last = nodes[nodes.length - 1];
    expect(last.role).toBeNull();
    expect(last.people.map((person) => person.name)).toEqual(['Eva']);
    expect(last.categories).toEqual([]);
    // The roster's admin flag is resolved through the guild's own roles.
    expect(rosterOf(INPUT.people, ROLES).find((person) => person.id === 'p-ada')?.admin).toBe(true);
    expect(rosterOf(INPUT.people, ROLES).find((person) => person.id === 'p-bob')?.admin).toBe(false);
    // A role the list no longer carries reads as roleless (the host deletes roles, never people).
    expect(rosterOf([{ id: 'p-x', name: 'X', roles: ['gone'] }], ROLES)[0]?.roles).toEqual([]);
  });

  test('the isometric stacks: one per category on a four-wide grid, with who reaches them on top', () => {
    const stacks = blockStacks(INPUT, '');
    expect(stacks.map((stack) => [stack.category, stack.kind])).toEqual([
      ['Boards', 'org'],
      ['Calls', 'org'],
      [null, 'org'],
      [null, 'personal'],
    ]);
    // The grid: four wide, the second row below the first.
    expect(stacks.map((stack) => [stack.col, stack.row])).toEqual([[0, 0], [1, 0], [2, 0], [3, 0]]);
    // Kanban and Jitsi are granted to `team`: Bob stands on both, Ada (an admin) on every one,
    // Eva on none.
    expect(stacks[0]?.people.map((person) => person.name).sort()).toEqual(['Ada', 'Bob']);
    expect(stacks[1]?.people.map((person) => person.name).sort()).toEqual(['Ada', 'Bob']);
    // Wiki is granted to nobody: only an admin stands on it.
    expect(stacks[2]?.people.map((person) => person.name)).toEqual(['Ada']);
    // The personal stack is the person's own: nobody reaches it by a role.
    expect(stacks[3]?.people.map((person) => person.name)).toEqual([]);
    // More than four categories wrap to the next row.
    const many: LibraryInput = {
      ...INPUT,
      orgTools: ['a', 'b', 'c', 'd', 'e'].map((id, index) =>
        tool(id, { category: `Cat ${id}`, order: index }),
      ),
      personalTools: [],
      favorites: [],
    };
    const wide = blockStacks(many, '');
    expect(wide[4]).toMatchObject({ col: 0, row: 1 });
  });
});
