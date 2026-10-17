// The host's environment (SP07 §1–§2). Everything here is data: no address, guild name or product
// name is written into code (`AGENTS.md`).

export type HostConfig = {
  /** Directory holding `host.db`, the key files and `backups/` (SP01 §1). */
  dataDir: string;
  /** The `https://` address the proxy exposes; the host itself serves plain HTTP (SP07 §2). */
  publicUrl: string;
  /** Port inside the container network; `PORT` in the Dockerfile (SP07 §1). */
  port: number;
  /** Dev runs may point `NOD_PUBLIC_URL` at a plain `http://` address. */
  dev: boolean;
};

export const DEFAULT_PORT = 8080;

/** A bad environment: the message goes to stderr and the process exits (main.ts). */
export class ConfigError extends Error {}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_PORT;
  if (!/^[0-9]+$/.test(raw)) throw new ConfigError(`invalid PORT: ${raw}`);
  const port = Number(raw);
  if (port < 1 || port > 65535) throw new ConfigError(`invalid PORT: ${raw}`);
  return port;
}

function parsePublicUrl(raw: string | undefined, dev: boolean): string {
  if (raw === undefined || raw === '') {
    throw new ConfigError('NOD_PUBLIC_URL is required (the https address the proxy exposes)');
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ConfigError(`invalid NOD_PUBLIC_URL: ${raw}`);
  }
  // SP07 §2: the host refuses to start outside dev when the address the Nod will pin is not https.
  if (!dev && parsed.protocol !== 'https:') {
    throw new ConfigError(`NOD_PUBLIC_URL must be https:// outside dev: ${raw}`);
  }
  return raw;
}

export function loadConfig(env: Record<string, string | undefined>): HostConfig {
  const dataDir = env.NOD_DATA?.trim();
  if (!dataDir) {
    throw new ConfigError('NOD_DATA is required (the directory holding the database and key files)');
  }
  const dev = env.NOD_DEV === '1' || env.NOD_DEV === 'true';
  return {
    dataDir,
    publicUrl: parsePublicUrl(env.NOD_PUBLIC_URL?.trim(), dev),
    port: parsePort(env.PORT?.trim()),
    dev,
  };
}
