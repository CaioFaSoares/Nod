// Network side of assisted registration (canonico §8, RF-29; docs/arquitetura.md §4).
// Only the network lives here: fetch the page, read the HTML up to 2 MiB and try the icons up to
// 512 KiB. Interpreting what came back is `shared/probe.ts` (pure, no `fetch`, tested with bun).
import { originOf } from '../shared/catalog';
import { analyzeHtml, detectProvider, iconType } from '../shared/probe';
import { bytesToBase64 } from './icons';
import type { Probe, RawIcon } from '../shared/types';

const HTML_LIMIT = 2 * 1024 * 1024;
const ICON_LIMIT = 512 * 1024;
const TIMEOUT_MS = 10_000;

export async function probe(url: string): Promise<Probe> {
  // An address outside https (or loopback) fails here, with the message from `shared/catalog`.
  const origin = originOf(url);
  const page = await fetchPage(url);
  const analysis = analyzeHtml(page.html, page.url);

  return {
    url,
    origin,
    finalUrl: page.url,
    title: analysis.title,
    icon: await firstIcon(analysis.icons),
    hasLoginForm: analysis.hasLoginForm,
    provider: detectProvider(origin, page.url),
  };
}

interface Page {
  url: string;
  html: string;
}

async function fetchPage(address: string): Promise<Page> {
  try {
    return await withDeadline(async (deadline): Promise<Page> => {
      const response = await fetch(address, { redirect: 'follow' });
      const url = response.url === '' ? address : response.url;
      return { url, html: await readText(response, HTML_LIMIT, deadline) };
    });
  } catch (error) {
    throw new Error(`couldn't open the address: ${reason(error)}`);
  }
}

/**
 * Runs `work` under a 10 s deadline. The runtime's `fetch` is not documented to take an
 * AbortSignal (`TinyFetchInit` in `backend/tiny.d.ts` has no `signal`), so the deadline is a timer
 * racing the promise plus a timestamp the read loops check — the reads stop instead of hanging.
 */
async function withDeadline<T>(work: (deadline: number) => Promise<T>): Promise<T> {
  const deadline = Date.now() + TIMEOUT_MS;
  let expire: (error: Error) => void = () => undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    expire = reject;
  });
  const timer = setTimeout(() => expire(new Error('timed out')), TIMEOUT_MS);
  try {
    return await Promise.race([work(deadline), expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** Reads the body as text, stopping at the limit or at the deadline: the rest is abandoned. */
async function readText(response: Response, limit: number, deadline: number): Promise<string> {
  const body = response.body;
  if (body === null) return (await response.text()).slice(0, limit);

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let html = '';
  let total = 0;
  try {
    while (total < limit) {
      if (Date.now() > deadline) throw new Error('timed out');
      const step = await reader.read();
      if (step.done) break;
      const rest = limit - total;
      const chunk = step.value.byteLength > rest ? step.value.subarray(0, rest) : step.value;
      html += decoder.decode(chunk, { stream: true });
      total += chunk.byteLength;
    }
  } finally {
    await cancel(reader);
  }
  return html + decoder.decode();
}

/** The first icon the probe accepts; the rest are never downloaded. */
async function firstIcon(urls: string[]): Promise<RawIcon | null> {
  for (const url of urls) {
    if (!/^https?:/i.test(url)) continue; // an icon only travels over http(s)
    const icon = await fetchIcon(url);
    if (icon !== null) return icon;
  }
  return null;
}

async function fetchIcon(url: string): Promise<RawIcon | null> {
  try {
    return await withDeadline(async (deadline): Promise<RawIcon | null> => {
      const response = await fetch(url, { redirect: 'follow' });
      // `iconType` refuses ICO and anything that is not a known image; the next one is tried then.
      const type = iconType(url, response.headers.get('content-type'));
      if (type === null) return null;
      const bytes = await readBytes(response, ICON_LIMIT, deadline);
      return bytes === null ? null : { type, base64: bytesToBase64(bytes) };
    });
  } catch {
    return null; // the icon is decoration: whatever fails here does not sink the probe
  }
}

/** Body bytes, or `null` when it goes over the limit (not even the excess is read to the end). */
async function readBytes(
  response: Response,
  limit: number,
  deadline: number,
): Promise<Uint8Array | null> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) return null;

  const body = response.body;
  if (body === null) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.byteLength > limit ? null : bytes;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (Date.now() > deadline) throw new Error('timed out');
      const step = await reader.read();
      if (step.done) break;
      total += step.value.byteLength;
      if (total > limit) return null;
      chunks.push(step.value);
    }
  } finally {
    await cancel(reader);
  }

  const bytes = new Uint8Array(total);
  let position = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, position);
    position += chunk.byteLength;
  }
  return bytes;
}

async function cancel(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // body already read to the end (or the runtime does not cancel): nothing to do
  }
}

function reason(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'unknown error';
}
