// Proves the O2 gate of the two auth sequences (`backend/main.ts`'s `beginAuth`; owner decision of
// 2026-10-17): a Nod older than the `minAppVersion` the discovery carries sends nothing at all — the
// discovery is the only call that leaves the machine, no salt request, no code and no `authKey`.
//
// `beginAuth` is the prologue both `host.activate` and `host.signIn` run (SP02 §4: the discovery,
// then the salt request), so the rule is pinned here once instead of through two runtime-bound
// handlers. The connection is scripted, like `test/sync.test.ts`'s: what is asserted is which calls
// went out, never a message of the host's.
import { describe, expect, mock, test } from 'bun:test';
import type * as Backend from '../backend/main';
import type { HostConnection, HostDiscovery } from '../backend/host-client';
import { HOST_ROUTES } from '../shared/host-api';

const APP_VERSION = '0.3.5';
const ADDRESS = 'https://guild.example.test';
const KID = 'kid-1';

/** A discovery document as SP04 §1 shape-checks it, with the minimum the case names. */
function discovery(minAppVersion: string): HostDiscovery {
  return {
    address: ADDRESS,
    fingerprint: 'AAAA-BBBB-CCCC-DDDD',
    pin: { kid: KID, ed25519Public: 'A'.repeat(43) },
    document: {
      api: 1,
      guild: 'Guild',
      key: { kid: KID, ed25519Public: 'A'.repeat(43) },
      fingerprint: 'AAAA-BBBB-CCCC-DDDD',
      minAppVersion,
      signIn: ['password'],
      update: null,
    },
  } as unknown as HostDiscovery;
}

/** What one case observes: the calls that went out and the minimum the discovery reported. */
interface Harness {
  beginAuth: typeof Backend.beginAuth;
  /** `method path` of every request the scripted connection answered. */
  sent: string[];
  /** The minimum every discovery reported, as `host.state` would keep it (SP04 §1). */
  observed: string[];
  /** How many pre-auth connections were built — zero is the point of the refusal. */
  connects: () => number;
  deps: (min: string, app?: string | null) => Backend.AuthPrologueDeps;
}

async function harness(): Promise<Harness> {
  // `backend/main.ts` reads the `tjs:sqlite` built-in at import time, which only exists in the
  // runtime. A static import would resolve before this stub — the dynamic import is the loading
  // boundary the test has to cross; the gate itself never touches SQLite.
  mock.module('tjs:sqlite', () => ({ Database: class {} }));
  const { beginAuth } = await import('../backend/main');

  const sent: string[] = [];
  const observed: string[] = [];
  let connects = 0;
  const connection = {
    request: async (method: string, path: string) => {
      sent.push(`${method} ${path}`);
      return { salt: 'c2FsdA', iterations: 100_000 };
    },
  } as unknown as HostConnection;

  return {
    beginAuth,
    sent,
    observed,
    connects: () => connects,
    deps: (min, app = APP_VERSION) => ({
      discover: async () => discovery(min),
      connect: () => {
        connects += 1;
        return connection;
      },
      observe: (version) => observed.push(version),
      appVersion: () => app,
    }),
  };
}

describe('the join and the sign-in while this Nod is older than the guild (O2)', () => {
  test('a minimum above the running app refuses before any credential', async () => {
    const h = await harness();

    await expect(h.beginAuth(h.deps('0.4.0'), 'ana@example.test')).rejects.toThrow(
      'update required — this guild needs a newer Nod',
    );

    // Nothing but the discovery: no connection was even built for an auth call, and nothing went out.
    expect(h.sent).toEqual([]);
    expect(h.connects()).toBe(0);
    // The minimum the discovery carried still reaches `host.state` (SP04 §1).
    expect(h.observed).toEqual(['0.4.0']);
  });

  test('the same version, or a newer app, makes the salt call and goes on', async () => {
    for (const [app, min] of [
      [APP_VERSION, APP_VERSION],
      [APP_VERSION, '0.3.4'],
      ['0.4.0', APP_VERSION],
    ] as const) {
      const h = await harness();
      const prologue = await h.beginAuth(h.deps(min, app), 'ana@example.test');

      expect(h.sent).toEqual([`POST ${HOST_ROUTES.authSalt}`]);
      expect(h.connects()).toBe(1);
      expect(prologue.published.iterations).toBe(100_000);
      expect(prologue.found.document.minAppVersion).toBe(min);
    }
  });

  test('a minimum this Nod cannot read is no verdict', async () => {
    const h = await harness();

    await h.beginAuth(h.deps('whenever'), 'ana@example.test');

    expect(h.sent).toEqual([`POST ${HOST_ROUTES.authSalt}`]);
    expect(h.observed).toEqual(['whenever']);
  });

  test('a runtime that never told the backend its version is not refused', async () => {
    const h = await harness();

    await h.beginAuth(h.deps('9.9.9', null), 'ana@example.test');

    expect(h.sent).toEqual([`POST ${HOST_ROUTES.authSalt}`]);
  });
});
