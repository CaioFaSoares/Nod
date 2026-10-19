// Keyboard shortcuts: the sidebar digit map and the global combo (canonico §7).
// Pure logic — no `tjs`, no `tiny`, no DOM. Signatures: docs/arquitetura.md §3.

import type { Id } from './types';

/** Digit → id map in the given order: 1..9; the tenth id onward is ignored (canonico §7). */
export function digits(ids: Id[]): Map<number, Id> {
  const map = new Map<number, Id>();
  for (let i = 0; i < ids.length && i < 9; i++) map.set(i + 1, ids[i]);
  return map;
}

/** Global shortcut: 'cmd+<key>' on macOS, 'ctrl+<key>' elsewhere (canonico §7). */
export function combo(key: string, os: 'macos' | 'windows' | 'linux'): string {
  return (os === 'macos' ? 'cmd+' : 'ctrl+') + key.toLowerCase();
}

/**
 * E03 (RF-51): the same, with Shift — ⌘⇧D on macOS, Ctrl+⇧D elsewhere. The platform modifier
 * stays the platform's (`combo`), which is the part a person reads on the tab strip.
 */
export function shiftCombo(key: string, os: 'macos' | 'windows' | 'linux'): string {
  return (os === 'macos' ? 'cmd+shift+' : 'ctrl+shift+') + key.toLowerCase();
}

/**
 * E03 (RF-49): the runtime's *Control* chord, which is Control on every OS — what ⌃Tab and ⌃⇧Tab
 * are registered with (`backend/tiny.d.ts` `hotkey.register`, combos like 'cmd+shift+k'). Not
 * `combo`: there the modifier follows the platform, and ⌃Tab is Control everywhere.
 */
export function ctrlCombo(key: string, shift = false): string {
  return (shift ? 'ctrl+shift+' : 'ctrl+') + key.toLowerCase();
}
