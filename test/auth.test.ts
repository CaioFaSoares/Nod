import { describe, expect, test } from 'bun:test';

import {
  PBKDF2_ITERATIONS,
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
// and pass the parameter explicitly (docs/arquitetura.md §3).
const TEST_ITERATIONS = 1000;

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
