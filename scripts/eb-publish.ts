// Produces the macOS half of a release's `manifest.json` from the Electrobun build: the built
// `Nod.app` zipped under the name `tinyjs publish` uses for the same architecture
// (`nod-<v>-macos-<arch>.zip`), its sha256, and a `mac.<arch>` entry — the shape every Nod reads
// (`electrobun/bun/facade/update.ts`), and the one the tinyjs runtime on a 0.6.0c Mac needs to swap
// in the Electrobun app.
//
// The release workflow runs this once per macOS runner (after `bun run eb:build` and the
// `codesign --verify --strict --deep` gate) and merges the two halves; the Windows/Linux legs copy
// the runtime's own artifacts instead. Why a zip of the `.app` and not Electrobun's own
// `artifacts/*-update.json`: that manifest has no digest and no notes, and its version decision is
// `hash !== installedHash`; the tinyjs updater on users' machines also only knows `.zip` of a
// bundle. The facade verifies the sha256, matches the bundle identity/version and swaps the bundle
// with a rollback helper of its own.
//
// One command:
//   bun scripts/eb-publish.ts build --arch <arm64|x86_64> --version <v> --base-url <url> \
//     [--notes-file <path>] [--build-root build] [--app <Nod.app>] [--out dist/publish]
//
// The pure core (`artifactName`, `downloadUrl`, `buildManifestHalf`, `releaseNotesFrom`,
// `findBuiltApp`) is what `test/eb-publish.test.ts` exercises; the CLI is the thin shell around it.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseManifest, plistString, UPDATE_ARCHES } from '../electrobun/bun/facade/update';
import type { UpdateArch, UpdateManifest } from '../electrobun/bun/facade/update';

/** The file the merge job reads from each macOS leg (`dist/publish/manifest.json`). */
const MANIFEST_NAME = 'manifest.json';

/** Release-asset prefix: `nod-<v>-macos-<arch>.zip`. */
const ARTIFACT_PREFIX = 'nod';

export function isArch(value: string): value is UpdateArch {
  return (UPDATE_ARCHES as readonly string[]).includes(value);
}

/** The three desktop platforms Electrobun builds for. */
export type ReleasePlatform = 'macos' | 'win' | 'linux';

export function isPlatform(value: string): value is ReleasePlatform {
  return value === 'macos' || value === 'win' || value === 'linux';
}

/** `x64` is the runtime's spelling; the manifest and the archives use `x86_64`. */
export function normalizeArch(value: string): UpdateArch | null {
  if (value === 'x64') return 'x86_64';
  return isArch(value) ? value : null;
}

/** The runtime's build/artifact directory spelling of an architecture. */
export function runtimeArch(arch: UpdateArch): string {
  return arch === 'x86_64' ? 'x64' : 'arm64';
}

/** `stable-<os>-<arch>-` prefix hutch gives update metadata and the update archive. */
export function runtimePrefix(platform: Exclude<ReleasePlatform, 'macos'>, arch: UpdateArch): string {
  return `stable-${platform}-${runtimeArch(arch)}-`;
}

/** `release.yml`'s version gate, the form the manifest and the tag must carry. */
export function normalizeVersion(value: string): string | null {
  const text = value.trim();
  return /^[0-9]+\.[0-9]+\.[0-9]+[a-z]*([-+][0-9A-Za-z.-]+)?$/.test(text) ? text : null;
}

export function artifactName(version: string, arch: UpdateArch): string {
  return `${ARTIFACT_PREFIX}-${version}-macos-${arch}.zip`;
}

/** `https://…/download` + `nod-….zip` → the address the manifest carries. */
export function downloadUrl(baseUrl: string, file: string): string {
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('--base-url must be http(s)');
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('--base-url must not carry credentials');
  }
  return `${baseUrl.replace(/\/+$/, '')}/${file}`;
}

/**
 * One runner's half of the release `manifest.json`: version, notes and its own `mac.<arch>` entry.
 * The merge job combines the two macOS halves; a half that does not parse as a
 * manifest (a bad digest, an empty version) is not written at all.
 */
export function buildManifestHalf(input: {
  version: string;
  notes: string;
  arch: UpdateArch;
  url: string;
  sha256: string;
}): UpdateManifest {
  const manifest = parseManifest({
    version: input.version,
    notes: input.notes,
    mac: { [input.arch]: { url: input.url, sha256: input.sha256 } },
  });
  if (manifest === null) throw new Error('the manifest half is not valid');
  return manifest;
}

/**
 * `release.yml`'s `sed '/^Merge pull request #/,/^$/d'`: GitHub's merge header (and the blank line
 * after it) is not news for anyone. A header without a following blank line drops the rest, as sed
 * does — the notes never survive a malformed commit body intact, and publishing one line of noise
 * is worse than falling back.
 */
export function stripMergeHeader(text: string): string {
  const kept: string[] = [];
  let dropping = false;
  for (const line of text.split('\n')) {
    if (!dropping && line.startsWith('Merge pull request #')) {
      dropping = true;
      continue;
    }
    if (dropping) {
      if (line === '') dropping = false;
      continue;
    }
    kept.push(line);
  }
  return kept.join('\n');
}

/**
 * The body of the `Release <version>:` commit, as release.yml publishes it; `null` when none of the
 * messages carries the header. `version` is escaped, so a pre-release such as `1.0.0-rc.1` matches
 * itself and not another commit's body.
 */
export function releaseNotesFrom(messages: readonly string[], version: string): string | null {
  // `m`: git's `--grep` matches a line, not only the body's first line (release.yml's rule).
  const pattern = new RegExp(`^Release ${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`, 'm');
  for (const message of messages) {
    if (!pattern.test(message)) continue;
    const notes = stripMergeHeader(message).trim();
    return notes === '' ? null : notes;
  }
  return null;
}

/**
 * Electrobun names its build directories `x64`, the release assets `x86_64` (the tinyjs
 * convention). The mapping stays in one place.
 */
const ELECTROBUN_ARCH: Record<UpdateArch, string> = { arm64: 'arm64', x86_64: 'x64' };

/** The one `.app` in `build/stable-macos-<arch>/` (stable builds carry no channel suffix). */
export function findBuiltApp(buildRoot: string, arch: UpdateArch): string | null {
  const directory = join(buildRoot, `stable-macos-${ELECTROBUN_ARCH[arch]}`);
  if (!existsSync(directory)) return null;
  const apps = readdirSync(directory, { withFileTypes: true }).filter(
    (entry) => entry.isDirectory() && entry.name.endsWith('.app'),
  );
  return apps.length === 1 ? join(directory, apps[0].name) : null;
}

export async function sha256File(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256');
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest('hex');
}

const ARCHIVE_SAFE_LISTING = 'Contents/Info.plist';

/**
 * `ditto -c -k --keepParent` — the same zip the tinyjs publish writes, and the one the tinyjs
 * updater extracts with `ditto -x -k` before it looks for the single `.app` it swaps.
 */
function createArchive(app: string, target: string): void {
  const result = Bun.spawnSync(['/usr/bin/ditto', '-c', '-k', '--keepParent', app, target], {
    stdout: 'ignore',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) {
    throw new Error(`ditto could not create the archive: ${result.stderr.toString().trim()}`);
  }
}

/**
 * Refuses an archive without a bundle in it: a zip of the wrong directory would publish a channel
 * whose install fails on every machine after the person waited for the download.
 */
function verifyArchive(target: string): void {
  const listing = Bun.spawnSync(['/usr/bin/unzip', '-l', target], { stdout: 'pipe', stderr: 'pipe' });
  if (listing.exitCode !== 0) {
    throw new Error(`the archive is unreadable: ${listing.stderr.toString().trim()}`);
  }
  const names = listing.stdout.toString();
  if (!names.split('\n').some((line) => line.trimEnd().endsWith(ARCHIVE_SAFE_LISTING))) {
    throw new Error(`the archive has no ${ARCHIVE_SAFE_LISTING}; was the .app built?`);
  }
}

/**
 * The bundle must already carry the version the release will claim. Electrobun writes the config's
 * version to `Resources/version.json` (what its own updater reads); the plist is the fallback, and
 * macOS may not preserve hotfix letters there.
 */
function verifyBundleVersion(app: string, version: string): void {
  let plist: string;
  try {
    plist = readFileSync(join(app, 'Contents', 'Info.plist'), 'utf8');
  } catch {
    throw new Error(`${app} is not an app bundle (no Contents/Info.plist)`);
  }
  let buildVersion: string | null = null;
  try {
    const meta = JSON.parse(readFileSync(join(app, 'Contents', 'Resources', 'version.json'), 'utf8')) as {
      version?: unknown;
    };
    buildVersion = typeof meta.version === 'string' ? meta.version : null;
  } catch {
    buildVersion = null;
  }
  const bundleVersion =
    buildVersion ??
    plistString(plist, 'CFBundleShortVersionString') ??
    plistString(plist, 'CFBundleVersion');
  if (bundleVersion === null) throw new Error(`${app} has no bundle version`);
  if (bundleVersion.replace(/^v/, '') !== version.replace(/^v/, '')) {
    throw new Error(
      `${app} says version ${bundleVersion}, but --version says ${version}; the Electrobun build must take the version from app.json`,
    );
  }
}

function gitBody(args: readonly string[]): string | null {
  const result = Bun.spawnSync(['git', ...args], { stdout: 'pipe', stderr: 'ignore' });
  if (result.exitCode !== 0) return null;
  const text = result.stdout.toString().trim();
  return text === '' ? null : text;
}

/** `--notes-file` from the workflow, or the same commit lookup release.yml does, or a last resort. */
function resolveNotes(version: string, notesFile: string | undefined): string {
  if (notesFile !== undefined) {
    const text = stripMergeHeader(readFileSync(notesFile, 'utf8')).trim();
    return text === '' ? `Nod ${version}` : text;
  }
  const matched = gitBody([
    'log',
    '-1',
    '--no-merges',
    '--extended-regexp',
    '--grep',
    `^Release ${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`,
    '--format=%B',
  ]);
  const last = gitBody(['log', '-1', '--format=%B']);
  const candidates = [matched, last].filter((value): value is string => value !== null);
  const notes = releaseNotesFrom(candidates, version) ?? stripMergeHeader(matched ?? last ?? '').trim();
  return notes === '' ? `Nod ${version}` : notes;
}

interface ParsedArgs {
  flags: Record<string, string>;
  rest: string[];
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags: Record<string, string> = {};
  const rest: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      rest.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const value = argv[index + 1];
    if (name === '' || value === undefined || value.startsWith('--')) {
      throw new Error(`${arg} needs a value`);
    }
    flags[name] = value;
    index += 1;
  }
  return { flags, rest };
}

/** A typo in a release job must fail here, not quietly publish a default. */
function checkFlags(flags: Record<string, string>, allowed: readonly string[]): void {
  for (const name of Object.keys(flags)) {
    if (!allowed.includes(name)) throw new Error(`unknown option --${name}`);
  }
}

function baseVersion(): string {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync('app.json', 'utf8')) as unknown;
  } catch {
    throw new Error('app.json is not readable here; pass --version');
  }
  const version =
    typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>).version : undefined;
  if (typeof version !== 'string') throw new Error('app.json has no version');
  return version;
}

function usage(): string {
  return [
    'usage:',
    '  bun scripts/eb-publish.ts build --platform <macos|win|linux> --arch <arm64|x86_64> --version <v> --base-url <url>',
    '    [--notes-file <path>] [--build-root build] [--app <Nod.app>] [--artifacts artifacts] [--out dist/publish]',
  ].join('\n');
}

/**
 * Copies one Windows/Linux leg's artifacts from Hutch's `artifacts/` into the publish directory.
 * The update metadata (`stable-<os>-<arch>-update.json`) and the compressed update archive
 * (`stable-<os>-<arch>-Nod.tar.zst`) are what the app's Updater reads; the installer
 * (`<os>-<arch>-Nod-Setup.*`) is what a person downloads. Every file the prefix names is copied
 * unchanged, so a new artifact from a later Hutch version is not silently dropped.
 */
function publishRuntimeArtifacts(options: {
  platform: Exclude<ReleasePlatform, 'macos'>;
  arch: UpdateArch;
  artifacts: string;
  out: string;
  version: string;
}): string[] {
  const prefix = runtimePrefix(options.platform, options.arch);
  const installPrefix = `${options.platform}-${runtimeArch(options.arch)}-`;
  const names = readdirSync(options.artifacts).filter(
    (name) => name.startsWith(prefix) || name.startsWith(installPrefix),
  );
  if (names.length === 0) {
    throw new Error(`no artifacts under ${options.artifacts} for ${options.platform}-${options.arch}`);
  }
  const updateName = `${prefix}update.json`;
  if (!names.includes(updateName)) {
    throw new Error(`missing ${updateName}; was the build a stable one?`);
  }
  if (!names.some((name) => name.startsWith(prefix) && name.endsWith('.tar.zst'))) {
    throw new Error(`missing ${prefix}Nod.tar.zst; the update archive was not built`);
  }
  const update = JSON.parse(readFileSync(join(options.artifacts, updateName), 'utf8')) as {
    version?: unknown;
  };
  if (update.version !== options.version) {
    throw new Error(`${updateName} says ${String(update.version)}, expected ${options.version}`);
  }
  const copied: string[] = [];
  for (const name of names) {
    const source = join(options.artifacts, name);
    const target = join(options.out, name);
    copyFileSync(source, target);
    copied.push(target);
  }
  return copied;
}

async function runBuild(argv: readonly string[]): Promise<void> {
  const { flags, rest } = parseArgs(argv);
  if (rest.length > 0) throw new Error(`unexpected argument: ${rest[0]}`);
  checkFlags(flags, ['platform', 'arch', 'version', 'base-url', 'notes-file', 'build-root', 'app', 'out', 'artifacts']);
  const platformFlag =
    flags.platform ?? (process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'win' : 'linux');
  if (!isPlatform(platformFlag)) throw new Error('--platform must be macos, win or linux');
  const archFlag = normalizeArch(flags.arch ?? (process.arch === 'x64' ? 'x86_64' : process.arch));
  if (archFlag === null) throw new Error(`--arch must be one of ${UPDATE_ARCHES.join(', ')} or x64`);
  const version = normalizeVersion(flags.version ?? baseVersion());
  if (version === null) throw new Error('--version must be X.Y.Z or X.Y.Z<letters>');
  const baseUrl = flags['base-url'];
  if (baseUrl === undefined) throw new Error('--base-url is required (the release download directory)');

  const out = resolve(flags.out ?? 'dist/publish');
  mkdirSync(out, { recursive: true });

  if (platformFlag !== 'macos') {
    const artifacts = resolve(flags.artifacts ?? 'artifacts');
    if (!existsSync(artifacts)) {
      throw new Error(`no ${artifacts}; run bun run eb:build first`);
    }
    const copied = publishRuntimeArtifacts({
      platform: platformFlag,
      arch: archFlag,
      artifacts,
      out,
      version,
    });
    for (const file of copied) console.log(`artifact: ${file}`);
    console.log(`platform: ${platformFlag} ${archFlag}`);
    return;
  }

  const buildRoot = resolve(flags['build-root'] ?? 'build');
  const appPath = flags.app ?? findBuiltApp(buildRoot, archFlag);
  if (appPath === null) {
    throw new Error(
      `no .app under ${join(buildRoot, `stable-macos-${ELECTROBUN_ARCH[archFlag]}`)}; run bun run eb:build first`,
    );
  }
  const app = resolve(appPath);
  verifyBundleVersion(app, version);

  const target = join(out, artifactName(version, archFlag));
  createArchive(app, target);
  verifyArchive(target);

  const sha256 = await sha256File(target);
  const notes = resolveNotes(version, flags['notes-file']);
  const manifest = buildManifestHalf({
    version,
    notes,
    arch: archFlag,
    url: downloadUrl(baseUrl, basename(target)),
    sha256,
  });
  const manifestPath = join(out, MANIFEST_NAME);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`artifact: ${target}`);
  console.log(`sha256:   ${sha256}`);
  console.log(`manifest: ${manifestPath}`);
}

async function main(): Promise<void> {
  const [command, ...argv] = process.argv.slice(2);
  if (command === 'build') return runBuild(argv);
  throw new Error(usage());
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`eb-publish: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
