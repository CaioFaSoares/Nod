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
