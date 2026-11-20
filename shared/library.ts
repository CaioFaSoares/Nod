// The library (RF-79, canonico §22 "The library (app + web)"): the org catalog's one model home —
// what a card carries, what the search reads, what a group is, and the org chart's model.
// The app's Home and the web portal assemble their own DOM over these; what they cannot
// disagree about is here.
//
// Pure (`shared/context.md`): no `tjs`, no `tiny`, no DOM, no Bun. `URL` only, and the readers of
// `shared/catalog.ts` — the same ones the validator and the sidebar read.

import { byOrderAndTitle, categoryOf, groupByCategory, orgAccountOf, tagsOf } from './catalog';
import type { Entry, Id, Role } from './types';

/** One person of the roster as the org chart draws them — a name and the roles they hold. */
export interface LibraryPerson {
  id: Id;
  name: string;
  /** the role ids the person holds; an admin sees every tool, whatever their roles */
  roles: Id[];
  admin: boolean;
}

/** The library's whole input: the two catalogs the person sees, their favorites, the guild's roles and roster. */
export interface LibraryInput {
  /** the org tools the person may open — already filtered by role, in catalog order */
  orgTools: readonly Entry[];
  personalTools: readonly Entry[];
  favorites: readonly Id[];
  roles: readonly Role[];
  people: readonly LibraryPerson[];
}

/** One card: what every view draws of a tool. */
export interface LibraryCard {
  entry: Entry;
  favorite: boolean;
  tags: string[];
  orgAccount: string | null;
}

/** The three views of the strip's control, in the order the person reads them. */
export type LibraryView = 'cards' | 'list' | 'org';

export const LIBRARY_VIEWS: ReadonlyArray<{ id: LibraryView; label: string }> = [
  { id: 'cards', label: 'Cards' },
  { id: 'list', label: 'List' },
  { id: 'org', label: 'Org chart' },
];

/** The view a machine never chose — and what an unread stored choice reads as. */
export const DEFAULT_LIBRARY_VIEW: LibraryView = 'cards';

/** Unknown choices, including the retired `blocks`, read as Cards without rewriting the preference. */
export function libraryViewOf(raw: string | null | undefined): LibraryView {
  return LIBRARY_VIEWS.some((view) => view.id === raw) ? (raw as LibraryView) : DEFAULT_LIBRARY_VIEW;
}

/** The host of an address, for the search and the card's second line. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * RF-79: the search box reads everything the person can name a tool by — the title, the category,
 * each tag, the org account and the host. Case-insensitive, substring; an empty query (or one of
 * spaces) matches everything, so the box clears the way it filled.
 */
export function librarySearch(entry: Entry, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  const haystack = [
    entry.title,
    categoryOf(entry) ?? '',
    hostOf(entry.url),
    orgAccountOf(entry) ?? '',
    ...tagsOf(entry),
  ];
  return haystack.some((text) => text.toLowerCase().includes(needle));
}

/** One card of a tool, with the favorites' mark and the library's two fields read once. */
export function libraryCard(entry: Entry, favorites: ReadonlySet<Id>): LibraryCard {
  return {
    entry,
    favorite: favorites.has(entry.id),
    tags: tagsOf(entry),
    orgAccount: orgAccountOf(entry),
  };
}

/** The cards of one input, filtered by the query, in the library's own order: favorites first, then the org tools, then the personal ones. */
export function libraryCards(input: LibraryInput, query: string): LibraryCard[] {
  const favorites = new Set(input.favorites);
  const visible = [...input.orgTools, ...input.personalTools].filter((entry) => librarySearch(entry, query));
  const starred = visible.filter((entry) => favorites.has(entry.id));
  const org = visible.filter((entry) => !favorites.has(entry.id) && entry.scope !== 'personal');
  const personal = visible.filter((entry) => !favorites.has(entry.id) && entry.scope === 'personal');
  return [...starred, ...org.sort(byOrderAndTitle), ...personal].map((entry) => libraryCard(entry, favorites));
}

/**
 * One collapsible group of the cards view: a category name — `null` is "Other tools" — and what
 * the group is: the guild's org tools, or the person's own (`kind`, so the two `null` groups never
 * read as one: the surfaces label a personal group "Your tools").
 */
export interface LibraryGroup {
  category: string | null;
  kind: 'org' | 'personal';
  cards: LibraryCard[];
}

/**
 * RF-79: the cards view's groups — the org tools by the category the guild gave them, in the order
 * `groupByCategory` has always read them, and the personal tools as their own last group (a
 * personal tool is never the guild's to file). Favorites stay inside their group: the star is a
 * mark on the card, not a move of the tool — a favorite org tool is still the guild's to file.
 */
export function libraryGroups(input: LibraryInput, query: string): LibraryGroup[] {
  const favorites = new Set(input.favorites);
  const cards = libraryCards(input, query);
  const orgEntries = cards.filter((card) => card.entry.scope !== 'personal').map((card) => card.entry);
  const groups: LibraryGroup[] = groupByCategory(orgEntries).map((group) => ({
    category: group.category,
    kind: 'org',
    cards: group.entries.map((entry) => libraryCard(entry, favorites)),
  }));
  const personal = cards.filter((card) => card.entry.scope === 'personal');
  if (personal.length > 0) groups.push({ category: null, kind: 'personal', cards: personal });
  return groups;
}

// ---------------------------------------------------------------- the org chart view (RF-79)

/** One node of the org chart: a role (or no role at all), the people who hold it, and the categories its granted tools are filed in. */
export interface OrgNode {
  /** `null` is the node of the people the guild gave no role — they still reached the portal, and reach nothing. */
  role: Role | null;
  people: LibraryPerson[];
  /** the categories of the tools this role is granted, in the group order, `null` inside for "Other tools" */
  categories: string[];
}

/**
 * RF-79: the org chart the owner chose the shape of — the guild's roles as nodes with their people,
 * and beside each the categories the node's people reach ("who reaches what"): a role reaches what
 * its granted tools are filed under, an admin reaches every category, a person with no role
 * reaches none. The people of the roster appear exactly once — their first role, and the roleless
 * in the last node.
 */
export function orgChart(input: LibraryInput, query: string): OrgNode[] {
  const tools = input.orgTools.filter((entry) => librarySearch(entry, query));
  const sorted = (names: Iterable<string>): string[] =>
    [...names].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b, 'en')));
  const all = (): string[] => sorted(new Set(tools.map((entry) => categoryOf(entry) ?? '')));
  const reachedBy = (person: LibraryPerson): string[] => {
    if (person.admin) return all();
    const names = new Set<string>();
    for (const entry of tools) {
      if (entry.roles.some((role) => person.roles.includes(role))) names.add(categoryOf(entry) ?? '');
    }
    return sorted(names);
  };
  const seen = new Set<Id>();
  const push = (role: Role | null, people: LibraryPerson[]): OrgNode => {
    for (const person of people) seen.add(person.id);
    const names = new Set<string>();
    for (const person of people) for (const name of reachedBy(person)) names.add(name);
    return { role, people, categories: sorted(names) };
  };
  const nodes: OrgNode[] = [];
  for (const role of input.roles) {
    const people = input.people.filter((person) => person.roles.includes(role.id) && !seen.has(person.id));
    if (people.length > 0) nodes.push(push(role, people));
  }
  const rest = input.people.filter((person) => !seen.has(person.id));
  if (rest.length > 0) nodes.push(push(null, rest));
  return nodes.filter((node) => node.people.length > 0 || node.categories.length > 0);
}

/**
 * RF-79: the roster as the org chart reads it — nothing of a person row but the name and
 * the roles, and the admin flag resolved through the guild's own roles (the host's `SnapshotPerson`
 * carries no email and no flag on purpose, SP04 §2). A person whose roles name no role of the list
 * reads as roleless, exactly as the chart's last node draws them.
 */
export function rosterOf(
  people: ReadonlyArray<{ id: Id; name: string; roles: Id[] }>,
  roles: readonly Role[],
): LibraryPerson[] {
  return people.map((person) => ({
    id: person.id,
    name: person.name,
    roles: person.roles.filter((id) => roles.some((role) => role.id === id)),
    admin: roles.some((role) => role.admin && person.roles.includes(role.id)),
  }));
}
