// App identity and icon resolution for the Electrobun build. `app.json` is the one versioned file
// that carries the app's name, version, window size, URL scheme and the two media usage strings;
// `electrobun.config.ts` is generated from it by `scripts/gen-electrobun-config.ts`.
//
// The icon (RF-56) comes from `NOD_ICON`, else the private `resources/icon.png`, else the tracked
// `assets/icon.png`. `iconSource` resolves it, `assertIconPng` refuses a file the build could not
// use and `iconForConfig` (the I/O half) stages an env file inside the project. Nothing tracked is
// ever written: `docs/distribuicao.md` §9 is the owner's step by step.

/** Icon of a release nobody customised: tracked, 1024×1024. */
export const DEFAULT_ICON = 'assets/icon.png';

/** Private icon of a custom build (RF-56): dropped in place, gitignored, like the seed. */
export const PRIVATE_ICON = 'resources/icon.png';

/** Generated copy of a `NOD_ICON` PNG, read from inside the project by every OS build. */
export const STAGED_ICON = '.nod-icon.png';

/** Smallest icon the pipeline is built around: the macOS `.icns` and the Windows/Linux PNG top out at 1024. */
export const MIN_ICON_SIZE = 1024;

/** PNG signature (8 bytes), then the IHDR chunk header: its length (13) and its type. */
const PNG_HEADER = [
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
];

/** The header above plus the 4-byte width and the 4-byte height that follow it. */
const PNG_HEADER_BYTES = 24;

/** Where the build takes the app icon from (RF-56). */
export type IconSource = 'env' | 'private' | 'default' | 'none';

/**
 * App icon by precedence (RF-56): the non-empty `NOD_ICON` path, else the private
 * `resources/icon.png`, else the tracked `assets/icon.png`. `none` means no file is there and the
 * build keeps Electrobun's own default icon.
 */
export function iconSource(
  envIcon: string,
  privateIconExists: boolean,
  defaultIconExists: boolean,
): IconSource {
  if (envIcon !== '') return 'env';
  if (privateIconExists) return 'private';
  if (defaultIconExists) return 'default';
  return 'none';
}

/**
 * `icon` value the generated config names for a source: the file itself, or the staged copy for
 * `NOD_ICON`. `null` (source `none`) leaves the icon to Electrobun's own default.
 */
export function iconConfigPath(source: IconSource): string | null {
  if (source === 'none') return null;
  return source === 'env' ? STAGED_ICON : source === 'private' ? PRIVATE_ICON : DEFAULT_ICON;
}

/**
 * Refuses an icon the build could not use (RF-56). Electrobun reads this one PNG for every OS:
 * macOS converts it to an `.iconset`, Windows and Linux embed the PNG itself — so the wrong file
 * is a mistake to report here, with its path, not a release that silently ships a default or a
 * blurry icon later.
 */
export function assertIconPng(bytes: Uint8Array, source: string): void {
  if (bytes.length < PNG_HEADER_BYTES || !PNG_HEADER.every((b, i) => bytes[i] === b)) {
    throw new Error(`${source} is not a PNG: the app icon must be a PNG file (RF-56)`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width < MIN_ICON_SIZE || height < MIN_ICON_SIZE) {
    throw new Error(
      `${source} is ${width}x${height}: the app icon must be at least ` +
        `${MIN_ICON_SIZE}x${MIN_ICON_SIZE} (the macOS .icns and the Windows/Linux icon are built ` +
        'from this one image, so a smaller file only ships upscaled)',
    );
  }
}

/**
 * I/O half of RF-56: resolves the icon source, refuses a file the build could not use and stages
 * a PNG given through `NOD_ICON` as `STAGED_ICON`. Returns the icon value for the generated
 * config, or `null` when there is no file to name.
 */
export async function iconForConfig(root: string): Promise<string | null> {
  const envIcon = process.env.NOD_ICON ?? '';
  const source = iconSource(
    envIcon,
    await Bun.file(`${root}/${PRIVATE_ICON}`).exists(),
    await Bun.file(`${root}/${DEFAULT_ICON}`).exists(),
  );
  const icon = iconConfigPath(source);
  if (icon === null) return null;

  // `NOD_ICON` is read as the owner typed it, relative to where the command runs; the project's own
  // files are read from the root and named from there so the message reads `resources/icon.png`
  // and not a path with `scripts/..` in it.
  const named = source === 'env' ? envIcon : icon;
  const file = Bun.file(source === 'env' ? named : `${root}/${named}`);
  if (!(await file.exists())) throw new Error(`icon file not found: ${named}`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  assertIconPng(bytes, named);
  if (source === 'env') await Bun.write(`${root}/${icon}`, bytes);
  return icon;
}
