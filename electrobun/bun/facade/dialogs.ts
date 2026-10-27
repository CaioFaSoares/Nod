// Cross-platform file dialogs for the Electrobun target.
//
// macOS keeps the native helper's NSOpenPanel/NSSavePanel (`facade/native.ts` +
// `electrobun/native/NodNative.swift`). Windows and Linux use the runtime's own
// `Utils.openFileDialog`, which ships a native chooser on both (`package/src/native/linux/
// native_file_dialog.h`, `openFileDialog` on the Windows wrapper). Electrobun 2.x exposes no save
// panel, so a save is a directory chooser plus the file name the backend proposed: the person picks
// where the file goes, and the backend writes it there. The name is sanitised and de-duplicated so a
// page-supplied name can never escape the chosen directory or silently overwrite a file.
//
// The module takes the dialog binding as an argument: unit tests drive the name/directory rules
// without the devkit, exactly like the rest of the facade.

import { existsSync } from 'node:fs';
import { basename, extname, join } from 'node:path';

/** The one devkit call this module uses (`Utils.openFileDialog`). */
export interface DialogBindings {
  openFileDialog(options: {
    startingFolder?: string;
    allowedFileTypes?: string;
    canChooseFiles?: boolean;
    canChooseDirectory?: boolean;
    allowsMultipleSelection?: boolean;
  }): Promise<string[]>;
}

export interface DialogOptions {
  types?: readonly string[];
  title?: string;
}

export interface SaveDialogOptions extends DialogOptions {
  name?: string;
}

export interface PlatformDialogs {
  openFile(options?: DialogOptions): Promise<string | null>;
  saveFile(options?: SaveDialogOptions): Promise<string | null>;
}

/** `['.json', 'jsonl']` → `'json,jsonl'`, the comma list the devkit expects. */
export function allowedTypes(types: readonly string[] | undefined): string {
  const seen = new Set<string>();
  for (const raw of types ?? []) {
    const value = raw.trim().replace(/^\./, '');
    if (value !== '') seen.add(value);
  }
  return seen.size === 0 ? '*' : [...seen].join(',');
}

/**
 * A basename with no path separators, no `..`, no control characters and a bounded length. A name
 * with no extension takes the first allowed type, matching the native panels' behaviour.
 */
export function safeSaveName(name: string | undefined, types: readonly string[] | undefined): string {
  const base = basename((name ?? '').trim());
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[/\\]/g, '')
    .replace(/^\.+/, '')
    .trim();
  const fallback = 'export';
  let result = cleaned === '' ? fallback : cleaned;
  const first = (types ?? []).map((type) => type.trim().replace(/^\./, '')).find((type) => type !== '');
  if (first !== undefined && extname(result) === '') result = `${result}.${first}`;
  return result.slice(0, 180);
}

/** `report.txt` → `report (2).txt` when the target already exists. */
export function uniquePath(directory: string, name: string, exists = existsSync): string {
  const target = join(directory, name);
  if (!exists(target)) return target;
  const extension = extname(name);
  const stem = extension === '' ? name : name.slice(0, -extension.length);
  for (let index = 2; index < 1000; index += 1) {
    const candidate = join(directory, `${stem} (${index})${extension}`);
    if (!exists(candidate)) return candidate;
  }
  return target;
}

export function createPlatformDialogs(bindings: DialogBindings): PlatformDialogs {
  return {
    async openFile(options = {}) {
      const paths = await bindings.openFileDialog({
        allowedFileTypes: allowedTypes(options.types),
        canChooseFiles: true,
        canChooseDirectory: false,
        allowsMultipleSelection: false,
      });
      const first = paths.find((path) => typeof path === 'string' && path !== '');
      return first ?? null;
    },
    async saveFile(options = {}) {
      // A directory chooser must not carry the file filter: on Windows/Linux a filter hides the
      // folders the person needs to pick.
      const paths = await bindings.openFileDialog({
        allowedFileTypes: '*',
        canChooseFiles: false,
        canChooseDirectory: true,
        allowsMultipleSelection: false,
      });
      const directory = paths.find((path) => typeof path === 'string' && path !== '');
      if (directory === undefined) return null;
      return uniquePath(directory, safeSaveName(options.name, options.types));
    },
  };
}
