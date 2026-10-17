// Fake tools for the smoke: local servers standing in for the internal tools, the identity
// provider, and one tool whose origin is not in the seed. Everything binds 127.0.0.1 on an
// ephemeral port (`port: 0`), so the smoke needs neither external network nor a fixed port.
//
// A: form login (entry `tool-a`), `/icon.png` serves the 1x1 PNG used as the tool icon.
// B: no login, plus the `/sso` view that leaves for the provider and comes back (`tool-b`).
// C: form login with the same shape as A, but its origin is NOT in the seed, so the runtime gate
//    does not allow `login.report` for it. It counts every `POST /login` it receives and serves
//    the counter at `GET /stats` (login-loop regression, step 10 of the smoke).
// Provider: only the SSO round trip; it never calls the Nod API.
//
// USERNAME/SECRET_A are the same pair `test/smoke/smoke.html` writes to the vault.

/** Credentials server A accepts — the same pair `test/smoke/smoke.html` saves in the vault. */
export const USERNAME = 'person@test';
export const SECRET_A = 'secret-a';

export interface Tools {
  originA: string;
  originB: string;
  originC: string;
  originProvider: string;
  stop(): void;
}

// Valid 1x1 RGBA PNG (70 bytes: signature + IHDR + IDAT + IEND). Fixed bytes in the file —
// server A serves this as the tool icon.
const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const PNG_1X1 = Buffer.from(PNG_1X1_BASE64, 'base64');

function page(title: string, body: string, head = ''): Response {
  return new Response(
    `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}</body></html>\n`,
    { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
  );
}

function redirect(status: number, location: string, cookie?: string): Response {
  const headers: Record<string, string> = { location: location, 'cache-control': 'no-store' };
  if (cookie) headers['set-cookie'] = cookie;
  return new Response(null, { status, headers });
}

function notFound(): Response {
  return new Response('not found\n', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

/** `true` when the Cookie header carries exactly this pair (`session=ok`). */
function hasCookie(req: Request, pair: string): boolean {
  const raw = req.headers.get('cookie') ?? '';
  return raw.split(';').some((part) => part.trim() === pair);
}

/** Login form of A and C: the `<link rel="icon">` is what makes A's probe find the PNG. */
function loginPage(tool: 'A' | 'C'): Response {
  return page(
    `Tool ${tool} · Test`,
    `<h1>Sign in to Tool ${tool}</h1>` +
      '<form method="post" action="/login">' +
      '<input type="text" name="username" autocomplete="username" placeholder="username">' +
      '<input type="password" name="password" autocomplete="current-password" placeholder="password">' +
      '<button type="submit">Sign in</button>' +
      '</form>',
    tool === 'A' ? '<link rel="icon" href="/icon.png">' : '',
  );
}

/**
 * A free loopback port: bound once and released, for the host (`PORT` refuses 0) and for each app
 * launch — a fixed port could be held by a process a previous smoke left behind, and then the page
 * would be served by the wrong instance.
 */
export function freePort(): number {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('ok') });
  const port = server.port;
  server.stop(true);
  return port;
}

/** Starts A, B, C and the provider; returns their origins and how to stop them. */
export function startTools(): Tools {
  // The four origins only exist after the bind (ephemeral port), but the handlers only run when
  // someone calls — so reading them through the closure is safe.
  let originA = '';
  let originB = '';
  let originC = '';
  let originProvider = '';

  const providerServer = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/authorize') {
        const back = url.searchParams.get('return') ?? '';
        if (!back.startsWith(`${originB}/`)) {
          return new Response('invalid return\n', {
            status: 400,
            headers: { 'content-type': 'text/plain; charset=utf-8' },
          });
        }
        return redirect(302, back);
      }
      return notFound();
    },
  });
  originProvider = `http://127.0.0.1:${providerServer.port}`;

  const serverB = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/') return page('Tool B · Test', '<h1>B is open</h1>');
      if (url.pathname === '/sso') {
        if (hasCookie(req, 'sso=ok')) return redirect(303, '/panel');
        const back = encodeURIComponent(`${originB}/sso/back`);
        return redirect(302, `${originProvider}/authorize?return=${back}`);
      }
      if (url.pathname === '/sso/back') {
        return redirect(303, '/panel', 'sso=ok; Path=/');
      }
      if (url.pathname === '/panel') {
        if (hasCookie(req, 'sso=ok')) return page('Panel B · Test', '<h1>panel B</h1>');
        return redirect(303, '/sso');
      }
      return notFound();
    },
  });
  originB = `http://127.0.0.1:${serverB.port}`;

  const serverA = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/icon.png') {
        return new Response(PNG_1X1, {
          headers: {
            'content-type': 'image/png',
            'content-length': String(PNG_1X1.byteLength),
            'cache-control': 'no-store',
          },
        });
      }
      if (url.pathname === '/login' && req.method === 'POST') {
        const body = new URLSearchParams(await req.text());
        if (body.get('username') === USERNAME && body.get('password') === SECRET_A) {
          return redirect(303, '/', 'session=ok; Path=/');
        }
        return loginPage('A');
      }
      if (url.pathname === '/') {
        if (hasCookie(req, 'session=ok')) return page('Tool A · Test', '<h1>signed in to A</h1>');
        return loginPage('A');
      }
      return notFound();
    },
  });
  originA = `http://127.0.0.1:${serverA.port}`;

  // C never accepts a login: it only has to be filled once (wrong secret) and count the attempt.
  let logins = 0;
  const serverC = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/stats') {
        return new Response(JSON.stringify({ posts: logins }) + '\n', {
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            'access-control-allow-origin': '*',
          },
        });
      }
      if (url.pathname === '/login' && req.method === 'POST') {
        await req.text();
        logins += 1;
        return loginPage('C');
      }
      if (url.pathname === '/') return loginPage('C');
      return notFound();
    },
  });
  originC = `http://127.0.0.1:${serverC.port}`;

  return {
    originA,
    originB,
    originC,
    originProvider,
    stop(): void {
      serverA.stop(true);
      serverB.stop(true);
      serverC.stop(true);
      providerServer.stop(true);
    },
  };
}
