// 0.5.1 (RF-63): where the backend's secrets live, behind the one `SecretStore` that session, vault,
// keys and the host client receive (`backend/main.ts` wires it).
//
// Every value the Nod used to keep as one keychain item each — the credentials
// (`nod.cred.<person>.<tool>`), the E02 pair (`nod.keys.<person>`) and the guild bearer
// (`nod.host.<kid>.<person>`) — is a `bv1.` envelope under the person's `vaultKey` (SP02 §8), so the
// keychain added nothing to their confidentiality, only one operating-system prompt per item each
// time the app's signature changed (macOS names the binary in the item's ACL, `docs/tinyjs.md` §5).
// Those values now live in the `secret` table, and the system keychain keeps exactly one item per
// person: `nod.bio.<person>`, the `vaultKey` that biometrics unlocks (SP02 §9). One fingerprint, one
// keychain read, and everything else opens from memory.
//
// Values written by an older Nod are still in the keychain. A read that misses the table looks
// there once: a `bv1.` value moves into the table and its item is deleted; a plaintext one (a legacy
// credential, a bearer of 0.5.0) is handed back as it is and moves on its next write, which is
// sealed. The table never holds a plaintext: `set` refuses anything that is not `bv1.`.
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
 * `secret` table, with the read-once move of what an older Nod left in the keychain.
 */
export function createSecretStore(deps: { rows: SecretRows; keychain: SecretStore }): SecretStore {
  function inKeychain(key: string): boolean {
    return key.startsWith(BIOMETRIC_ITEM_PREFIX);
  }

  /**
   * The keychain item an older Nod left under `key`, removed. A refusal (the person denied the
   * system prompt) leaves a stale copy behind and is not a reason to fail the write that replaced
   * it: the table is the value from now on, and the next delete of the key tries again.
   */
  async function dropLegacy(key: string): Promise<boolean> {
    try {
      return await deps.keychain.delete(key);
    } catch {
      return false;
    }
  }

  return {
    async get(key) {
      if (inKeychain(key)) return deps.keychain.get(key);
      const stored = deps.rows.secret(key);
      if (stored !== null) return stored;
      const legacy = await deps.keychain.get(key);
      if (legacy === null || !isSealedVaultValue(legacy)) return legacy;
      deps.rows.setSecret(key, legacy);
      await dropLegacy(key);
      return legacy;
    },
    async set(key, value) {
      if (inKeychain(key)) return deps.keychain.set(key, value);
      if (!isSealedVaultValue(value)) return false;
      // The first write under a key is where a plaintext an older Nod left in the keychain is
      // replaced; afterwards the keychain has nothing under it.
      const first = deps.rows.secret(key) === null;
      deps.rows.setSecret(key, value);
      if (first) await dropLegacy(key);
      return true;
    },
    async delete(key) {
      if (inKeychain(key)) return deps.keychain.delete(key);
      const had = deps.rows.secret(key) !== null;
      deps.rows.deleteSecret(key);
      const legacy = await dropLegacy(key);
      return had || legacy;
    },
  };
}

/**
 * A `SecretStore` for values that are not `bv1.` by themselves — the guild bearer (SP02 §5): each
 * one is sealed under the session's `vaultKey` with its key as the AAD before it reaches `store`,
 * and opened on the way out. Locked (no `vaultKey`), nothing is written and nothing opens — the
 * bearer is read only after the unlock (SP02 §5). A plaintext an older Nod left in the keychain is
 * answered as it is and, with a key in hand, sealed into the table at once.
 */
export function sealedSecrets(store: SecretStore, vaultKey: () => Uint8Array<ArrayBuffer> | null): SecretStore {
  async function set(key: string, value: string): Promise<boolean> {
    const sealer = vaultKey();
    if (sealer === null) return false;
    return store.set(key, await encryptVaultBytes(sealer, key, new TextEncoder().encode(value)));
  }

  return {
    async get(key) {
      const raw = await store.get(key);
      if (raw === null) return null;
      const opener = vaultKey();
      if (!isSealedVaultValue(raw)) {
        if (opener !== null) await set(key, raw);
        return raw;
      }
      if (opener === null) return null;
      const bytes = await decryptVaultBytes(opener, key, raw);
      return bytes === null ? null : new TextDecoder().decode(bytes);
    },
    set,
    delete: (key) => store.delete(key),
  };
}
