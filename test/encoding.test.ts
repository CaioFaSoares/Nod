// `shared/encoding.ts`: the byte encodings of `docs/specs/README.md` — base64url without padding,
// lowercase hex for digests, and the one SHA-256 every side computes. Behavior only, no wording:
// the vectors of RFC 4648 §10, round trips of random bytes, the refusals, and two published digests.

import { describe, expect, test } from 'bun:test';

import { fromBase64url, fromHex, sha256Hex, toBase64url, toHex } from '../shared/encoding';

const encoder = new TextEncoder();

/**
 * RFC 4648 §10's test vectors with the alphabet of §5 and no padding: the standard `Zg==` is `Zg`
 * here. Each pair is `[text, encoded]`.
 */
const RFC_4648: readonly (readonly [string, string])[] = [
  ['', ''],
  ['f', 'Zg'],
  ['fo', 'Zm8'],
  ['foo', 'Zm9v'],
  ['foob', 'Zm9vYg'],
  ['fooba', 'Zm9vYmE'],
  ['foobar', 'Zm9vYmFy'],
];

/** Two published SHA-256 digests, as lowercase hex. */
const SHA_256: readonly (readonly [string, string])[] = [
  ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
];

describe('base64url', () => {
  test('encodes the RFC 4648 §10 vectors without padding', () => {
    for (const [text, encoded] of RFC_4648) {
      expect(toBase64url(encoder.encode(text))).toBe(encoded);
    }
  });

  test('decodes the RFC 4648 §10 vectors', () => {
    for (const [text, encoded] of RFC_4648) {
      expect(fromBase64url(encoded)).toEqual(encoder.encode(text));
    }
  });

  test('writes the two characters the alphabets disagree on', () => {
    // 11111011 11101111 10111110 → four groups of 62 → '++++' in the standard alphabet.
    expect(toBase64url(new Uint8Array([0xfb, 0xef, 0xbe]))).toBe('----');
    expect(fromBase64url('----')).toEqual(new Uint8Array([0xfb, 0xef, 0xbe]));
    expect(toBase64url(new Uint8Array([0xff, 0xff, 0xff]))).toBe('____');
    expect(fromBase64url('____')).toEqual(new Uint8Array([0xff, 0xff, 0xff]));
  });

  test('keeps every byte of random input', () => {
    for (let length = 0; length <= 64; length++) {
      const bytes = crypto.getRandomValues(new Uint8Array(length));
      expect(fromBase64url(toBase64url(bytes))).toEqual(bytes);
    }
  });

  test('no bytes are no characters', () => {
    expect(toBase64url(new Uint8Array(0))).toBe('');
    expect(fromBase64url('')).toEqual(new Uint8Array(0));
  });

  test('refuses padding, the standard alphabet, a separator and a stranded character', () => {
    expect(() => fromBase64url('Zg==')).toThrow('invalid base64url');
    expect(() => fromBase64url('Zg=')).toThrow('invalid base64url');
    expect(() => fromBase64url('Zm9v+')).toThrow('invalid base64url');
    expect(() => fromBase64url('Zm9v/')).toThrow('invalid base64url');
    expect(() => fromBase64url('Zm9v YmFy')).toThrow('invalid base64url');
    expect(() => fromBase64url('Z')).toThrow('invalid base64url');
  });

  test('refuses trailing bits that are not zero', () => {
    // 'Zh' holds the same 8 bits as 'Zg' plus four that are not zero: it would decode to 'f', but it
    // is not the string that was written.
    expect(fromBase64url('Zg')).toEqual(encoder.encode('f'));
    expect(() => fromBase64url('Zh')).toThrow('invalid base64url');
  });
});

describe('hex', () => {
  test('writes two lowercase digits per byte', () => {
    expect(toHex(new Uint8Array([0x00, 0x0f, 0xff, 0xa5]))).toBe('000fffa5');
    expect(toHex(new Uint8Array(0))).toBe('');
  });

  test('keeps every byte of random input', () => {
    for (let length = 0; length <= 64; length++) {
      const bytes = crypto.getRandomValues(new Uint8Array(length));
      expect(fromHex(toHex(bytes))).toEqual(bytes);
    }
  });

  test('reads the digests it writes', () => {
    expect(fromHex('ba7816bf')).toEqual(new Uint8Array([0xba, 0x78, 0x16, 0xbf]));
  });

  test('refuses an odd length and a character outside the alphabet', () => {
    expect(() => fromHex('abc')).toThrow('invalid hex');
    expect(() => fromHex('0g')).toThrow('invalid hex');
    expect(() => fromHex('12 34')).toThrow('invalid hex');
    expect(() => fromHex('ff,')).toThrow('invalid hex');
  });
});

describe('sha256Hex', () => {
  test('computes the published digests', async () => {
    for (const [text, digest] of SHA_256) {
      expect(await sha256Hex(text)).toBe(digest);
    }
  });

  test('hashes a string as its UTF-8 bytes', async () => {
    expect(await sha256Hex(encoder.encode('abc'))).toBe(await sha256Hex('abc'));
    expect(await sha256Hex('café')).toBe(await sha256Hex(encoder.encode('café')));
    expect(await sha256Hex('café')).not.toBe(await sha256Hex('cafe'));
  });

  test('answers lowercase hex of 32 bytes', async () => {
    const digest = await sha256Hex('nod');
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(fromHex(digest)).toHaveLength(32);
  });
});
