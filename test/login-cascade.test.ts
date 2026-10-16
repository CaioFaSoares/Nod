import { describe, expect, test } from 'bun:test';

import {
  type CascadeAction,
  type CascadeSignal,
  type CascadeState,
  newCascade,
  stepCascade,
} from '../shared/login-cascade';
import type { ReportState } from '../shared/types';

const ORIGIN = 'https://kanban.copland.studio';
const PROVIDER = 'https://accounts.example.com';
const CTX = { hasCredential: true, noFill: false };

function state(partial: Partial<CascadeState> = {}): CascadeState {
  return { ...newCascade(ORIGIN), ...partial };
}

function navigate(s: CascadeState, url: string): { state: CascadeState; action: CascadeAction } {
  return stepCascade(s, { type: 'navigated', url }, CTX);
}

function finish(
  s: CascadeState,
  url: string,
  ctx = CTX,
): { state: CascadeState; action: CascadeAction } {
  return stepCascade(s, { type: 'finished', url }, ctx);
}

function report(
  s: CascadeState,
  reported: ReportState,
  ctx = CTX,
): { state: CascadeState; action: CascadeAction } {
  return stepCascade(s, { type: 'report', state: reported }, ctx);
}

describe('newCascade', () => {
  test('starts on the origin, with no attempt, without leaving and without a result', () => {
    expect(newCascade(ORIGIN)).toEqual({
      origin: ORIGIN,
      attempts: 0,
      leftOrigin: false,
      result: null,
    });
  });
});

describe('stepCascade — one test per numbered rule', () => {
  test('1. with a result already set, every signal is none and the state comes back untouched', () => {
    const done = state({ attempts: 1, leftOrigin: true, result: 'manual' });
    const signals: CascadeSignal[] = [
      { type: 'navigated', url: `${ORIGIN}/panel` },
      { type: 'navigated', url: `${PROVIDER}/authorize` },
      { type: 'finished', url: `${ORIGIN}/panel` },
      { type: 'finished', url: `${PROVIDER}/authorize` },
      { type: 'report', state: 'no-form' },
      { type: 'report', state: 'form' },
      { type: 'report', state: 'filled' },
      { type: 'report', state: 'error' },
    ];

    for (const signal of signals) {
      const step = stepCascade(done, signal, CTX);
      expect(step.action).toEqual({ type: 'none' });
      expect(step.state).toEqual(done);
    }
  });

  test('2. landing outside the origin marks leftOrigin and never injects', () => {
    const received = state();
    const away = finish(received, `${PROVIDER}/authorize`);
    expect(away.action).toEqual({ type: 'none' });
    expect(away.state).toEqual(state({ leftOrigin: true }));
    expect(received.leftOrigin).toBe(false);

    const hoppedAway = navigate(state(), `${PROVIDER}/authorize`);
    expect(hoppedAway.action).toEqual({ type: 'none' });
    expect(hoppedAway.state.leftOrigin).toBe(true);
  });

  test('2. an invalid URL counts as a different origin', () => {
    expect(finish(state(), 'not a url').state.leftOrigin).toBe(true);
    expect(navigate(state(), 'not a url').state.leftOrigin).toBe(true);
    expect(finish(state(), '').state.leftOrigin).toBe(true);
  });

  test('2. another scheme on the same host is another origin', () => {
    expect(finish(state(), 'http://kanban.copland.studio').state.leftOrigin).toBe(true);
  });

  test('3. navigating inside the origin is not an action and keeps what was learned', () => {
    const received = state({ attempts: 1, leftOrigin: true });
    const step = navigate(received, `${ORIGIN}/sso/back`);
    expect(step.action).toEqual({ type: 'none' });
    expect(step.state).toEqual(received);
  });

  test('4. finishing on the origin injects once and counts the fill when it is made', () => {
    const first = finish(state(), `${ORIGIN}/login`);
    expect(first.action).toEqual({ type: 'inject', fill: true });
    expect(first.state.attempts).toBe(1);

    const second = finish(first.state, `${ORIGIN}/login`);
    expect(second.action).toEqual({ type: 'inject', fill: false });
    expect(second.state.attempts).toBe(1);

    // Any path of the origin still arrives on the origin — the comparison is by origin.
    const anotherPath = finish(state(), `${ORIGIN}/panel`);
    expect(anotherPath.action).toEqual({ type: 'inject', fill: true });
  });

  test('4. without a credential, with noFill or after an attempt the inject does not fill', () => {
    expect(finish(state(), ORIGIN, { hasCredential: false, noFill: false })).toEqual({
      state: state(),
      action: { type: 'inject', fill: false },
    });
    expect(finish(state(), ORIGIN, { hasCredential: true, noFill: true })).toEqual({
      state: state(),
      action: { type: 'inject', fill: false },
    });
    expect(finish(state({ attempts: 1 }), ORIGIN).action).toEqual({ type: 'inject', fill: false });
    expect(finish(state({ attempts: 1 }), ORIGIN).state.attempts).toBe(1);
  });

  test('5. no-form: provider after leaving, filled after a fill, session with neither', () => {
    const provider = report(state({ leftOrigin: true }), 'no-form');
    expect(provider.action).toEqual({ type: 'result', result: 'provider' });
    expect(provider.state).toEqual(state({ leftOrigin: true, result: 'provider' }));

    const filled = report(state({ attempts: 1 }), 'no-form');
    expect(filled.action).toEqual({ type: 'result', result: 'filled' });
    expect(filled.state.result).toBe('filled');

    const session = report(state(), 'no-form');
    expect(session.action).toEqual({ type: 'result', result: 'session' });
    expect(session.state.result).toBe('session');

    // The provider wins over the count: the redirect, not the submit, resolved the login.
    const both = report(state({ attempts: 1, leftOrigin: true }), 'no-form');
    expect(both.state.result).toBe('provider');
  });

  test('6. filled is not an action: the attempt was already counted at injection time', () => {
    const injected = finish(newCascade(ORIGIN), `${ORIGIN}/login`);
    expect(injected.state.attempts).toBe(1);

    const step = report(injected.state, 'filled');
    expect(step.action).toEqual({ type: 'none' });
    expect(step.state).toEqual(injected.state);
    expect(step.state.attempts).toBe(1);
    expect(step.state.result).toBeNull();
  });

  test('7. form: manual on the first sight, failed after a fill had already happened', () => {
    const manual = report(state(), 'form');
    expect(manual.action).toEqual({ type: 'result', result: 'manual' });
    expect(manual.state).toEqual(state({ result: 'manual' }));

    const failed = report(state({ attempts: 1 }), 'form');
    expect(failed.action).toEqual({ type: 'result', result: 'failed' });
    expect(failed.state).toEqual(state({ attempts: 1, result: 'failed' }));
  });

  test('8. error from the adapter always fails, with or without a fill behind it', () => {
    const first = report(state(), 'error');
    expect(first.action).toEqual({ type: 'result', result: 'failed' });
    expect(first.state).toEqual(state({ result: 'failed' }));

    expect(report(state({ attempts: 1 }), 'error').state.result).toBe('failed');
    expect(report(state({ attempts: 1, leftOrigin: true }), 'error').state.result).toBe('failed');
  });
});

describe('stepCascade — login-loop fix and full flows', () => {
  test('without any report, finishing on the origin never fills a second time', () => {
    const first = finish(newCascade(ORIGIN), ORIGIN);
    expect(first.action).toEqual({ type: 'inject', fill: true });
    expect(first.state.attempts).toBe(1);

    const second = finish(first.state, ORIGIN);
    expect(second.action).toEqual({ type: 'inject', fill: false });
    expect(second.state.attempts).toBe(1);

    const third = finish(second.state, `${ORIGIN}/login`);
    expect(third.action).toEqual({ type: 'inject', fill: false });
    expect(third.state.attempts).toBe(1);
  });

  test('full flow: form login fills, submits and the site confirms without a form', () => {
    const arrived = finish(newCascade(ORIGIN), `${ORIGIN}/login`);
    expect(arrived.action).toEqual({ type: 'inject', fill: true });

    const submitted = report(arrived.state, 'filled');
    expect(submitted.action).toEqual({ type: 'none' });

    const back = finish(submitted.state, `${ORIGIN}/panel`);
    expect(back.action).toEqual({ type: 'inject', fill: false });

    const done = report(back.state, 'no-form');
    expect(done.action).toEqual({ type: 'result', result: 'filled' });
    expect(done.state.result).toBe('filled');
    expect(done.state.attempts).toBe(1);
    expect(done.state.leftOrigin).toBe(false);
  });

  test('full flow: silent SSO through the provider reaches the panel and reports provider', () => {
    const start = navigate(newCascade(ORIGIN), `${ORIGIN}/sso`);
    expect(start.action).toEqual({ type: 'none' });
    expect(start.state.leftOrigin).toBe(false);

    const atProvider = navigate(start.state, `${PROVIDER}/authorize`);
    expect(atProvider.action).toEqual({ type: 'none' });
    expect(atProvider.state.leftOrigin).toBe(true);

    const returning = navigate(atProvider.state, `${ORIGIN}/sso/back`);
    expect(returning.state.leftOrigin).toBe(true);

    const panel = finish(returning.state, `${ORIGIN}/panel`);
    expect(panel.action).toEqual({ type: 'inject', fill: true });

    const done = report(panel.state, 'no-form');
    expect(done.action).toEqual({ type: 'result', result: 'provider' });
    expect(done.state.result).toBe('provider');
  });

  test('full flow: an existing session reports session without ever filling', () => {
    const ctx = { hasCredential: false, noFill: false };
    const arrived = finish(newCascade(ORIGIN), `${ORIGIN}/`, ctx);
    expect(arrived.action).toEqual({ type: 'inject', fill: false });
    expect(arrived.state.attempts).toBe(0);

    const done = report(arrived.state, 'no-form', ctx);
    expect(done.action).toEqual({ type: 'result', result: 'session' });
    expect(done.state.result).toBe('session');
  });

  test('full flow: a form the adapter did not fill goes to manual on the first sight', () => {
    const arrived = finish(newCascade(ORIGIN), `${ORIGIN}/login`, { hasCredential: false, noFill: false });
    expect(arrived.action).toEqual({ type: 'inject', fill: false });

    const done = report(arrived.state, 'form', { hasCredential: false, noFill: false });
    expect(done.state.result).toBe('manual');
  });

  test('never mutates the received state', () => {
    const signals: CascadeSignal[] = [
      { type: 'navigated', url: `${ORIGIN}/login` },
      { type: 'navigated', url: `${PROVIDER}/authorize` },
      { type: 'finished', url: `${ORIGIN}/login` },
      { type: 'finished', url: `${PROVIDER}/authorize` },
      { type: 'report', state: 'no-form' },
      { type: 'report', state: 'form' },
      { type: 'report', state: 'filled' },
      { type: 'report', state: 'error' },
    ];

    for (const signal of signals) {
      const received = Object.freeze(state());
      expect(() => stepCascade(received, signal, CTX)).not.toThrow();
      expect(received).toEqual(state());
    }

    const received = Object.freeze(state());
    const step = stepCascade(received, { type: 'finished', url: `${ORIGIN}/login` }, CTX);
    expect(step.state).not.toBe(received);
    expect(step.state.attempts).toBe(1);
    expect(received.attempts).toBe(0);
  });
});
