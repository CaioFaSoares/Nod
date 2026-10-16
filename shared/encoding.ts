// Byte encodings and the one hash every side needs: base64url without padding, hex and SHA-256.
// `docs/specs/README.md` fixes the rule — binary travels as base64url without padding, hex only for
// the SHA-256 digests stored as lookup keys (session tokens, code hashes, key ids).
//
// Pure, like every other module of `shared/`: the language, `crypto.subtle`, `crypto.getRandomValues`
// and `btoa`. No `tjs`, no `tiny`, no DOM, no `bun:*` — the same bytes in the host (Bun) and in the
// Bond backend (txiki.js).
//
// Decoding is written out instead of leaning on `atob`: the two runtimes' decoders differ on
// non-canonical input (trailing bits that are not zero), and one contract cannot answer two ways.
// Re-encoding, which is unambiguous, stays `btoa`.
//
// Type note (TypeScript 6): a bare `Uint8Array` is `Uint8Array<ArrayBufferLike>`, which WebCrypto
// does not accept as `BufferSource`. Whoever PRODUCES bytes (decoding, `TextEncoder`, `getRandomValues`,
// `digest`) returns `Uint8Array<ArrayBuffer>`; whoever only reads bytes accepts any `Uint8Array`.

/** The base64url alphabet of RFC 4648 §5: the standard one with `+`/`/` replaced by `-`/`_`. */
const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Anything else — including the standard `+`/`/` and `=` — is not base64url. */
const BASE64URL_TEXT = /^[A-Za-z0-9_-]*$/;

/** Lowercase and uppercase alike: `fromHex` answers bytes, and a digest is compared as bytes. */
const HEX_TEXT = /^[0-9a-fA-F]*$/;

/**
 * base64url without padding: `''` for no bytes, and never `=`. The output is the canonical encoding
 * of the input, so `fromBase64url(toBase64url(bytes))` is the identity.
 */
export function toBase64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/**
 * The bytes of a base64url string, or `invalid base64url`: a character outside the alphabet, a
 * length that cannot hold whole bytes (`length % 4 === 1`), padding, or trailing bits that are not
 * zero — the last one is what keeps a caller from reading a string that is not the one that was
 * written.
 */
export function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  if (!BASE64URL_TEXT.test(text) || text.length % 4 === 1) throw new Error('invalid base64url');
  const bytes = new Uint8Array(Math.floor((text.length * 6) / 8));
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (const char of text) {
    buffer = (buffer << 6) | BASE64URL_ALPHABET.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[index] = (buffer >>> bits) & 255;
      index += 1;
    }
  }
  if (bits > 0 && (buffer & ((1 << bits) - 1)) !== 0) throw new Error('invalid base64url');
  return bytes;
}

/** Lowercase hex, two digits per byte: the form SP01 §2 stores a SHA-256 digest in. */
export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/** The bytes of a hex string, or `invalid hex`: an odd length or a character outside `0-9a-fA-F`. */
export function fromHex(text: string): Uint8Array<ArrayBuffer> {
  if (text.length % 2 !== 0 || !HEX_TEXT.test(text)) throw new Error('invalid hex');
  const bytes = new Uint8Array(text.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/**
 * `SHA-256` of a string (UTF-8 bytes) or of bytes, lowercase hex: the single hash of
 * `docs/specs/README.md` — code hashes, token hashes, the snapshot version and the host `kid` all
 * come from here rather than from a per-file copy.
 */
export async function sha256Hex(data: Uint8Array<ArrayBuffer> | string): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return toHex(new Uint8Array(digest));
}
