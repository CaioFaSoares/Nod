// Sealed credential shares: X25519 key agreement, HKDF-SHA256, AES-256-GCM and the Ed25519
// signature over the sealed body. Wire format: `docs/specs/SP06-credential-sharing.md` §3; the key
// pairs §2. Pure logic: only WebCrypto, TextEncoder and btoa/atob. No tjs, tiny or DOM.
// Signatures: docs/arquitetura.md §3.

/** First byte of the body and `v` of the payload (SP06 §3). A new format gets a new number. */
export const SEAL_VERSION = 1;
/** Raw X25519 / Ed25519 public key: 32 bytes, base64url on the wire. */
export const SEAL_PUBLIC_LENGTH = 32;
/** AES-256-GCM nonce (SP06 §3). */
export const SEAL_NONCE_LENGTH = 12;
/** Ed25519 signature appended to the body. */
export const SEAL_SIGNATURE_LENGTH = 64;

/** HKDF `info` of the seal (SP06 §3): changing it changes every sealed body. */
const SEAL_INFO = 'bond/share/v1';
// frozen protocol label (kept 'bond' on purpose: changing it changes every derived key)
/** AES-GCM tag length in bytes; the ciphertext of the body carries it (SP06 §1). */
const GCM_TAG_LENGTH = 16;
/** AES-256 key length: the HKDF output length of SP06 §3. */
const KEY_LENGTH = 32;

// Type note (TypeScript 6): a bare `Uint8Array` is `Uint8Array<ArrayBufferLike>`, which WebCrypto
// does not accept as `BufferSource`. Whoever PRODUCES bytes (decoding, `TextEncoder`,
// `getRandomValues`, `deriveBits`, `encrypt`, `sign`) returns `Uint8Array<ArrayBuffer>`; whoever
// only reads bytes accepts any `Uint8Array`.

export type SealScope = 'role' | 'org';
export type SealKind = 'send' | 'assign' | 'update';

/**
 * The plaintext of a sealed share (SP06 §3). `credentialId` and `to` are also the two halves of the
 * AAD, so a body sealed for one credential or one person only opens there.
 */
export interface SealPayload {
  v: typeof SEAL_VERSION;
  credentialId: string;
  toolId: string;
  toolOrigin: string;
  label: string;
  username: string;
  secret: string;
  scope: SealScope;
  from: string;
  to: string;
  kind: SealKind;
  /** ISO 8601 UTC with `Z` (`docs/specs/README.md`). */
  issuedAt: string;
}

/**
 * A key pair ready for storage: the raw 32-byte public key (SP06 §2 sends it to `PUT /v1/keys`) and
 * the PKCS#8 private key (SP06 §2 encrypts it as a `bv1.` vault value). Not extractable again: the
 * bytes are what the caller keeps.
 */
export interface SealKeyPair {
  publicKey: Uint8Array<ArrayBuffer>;
  privateKey: Uint8Array<ArrayBuffer>;
}

/** Test vectors only: pins the ephemeral pair and the nonce so `seal` is reproducible byte for byte. */
export interface SealOptions {
  ephemeral?: SealKeyPair;
  nonce?: Uint8Array<ArrayBuffer>;
}

/**
 * What the opener must already know (SP06 §3): its own pair — the private key decrypts and the
 * public key is the second half of the HKDF salt — the sender's **pinned** Ed25519 key, and the
 * `credentialId` and `to` that make the AAD.
 */
export interface OpenOptions {
  recipientPrivateKey: Uint8Array<ArrayBuffer>;
  recipientPublicKey: Uint8Array<ArrayBuffer>;
  senderPublicKey: Uint8Array<ArrayBuffer>;
  credentialId: string;
  to: string;
}

// ------------------------------------------------------------- encoding (helpers)

function bytesToBinary(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return binary;
}

function binaryToBytes(binary: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** base64url without padding (`docs/specs/README.md`): the only wire encoding of a sealed share. */
function bytesToBase64url(bytes: Uint8Array): string {
  return btoa(bytesToBinary(bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** `null` on anything that is not base64url without padding, so `open` declines instead of throwing. */
function base64urlToBytes(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  try {
    return binaryToBytes(atob(padded));
  } catch {
    return null;
  }
}

function concatBytes(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  let length = 0;
  for (const part of parts) length += part.length;
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

// ------------------------------------------------------------- primitives

/** HMAC-SHA256(key, message) → 32 bytes; the only primitive HKDF is built on (SP06 §1). */
async function hmacSha256(
  key: Uint8Array<ArrayBuffer>,
  message: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const imported = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', imported, message));
}

/**
 * HKDF-SHA256 (RFC 5869) over `hmacSha256`, written here so the seal does not depend on `subtle`
 * exposing HKDF (SP06 §1). `salt` and `info` are mandatory at every call site.
 */
async function hkdfSha256(
  ikm: Uint8Array<ArrayBuffer>,
  salt: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
  length: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const prk = await hmacSha256(salt, ikm);
  const blocks: Uint8Array[] = [];
  let previous: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  let counter = 1;
  let produced = 0;
  while (produced < length) {
    previous = await hmacSha256(prk, concatBytes([previous, info, new Uint8Array([counter])]));
    blocks.push(previous);
    produced += previous.length;
    counter++;
  }
  return concatBytes(blocks).slice(0, length);
}

export async function importX25519PublicKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, { name: 'X25519' }, true, []);
}

export async function importX25519PrivateKey(pkcs8: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey('pkcs8', pkcs8, { name: 'X25519' }, false, ['deriveBits']);
}

export async function importEd25519PublicKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, { name: 'Ed25519' }, true, ['verify']);
}

export async function importEd25519PrivateKey(pkcs8: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
}

/** X25519(private, public) → 32 bytes: the `shared` of SP06 §3. */
async function sharedSecret(
  privateKey: CryptoKey,
  publicKey: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const peer = await importX25519PublicKey(publicKey);
  const bits = await crypto.subtle.deriveBits({ name: 'X25519', public: peer }, privateKey, 256);
  return new Uint8Array(bits);
}

// ------------------------------------------------------------- key pairs (SP06 §2)

/** One X25519 pair for receiving, exported the way SP06 §2 stores it (raw public, PKCS#8 private). */
export async function generateX25519KeyPair(): Promise<SealKeyPair> {
  const pair = (await crypto.subtle.generateKey({ name: 'X25519' }, true, [
    'deriveBits',
  ])) as CryptoKeyPair;
  return {
    publicKey: new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)),
    privateKey: new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey)),
  };
}

/** One Ed25519 pair for signing, exported the same way. */
export async function generateEd25519KeyPair(): Promise<SealKeyPair> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  return {
    publicKey: new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)),
    privateKey: new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey)),
  };
}

// ------------------------------------------------------------- signature (SP06 §3)

/** Ed25519 signature over any bytes; inside the seal it covers the whole body. */
export async function sign(
  message: Uint8Array<ArrayBuffer>,
  privateKey: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await importEd25519PrivateKey(privateKey);
  return new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, message));
}

/** `false` on a bad signature, a wrong key or bytes the runtime refuses: the caller declines. */
export async function verify(
  signature: Uint8Array<ArrayBuffer>,
  message: Uint8Array<ArrayBuffer>,
  publicKey: Uint8Array<ArrayBuffer>,
): Promise<boolean> {
  try {
    const key = await importEd25519PublicKey(publicKey);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, signature, message);
  } catch {
    return false;
  }
}

// ------------------------------------------------------------- seal and open (SP06 §3)

/**
 * `seal(payload, recipientX25519Public, senderEd25519Private)` → the `sealed` string of SP06 §3
 * (`base64url(body || sig)`), exactly the value `POST /v1/shares` carries per recipient.
 *
 * A fresh ephemeral X25519 pair per call, so two seals of the same payload differ; the signature
 * makes a modified body or a different sender key fail at `open`.
 */
export async function seal(
  payload: SealPayload,
  recipientPublicKey: Uint8Array<ArrayBuffer>,
  senderPrivateKey: Uint8Array<ArrayBuffer>,
  options: SealOptions = {},
): Promise<string> {
  const ephemeral = options.ephemeral ?? (await generateX25519KeyPair());
  const ephemeralPrivate = await importX25519PrivateKey(ephemeral.privateKey);
  const shared = await sharedSecret(ephemeralPrivate, recipientPublicKey);
  const key = await hkdfSha256(
    shared,
    concatBytes([ephemeral.publicKey, recipientPublicKey]),
    new TextEncoder().encode(SEAL_INFO),
    KEY_LENGTH,
  );
  const nonce = options.nonce ?? crypto.getRandomValues(new Uint8Array(SEAL_NONCE_LENGTH));
  const cipher = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt']);
  // The plaintext is the payload in the key order SP06 §3 writes: a pinned vector hinges on it.
  const plaintext = new TextEncoder().encode(
    JSON.stringify({
      v: payload.v,
      credentialId: payload.credentialId,
      toolId: payload.toolId,
      toolOrigin: payload.toolOrigin,
      label: payload.label,
      username: payload.username,
      secret: payload.secret,
      scope: payload.scope,
      from: payload.from,
      to: payload.to,
      kind: payload.kind,
      issuedAt: payload.issuedAt,
    }),
  );
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: nonce,
        // AAD = UTF-8 of `credentialId|to` (SP06 §3): it binds the body to one credential and one person.
        additionalData: new TextEncoder().encode(`${payload.credentialId}|${payload.to}`),
      },
      cipher,
      plaintext,
    ),
  );
  const body = concatBytes([
    new Uint8Array([SEAL_VERSION]),
    ephemeral.publicKey,
    nonce,
    ciphertext,
  ]);
  return bytesToBase64url(concatBytes([body, await sign(body, senderPrivateKey)]));
}

function isSealPayload(value: unknown): value is SealPayload {
  if (typeof value !== 'object' || value === null) return false;
  const payload = value as Record<string, unknown>;
  if (payload.v !== SEAL_VERSION) return false;
  const strings = [
    'credentialId',
    'toolId',
    'toolOrigin',
    'label',
    'username',
    'secret',
    'from',
    'to',
    'issuedAt',
  ];
  if (!strings.every((field) => typeof payload[field] === 'string')) return false;
  if (payload.scope !== 'role' && payload.scope !== 'org') return false;
  return payload.kind === 'send' || payload.kind === 'assign' || payload.kind === 'update';
}

/**
 * `open(sealed, options)` → the payload, or `null` when the share is not valid: bad base64url, a
 * body too short to hold a signature, a signature that does not verify against the **pinned**
 * sender key, a version this build does not know, a GCM tag that does not match the ciphertext or
 * the AAD, a payload that is not SP06 §3's, or a payload addressed to somebody else. One outcome
 * only, so the caller declines with a single reason (`invalid share`, SP06 §3).
 *
 * The checks that need host metadata — `toolId`, `kind` and the tool's visibility and origin
 * (SP06 §3 steps 4 and 5) — stay with the caller, against the payload this returns.
 */
export async function open(sealed: string, options: OpenOptions): Promise<SealPayload | null> {
  const bytes = base64urlToBytes(sealed);
  if (bytes === null) return null;
  const bodyLength = bytes.length - SEAL_SIGNATURE_LENGTH;
  if (bodyLength < 1 + SEAL_PUBLIC_LENGTH + SEAL_NONCE_LENGTH + GCM_TAG_LENGTH) return null;
  const body = bytes.slice(0, bodyLength);
  if (!(await verify(bytes.slice(bodyLength), body, options.senderPublicKey))) return null;
  if (body[0] !== SEAL_VERSION) return null;

  const ephemeralPublic = body.slice(1, 1 + SEAL_PUBLIC_LENGTH);
  const nonce = body.slice(1 + SEAL_PUBLIC_LENGTH, 1 + SEAL_PUBLIC_LENGTH + SEAL_NONCE_LENGTH);
  const ciphertext = body.slice(1 + SEAL_PUBLIC_LENGTH + SEAL_NONCE_LENGTH);

  let plaintext: Uint8Array<ArrayBuffer>;
  try {
    const privateKey = await importX25519PrivateKey(options.recipientPrivateKey);
    const shared = await sharedSecret(privateKey, ephemeralPublic);
    const key = await hkdfSha256(
      shared,
      concatBytes([ephemeralPublic, options.recipientPublicKey]),
      new TextEncoder().encode(SEAL_INFO),
      KEY_LENGTH,
    );
    const cipher = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['decrypt']);
    plaintext = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: nonce,
          additionalData: new TextEncoder().encode(`${options.credentialId}|${options.to}`),
        },
        cipher,
        ciphertext,
      ),
    );
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    return null;
  }
  if (!isSealPayload(parsed)) return null;
  return parsed.to === options.to ? parsed : null;
}
