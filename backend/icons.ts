// Catalog icons: bytes on disk, addressed by content hash.
// Contract: `docs/arquitetura.md` §4 (`createIcons`); requirements: `docs/canonico.md` §8, §19.
// The database keeps only the hash (`tool.icon_hash`); the file lives at `<dir>/<sha256>.<type>`
// and leaves here as a data URI for the page and for the tool windows.
import type { RawIcon } from '../shared/types';

/** Accepted types, in the order `dataUri` looks for the file. */
const TYPES: RawIcon['type'][] = ['png', 'svg', 'jpeg', 'webp'];

const EXTENSION: Record<RawIcon['type'], string> = {
  png: 'png',
  svg: 'svg',
  jpeg: 'jpeg',
  webp: 'webp',
};

const MIME: Record<RawIcon['type'], string> = {
  png: 'image/png',
  svg: 'image/svg+xml',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

/** File extension → type: the seed may carry the icon as a relative path. */
const BY_EXTENSION: Record<string, RawIcon['type'] | undefined> = {
  png: 'png',
  svg: 'svg',
  jpg: 'jpeg',
  jpeg: 'jpeg',
  webp: 'webp',
};

/** Media type → type: the seed may carry the icon as a data URI. */
const BY_MIME: Record<string, RawIcon['type'] | undefined> = {
  'image/png': 'png',
  'image/svg+xml': 'svg',
  'image/jpeg': 'jpeg',
  'image/webp': 'webp',
};

const HASH = /^[0-9a-f]{64}$/;
/** Bytes per `String.fromCharCode` call: 8 KiB stays under the argument limit. */
const CHUNK = 0x2000;

export interface Icons {
  /** Writes the bytes and returns the sha256 in hex. */
  save(icon: RawIcon): Promise<string>;
  /** Data URI of this hash, or `null` when there is no file (or the hash is not 64 hex). */
  dataUri(hash: string): Promise<string | null>;
}

export function createIcons(dir: string): Icons {
  async function save(icon: RawIcon): Promise<string> {
    const bytes = base64ToBytes(icon.base64);
    let hash = '';
    for (const byte of new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))) {
      hash += byte.toString(16).padStart(2, '0');
    }
    await tjs.makeDir(dir, { recursive: true });
    await tjs.writeFile(`${dir}/${hash}.${EXTENSION[icon.type]}`, bytes);
    return hash;
  }

  async function dataUri(hash: string): Promise<string | null> {
    if (!HASH.test(hash)) return null;
    for (const type of TYPES) {
      try {
        const bytes = await tjs.readFile(`${dir}/${hash}.${EXTENSION[type]}`);
        return `data:${MIME[type]};base64,${bytesToBase64(bytes)}`;
      } catch {
        // no file with this extension: try the next one
      }
    }
    return null;
  }

  return { save, dataUri };
}

/** Icon type of a path's extension (`png`, `svg`, `jpg`/`jpeg`, `webp`), or `null`. */
export function typeOfPath(path: string): RawIcon['type'] | null {
  const found = /\.([a-z0-9]+)$/i.exec(path);
  const extension = found === null ? undefined : found[1];
  if (extension === undefined) return null;
  return BY_EXTENSION[extension.toLowerCase()] ?? null;
}

/** Icon type of a data URI media type (`image/png`, `image/svg+xml`, …), or `null`. */
export function typeOfMime(mime: string): RawIcon['type'] | null {
  return BY_MIME[mime.toLowerCase()] ?? null;
}

/** Base64 of these bytes (the inverse of `atob`), in chunks so the stack never overflows. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let start = 0; start < bytes.length; start += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(start, start + CHUNK));
  }
  return btoa(binary);
}

/**
 * Bytes of a base64 string: `atob` returns a binary string, one byte per code unit.
 * Returns `Uint8Array<ArrayBuffer>` (not a bare `Uint8Array`) because WebCrypto only accepts a
 * `BufferSource` — the same typing note as `binaryToBytes` in `shared/auth.ts`.
 */
function base64ToBytes(text: string): Uint8Array<ArrayBuffer> {
  let binary: string;
  try {
    binary = atob(text);
  } catch {
    throw new Error('invalid icon: invalid base64');
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
