// Login cascade: the fixed order for entering a tool (canonico §8, §11).
// Takes a navigation signal (`navigated`, `finished`) or the adapter report (`report`) and says the
// next step. Pure logic — no `tjs`, no `tiny`, no DOM; the state belongs to the caller.
// Signatures: docs/arquitetura.md §3.

import type { LoginResult, ReportState } from './types';

export interface CascadeState {
  origin: string;
  attempts: number;
  leftOrigin: boolean;
  result: LoginResult | null;
}

export type CascadeSignal =
  | { type: 'navigated'; url: string } // policy/start of the main frame, including each redirect hop
  | { type: 'finished'; url: string } // main-frame load finished (or a re-check timer)
  | { type: 'report'; state: ReportState };

export type CascadeAction =
  | { type: 'none' }
  | { type: 'inject'; fill: boolean }
  | { type: 'result'; result: LoginResult };

export function newCascade(origin: string): CascadeState {
  return { origin, attempts: 0, leftOrigin: false, result: null };
}

/**
 * One cascade step. Never mutates `s`: returns the next state and the action to run.
 * Numbered rules of docs/arquitetura.md §3 (canonico §8, §11).
 */
export function stepCascade(
  s: CascadeState,
  signal: CascadeSignal,
  ctx: { hasCredential: boolean; noFill: boolean },
): { state: CascadeState; action: CascadeAction } {
  // 1. The cascade stops at the first step that resolves.
  if (s.result !== null) return { state: s, action: { type: 'none' } };

  // 2. Landing outside the entry origin: mark that it left and never inject outside the origin.
  //    The runtime asks the policy on every redirect hop, so `navigated` sees hops whose document
  //    never loads. An invalid URL has no origin (`''`), which never matches the validated origin
  //    of an entry (`shared/catalog.ts`) and therefore counts as a different origin.
  if (signal.type !== 'report') {
    let landed = '';
    try {
      landed = new URL(signal.url).origin;
    } catch {
      // Invalid URL: `landed` stays `''`.
    }
    if (landed !== s.origin) {
      return { state: { ...s, leftOrigin: true }, action: { type: 'none' } };
    }
  }

  // 3. A navigation inside the origin is not an action.
  if (signal.type === 'navigated') return { state: s, action: { type: 'none' } };

  // 4. Landing on the origin: the adapter fills only on the first attempt, with a credential and
  //    without the `noFill` override. The attempt counts when the fill is made, not when it is
  //    reported — a fill that is never reported can never become a second fill (the login-loop fix).
  if (signal.type === 'finished') {
    const fill = ctx.hasCredential && !ctx.noFill && s.attempts === 0;
    return {
      state: fill ? { ...s, attempts: s.attempts + 1 } : s,
      action: { type: 'inject', fill },
    };
  }

  // 5. No login form: the provider resolved it when the cascade left the origin; otherwise there
  //    was already a session — or the previous submit went through.
  if (signal.state === 'no-form') {
    const result: LoginResult = s.leftOrigin ? 'provider' : s.attempts > 0 ? 'filled' : 'session';
    return { state: { ...s, result }, action: { type: 'result', result } };
  }

  // 6. The form was filled and submitted: wait for the next `finished`.
  if (signal.state === 'filled') return { state: s, action: { type: 'none' } };

  // 7. There is a form and it was not filled: the first time is manual; after a fill the adapter
  //    missed the form it had already touched, which is a failure.
  if (signal.state === 'form') {
    const result: LoginResult = s.attempts > 0 ? 'failed' : 'manual';
    return { state: { ...s, result }, action: { type: 'result', result } };
  }

  // 8. The adapter threw.
  return { state: { ...s, result: 'failed' }, action: { type: 'result', result: 'failed' } };
}
