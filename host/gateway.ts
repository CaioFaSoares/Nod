// Gateway (RF-80): renders the Caddyfile for the routes the guild admin exposed and drives Caddy's
// admin API over a unix socket. The module never reads DUCKDNS_TOKEN: the Caddyfile carries the
// literal `{$DUCKDNS_TOKEN}` placeholder and Caddy expands it from its own environment, so the
// token never reaches the host, its logs or its errors.

export type GatewaySettings = { socket: string; domain: string; port: number; base: string };
export type GatewayRouteInput = { id: string; upstream: string };
export type GatewayState = { caddyReachable: boolean; lastAppliedAt: string | null; lastError: string | null };

/** Thrown by validateUpstream; the message is static and never echoes the input. */
export class GatewayInputError extends Error {}

export const GATEWAY_RECONCILE_MS = 60_000;
export const GATEWAY_ERROR_MAX = 300;

const INVALID_UPSTREAM = 'invalid gateway upstream';
const INVALID_ID = 'invalid gateway route id';
const CONTAINER_NAME = /^[a-z0-9]([a-z0-9_-]{0,62})$/;
const ROUTE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

function isPrivateIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b, c, d] = m.slice(1).map(Number) as [number, number, number, number];
  if ([a, b, c, d].some((n) => n > 255)) return false;
  // 127/8 is refused on purpose: loopback inside the Caddy container is Caddy itself.
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

/** Validates an upstream and returns it normalized as `scheme://host:port`. */
export function validateUpstream(raw: string): string {
  // Whitespace and braces would let a value escape into the Caddyfile (injection).
  if (typeof raw !== 'string' || /[\s{}]/.test(raw)) throw new GatewayInputError(INVALID_UPSTREAM);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new GatewayInputError(INVALID_UPSTREAM);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new GatewayInputError(INVALID_UPSTREAM);
  // URL drops default ports, so the explicit port is checked on the raw text.
  const portMatch = /^https?:\/\/[^/?#@]+:(\d+)(?:[/?#]|$)/i.exec(raw);
  if (!portMatch) throw new GatewayInputError(INVALID_UPSTREAM);
  if (url.username || url.password) throw new GatewayInputError(INVALID_UPSTREAM);
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) throw new GatewayInputError(INVALID_UPSTREAM);
  const host = url.hostname;
  const allowed = CONTAINER_NAME.test(host) || host === 'host.docker.internal' || isPrivateIpv4(host);
  if (!allowed || Number(portMatch[1]) > 65535) throw new GatewayInputError(INVALID_UPSTREAM);
  return `${url.protocol}//${host}:${Number(portMatch[1])}`;
}

export function gatewayHostname(id: string, domain: string): string {
  return `${id}.${domain}`;
}

export function gatewayUrl(id: string, domain: string, port: number): string {
  return `https://${gatewayHostname(id, domain)}:${port}`;
}

export function renderCaddyfile(
  base: string,
  routes: readonly GatewayRouteInput[],
  domain: string,
  port: number,
): string {
  const blocks = [...routes]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((r) => {
      // Defense in depth: the routes already validated these, the file we hand Caddy re-checks.
      if (!ROUTE_ID.test(r.id)) throw new GatewayInputError(INVALID_ID);
      const upstream = validateUpstream(r.upstream);
      return `${gatewayHostname(r.id, domain)}:${port} {\n\ttls {\n\t\tdns duckdns {$DUCKDNS_TOKEN}\n\t}\n\treverse_proxy ${upstream} {\n\t\theader_up Host {upstream_hostport}\n\t}\n}\n`;
    });
  return `${base.trimEnd()}\n\n${blocks.join('\n')}`.replace(/\n*$/, '\n');
}

export interface Gateway {
  state(): GatewayState;
  /** POST /load with the rendered Caddyfile; true on 2xx. Updates state. Never throws. */
  apply(): Promise<boolean>;
  /** Checks Caddy's live config against the route table and re-applies when it drifted. Never throws. */
  reconcile(): Promise<boolean>;
  /** reconcile now and every intervalMs; returns stop(). The timer is unref'd. */
  start(intervalMs?: number): () => void;
}

/**
 * The admin API's base over the unix socket. Caddy 2.7–2.9 checked the `Host` header on a unix
 * socket too and accepted only an empty host, `127.0.0.1` or `::1` (caddyserver/caddy#6832); later
 * releases skip the check (`admin.go`, `allowedOrigins`). `127.0.0.1` passes both — the socket, not
 * the name, is what is dialed.
 */
const ADMIN = 'http://127.0.0.1';

function clip(text: string): string {
  return text.length > GATEWAY_ERROR_MAX ? text.slice(0, GATEWAY_ERROR_MAX) : text;
}

export function createGateway(deps: {
  settings: GatewaySettings;
  routes: () => GatewayRouteInput[];
  now: () => string;
  log?: (line: string) => void;
  fetchImpl?: typeof fetch;
}): Gateway {
  const { settings, routes, now } = deps;
  const doFetch = deps.fetchImpl ?? fetch;
  const logInfo = deps.log ?? ((l: string) => console.info(l));
  const logErr = deps.log ?? ((l: string) => console.error(l));
  const st: GatewayState = { caddyReachable: false, lastAppliedAt: null, lastError: null };
  let lastApplyOk = true;
  // Concurrent reconcile/apply calls chain on this tail, so they never overlap and each runs in order.
  let tail: Promise<unknown> = Promise.resolve();
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };

  const fail = (msg: string): false => {
    const changed = st.lastError !== clip(msg);
    st.lastError = clip(msg);
    lastApplyOk = false;
    if (changed) logErr(`gateway: apply failed: ${st.lastError}`);
    return false;
  };

  async function applyNow(): Promise<boolean> {
    try {
      const body = renderCaddyfile(settings.base, routes(), settings.domain, settings.port);
      const res = await doFetch(`${ADMIN}/load`, {
        unix: settings.socket,
        method: 'POST',
        headers: { 'content-type': 'text/caddyfile' },
        body,
      } as RequestInit);
      if (!res.ok) {
        st.caddyReachable = true;
        const text = await res.text().catch(() => '');
        let detail = text;
        try {
          const j = JSON.parse(text) as { error?: unknown };
          if (typeof j.error === 'string') detail = j.error;
        } catch {
          /* plain text answer */
        }
        return fail(`caddy /load answered ${res.status}: ${detail}`);
      }
      st.caddyReachable = true;
      st.lastError = null;
      st.lastAppliedAt = now();
      lastApplyOk = true;
      logInfo('gateway: applied');
      return true;
    } catch (e) {
      if (e instanceof GatewayInputError) return fail(`gateway config invalid: ${e.message}`);
      st.caddyReachable = false;
      return fail(`caddy admin unreachable: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function reconcileNow(): Promise<boolean> {
    let text: string;
    try {
      const res = await doFetch(`${ADMIN}/config/`, { unix: settings.socket } as RequestInit);
      if (!res.ok) {
        st.caddyReachable = false;
        return fail(`caddy /config answered ${res.status}`);
      }
      st.caddyReachable = true;
      text = await res.text();
    } catch (e) {
      st.caddyReachable = false;
      return fail(`caddy admin unreachable: ${e instanceof Error ? e.message : String(e)}`);
    }
    const missing = routes().some((r) => !text.includes(gatewayHostname(r.id, settings.domain)));
    if (!missing && lastApplyOk) return true;
    return applyNow();
  }

  return {
    state: () => ({ ...st }),
    apply: () => serialize(applyNow),
    reconcile: () => serialize(reconcileNow),
    start(intervalMs = GATEWAY_RECONCILE_MS) {
      void this.reconcile();
      const timer = setInterval(() => void this.reconcile(), intervalMs);
      timer.unref();
      return () => clearInterval(timer);
    },
  };
}
