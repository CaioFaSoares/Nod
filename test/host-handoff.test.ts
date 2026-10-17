// `shared/host-merge.ts`'s RF-40 rule (B8b): the local `org` tools a joined host does not already
// carry as an org tool — what the Hosts tab offers as personal tools so no local tool disappears.
import { describe, expect, test } from 'bun:test';
import { leftoverLocalTools } from '../shared/host-merge';
import type { Entry } from '../shared/types';

function entry(id: string, url: string, fields: Partial<Entry> = {}): Entry {
  return {
    id,
    title: `Tool ${id}`,
    url,
    icon: null,
    order: 1,
    roles: [],
    views: [],
    auth: null,
    active: true,
    scope: 'org',
    ownerId: null,
    ...fields,
  };
}

describe('leftoverLocalTools (RF-40, B8b)', () => {
  test('a local tool the guild serves on the same address is not a leftover', () => {
    const local = [entry('jitsi', 'https://jitsi.example.test/rooms')];
    const guild = [entry('jitsi', 'https://jitsi.example.test/rooms')];
    expect(leftoverLocalTools(local, guild)).toEqual([]);
  });

  test('the comparison is origin plus path — another path of the same host is a leftover', () => {
    const local = [entry('notes', 'https://apps.example.test/notes')];
    const guild = [entry('wiki', 'https://apps.example.test/wiki')];
    expect(leftoverLocalTools(local, guild).map((e) => e.id)).toEqual(['notes']);
  });

  test('query and fragment do not make two addresses different', () => {
    const local = [entry('notes', 'https://apps.example.test/notes?tab=1#top')];
    const guild = [entry('notes', 'https://apps.example.test/notes')];
    expect(leftoverLocalTools(local, guild)).toEqual([]);
  });

  test('a different origin is a leftover even with the same path', () => {
    const local = [entry('notes', 'https://mine.example.test/notes')];
    const guild = [entry('notes', 'https://apps.example.test/notes')];
    expect(leftoverLocalTools(local, guild).map((e) => e.id)).toEqual(['notes']);
  });

  test('without an org tool every local tool is a leftover, in the order it came', () => {
    const local = [entry('a', 'https://a.example.test/'), entry('b', 'https://b.example.test/')];
    expect(leftoverLocalTools(local, []).map((e) => e.id)).toEqual(['a', 'b']);
  });

  test('only the leftovers are answered, in the local order', () => {
    const local = [
      entry('keep', 'https://keep.example.test/'),
      entry('twin', 'https://twin.example.test/'),
      entry('also-keep', 'https://also.example.test/'),
    ];
    const guild = [entry('twin', 'https://twin.example.test/')];
    expect(leftoverLocalTools(local, guild).map((e) => e.id)).toEqual(['keep', 'also-keep']);
  });

  test('an address that does not parse matches only itself', () => {
    const local = [entry('odd', 'not an address')];
    const guild = [entry('odd', 'not an address')];
    expect(leftoverLocalTools(local, guild)).toEqual([]);
  });

  test('a local personal row the snapshot does not hold is a leftover (B8b fix)', () => {
    const local = [
      entry('p-aaaaaaaaaa', 'https://mine.example.test/app', { scope: 'personal', ownerId: 'p1' }),
    ];
    expect(leftoverLocalTools(local, [], []).map((e) => e.id)).toEqual(['p-aaaaaaaaaa']);
  });

  test('a personal row the snapshot already carries by id is not a leftover', () => {
    const local = [entry('p-aaaaaaaaaa', 'https://mine.example.test/app', { scope: 'personal', ownerId: 'p1' })];
    const held = [entry('p-aaaaaaaaaa', 'https://mine.example.test/app', { scope: 'personal', ownerId: 'p1' })];
    expect(leftoverLocalTools(local, [], held)).toEqual([]);
  });

  test('org and personal leftovers come back in the local order', () => {
    const local = [
      entry('notes', 'https://notes.example.test/app'),
      entry('p-bbbbbbbbbb', 'https://mine.example.test/app', { scope: 'personal', ownerId: 'p1' }),
      entry('twin', 'https://twin.example.test/'),
    ];
    const orgTools = [entry('twin', 'https://twin.example.test/')];
    expect(leftoverLocalTools(local, orgTools, []).map((e) => e.id)).toEqual(['notes', 'p-bbbbbbbbbb']);
  });
});
