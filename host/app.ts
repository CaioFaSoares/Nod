// The Elysia app: routes, auth levels, error mapping, rate limits (SP03). H1 serves only the health
// probe of SP03 §2; the rest arrives with H2–H6.
//
// The app takes its dependencies instead of reading the environment or opening its own connection,
// so a test runs the real app on a temp data dir (`app.handle(new Request(...))`).

import { Elysia } from 'elysia';
import type { Database } from 'bun:sqlite';

import type { HostConfig } from './config';

export type AppDeps = {
  /** Host configuration resolved at boot (SP07 §1–§2). */
  config: HostConfig;
  /** The migrated connection of the process (SP01 §1). */
  db: Database;
};

export function createApp(deps: AppDeps) {
  return new Elysia()
    // Both land on the request context, so the routes of H2 onward read the resolved configuration
    // and the open connection instead of deriving them a second time.
    .decorate({ config: deps.config, db: deps.db })
    .get('/health', () => 'ok');
}
