import { describe, expect, test } from 'bun:test';
import {
  addFolder,
  applySidebarLayout,
  flatOrder,
  mergeIntoFolder,
  moveFolder,
  moveTool,
  parseLayout,
  removeFolder,
  renameFolder,
  seedLayout,
  step,
  takeOutOfFolder,
} from '../shared/sidebar-layout';
import type { Entry, SidebarLayout } from '../shared/types';

const entry = (id: string): Entry => ({
  id,
  title: id.toUpperCase(),
  url: `https://${id}.example.test`,
  icon: null,
  order: 0,
  roles: [],
  views: [],
  auth: null,
  active: true,
});

const folder = (id: string, tools: string[], name = id, open = true) =>
  ({ kind: 'folder', folder: { id, name, open, tools } }) as const;
const tool = (id: string) => ({ kind: 'tool', id }) as const;
const layout = (...nodes: SidebarLayout['nodes']): SidebarLayout => ({ nodes: [...nodes] });

describe('parseLayout', () => {
  test('null stays null; a non-layout is refused', () => {
    expect(parseLayout(null)).toBeNull();
    expect(() => parseLayout({})).toThrow();
    expect(() => parseLayout({ nodes: [{ kind: 'x' }] })).toThrow();
    expect(() => parseLayout({ nodes: [folder('bad id', [])] })).toThrow();
    expect(() => parseLayout({ nodes: [folder('f-a', [], '   ')] })).toThrow();
  });

  test('a tool named twice keeps its first place, names are trimmed', () => {
    const parsed = parseLayout({ nodes: [tool('a'), folder('f-x', ['a', 'b'], '  Work   tools ')] });
    expect(parsed).toEqual(layout(tool('a'), folder('f-x', ['b'], 'Work tools')));
  });

  test('a repeated folder id is refused', () => {
    expect(() => parseLayout({ nodes: [folder('f-a', []), folder('f-a', [])] })).toThrow();
  });
});

describe('applySidebarLayout', () => {
  const entries = ['a', 'b', 'c', 'd'].map(entry);

  test('no layout keeps the catalog order', () => {
    expect(applySidebarLayout(entries, null).map((e) => e.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  test('arranged first, folders in place, unknown ids skipped, the rest after', () => {
    const order = applySidebarLayout(entries, layout(tool('c'), folder('f-x', ['zz', 'a']), tool('gone')));
    expect(order.map((e) => e.id)).toEqual(['c', 'a', 'b', 'd']);
  });
});

describe('edits', () => {
  const base = layout(tool('a'), folder('f-x', ['b', 'c']), tool('d'));

  test('moveTool next to a tool in a folder joins the folder', () => {
    expect(flatOrder(moveTool(base, 'a', { after: 'b' }))).toEqual(['b', 'a', 'c', 'd']);
    expect(moveTool(base, 'a', { after: 'b' }).nodes[0]).toEqual(folder('f-x', ['b', 'a', 'c']));
  });

  test('moveTool out of a folder to the top level, and into a folder at an index', () => {
    expect(moveTool(base, 'c', { before: 'a' }).nodes).toEqual([tool('c'), tool('a'), folder('f-x', ['b']), tool('d')]);
    expect(moveTool(base, 'd', { into: 'f-x', index: 0 }).nodes).toEqual([tool('a'), folder('f-x', ['d', 'b', 'c'])]);
  });

  test('moveFolder next to a tool inside another folder lands next to that folder', () => {
    const two = layout(folder('f-x', ['a']), folder('f-y', ['b']), tool('c'));
    expect(moveFolder(two, 'f-y', { before: 'a' }).nodes.map((n) => (n.kind === 'tool' ? n.id : n.folder.id))).toEqual([
      'f-y',
      'f-x',
      'c',
    ]);
    expect(moveFolder(two, 'f-x', { after: 'c' }).nodes.map((n) => (n.kind === 'tool' ? n.id : n.folder.id))).toEqual([
      'f-y',
      'c',
      'f-x',
    ]);
  });

  test('mergeIntoFolder makes a folder where the target stood', () => {
    expect(mergeIntoFolder(base, 'd', 'a', 'New', 'f-n').nodes).toEqual([folder('f-x', ['b', 'c']), folder('f-n', ['d', 'a'], 'New')]);
    // Into a tool that is already in a folder: the dragged one joins it.
    expect(mergeIntoFolder(base, 'b', 'd', 'New', 'f-n').nodes).toEqual([tool('a'), folder('f-x', ['b', 'd', 'c'])]);
  });

  test('removeFolder spills its tools in place; takeOutOfFolder lands after the folder', () => {
    expect(removeFolder(base, 'f-x').nodes).toEqual([tool('a'), tool('b'), tool('c'), tool('d')]);
    expect(takeOutOfFolder(base, 'b').nodes).toEqual([tool('a'), folder('f-x', ['c']), tool('b'), tool('d')]);
  });

  test('addFolder with a tool takes it from its place; renameFolder ignores a blank name', () => {
    expect(addFolder(base, 'Mine', 'f-n', 'a').nodes).toEqual([folder('f-n', ['a'], 'Mine'), folder('f-x', ['b', 'c']), tool('d')]);
    expect(renameFolder(base, 'f-x', '  ').nodes[1]).toEqual(folder('f-x', ['b', 'c']));
    expect(renameFolder(base, 'f-x', 'Work').nodes[1]).toEqual(folder('f-x', ['b', 'c'], 'Work'));
  });

  test('step moves through folders and out of their edges', () => {
    expect(step(base, { tool: 'a' }, 1).nodes).toEqual([folder('f-x', ['a', 'b', 'c']), tool('d')]);
    expect(step(base, { tool: 'b' }, -1).nodes).toEqual([tool('a'), tool('b'), folder('f-x', ['c']), tool('d')]);
    expect(step(base, { tool: 'b' }, 1).nodes[1]).toEqual(folder('f-x', ['c', 'b']));
    expect(step(base, { folder: 'f-x' }, -1).nodes[0]).toEqual(folder('f-x', ['b', 'c']));
    // The edge of the top level is a no-op.
    expect(step(base, { tool: 'd' }, 1)).toEqual(base);
  });

  test('edits never mutate their input', () => {
    const before = JSON.stringify(base);
    moveTool(base, 'a', { into: 'f-x' });
    removeFolder(base, 'f-x');
    step(base, { tool: 'b' }, 1);
    expect(JSON.stringify(base)).toBe(before);
  });
});

test('seedLayout turns categories into open folders', () => {
  let n = 0;
  const seeded = seedLayout(
    [
      { category: null, ids: ['fav'] },
      { category: 'Work', ids: ['a', 'b'] },
      { category: null, ids: ['c'] },
      { category: 'Empty', ids: [] },
    ],
    () => `f-${(n += 1)}`,
  );
  expect(seeded.nodes).toEqual([tool('fav'), folder('f-1', ['a', 'b'], 'Work'), tool('c')]);
});
