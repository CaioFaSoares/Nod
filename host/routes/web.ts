// E04's M1 portal (RF-73–RF-76, `docs/canonico.md` §22 "Web Nod", `docs/epics/E04-web-nod.md` §9):
// the browser version of the Nod the host serves on its own address when `WEB_UI` is on — the same
// port the app syncs through (SP07 §2's `NOD_PORT`), one origin, no CORS.
//
// What the portal is not, on purpose (E04 §2's table): no vault, no shares, no autofill, no docked
// tabs, no admin screens. It lists and organizes; the tools still decide who gets in.
//
// The session is a cookie, not a bearer (RF-74): `HttpOnly` so the page's JavaScript never reads it,
// `SameSite=Strict` with an `Origin` check on every write (RF-76), one `sessions` row like the app's
// — os `web` in the account's devices, revoked from there or by the portal's own sign-out. The
// password never travels (RF-75): the page derives `authKey` with the same `shared/auth.ts` the app
// uses and sends only that, and the sign-in pays SP02 §5's address and email budgets.
//
// Nothing here stores or logs a secret: the `authKey` is hashed as it arrives (SP02 §2), the token
// lives in the cookie alone and only its SHA-256 in the row (SP02 §5), and no request body is
// logged (`host/context.md`).

import { Elysia, status, t } from 'elysia';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type Device } from '../../shared/host-api';
import {
  AUTH_KEY_PATTERN,
  INVALID_CREDENTIALS,
  TOO_MANY_ATTEMPTS,
  callerOf,
  clientAddress,
  hostOf,
  type HostContext,
} from '../auth';
import { GUILD_NAME_ENV, type HostConfig } from '../config';
import { entryOf, personalViewOf, snapshotSource } from '../snapshot';

// ---------------------------------------------------------------- the page's files

/**
 * The portal's whole surface, by request path: the vite build of `web/` writes exactly these names
 * (`web/vite.config.ts` pins them), so the map is the allowlist — no requested path is ever turned
 * into a file name, and anything else is the host's own 404.
 */
const ASSETS: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
};

/** E04 §3's hardening: the strict CSP the page is served under. */
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; " +
  "img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

/**
 * The portal's directory: `host/public`, the vite build of `web/` — beside the code it is served
 * by, never inside the data dir. A test passes its own so no test reads or writes the real one.
 */
export function defaultWebDir(): string {
  return join(import.meta.dir, '..', 'public');
}

// ---------------------------------------------------------------- cookie and origin

/** RF-74: the one cookie the portal sets. The token is base64url, so no quoting is needed. */
const COOKIE_NAME = 'nod_web';

function sessionCookie(token: string, dev: boolean): string {
  // E04 §3: `Secure` outside dev — a deployment serves the portal through the same TLS proxy the
  // app's address pins (SP07 §2), and dev is loopback's plain `http://`.
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict${dev ? '' : '; Secure'}`;
}

function clearedCookie(dev: boolean): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict${dev ? '' : '; Secure'}; Max-Age=0`;
}

/** The token of this request's cookie, or null — never a signal of which one was wrong. */
function cookieToken(request: Request): string | null {
  const header = request.headers.get('cookie');
  if (header === null) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    if (part.slice(0, separator).trim() === COOKIE_NAME) {
      const value = part.slice(separator + 1).trim();
      return value === '' ? null : value;
    }
  }
  return null;
}

/**
 * RF-76: `Origin` must be this host's own address when the browser sends it. Absent is allowed —
 * a browser always sends `Origin` on a cross-site POST, so an attacker's request cannot lose the
 * header, and a non-browser caller has no cookie to ride (E04 §3's `SameSite` plus this check).
 *
 * "Own address" is two things: the request's own scheme and host (direct, and dev), and the origin
 * of `NOD_PUBLIC_URL` — behind the TLS proxy (SP07 §2, §6) the host sees plain `http://` while the
 * browser's `Origin` is the proxy's `https://` address, so the request's scheme alone refused every
 * production sign-in with `origin refused`.
 */
function originAllowed(request: Request, publicUrl: string): boolean {
  const origin = request.headers.get('origin');
  if (origin === null) return true;
  const url = new URL(request.url);
  return origin === `${url.protocol}//${url.host}` || origin === new URL(publicUrl).origin;
}

// ---------------------------------------------------------------- the routes

/** The `sessions` device a web sign-in is (RF-74): the portal itself, named honestly. */
const WEB_DEVICE: Device = { name: 'Web portal', os: 'web', appVersion: 'web' };

const emailSchema = t.String({ minLength: 1, maxLength: 320 });
const authKeySchema = t.String({ pattern: AUTH_KEY_PATTERN });
const loginBody = t.Object({ email: emailSchema, authKey: authKeySchema });

/**
 * What this file reads off the request context — the same cast rule as `hostOf`, with the two
 * decorations `host/app.ts` adds and this plugin's own caller.
 */
type WebContext = HostContext & { config: HostConfig };

function webOf(ctx: unknown): WebContext {
  return ctx as WebContext;
}

/** SP02 §5's one message and one rate-limit answer, the portal's too. */
function rateLimited() {
  return status(429, { error: TOO_MANY_ATTEMPTS });
}

/**
 * The portal's own caller guard, mirroring `personAuth` with the cookie instead of the bearer: a
 * live `sessions` row of a person who is not disabled, slid forward on every authenticated request.
 */
const webCaller = new Elysia({ name: 'host-web-caller' }).derive('plugin', async (ctx) => {
  const { auth, request } = hostOf(ctx);
  const token = cookieToken(request);
  const caller = token === null ? null : await auth.authenticate(token);
  if (caller === null) return status(401, { error: INVALID_CREDENTIALS });
  return { person: caller.person, session: caller.session };
});

/**
 * SP02 §5's address budget for this group, nested the way the auth group nests its own: the hook
 * covers this file's routes and stops there, so the API groups keep their own budgets.
 */
const addressLimit = new Elysia({ name: 'host-web-address-limit' }).onBeforeHandle(
  'plugin',
  (ctx) => {
    const { auth, request } = webOf(ctx);
    const address = clientAddress(request, ctx.server?.requestIP(request)?.address ?? null);
    if (!auth.limiter.allowAddress(address)) return rateLimited();
  },
);

export function webRoutes(deps: { webDir?: string }) {
  const webDir = deps.webDir ?? defaultWebDir();

  /** The page and its assets, with the hardening headers E04 §3 asks for. */
  const asset = (path: string): Response | null => {
    const found = ASSETS[path];
    if (found === undefined) return null;
    const file = join(webDir, found.file);
    if (!existsSync(file)) return null;
    return new Response(readFileSync(file), {
      status: 200,
      headers: {
        'content-type': found.type,
        'cache-control': 'no-store',
        'content-security-policy': CSP,
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
      },
    });
  };

  const notFound = () => status(404, { error: 'not found' });

  return new Elysia({ name: 'host-web-routes' })
    .use(addressLimit)

    .get('/', () => {
      const page = asset('/');
      return page === null ? notFound() : page;
    })
    .get('/index.html', () => {
      const page = asset('/index.html');
      return page === null ? notFound() : page;
    })
    .get('/app.js', () => {
      const file = asset('/app.js');
      return file === null ? notFound() : file;
    })
    .get('/style.css', () => {
      const file = asset('/style.css');
      return file === null ? notFound() : file;
    })

    // RF-73/RF-75: the browser signs in with the `authKey` its page derived from the host's salt
    // (`shared/auth.ts`, the same derivation the app's backend runs). The answer is the cookie
    // alone — no token in a body a script could read.
    .post('/web/api/login', { body: loginBody }, async (ctx) => {
      const { repo, auth, config, request } = webOf(ctx);
      if (!originAllowed(request, config.publicUrl)) return status(403, { error: 'origin refused' });
      const email = ctx.body.email.trim().toLowerCase();
      if (!auth.limiter.allowEmail(email)) return rateLimited();

      const person = await auth.verify(email, ctx.body.authKey);
      // One answer for a wrong key and an email that exists nowhere (SP02 §4), and the disabled
      // person is as dead here as in the app's routes (SP01 §2 revoked their sessions).
      if (person === null || person.disabledAt !== null) {
        auth.limiter.failEmail(email);
        return status(401, { error: INVALID_CREDENTIALS });
      }

      const token = auth.newToken();
      repo.createSession(
        {
          id: crypto.randomUUID(),
          personId: person.id,
          tokenHash: await auth.tokenHash(token),
          device: WEB_DEVICE,
        },
        auth.now(),
      );
      return new Response(null, { status: 204, headers: { 'set-cookie': sessionCookie(token, config.dev) } });
    })

    // Below this line the caller is the cookie's live session.
    .use(webCaller)

    // RF-74: the portal's sign-out revokes this session row, exactly like the app's own logout.
    .post('/web/api/logout', (ctx) => {
      const { repo, auth, config, request } = webOf(ctx);
      if (!originAllowed(request, config.publicUrl)) return status(403, { error: 'origin refused' });
      const { session } = callerOf(ctx);
      repo.revokeOwnSession(session.personId, session.id, auth.now());
      return new Response(null, { status: 204, headers: { 'set-cookie': clearedCookie(config.dev) } });
    })

    // What the page's header draws: the guild's name and the signed-in person. Nothing else of the
    // person row travels — the host's private columns stay in the repo (`host/snapshot.ts`).
    .get('/web/api/me', (ctx) => {
      const { person } = callerOf(ctx);
      return {
        guild: process.env[GUILD_NAME_ENV]?.trim() ?? '',
        name: person.name,
        email: person.email,
        admin: person.admin,
      };
    })

    // The granted catalog, built by `snapshotSource` so the selection is the repo's own rule —
    // the admin sees every org tool, a member the ones their roles are granted (SP04 §2) — and
    // the mapping is the one the signed snapshot travels through. Favorites are the row's ids,
    // the same ids the app's own star writes. The roster and the guild's roles ride along for
    // RF-79's organization views: they carry no email and no key (SP04 §2's `SnapshotPerson`),
    // and the web draws who reaches what exactly as the app does.
    .get('/web/api/catalog', (ctx) => {
      const { repo } = webOf(ctx);
      const { person } = callerOf(ctx);
      const source = snapshotSource(repo, person);
      return {
        favorites: source.favorites,
        orgTools: source.orgTools.map(entryOf),
        personalTools: source.personalTools.map(entryOf),
        personalViews: source.personalViews.map(personalViewOf),
        roles: source.roles,
        people: source.people,
      };
    });
}
