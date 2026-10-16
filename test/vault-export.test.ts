import { describe, expect, test } from 'bun:test';

import { exportVault, importVault } from '../shared/vault-export';
import type { VaultExportItem } from '../shared/types';

const PASSWORD = 'local password of the vault';
const ITERATIONS = 1_000;
const INVALID = 'wrong password or invalid file';

const ITEMS: VaultExportItem[] = [
  { toolId: 'kanban', label: 'Kanban — sprint', username: 'jose', secret: 's3cret' },
  { toolId: 'webmail', label: 'Webmail', username: 'jose@copland.studio', secret: 'another' },
];

function envelopeOf(blob: string): Record<string, unknown> {
  return JSON.parse(atob(blob)) as Record<string, unknown>;
}

/** Rebuilds the blob from the envelope, for the tampered-file tests. */
function blobOf(envelope: Record<string, unknown>): string {
  return btoa(JSON.stringify(envelope));
}

describe('exportVault / importVault', () => {
  test('a round trip returns exactly the same items', async () => {
    const blob = await exportVault(ITEMS, PASSWORD, ITERATIONS);
    expect(await importVault(blob, PASSWORD)).toEqual(ITEMS);
  });

  test('an empty vault also comes back empty', async () => {
    const blob = await exportVault([], PASSWORD, ITERATIONS);
    expect(await importVault(blob, PASSWORD)).toEqual([]);
  });

  test('the blob is the agreed envelope, with a 16 B salt and a 12 B nonce', async () => {
    const envelope = envelopeOf(await exportVault(ITEMS, PASSWORD, ITERATIONS));
    expect(envelope.v).toBe(1);
    expect(envelope.alg).toBe('PBKDF2-SHA256+AES-256-GCM');
    expect(envelope.iter).toBe(ITERATIONS);
    expect(atob(envelope.salt as string)).toHaveLength(16);
    expect(atob(envelope.nonce as string)).toHaveLength(12);
    expect(typeof envelope.ct).toBe('string');
    expect((envelope.ct as string).length).toBeGreaterThan(0);
  });

  test('each export uses a fresh salt and nonce', async () => {
    const first = envelopeOf(await exportVault(ITEMS, PASSWORD, ITERATIONS));
    const second = envelopeOf(await exportVault(ITEMS, PASSWORD, ITERATIONS));
    expect(second.salt).not.toBe(first.salt);
    expect(second.nonce).not.toBe(first.nonce);
    expect(second.ct).not.toBe(first.ct);
  });

  test('the wrong password throws the single message', async () => {
    const blob = await exportVault(ITEMS, PASSWORD, ITERATIONS);
    await expect(importVault(blob, 'wrong password')).rejects.toThrow(INVALID);
  });

  test('a blob that is not base64/JSON throws the same message', async () => {
    await expect(importVault('this is not a file', PASSWORD)).rejects.toThrow(INVALID);
    await expect(importVault('***', PASSWORD)).rejects.toThrow(INVALID);
    await expect(importVault('e30=', PASSWORD)).rejects.toThrow(INVALID); // {}
    await expect(importVault('bnVsbA==', PASSWORD)).rejects.toThrow(INVALID); // null
  });

  test('a version other than 1 throws the same message', async () => {
    const envelope = envelopeOf(await exportVault(ITEMS, PASSWORD, ITERATIONS));
    envelope.v = 2;
    await expect(importVault(blobOf(envelope), PASSWORD)).rejects.toThrow(INVALID);
  });

  test('another algorithm throws the same message', async () => {
    const envelope = envelopeOf(await exportVault(ITEMS, PASSWORD, ITERATIONS));
    envelope.alg = 'PBKDF2-SHA256+AES-256-CBC';
    await expect(importVault(blobOf(envelope), PASSWORD)).rejects.toThrow(INVALID);
  });

  test('a tampered ciphertext does not decrypt and throws the same message', async () => {
    const envelope = envelopeOf(await exportVault(ITEMS, PASSWORD, ITERATIONS));
    const ct = envelope.ct as string;
    envelope.ct = (ct[0] === 'A' ? 'B' : 'A') + ct.slice(1);
    await expect(importVault(blobOf(envelope), PASSWORD)).rejects.toThrow(INVALID);
  });

  test('content that is not a list of valid items throws the same message', async () => {
    const incomplete = [{ toolId: 'kanban', label: 'Kanban', username: 'jose' }];
    const blob = await exportVault(incomplete as unknown as VaultExportItem[], PASSWORD, ITERATIONS);
    await expect(importVault(blob, PASSWORD)).rejects.toThrow(INVALID);
  });
});

// A forged `iter` must never reach the derivation: 1e12 PBKDF2 rounds would hang the backend.
describe('importVault — iter bounds', () => {
  async function blobWithIterations(iter: unknown): Promise<string> {
    const envelope = envelopeOf(await exportVault(ITEMS, PASSWORD, ITERATIONS));
    envelope.iter = iter;
    return blobOf(envelope);
  }

  test('iter above the ceiling is refused without deriving', async () => {
    const blob = await blobWithIterations(1_000_000_000_000);
    const start = performance.now();
    await expect(importVault(blob, PASSWORD)).rejects.toThrow(INVALID);
    expect(performance.now() - start).toBeLessThan(200);
  });

  test('iter below the floor is refused without deriving', async () => {
    const start = performance.now();
    await expect(importVault(await blobWithIterations(999), PASSWORD)).rejects.toThrow(INVALID);
    expect(performance.now() - start).toBeLessThan(200);
  });

  test('iter that is not a positive integer is refused', async () => {
    await expect(importVault(await blobWithIterations(0), PASSWORD)).rejects.toThrow(INVALID);
    await expect(importVault(await blobWithIterations(-1_000), PASSWORD)).rejects.toThrow(INVALID);
    await expect(importVault(await blobWithIterations(1_000.5), PASSWORD)).rejects.toThrow(INVALID);
    await expect(importVault(await blobWithIterations('1000'), PASSWORD)).rejects.toThrow(INVALID);
  });

  test('the floor itself is accepted', async () => {
    const blob = await exportVault(ITEMS, PASSWORD, 1_000);
    expect(envelopeOf(blob).iter).toBe(1_000);
    expect(await importVault(blob, PASSWORD)).toEqual(ITEMS);
  });
});
