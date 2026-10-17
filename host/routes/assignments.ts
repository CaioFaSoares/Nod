// The block 2 admin routes of SP03 §3 (SP06 §4, E02 K8): the assignment of a credential to a role,
// and the list of the members of that role who still have no copy.
//
// `host/app.ts` mounts this plugin with one `.use(...)` line, exactly like `routes/admin.ts`. The
// group mounts `personAuth` and then `adminAuth`, in that order and for the reason `host/context.md`
// records: a plugin's `derive` does not reach the `derive` of the plugin that mounts it, so
// `adminAuth` alone would read no person and answer 500 (h5). Below the guards, a live non-admin
// member is the 403 `admin only` of SP03 §1 and never reaches a handler.
//
// The two routes own the HTTP surface only: `repo.ts` holds the rules (an assignment names an org
// tool, the assigner is not in their own missing list) and `PUT` answers `204` either way — an
// assignment that is switched off is a delete, and removing what is not there is not an error.

import { Elysia, status, t } from 'elysia';

import { HOST_ROUTES, type MissingCopy } from '../../shared/host-api';
import { adminAuth, callerOf, hostOf, personAuth } from '../auth';

// ---------------------------------------------------------------- schema (SP03 §1)

/** A uuid or a slug id: the bounds every id of a body has, as in `routes/admin.ts`. */
const idSchema = t.String({ minLength: 1, maxLength: 64 });

/** SP03 §3 `PUT /v1/admin/assignments`: the credential, the role it goes to, and the tool it is. */
const assignmentBody = t.Object({
  credentialId: idSchema,
  roleId: idSchema,
  toolId: idSchema,
  assigned: t.Boolean(),
});

// ---------------------------------------------------------------- routes

export const assignmentRoutes = new Elysia({ name: 'host-assignment-routes' })
  // SP03 §1: the admin level, `person` → `admin` → route, one guard run each.
  .use(personAuth)
  .use(adminAuth)

  /**
   * SP03 §3: `assigned: true` writes the assignment (upsert: one row per credential and role) and
   * `assigned: false` removes it. `assignedBy` is the caller: the assigner is excluded from their own
   * missing list, because they are the one who seals the copies (SP06 §4).
   */
  .put(HOST_ROUTES.adminAssignments, { body: assignmentBody }, (ctx) => {
    const { person } = callerOf(ctx);
    const { repo, auth } = hostOf(ctx);
    repo.saveAssignment({ ...ctx.body, assignedBy: person.id }, auth.now());
    return status(204);
  })

  /**
   * SP03 §3, RF-47: for every assignment, the members of that role without a live copy of the
   * credential. The admin's Nod seals one to each of them after its gate; the next sync then shows
   * the list shorter, and empty once everybody holds it.
   */
  .get(
    HOST_ROUTES.adminAssignmentsMissing,
    (ctx): MissingCopy[] => hostOf(ctx).repo.missingCopies(),
  );
