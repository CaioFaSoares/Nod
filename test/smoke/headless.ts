// Headless members of the UI smoke (`test/smoke/ui.ts`): the parts of the world no screen is tested
// on, done from Bun straight against the host instead of a whole `tinyjs dev` launch each.
//
// The three phases this replaced (`person2-join`, `other-accept`, `person-second-machine`) had no
// check of their own — they only put the second member Q in the guild with a key pair, had Q accept
// the role share (so #35's holders list has two people), and re-keyed P from a "second machine" (so
// #30 shows a changed key). The host is what the admin's screens read afterwards, and it sees the
// same rows here: the routes, bodies and key derivation are the shared ones (`shared/host-api.ts`,
// `shared/auth.ts`, `shared/seal.ts`). What is NOT exercised here is a Nod backend on Q's side —
// the connected smoke (`test/smoke/connected.ts`) and `bun test` own that.
//
// The password and the codes live in this process' memory only; nothing is printed.
import { deriveKeys } from '../../shared/auth';
import { toBase64url } from '../../shared/encoding';
import {
  HOST_ROUTES,
  type ActivateRequest,
  type Device,
  type IncomingShare,
  type JoinRequest,
  type PublicKeys,
  type SaltResponse,
  type Snapshot,
  type TokenResponse,
} from '../../shared/host-api';
import { generateEd25519KeyPair, generateX25519KeyPair } from '../../shared/seal';

const DEVICE: Device = { name: 'UI smoke headless', os: 'macos', appVersion: '0.0.0-smoke' };

/** A signed-in member: the bearer and the person id the host answered. */
export interface HeadlessMember {
  token: string;
  personId: string;
}

async function request<T>(
  address: string,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body?: unknown,
  token?: string,
): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${address}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    // The host's error body is an English sentence without values from the request (SP03 §1).
    const text = await response.text().catch(() => '');
    throw new Error(`${method} ${path} answered ${response.status} ${text.slice(0, 160)}`);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** SP02 §1: the Nod chooses the salt at activation and only `authKey` travels. */
async function credentials(
  address: string,
  email: string,
  password: string,
): Promise<{ salt: string; authKey: string }> {
  const published = await request<SaltResponse>(address, 'POST', HOST_ROUTES.authSalt, { email });
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keys = await deriveKeys(password, salt, published.iterations);
  return { salt: toBase64url(salt), authKey: toBase64url(keys.authKey) };
}

/** SP06 §2: a fresh pair's public halves, which is what an activation (or a reset) publishes. */
async function publishKeys(address: string, member: HeadlessMember): Promise<void> {
  const [x, ed] = await Promise.all([generateX25519KeyPair(), generateEd25519KeyPair()]);
  const body: PublicKeys = {
    x25519Public: toBase64url(x.publicKey),
    ed25519Public: toBase64url(ed.publicKey),
  };
  await request<void>(address, 'PUT', HOST_ROUTES.keys, body, member.token);
}

/** RF-59: redeems a guild invite with the account this member chooses, then publishes a pair. */
export async function joinWithInvite(
  address: string,
  account: { email: string; name: string; password: string; code: string },
): Promise<HeadlessMember> {
  const body: JoinRequest = {
    email: account.email,
    name: account.name,
    code: account.code,
    device: DEVICE,
    ...(await credentials(address, account.email, account.password)),
  };
  const opened = await request<TokenResponse>(address, 'POST', HOST_ROUTES.authJoin, body);
  const member = { token: opened.token, personId: opened.personId };
  await publishKeys(address, member);
  return member;
}

/**
 * SP02 §7: an access code reissued by the admin, redeemed on "another machine" — a new salt and a
 * new pair, so the admin's pin table sees the person's key change (#30).
 */
export async function activateWithAccessCode(
  address: string,
  account: { email: string; password: string; code: string },
): Promise<HeadlessMember> {
  const body: ActivateRequest = {
    email: account.email,
    code: account.code,
    device: DEVICE,
    ...(await credentials(address, account.email, account.password)),
  };
  const opened = await request<TokenResponse>(address, 'POST', HOST_ROUTES.authActivate, body);
  const member = { token: opened.token, personId: opened.personId };
  await publishKeys(address, member);
  return member;
}

/**
 * SP06 §4: accepts every share waiting for this member. The host records the holder on accept and
 * never sees the content, so the sealed copy is not opened here — no screen of Q's is under test.
 */
export async function acceptAllShares(address: string, member: HeadlessMember): Promise<number> {
  const snapshot = await request<Snapshot>(address, 'GET', HOST_ROUTES.state, undefined, member.token);
  const waiting: IncomingShare[] = snapshot.incomingShares ?? [];
  for (const share of waiting) {
    await request<void>(
      address,
      'POST',
      HOST_ROUTES.shareAccept.replace(':id', encodeURIComponent(share.id)),
      undefined,
      member.token,
    );
  }
  return waiting.length;
}
