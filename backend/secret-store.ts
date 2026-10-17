// 0.5.1 (RF-63): where the backend's secrets live, behind the one `SecretStore` that session, vault,
// keys and the host client receive (`backend/main.ts` wires it).
//
// Every value the Nod used to keep as one keychain item each — the credentials
// (`nod.cred.<person>.<tool>`), the E02 pair (`nod.keys.<person>`) and the guild bearer
// (`nod.host.<kid>.<person>`) — is a `bv1.` envelope under the person's `vaultKey` (SP02 §8), so the
// keychain added nothing to their confidentiality, only one operating-system prompt per item each
// time the app's signature changed (macOS names the binary in the item's ACL, `docs/tinyjs.md` §5).
// Those values live in the `secret` table, and the system keychain keeps exactly one item per
// person: `nod.bio.<person>`, the `vaultKey` that biometrics unlocks (SP02 §9).
//
// The rule that keeps the prompts away: outside `nod.bio.*`, the store **never** touches the system
// keychain — no fallback read on a miss, no delete of an old copy. Each of those used to be one more
// password prompt whenever the item's ACL did not name the running build. What an older Nod left in
// the keychain is brought over by `importLegacySecrets` alone: read-only, only for keys the table
// lacks, once per person (`backend/main.ts` keeps the marker). The old items are left in the keychain
// untouched, since deleting them is itself a prompt.
//
// Nothing here imports `tjs` or `tiny`; `bun test` drives it with an in-memory keychain and SQLite.
import { decryptVaultBytes, encryptVaultBytes, isSealedVaultValue } from '../shared/vault-crypto';
import type { SecretStore } from '../shared/types';

/** SP02 §9: the prefix of the one item that stays in the system keychain. */
export const BIOMETRIC_ITEM_PREFIX = 'nod.bio.';

/** The three rows of `backend/repo.ts` this store needs (RF-63's `secret` table). */
export interface SecretRows {
  secret(key: string): string | null;
  setSecret(key: string, value: string): void;
  deleteSecret(key: string): void;
}

/**
 * The backend's `SecretStore`: `nod.bio.*` goes to the system keychain, every other key to the
 * `secret` table and nowhere else. The table never holds a plaintext: `set` refuses anything that
 * is not `bv1.`.
 */
export function createSecretStore(deps: { rows: SecretRows; keychain: SecretStore }): SecretStore {
  function inKeychain(key: string): boolean {
    return key.startsWith(BIOMETRIC_ITEM_PREFIX);
  }

  return {
    async get(key) {
      return inKeychain(key) ? deps.keychain.get(key) : deps.rows.secret(key);
    },
    async set(key, value) {
      if (inKeychain(key)) return deps.keychain.set(key, value);
      if (!isSealedVaultValue(value)) return false;
      deps.rows.setSecret(key, value);
      return true;
    },
    async delete(key) {
      if (inKeychain(key)) return deps.keychain.delete(key);
      const had = deps.rows.secret(key) !== null;
      deps.rows.deleteSecret(key);
      return had;
    },
  };
}

/** The `meta` rows `importLegacySecrets` keeps its one-shot marker and its report in. */
export interface ImportMarks {
  meta(key: string): string | null;
  setMeta(key: string, value: string): void;
}

/** RF-63: the `meta` key that says a person's keychain import was attempted (never repeated). */
export function legacyImportedKey(personId: string): string {
  return `keychain_imported.${personId}`;
}

/** RF-63: the `meta` key that counts the old items a person's import could not read (refused). */
export function legacySkippedKey(personId: string): string {
  return `keychain_import_skipped.${personId}`;
}

/**
 * RF-63: brings what an older Nod left in the system keychain for `personId` into the `secret`
 * table — **one attempt per person, ever**. Only keys the table lacks are read, each once; nothing
 * is ever written to or deleted from the keychain. A `bv1.` value is copied as it is; a plaintext (a
 * 0.5.0 bearer, a pre-V1 credential) goes through `seal`, and is dropped when `seal` answers `null`.
 * A read the keychain refuses (the person denied the system prompt) is skipped and counted under
 * `legacySkippedKey`, never retried: the marker is set after the attempt whatever happened, so a
 * refused item can never bring the prompt back at the next unlock. Answers how many were skipped.
 */
export async function importLegacySecrets(
  deps: { rows: SecretRows & ImportMarks; keychain: SecretStore },
  personId: string,
  keys: readonly string[],
  seal: (key: string, plaintext: string) => Promise<string | null>,
): Promise<number> {
  if (deps.rows.meta(legacyImportedKey(personId)) === '1') return 0;
  let skipped = 0;
  try {
    for (const key of keys) {
      if (key.startsWith(BIOMETRIC_ITEM_PREFIX) || deps.rows.secret(key) !== null) continue;
      let raw: string | null;
      try {
        raw = await deps.keychain.get(key);
      } catch {
        skipped += 1;
        continue;
      }
      if (raw === null) continue;
      const value = isSealedVaultValue(raw) ? raw : await seal(key, raw).catch(() => null);
      if (value !== null && isSealedVaultValue(value)) deps.rows.setSecret(key, value);
    }
  } finally {
    deps.rows.setMeta(legacyImportedKey(personId), '1');
    if (skipped > 0) deps.rows.setMeta(legacySkippedKey(personId), String(skipped));
  }
  return skipped;
}

/**
 * A `SecretStore` for values that are not `bv1.` by themselves — the guild bearer (SP02 §5): each
 * one is sealed under the session's `vaultKey` with its key as the AAD before it reaches `store`,
 * and opened on the way out. Locked (no `vaultKey`), nothing is written and nothing opens — the
 * bearer is read only after the unlock (SP02 §5).
 */
export function sealedSecrets(store: SecretStore, vaultKey: () => Uint8Array<ArrayBuffer> | null): SecretStore {
  return {
    async get(key) {
      const raw = await store.get(key);
      const opener = vaultKey();
      if (raw === null || opener === null) return null;
      const bytes = await decryptVaultBytes(opener, key, raw);
      return bytes === null ? null : new TextDecoder().decode(bytes);
    },
    async set(key, value) {
      const sealer = vaultKey();
      if (sealer === null) return false;
      return store.set(key, await encryptVaultBytes(sealer, key, new TextEncoder().encode(value)));
    },
    delete: (key) => store.delete(key),
  };
}
