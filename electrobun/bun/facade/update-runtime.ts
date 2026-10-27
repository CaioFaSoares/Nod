// `app.update` on Windows and Linux, over Electrobun's own `Updater`.
//
// macOS keeps the facade in `update.ts`: it reads the project's `manifest.json`, verifies the
// artifact's sha256 and swaps the `.app` with a rollback helper. Windows and Linux use the runtime's
// update channel (`stable-<os>-<arch>-update.json` + `.tar.zst`, published by `electrobun build`
// and uploaded unchanged by the release job), because replacing an installed directory is the
// runtime's own platform work — a scheduled helper on Windows, an in-place swap on Linux.
//
// `check()` reads the same `manifest.json` the macOS path reads for `notes`; a release that ships
// no manifest still offers the update, with no notes. `install()` delegates download/prepare/apply
// to the runtime and answers the `TinyApp.update` contract the backend already consumes.

import type { UpdateFacade, UpdateInfo } from './update';

/** The slice of the devkit's `Updater` this facade uses; injected so tests need no devkit. */
export interface RuntimeUpdater {
  checkForUpdate(): Promise<{ version: string | null; updateAvailable: boolean }>;
  downloadUpdate(): Promise<void>;
  updateInfo(): { updateReady: boolean; error: string };
  applyUpdate(): Promise<void>;
}

export interface RuntimeUpdateOptions {
  /** The seed's `update.url` (`.../manifest.json`), or `null` when the release shipped no channel. */
  updateUrl: string | null;
  /** The running build's version. */
  version: string;
  /** The devkit's `Updater` (`electrobun/main`). */
  updater: RuntimeUpdater;
  /** Test seam; production uses the global fetch. */
  fetch?: (url: string) => Promise<Response>;
}

const MANIFEST_MAX_BYTES = 64 * 1024;

/** `{ version, notes }` out of the legacy manifest; tolerant of a release that ships only notes. */
async function readNotes(
  updateUrl: string,
  fetchFn: (url: string) => Promise<Response>,
): Promise<{ version: string | null; notes: string | null }> {
  try {
    const response = await fetchFn(updateUrl);
    if (!response.ok) return { version: null, notes: null };
    const text = await response.text();
    if (text.length > MANIFEST_MAX_BYTES) return { version: null, notes: null };
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const version = typeof parsed.version === 'string' ? parsed.version : null;
    const notes = typeof parsed.notes === 'string' && parsed.notes !== '' ? parsed.notes : null;
    return { version, notes };
  } catch {
    return { version: null, notes: null };
  }
}

export function createRuntimeUpdate(options: RuntimeUpdateOptions): UpdateFacade {
  const updater = options.updater;
  const fetchFn = options.fetch ?? ((url: string) => fetch(url));
  let lastRefusal: string | null = null;

  return {
    async check(): Promise<UpdateInfo> {
      if (options.updateUrl === null) {
        return { available: false, current: options.version, latest: null, notes: null };
      }
      try {
        const remote = await updater.checkForUpdate();
        const extra = await readNotes(options.updateUrl, fetchFn);
        return {
          available: remote.updateAvailable === true,
          current: options.version,
          latest: remote.version ?? extra.version,
          notes: extra.notes,
        };
      } catch {
        return { available: false, current: options.version, latest: null, notes: null };
      }
    },
    async install(): Promise<boolean> {
      if (options.updateUrl === null) {
        lastRefusal = 'this release has no update channel';
        return false;
      }
      lastRefusal = null;
      try {
        await updater.downloadUpdate();
        const ready = updater.updateInfo();
        if (!ready.updateReady) {
          lastRefusal = ready.error !== '' ? ready.error : 'the update could not be prepared';
          return false;
        }
        await updater.applyUpdate();
        return true;
      } catch (error) {
        lastRefusal = error instanceof Error ? error.message : String(error);
        return false;
      }
    },
    refusal: () => lastRefusal,
  };
}
