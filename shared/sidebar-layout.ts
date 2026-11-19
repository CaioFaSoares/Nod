// The person's own sidebar: their order of the tools and their folders (`sidebar.layout`).
//
// One shape, read by both halves: the backend applies it to the catalog (`applySidebarLayout`), so
// `catalog.list`, `tools.state` and the ⌘1…⌘9 digits all follow the order the person sees; the page
// draws it and edits it with the pure helpers below, then sends the whole layout back.
//
// A layout never decides what a person sees — the catalog does. An id the catalog does not resolve
// is skipped where it stands (a tool that left the guild keeps no gap), and a tool the layout does
// not name yet (a tool added since) comes after the arranged ones, in the catalog's own order.
import type { Entry, Id, SidebarFolder, SidebarLayout, SidebarNode } from './types';

/** Limits of what is stored: generous for a person, small enough for one meta row. */
export const MAX_NODES = 500;
export const MAX_FOLDERS = 64;
export const MAX_FOLDER_NAME = 40;

const FOLDER_ID = /^f-[a-z0-9-]{1,40}$/;

/** A fresh folder id. */
export function newFolderId(random: () => number = Math.random): string {
  return `f-${Math.floor(random() * 2 ** 48).toString(36)}`;
}

/** A folder name as stored: trimmed, inner whitespace collapsed, at most `MAX_FOLDER_NAME`. */
export function folderName(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_FOLDER_NAME);
}

/**
 * The layout a caller sent or the store held, checked: `null` for `null`, and an error for a shape
 * that is not a layout. A tool named twice keeps its first place; an empty folder is kept (a folder
 * the person just made).
 */
export function parseLayout(raw: unknown): SidebarLayout | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object' || !Array.isArray((raw as { nodes?: unknown }).nodes)) {
    throw new Error('invalid sidebar layout');
  }
  const input = (raw as { nodes: unknown[] }).nodes;
  if (input.length > MAX_NODES) throw new Error('invalid sidebar layout: too many items');
  const seen = new Set<Id>();
  const folders = new Set<string>();
  const nodes: SidebarNode[] = [];
  const tool = (value: unknown): Id | null => {
    if (typeof value !== 'string' || value === '' || value.length > 200) throw new Error('invalid sidebar layout: tool id');
    if (seen.has(value)) return null;
    seen.add(value);
    return value;
  };
  for (const node of input) {
    if (typeof node !== 'object' || node === null) throw new Error('invalid sidebar layout: item');
    const kind = (node as { kind?: unknown }).kind;
    if (kind === 'tool') {
      const id = tool((node as { id?: unknown }).id);
      if (id !== null) nodes.push({ kind: 'tool', id });
      continue;
    }
    if (kind !== 'folder') throw new Error('invalid sidebar layout: item kind');
    const folder = (node as { folder?: unknown }).folder;
    if (typeof folder !== 'object' || folder === null) throw new Error('invalid sidebar layout: folder');
    const { id, name, open, tools } = folder as Record<string, unknown>;
    if (typeof id !== 'string' || !FOLDER_ID.test(id) || folders.has(id)) {
      throw new Error('invalid sidebar layout: folder id');
    }
    if (typeof name !== 'string' || folderName(name) === '') throw new Error('invalid sidebar layout: folder name');
    if (!Array.isArray(tools) || tools.length > MAX_NODES) throw new Error('invalid sidebar layout: folder tools');
    folders.add(id);
    if (folders.size > MAX_FOLDERS) throw new Error('invalid sidebar layout: too many folders');
    const inside: Id[] = [];
    for (const value of tools) {
      const toolId = tool(value);
      if (toolId !== null) inside.push(toolId);
    }
    nodes.push({ kind: 'folder', folder: { id, name: folderName(name), open: open !== false, tools: inside } });
  }
  return { nodes };
}

/** Every tool the layout names, in the order the sidebar shows them (a folder's tools in its place). */
export function flatOrder(layout: SidebarLayout): Id[] {
  const ids: Id[] = [];
  for (const node of layout.nodes) {
    if (node.kind === 'tool') ids.push(node.id);
    else ids.push(...node.folder.tools);
  }
  return ids;
}

/**
 * The catalog in the person's order: the arranged tools first, in the layout's order, then the ones
 * the layout does not name, in the order they came. Without a layout the catalog is unchanged.
 */
export function applySidebarLayout(entries: Entry[], layout: SidebarLayout | null): Entry[] {
  if (layout === null) return entries;
  const byId = new Map<Id, Entry>();
  for (const entry of entries) byId.set(entry.id, entry);
  const ordered: Entry[] = [];
  const placed = new Set<Id>();
  for (const id of flatOrder(layout)) {
    const entry = byId.get(id);
    if (entry === undefined || placed.has(id)) continue;
    placed.add(id);
    ordered.push(entry);
  }
  for (const entry of entries) if (!placed.has(entry.id)) ordered.push(entry);
  return ordered;
}

// ------------------------------------------------------------------ edits (the page's)

/** Where an item goes: next to a tool, next to a folder, into a folder, or at the end of the top. */
export type Drop =
  | { before: Id }
  | { after: Id }
  | { beforeFolder: string }
  | { afterFolder: string }
  | { into: string; index?: number }
  | { end: true };

function clone(layout: SidebarLayout): SidebarLayout {
  return {
    nodes: layout.nodes.map((node) =>
      node.kind === 'tool' ? { ...node } : { kind: 'folder', folder: { ...node.folder, tools: [...node.folder.tools] } },
    ),
  };
}

/** The folder a tool sits in, or `null` at the top level (or nowhere). */
export function folderOf(layout: SidebarLayout, id: Id): SidebarFolder | null {
  for (const node of layout.nodes) {
    if (node.kind === 'folder' && node.folder.tools.includes(id)) return node.folder;
  }
  return null;
}

function findFolder(layout: SidebarLayout, folderId: string): SidebarFolder | null {
  for (const node of layout.nodes) if (node.kind === 'folder' && node.folder.id === folderId) return node.folder;
  return null;
}

/** The layout with the tool taken out of wherever it was (a folder keeps existing, even empty). */
function without(layout: SidebarLayout, id: Id): SidebarLayout {
  const next = clone(layout);
  next.nodes = next.nodes.filter((node) => node.kind !== 'tool' || node.id !== id);
  for (const node of next.nodes) {
    if (node.kind === 'folder') node.folder.tools = node.folder.tools.filter((tool) => tool !== id);
  }
  return next;
}

/** The index of a top-level node: a tool by id, a folder by folder id; -1 when absent. */
function rootIndex(layout: SidebarLayout, ref: { tool?: Id; folder?: string }): number {
  return layout.nodes.findIndex((node) =>
    node.kind === 'tool' ? node.id === ref.tool : node.folder.id === ref.folder,
  );
}

/**
 * The layout with `id` moved to `drop`. A tool can go next to a tool inside a folder (it joins the
 * folder) or at the top level; a drop that names nothing the layout holds puts it at the end.
 */
export function moveTool(layout: SidebarLayout, id: Id, drop: Drop): SidebarLayout {
  const next = without(layout, id);
  const toolNode: SidebarNode = { kind: 'tool', id };
  if ('before' in drop || 'after' in drop) {
    const ref = 'before' in drop ? drop.before : drop.after;
    const shift = 'before' in drop ? 0 : 1;
    const folder = folderOf(next, ref);
    if (folder !== null) {
      folder.tools.splice(folder.tools.indexOf(ref) + shift, 0, id);
      return next;
    }
    const index = rootIndex(next, { tool: ref });
    if (index >= 0) {
      next.nodes.splice(index + shift, 0, toolNode);
      return next;
    }
  } else if ('beforeFolder' in drop || 'afterFolder' in drop) {
    const ref = 'beforeFolder' in drop ? drop.beforeFolder : drop.afterFolder;
    const index = rootIndex(next, { folder: ref });
    if (index >= 0) {
      next.nodes.splice(index + ('beforeFolder' in drop ? 0 : 1), 0, toolNode);
      return next;
    }
  } else if ('into' in drop) {
    const folder = findFolder(next, drop.into);
    if (folder !== null) {
      const at = drop.index === undefined ? folder.tools.length : Math.max(0, Math.min(drop.index, folder.tools.length));
      folder.tools.splice(at, 0, id);
      return next;
    }
  }
  next.nodes.push(toolNode);
  return next;
}

/** The layout with a folder moved next to a top-level item (a folder never goes inside a folder). */
export function moveFolder(layout: SidebarLayout, folderId: string, drop: Drop): SidebarLayout {
  const next = clone(layout);
  const from = rootIndex(next, { folder: folderId });
  if (from < 0) return next;
  const [node] = next.nodes.splice(from, 1);
  let index = next.nodes.length;
  if ('before' in drop || 'after' in drop) {
    const ref = 'before' in drop ? drop.before : drop.after;
    // Next to a tool inside a folder means next to that folder.
    const holder = folderOf(next, ref);
    const at = holder !== null ? rootIndex(next, { folder: holder.id }) : rootIndex(next, { tool: ref });
    if (at >= 0) index = at + ('before' in drop ? 0 : 1);
  } else if ('beforeFolder' in drop || 'afterFolder' in drop) {
    const ref = 'beforeFolder' in drop ? drop.beforeFolder : drop.afterFolder;
    const at = rootIndex(next, { folder: ref });
    if (at >= 0) index = at + ('beforeFolder' in drop ? 0 : 1);
  } else if ('into' in drop) {
    const at = rootIndex(next, { folder: drop.into });
    if (at >= 0) index = at + 1;
  }
  next.nodes.splice(index, 0, node);
  return next;
}

/**
 * A new folder holding `target` and `dragged`, where `target` stood — dropping one tool on another.
 * When `target` is already in a folder, `dragged` simply joins that folder after it.
 */
export function mergeIntoFolder(layout: SidebarLayout, target: Id, dragged: Id, name: string, folderId: string): SidebarLayout {
  if (target === dragged) return clone(layout);
  const holder = folderOf(layout, target);
  if (holder !== null) return moveTool(layout, dragged, { after: target });
  const next = without(layout, dragged);
  const index = rootIndex(next, { tool: target });
  const folder: SidebarNode = { kind: 'folder', folder: { id: folderId, name: folderName(name), open: true, tools: [target, dragged] } };
  if (index < 0) {
    next.nodes.push(folder);
    return next;
  }
  next.nodes.splice(index, 1, folder);
  return next;
}

/** A new, empty folder at the end of the top level (or holding `tool`, taken from its place). */
export function addFolder(layout: SidebarLayout, name: string, folderId: string, tool?: Id): SidebarLayout {
  let next = clone(layout);
  let at = next.nodes.length;
  if (tool !== undefined) {
    const holder = folderOf(next, tool);
    const index = holder === null ? rootIndex(next, { tool }) : rootIndex(next, { folder: holder.id }) + 1;
    next = without(next, tool);
    if (index >= 0) at = index;
  }
  next.nodes.splice(at, 0, {
    kind: 'folder',
    folder: { id: folderId, name: folderName(name), open: true, tools: tool === undefined ? [] : [tool] },
  });
  return next;
}

export function renameFolder(layout: SidebarLayout, folderId: string, name: string): SidebarLayout {
  const next = clone(layout);
  const folder = findFolder(next, folderId);
  if (folder !== null && folderName(name) !== '') folder.name = folderName(name);
  return next;
}

export function setFolderOpen(layout: SidebarLayout, folderId: string, open: boolean): SidebarLayout {
  const next = clone(layout);
  const folder = findFolder(next, folderId);
  if (folder !== null) folder.open = open;
  return next;
}

/** The folder goes; its tools stay, in its place and in its order. */
export function removeFolder(layout: SidebarLayout, folderId: string): SidebarLayout {
  const next = clone(layout);
  const index = rootIndex(next, { folder: folderId });
  if (index < 0) return next;
  const node = next.nodes[index];
  const tools = node.kind === 'folder' ? node.folder.tools : [];
  next.nodes.splice(index, 1, ...tools.map((id): SidebarNode => ({ kind: 'tool', id })));
  return next;
}

/** The tool leaves its folder and stands right after it at the top level. */
export function takeOutOfFolder(layout: SidebarLayout, id: Id): SidebarLayout {
  const holder = folderOf(layout, id);
  if (holder === null) return clone(layout);
  return moveTool(layout, id, { afterFolder: holder.id });
}

/**
 * One step up (-1) or down (+1) for the keyboard: a tool moves inside its folder, or past its
 * neighbour at the top level (into a folder it meets, open or not, at the near end); a folder moves
 * past its neighbour. A tool at the edge of its folder steps out of it.
 */
export function step(layout: SidebarLayout, ref: { tool: Id } | { folder: string }, by: -1 | 1): SidebarLayout {
  if ('folder' in ref) {
    const index = rootIndex(layout, { folder: ref.folder });
    const neighbour = layout.nodes[index + by];
    if (index < 0 || neighbour === undefined) return clone(layout);
    const drop: Drop =
      neighbour.kind === 'tool'
        ? by < 0 ? { before: neighbour.id } : { after: neighbour.id }
        : by < 0 ? { beforeFolder: neighbour.folder.id } : { afterFolder: neighbour.folder.id };
    return moveFolder(layout, ref.folder, drop);
  }
  const id = ref.tool;
  const holder = folderOf(layout, id);
  if (holder !== null) {
    const at = holder.tools.indexOf(id);
    const neighbour = holder.tools[at + by];
    if (neighbour === undefined) {
      return moveTool(layout, id, by < 0 ? { beforeFolder: holder.id } : { afterFolder: holder.id });
    }
    return moveTool(layout, id, by < 0 ? { before: neighbour } : { after: neighbour });
  }
  const index = rootIndex(layout, { tool: id });
  const neighbour = layout.nodes[index + by];
  if (index < 0 || neighbour === undefined) return clone(layout);
  if (neighbour.kind === 'tool') return moveTool(layout, id, by < 0 ? { before: neighbour.id } : { after: neighbour.id });
  return moveTool(layout, id, { into: neighbour.folder.id, index: by < 0 ? neighbour.folder.tools.length : 0 });
}

/**
 * The layout that reproduces the default sidebar, so the first edit changes only what was moved:
 * the favorites on top, each guild category as an open folder, the uncategorized org tools, then the
 * personal tools. `groups` is the default sidebar as the page draws it.
 */
export function seedLayout(groups: { category: string | null; ids: Id[] }[], makeId: () => string): SidebarLayout {
  const nodes: SidebarNode[] = [];
  for (const group of groups) {
    if (group.category === null) {
      for (const id of group.ids) nodes.push({ kind: 'tool', id });
    } else if (group.ids.length > 0) {
      nodes.push({ kind: 'folder', folder: { id: makeId(), name: folderName(group.category) || 'Folder', open: true, tools: [...group.ids] } });
    }
  }
  return parseLayout({ nodes }) ?? { nodes: [] };
}
