// SP04 §1.3's join link, `nod://join?host=<address>&fp=<fingerprint>[&code=<code>]`, built and read
// in one place: the backend reads the link the OS forwards (`onOpenUrl`), the page reads a link the
// person pastes into the join dialog, and the admin's invite card builds one (0.5.0, RF-59).
//
// Pure (`shared/context.md`): only `URL` and `URLSearchParams`, which every runtime of this repo has.
// Nothing here is a secret by itself; a code inside a link is the person's own and is never logged.

import type { JoinInvite } from './types';

/**
 * Reads a join link. Every other text — another scheme, another action, a missing `host` or `fp` —
 * answers `null`. `nod://join` puts the action in the authority; a link typed as `nod:join` has it
 * in the path. Surrounding whitespace (a pasted link) is ignored.
 */
export function parseJoinLink(url: string): JoinInvite | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'nod:') return null;
  const action = parsed.host !== '' ? parsed.host : parsed.pathname.replaceAll('/', '');
  if (action.toLowerCase() !== 'join') return null;
  const address = parsed.searchParams.get('host');
  const fingerprint = parsed.searchParams.get('fp');
  if (address === null || address.trim() === '') return null;
  if (fingerprint === null || fingerprint.trim() === '') return null;
  const code = parsed.searchParams.get('code');
  return { address, fingerprint, code: code === null || code.trim() === '' ? null : code };
}

/** Builds the link `parseJoinLink` reads back; the invite card of Settings → People shows it. */
export function joinLink(invite: JoinInvite): string {
  const params = new URLSearchParams({ host: invite.address, fp: invite.fingerprint });
  if (invite.code !== null) params.set('code', invite.code);
  return `nod://join?${params.toString()}`;
}
