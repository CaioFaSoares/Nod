#!/usr/bin/env bun
// `bun run setup-code` (SP07 §3): prints one setup code to the terminal that ran it while the host
// has nobody able to administer it, and stays quiet once an admin exists.
//
// The code is the only thing this command writes to stdout, it is stored as the hex SHA-256 of its
// normalized form (SP02 §3, `repo.issueCode`), and nothing here logs it: no secret reaches a log.
//
// Run from `host/` — the container runs the script of `host/package.json` there (H9) — with the
// environment `host/config.ts` reads, the same one `main.ts` boots on.

import { sha256Hex } from '../../shared/encoding';
import { generateCode, normalizeCode } from '../../shared/host-api';
import { ConfigError, loadConfig, type HostConfig } from '../config';
import { bootHost } from '../main';
import { createRepo, type Repo } from '../repo';

/** Printed to stderr when the command refuses. The code never appears in a message. */
export const ADMIN_EXISTS = 'refused: an admin already exists';

export type IssuedSetupCode =
  | { issued: true; code: string; expiresAt: string }
  | { issued: false };

/**
 * SP02 §3: 10 random bytes as Crockford base32, `XXXX-XXXX-XXXX-XXXX`, valid 24 h, revoking the
 * previous unused one (`repo.issueCode`). Refused while an admin exists — `repo.adminCount()` is that
 * count, "activated and not disabled" (SP01 §2), the rule the last-admin guard uses.
 */
export async function issueSetupCode(repo: Repo, now: string): Promise<IssuedSetupCode> {
  if (repo.adminCount() > 0) return { issued: false };
  const code = generateCode('setup');
  const normalized = normalizeCode(code);
  if (normalized === null) throw new Error('the generated setup code is not Crockford base32');
  const record = repo.issueCode(
    { id: crypto.randomUUID(), purpose: 'setup', personId: null, codeHash: await sha256Hex(normalized) },
    now,
  );
  return { issued: true, code, expiresAt: record.expiresAt };
}

/** The whole command: environment → data dir and migrations → one code → its exit code. */
export async function run(env: Record<string, string | undefined>): Promise<number> {
  let config: HostConfig;
  try {
    config = loadConfig(env);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    process.stderr.write(`${error.message}\n`);
    return 1;
  }

  const host = await bootHost(config);
  try {
    const issued = await issueSetupCode(createRepo(host.db), new Date().toISOString());
    if (!issued.issued) {
      process.stderr.write(`${ADMIN_EXISTS}\n`);
      return 1;
    }
    process.stdout.write(`${issued.code}\n`);
    process.stderr.write(`the code expires at ${issued.expiresAt}\n`);
    return 0;
  } finally {
    host.close();
  }
}

if (import.meta.main) process.exit(await run(process.env));
