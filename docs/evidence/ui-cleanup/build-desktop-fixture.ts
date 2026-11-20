import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

// Isolated browser layout evidence only, never a replacement for the Electrobun runtime.
const [rootArgument, outputArgument] = process.argv.slice(2);
if (!rootArgument || !outputArgument) throw new Error('Usage: bun build-desktop-fixture.ts <repository> <output-directory>');
const root = resolve(rootArgument);
const out = resolve(outputArgument);
const assets = join(root, 'dist/assets');
const cssNames = (await readdir(assets)).filter(name => name.endsWith('.css'));
if (cssNames.length !== 1) throw new Error(`Expected one production desktop CSS asset, got ${cssNames.length}`);
const cssPath = join(assets, cssNames[0]!);
const originalCSS = await readFile(cssPath, 'utf8');
let css = originalCSS;
const fonts: Array<{ path: string; sha256: string }> = [];
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
for (const match of originalCSS.matchAll(/url\(([^)]+\.woff2)\)/g)) {
  const url = match[1]!.replace(/^["']|["']$/g, '');
  const path = join(assets, basename(url));
  const data = await readFile(path);
  fonts.push({ path, sha256: hash(data) });
  css = css.replace(match[0], `url(data:font/woff2;base64,${data.toString('base64')})`);
}
if (fonts.length !== 8) throw new Error(`Expected all eight bundled Rubik faces, got ${fonts.length}`);
const build = await Bun.build({ entrypoints: [join(root, 'src/app.ts')], target: 'browser', format: 'iife', minify: false, write: false });
if (!build.success || build.outputs.length !== 1) throw new Error(String(build.logs));
const js = await build.outputs[0]!.text();
await mkdir(out, { recursive: true });
await writeFile(join(out, 'app.js'), js);
await writeFile(join(out, 'style.css'), css);
for (const name of ['tiny-fixture.js', 'measure.js']) await copyFile(join(import.meta.dir, name), join(out, name));
await writeFile(join(out, 'provenance.json'), JSON.stringify({
  purpose: 'Isolated desktop layout fixture only; not runtime, backend, auth, or accessibility acceptance evidence',
  createdAt: new Date().toISOString(),
  source: { path: join(root, 'src/app.ts'), sha256: hash(await readFile(join(root, 'src/app.ts'))) },
  productionCSS: { path: cssPath, sha256: hash(originalCSS) },
  bundledFonts: fonts,
  fixture: { jsSHA256: hash(js), cssWithEmbeddedFontsSHA256: hash(css) },
  bun: Bun.version,
}, null, 2) + '\n');
console.log(`Fixture: ${js.length} JS chars; ${css.length} CSS chars; ${fonts.length} embedded fonts; ${out}`);
