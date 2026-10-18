// The two audit events of the vault (`credentialEvent`, `backend/main.ts`), RF-65 over SP06 §6: a
// save and a removal record the tool and the credential's own id — never its label, which defaults
// to the username (`VaultItem.label`), and never a value of the secret. A local event is pushed to
// the host (`backend/sync.ts`), and the host may not hold a username of a vault in clear (RF-44).
//
// The rule is exported from `backend/main.ts` with no runtime around it — like `entryProfiles` in
// `test/entry.test.ts` — so it is pinned without an app, a host or a database.
import { describe, expect, mock, test } from 'bun:test';

import type * as Backend from '../backend/main';
import type { VaultItem } from '../shared/types';

/** The builder under test, loaded past the `tjs:sqlite` import of `backend/main.ts`. */
async function credentialEventOf(): Promise<typeof Backend.credentialEvent> {
  // `backend/main.ts` reads the `tjs:sqlite` built-in at import time, which only exists in the
  // runtime. A static import would resolve before this stub — the dynamic import is the loading
  // boundary the test has to cross; nothing under test touches SQLite.
  mock.module('tjs:sqlite', () => ({ Database: class {} }));
  const backend = await import('../backend/main');
  return backend.credentialEvent;
}

/** The username of the run: it must not appear in an event, in any text of it. */
const USERNAME = 'smoke-share-user';

/** One credential of the vault; `label` is what the person sees and defaults to the username. */
function credential(label: string): VaultItem {
  return {
    id: 'item-1',
    personId: 'p-ana',
    toolId: 'tool-a',
    label,
    username: USERNAME,
    keychainKey: 'nod.cred.p-ana.tool-a.item-1',
    createdAt: '2026-10-18T10:00:00.000Z',
    updatedAt: '2026-10-18T10:00:00.000Z',
    credentialId: null,
    scope: 'role',
    rotationPending: false,
    holders: [],
    isDefault: true,
  };
}

describe('the vault events (RF-65, SP06 §6)', () => {
  test('`credential_saved` names the tool and the item id, and nothing of the credential', async () => {
    const credentialEvent = await credentialEventOf();
    // A save without a label: the vault's default label is the username (RF-65).
    const event = credentialEvent('credential_saved', 'p-ana', credential(USERNAME));

    expect(event.type).toBe('credential_saved');
    expect(event.personId).toBe('p-ana');
    expect(event.toolId).toBe('tool-a');
    expect(event.detail).toBe('item-1');
    expect(event.url).toBeNull();
    expect(event.result).toBeNull();
    // The label is this credential's username, and no text of the event may carry it.
    expect(event.detail).not.toContain(USERNAME);
    expect(JSON.stringify(event)).not.toContain(USERNAME);
  });

  test('`credential_removed` is the same, and a label the person typed stays out of it too', async () => {
    const credentialEvent = await credentialEventOf();
    const event = credentialEvent('credential_removed', 'p-ana', credential('Work'));

    expect(event.type).toBe('credential_removed');
    expect(event.personId).toBe('p-ana');
    expect(event.toolId).toBe('tool-a');
    expect(event.detail).toBe('item-1');
    // Never the label: it is the person's own text, and it is the username whenever they did not
    // type one — so the event names the id and the tool, and the page resolves the rest.
    expect(JSON.stringify(event)).not.toContain('Work');
    expect(JSON.stringify(event)).not.toContain(USERNAME);
  });
});
