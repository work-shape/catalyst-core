import {
  ACTIONS,
  ROLE_DEFAULT_ACTIONS,
  createPlatformId,
  isEditableBuiltInRole,
  type RolePendingAction
} from "@work-shape/catalyst-core";
import type { ReservedSql } from "postgres";

type Queries = Pick<ReservedSql, "unsafe">;

interface StoredBuiltInRole {
  client_instance_id: string;
  id: string;
  default_actions: string[];
  pending_actions: RolePendingAction[];
}

interface RoleRow {
  action: string;
  effect: string;
  scope_kind: string;
}

/**
 * The data step of the migration step for roles (ADR-0028). The caller runs it in one
 * transaction; it takes each instance's rights lock first. A release never changes an edited role by itself and never hides that
 * it did not:
 *
 * - An action the release no longer knows leaves every role, as an audit event.
 * - A stored built-in role whose rows still equal the default it was reconciled with was never
 *   edited in effect: its row goes, and it holds the release's default as a role nobody edited.
 * - An edited one keeps its rows. Each action the release added to its default, or took out of
 *   it, waits as pending until a superadmin decides it, and the role records the new default.
 *
 * Each change is a `role.reconciled` audit event that names the actions. A database without
 * the table of roles, migrated by an older release's migrations, has nothing to reconcile.
 */
export async function reconcileBuiltInRoles(session: Queries): Promise<void> {
  const [table] = await session.unsafe<{ name: string | null }[]>(
    "select to_regclass('roles')::text as name"
  );
  if (!table?.name) return;
  const instances = await session.unsafe<{ client_instance_id: string }[]>(
    "select distinct client_instance_id from roles order by client_instance_id"
  );
  for (const { client_instance_id: clientInstanceId } of instances) {
    await session.unsafe("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `access:${clientInstanceId}`
    ]);
  }
  const known: readonly string[] = ACTIONS;
  const retired = await session.unsafe<
    { client_instance_id: string; holder_id: string; action: string }[]
  >(
    `delete from permission_grants where holder_kind = 'role' and not (action = any($1::text[]))
     returning client_instance_id, holder_id, action`,
    [known]
  );
  for (const row of retired) {
    await audit(session, row.client_instance_id, row.holder_id, {
      removedFromProduct: [row.action]
    });
  }
  const stored = await session.unsafe<StoredBuiltInRole[]>(
    "select client_instance_id, id, default_actions, pending_actions from roles where built_in order by client_instance_id, id"
  );
  for (const role of stored) {
    if (!isEditableBuiltInRole(role.id)) continue;
    const release: readonly string[] = ROLE_DEFAULT_ACTIONS[role.id];
    const recorded = role.default_actions.filter((action) => known.includes(action));
    const added = release.filter((action) => !recorded.includes(action));
    const removed = recorded.filter((action) => !release.includes(action));
    const pendingKnown = role.pending_actions.filter((entry) => known.includes(entry.action));
    if (
      added.length === 0 &&
      removed.length === 0 &&
      pendingKnown.length === role.pending_actions.length
    )
      continue;
    const rows = await session.unsafe<RoleRow[]>(
      `select action, effect, scope_kind from permission_grants
       where client_instance_id = $1 and holder_kind = 'role' and holder_id = $2`,
      [role.client_instance_id, role.id]
    );
    if (pendingKnown.length === 0 && equalsDefault(rows, recorded)) {
      await session.unsafe(
        "delete from permission_grants where client_instance_id = $1 and holder_kind = 'role' and holder_id = $2",
        [role.client_instance_id, role.id]
      );
      await session.unsafe("delete from roles where client_instance_id = $1 and id = $2", [
        role.client_instance_id,
        role.id
      ]);
      await audit(session, role.client_instance_id, role.id, { edited: false, added, removed });
      continue;
    }
    const pending = withChanges(pendingKnown, added, removed);
    await session.unsafe(
      `update roles set default_actions = $3::text::jsonb, pending_actions = $4::text::jsonb, updated_at = now()
       where client_instance_id = $1 and id = $2`,
      [role.client_instance_id, role.id, JSON.stringify(release), JSON.stringify(pending)]
    );
    await audit(session, role.client_instance_id, role.id, { edited: true, added, removed });
  }
}

/** The rows are the default's: one instance-wide allow for each of its actions, and no more. */
function equalsDefault(rows: readonly RoleRow[], actions: readonly string[]): boolean {
  return (
    rows.length === actions.length &&
    rows.every(
      (row) =>
        row.effect === "allow" && row.scope_kind === "instance" && actions.includes(row.action)
    )
  );
}

/**
 * The pending list after a release: an action it added waits as `added`, one it took out as
 * `removed`, and a change that undoes a pending one of the other way takes that one away.
 */
function withChanges(
  pending: readonly RolePendingAction[],
  added: readonly string[],
  removed: readonly string[]
): RolePendingAction[] {
  let next = [...pending];
  const apply = (action: string, change: RolePendingAction["change"]) => {
    const undone = next.some((entry) => entry.action === action && entry.change !== change);
    next = next.filter((entry) => entry.action !== action);
    if (!undone) next.push({ action, change });
  };
  for (const action of added) apply(action, "added");
  for (const action of removed) apply(action, "removed");
  return next;
}

async function audit(
  session: Queries,
  clientInstanceId: string,
  roleId: string,
  metadata: Record<string, unknown>
): Promise<void> {
  await session.unsafe(
    `insert into audit_events (id, client_instance_id, type, status, subject, correlation_id, created_at, metadata)
     values ($1, $2, 'role.reconciled', 'success', $3, $4, now(), $5::text::jsonb)`,
    [
      createPlatformId("audit"),
      clientInstanceId,
      roleId,
      createPlatformId("corr"),
      JSON.stringify({ roleId, ...metadata })
    ]
  );
}
