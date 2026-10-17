// The one build fact `backend/main.ts` misses: whether this process is a **non-release dev run**.
//
// `scripts/gen-config.ts <dev|build>` writes the stamp below into the project's `resources/` with
// the mode it was asked for, and the backend reads it back at start-up. It is the same word the
// rest of the pipeline uses for the distinction (`app:dev` vs `app:build`, `docs/arquitetura.md`
// §6), read at runtime instead of compile time, which is what lets SP02 §9's dev exception exist
// without a knob a release build would honour.
//
// A release never carries it. The build stages the files its `"resources"` list names — the list
// `scripts/gen-config.ts build` writes — and this stamp is not in it, so a built app finds no stamp
// at all. Anything but the exact `dev` text is a release: the question fails closed.

/** File name of the stamp inside the app's resources folder (`docs/arquitetura.md` §6). */
export const BUILD_MODE_STAMP = 'build-mode';

/** The two modes `scripts/gen-config.ts` is run with; the stamp carries the same word. */
export type BuildMode = 'dev' | 'build';

/**
 * The mode a stamp's text names, or `null` when it names neither — no stamp at all, junk, a file
 * from another rule, or a stamp a release staged by accident. `null` is a release build.
 */
export function stampMode(text: string): BuildMode | null {
  const value = text.trim();
  return value === 'dev' || value === 'build' ? value : null;
}
