// DOM helpers shared by every view of the single page (src/app.ts, src/palette.ts,
// src/settings.ts, src/tabs.ts). Text always goes in through `textContent`, never `innerHTML`.

type Child = Node | string | null | undefined | false;

export interface ElProps {
  class?: string;
  id?: string;
  title?: string;
  role?: string;
  /** aria-* and data-* attributes, without the prefix: { label: 'x' } → aria-label="x" */
  aria?: Record<string, string>;
  data?: Record<string, string>;
  /** other attributes set verbatim (type, name, autocomplete, placeholder, for, …) */
  attrs?: Record<string, string>;
  on?: { [K in keyof HTMLElementEventMap]?: (event: HTMLElementEventMap[K]) => void };
}

/** Creates an element with props and children; strings become text nodes. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: ElProps = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.id) node.id = props.id;
  if (props.title) node.title = props.title;
  if (props.role) node.setAttribute('role', props.role);
  for (const [k, v] of Object.entries(props.aria ?? {})) node.setAttribute(`aria-${k}`, v);
  for (const [k, v] of Object.entries(props.data ?? {})) node.setAttribute(`data-${k}`, v);
  for (const [k, v] of Object.entries(props.attrs ?? {})) node.setAttribute(k, v);
  for (const [type, handler] of Object.entries(props.on ?? {})) {
    node.addEventListener(type, handler as EventListener);
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

/**
 * The 2-letter mark of a name that has no icon: a tool's glyph, a guild's tile in the entry rail
 * and the icon of a guild in the join card all fall back to it. `?` for a name with no letters.
 */
export function initials(name: string): string {
  const mark = name.trim().slice(0, 2).toUpperCase();
  return mark === '' ? '?' : mark;
}

/**
 * Tool icon: the data URI the backend answered for it, or the two letters of its title. The
 * sidebar, Home's cards and the tabs of the strip (`src/tabs.ts`) all draw a tool this way, so it
 * looks the same wherever it is named.
 */
export function glyph(title: string, icon: string | null): HTMLElement {
  if (icon !== null) return el('img', { class: 'glyph-img', attrs: { src: icon, alt: '' } });
  return el('span', { class: 'chip' }, initials(title));
}

/** A button that disables itself while its async handler runs. */
export function button(
  label: string,
  onClick: () => void | Promise<void>,
  opts: { kind?: 'primary' | 'danger' | 'ghost'; title?: string; aria?: string } = {},
): HTMLButtonElement {
  const b = el('button', {
    class: ['button', opts.kind ? `button-${opts.kind}` : ''].filter(Boolean).join(' '),
    title: opts.title,
    attrs: { type: 'button' },
    aria: opts.aria ? { label: opts.aria } : {},
  }, label);
  b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      await onClick();
    } finally {
      b.disabled = false;
    }
  });
  return b;
}

/** A labelled form field wrapping the given input. */
export function field(label: string, input: HTMLElement, hint?: string): HTMLLabelElement {
  return el('label', { class: 'field' }, el('span', { class: 'field-label' }, label), input, hint ? el('span', { class: 'field-hint' }, hint) : null);
}

export function input(
  name: string,
  opts: { type?: string; value?: string; placeholder?: string; autocomplete?: string; required?: boolean } = {},
): HTMLInputElement {
  const i = el('input', {
    class: 'input',
    attrs: {
      name,
      type: opts.type ?? 'text',
      autocomplete: opts.autocomplete ?? 'off',
      ...(opts.placeholder ? { placeholder: opts.placeholder } : {}),
    },
  });
  if (opts.value !== undefined) i.value = opts.value;
  i.required = opts.required ?? false;
  return i;
}

/** Shows a status line (error / ok / info) inside `container`, replacing the previous one. */
export function message(container: HTMLElement, kind: 'error' | 'ok' | 'info', text: string): void {
  container.replaceChildren(el('p', { class: `message message-${kind}`, role: kind === 'error' ? 'alert' : 'status' }, text));
}

export function clear(container: HTMLElement): void {
  container.replaceChildren();
}

/**
 * Atrius' icon button: one cell, a system glyph (never an emoji, never an icon library) drawn by
 * the stylesheet from `data-icon`. The words stay the button's text — hidden on screen, read by a
 * screen reader, matched by the smoke — and they are the tooltip too, so no act is a bare glyph.
 */
export function iconButton(
  icon: string,
  label: string,
  onClick: () => void | Promise<void>,
  opts: { kind?: 'primary' | 'danger'; title?: string; pressed?: boolean; popup?: boolean } = {},
): HTMLButtonElement {
  const title = opts.title ?? label;
  const b = el(
    'button',
    {
      class: ['icon-button', opts.kind ? `icon-button-${opts.kind}` : ''].filter(Boolean).join(' '),
      title,
      attrs: { type: 'button' },
      aria: {
        label: title,
        ...(opts.pressed === undefined ? {} : { pressed: opts.pressed ? 'true' : 'false' }),
        ...(opts.popup ? { haspopup: 'menu' } : {}),
      },
      data: { icon },
    },
    label,
  );
  b.addEventListener('click', async (event) => {
    event.stopPropagation();
    b.disabled = true;
    try {
      await onClick();
    } finally {
      b.disabled = false;
    }
  });
  return b;
}

/** An empty slot of an icon row: the acts that do not apply keep their place, so columns line up. */
export function iconSlot(): HTMLElement {
  return el('span', { class: 'icon-slot', aria: { hidden: 'true' } });
}

/** One line of a menu: an act, a group heading or a rule. */
export type MenuItem =
  | { label: string; run: () => void; glyph?: string; danger?: boolean; disabled?: boolean; hint?: string }
  | { group: string }
  | 'separator';

const MENU_ID = 'nod-menu';

/** Closes the open menu, if any, and gives the focus back to whoever opened it. */
export function closeMenu(): void {
  const open = document.getElementById(MENU_ID) as (HTMLElement & { closeMenu?: () => void }) | null;
  if (open !== null && open.closeMenu !== undefined) open.closeMenu();
}

/**
 * Atrius Menu: a floating list of acts, one cell per line, the active one in inverted ink. It opens
 * under `anchor` (an element) or at a point (a right click), stays on screen, and is driven by the
 * keyboard — arrows, Home/End, Enter, Escape (which closes only the menu and gives the focus back).
 */
export function openMenu(anchor: HTMLElement | { x: number; y: number }, items: MenuItem[], label: string): void {
  closeMenu();
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const menu = el('div', { id: MENU_ID, class: 'menu', role: 'menu', aria: { label } }) as HTMLElement & {
    closeMenu?: () => void;
  };
  const acts: HTMLButtonElement[] = [];
  for (const item of items) {
    if (item === 'separator') {
      menu.append(el('div', { class: 'menu-sep', role: 'separator' }));
      continue;
    }
    if ('group' in item) {
      menu.append(el('div', { class: 'menu-group', role: 'presentation' }, item.group));
      continue;
    }
    const act = el(
      'button',
      {
        class: item.danger ? 'menu-item menu-item-danger' : 'menu-item',
        role: 'menuitem',
        attrs: { type: 'button', tabindex: '-1' },
      },
      el('span', { class: 'menu-mark', aria: { hidden: 'true' } }, item.glyph ?? ''),
      el('span', { class: 'menu-label' }, item.label),
      el('span', { class: 'menu-key' }, item.hint ?? ''),
    );
    act.disabled = item.disabled === true;
    act.addEventListener('click', () => {
      close(false);
      item.run();
    });
    act.addEventListener('mouseenter', () => act.focus());
    menu.append(act);
    acts.push(act);
  }

  function onKey(event: KeyboardEvent): void {
    const enabled = acts.filter((act) => !act.disabled);
    const at = enabled.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const by = event.key === 'ArrowDown' ? 1 : -1;
      enabled[(at + by + enabled.length) % enabled.length]?.focus();
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      (event.key === 'Home' ? enabled[0] : enabled[enabled.length - 1])?.focus();
    } else if (event.key === 'Tab') {
      event.preventDefault();
      close(true);
    }
  }
  function onOutside(event: PointerEvent): void {
    if (!menu.contains(event.target as Node)) close(false);
  }
  function close(refocus: boolean): void {
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('pointerdown', onOutside, true);
    window.removeEventListener('blur', onBlur);
    menu.remove();
    if (refocus && opener !== null && opener.isConnected) opener.focus();
  }
  function onBlur(): void {
    close(false);
  }
  menu.closeMenu = () => close(false);

  document.body.append(menu);
  const rect = anchor instanceof HTMLElement ? anchor.getBoundingClientRect() : null;
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  let x = rect === null ? (anchor as { x: number }).x : rect.left;
  let y = rect === null ? (anchor as { y: number }).y : rect.bottom + 4;
  // A menu opened from the rail opens beside it, not over it.
  if (rect !== null && rect.width <= 64 && rect.left < 80) {
    x = rect.right + 4;
    y = rect.top;
  }
  x = Math.max(4, Math.min(x, window.innerWidth - width - 8));
  y = Math.max(4, Math.min(y, window.innerHeight - height - 8));
  menu.style.left = `${Math.round(x)}px`;
  menu.style.top = `${Math.round(y)}px`;
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('pointerdown', onOutside, true);
  window.addEventListener('blur', onBlur);
  acts.find((act) => !act.disabled)?.focus();
}

/**
 * A one-field dialog — a folder's name — in the palette's layer. Answers the trimmed text, or
 * `null` when the person cancels (Escape, a click outside, Cancel).
 */
let cancelPrompt: (() => void) | null = null;

/** Cancels the active prompt, including when its owning session ends. */
export function closePrompt(): void {
  cancelPrompt?.();
}

export function promptText(opts: { title: string; label: string; value?: string; confirm: string; placeholder?: string }): Promise<string | null> {
  closePrompt();
  return new Promise((resolve) => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const field_ = input('name', { value: opts.value ?? '', placeholder: opts.placeholder ?? '', required: true });
    const overlay = el('div', { class: 'overlay' });
    let done = false;
    const finish = (value: string | null): void => {
      if (done) return;
      done = true;
      cancelPrompt = null;
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      if (opener !== null && opener.isConnected) opener.focus();
      resolve(value);
    };
    cancelPrompt = () => finish(null);
    const submit = (): void => {
      const value = field_.value.trim();
      if (value === '') {
        field_.setAttribute('aria-invalid', 'true');
        field_.focus();
        return;
      }
      finish(value);
    };
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        finish(null);
      } else if (event.key === 'Enter' && document.activeElement === field_) {
        event.preventDefault();
        submit();
      }
    }
    overlay.append(
      el(
        'div',
        { class: 'palette dialog', role: 'dialog', aria: { modal: 'true', label: opts.title } },
        el('h2', { class: 'dialog-title' }, opts.title),
        field(opts.label, field_),
        el('div', { class: 'row' }, button(opts.confirm, submit, { kind: 'primary' }), button('Cancel', () => finish(null), { kind: 'ghost' })),
      ),
    );
    overlay.addEventListener('mousedown', (event) => {
      if (event.target === overlay) finish(null);
    });
    document.addEventListener('keydown', onKey, true);
    document.body.append(overlay);
    field_.focus();
    field_.select();
  });
}
