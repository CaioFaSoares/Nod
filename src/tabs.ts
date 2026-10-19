// E03 (RF-49…RF-52, RF-66…RF-69): the tab view of the main window — the strip of the open tabs,
// the toolbar that acts on the active one, and the slot the backend lays the docked tab on.
// The page owns the strip and reports the slot; `backend/tool-windows.ts` owns the windows and the
// geometry, and the pure helpers live in `shared/tabs.ts`. This module talks to the backend only
// through `./api`, and `src/app.ts` mounts it — docked mode only (RF-52) — handing it the two things
// that need the window's own state: the banner and the catalog of a save (RF-67), and the link
// dialog (RF-66). RF-69 embedded tabs add the iframe layer (`createEmbedLayer`), mounted by the
// shell rather than by this view so Home and Settings never take the iframes out of the document.

import { call } from './api';
import { button, el, glyph } from './ui';
import { rectEquals } from '../shared/tabs';
import type { Id, SlotRect, TabState, ToolStatus, ToolsState, VaultItem } from '../shared/types';

/** RF-66: the mark of a tab that is not a tool — an address opened by hand or adopted from a tool. */
const LINK_GLYPH = '🔗';

/**
 * E03: the docked tab the strip, the toolbar and the palette act on. `null` in Windows mode, and
 * while every tab is detached — a detached tab is its own window, not the panel's.
 */
export function activeTab(state: ToolsState): TabState | null {
  return state.active === null ? null : state.tabs.find((tab) => tab.id === state.active) ?? null;
}

/**
 * E03: the page's half of the `tabs.*` methods. The toolbar, the palette rows and the shortcuts all
 * come through here, so the three cannot drift apart; the backend owns the windows, and the answer
 * of every call lands in `src/app.ts`, which is the one that draws the window from it.
 */
export interface TabsApi {
  newTab: (toolId: Id) => void;
  activate: (id: string) => void;
  close: (id: string) => void;
  detach: (id: string) => void;
  dock: (id: string) => void;
  next: (step: 1 | -1) => void;
  /** RF-67 (⌘D): the tab's address saved to the sidebar — the app's own `save` does the rest. */
  save: (id: string) => void;
  /**
   * RF-69: the tool opens as an embedded tab (`true`) or as a window (`false`). The app checks
   * `tabs.checkEmbed` first and shows the reason when the address may not be framed; the backend
   * stores the preference and converts the tool's open tabs in place.
   */
  setEmbedded: (toolId: Id, embedded: boolean) => void;
  /**
   * RF-70: the person reports that the tool lost its login inside Nod. The backend blocks the tool
   * from embedding — its open tabs become window tabs in place — and the answer's `embedBlocked`
   * carries the reason the app shows.
   */
  reportLoginFails: (toolId: Id) => void;
  /**
   * 0.6.0b (RF-69): the credential's username goes to the clipboard — it is already on screen in
   * Settings → Vault, never a secret.
   */
  copyUsername: (item: VaultItem) => void;
  /**
   * 0.6.0b (RF-69): the credential's password goes to the clipboard through the gated `vault.copy`,
   * exactly as Settings → Vault does; nothing of it reaches this page.
   */
  copyPassword: (item: VaultItem) => void;
}

/** What the two halves of the page hand each other. */
export interface TabsDeps {
  /** Runs a `tabs.*` action: the answer goes to `src/app.ts`, which redraws from it. */
  run: (action: () => Promise<ToolsState>) => void;
  /** RF-67: the app's own half of a save — the banner and the catalog of the new entry. */
  save: (id: string) => void;
  /** RF-69: the app's half of the embedding toggle — the frameability check and its message. */
  setEmbedded: (toolId: Id, embedded: boolean) => void;
  /** RF-70: the app's half of a report — the call, its answer and the notice of the block. */
  reportLoginFails: (toolId: Id) => void;
  /** 0.6.0b: the app's clipboard copy of a credential's username. */
  copyUsername: (item: VaultItem) => void;
  /** 0.6.0b: the app's gated copy of a credential's password. */
  copyPassword: (item: VaultItem) => void;
}

/** E03: one definition of each action, shared by the strip, the palette and the keyboard. */
export function tabsApi(deps: TabsDeps): TabsApi {
  return {
    // RF-50 (⌘T): another tab of the same tool, never a reload of this one.
    newTab: (toolId) => deps.run(() => call('tabs.new', { toolId })),
    // RF-49/RF-51: docked, it takes the slot; detached, its own window comes forward.
    activate: (id) => deps.run(() => call('tabs.activate', { id })),
    // RF-50 (⌘W): an ad-hoc tab is forgotten with it (RF-66).
    close: (id) => deps.run(() => call('tabs.close', { id })),
    // RF-51 (⌘⇧D): out into its own framed window — the same window, the same page.
    detach: (id) => deps.run(() => call('tabs.detach', { id })),
    // RF-51 (⌘⇧D): back onto the slot — the same window, the same page.
    dock: (id) => deps.run(() => call('tabs.dock', { id })),
    // RF-50 (⌃Tab / ⌃⇧Tab): the strip's neighbours, wrapping.
    next: (step) => deps.run(() => call('tabs.next', { step })),
    save: deps.save,
    setEmbedded: deps.setEmbedded,
    reportLoginFails: deps.reportLoginFails,
    copyUsername: deps.copyUsername,
    copyPassword: deps.copyPassword,
  };
}

/**
 * E03 (RF-49): one report of the slot to the backend. Geometry is not something to tell the person
 * about: a locked or quitting window that refuses the call is simply not reported to (RNF-01), and
 * the next report re-places the tab anyway.
 *
 * A `null` is what Windows mode reports once when the session opens (RF-52): the page has no slot
 * of its own there, and one left over from a docked session must not be followed.
 */
export function reportSlot(rect: SlotRect | null): void {
  try {
    call('tabs.slot', { rect }).catch(() => {
      // The bridge is gone (a lock, a quit): there is no slot to report to.
    });
  } catch {
    // The call itself threw before it left: nothing to report either.
  }
}

/** E03: what the tab view needs from the window it lives in. */
export interface TabsViewCtx {
  /** the last `tools.state`/`tools` answer the window holds */
  state: ToolsState;
  /** the page's `tabs.*` actions (`tabsApi` above) */
  actions: TabsApi;
  /** RF-66: "Open link…" — the dialog of `src/app.ts`, beside the personal-tool one */
  openLink: () => void;
  /** RF-69: the iframes of the embedded tabs, mounted once by the shell and kept across views */
  embeds: EmbedLayer;
  /**
   * 0.6.0b: the credential the login cascade would use for a tool — the default one — or null while
   * the page does not know the vault. Only metadata (never a secret) is returned.
   */
  credential: (toolId: Id) => VaultItem | null;
}

/**
 * RF-69: the iframe layer of the embedded tabs. One `<iframe>` per open embedded tab, keyed by tab
 * id — created once, kept across every re-render of the view, hidden (`display:none`) while its tab
 * is not the active one, and removed when the tab closes. `src` is written only when the backend's
 * `url` changes, so a redraw never reloads a tool.
 *
 * The element is mounted on the shell's content box, not on the tab view: Home and Settings replace
 * the panel, and taking the iframes with it would reload every embedded tool on the way back
 * (RF-50). `place` puts the layer over the slot rect and `place(null)` hides it while the panel is
 * not the tab view; neither detaches the iframes from the document, and a `display:none` iframe
 * never reloads (spike §1).
 */
export interface EmbedLayer {
  /** the element the shell keeps mounted */
  element: HTMLElement;
  /** reconciles the iframes with a `tools`/`tabs.*` answer */
  update(state: ToolsState): void;
  /** puts the layer over the slot rect; `null` hides it (no slot on screen) */
  place(rect: SlotRect | null): void;
  destroy(): void;
}

/** RF-69: builds the layer of the embedded tabs (`EmbedLayer` above); the shell mounts it once. */
export function createEmbedLayer(): EmbedLayer {
  // Until a tab view places it over the slot there is nothing to show.
  const element = el('div', { class: 'tab-embeds' });
  element.hidden = true;
  const frames = new Map<string, HTMLIFrameElement>();

  function create(tab: TabState): HTMLIFrameElement {
    const frame = el('iframe', {
      class: 'tab-embed',
      title: tab.title,
      attrs: {
        // Spike §5: a framed tool gets camera/mic silently when its origin carries `media.*`; the
        // rest of the list is what a tool expects of a browser and costs nothing here. No `sandbox`:
        // it changed no measured result (spike §6).
        allow: 'camera; microphone; display-capture; fullscreen; clipboard-read; clipboard-write',
        referrerpolicy: 'strict-origin-when-cross-origin',
      },
    });
    frames.set(tab.id, frame);
    element.append(frame);
    return frame;
  }

  return {
    element,
    update(state: ToolsState): void {
      const open = new Set<string>();
      for (const tab of state.tabs) {
        if (!tab.embedded) continue;
        open.add(tab.id);
        const frame = frames.get(tab.id) ?? create(tab);
        // RF-69: the address is the backend's. Comparing the last one written is what keeps a
        // redraw from reloading the tool.
        if (tab.url !== '' && frame.dataset.url !== tab.url) {
          frame.dataset.url = tab.url;
          frame.setAttribute('src', tab.url);
        }
        if (frame.title !== tab.title) frame.title = tab.title;
        frame.hidden = tab.id !== state.active;
      }
      for (const [id, frame] of frames) {
        if (open.has(id)) continue;
        frame.remove();
        frames.delete(id);
      }
    },
    place(rect: SlotRect | null): void {
      if (rect === null) {
        element.hidden = true;
        return;
      }
      element.hidden = false;
      element.style.left = `${rect.x}px`;
      element.style.top = `${rect.y}px`;
      element.style.width = `${rect.width}px`;
      element.style.height = `${rect.height}px`;
    },
    destroy(): void {
      frames.clear();
      element.remove();
    },
  };
}

/** E03: the mounted view — `update` on a new answer, `destroy` when the panel leaves it. */
export interface TabsHandle {
  update(state: ToolsState): void;
  destroy(): void;
}

/**
 * E03 (RF-49/RF-50): mounts the tab view in `root` (the center panel, `src/app.ts`) and reports the
 * slot while it lives. The strip and the toolbar are drawn again on every answer; the slot element
 * itself is never replaced, so the `ResizeObserver` keeps watching the box the backend follows.
 *
 * The slot is reported on: a view change (`destroy`/mount), a new answer, the slot's own box moving,
 * a window resize, an overlay appearing or leaving, and the page being hidden or shown.
 */
export function mountTabs(root: HTMLElement, ctx: TabsViewCtx): TabsHandle {
  let state = ctx.state;

  const strip = el('div', { class: 'tab-strip', role: 'tablist', aria: { label: 'Open tabs' } });
  const toolbar = el('div', { class: 'tab-toolbar' });
  // RF-49: the slot carries nothing of the page's own: the backend lays the docked tab on it, and
  // while it is away only the window's background shows.
  const slot = el('div', { class: 'tab-slot', aria: { hidden: 'true' } });
  root.append(strip, toolbar, slot);

  /** The last rect sent, so the same slot is not reported twice (`undefined`: nothing sent yet). */
  let sent: SlotRect | null | undefined = undefined;

  function send(rect: SlotRect | null): void {
    if (sent !== undefined && rectEquals(sent, rect)) return;
    sent = rect;
    reportSlot(rect);
  }

  /**
   * RF-49: the rect the backend lays the active docked tab on, or `null` when no tab may show over
   * the panel — while the page is hidden (a minimized window is not followed), while a modal overlay
   * covers the window (the palette and the dialogs of `src/app.ts`, every one of them a `.overlay`
   * child of `document.body`), and while the active tab is detached or there is none. Home, Settings
   * and the locked screen never mount this view at all: they report the `null` of `destroy`.
   *
   * RF-69: an embedded tab has no window to place, but the rect is still what tells the backend the
   * tab view is up (its hotkeys act on the embedded tab) and what places the iframe layer. It is
   * never the null of an overlay: an overlay covers the iframe naturally, so the frame stays where
   * it is (the null rule below is the docked window's alone).
   */
  function currentRect(): SlotRect | null {
    if (document.visibilityState === 'hidden') return null;
    const active = activeTab(state);
    if (active === null) return null;
    if (!active.embedded && document.querySelector('.overlay') !== null) return null;
    if (!active.docked && !active.embedded) return null;
    const box = slot.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return null;
    return {
      x: Math.round(box.x),
      y: Math.round(box.y),
      width: Math.round(box.width),
      height: Math.round(box.height),
    };
  }

  /** The slot moved, or stopped being one: one report, and only when the numbers changed. */
  const syncSlot = (): void => {
    const rect = currentRect();
    send(rect);
    // RF-69: an embedded tab lives in this layer, over the same rect the backend lays a window on.
    // While the panel is not the tab view the view is destroyed and the layer hidden, not detached.
    ctx.embeds.place(rect);
  };

  function draw(): void {
    const active = activeTab(state);
    // RF-69: one iframe per open embedded tab, before the strip is redrawn — the layer is keyed by
    // tab id, so this updates the frames without re-creating them.
    ctx.embeds.update(state);
    strip.replaceChildren(
      ...state.tabs.map((tab) => tabNode(tab, tab.id === state.active, state.tools, ctx.actions)),
      newTabButton(active, ctx.actions),
    );
    toolbar.replaceChildren(...toolbarButtons(active, ctx));
  }

  // Every observer and every event below ends in the same report — the callback keeps one identity,
  // so each of them can be removed again on `destroy`.
  const boxes = new ResizeObserver(syncSlot);
  boxes.observe(slot);
  const overlays = new MutationObserver(syncSlot);
  overlays.observe(document.body, { childList: true });
  window.addEventListener('resize', syncSlot);
  document.addEventListener('visibilitychange', syncSlot);

  draw();
  syncSlot();

  return {
    update(next: ToolsState): void {
      state = next;
      draw();
      // The strip may have changed height (a tab opened or closed), which moves the slot's box.
      syncSlot();
    },
    destroy(): void {
      boxes.disconnect();
      overlays.disconnect();
      window.removeEventListener('resize', syncSlot);
      document.removeEventListener('visibilitychange', syncSlot);
      // Home or Settings took the panel, or the session locked: there is no slot any more. RF-69:
      // the iframes stay in the document (only hidden), so the embedded tools keep running.
      ctx.embeds.place(null);
      send(null);
    },
  };
}

/**
 * E03 (RF-50/RF-51, RF-66): one tab of the strip. The row activates the tab — a docked one takes
 * the slot, a detached one (marked ↗) is brought forward in its own window. The × closes it, and
 * never activates it on the way.
 */
function tabNode(tab: TabState, active: boolean, tools: ToolStatus[], actions: TabsApi): HTMLElement {
  // The tooltip and the accessible name carry what the narrow strip cannot: the marks and the
  // failure in full.
  const name =
    `${tab.title}` +
    (tab.toolId === null ? ' — not saved' : '') +
    (tab.embedded ? ' — inside Nod' : '') +
    (tab.docked ? '' : ' — in its own window') +
    (tab.error === null ? '' : ` — failed: ${tab.error}`);
  const node = el(
    'div',
    {
      class: active ? 'tab-item tab-item-active' : 'tab-item',
      role: 'tab',
      title: name,
      aria: { selected: active ? 'true' : 'false', label: name },
      attrs: { tabindex: active ? '0' : '-1' },
    },
    tabMark(tab, tools),
    el('span', { class: 'tab-title' }, tab.title),
    ...tabFlags(tab),
    // A detached tab carries its own way back: the backend keeps the slot on a tab that is docked,
    // so `tabs.dock` has no active tab to act on for this one (the toolbar's Detach/Dock speaks for
    // the tab that is on the panel — RF-51). RF-69: an embedded tab is never detached, and offers
    // no detach/dock control at all; its mark is the ▣ `tabFlags` adds.
    tab.docked || tab.embedded ? null : dockButton(tab, actions),
    closeButton(tab, actions),
  );
  node.addEventListener('click', () => actions.activate(tab.id));
  // The strip is reachable from the keyboard (RNF-07): the arrows and ⌃Tab move, but a row that is
  // focused answers Enter and Space like every other control.
  node.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    actions.activate(tab.id);
  });
  return node;
}

/**
 * The mark of a tab: the icon its tool carries in `tools`, the tool's initials, or the link glyph of
 * an address that is no tool of the catalog (RF-66).
 */
function tabMark(tab: TabState, tools: ToolStatus[]): HTMLElement {
  if (tab.toolId === null) {
    return el('span', { class: 'tab-mark tab-mark-link', aria: { hidden: 'true' } }, LINK_GLYPH);
  }
  const tool = tools.find((item) => item.id === tab.toolId) ?? null;
  const icon = tool !== null && tool.icon !== null && tool.icon !== '' ? tool.icon : null;
  return el('span', { class: 'tab-mark' }, glyph(tab.title, icon));
}

/** RF-51/RF-66/RF-69: what the tab is and is not — not saved, inside Nod, in its own window, failed, loading. */
function tabFlags(tab: TabState): HTMLElement[] {
  const flags: HTMLElement[] = [];
  // RF-66/RF-68: an ad-hoc tab is not saved anywhere until the person saves it (RF-67).
  if (tab.toolId === null) {
    flags.push(el('span', { class: 'tab-flag tab-unsaved', title: 'Not saved — save it to the sidebar' }, '•'));
  }
  // RF-69: this tab is a page inside the Nod, not a window of its own.
  if (tab.embedded) {
    flags.push(el('span', { class: 'tab-flag tab-embedded', title: 'Inside Nod' }, '▣'));
  }
  // RF-51: this tab left the panel for a window of its own.
  if (!tab.docked) {
    flags.push(el('span', { class: 'tab-flag tab-detached', title: 'In its own window' }, '↗'));
  }
  if (tab.error !== null) {
    flags.push(el('span', { class: 'tab-flag tab-failed', title: `Failed: ${tab.error}` }, '!'));
  } else if (tab.loading) {
    flags.push(el('span', { class: 'tab-flag tab-loading', title: 'Loading…' }, '…'));
  }
  return flags;
}

/**
 * RF-51: the way back of a tab that lives in its own window — its row's ⤓. The row is not
 * activated on the way (docking is what was asked for, and the docked tab becomes the active one).
 */
function dockButton(tab: TabState, actions: TabsApi): HTMLButtonElement {
  const label = `Dock ${tab.title} back onto the panel`;
  const node = el(
    'button',
    { class: 'tab-dock', title: label, aria: { label }, attrs: { type: 'button' } },
    '⤓',
  );
  node.addEventListener('click', (event) => {
    event.stopPropagation();
    actions.dock(tab.id);
  });
  return node;
}

/** The × of a tab: it closes the tab and stops there, so the row is not activated on the way. */
function closeButton(tab: TabState, actions: TabsApi): HTMLButtonElement {
  const node = el(
    'button',
    {
      class: 'tab-close',
      title: `Close ${tab.title}`,
      aria: { label: `Close ${tab.title}` },
      attrs: { type: 'button' },
    },
    '×',
  );
  node.addEventListener('click', (event) => {
    event.stopPropagation();
    actions.close(tab.id);
  });
  return node;
}

/**
 * E03 (⌘T): the "+" that ends the strip — another tab of the tool the active tab shows. An ad-hoc
 * active tab has no tool to open another of, and no tab at all leaves nothing to repeat, so the
 * button waits.
 */
function newTabButton(active: TabState | null, actions: TabsApi): HTMLButtonElement {
  const toolId = active === null ? null : active.toolId;
  const node = el(
    'button',
    {
      class: 'tab-new',
      title: toolId === null ? 'New tab — open a tool first' : 'Another tab of this tool',
      aria: { label: 'New tab' },
      attrs: { type: 'button', ...(toolId === null ? { disabled: 'true' } : {}) },
    },
    '+',
  );
  if (toolId !== null) node.addEventListener('click', () => actions.newTab(toolId));
  return node;
}

/**
 * E03: the toolbar of the panel. Detach/Dock, the embedding toggle and Save to sidebar act on the
 * active tab (RF-51, RF-67, RF-69); "Open link…" is always there, because a link opened by hand
 * (RF-66) needs no tab to start from.
 */
function toolbarButtons(active: TabState | null, ctx: TabsViewCtx): HTMLElement[] {
  const buttons: HTMLElement[] = [];
  if (active !== null) {
    const toolId = active.toolId;
    // RF-69: an embedded tab has no window to detach and no dock to come back from.
    if (!active.embedded) {
      buttons.push(
        button(
          active.docked ? 'Detach' : 'Dock',
          () => {
            if (active.docked) ctx.actions.detach(active.id);
            else ctx.actions.dock(active.id);
          },
          {
            kind: 'ghost',
            title: active.docked
              ? `Take ${active.title} out into its own window`
              : `Bring ${active.title} back onto the panel`,
          },
        ),
      );
    }
    // RF-69: the tool's place, not an individual tab's — `setEmbedded` converts every open tab of
    // the tool. An ad-hoc tab is nobody's tool and has no toggle (RF-68).
    if (toolId !== null) {
      buttons.push(
        active.embedded
          ? button('Open as window', () => ctx.actions.setEmbedded(toolId, false), {
              kind: 'ghost',
              title: `Open ${active.title} in a window of its own`,
            })
          : button('Show inside Nod', () => ctx.actions.setEmbedded(toolId, true), {
              kind: 'ghost',
              title: `Show ${active.title} inside Nod instead of a window`,
            }),
      );
      // RF-70: a framed site never stores a SameSite login, so the person may find the tool signed
      // out inside Nod. Reporting it blocks the tool from embedding; the backend turns its tabs back
      // into windows in place, and the app shows the notice once from the answer's `embedBlocked`.
      if (active.embedded) {
        buttons.push(
          button(
            "Login won't stay? Open as window",
            () => ctx.actions.reportLoginFails(toolId),
            {
              kind: 'ghost',
              title: `If ${active.title} forgets its login inside Nod, report it and open it as a window`,
            },
          ),
        );
      }
    }
    // 0.6.0b (RF-69): no script reaches a subframe, so an embedded tool cannot be autofilled. When
    // the person holds a credential for it, the tab offers the login as two copy actions: the
    // username (already shown in Settings → Vault, not a secret) and the password through the gated
    // `vault.copy`. The vault metadata is read lazily by `src/app.ts`.
    const credential = active.embedded && toolId !== null ? ctx.credential(toolId) : null;
    if (credential !== null) {
      buttons.push(
        el('span', { class: 'tab-signin', aria: { hidden: 'true' } }, 'Sign in'),
        button('Copy username', () => ctx.actions.copyUsername(credential), {
          kind: 'ghost',
          title: `Copy the username for ${credential.label !== '' ? credential.label : credential.username}`,
        }),
        button('Copy password', () => ctx.actions.copyPassword(credential), {
          kind: 'ghost',
          title: 'Copy the password — Nod asks for the gate exactly as Settings → Vault does',
        }),
      );
    }
    buttons.push(
      button('Save to sidebar', () => ctx.actions.save(active.id), {
        kind: 'ghost',
        title: `Save ${active.title} to the sidebar`,
      }),
    );
  }
  buttons.push(
    button('Open link…', () => ctx.openLink(), { kind: 'ghost', title: 'Open an address as a tab' }),
  );
  return buttons;
}
