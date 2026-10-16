# SP04 — Sync

Why: `docs/epics/E01-connected-mode.md` §8. Types in `shared/host-api.ts`.

## 1. Discovery and key pinning

`GET /.well-known/bond`:

```ts
interface Discovery {
  api: 1;
  guild: string;                 // meta.guild_name
  key: { kid: string; ed25519Public: string };   // raw 32 bytes, base64url
  fingerprint: string;           // §1.1
  minAppVersion: string;         // semver
  signIn: ['access-code'];       // 'email' later
}
```

**Fingerprint**: SHA-256 of the raw public key, first 10 bytes, Crockford base32, grouped
`XXXX-XXXX-XXXX-XXXX`.

**Add host (Bond)**:

1. Normalize the address: `https://` only, except `http://127.0.0.1` and `http://localhost` for
   dev; no path, no user info.
2. Fetch discovery and show the guild name and fingerprint.
3. If the person arrived through `bond://join?host=…&fp=…[&code=…]`, compare `fp`; a mismatch aborts
   with `host key does not match the invite` and stores nothing.
4. Otherwise the person confirms the fingerprint on screen.
5. Pin `{ address, kid, ed25519Public }` in the host record (SP05 §2).

From then on, every discovery or snapshot whose `kid`/key differs is refused with `host key
changed — remove and add the host again`. Nothing is replaced silently.

## 2. Signed snapshot

`GET /v1/state` returns the JSON body plus two headers:

```text
ETag: "<version>"
Bond-Signature: kid=<kid>; sig=<base64url Ed25519 signature over the exact response body bytes>
```

- The Bond verifies the signature over the bytes as received, before parsing. No canonical JSON:
  whatever bytes were signed are the bytes checked.
- `version` = base64url of the first 16 bytes of SHA-256 of the unsigned body. The host computes it
  per person and answers `304` when `If-None-Match` matches.

```ts
interface Snapshot {
  api: 1;
  version: string;
  issuedAt: string;              // the Bond refuses a snapshot older than the last accepted one
  me: { id: Id; email: string; name: string; roles: Id[]; admin: boolean; kind: 'member' | 'client' };
  roles: Role[];                 // all roles (names are not secret inside the guild)
  orgTools: Entry[];             // org entries granted to me (all, if admin), with org views; Entry.roles filled
  personalTools: Entry[];        // mine, scope 'personal'
  personalViews: PersonalView[]; // mine, under any entry I see
  favorites: Id[];               // ordered
  // block 2
  people?: { id: Id; name: string; roles: Id[]; kind: string; x25519Public?: string; ed25519Public?: string }[];
  incomingShares?: IncomingShare[];
  holders?: Record<string /* credentialId */, Holder[]>;
  rotationPending?: string[];    // credentialIds I own with a removed holder
}
```

`Entry` gains `scope: 'org' | 'personal'` and `ownerId: Id | null`; `View` gains `id`, `scope`,
`ownerId`. Both changes land in `shared/types.ts`. Local mode fills `scope: 'org'`, `ownerId:
null`, so today's code keeps working.

## 3. When the Bond syncs

- **Triggers**:
  - right after unlock;
  - every 5 minutes while unlocked, on a backend timer (`docs/tinyjs.md` §3: the page is throttled
    when hidden);
  - "Sync now";
  - after any admin write.
- **Order**: flush the outbox (§4), push events (§5), then `GET /v1/state`.
- **Network failure**: the state goes **stale**; the cache stays in use; Settings → Hosts shows the
  last success time. Retry with backoff of 30 s, 1 min, 2 min, then the normal 5 min.
- **401 on a valid-looking token** (revoked or expired): clear the token, drop org data from the
  cache, keep personal data, ask for sign-in. That's what RF-39 observes.

## 4. Outbox (person writes)

The local table `host_outbox(id, op, path, body, created_at, attempts, last_error)` holds the
person's writes: personal tools, personal views, favorites.

- Each write updates the local cache immediately and appends one row.
- **Replay**: in `id` order, one request at a time.
  - `2xx` deletes the row.
  - `409` (stale): drop the row and accept the host's version at the next snapshot.
  - `4xx` other: drop the row and raise an event `sync.rejected`.
  - `5xx` or network: stop and retry at the next sync.
- `updatedAt` is set by the Bond at write time; the host keeps the newest (last-write-wins; one
  writer per record).

## 5. Events

- The existing local events (`docs/canonico.md` §13) gain `sent_at`.
- **Push**: up to 500 unsent events, oldest first. Each has a stable client id (the local event id).
  The host inserts with `ON CONFLICT(id) DO NOTHING` and returns every id it now holds. The Bond
  marks those `sent_at`.
- Settings → Activity shows sent vs pending, the "what was sent" view of `docs/canonico.md` §13.
- Events keep the rule: no secret, URL as `origin + pathname` only.

## 6. Acceptance

- A snapshot with one byte changed fails verification and the previous cache stays.
- A discovery answering another key after pinning is refused.
- Two runs of the same event batch leave one row per event on the host.
- Offline: unlock shows cached tools; adding a personal tool queues one outbox row; reconnecting
  sends it and the row disappears.
