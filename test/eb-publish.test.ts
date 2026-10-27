// The publish pipeline's pure core and the update facade's validation rules: what a release's
// `manifest.json` may say (the tinyjs format every Nod reads), what one macOS half of it carries,
// which notes the release text picks, and that nothing but bytes matching the published sha256 can
// be staged for install. Behavior, not wording (`test/version.test.ts` style).
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  artifactName,
  buildManifestHalf,
  downloadUrl,
  findBuiltApp,
  isArch,
  normalizeVersion,
  releaseNotesFrom,
  sha256File,
  stripMergeHeader,
} from '../scripts/eb-publish';
import {
  bundlePathOf,
  channelUrlFor,
  createUpdate,
  downloadVerified,
  extractArchive,
  helperEnv,
  infoFrom,
  INSTALL_LOG_NAME,
  isNewer,
  isTranslocatedBundle,
  parseManifest,
  plistString,
  stagedBundleMatches,
  updateArch,
} from '../electrobun/bun/facade/update';

const scratch = mkdtempSync(join(tmpdir(), 'nod-eb-publish-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);
const SHA_D = 'd'.repeat(64);
const DOWNLOAD = 'https://github.com/CaioFaSoares/Nod/releases/latest/download';
const MAC_ARM64 = `${DOWNLOAD}/nod-0.6.0d-macos-arm64.zip`;
const MAC_X86 = `${DOWNLOAD}/nod-0.6.0d-macos-x86_64.zip`;

/** What `release.yml` publishes, byte for byte: the tinyjs format with the macOS blocks on top. */
const RELEASE_MANIFEST = {
  version: '0.6.0d',
  notes: 'The release notes.',
  url: MAC_ARM64,
  sha256: SHA_A,
  mac: {
    arm64: { url: MAC_ARM64, sha256: SHA_A },
    x86_64: { url: MAC_X86, sha256: SHA_B },
  },
  win: { url: `${DOWNLOAD}/nod-0.6.0d-win.zip`, sha256: SHA_C, version: '0.6.0d' },
  linux: {
    x86_64: { url: `${DOWNLOAD}/nod-0.6.0d-linux-x86_64.tar.gz`, sha256: SHA_D },
    arm64: { url: `${DOWNLOAD}/nod-0.6.0d-linux-arm64.tar.gz`, sha256: SHA_D },
    notes: 'Linux notes.',
  },
};

function half(
  arch: 'arm64' | 'x86_64',
  overrides: { version?: string; notes?: string; url?: string; sha256?: string } = {},
) {
  return buildManifestHalf({
    version: overrides.version ?? '0.6.0d',
    notes: overrides.notes ?? 'The release notes.',
    arch,
    url: overrides.url ?? (arch === 'arm64' ? MAC_ARM64 : MAC_X86),
    sha256: overrides.sha256 ?? (arch === 'arm64' ? SHA_A : SHA_B),
  });
}

describe('release naming', () => {
  test('versions are the form the release tag carries', () => {
    expect(normalizeVersion('0.6.0c')).toBe('0.6.0c');
    expect(normalizeVersion('1.2.3')).toBe('1.2.3');
    expect(normalizeVersion('1.0.0-rc.1')).toBe('1.0.0-rc.1');
    expect(normalizeVersion('1.0.0+build.7')).toBe('1.0.0+build.7');
    expect(normalizeVersion(' 0.6.0a ')).toBe('0.6.0a');
    expect(normalizeVersion('v0.6.0')).toBeNull();
    expect(normalizeVersion('0.6')).toBeNull();
    expect(normalizeVersion('release-0.6.0')).toBeNull();
    expect(normalizeVersion('')).toBeNull();
  });

  test('the artifact carries the tinyjs mac zip name, per arch', () => {
    expect(artifactName('0.6.0d', 'arm64')).toBe('nod-0.6.0d-macos-arm64.zip');
    expect(artifactName('0.6.0d', 'x86_64')).toBe('nod-0.6.0d-macos-x86_64.zip');
    expect(isArch('arm64')).toBe(true);
    expect(isArch('x86_64')).toBe(true);
    expect(isArch('x64')).toBe(false);
    expect(isArch('universal')).toBe(false);
  });

  test('the download address is the base directory plus the file', () => {
    const base = 'https://github.com/CaioFaSoares/Nod/releases/latest/download';
    expect(downloadUrl(base, 'nod-0.6.0d-macos-arm64.zip')).toBe(`${base}/nod-0.6.0d-macos-arm64.zip`);
    expect(downloadUrl(`${base}/`, 'a.zip')).toBe(`${base}/a.zip`);
    expect(() => downloadUrl('ftp://example.com/x', 'a')).toThrow();
    expect(() => downloadUrl('https://user:pass@example.com/x', 'a')).toThrow();
  });
});

describe('the release manifest.json', () => {
  test('a macOS runner writes one arch half with the release notes', () => {
    expect(half('arm64')).toEqual({
      version: '0.6.0d',
      notes: 'The release notes.',
      mac: { arm64: { url: MAC_ARM64, sha256: SHA_A } },
    });
    expect(() =>
      buildManifestHalf({ version: '0.6.0d', notes: 'x', arch: 'arm64', url: MAC_ARM64, sha256: 'abc' }),
    ).toThrow();
    expect(() =>
      buildManifestHalf({ version: '0.6.0d', notes: 'x', arch: 'arm64', url: 'ftp://x/a', sha256: SHA_A }),
    ).toThrow();
  });

  test('the tinyjs blocks and the legacy top-level url are carried, not refused', () => {
    const manifest = parseManifest(RELEASE_MANIFEST);
    expect(manifest).not.toBeNull();
    expect(manifest?.version).toBe('0.6.0d');
    expect(manifest?.notes).toBe('The release notes.');
    expect(manifest?.mac).toEqual(RELEASE_MANIFEST.mac);
    // The Windows/Linux readers' fields ride along untouched; the facade only reads `mac`.
    expect(JSON.parse(JSON.stringify(manifest))).not.toHaveProperty('win');
    expect(parseManifest(RELEASE_MANIFEST)?.mac.x86_64?.sha256).toBe(SHA_B);
  });

  test('the arch a Mac picks is its own, never the other CPU’s', () => {
    const manifest = parseManifest(RELEASE_MANIFEST);
    const arm = updateArch('darwin', 'arm64');
    const intel = updateArch('darwin', 'x64');
    expect(arm).toBe('arm64');
    expect(intel).toBe('x86_64');
    expect(arm === null ? null : manifest?.mac[arm]).toEqual({ url: MAC_ARM64, sha256: SHA_A });
    expect(intel === null ? null : manifest?.mac[intel]).toEqual({ url: MAC_X86, sha256: SHA_B });
    // A release may ship only one architecture, and notes are optional.
    expect(parseManifest({ version: '0.6.0d', mac: { x86_64: { url: MAC_X86, sha256: SHA_B } } })).toEqual({
      version: '0.6.0d',
      notes: null,
      mac: { x86_64: { url: MAC_X86, sha256: SHA_B } },
    });
  });

  test('a broken channel is refused instead of offered', () => {
    const good = { version: '0.6.0d', notes: 'n', mac: { arm64: { url: MAC_ARM64, sha256: SHA_A } } };
    expect(parseManifest(null)).toBeNull();
    expect(parseManifest([])).toBeNull();
    expect(parseManifest({ ...good, version: 'v0.6.0' })).toBeNull();
    expect(parseManifest({ ...good, version: 'latest' })).toBeNull();
    expect(parseManifest({ ...good, notes: 7 })).toBeNull();
    expect(parseManifest({ ...good, mac: {} })).toBeNull();
    expect(parseManifest({ ...good, mac: { arm64: { url: MAC_ARM64 } } })).toBeNull();
    expect(parseManifest({ ...good, mac: { arm64: { url: MAC_ARM64, sha256: 'not-a-digest' } } })).toBeNull();
    expect(parseManifest({ ...good, mac: { arm64: { url: 'ftp://example.com/a', sha256: SHA_A } } })).toBeNull();
    expect(parseManifest({ ...good, mac: { arm64: { url: 'https://u:p@example.com/a', sha256: SHA_A } } })).toBeNull();
    // A manifest with no macOS entry at all is nothing this target can install.
    expect(parseManifest({ version: '0.6.0d', win: { url: MAC_ARM64, sha256: SHA_A } })).toBeNull();
    // Unknown fields are a newer publisher's business, not a refusal.
    expect(parseManifest({ ...good, generatedAt: '2026-10-23' })?.version).toBe('0.6.0d');
  });

  test('check reads the seed url itself and never offers a non-newer version', async () => {
    const requested: string[] = [];
    const body = JSON.stringify(RELEASE_MANIFEST);
    const channel = async (url: string): Promise<Response> => {
      requested.push(url);
      return new Response(body);
    };
    const update = createUpdate({
      updateUrl: `${DOWNLOAD}/manifest.json`,
      version: '0.6.0c',
      dataDir: scratch,
      fetch: channel,
    });
    expect(await update.check()).toEqual({
      available: true,
      current: '0.6.0c',
      latest: '0.6.0d',
      notes: 'The release notes.',
    });
    expect(requested[0].startsWith(`${DOWNLOAD}/manifest.json?_=`)).toBe(true);

    const current = createUpdate({
      updateUrl: `${DOWNLOAD}/manifest.json`,
      version: '0.6.0d',
      dataDir: scratch,
      fetch: channel,
    });
    expect((await current.check()).available).toBe(false);

    const newer = createUpdate({
      updateUrl: `${DOWNLOAD}/manifest.json`,
      version: '0.6.1',
      dataDir: scratch,
      fetch: channel,
    });
    expect((await newer.check()).available).toBe(false);

    const broken = createUpdate({
      updateUrl: `${DOWNLOAD}/manifest.json`,
      version: '0.6.0c',
      dataDir: scratch,
      fetch: async () => new Response('{"version":"latest"}'),
    });
    await expect(broken.check()).rejects.toThrow();

    const offline = createUpdate({ updateUrl: null, version: '0.6.0c', dataDir: scratch });
    await expect(offline.check()).rejects.toThrow();
  });

  test('install refuses a run that is not inside an .app, before it downloads anything', async () => {
    let called = false;
    const update = createUpdate({
      updateUrl: `${DOWNLOAD}/manifest.json`,
      version: '0.6.0c',
      dataDir: scratch,
      fetch: async () => {
        called = true;
        return new Response('{}');
      },
    });
    // `bun test` runs from the Bun binary, not from a bundle: there is nothing to swap.
    expect(await update.install()).toBe(false);
    expect(called).toBe(false);
  });

  test('the channel is the seed url, validated and otherwise untouched', () => {
    expect(channelUrlFor('https://github.com/o/r/releases/latest/download/manifest.json')).toBe(
      'https://github.com/o/r/releases/latest/download/manifest.json',
    );
    expect(channelUrlFor('https://example.com/updates/manifest.json#x')).toBe(
      'https://example.com/updates/manifest.json',
    );
    expect(() => channelUrlFor('file:///tmp/manifest.json')).toThrow();
    expect(() => channelUrlFor('https://u:p@example.com/manifest.json')).toThrow();
  });
});

describe('the version decision', () => {
  test('a hotfix letter makes a release newer, and an equal one is never offered', () => {
    expect(isNewer('0.5.5', '0.5.5a')).toBe(true);
    expect(isNewer('0.5.5a', '0.5.5b')).toBe(true);
    expect(isNewer('0.5.5', '0.5.6')).toBe(true);
    expect(isNewer('0.5.5a', '0.5.5')).toBe(false);
    expect(isNewer('0.6.0d', '0.6.0d')).toBe(false);
    expect(isNewer('0.6.1', '0.6.0d')).toBe(false);
  });

  test('check answers the running version and the channel notes', () => {
    const manifest = parseManifest(RELEASE_MANIFEST);
    expect(manifest).not.toBeNull();
    if (manifest === null) return;
    expect(infoFrom(manifest, '0.6.0c')).toEqual({
      available: true,
      current: '0.6.0c',
      latest: '0.6.0d',
      notes: 'The release notes.',
    });
    expect(infoFrom(manifest, '0.6.0d').available).toBe(false);
    expect(infoFrom(manifest, '0.6.0e').available).toBe(false);
  });

  test('only macOS artifacts exist', () => {
    expect(updateArch('darwin', 'arm64')).toBe('arm64');
    expect(updateArch('darwin', 'x64')).toBe('x86_64');
    expect(updateArch('linux', 'arm64')).toBeNull();
    expect(updateArch('win32', 'x64')).toBeNull();
    expect(updateArch('darwin', 'ia32')).toBeNull();
  });
});

describe('the bundle that gets swapped', () => {
  test('the running app is found by ascending from its executable', () => {
    expect(bundlePathOf('/Applications/Nod.app/Contents/MacOS/bun')).toBe('/Applications/Nod.app');
    expect(bundlePathOf('/Users/x/Applications/My Nod.app/Contents/MacOS/bun')).toBe('/Users/x/Applications/My Nod.app');
    expect(bundlePathOf('/usr/local/bin/bun')).toBeNull();
    expect(bundlePathOf('bun')).toBeNull();
    expect(isTranslocatedBundle('/private/var/folders/x/AppTranslocation/ABC/Nod.app')).toBe(true);
    expect(isTranslocatedBundle('/Applications/Nod.app')).toBe(false);
  });

  test('the staged bundle must be the same app at the advertised version', () => {
    const running = join(scratch, 'running', 'Nod.app');
    const staged = join(scratch, 'staged', 'Nod.app');
    for (const app of [running, staged]) mkdirSync(join(app, 'Contents'), { recursive: true });
    const plist = (identifier: string, version: string): string =>
      `<?xml version="1.0"?><plist><dict><key>CFBundleIdentifier</key><string>${identifier}</string>` +
      `<key>CFBundleVersion</key><string>${version}</string></dict></plist>`;
    writeFileSync(join(running, 'Contents', 'Info.plist'), plist('copland.nod', '0.6.0d'));
    writeFileSync(join(staged, 'Contents', 'Info.plist'), plist('copland.nod', '0.6.0d'));
    expect(stagedBundleMatches(staged, running, '0.6.0d')).toBe(true);
    writeFileSync(join(staged, 'Contents', 'Info.plist'), plist('copland.other', '0.6.0d'));
    expect(stagedBundleMatches(staged, running, '0.6.0d')).toBe(false);
    writeFileSync(join(staged, 'Contents', 'Info.plist'), plist('copland.nod', '0.6.0c'));
    expect(stagedBundleMatches(staged, running, '0.6.0d')).toBe(false);
    rmSync(join(staged, 'Contents', 'Info.plist'));
    expect(stagedBundleMatches(staged, running, '0.6.0d')).toBe(false);
  });

  test('an XML plist string is read and unescaped', () => {
    const xml = '<key>CFBundleIdentifier</key><string>copland.nod&amp;dev</string>';
    expect(plistString(xml, 'CFBundleIdentifier')).toBe('copland.nod&dev');
    expect(plistString(xml, 'CFBundleVersion')).toBeNull();
  });
});

describe('the downloaded archive', () => {
  const text = 'a release archive, pretend it is 70 MB';
  const bytes = new TextEncoder().encode(text);
  const digest = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');

  const responding = (body: string, init: ResponseInit = {}): (() => Promise<Response>) =>
    async () => new Response(body, init);

  test('the bytes that hash to the published digest are accepted', async () => {
    const path = join(scratch, 'dl-ok.zip');
    expect(await downloadVerified(MAC_ARM64, path, responding(text), digest)).toBe(true);
    expect(new Bun.CryptoHasher('sha256').update(readFileSync(path)).digest('hex')).toBe(digest);
  });

  test('a single changed byte is refused', async () => {
    const path = join(scratch, 'dl-bad.zip');
    expect(await downloadVerified(MAC_ARM64, path, responding(`${text}!`), digest)).toBe(false);
    expect(await downloadVerified(MAC_ARM64, join(scratch, 'dl-bad2.zip'), responding(text), SHA_B)).toBe(false);
  });

  test('an error response, a missing digest or an absurd size never reaches the disk', async () => {
    const path = join(scratch, 'dl-none.zip');
    expect(await downloadVerified(MAC_ARM64, path, async () => new Response(null, { status: 404 }), digest)).toBe(false);
    expect(await downloadVerified(MAC_ARM64, path, responding(text), 'abc')).toBe(false);
    expect(
      await downloadVerified(MAC_ARM64, path, responding(text, { headers: { 'content-length': '999999999999' } }), digest),
    ).toBe(false);
  });
});

describe.skipIf(process.platform !== 'darwin')('unpacking the verified archive (ditto)', () => {
  const archivedApp = (name: string): string => {
    const root = join(scratch, `pack-${name}`);
    const app = join(root, 'Nod.app', 'Contents', 'MacOS');
    mkdirSync(app, { recursive: true });
    writeFileSync(join(app, 'payload.txt'), name);
    const zip = join(scratch, `pack-${name}.zip`);
    const made = Bun.spawnSync(['/usr/bin/ditto', '-c', '-k', '--keepParent', join(root, 'Nod.app'), zip]);
    expect(made.exitCode).toBe(0);
    return zip;
  };

  test('the zipped .app is unpacked with ditto, needing nothing on PATH', () => {
    const zip = archivedApp('zip');
    const destination = join(scratch, 'unpack-zip');
    mkdirSync(destination, { recursive: true });
    const saved = process.env.PATH;
    process.env.PATH = '/nonexistent';
    try {
      expect(extractArchive(zip, destination)).toBeNull();
    } finally {
      process.env.PATH = saved;
    }
    expect(readFileSync(join(destination, 'Nod.app', 'Contents', 'MacOS', 'payload.txt'), 'utf8')).toBe('zip');
  });

  test('an archive that is not a zip is refused with the reason', () => {
    const path = join(scratch, 'not-a.zip');
    writeFileSync(path, 'not a zip');
    const destination = join(scratch, 'unpack-bad');
    mkdirSync(destination, { recursive: true });
    const problem = extractArchive(path, destination);
    expect(problem).not.toBeNull();
    expect(problem ?? '').toContain('ditto');
  });
});

describe('the swap helper environment', () => {
  test('the helper is given an allowlist, never the whole environment', () => {
    const env = helperEnv({
      PATH: '/opt/homebrew/bin:/usr/bin',
      HOME: '/Users/x',
      TMPDIR: '/var/folders/t/',
      LANG: 'en_US.UTF-8',
      NOD_TOKEN: 'secret',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
    });
    expect(env.PATH).toBe('/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin');
    expect(env.HOME).toBe('/Users/x');
    expect(env.TMPDIR).toBe('/var/folders/t/');
    expect(env.LANG).toBe('en_US.UTF-8');
    expect(Object.keys(env).sort()).toEqual(['HOME', 'LANG', 'PATH', 'TMPDIR']);
    // An empty PATH still leaves the helper (and the Nod it reopens) with the tool directories.
    expect(helperEnv({}).PATH).toBe('/usr/bin:/bin:/usr/sbin:/sbin');
  });
});

describe('the install log', () => {
  const channel = (body: string): (() => Promise<Response>) => async () => new Response(body);

  test('a refusal is logged and answered by refusal(), never a silent no-op', async () => {
    const data = join(scratch, 'log-refusal');
    const update = createUpdate({
      updateUrl: 'http://127.0.0.1:1/manifest.json',
      version: '0.6.0c',
      dataDir: data,
      fetch: channel('{"version":"latest"}'),
    });
    expect(await update.install()).toBe(false);
    // The first refusal depends on the machine running the suite: on macOS `bun test` runs from the
    // Bun binary, not from a bundle, so there is nothing to swap; elsewhere (the release job's
    // ubuntu runner) there is no macOS artifact for this machine at all. Either way it is logged.
    const reason =
      process.platform === 'darwin'
        ? 'this run is not inside an .app'
        : `this machine (${process.platform}/${process.arch}) has no macOS artifact`;
    expect(update.refusal()).toContain(reason);
    const log = readFileSync(join(data, 'updates', INSTALL_LOG_NAME), 'utf8');
    expect(log).toContain('install 0.6.0c from http://127.0.0.1:1/manifest.json');
    expect(log).toContain(`refused: ${reason}`);
  });

  test('a missing channel is refused with its own reason', async () => {
    const data = join(scratch, 'log-channel');
    const update = createUpdate({ updateUrl: null, version: '0.6.0c', dataDir: data });
    expect(await update.install()).toBe(false);
    expect(update.refusal()).toContain('no update channel');
    expect(readFileSync(join(data, 'updates', INSTALL_LOG_NAME), 'utf8')).toContain(
      'refused: the seed names no update channel',
    );
  });
});

describe('release notes', () => {
  test('GitHub’s merge header is dropped', () => {
    const body = 'Merge pull request #42 from dev\n\nRelease notes go here.\n\nAnd here.';
    expect(stripMergeHeader(body)).toBe('Release notes go here.\n\nAnd here.');
    expect(stripMergeHeader('Just notes.')).toBe('Just notes.');
  });

  test('the Release <version>: commit wins over the other bodies', () => {
    expect(releaseNotesFrom(['Unrelated.', 'Release 0.6.0d: what changed.'], '0.6.0d')).toBe(
      'Release 0.6.0d: what changed.',
    );
    expect(releaseNotesFrom(['Release 0.6.10: newer.'], '0.6.1')).toBeNull();
    expect(releaseNotesFrom(['Release 1.0.0-rc.1: candidate.'], '1.0.0-rc.1')).toBe('Release 1.0.0-rc.1: candidate.');
    expect(releaseNotesFrom(['Release 1.0.0: final.'], '1.0.0-rc.1')).toBeNull();
    expect(releaseNotesFrom([], '0.6.0d')).toBeNull();
  });
});

describe('what the build left behind', () => {
  test('the built app is found by channel and arch', () => {
    const buildRoot = join(scratch, 'build');
    mkdirSync(join(buildRoot, 'stable-macos-arm64', 'Nod.app'), { recursive: true });
    // Electrobun calls the Intel build `x64`, the release asset `x86_64`; the script maps between.
    mkdirSync(join(buildRoot, 'stable-macos-x64', 'Nod.app'), { recursive: true });
    expect(findBuiltApp(buildRoot, 'arm64')).toBe(join(buildRoot, 'stable-macos-arm64', 'Nod.app'));
    expect(findBuiltApp(buildRoot, 'x86_64')).toBe(join(buildRoot, 'stable-macos-x64', 'Nod.app'));
  });

  test('the sha256 of a file is its bytes', async () => {
    const path = join(scratch, 'hashed.bin');
    writeFileSync(path, 'abc');
    expect(await sha256File(path)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(existsSync(path)).toBe(true);
  });
});
