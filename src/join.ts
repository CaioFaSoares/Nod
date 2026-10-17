// 0.5.0 (RF-59), SP05 §4: the Discord-like way into a guild. An invite link opens the guild's card
// — icon, name, the roles the invite carries, how long and how often it still works, the
// fingerprint to check out loud — and the person then creates the account they chose. The secondary
// paths sit beside it: sign in to a guild this Nod already knows, use an access code an admin
// handed over, or create a guild with a setup code.
//
// Two screens mount this module: the entry screen's `+` tile (`src/entry.ts`) and Settings → Hosts
// (`src/settings.ts`). `host.discover`, `host.activate`, `host.signIn` and `host.invitePreview` take
// no session, which is why the same flow works locked and unlocked.
//
// The page talks to the backend only through `./api`. The password and the code leave this module
// only as the parameter of that one call, and neither is ever written back into the DOM after a
// submit (the fields are rebuilt instead).
import { call, errorMessage } from './api';
import { button, clear, el, field, initials, input, message } from './ui';
import { codeKindOf } from '../shared/host-api';
import { joinLink, parseJoinLink } from '../shared/join-link';
import type { Id, InviteView, JoinInvite } from '../shared/types';

/**
 * Which way in the person picked. `join` is the invite of RF-59 (the link, or an address with the
 * code); `signin` is guild this Nod already knows; `access` is a code an admin handed over for
 * an account that exists; `setup` is the code that creates a guild.
 */
export type JoinStep = 'join' | 'signin' | 'access' | 'setup';

/** The pane on screen: the invite link, the address form, the invite card, the account form. */
type Pane = 'start' | 'address' | 'preview' | 'account';

/** What the flow holds between renders. The password is cleared on every submit. */
interface JoinDraft {
  mode: JoinStep;
  pane: Pane;
  /** the address typed (or the one the link/prefill carried) */
  address: string;
  /** the fingerprint the invite (or the pinned host) fixed, or null when the person typed it */
  expected: string | null;
  guild: string;
  fingerprint: string;
  /** the address was found and its key accepted */
  discovered: boolean;
  /** the text of the invite link field */
  link: string;
  /** the invite card `host.invitePreview` answered, once it did */
  preview: InviteView | null;
  /** the invite link's field or the address form's code field, whichever is on screen */
  code: string;
  /** the "address and a code instead" disclosure of the free pane is open */
  manual: boolean;
  email: string;
  name: string;
  password: string;
  confirm: string;
  /**
   * F1: the local account of this Nod that holds the join's email, as the backend answered it —
   * `null` while the flow has not collided with one. It is what puts the choice of which account
   * wins on screen, and the next submit carries the decision (`adoptLocal`).
   */
  collision: { personId: Id; email: string; name: string } | null;
  /** F1: which account the person picked while a collision is on screen. */
  choice: 'guild' | 'local';
}

/** What the screen that mounts the flow starts with. */
export interface JoinFlowOptions {
  /** a prefilled address and fingerprint: a `nod://join` invite, or what an added host knows */
  prefill?: JoinInvite | null;
  /** the prefill is the host this machine already pinned, so another key is SP04 §1.4's refusal */
  pinned?: boolean;
  /** which path opens; the invite of RF-59 unless the screen asks for another (default `join`) */
  step?: JoinStep;
  /** an account exists on this machine: the email starts filled */
  email?: string | null;
  /** the join went through: the backend has already pushed the new session (`vaultWiped`: the
   *  reset removed this machine's saved logins, SP02 §7) */
  onJoined: (result: { vaultWiped: boolean }) => void;
}

/** Case, spaces and grouping are presentation (SP04 §1.1): one key typed two ways is one string. */
function sameFingerprint(left: string, right: string): boolean {
  const plain = (value: string): string => value.toUpperCase().replaceAll('-', '').replaceAll(' ', '');
  return plain(left) === plain(right);
}

/**
 * SP05 §4's join flow, shared by the entry screen's `+` tile and Settings → Hosts. Answers the
 * handle the screens need to re-aim it when a `nod://join` link arrives on an open screen.
 */
export function mountJoinFlow(
  root: HTMLElement,
  ctx: JoinFlowOptions,
): { setPrefill(invite: JoinInvite | null): void } {
  const refusal =
    ctx.pinned === true
      ? 'host key changed — remove and add the host again'
      : 'host key does not match the invite';
  const prefilled = ctx.prefill ?? null;
  const expected = prefilled === null || prefilled.fingerprint.trim() === '' ? null : prefilled.fingerprint;
  const draft: JoinDraft = {
    mode: ctx.step ?? 'join',
    pane: ctx.step === undefined || ctx.step === 'join' ? 'start' : 'address',
    address: prefilled?.address ?? '',
    expected,
    guild: '',
    fingerprint: '',
    discovered: false,
    link: prefilled === null ? '' : joinLink(prefilled),
    preview: null,
    code: prefilled?.code ?? '',
    manual: false,
    email: ctx.email ?? '',
    name: '',
    password: '',
    confirm: '',
    collision: null,
    choice: 'guild',
  };
  let status: { kind: 'info' | 'ok' | 'error'; text: string } | null = null;

  function render(): void {
    clear(root);
    const box = el('section', { class: 'stack join-flow' });
    if (draft.pane === 'start') box.append(startCard());
    else if (draft.pane === 'address') box.append(addressCard());
    else if (draft.pane === 'preview') box.append(previewCard());
    else box.append(accountCard());
    if (status !== null) {
      const line = el('div');
      message(line, status.kind, status.text);
      box.append(line);
    }
    root.append(box);
  }

  /** Which path the person is on, as the pane's own title and hint say it. */
  function title(): { head: string; hint: string } {
    switch (draft.mode) {
      case 'signin':
        return { head: 'Sign in to your guild', hint: 'The address of the host, then your password.' };
      case 'access':
        return {
          head: 'Use your access code',
          hint: 'The code your admin handed over, and the password you want on this machine.',
        };
      case 'setup':
        return {
          head: 'Create a guild',
          hint: 'The address of your host, the setup code it printed, and the account of its first admin.',
        };
      default:
        return { head: 'Join a guild', hint: 'The invite link your admin sent you.' };
    }
  }

  /**
   * Step 1 of the invite of RF-59: one field, the link. An address and a code are accepted for the
   * person whose admin sent them apart, and the two other ways in — sign in, an access code — plus
   * creating a guild sit under it.
   */
  function startCard(): HTMLElement {
    const linkField = input('join-link', { value: draft.link, placeholder: 'nod://join?host=…' });
    linkField.addEventListener('input', () => {
      draft.link = linkField.value;
    });
    const card = el(
      'section',
      { class: 'card stack' },
      el('h2', {}, title().head),
      el(
        'p',
        { class: 'muted' },
        'Paste the invite link your admin sent you. You choose your own name, email and password — ' +
          'the invite decides the roles you start with.',
      ),
      el('div', { class: 'row' }, field('Invite link', linkField), button('Continue', () => void fromLink(), { kind: 'primary' })),
    );

    if (draft.manual) {
      card.append(manualCard());
    } else {
      card.append(
        el(
          'div',
          { class: 'row' },
          button('Have an address and a code instead?', () => {
            draft.manual = true;
            status = null;
            render();
          }, { kind: 'ghost' }),
        ),
      );
    }

    card.append(
      el(
        'div',
        { class: 'row join-secondary' },
        button('Already in this guild? Sign in', () => openMode('signin'), { kind: 'ghost' }),
        button('Got a code from your admin?', () => openMode('access'), { kind: 'ghost' }),
        button('Create a guild', () => openMode('setup'), { kind: 'ghost' }),
      ),
    );
    return card;
  }

  /** The address and the code, for the admin who sent them apart instead of as one link. */
  function manualCard(): HTMLElement {
    const address = input('address', { value: draft.address, placeholder: 'nod.example.com' });
    address.addEventListener('input', () => {
      draft.address = address.value;
    });
    const code = input('code', { value: draft.code, placeholder: 'XXXX-…' });
    code.addEventListener('input', () => {
      draft.code = code.value;
    });
    return el(
      'div',
      { class: 'stack' },
      el('div', { class: 'row' }, field('Address', address), field('Code', code)),
      el(
        'p',
        { class: 'muted' },
        'An invite link, a code for an account that exists and a setup code of a new guild all work here.',
      ),
      el('div', { class: 'row' }, button('Continue with the code', () => void fromTyped(), { kind: 'primary' })),
    );
  }

  /** Step 1 of the other three paths: the address (and the code they carry). */
  function addressCard(): HTMLElement {
    const address = input('address', { value: draft.address, placeholder: 'nod.example.com' });
    address.addEventListener('input', () => {
      draft.address = address.value;
    });
    const rows: HTMLElement[] = [el('div', { class: 'row' }, field('Address', address))];
    if (draft.mode !== 'signin') {
      const code = input('code', { value: draft.code, placeholder: 'XXXX-…' });
      code.addEventListener('input', () => {
        draft.code = code.value;
      });
      rows.push(el('div', { class: 'row' }, field('Code', code)));
    }
    const card = el(
      'section',
      { class: 'card stack' },
      el('h2', {}, title().head),
      el('p', { class: 'muted' }, title().hint),
      ...rows,
    );
    if (draft.discovered) {
      card.append(
        el(
          'div',
          { class: 'row' },
          el('span', { class: 'chip' }, draft.guild),
          el('span', { class: 'mono fingerprint' }, draft.fingerprint),
        ),
        el('p', { class: 'muted' }, 'Check this fingerprint with your admin before you continue.'),
      );
    }
    card.append(
      el(
        'div',
        { class: 'row' },
        button(draft.discovered ? 'Continue' : 'Find guild', () => void fromTyped(), { kind: 'primary' }),
        button('Back', () => openMode('join'), { kind: 'ghost' }),
      ),
    );
    return card;
  }

  /**
   * Step 2 of the invite: what the link opens. The guild's own card — icon, name, the roles the
   * invite grants and how long it still works — is what the person checks before creating anything,
   * and the fingerprint is the one they confirm with whoever invited them (SP04 §1.3).
   */
  function previewCard(): HTMLElement {
    const card = el('section', { class: 'card stack invite-card' });
    const preview = draft.preview;
    card.append(
      el(
        'div',
        { class: 'invite-head' },
        preview !== null && preview.icon !== null
          ? el('img', { class: 'invite-icon', attrs: { src: preview.icon, alt: '' } })
          : el('span', { class: 'invite-initials', aria: { hidden: 'true' } }, initials(draft.guild)),
        el(
          'div',
          { class: 'stack' },
          el('h2', {}, draft.guild === '' ? 'A guild' : draft.guild),
          el('p', { class: 'muted' }, "You've been invited to join"),
        ),
      ),
    );
    if (preview !== null) {
      const roles = el('div', { class: 'row invite-roles', aria: { label: 'Roles of this invite' } });
      for (const role of preview.roles) roles.append(el('span', { class: 'chip' }, role));
      if (preview.roles.length === 0) roles.append(el('span', { class: 'muted' }, 'No role yet'));
      card.append(roles);
      card.append(
        el(
          'p',
          { class: 'muted' },
          preview.usesLeft === null
            ? 'This invite has no use limit.'
            : `${preview.usesLeft} ${preview.usesLeft === 1 ? 'use' : 'uses'} left.`,
          preview.expiresAt === null ? ' It never expires.' : ` It expires at ${preview.expiresAt.slice(0, 10)}.`,
        ),
      );
    }
    card.append(
      el('p', { class: 'mono fingerprint' }, draft.fingerprint),
      el('p', { class: 'muted' }, 'Check it with whoever invited you.'),
      el(
        'div',
        { class: 'row' },
        button('Accept invite', () => {
          draft.pane = 'account';
          status = null;
          render();
        }, { kind: 'primary' }),
        button('Back', () => backToStart(), { kind: 'ghost' }),
      ),
    );
    return card;
  }

  /**
   * F1: the choice SP05 §4's join asks for when a local account of this Nod already holds the
   * email the join is about. The backend answered it before any host call, so the code is whole; the
   * select decides what the next submit does — the guild account (the local one becomes it) or the
   * local one (the join is cancelled and nothing is sent).
   */
  function collisionCard(): HTMLElement {
    const select = el(
      'select',
      { class: 'input', attrs: { name: 'join-choice' } },
      el('option', { attrs: { value: 'guild' } }, 'Use the guild account'),
      el('option', { attrs: { value: 'local' } }, 'Keep using the local account'),
    );
    select.value = draft.choice;
    select.addEventListener('change', () => {
      draft.choice = select.value === 'local' ? 'local' : 'guild';
    });
    const block = el(
      'section',
      { class: 'stack' },
      el(
        'p',
        {},
        `This Nod already has the account ${draft.collision === null ? '' : draft.collision.email} ` +
          `${draft.collision === null || draft.collision.name === '' ? '' : `(${draft.collision.name}) `}` +
          'saved on this machine. Which account should Nod use?',
      ),
      field('Account', select),
      el(
        'p',
        { class: 'muted' },
        'Use the guild account: your local account becomes the guild account, saved logins and ' +
          'roles come with you, and your password becomes the guild password. Keep using the local ' +
          'account: the join is cancelled and nothing is sent.',
      ),
    );
    block.hidden = draft.collision === null;
    return block;
  }

  /** Step 3 of the invite (and the account form of the other three paths). */
  function accountCard(): HTMLElement {
    const collision = collisionCard();
    const email = input('email', { type: 'email', autocomplete: 'username', value: draft.email });
    email.addEventListener('input', () => {
      draft.email = email.value;
      if (draft.collision !== null) {
        draft.collision = null;
        draft.choice = 'guild';
        collision.hidden = true;
      }
    });
    const password = input('password', {
      type: 'password',
      autocomplete: draft.mode === 'signin' ? 'current-password' : 'new-password',
    });
    password.addEventListener('input', () => {
      draft.password = password.value;
    });
    const fields: HTMLElement[] = [];
    if (draft.mode === 'join' || draft.mode === 'setup') {
      const name = input('name', { value: draft.name, autocomplete: 'name' });
      name.addEventListener('input', () => {
        draft.name = name.value;
      });
      fields.push(field('Name', name));
    }
    fields.push(field('Email', email));
    if (draft.mode === 'access' || draft.mode === 'setup' || (draft.mode === 'join' && draft.code === '')) {
      const code = input('code', { value: draft.code, placeholder: 'XXXX-…' });
      code.addEventListener('input', () => {
        draft.code = code.value;
      });
      fields.push(field('Code', code));
    }
    fields.push(field('Password', password));
    if (draft.mode !== 'signin') {
      const confirm = input('confirm', { type: 'password', autocomplete: 'new-password' });
      confirm.addEventListener('input', () => {
        draft.confirm = confirm.value;
      });
      fields.push(field('Confirm password', confirm));
    }

    const card = el(
      'section',
      { class: 'card stack' },
      el(
        'div',
        { class: 'row' },
        el('span', { class: 'chip' }, draft.guild === '' ? 'Guild' : draft.guild),
        el('span', { class: 'mono fingerprint' }, draft.fingerprint),
      ),
      el('h2', {}, draft.mode === 'signin' ? 'Your account' : 'Create your account'),
      collision,
      el('div', { class: 'row' }, ...fields),
    );
    if (draft.mode === 'signin') {
      card.append(el('p', { class: 'muted' }, 'The password you already set for this guild.'));
    } else {
      card.append(
        el(
          'p',
          { class: 'muted' },
          'Nod derives the keys on this machine; the password itself never reaches the host.',
        ),
      );
    }
    // F1: with a collision on screen the button is the one that carries the decision of the select.
    const label =
      draft.collision !== null
        ? 'Continue'
        : draft.mode === 'signin'
          ? 'Sign in'
          : draft.mode === 'setup'
            ? 'Create the guild'
            : draft.mode === 'access'
              ? 'Set my password'
              : 'Join the guild';
    card.append(
      el(
        'div',
        { class: 'row' },
        button(label, () => void submit(), { kind: 'primary' }),
        button('Back', () => backToStart(), { kind: 'ghost' }),
      ),
    );
    return card;
  }

  /** Back to the pane this path started from: the invite link, or the address form of its path. */
  function backToStart(): void {
    draft.pane = draft.mode === 'join' ? 'start' : 'address';
    draft.password = '';
    draft.confirm = '';
    draft.collision = null;
    draft.choice = 'guild';
    status = null;
    render();
  }

  /** One of the paths under the link: the address form of it, starting from nothing typed. */
  function openMode(mode: JoinStep): void {
    draft.mode = mode;
    draft.pane = mode === 'join' ? 'start' : 'address';
    draft.address = '';
    draft.expected = null;
    draft.guild = '';
    draft.fingerprint = '';
    draft.discovered = false;
    draft.code = '';
    draft.preview = null;
    draft.manual = false;
    draft.password = '';
    draft.confirm = '';
    draft.collision = null;
    draft.choice = 'guild';
    status = null;
    render();
  }

  /**
   * SP04 §1.3's discovery, with the fingerprint an invite (or the pinned host) fixed compared here,
   * before a password is typed. The backend compares it again — over the same discovery — when the
   * call goes out.
   */
  async function find(raw: string): Promise<boolean> {
    const address = raw.trim();
    if (address === '') {
      status = { kind: 'error', text: 'enter the address of the host' };
      return false;
    }
    try {
      const found = await call('host.discover', { address });
      draft.address = address;
      draft.guild = found.guild;
      draft.fingerprint = found.fingerprint;
      draft.discovered = draft.expected === null || sameFingerprint(draft.expected, found.fingerprint);
      if (!draft.discovered) {
        draft.guild = '';
        draft.fingerprint = '';
        status = { kind: 'error', text: refusal };
        return false;
      }
      return true;
    } catch (e) {
      draft.discovered = false;
      draft.guild = '';
      draft.fingerprint = '';
      status = { kind: 'error', text: errorMessage(e) };
      return false;
    }
  }

  /** The invite's card, from the code and the key the link carried (RF-59). */
  async function openInvite(): Promise<void> {
    try {
      draft.preview = await call('host.invitePreview', {
        address: draft.address,
        fingerprint: draft.expected ?? draft.fingerprint,
        code: draft.code,
      });
      draft.guild = draft.preview.guild;
      draft.pane = 'preview';
    } catch (e) {
      draft.preview = null;
      status = { kind: 'error', text: errorMessage(e) };
      draft.pane = 'start';
    }
    render();
  }

  /** The invite link of step 1: the link is what decides the address, the key and the code. */
  async function fromLink(): Promise<void> {
    status = null;
    const parsed = parseJoinLink(draft.link);
    if (parsed === null) {
      status = { kind: 'error', text: 'paste a nod://join link, or use an address and a code below' };
      render();
      return;
    }
    draft.mode = 'join';
    draft.address = parsed.address;
    draft.expected = parsed.fingerprint;
    draft.code = parsed.code ?? '';
    draft.discovered = false;
    draft.preview = null;
    if (!(await find(draft.address))) {
      render();
      return;
    }
    if (draft.code === '') {
      // A link without a code still names the guild; the account form asks for the code.
      draft.pane = 'account';
      render();
      return;
    }
    await openInvite();
  }

  /** The typed address, plus the code when the path carries one. */
  async function fromTyped(): Promise<void> {
    status = null;
    if (!(await find(draft.address))) {
      render();
      return;
    }
    if (draft.mode === 'signin') {
      draft.pane = 'account';
      render();
      return;
    }
    const code = draft.code.trim();
    if (code === '') {
      status = { kind: 'error', text: 'enter the code your admin gave you' };
      render();
      return;
    }
    const kind = codeKindOf(code);
    if (kind === null) {
      status = { kind: 'error', text: 'that is not a code — a code is 8, 16 or 24 characters' };
      render();
      return;
    }
    if (kind === 'invite') {
      await openInvite();
      return;
    }
    draft.mode = kind;
    draft.pane = 'account';
    render();
  }

  async function submit(): Promise<void> {
    status = null;
    // F1: the decision the select carries. Keeping the local account cancels the join here — nothing
    // is sent, and the code the person was given is untouched.
    if (draft.collision !== null && draft.choice === 'local') {
      draft.collision = null;
      draft.choice = 'guild';
      draft.password = '';
      draft.confirm = '';
      status = { kind: 'info', text: 'the join was cancelled — nothing was sent to the guild' };
      render();
      return;
    }
    const email = draft.email.trim();
    if (email === '') {
      status = { kind: 'error', text: 'enter your email' };
      render();
      return;
    }
    if (draft.password === '') {
      status = { kind: 'error', text: 'enter your password' };
      render();
      return;
    }
    const creates = draft.mode === 'join' || draft.mode === 'setup';
    if (creates && draft.password !== draft.confirm) {
      status = { kind: 'error', text: 'the two passwords are not the same' };
      render();
      return;
    }
    if (creates && draft.name.trim() === '') {
      status = { kind: 'error', text: 'enter your name — the guild shows it to the other members' };
      render();
      return;
    }
    if (draft.mode !== 'signin' && draft.code.trim() === '') {
      status = { kind: 'error', text: 'enter the code your admin gave you' };
      render();
      return;
    }
    // The fingerprint the host answered is what the backend re-checks; the invite's own one wins
    // when there was an invite (it is the same string, or the flow already refused above).
    const fingerprint = draft.expected ?? draft.fingerprint;
    const code = draft.code.trim();
    const password = draft.password;
    // F1: with the choice on screen this submit is the person's decision, and it is what the backend
    // reads as `adoptLocal`.
    const adoptLocal = draft.collision === null ? {} : { adoptLocal: true };
    let vaultWiped = false;
    try {
      const answer =
        draft.mode === 'signin'
          ? await call('host.signIn', {
              address: draft.address,
              fingerprint,
              email,
              password,
              ...adoptLocal,
            })
          : await call('host.activate', {
              address: draft.address,
              fingerprint,
              email,
              code,
              password,
              ...(creates ? { name: draft.name.trim() } : {}),
              ...adoptLocal,
            });
      if (answer.kind !== 'session') {
        // F1: the backend answered the choice — a local account of this Nod holds the email and
        // nothing was sent, so the code is whole. The password goes (the fields are rebuilt).
        draft.collision = answer;
        draft.choice = 'guild';
        draft.password = '';
        draft.confirm = '';
        status = { kind: 'info', text: 'nothing was sent to the guild yet' };
        render();
        return;
      }
      // SP02 §7/RF-43: the reset (or the activation over a local account with another `vaultKey`)
      // removed this machine's saved logins; the screen that replaces this one tells the person.
      vaultWiped = answer.wipedVault === true;
    } catch (e) {
      // A failed join keeps neither the password nor a half-written host.
      draft.password = '';
      draft.confirm = '';
      status = { kind: 'error', text: errorMessage(e) };
      render();
      return;
    }
    draft.password = '';
    draft.confirm = '';
    ctx.onJoined({ vaultWiped });
  }

  /** An address that came with the screen: the pinned host of a sign-in, or a pushed invite. */
  async function lookupPrefill(): Promise<void> {
    if (draft.address === '') {
      render();
      return;
    }
    if (!(await find(draft.address))) {
      render();
      return;
    }
    if (draft.mode === 'signin') {
      draft.pane = 'account';
      render();
      return;
    }
    if (draft.code !== '') {
      await openInvite();
      return;
    }
    draft.pane = 'account';
    render();
  }

  render();
  if (prefilled !== null) void lookupPrefill();

  return {
    setPrefill(invite: JoinInvite | null): void {
      if (invite === null) return;
      // An invite link is the invite's own path (RF-59): a flow open on another one — a sign-in of
      // the same host, say — goes back to the card the link opens.
      draft.mode = 'join';
      draft.address = invite.address;
      draft.expected = invite.fingerprint.trim() === '' ? null : invite.fingerprint;
      draft.code = invite.code ?? '';
      draft.link = joinLink(invite);
      draft.preview = null;
      draft.discovered = false;
      draft.pane = 'start';
      status = null;
      render();
      void lookupPrefill();
    },
  };
}
