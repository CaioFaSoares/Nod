// Credential vault of Bond — docs/arquitetura.md §4; concepts in docs/canonico.md §11.
//
// The credential value lives only in the OS keychain (key `bond.cred.<person>.<tool>`); the
// database keeps the index (`VaultItem`), never the secret. Nothing here imports `tjs` or `tiny`:
// the repository and the keychain come in through `deps`, which keeps the slice testable with
// `bun test`. The `credential_saved`/`credential_removed`/`vault_exported`/`vault_imported` events
// belong to `backend/main.ts`: the vault records no event at all.
import { exportVault, importVault } from '../shared/vault-export';
import type { Id, SecretStore, VaultExportItem, VaultItem } from '../shared/types';
import type { Repo } from './repo';

const USERNAME_REQUIRED = 'a username is required';
const SECRET_REQUIRED = 'a secret is required';
const UNKNOWN_TOOL = 'unknown tool';
const KEYCHAIN_REFUSED = 'the system keychain refused the credential';

export interface VaultDeps {
  repo: Repo;
  keychain: SecretStore;
  /** PBKDF2 iterations of the export (§3). The tests pass 1000; default: the pure module's own. */
  iterations?: number;
}

/** What `createVault` returns (§4). Declared apart so the contract has a name of its own. */
export interface Vault {
  key(personId: Id, toolId: Id): string;
  list(personId: Id): VaultItem[];
  save(
    personId: Id,
    p: { toolId: Id; username: string; secret: string; label?: string },
  ): Promise<VaultItem>;
  read(personId: Id, toolId: Id): Promise<{ username: string; secret: string } | null>;
  remove(personId: Id, toolId: Id): Promise<void>;
  removeAllOf(personId: Id): Promise<void>;
  removeAllForTool(toolId: Id): Promise<void>;
  export(personId: Id, password: string): Promise<string>;
  import(personId: Id, blob: string, password: string): Promise<number>;
}

/**
 * Vault (§4): the index lives in the repository and the value in the keychain. `save` is the only
 * path that writes to both, and the index only goes in after the keychain accepted.
 */
export function createVault(deps: VaultDeps): Vault {
  function key(personId: Id, toolId: Id): string {
    return `bond.cred.${personId}.${toolId}`;
  }

  function list(personId: Id): VaultItem[] {
    return deps.repo.listVault(personId);
  }

  async function save(
    personId: Id,
    p: { toolId: Id; username: string; secret: string; label?: string },
  ): Promise<VaultItem> {
    const username = p.username.trim();
    if (username.length === 0) throw new Error(USERNAME_REQUIRED);
    // The secret is not trimmed: leading or trailing space may be part of the tool's password.
    if (p.secret.length === 0) throw new Error(SECRET_REQUIRED);
    // The row has a foreign key to `tool`: an entry that does not exist is refused before anything
    // is written to the keychain (the index would be impossible to keep).
    if (deps.repo.entry(p.toolId) === null) throw new Error(UNKNOWN_TOOL);

    const label = p.label === undefined || p.label.trim().length === 0 ? p.toolId : p.label;
    const keychainKey = key(personId, p.toolId);
    const stored = await deps.keychain.set(
      keychainKey,
      JSON.stringify({ username, secret: p.secret }),
    );
    if (!stored) throw new Error(KEYCHAIN_REFUSED);

    return deps.repo.saveVaultItem({
      personId,
      toolId: p.toolId,
      label,
      username,
      keychainKey,
    });
  }

  async function read(
    personId: Id,
    toolId: Id,
  ): Promise<{ username: string; secret: string } | null> {
    const item = deps.repo.vaultItem(personId, toolId);
    if (item === null) return null;
    const raw = await deps.keychain.get(item.keychainKey);
    if (raw === null) return null;
    try {
      const value: unknown = JSON.parse(raw);
      if (typeof value !== 'object' || value === null) return null;
      const record = value as { username?: unknown; secret?: unknown };
      if (typeof record.username !== 'string' || typeof record.secret !== 'string') return null;
      return { username: record.username, secret: record.secret };
    } catch {
      // Keychain holding junk (or a value swapped by hand): an unreadable credential is an absent one.
      return null;
    }
  }

  async function remove(personId: Id, toolId: Id): Promise<void> {
    const item = deps.repo.vaultItem(personId, toolId);
    if (item !== null) await deps.keychain.delete(item.keychainKey);
    deps.repo.removeVaultItem(personId, toolId);
  }

  async function removeAllOf(personId: Id): Promise<void> {
    // `removeVaultOf` hands back what it deleted exactly so the keychain can be cleaned afterwards.
    const removed = deps.repo.removeVaultOf(personId);
    for (const item of removed) await deps.keychain.delete(item.keychainKey);
  }

  async function removeAllForTool(toolId: Id): Promise<void> {
    // Removing a tool from the catalog (canonico §8, A6) has to take every person's credential with
    // it: the keychain item and the index row, or the next `bond.cred.*` read finds a ghost.
    const items = deps.repo.vaultItemsByTool(toolId);
    for (const item of items) {
      await deps.keychain.delete(item.keychainKey);
      deps.repo.removeVaultItem(item.personId, toolId);
    }
  }

  async function exportItems(personId: Id): Promise<VaultExportItem[]> {
    const items: VaultExportItem[] = [];
    for (const item of deps.repo.listVault(personId)) {
      const credential = await read(personId, item.toolId);
      if (credential === null) continue;
      items.push({
        toolId: item.toolId,
        label: item.label,
        username: credential.username,
        secret: credential.secret,
      });
    }
    return items;
  }

  async function exportToBlob(personId: Id, password: string): Promise<string> {
    return exportVault(await exportItems(personId), password, deps.iterations);
  }

  async function importFromBlob(personId: Id, blob: string, password: string): Promise<number> {
    const items = await importVault(blob, password);
    for (const item of items) {
      await save(personId, {
        toolId: item.toolId,
        username: item.username,
        secret: item.secret,
        label: item.label,
      });
    }
    return items.length;
  }

  return {
    key,
    list,
    save,
    read,
    remove,
    removeAllOf,
    removeAllForTool,
    export: exportToBlob,
    import: importFromBlob,
  };
}
