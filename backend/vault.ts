// Credential vault of Nod — docs/arquitetura.md §4; concepts in docs/canonico.md §11.
//
// The credential value lives only in the OS keychain (key `nod.cred.<person>.<tool>.<item>` for
// every credential 0.5.5 creates — RF-65; the row of one an older build wrote carries the
// `nod.cred.<person>.<tool>` it was sealed under, and a re-keyed row keeps its own, B8b); the
// database keeps the index (`VaultItem`), never the secret. Nothing here imports `tjs` or `tiny`:
// the repository and the keychain come in through `deps`, which keeps the slice testable with
// `bun test`. The `credential_saved`/`credential_removed`/`vault_exported`/`vault_imported` events
// belong to `backend/main.ts`: the vault records no event at all.
//
// 0.5.5 (RF-65): a person holds as many credentials of one tool as they want, and every call of
// this slice addresses ONE of them by its own id — `save` with an `itemId` replaces that credential
// and without one adds a new one beside the others, `read`/`remove` name the item. The single
// exception is `readDefault`, which the login cascade asks with a tool id: the tool is what a window
// is, and the credential it fills with is the tool's default.
//
// The index row also carries the origin of the entry at save time (SP02 §8, RF-38): it is what
// `backend/tool-windows.ts` compares a window's entry origin against before it fills a form.
//
// V1/SP02 §8: the keychain value is never the credential in clear. `save` seals it with the
// session's `vaultKey` (AAD = the keychain key) through `shared/vault-crypto.ts`, and `read` opens
// it with the same key. Values without the `bv1.` prefix are legacy plaintext: `read` still opens
// them so an upgrade never loses a credential. Since RF-63 the store never hands one back — the
// keychain import of `backend/main.ts` (`importLegacy`) seals them on the way into the `secret` table.
import { originOf } from '../shared/catalog';
import { exportVault, importVault } from '../shared/vault-export';
import {
  decryptVaultBytes,
  decryptVaultValue,
  encryptVaultBytes,
  encryptVaultValue,
  isSealedVaultValue,
  plainVaultCredential,
} from '../shared/vault-crypto';
import type { VaultCredential } from '../shared/vault-crypto';
import type { ShareScope } from '../shared/host-api';
import type { Id, SecretStore, VaultExportItem, VaultItem } from '../shared/types';
import type { Repo } from './repo';

const USERNAME_REQUIRED = 'a username is required';
const SECRET_REQUIRED = 'a secret is required';
const UNKNOWN_TOOL = 'unknown tool';
const KEYCHAIN_REFUSED = 'the system keychain refused the credential';
/** RF-65: the id names no credential of this person — of another's, or of none at all. */
const UNKNOWN_CREDENTIAL = 'unknown credential';
/** RF-65: a save named an item of another tool. A credential never changes tool through a save. */
const INVALID_CREDENTIAL = 'invalid credential';
/** SP02 §8: no `vaultKey` in memory (a locked session, or one unlocked without a password). */
const VAULT_LOCKED = 'the vault is locked — unlock with your password first';
/** A `bv1.` value that not even the new key opens: the password change has nothing to re-seal. */
const VAULT_UNREADABLE = 'a saved login could not be opened with the current key';

export interface VaultDeps {
  repo: Repo;
  keychain: SecretStore;
  /**
   * SP02 §8: the `vaultKey` of the unlocked session. `backend/main.ts` reads it from
   * `session.vaultKey()`, which is null while locked — and then the vault can neither read nor
   * write a sealed value. Missing in tests that never touch a credential: the same refusal.
   */
  vaultKey?: () => Uint8Array<ArrayBuffer> | null;
  /** PBKDF2 iterations of the export (§3). The tests pass 1000; default: the pure module's own. */
  iterations?: number;
  /**
   * K9/SP06 §4: the one sharing call-out of this file. After `save` stored a new value it asks
   * this for what the credential's holders have to say — the owner's edit has to reach them as an
   * `update`. It answers a warning to show with the item, or `null`. The call-out is best-effort:
   * a throw leaves the save standing, because the value is already in the keychain and the index.
   */
  afterSave?: (personId: Id, item: VaultItem) => Promise<string | null>;
}

/** What `createVault` returns (§4). Declared apart so the contract has a name of its own. */
export interface Vault {
  list(personId: Id): VaultItem[];
  /**
   * RF-65: `itemId` names the credential this save replaces — one this person holds, of the same
   * tool, or the call is refused. Without it a new credential is added to the tool beside the ones
   * it already has, and it becomes the one the fill uses when the tool had none. `label` tells the
   * credentials of one tool apart and defaults to the username.
   */
  save(
    personId: Id,
    p: {
      itemId?: Id;
      toolId: Id;
      username: string;
      secret: string;
      label?: string;
      /** K4: the credential group an accepted share carries; omit for a plain save. */
      credentialId?: string | null;
      /** K6: the scope of an accepted share; omit for a plain save. */
      scope?: ShareScope;
    },
  ): Promise<VaultItem>;
  /** One credential of this person, by its own id; `null` when it is not there or will not open. */
  read(personId: Id, itemId: Id): Promise<{ username: string; secret: string } | null>;
  /**
   * RF-65: the credential of a tool the login cascade fills with (`backend/main.ts`'s
   * `credentialOf`) — the tool's default item. The only read of this slice that goes by tool id:
   * a tool window knows its tool, and which credential fills it is the vault's own rule.
   */
  readDefault(personId: Id, toolId: Id): Promise<{ username: string; secret: string } | null>;
  /** Removes one credential; an id this person does not hold is refused (`unknown credential`). */
  remove(personId: Id, itemId: Id): Promise<void>;
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
  /** SP02 §8: the key of the unlocked session, or the typed refusal — never a plaintext write. */
  function requireVaultKey(): Uint8Array<ArrayBuffer> {
    const found = deps.vaultKey === undefined ? null : deps.vaultKey();
    if (found === null) throw new Error(VAULT_LOCKED);
    return found;
  }

  function list(personId: Id): VaultItem[] {
    return deps.repo.listVault(personId);
  }

  /**
   * SP02 §8: the value of one index row. It is read by the key the row carries — never by a derived
   * one — because that string is the AAD the value was sealed with, and an item of an older build
   * (or one a re-key moved, B8b) carries a key of another shape.
   */
  async function open(item: VaultItem): Promise<{ username: string; secret: string } | null> {
    const raw = await deps.keychain.get(item.keychainKey);
    if (raw === null) return null;
    // A `bv1.` value opens only with the session's `vaultKey` over this same keychain key. Without a
    // key (locked) or with one that does not match, the credential is absent, not an error.
    if (isSealedVaultValue(raw)) {
      const vaultKey = deps.vaultKey === undefined ? null : deps.vaultKey();
      if (vaultKey === null) return null;
      return decryptVaultValue(vaultKey, item.keychainKey, raw);
    }
    // Legacy plaintext (no prefix): readable until the first unlock re-encrypts it.
    return plainVaultCredential(raw);
  }

  async function save(
    personId: Id,
    p: {
      itemId?: Id;
      toolId: Id;
      username: string;
      secret: string;
      label?: string;
      credentialId?: string | null;
      scope?: ShareScope;
    },
  ): Promise<VaultItem> {
    const username = p.username.trim();
    if (username.length === 0) throw new Error(USERNAME_REQUIRED);
    // The secret is not trimmed: leading or trailing space may be part of the tool's password.
    if (p.secret.length === 0) throw new Error(SECRET_REQUIRED);
    // The entry comes from the effective catalog — `backend/main.ts` hands the vault a repository
    // whose `entry` is the connected one while connected (SP05 §2). A tool of the guild may have no
    // local `tool` row at all, and it is still refused when the catalog does not know it: without an
    // entry there is no origin to bind the credential to (RF-38).
    const entry = deps.repo.entry(p.toolId);
    if (entry === null) throw new Error(UNKNOWN_TOOL);
    // RF-65: the credential this save replaces, when the caller names one. Both refusals come before
    // anything is written: an id this person does not hold, and an id of another tool's — a
    // credential is edited where it is, never moved from one tool to another by a save.
    const previous = p.itemId === undefined ? null : deps.repo.vaultItemById(personId, p.itemId);
    if (p.itemId !== undefined && previous === null) throw new Error(UNKNOWN_CREDENTIAL);
    if (previous !== null && previous.toolId !== p.toolId) throw new Error(INVALID_CREDENTIAL);
    // RF-38: the origin is taken before the keychain write, so a refused write leaves no trace of
    // it either. It is the entry's own canonical origin — the same value the tool window compares
    // its address against.
    const origin = originOf(entry.url);

    const label = p.label === undefined || p.label.trim().length === 0 ? username : p.label;
    // RF-65: an item keeps the key it was created with, so replacing a credential rewrites the value
    // under the key the row already carries (nothing is orphaned in the keychain); a credential added
    // now gets its own key, with its id in it. The key is the AAD of the sealed value: it is written
    // once, with the row, and never derived again.
    const itemId = previous?.id ?? crypto.randomUUID();
    const keychainKey = previous?.keychainKey ?? `nod.cred.${personId}.${p.toolId}.${itemId}`;
    // SP02 §8: sealed before the keychain sees it, with the keychain key as AAD. A locked session
    // and a value over the keychain limit both refuse here, with nothing written on either side.
    const value = await encryptVaultValue(requireVaultKey(), keychainKey, {
      username,
      secret: p.secret,
    });
    const stored = await deps.keychain.set(keychainKey, value);
    if (!stored) throw new Error(KEYCHAIN_REFUSED);

    const item = deps.repo.saveVaultItem({
      id: itemId,
      personId,
      toolId: p.toolId,
      label,
      username,
      keychainKey,
      origin,
      credentialId: p.credentialId,
      scope: p.scope,
    });
    // K9/SP06 §4: the value is stored — the call-out can only add a warning, never undo the save.
    if (deps.afterSave === undefined) return item;
    let warning: string | null = null;
    try {
      warning = await deps.afterSave(personId, item);
    } catch {
      warning = null;
    }
    return warning === null ? item : { ...item, updateWarning: warning };
  }

  async function read(
    personId: Id,
    itemId: Id,
  ): Promise<{ username: string; secret: string } | null> {
    const item = deps.repo.vaultItemById(personId, itemId);
    return item === null ? null : await open(item);
  }

  async function readDefault(
    personId: Id,
    toolId: Id,
  ): Promise<{ username: string; secret: string } | null> {
    const item = deps.repo.defaultVaultItem(personId, toolId);
    return item === null ? null : await open(item);
  }

  async function remove(personId: Id, itemId: Id): Promise<void> {
    const item = deps.repo.vaultItemById(personId, itemId);
    if (item === null) throw new Error(UNKNOWN_CREDENTIAL);
    await deps.keychain.delete(item.keychainKey);
    // RF-65: the repository hands the default of a tool to the oldest credential left when the one
    // removed held it, so a tool that still has credentials always has one to fill with.
    deps.repo.removeVaultItem(personId, itemId);
  }

  async function removeAllOf(personId: Id): Promise<void> {
    // `removeVaultOf` hands back what it deleted exactly so the keychain can be cleaned afterwards.
    const removed = deps.repo.removeVaultOf(personId);
    for (const item of removed) await deps.keychain.delete(item.keychainKey);
  }

  async function removeAllForTool(toolId: Id): Promise<void> {
    // Removing a tool from the catalog (canonico §8, A6) has to take every person's credential with
    // it: the keychain item and the index row, or the next `nod.cred.*` read finds a ghost. Every
    // credential of the tool goes, not just the default (RF-65).
    const items = deps.repo.vaultItemsByTool(toolId);
    for (const item of items) {
      await deps.keychain.delete(item.keychainKey);
      deps.repo.removeVaultItem(item.personId, item.id);
    }
  }

  async function exportItems(personId: Id): Promise<VaultExportItem[]> {
    const items: VaultExportItem[] = [];
    // RF-65: every credential of the person goes to the file, not one per tool — the format is
    // v1's list of items and it already carries as many of a tool as there are.
    for (const item of deps.repo.listVault(personId)) {
      const credential = await open(item);
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
      // RF-65: a file written before 0.5.5 holds one credential per tool, and importing it again
      // must not pile copies up: the item of that tool with the same username is replaced in place,
      // and a username this tool does not have yet is added beside the others.
      const held = deps.repo
        .vaultItemsOfTool(personId, item.toolId)
        .find((stored) => stored.username === item.username);
      await save(personId, {
        itemId: held?.id,
        toolId: item.toolId,
        username: item.username,
        secret: item.secret,
        label: item.label,
      });
    }
    return items.length;
  }

  return {
    list,
    save,
    read,
    readDefault,
    remove,
    removeAllOf,
    removeAllForTool,
    export: exportToBlob,
    import: importFromBlob,
  };
}

/**
 * SP02 §7: the password change re-seals every value of one person under the new `vaultKey` before
 * the verifier is rewritten, so the vault stays readable with the new password. `from` is the old
 * key — `null` when the account had none (a v1 row, whose values are plaintext). The whole set is
 * opened and re-sealed **in memory first**; only then is the keychain written, so a value that
 * cannot be opened aborts with the old values still in place and readable.
 *
 * A value that already opens with `to` was re-sealed by an interrupted earlier run and is accepted
 * as it is: the operation is safe to repeat. Values the keychain lost are skipped; plaintext values
 * are sealed under the new key.
 *
 * `extra` are `bv1.` values that live under the same `vaultKey` but are not vault items — today the
 * E02 key pair of `backend/keys.ts`, held under `nod.keys.<person>` with the same string as its AAD
 * (M1). They ride in this same batch, opened first and written with it, so no crash can leave the
 * pair under a key nothing holds. One of them that neither key opens is **skipped** rather than
 * fatal: such a pair is already unusable (a reset elsewhere) and must not block a password change —
 * `keys.reSeal` is what reports it to the person afterwards.
 */
export async function reencryptVaultItems(
  deps: { repo: Repo; keychain: SecretStore },
  personId: Id,
  from: Uint8Array<ArrayBuffer> | null,
  to: Uint8Array<ArrayBuffer>,
  extra: readonly { key: string; aad: string }[] = [],
): Promise<number> {
  const planned: { key: string; value: string }[] = [];
  for (const item of deps.repo.listVault(personId)) {
    const raw = await deps.keychain.get(item.keychainKey);
    if (raw === null) continue;
    let credential: VaultCredential | null;
    if (isSealedVaultValue(raw)) {
      credential = from === null ? null : await decryptVaultValue(from, item.keychainKey, raw);
      if (credential === null) credential = await decryptVaultValue(to, item.keychainKey, raw);
      if (credential === null) throw new Error(VAULT_UNREADABLE);
    } else {
      credential = plainVaultCredential(raw);
    }
    if (credential === null) continue;
    planned.push({
      key: item.keychainKey,
      value: await encryptVaultValue(to, item.keychainKey, credential),
    });
  }
  for (const item of extra) {
    const raw = await deps.keychain.get(item.key);
    if (raw === null) continue;
    const bytes =
      (from === null ? null : await decryptVaultBytes(from, item.aad, raw)) ??
      (await decryptVaultBytes(to, item.aad, raw));
    if (bytes === null) continue;
    planned.push({ key: item.key, value: await encryptVaultBytes(to, item.aad, bytes) });
  }
  for (const item of planned) {
    if (!(await deps.keychain.set(item.key, item.value))) throw new Error(KEYCHAIN_REFUSED);
  }
  return planned.length;
}

