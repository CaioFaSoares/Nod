// The Bond's side of the host connection: discovery, the pin, the bearer, the signed snapshot and
// the one typed error every failure becomes (SP04 §1–§2, SP02 §5; `backend/context.md`).
//
// The runtime arrives as parameters — `fetch` and the keychain (`app.secrets`) — so this same file
// runs under txiki.js (`backend/main.ts` wires the globals) and under `bun test`. It imports no
// `tjs`, no `tiny` and no `bun:*`, and it reads or writes no database: the caller owns the `host`
// row and the state (`backend/sync.ts`, B4/B10).
//
// RF-30 by construction: `createHostClient` touches no network. `discover` talks to the address the
// person typed (or the invite carried) and `connect` demands the pinned key of a `host` row, so
// without a host the only thing that can reach a host is a person-initiated discovery.
//
// Secret rule (`AGENTS.md`): the bearer lives in the system keychain under
// `bond.host.<kid>.<personId>` (SP02 §5) and is never named in a message, an error or a log of this
// file.

import { originOf } from '../shared/catalog';
import { fromBase64url } from '../shared/encoding';
import {
  CODE_ALPHABET,
  HOST_ROUTES,
  SNAPSHOT_SIGNATURE_HEADER,
  formatCode,
} from '../shared/host-api';
import { verify } from '../shared/seal';
import type { Discovery, SignInMethod, Snapshot, SnapshotSignature } from '../shared/host-api';
import type { Id, SecretStore } from '../shared/types';

// ---------------------------------------------------------------- constants

/** Raw Ed25519 public key: 32 bytes, base64url on the wire (SP04 §1, SP06 §2). */
const PUBLIC_KEY_BYTES = 32;

/** SP04 §1.1: the fingerprint is the first 10 bytes of the digest — 16 Crockford characters. */
const FINGERPRINT_BYTES = 10;

/** SP04 §2 asks for `If-None-Match` and answers `ETag`; only the answer side is in the contract. */
const IF_NONE_MATCH_HEADER = 'If-None-Match';

/**
 * How long one request may take. The runtime's `fetch` takes no `AbortSignal`
 * (`TinyFetchInit`, `backend/tiny.d.ts`), so the deadline is a timer racing the promise — the same
 * shape `backend/probe-net.ts` uses.
 */
export const REQUEST_TIMEOUT_MS = 10_000;

/** SP04 §1: any `kid`/key that is not the pinned one, on a discovery or on a snapshot. */
export const HOST_KEY_CHANGED = 'host key changed — remove and add the host again';

/** SP04 §1.3: the host does not carry the key the invite's `fp` named. */
export const HOST_KEY_MISMATCH = 'host key does not match the invite';

/** 401: the session was revoked or expired (SP02 §5, SP04 §3, RF-39). */
const HOST_SIGNED_OUT = 'signed out';
/** 429 (SP02 §5). */
const HOST_RATE_LIMITED = 'too many attempts';
/** Any other 4xx: the host refused the request. */
const HOST_REFUSED = 'the host refused the request';
/** 5xx. */
const HOST_FAILED = 'the host failed to answer';
/** `fetch` rejected, or the deadline passed: the host was not reached (SP04 §3 keeps the cache). */
const HOST_OFFLINE = 'could not reach the host';
/** An answer that is not the document the route defines. */
const HOST_NOT_A_HOST = 'the host is not a Bond host';
/** SP04 §2: the bytes are not the bytes the pinned key signed. */
const HOST_UNSIGNED = 'the snapshot is not signed by the host key';
/** SP04 §2: an `issuedAt` older than the last accepted one. */
const HOST_STALE = 'the host answered an older snapshot than the last accepted one';
/** SP02 §5: the bearer could not be stored, so the sign-in cannot be kept. */
const HOST_KEYCHAIN_REFUSED = 'the system keychain refused the token';

/** The methods the Bond sends (SP03 §2: `GET`/`POST`, the personal `PUT`/`DELETE`, admin `PATCH`). */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** What `fetch` looks like from here: the runtime's global, injected (`backend/probe-net.ts`). */
export type HostFetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Why a host call failed: what the caller switches on, instead of a message (`backend/sync.ts`,
 * B4/B10, reacts to `signed-out` and `offline` by name — SP04 §3).
 */
export type HostFailure =
  | 'offline' // `fetch` rejected or the deadline passed
  | 'signed-out' // 401: revoked or expired session
  | 'rate-limited' // 429
  | 'refused' // another 4xx
  | 'server' // 5xx
  | 'key-changed' // the answer is not signed by the pinned key (SP04 §1)
  | 'key-mismatch' // discovery does not match the invite's `fp` (SP04 §1.3)
  | 'signature' // the snapshot's bytes are not the bytes that were signed (SP04 §2)
  | 'stale' // an `issuedAt` older than the last accepted one (SP04 §2)
  | 'invalid' // the answer is not the document the route defines
  | 'keychain'; // the keychain refused the bearer (SP02 §5)

/**
 * One refusal of a host call. `message` is English, carries nothing from the request or from the
 * host's body, and is what Settings → Hosts can show as `host.last_error` (SP04 §3).
 */
export class HostError extends Error {
  /** Which refusal this is. */
  readonly failure: HostFailure;
  /** The HTTP status when there was one; `null` for a network failure or a local refusal. */
  readonly status: number | null;

  constructor(failure: HostFailure, message: string, status: number | null = null) {
    super(message);
    this.name = 'HostError';
    this.failure = failure;
    this.status = status;
  }
}

/** Everything the client needs from its runtime. */
export interface HostClientDeps {
  /** The runtime's `fetch`: txiki.js's global in the app, Bun's in the tests. */
  fetch: HostFetch;
  /** `app.secrets` at runtime (SP02 §5): the bearer goes here and nowhere else. */
  keychain: SecretStore;
  /** The clock, injected the way `iterations` is in `backend/vault.ts`; the deadline is measured on it. */
  now?: () => Date;
  /** The ceiling of one request; `REQUEST_TIMEOUT_MS` unless a caller (or a test) tightens it. */
  timeoutMs?: number;
}

/** The pinned half of the `host` row, as the client needs it (SP05 §2). */
export interface PinnedHost {
  /** Canonical address: `https`, or `http` on loopback in dev (SP04 §1.1). */
  address: string;
  /** The id of the pinned key pair (SP01 §1). */
  kid: string;
  /** Pinned Ed25519 public key, base64url raw 32 bytes. */
  publicKey: string;
  /** The host's person id; with `kid` it names the keychain item of the bearer (SP02 §5). */
  personId: Id;
}

/** What `discover` answers (SP04 §1): what the screen shows and what step 5 pins. */
export interface HostDiscovery {
  /** Canonical address, as it must be pinned: no path, no user info (SP04 §1.1). */
  address: string;
  /** SP04 §1.1's fingerprint of the key below — recomputed here, never trusted from the wire. */
  fingerprint: string;
  /** Exactly what step 5 writes into the `host` row (SP05 §2). */
  pin: { kid: string; ed25519Public: string };
  /** The host's own document, shape-checked (SP04 §1). */
  document: Discovery;
}

/** What a discovery has to match, when the caller knows something already. */
export interface DiscoveryExpectation {
  /** The invite's `fp` (SP04 §1.3): a mismatch is `host key does not match the invite`. */
  fingerprint?: string | null;
  /**
   * The key a host that is already added was pinned with (SP04 §1): any difference — the `kid` or
   * the key — is `host key changed — remove and add the host again`. Takes precedence over
   * `fingerprint`.
   */
  pinned?: { kid: string; ed25519Public: string };
}

/**
 * `GET /v1/state` (SP04 §2). `notModified` is the `304`; otherwise the body is the one the pinned
 * key signed, verbatim, and `snapshot.version`/`snapshot.issuedAt` are the fields the caller stores
 * in the `host` row (the `ETag` itself is not signed, so it is never the source).
 */
export type SnapshotResult =
  | { notModified: true }
  | { notModified: false; snapshot: Snapshot; raw: string };

/** A client bound to one pinned host: the bearer and every call past the pin. */
export interface HostConnection {
  /** The host this connection was built for, as it was pinned. */
  readonly host: PinnedHost;
  /** The keychain item of the bearer: `bond.host.<kid>.<personId>` (SP02 §5). */
  tokenKey(): string;
  /** Stores the token the host returned once (SP02 §5). The token is passed through, never kept. */
  saveToken(token: string): Promise<void>;
  /** Forgets it: sign-out, a `401`, or the host being removed. */
  forgetToken(): Promise<void>;
  /** One call with the bearer, its answer typed by the caller (SP03 §2). */
  request<T>(method: HttpMethod, path: string, body?: unknown): Promise<T>;
  /** The signed snapshot; `version` is the last accepted one (the `ETag` of SP04 §2). */
  snapshot(options?: { version?: string | null; notOlderThan?: string | null }): Promise<SnapshotResult>;
}

/** The whole client: what runs before a pin, and what runs with one. */
export interface HostClient {
  /** SP04 §1 steps 1–4. Nothing is written: the caller shows the guild and the fingerprint. */
  discover(address: string, expect?: DiscoveryExpectation): Promise<HostDiscovery>;
  /** SP04 §1 step 5 onward, for a caller that already holds the `host` row (RF-30). */
  connect(host: PinnedHost): HostConnection;
}

// ---------------------------------------------------------------- fingerprint (SP04 §1.1)

/**
 * SP04 §1.1: SHA-256 of the raw public key, its first 10 bytes in Crockford base32, grouped
 * `XXXX-XXXX-XXXX-XXXX` — the string the person reads out and the invite carries.
 *
 * Finding for the coordinator: the host computes this same string for `Discovery.fingerprint`
 * (H6), and `shared/host-api.ts` keeps its base32 encoder private, so the two sides can drift
 * apart. The home for this function is that file, beside `CODE_ALPHABET`; `shared/` is not this
 * slice's to edit, so the copy lives here until the coordinator moves it.
 */
export async function fingerprintOf(rawPublicKey: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', rawPublicKey));
  let out = '';
  let buffer = 0;
  let bits = 0;
  // 5 bits per character, most significant first; 10 bytes are 80 bits, exactly 16 characters.
  for (const byte of digest.subarray(0, FINGERPRINT_BYTES)) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CODE_ALPHABET[(buffer >>> bits) & 31];
    }
  }
  return formatCode(out);
}

/** Case, spaces and grouping are presentation: the same key typed two ways is one string. */
function normalizeFingerprint(text: string): string {
  return text.toUpperCase().replaceAll('-', '').replaceAll(' ', '');
}

// ---------------------------------------------------------------- client

export function createHostClient(deps: HostClientDeps): HostClient {
  const now = deps.now ?? (() => new Date());
  const timeoutMs = deps.timeoutMs ?? REQUEST_TIMEOUT_MS;

  /** Runs `work` under `timeoutMs`; the timer loses its race and the work is abandoned. */
  async function withDeadline<T>(work: () => Promise<T>): Promise<T> {
    const deadline = now().getTime() + timeoutMs;
    let expire: (error: Error) => void = () => undefined;
    const expired = new Promise<never>((_resolve, reject) => {
      expire = reject;
    });
    const timer = setTimeout(() => expire(new Error('timed out')), Math.max(0, deadline - now().getTime()));
    try {
      return await Promise.race([work(), expired]);
    } finally {
      clearTimeout(timer);
    }
  }

  function notAHost(): HostError {
    return new HostError('invalid', HOST_NOT_A_HOST);
  }

  /** SP04 §2: no signature this Bond can check, whatever the reason (absent, malformed, wrong key). */
  function unsigned(): HostError {
    return new HostError('signature', HOST_UNSIGNED);
  }

  /** A pinned or discovered public key: base64url, exactly the 32 raw bytes of SP04 §1. */
  function publicKeyBytes(text: string): Uint8Array<ArrayBuffer> {
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = fromBase64url(text);
    } catch {
      throw notAHost();
    }
    if (bytes.length !== PUBLIC_KEY_BYTES) throw notAHost();
    return bytes;
  }

  /** SP04 §2's answer for a status that is a failure, with the host's own body left unread. */
  function failureOf(status: number): HostError {
    if (status === 401) return new HostError('signed-out', HOST_SIGNED_OUT, status);
    if (status === 429) return new HostError('rate-limited', HOST_RATE_LIMITED, status);
    if (status >= 500) return new HostError('server', HOST_FAILED, status);
    return new HostError('refused', HOST_REFUSED, status);
  }

  async function send(
    method: HttpMethod,
    url: string,
    body: unknown,
    token: string | null,
    extra: Record<string, string> = {},
  ): Promise<Response> {
    const headers: Record<string, string> = { accept: 'application/json', ...extra };
    if (body !== undefined) headers['content-type'] = 'application/json';
    // SP02 §5: `Authorization: Bearer <token>`, read from the keychain by the caller of `send`. No
    // token (not signed in yet, or a public route): no header at all — the host answers 401 where
    // one is needed, and that 401 becomes the `signed-out` failure.
    if (token !== null && token !== '') headers.authorization = `Bearer ${token}`;

    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);

    let response: Response;
    try {
      response = await withDeadline(() => deps.fetch(url, init));
    } catch {
      // A rejected fetch, an expired deadline and a runtime-level failure are one thing to the
      // caller: the host was not reached (SP04 §3 keeps the cache and retries).
      throw new HostError('offline', HOST_OFFLINE);
    }
    // No body is read on a failure: the host's message is the host's, and echoing it would put a
    // string the Bond did not write into an error, a log or an event (`AGENTS.md`).
    if (!response.ok && response.status !== 304) throw failureOf(response.status);
    return response;
  }

  /** The whole body, or `offline`: a body that cannot be read is a call that did not complete. */
  async function readBody(response: Response): Promise<Uint8Array<ArrayBuffer>> {
    try {
      return new Uint8Array(await response.arrayBuffer());
    } catch {
      throw new HostError('offline', HOST_OFFLINE);
    }
  }

  /** JSON, or the `invalid` failure: a body that is not JSON is not the document of any route. */
  function parseJson(raw: string): unknown {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      throw notAHost();
    }
  }

  async function readJson(response: Response): Promise<unknown> {
    return parseJson(new TextDecoder().decode(await readBody(response)));
  }

  function isSignInMethod(value: unknown): value is SignInMethod {
    return value === 'access-code' || value === 'email';
  }

  /** SP04 §1's `Discovery`, shape-checked: the fields the Bond reads before it pins anything. */
  function readDiscovery(value: unknown): Discovery {
    if (typeof value !== 'object' || value === null) throw notAHost();
    const document = value as Partial<Discovery>;
    const key = document.key as { kid?: unknown; ed25519Public?: unknown } | undefined;
    const ok =
      document.api === 1 &&
      typeof document.guild === 'string' &&
      document.guild !== '' &&
      typeof key === 'object' &&
      key !== null &&
      typeof key.kid === 'string' &&
      key.kid !== '' &&
      typeof key.ed25519Public === 'string' &&
      typeof document.fingerprint === 'string' &&
      typeof document.minAppVersion === 'string' &&
      Array.isArray(document.signIn) &&
      document.signIn.every(isSignInMethod);
    if (!ok) throw notAHost();
    return document as Discovery;
  }

  /**
   * Only what this client itself reads: the rest of the body is `shared/host-merge.ts`'s to check
   * when it turns a snapshot into rows (B5). A second full validator here would be a second home
   * for the same shape, free to drift from that one.
   */
  function readSnapshot(value: unknown): Snapshot {
    if (typeof value !== 'object' || value === null) throw notAHost();
    const snapshot = value as Partial<Snapshot>;
    if (snapshot.api !== 1 || typeof snapshot.version !== 'string' || typeof snapshot.issuedAt !== 'string') {
      throw notAHost();
    }
    return snapshot as Snapshot;
  }

  /** SP04 §2's `Bond-Signature: kid=<kid>; sig=<base64url>`. */
  function readSignature(header: string | null): SnapshotSignature {
    if (header === null) throw unsigned();
    let kid: string | null = null;
    let sig: string | null = null;
    for (const part of header.split(';')) {
      const separator = part.indexOf('=');
      if (separator === -1) continue;
      const name = part.slice(0, separator).trim();
      const value = part.slice(separator + 1).trim();
      if (value === '') continue;
      if (name === 'kid') kid = value;
      if (name === 'sig') sig = value;
    }
    if (kid === null || sig === null) throw unsigned();
    return { kid, sig };
  }

  /** The signature bytes, or the `signature` failure: a `sig` that is not base64url is not a signature. */
  function signatureBytes(text: string): Uint8Array<ArrayBuffer> {
    try {
      return fromBase64url(text);
    } catch {
      throw unsigned();
    }
  }

  async function discover(address: string, expect: DiscoveryExpectation = {}): Promise<HostDiscovery> {
    // SP04 §1.1: normalization is `originOf`'s — `https`, or `http` on loopback in dev, no path and
    // no user info. Plain `http` to a real host throws `address must be https` here, before a byte
    // leaves the machine, and the caller stores nothing.
    const canonical = originOf(address);
    const response = await send('GET', `${canonical}${HOST_ROUTES.discovery}`, undefined, null);
    const document = readDiscovery(await readJson(response));
    const publicKey = publicKeyBytes(document.key.ed25519Public);
    const fingerprint = await fingerprintOf(publicKey);
    // The host computes the same string; one that disagrees with itself is not a Bond host. Both
    // sides are normalized first: grouping and case are presentation, not identity.
    if (normalizeFingerprint(fingerprint) !== normalizeFingerprint(document.fingerprint)) throw notAHost();

    if (expect.pinned !== undefined) {
      // SP04 §1: from the moment a host is added, another key is never accepted silently.
      const pinned = await fingerprintOf(publicKeyBytes(expect.pinned.ed25519Public));
      if (
        expect.pinned.kid !== document.key.kid ||
        normalizeFingerprint(pinned) !== normalizeFingerprint(fingerprint)
      ) {
        throw new HostError('key-changed', HOST_KEY_CHANGED);
      }
    } else if (expect.fingerprint !== undefined && expect.fingerprint !== null) {
      // SP04 §1.3: the invite carried a fingerprint, and it is not this key's.
      if (normalizeFingerprint(expect.fingerprint) !== normalizeFingerprint(fingerprint)) {
        throw new HostError('key-mismatch', HOST_KEY_MISMATCH);
      }
    }

    return {
      address: canonical,
      fingerprint,
      pin: { kid: document.key.kid, ed25519Public: document.key.ed25519Public },
      document,
    };
  }

  function connect(host: PinnedHost): HostConnection {
    // SP04 §1.1 holds for every call, not only for discovery: a `host` row edited by hand cannot
    // make the Bond talk plain `http` to a real host.
    const address = originOf(host.address);
    const publicKey = publicKeyBytes(host.publicKey);
    // SP02 §5's keychain item: read on every call, passed straight to the header, never logged,
    // never returned and never written anywhere else.
    const key = hostTokenKey(host.kid, host.personId);

    async function request<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
      const response = await send(method, `${address}${path}`, body, await deps.keychain.get(key));
      // 204 is the answer of the routes that answer nothing (logout, the deletes, favorites).
      if (response.status === 204) return undefined as T;
      return (await readJson(response)) as T;
    }

    async function snapshot(
      options: { version?: string | null; notOlderThan?: string | null } = {},
    ): Promise<SnapshotResult> {
      const extra: Record<string, string> = {};
      // SP04 §2 writes the `ETag` as `"<version>"`: with the last accepted version the host answers
      // 304 instead of the body, and nothing is read from the network.
      if (options.version !== undefined && options.version !== null) {
        extra[IF_NONE_MATCH_HEADER] = `"${options.version}"`;
      }
      const response = await send(
        'GET',
        `${address}${HOST_ROUTES.state}`,
        undefined,
        await deps.keychain.get(key),
        extra,
      );
      if (response.status === 304) return { notModified: true };

      // SP04 §2: the bytes as received, verified whole, before a single character is parsed.
      const bytes = await readBody(response);
      const signature = readSignature(response.headers.get(SNAPSHOT_SIGNATURE_HEADER));
      if (signature.kid !== host.kid) throw new HostError('key-changed', HOST_KEY_CHANGED);
      if (!(await verify(signatureBytes(signature.sig), bytes, publicKey))) throw unsigned();

      const raw = new TextDecoder().decode(bytes);
      const verified = readSnapshot(parseJson(raw));
      if (
        options.notOlderThan !== undefined &&
        options.notOlderThan !== null &&
        verified.issuedAt < options.notOlderThan
      ) {
        throw new HostError('stale', HOST_STALE);
      }
      return { notModified: false, snapshot: verified, raw };
    }

    return {
      host,
      tokenKey: () => key,
      async saveToken(token: string): Promise<void> {
        if (!(await deps.keychain.set(key, token))) {
          throw new HostError('keychain', HOST_KEYCHAIN_REFUSED);
        }
      },
      async forgetToken(): Promise<void> {
        await deps.keychain.delete(key);
      },
      request,
      snapshot,
    };
  }

  return { discover, connect };
}

/** The keychain item of the bearer (SP02 §5): one per host key and per host person. */
export function hostTokenKey(kid: string, personId: Id): string {
  return `bond.host.${kid}.${personId}`;
}
