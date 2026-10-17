// M7 of `docs/specs/SP06-credential-sharing.md` §4, RF-54, finding M7 of
// `docs/handovers/block2-review.md`: the admin's list of the holders of every org credential.
//
// The verified snapshot carries `holders` for every credential the caller may see — every credential
// of the guild, for an admin (SP04 §2) — keyed by credential id. A holder row carries the tool the
// credential is for (`Holder.toolId`, from `credential_holders.tool_id`), so the row is the primary
// source; the two lookups the caller hands this builder remain the fallback for a snapshot cached
// before the field existed: the tool a credential belongs to, from what this Nod knows (its own vault
// rows, the shares it saw, the admin's missing-copy rows), and the effective catalog's title of a
// tool. A credential none of those names is listed under its own id with no title, so the admin still
// sees every holder row.
//
// This module is pure: no repository, no host, no clock. `backend/main.ts` assembles the source and
// hands the answer to the page as `holders.list`.
import type { Holder, ShareScope } from '../shared/host-api';
import type { CredentialHolders, Id } from '../shared/types';

/** What the builder reads: the verified snapshot's fields and the two lookups above. */
export interface CredentialHoldersSource {
  /** `Snapshot.holders`: credential id → its rows, exactly as the signed body carries them. */
  holders: Record<string, readonly Holder[]> | null | undefined;
  /** `Snapshot.people`: the roster the display names are resolved against. */
  people: ReadonlyArray<{ id: Id; name: string }> | null | undefined;
  /**
   * The tool a credential is for, as this Nod knows it; `null` when nothing names it, and the
   * credential then stands under its own id.
   */
  toolOf: (credentialId: string) => Id | null;
  /** The effective catalog's title of one tool, or `null` when the catalog does not carry it. */
  titleOf: (toolId: Id) => string | null;
}

const SCOPES: ReadonlyArray<ShareScope> = ['role', 'blocked', 'org'];

/**
 * One holder row as the signed body carries it, or `null` for a value that is not a row. The body
 * is verified before it is cached, so this guards the field types a newer host could still add to
 * (the same reading `backend/shares.ts` gives an incoming share).
 */
function readHolder(value: unknown): Holder | null {
  if (typeof value !== 'object' || value === null) return null;
  if (!('personId' in value) || typeof value.personId !== 'string' || value.personId === '') return null;
  if (!('name' in value) || typeof value.name !== 'string') return null;
  if (!('owner' in value) || typeof value.owner !== 'boolean') return null;
  if (!('scope' in value) || !SCOPES.includes(value.scope as ShareScope)) return null;
  if (!('since' in value) || typeof value.since !== 'string') return null;
  // `toolId` arrived with the H1 host fix; a snapshot cached before it has no field at all, and the
  // builder fills the credential's own tool id below.
  if ('toolId' in value && (typeof value.toolId !== 'string' || value.toolId === '')) return null;
  if (!('removedAt' in value) || (value.removedAt !== null && typeof value.removedAt !== 'string')) {
    return null;
  }
  return {
    personId: value.personId,
    name: value.name,
    toolId: 'toolId' in value ? (value.toolId as string) : '',
    owner: value.owner,
    scope: value.scope as ShareScope,
    since: value.since,
    removedAt: value.removedAt as string | null,
  };
}

/**
 * One `CredentialHolders` row per credential the snapshot carries holder rows for, sorted by tool
 * title (case-insensitive) so the card reads as a catalog list, with the credential id as the tie
 * break that keeps two credentials of one tool apart. The holders of each credential read owner
 * first, then the live ones, then the revoked ones — each group in the order the host sent them
 * (owner first, then by date and name, `host/repo.ts`'s `holdersOf`). A revoked holder keeps its row
 * and its date (SP06 §4), so the admin reads "no longer has it" instead of a gap.
 */
export function buildCredentialHolders(source: CredentialHoldersSource): CredentialHolders[] {
  const rows: CredentialHolders[] = [];
  const names: Record<Id, string> = {};
  for (const person of Array.isArray(source.people) ? source.people : []) {
    if (typeof person?.id === 'string' && typeof person.name === 'string') names[person.id] = person.name;
  }
  const holders = source.holders;
  if (typeof holders !== 'object' || holders === null) return rows;

  for (const credentialId of Object.keys(holders)) {
    const raw = holders[credentialId];
    if (!Array.isArray(raw)) continue;
    const list: Holder[] = [];
    for (const value of raw) {
      const holder = readHolder(value);
      // The display name is the roster's: the same person named once by the host and once by the
      // roster must not read as two people.
      if (holder !== null) list.push({ ...holder, name: names[holder.personId] ?? holder.name });
    }
    if (list.length === 0) continue;
    // The owner first, then the live holders, then the revoked ones; a stable sort keeps the host's
    // own order (owner, then since, then name) inside each group.
    list.sort((left, right) => {
      const leftRank = left.owner ? 0 : left.removedAt === null ? 1 : 2;
      const rightRank = right.owner ? 0 : right.removedAt === null ? 1 : 2;
      return leftRank - rightRank;
    });
    const toolId = list[0]?.toolId || source.toolOf(credentialId) || credentialId;
    rows.push({
      credentialId,
      toolId,
      toolTitle: source.titleOf(toolId),
      holders: list.map((holder) => ({ ...holder, toolId: holder.toolId || toolId })),
    });
  }

  rows.sort((left, right) => {
    const leftKey = (left.toolTitle ?? left.toolId).toLowerCase();
    const rightKey = (right.toolTitle ?? right.toolId).toLowerCase();
    if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1;
    return left.credentialId < right.credentialId ? -1 : left.credentialId > right.credentialId ? 1 : 0;
  });
  return rows;
}
