// The host's boot surface, on a temp data dir and the real Elysia app (host/context.md).
// Run with `bun test host/`.

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from './app';
import { ConfigError, DEFAULT_PORT, loadConfig, type HostConfig } from './config';
import {
  HOST_SECRET_BYTES,
  HOST_SECRET_FILE,
  SIGNING_KEY_FILE,
  hostSecretPath,
  signingKeyPath,
} from './keys';
import { DATABASE_FILE, bootHost } from './main';
import { SCHEMA_VERSION_KEY } from './migrations';

const dirs: string[] = [];

/** A data dir that lives only for the duration of the test. */
function tempConfig(over: Partial<HostConfig> = {}): HostConfig {
  const dataDir = mkdtempSync(join(tmpdir(), 'bond-host-'));
  dirs.push(dataDir);
  return { dataDir, publicUrl: 'https://bond.example', port: DEFAULT_PORT, dev: false, ...over };
}

function fileMode(path: string): number {
  return statSync(path).mode & 0o777;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe('boot', () => {
  test('a fresh data dir serves GET /health with 200 ok', async () => {
    const config = tempConfig();
    const host = await bootHost(config);
    const app = createApp({ config, db: host.db });

    const response = await app.handle(new Request('http://bond.test/health'));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');

    host.close();
  });

  test('the first boot creates both key files with mode 0600 and applies migration 1', async () => {
    const config = tempConfig();
    const host = await bootHost(config);

    for (const name of [SIGNING_KEY_FILE, HOST_SECRET_FILE]) {
      const path = join(config.dataDir, name);
      expect(existsSync(path)).toBe(true);
      expect(fileMode(path)).toBe(0o600);
    }
    expect(existsSync(join(config.dataDir, DATABASE_FILE))).toBe(true);

    const secret = new Uint8Array(readFileSync(hostSecretPath(config.dataDir)));
    expect(secret.length).toBe(HOST_SECRET_BYTES);

    const key = JSON.parse(readFileSync(signingKeyPath(config.dataDir), 'utf8'));
    expect(key.kid).toBe(host.signingKey.kid);
    expect(key.publicJwk.crv).toBe('Ed25519');
    expect(typeof key.privateJwk.d).toBe('string');

    const version = host.db
      .query<{ value: string }, [string]>('SELECT value FROM meta WHERE key = ?')
      .get(SCHEMA_VERSION_KEY);
    expect(version?.value).toBe('1');

    host.close();
  });

  test('a second boot reuses the same key files', async () => {
    const config = tempConfig();
    const first = await bootHost(config);
    const firstKey = readFileSync(signingKeyPath(config.dataDir));
    const firstSecret = readFileSync(hostSecretPath(config.dataDir));
    const firstKid = first.signingKey.kid;
    first.close();

    const second = await bootHost(config);
    expect(second.signingKey.kid).toBe(firstKid);
    expect(readFileSync(signingKeyPath(config.dataDir)).equals(firstKey)).toBe(true);
    expect(readFileSync(hostSecretPath(config.dataDir)).equals(firstSecret)).toBe(true);
    expect(fileMode(signingKeyPath(config.dataDir))).toBe(0o600);
    expect(fileMode(hostSecretPath(config.dataDir))).toBe(0o600);
    second.close();
  });
});

describe('environment', () => {
  const base = { BOND_DATA: '/data', BOND_PUBLIC_URL: 'https://bond.example' };

  test('an https public URL with no other variable set is enough', () => {
    const config = loadConfig({ ...base });
    expect(config).toEqual({
      dataDir: '/data',
      publicUrl: 'https://bond.example',
      port: DEFAULT_PORT,
      dev: false,
    });
  });

  test('a non-https public URL is refused outside dev', () => {
    expect(() => loadConfig({ ...base, BOND_PUBLIC_URL: 'http://bond.example' })).toThrow(
      ConfigError,
    );
    expect(() =>
      loadConfig({ BOND_DATA: '/data', BOND_PUBLIC_URL: 'http://127.0.0.1:8080' }),
    ).toThrow(ConfigError);
  });

  test('dev accepts a plain http address', () => {
    const config = loadConfig({
      BOND_DATA: '/data',
      BOND_PUBLIC_URL: 'http://127.0.0.1:8080',
      BOND_DEV: '1',
    });
    expect(config.dev).toBe(true);
    expect(config.publicUrl).toBe('http://127.0.0.1:8080');
  });

  test('BOND_DATA and BOND_PUBLIC_URL are required, PORT must be a real port', () => {
    expect(() => loadConfig({ BOND_PUBLIC_URL: 'https://bond.example' })).toThrow(ConfigError);
    expect(() => loadConfig({ BOND_DATA: '/data' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, BOND_PUBLIC_URL: 'not a url' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, PORT: 'no' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, PORT: '0' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, PORT: '65536' })).toThrow(ConfigError);
    expect(loadConfig({ ...base, PORT: '9000' }).port).toBe(9000);
  });
});
