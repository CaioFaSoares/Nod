// K5/SP02 §9: the factor one gated call uses, and the build-mode stamp the dev exception of
// `docs/canonico.md` §22 rests on. `backend/main.ts` reads the `tjs:sqlite` built-in at import time,
// which only exists in the runtime, so the module is reached through a dynamic import with the same
// stub `test/personal.test.ts` uses — the gate predicate itself touches no SQLite.
import { describe, expect, mock, test } from 'bun:test';

import { stampMode } from '../shared/build-mode';

describe('the factor of the K5 gate (SP02 §9)', () => {
  test('the machine capability decides: with `authenticate`, a release never takes a password', async () => {
    mock.module('tjs:sqlite', () => ({ Database: class {} }));
    const { gateFactor } = await import('../backend/main');

    // `docs/canonico.md` §22, "gate where biometrics exist": where the runtime reports the
    // capability the operating system's prompt is the factor, and a release build (`devRun` false)
    // never takes a typed password there — whatever the page sends — until a prompt failed.
    expect(gateFactor('smoke-connected-1', true, false, false)).toBe('biometrics');
    expect(gateFactor('', true, false, false)).toBe('biometrics');
    expect(gateFactor(undefined, true, false, false)).toBe('biometrics');

    // The Proposto exception of `docs/canonico.md` §22, "gate in a dev run": a non-release
    // (`tinyjs dev`) run also takes the typed password, which is what the unattended smoke passes.
    // Without one the prompt is still what runs.
    expect(gateFactor('smoke-connected-1', true, true, false)).toBe('password');
    expect(gateFactor('', true, true, false)).toBe('biometrics');
    expect(gateFactor(undefined, true, true, false)).toBe('biometrics');

    // No capability (Linux): the typed password is the only factor there, and the run's mode has
    // nothing to say about it.
    expect(gateFactor('smoke-connected-1', false, false, false)).toBe('password');
    expect(gateFactor('smoke-connected-1', false, true, false)).toBe('password');

    // Neither factor: `authentication required`, before anything is read — in either mode.
    expect(gateFactor(undefined, false, false, false)).toBe('unavailable');
    expect(gateFactor('', false, false, false)).toBe('unavailable');
    expect(gateFactor(undefined, false, true, false)).toBe('unavailable');
    expect(gateFactor('', false, true, false)).toBe('unavailable');
  });

  test('after the system prompt failed in the session, a release takes the typed password', async () => {
    mock.module('tjs:sqlite', () => ({ Database: class {} }));
    const { gateFactor } = await import('../backend/main');

    // canonico §22, "Gate fallback when the system prompt fails": Windows without Hello reports
    // `authenticate` and then answers `false` to every prompt. Once that happened, the password the
    // page sends is the factor; a call without one still goes to the prompt.
    expect(gateFactor('hunter22', true, false, true)).toBe('password');
    expect(gateFactor(undefined, true, false, true)).toBe('biometrics');
    expect(gateFactor('', true, false, true)).toBe('biometrics');
  });

  test('a confirmed gate covers the next calls until 15 idle minutes pass (owner, 2026-10-17)', async () => {
    mock.module('tjs:sqlite', () => ({ Database: class {} }));
    const { gateStillOpen, GATE_WINDOW_MS } = await import('../backend/main');

    expect(GATE_WINDOW_MS).toBe(15 * 60 * 1000);
    expect(gateStillOpen(null, 1_000)).toBe(false);
    expect(gateStillOpen(1_000, 1_000)).toBe(true);
    expect(gateStillOpen(1_000, 1_000 + GATE_WINDOW_MS - 1)).toBe(true);
    expect(gateStillOpen(1_000, 1_000 + GATE_WINDOW_MS)).toBe(false);
    // A clock that went backwards is not a confirmation.
    expect(gateStillOpen(5_000, 1_000)).toBe(false);
  });
});

describe('the runtime-neutral capability split (0.7.0)', () => {
  test('`biometricUnlock: false` keeps the gate prompt and refuses the session unlock', async () => {
    mock.module('tjs:sqlite', () => ({ Database: class {} }));
    const { authenticateFactors, gateFactor } = await import('../backend/main');

    // The Electrobun target: `authenticate` backs the gate (the system prompt is still offered),
    // but not a session unlock — its `bun` binary shares Bun's Developer ID, so the keychain would
    // let any Electrobun app read `nod.bio.<person>` (`docs/handovers/e07-migration.md` §5).
    const electrobun = authenticateFactors('macos', { authenticate: true, biometricUnlock: false });
    expect(electrobun).toEqual({ systemPrompt: true, biometricUnlock: false });
    expect(gateFactor(undefined, electrobun.systemPrompt, false, false)).toBe('biometrics');
    expect(gateFactor('typed', electrobun.systemPrompt, false, false)).toBe('biometrics');

    // tinyjs: the key is absent, and an absent key means supported.
    expect(authenticateFactors('macos', { authenticate: true })).toEqual({
      systemPrompt: true,
      biometricUnlock: true,
    });
    expect(authenticateFactors('macos', { authenticate: true, biometricUnlock: true })).toEqual({
      systemPrompt: true,
      biometricUnlock: true,
    });

    // Linux has no `app.authenticate`: neither answer exists there.
    expect(authenticateFactors('linux', {})).toEqual({ systemPrompt: false, biometricUnlock: false });
    // A machine without the prompt has no unlock to back either.
    expect(authenticateFactors('windows', { authenticate: false })).toEqual({
      systemPrompt: false,
      biometricUnlock: false,
    });
  });
});

describe('the build-mode stamp (SP02 §9, canonico §22)', () => {
  test('names a dev run only for the exact `dev` text', () => {
    // `scripts/gen-electrobun-config.ts dev` writes it, and the backend reads it back at start-up.
    expect(stampMode('dev\n')).toBe('dev');
    expect(stampMode(' build \n')).toBe('build');
    // A release stages no stamp at all (it is not in its `"resources"` list), so absence is a
    // release — and so is every body this rule does not name: the exception fails closed.
    expect(stampMode('')).toBeNull();
    expect(stampMode('DEV')).toBeNull();
    expect(stampMode('development')).toBeNull();
    expect(stampMode('1')).toBeNull();
  });
});
