// E03 (RF-49…RF-52, RF-66…RF-68): the pure half of docked tabs, quick links and save-in-one-step.
// Contract: `local://e03-design.md` §"Pure module `shared/tabs.ts`"; requirements: docs/canonico.md §14;
// epic: docs/epics/E03-docked-tabs.md; measured geometry: docs/handovers/e03-spikes.md §3.
//
// Pure (`shared/context.md`): no `tjs`, no `tiny`, no DOM. Only `URL`/`URLSearchParams`, which every
// runtime of this repo has (the same rule `shared/join-link.ts` follows). The backend owns the live
// tab list and the geometry calls; this module only decides ids, order, link acceptance and the
// screen rect, so page, backend and tests cannot disagree about any of them.

import { originOf } from './catalog';
import { TOOL_WINDOW_PREFIX, type Id, type SlotRect, type WindowMode } from './types';

// ---------------------------------------------------------------- window ids

/**
 * E03: every ad-hoc tab (`tabs.openLink`, the `nod://open?url=` deep link) gets a window id
 * `link_<n>`. Ad-hoc tabs never start with `tool_`, so `toolOfWindow` refuses them and the backend's
 * `guarded` gate gives them no method at all (RF-68).
 */
export const LINK_WINDOW_PREFIX = 'link_';

/**
 * E03: window id of a tool's `n`-th tab, `n >= 2`. The first tab keeps the day-one id
 * (`tool_<entry>`, `window` views still `tool_<entry>_<viewIndex>`), so the runtime's `toolOfWindow`
 * — which splits on `_` — keeps answering the same tool for every tab.
 */
export function tabWindowId(toolId: Id, n: number): string {
  return `${TOOL_WINDOW_PREFIX}${toolId}_t${n}`;
}

/** E03: the first free tab number of a tool, from 2 up. `liveIds` are the window ids in use. */
export function nextTabNumber(toolId: Id, liveIds: Iterable<string>): number {
  const used = new Set(liveIds);
  let n = 2;
  while (used.has(tabWindowId(toolId, n))) n += 1;
  return n;
}

/** E03: window id of an ad-hoc tab opened by hand; `n >= 1`. */
export function linkWindowId(n: number): string {
  return `${LINK_WINDOW_PREFIX}${n}`;
}

/** E03: the first free ad-hoc window id, from 1 up. */
export function nextLinkNumber(liveIds: Iterable<string>): number {
  const used = new Set(liveIds);
  let n = 1;
  while (used.has(linkWindowId(n))) n += 1;
  return n;
}

// ---------------------------------------------------------------- strip order

/**
 * E03 (RF-66): inserts `id` right after `afterId` — a link clicked inside a tab opens next to it,
 * an adopted popup lands right after its opener. `null` (no opener) or an id no longer in the strip
 * appends at the end. Returns a new array; `order` is never mutated.
 */
export function insertAfter(order: string[], afterId: string | null, id: string): string[] {
  const next = [...order];
  const at = afterId === null ? -1 : next.indexOf(afterId);
  if (at === -1) next.push(id);
  else next.splice(at + 1, 0, id);
  return next;
}

/**
 * E03: which tab becomes active when `closedId` goes away — the tab on its right, else the one on
 * its left, else none (the strip emptied). An id not in the strip has no neighbour either.
 */
export function neighbourAfterClose(order: string[], closedId: string): string | null {
  const at = order.indexOf(closedId);
  if (at === -1) return null;
  if (at + 1 < order.length) return order[at + 1];
  if (at - 1 >= 0) return order[at - 1];
  return null;
}

/**
 * E03 (⌃Tab / ⌃⇧Tab, RF-49): the tab `step` away from `current`, wrapping at both ends. With no
 * current tab (or one no longer in the strip), `+1` starts at the first tab and `-1` at the last;
 * an empty strip has none.
 */
export function stepTab(order: string[], current: string | null, step: 1 | -1): string | null {
  if (order.length === 0) return null;
  const at = current === null ? -1 : order.indexOf(current);
  if (at === -1) return step === 1 ? order[0] : order[order.length - 1];
  return order[(at + step + order.length) % order.length];
}

// ---------------------------------------------------------------- links (RF-66)

/** A leading `scheme:` — RFC 3986's grammar, the same one the WHATWG `URL` parser accepts. */
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * E03/RF-66: the longest address a tab opens with. RFC 7230's recommended request-line limit, and
 * the length every browser keeps working at; a pasted "link" longer than that is a payload, not an
 * address (the tab title, the persisted list and the audit events all keep the URL whole).
 */
const LINK_MAX_LENGTH = 2048;

/**
 * E03 (RF-66): one URL the Nod may open as a tab. Surrounding whitespace (a pasted link) is
 * ignored; a bare host (`example.com/x`) is read as `https://`. Only `http:`/`https:` with a host
 * survive — `javascript:`, `data:`, `file:`, `mailto:` and the like are refused, so an ad-hoc tab
 * can never leave the web (RF-68). A URL that carries credentials (`https://user:secret@host/`) is
 * refused: the address goes into `store.json`, the audit log and the sidebar, and a password in it
 * would be a secret written to disk and shown in a list. Anything past 2048 characters is refused
 * too — no address a person pastes is that long, and the tab title, the persisted list and the
 * events all keep it whole. Returns the normalized `href`, or `null`.
 */
export function parseLinkUrl(raw: string): string | null {
  const text = raw.trim();
  if (text === '') return null;
  let parsed: URL;
  try {
    parsed = new URL(SCHEME.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.hostname === '') return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  if (parsed.href.length > LINK_MAX_LENGTH) return null;
  return parsed.href;
}

/**
 * E03: reads the `nod://open?url=<encoded>` deep link of RF-66. The scheme is case-insensitive and
 * the action sits in the authority (`nod://open`) or, as in `shared/join-link.ts`, in the path
 * (`nod:open`); any other action — `nod://join` is read by its own module — and any missing or
 * unacceptable `url` answer `null`. Returns the `parseLinkUrl` of the carried URL.
 */
export function parseOpenLink(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'nod:') return null;
  const action = parsed.host !== '' ? parsed.host : parsed.pathname.replaceAll('/', '');
  if (action.toLowerCase() !== 'open') return null;
  const target = parsed.searchParams.get('url');
  if (target === null) return null;
  return parseLinkUrl(target);
}

// ---------------------------------------------------------------- slot rect (RF-49)

/**
 * E03 (RF-49): the slot rect in CSS px relative to the main page → a screen rect for the docked
 * tab, by the formula measured on macOS (`docs/handovers/e03-spikes.md` §3): the slot's top-left
 * shifts by half the side borders and by the whole title bar. Every field is rounded to whole
 * points; `width`/`height` are passed through unchanged (the slot is the page box, frame excluded).
 */
export function slotToScreen(
  main: { x: number; y: number; width: number; height: number; outer: { width: number; height: number } },
  rect: SlotRect,
): SlotRect {
  const dx = main.outer.width - main.width;
  const dy = main.outer.height - main.height;
  return {
    x: Math.round(main.x + dx / 2 + rect.x),
    y: Math.round(main.y + dy + rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

/** E03: whether two slot rects are the same — the backend skips a re-place when nothing moved. */
export function rectEquals(a: SlotRect | null, b: SlotRect | null): boolean {
  if (a === null || b === null) return a === b;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

// ---------------------------------------------------------------- restore (T6, RF-49)

/**
 * One non-ad-hoc tab as `open_tools` keeps it (docs/canonico.md §7 "Restauração"): the tool, its
 * `window` view index, the last URL, and whether it was detached or active. Ad-hoc tabs are never
 * persisted (E03 §5). Old items `{ toolId, view? }` stay valid.
 */
export interface PersistedTab {
  toolId: Id;
  view?: number;
  url?: string;
  detached?: true;
  active?: true;
}

/**
 * E03 (RF-49, T6): reads `open_tools` back into tabs. Anything but an array answers `[]`; an item
 * without a non-empty `toolId` — a foreign or corrupt entry — is dropped, as is one whose `view`
 * is present but not a non-negative integer. `url` is kept only when `parseLinkUrl` accepts it
 * (the item survives either way), `detached` only when exactly `true`, and `active` only when
 * exactly `true` and only on the first such item — two actives in the store restore as one.
 */
export function parsePersistedTabs(raw: unknown): PersistedTab[] {
  if (!Array.isArray(raw)) return [];
  const out: PersistedTab[] = [];
  let activeSeen = false;
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const toolId = record.toolId;
    if (typeof toolId !== 'string' || toolId === '') continue;
    const tab: PersistedTab = { toolId };
    const view = record.view;
    if (view !== undefined) {
      if (typeof view !== 'number' || !Number.isInteger(view) || view < 0) continue;
      tab.view = view;
    }
    if (typeof record.url === 'string') {
      const parsedUrl = parseLinkUrl(record.url);
      if (parsedUrl !== null) tab.url = parsedUrl;
    }
    if (record.detached === true) tab.detached = true;
    if (record.active === true && !activeSeen) {
      tab.active = true;
      activeSeen = true;
    }
    out.push(tab);
  }
  return out;
}

// ---------------------------------------------------------------- save (Q3, RF-67)

/**
 * E03 (RF-67): where `tabs.save` sends a tab, by origin alone — no typing, no probing here. The
 * tab's URL is http(s)-only; when its origin is one of the entries the person sees, it becomes a
 * `view` of the first such entry; otherwise a new `tool`. `null` means "not a link to save" (a
 * `file:`, empty or malformed URL). The origin compare goes through `originOf`, whose strict
 * parser throws on a stale or foreign entry URL, each guarded so one bad entry never blocks the
 * others.
 */
export function saveTarget(
  url: string,
  entries: Array<{ id: Id; url: string }>,
): { kind: 'view'; entryId: Id } | { kind: 'tool' } | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.hostname === '') return null;
  const origin = parsed.origin;
  for (const entry of entries) {
    let entryOrigin: string;
    try {
      entryOrigin = originOf(entry.url);
    } catch {
      continue;
    }
    if (entryOrigin === origin) return { kind: 'view', entryId: entry.id };
  }
  return { kind: 'tool' };
}

/**
 * E03 (RF-52): the mode a Nod starts in when `window_mode` holds nothing — `docked` on macOS
 * (measured to position windows, `docs/handovers/e03-spikes.md` §8), `windows` on Windows and
 * Linux (canonico §22 "Docked mode per OS"). A runtime that cannot position windows overrides this
 * to `windows` regardless; that check lives in the backend.
 */
export function defaultMode(os: 'macos' | 'windows' | 'linux'): WindowMode {
  return os === 'macos' ? 'docked' : 'windows';
}
