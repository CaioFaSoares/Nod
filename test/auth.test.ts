import { describe, expect, test } from 'bun:test';

import {
  PBKDF2_ITERATIONS,
  deriveKeys,
  generateInviteCode,
  hashInviteCode,
  hashPassword,
  inviteIsValid,
  unlockWait,
  validateNewPassword,
  verifyPassword,
} from '../shared/auth';
import type { PasswordHash } from '../shared/types';

// PBKDF2 with 600,000 iterations costs hundreds of ms per derivation; the tests use few iterations
// and pass the parameter explicitly (docs/arquitetura.md §3). Vector 3 below is the exception: it
// pins the production cost on purpose.
const TEST_ITERATIONS = 1000;

export interface KdfVector {
  /** Exactly as typed: vector 2 is in NFD on purpose, so the vector covers the NFC step of SP02 §1. */
  password: string;
  /** The 16 salt bytes, lowercase hex. */
  saltHex: string;
  iterations: number;
  /** The expected 32-byte keys, lowercase hex: computed once (Bun, 2026-10-16) and pinned. */
  authKey: string;
  vaultKey: string;
  localKey: string;
}

/**
 * The three SP02 §1 vectors. The hex was computed once with this same code under Bun and checked
 * against an independent implementation (Node `pbkdf2Sync` + `createHmac`, NFC applied by hand).
 *
 * `test/smoke/run.ts` imports this table: the Bond runtime (txiki.js) derives the same triples and
 * the smoke compares them against this same pinned hex.
 *
 * Vectors 1 and 2 stay at 1000 iterations to keep the suite fast; vector 3 uses the production count
 * (`PBKDF2_ITERATIONS`), which is what the host and the unlock path actually pay.
 */
export const KDF_VECTORS: KdfVector[] = [
  {
    password: 'correct horse battery staple',
    saltHex: '000102030405060708090a0b0c0d0e0f',
    iterations: 1000,
    authKey: '8f5d9631b2425febae77676239724baadfc150a78186996166bba91ea20a33a4',
    vaultKey: '3e1717afd122bc46c5ef27e03b4ac87180f174aec27dfc6d87fcfc7fb8a271e6',
    localKey: '254aec6c6d53cd77a078fac64513d3ff5969ba41b50638724ed279a27aa2bfc9',
  },
  {
    // 'café-Ünicode-pässwörd' typed with combining marks (NFD): the derived keys must equal those of
    // the NFC form below, which is why the pinned hex is the NFC one.
    password: 'cafe\u0301-U\u0308nicode-pa\u0308sswo\u0308rd',
    saltHex: 'ffeeddccbbaa99887766554433221100',
    iterations: 1000,
    authKey: 'e94fe009e769ebc5ae5e2f5e0518c42ac3cb077f99bffb22938642e20355de04',
    vaultKey: 'c54112e99b6b8f73e272ba3021aba0a7430067d9324e6a5e3ebf2e6fd3074934',
    localKey: '0be6e4c41ba9235af51ff4afa2273d404cf89c8bf13e46a1dcd3602b6924a356',
  },
  {
    password: 'bond-h3-third-vector',
    saltHex: '00112233445566778899aabbccddeeff',
    iterations: PBKDF2_ITERATIONS,
    authKey: 'c755c494f743b2df0c76cca56b08d44e1e26bfaa5ccf5be8aa1a3ddf15eef43d',
    vaultKey: 'a740caf4e1c9be6a719165afe7263b9edc8c2d63995b8241f09839c8b7a2462a',
    localKey: '5a91a24b2e32e0c48324b973b7a0cdba980397437a01b09ee1526c2990a43ef4',
  },
];

/** 16 salt bytes of a vector, as `deriveKeys` takes them. */
function bytesOf(hex: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array((hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));
}

function hexOf(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

describe('hashPassword and verifyPassword', () => {
  test('the right password passes and the wrong one does not', async () => {
    const h = await hashPassword('local-secret', TEST_ITERATIONS);

    expect(await verifyPassword('local-secret', h)).toBe(true);
    expect(await verifyPassword('local-secret ', h)).toBe(false);
    expect(await verifyPassword('another-password', h)).toBe(false);
    expect(await verifyPassword('', h)).toBe(false);
  });

  test('two hashes of the same password use different salts', async () => {
    const a = await hashPassword('same-password', TEST_ITERATIONS);
    const b = await hashPassword('same-password', TEST_ITERATIONS);

    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
  });

  test('the hash stores algorithm, parameters and a 16-byte salt', async () => {
    const h = await hashPassword('test-password', TEST_ITERATIONS);

    expect(PBKDF2_ITERATIONS).toBe(600_000);
    expect(h.algorithm).toBe('PBKDF2-SHA256');
    expect(h.iterations).toBe(TEST_ITERATIONS);
    expect(atob(h.salt).length).toBe(16);
    expect(atob(h.hash).length).toBe(32);
  });

  test('the iterations parameter changes the derived hash', async () => {
    const h = await hashPassword('password-with-iterations', TEST_ITERATIONS);

    expect(await verifyPassword('password-with-iterations', h)).toBe(true);
    expect(
      await verifyPassword('password-with-iterations', { ...h, iterations: TEST_ITERATIONS * 2 }),
    ).toBe(false);
  });

  test('an algorithm other than the expected one rejects without deriving', async () => {
    const h = await hashPassword('password-with-algorithm', TEST_ITERATIONS);
    const changed = { ...h, algorithm: 'MD5' } as unknown as PasswordHash;

    expect(await verifyPassword('password-with-algorithm', changed)).toBe(false);
  });

  test('a truncated hash of another size rejects', async () => {
    const h = await hashPassword('truncated-password', TEST_ITERATIONS);
    const truncated = { ...h, hash: h.hash.slice(0, 16) };

    expect(await verifyPassword('truncated-password', truncated)).toBe(false);
  });
});

// SP02 §1: one PBKDF2 and three HMACs, pinned so a change in the derivation, in a label or in the
// NFC step fails here first. The smoke derives these same vectors in the Bond runtime (txiki.js).
describe('deriveKeys (SP02 §1)', () => {
  test('the three pinned vectors derive the pinned bytes', async () => {
    for (const vector of KDF_VECTORS) {
      const keys = await deriveKeys(vector.password, bytesOf(vector.saltHex), vector.iterations);

      expect(hexOf(keys.authKey)).toBe(vector.authKey);
      expect(hexOf(keys.vaultKey)).toBe(vector.vaultKey);
      expect(hexOf(keys.localKey)).toBe(vector.localKey);
    }
  });

  test('each key is 32 bytes', async () => {
    const [vector] = KDF_VECTORS;
    const keys = await deriveKeys(vector.password, bytesOf(vector.saltHex), vector.iterations);

    expect(keys.authKey.length).toBe(32);
    expect(keys.vaultKey.length).toBe(32);
    expect(keys.localKey.length).toBe(32);
  });

  test('the three keys differ from each other', async () => {
    for (const vector of KDF_VECTORS) {
      const keys = await deriveKeys(vector.password, bytesOf(vector.saltHex), vector.iterations);

      expect(new Set([hexOf(keys.authKey), hexOf(keys.vaultKey), hexOf(keys.localKey)]).size).toBe(3);
    }
  });

  test('a different salt changes all three keys', async () => {
    const [vector] = KDF_VECTORS;
    const keys = await deriveKeys(
      vector.password,
      bytesOf('ffffffffffffffffffffffffffffffff'),
      vector.iterations,
    );

    expect(hexOf(keys.authKey)).not.toBe(vector.authKey);
    expect(hexOf(keys.vaultKey)).not.toBe(vector.vaultKey);
    expect(hexOf(keys.localKey)).not.toBe(vector.localKey);
  });

  test('a different iteration count changes all three keys', async () => {
    const [vector] = KDF_VECTORS;
    const keys = await deriveKeys(vector.password, bytesOf(vector.saltHex), vector.iterations + 1);

    expect(hexOf(keys.authKey)).not.toBe(vector.authKey);
    expect(hexOf(keys.vaultKey)).not.toBe(vector.vaultKey);
    expect(hexOf(keys.localKey)).not.toBe(vector.localKey);
  });

  test('a password typed in NFD derives the keys of its NFC form', async () => {
    const [, vector] = KDF_VECTORS;
    const composed = vector.password.normalize('NFC');
    expect(vector.password).not.toBe(composed); // the vector only covers the NFC step if it differs
    const salt = bytesOf(vector.saltHex);

    const fromNfd = await deriveKeys(vector.password, salt, vector.iterations);
    const fromNfc = await deriveKeys(composed, salt, vector.iterations);

    expect(hexOf(fromNfd.authKey)).toBe(vector.authKey);
    expect(hexOf(fromNfd.vaultKey)).toBe(hexOf(fromNfc.vaultKey));
    expect(hexOf(fromNfd.localKey)).toBe(hexOf(fromNfc.localKey));
  });
});

describe('validateNewPassword', () => {
  test('seven characters is too short', () => {
    expect(validateNewPassword('1234567')).toBe('password must be at least 8 characters');
  });

  test('eight characters is accepted', () => {
    expect(validateNewPassword('12345678')).toBeNull();
  });

  test('an empty password is too short', () => {
    expect(validateNewPassword('')).toBe('password must be at least 8 characters');
  });
});

describe('invite code', () => {
  test('has 43 base64url characters without padding', () => {
    expect(generateInviteCode()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test('two consecutive codes differ', () => {
    expect(generateInviteCode()).not.toBe(generateInviteCode());
  });
});

describe('hashInviteCode', () => {
  test('is SHA-256 in lowercase hex', async () => {
    const hex = await hashInviteCode('abc');

    expect(hex).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });

  test('different codes give different hashes', async () => {
    expect(await hashInviteCode('one-code')).not.toBe(await hashInviteCode('other-code'));
  });
});

describe('inviteIsValid', () => {
  const now = new Date('2026-10-15T12:00:00.000Z');

  test('expired rejects', () => {
    expect(
      inviteIsValid({ expiresAt: '2026-10-15T11:59:59.000Z', usedAt: null }, now),
    ).toBe(false);
  });

  test('exactly at the expiry instant rejects', () => {
    expect(
      inviteIsValid({ expiresAt: '2026-10-15T12:00:00.000Z', usedAt: null }, now),
    ).toBe(false);
  });

  test('used rejects, even before expiring', () => {
    expect(
      inviteIsValid({ expiresAt: '2026-10-16T12:00:00.000Z', usedAt: '2026-10-15T10:00:00.000Z' }, now),
    ).toBe(false);
  });

  test('unused and within validity passes', () => {
    expect(
      inviteIsValid({ expiresAt: '2026-10-16T12:00:00.000Z', usedAt: null }, now),
    ).toBe(true);
  });
});

describe('unlockWait', () => {
  test('up to four failures there is no wait', () => {
    expect(unlockWait(0)).toBe(0);
    expect(unlockWait(4)).toBe(0);
  });

  test('the wait doubles starting from the fifth failure', () => {
    expect(unlockWait(5)).toBe(1000);
    expect(unlockWait(6)).toBe(2000);
    expect(unlockWait(7)).toBe(4000);
  });

  test('the wait is capped at fifteen minutes', () => {
    expect(unlockWait(40)).toBe(900_000);
    expect(unlockWait(41)).toBe(900_000);
  });
});
