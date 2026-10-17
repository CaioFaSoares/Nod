// O2's surface on the real Elysia app over a temp data dir (SP03 §3, SP04 §1): `GET /v1/meta/app`
// and the `minAppVersion` the discovery repeats. Every request goes through
// `app.handle(new Request(...))` on the app the boot built, and the configuration comes from the
// real `loadAppMeta`, so what a deployment mistypes is what these tests mistype. Run with
// `bun test host/meta.test.ts`.
//
// The two facts the file pins: the route is public (a Nod too old to sign in still has to learn that
// it must update), and `minAppVersion` is one value — the one the boot resolved — so discovery and
// `/v1/meta/app` cannot disagree, whatever the process environment says later.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HOST_ROUTES,
  type AppMeta,
  type Discovery,
} from '../shared/host-api';
import { createApp } from './app';
import { INVALID_CREDENTIALS } from './auth';
import {
  ConfigError,
  DEFAULT_MIN_APP_VERSION,
  MIN_APP_VERSION_ENV,
  UPDATE_URL_ENV,
  loadAppMeta,
  loadConfig,
} from './config';
import { bootHost } from './main';

const UPDATE_URL = 'https://updates.example.test/manifest.json';
const MIN_APP_VERSION = '1.4.2';

type TestHost = {
  /** The real app of `host/app.ts`, built once: the same app every request goes through. */
  app: { handle(request: Request): Promise<Response> };
  cleanup(): void;
};

const hosts: TestHost[] = [];
const dirs: string[] = [];

/** A booted app whose app metadata the test handed over, on a temp data dir. */
async function startHost(appMeta?: AppMeta): Promise<TestHost> {
  const dir = mkdtempSync(join(tmpdir(), 'nod-meta-'));
  dirs.push(dir);
  const config = loadConfig({ NOD_DATA: dir, NOD_PUBLIC_URL: 'https://nod.example' });
  const host = await bootHost(config);
  const started: TestHost = {
    app: createApp({ config, db: host.db, appMeta }),
    cleanup: () => host.close(),
  };
  hosts.push(started);
  return started;
}

afterEach(() => {
  for (const host of hosts.splice(0)) host.cleanup();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const get = (host: TestHost, path: string, token?: string): Promise<Response> =>
  host.app.handle(
    new Request(`http://nod.test${path}`, {
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    }),
  );

// ---------------------------------------------------------------- configuration (SP07 §2)

describe('the app metadata of the environment', () => {
  test('defaults to no minimum version and no update manifest', () => {
    expect(loadAppMeta({})).toEqual({ minAppVersion: DEFAULT_MIN_APP_VERSION, update: null });
    expect(DEFAULT_MIN_APP_VERSION).toBe('0.0.0');
  });

  test('reads both values off the environment', () => {
    expect(
      loadAppMeta({ [MIN_APP_VERSION_ENV]: MIN_APP_VERSION, [UPDATE_URL_ENV]: UPDATE_URL }),
    ).toEqual({ minAppVersion: MIN_APP_VERSION, update: { url: UPDATE_URL } });
    // A semver's pre-release and build parts are semver too (semver.org §9).
    expect(loadAppMeta({ [MIN_APP_VERSION_ENV]: '1.0.0-rc.1+build.5' }).minAppVersion).toBe(
      '1.0.0-rc.1+build.5',
    );
    // Whitespace from a compose file's `VAR: ${VAR}` line is not part of the value.
    expect(loadAppMeta({ [MIN_APP_VERSION_ENV]: ' 1.4.2 ' }).minAppVersion).toBe('1.4.2');
    expect(loadAppMeta({ [UPDATE_URL_ENV]: '' }).update).toBeNull();
  });

  test('refuses a value that is not a semver or not an https address', () => {
    for (const bad of ['v1.2.3', '1.2', 'latest', '1.2.3.4', '1.2.x']) {
      expect(() => loadAppMeta({ [MIN_APP_VERSION_ENV]: bad })).toThrow(ConfigError);
    }
    for (const bad of ['not a url', 'http://updates.example.test/manifest.json', 'file:///tmp/m.json']) {
      expect(() => loadAppMeta({ [UPDATE_URL_ENV]: bad })).toThrow(ConfigError);
    }
  });
});

// ---------------------------------------------------------------- the public route (SP03 §3)

describe('GET /v1/meta/app (SP03 §3)', () => {
  test('answers the minimum app version and the update manifest of the boot', async () => {
    const host = await startHost(loadAppMeta({ [MIN_APP_VERSION_ENV]: MIN_APP_VERSION, [UPDATE_URL_ENV]: UPDATE_URL }));
    const response = await get(host, HOST_ROUTES.appMeta);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      minAppVersion: MIN_APP_VERSION,
      update: { url: UPDATE_URL },
    });
  });

  test('answers update: null while the deployment sets no manifest', async () => {
    const host = await startHost(loadAppMeta({ [MIN_APP_VERSION_ENV]: MIN_APP_VERSION }));
    const response = await get(host, HOST_ROUTES.appMeta);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ minAppVersion: MIN_APP_VERSION, update: null });
  });

  test('is public: no token and a dead token answer alike, and the discovery repeats its version', async () => {
    const host = await startHost(loadAppMeta({ [MIN_APP_VERSION_ENV]: MIN_APP_VERSION, [UPDATE_URL_ENV]: UPDATE_URL }));

    // SP03 §1: the public level reads no caller. A Nod that cannot sign in any more — because this
    // host raised the minimum version — must still be able to read what it has to update to.
    for (const token of [undefined, 'not-a-session-token']) {
      const response = await get(host, HOST_ROUTES.appMeta, token);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        minAppVersion: MIN_APP_VERSION,
        update: { url: UPDATE_URL },
      });
    }

    // SP04 §1: the discovery's `minAppVersion` is the same resolved value, from the one source.
    const discovery = await get(host, HOST_ROUTES.discovery);
    expect(discovery.status).toBe(200);
    const document = (await discovery.json()) as Discovery;
    expect(document.minAppVersion).toBe(MIN_APP_VERSION);
    expect(document.api).toBe(1);

    // A bad token is a 401 on a person route and nothing else: the public level is untouched.
    const denied = await get(host, HOST_ROUTES.state, 'not-a-session-token');
    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual({ error: INVALID_CREDENTIALS });
  });

  test('answers the value the boot resolved, never a later environment', async () => {
    // What the boot resolved is the process's answer: a route that read the environment per request
    // would answer a value the two documents could disagree on (and would ignore `main.ts`'s
    // validation at boot).
    const host = await startHost(loadAppMeta({ [MIN_APP_VERSION_ENV]: MIN_APP_VERSION, [UPDATE_URL_ENV]: UPDATE_URL }));
    const saved = process.env[MIN_APP_VERSION_ENV];
    process.env[MIN_APP_VERSION_ENV] = '9.9.9';
    try {
      expect(await (await get(host, HOST_ROUTES.appMeta)).json()).toEqual({
        minAppVersion: MIN_APP_VERSION,
        update: { url: UPDATE_URL },
      });
      expect(((await (await get(host, HOST_ROUTES.discovery)).json()) as Discovery).minAppVersion).toBe(
        MIN_APP_VERSION,
      );
    } finally {
      if (saved === undefined) delete process.env[MIN_APP_VERSION_ENV];
      else process.env[MIN_APP_VERSION_ENV] = saved;
    }
  });

  test('an app built without a resolved value reads the environment, one read for both documents', async () => {
    // `AppDeps.appMeta` is optional: the harnesses of H4–H8 build the app by hand and hand over no
    // value, and the environment is then the only source — the same `loadAppMeta` the boot runs, so
    // the discovery and this route still answer one value.
    const saved = {
      version: process.env[MIN_APP_VERSION_ENV],
      url: process.env[UPDATE_URL_ENV],
    };
    process.env[MIN_APP_VERSION_ENV] = MIN_APP_VERSION;
    process.env[UPDATE_URL_ENV] = UPDATE_URL;
    try {
      const host = await startHost();
      expect(await (await get(host, HOST_ROUTES.appMeta)).json()).toEqual({
        minAppVersion: MIN_APP_VERSION,
        update: { url: UPDATE_URL },
      });
      expect(((await (await get(host, HOST_ROUTES.discovery)).json()) as Discovery).minAppVersion).toBe(
        MIN_APP_VERSION,
      );
    } finally {
      if (saved.version === undefined) delete process.env[MIN_APP_VERSION_ENV];
      else process.env[MIN_APP_VERSION_ENV] = saved.version;
      if (saved.url === undefined) delete process.env[UPDATE_URL_ENV];
      else process.env[UPDATE_URL_ENV] = saved.url;
    }
  });
});
