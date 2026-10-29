import { CONNECTION_ACCESS_VERBS, type ConnectionAccess } from "@work-shape/catalyst-api-contract";
import {
  BUILT_IN_ROLES,
  CONNECTION_ACTIONS,
  asUserId,
  hasAuthScope,
  isSuperadmin,
  type ActorAccess,
  type AuthenticatedUser,
  type PermissionGrant,
  type RoleGrant
} from "@work-shape/catalyst-core";
import { seesPrincipals } from "../access/grant-holder-rules";
import { unstoredBuiltInRole } from "../access/role-rights";
import type { ChatServerOptions } from "../types";

// Who may use one Connection (CONN-WHO-1), read under the Connection's own read right. Every
// reader gets the built-in roles that hold a right on it. A reader who manages users also gets
// the custom roles, then every person, group and service principal that holds one by a row of
// its own; a service principal only where the reader may see service principals. Nothing the
// reader may not see is named or counted. Each says what it may do: a right is held where an
// allow covers this Connection and no deny of the same holder does, at instance scope or on
// this Connection alone. The people of a role are not listed again.

/** The right that names who holds a right: the one that administers users and their grants. */
const NAMES_HOLDERS = "users.manage";

/** What a credential carries to read the administration of users. */
const USER_ADMIN_READ_SCOPE = "user_admin:read";

/** How many grant rows one read looks through per right. */
const MAX_GRANT_ROWS = 1_000;

type Verb = (typeof CONNECTION_ACCESS_VERBS)[number];
type Holder = ConnectionAccess["holders"][number];
type Row = Pick<PermissionGrant, "action" | "effect" | "scopeKind" | "scopeId">;

/** What the rows of one holder let it do with the Connection, in the order of the levels. */
function verbsOnConnection(rows: readonly Row[], assetId: string): Verb[] {
  const covers = (row: Row) =>
    row.scopeKind === "instance" || (row.scopeKind === "asset" && row.scopeId === assetId);
  return CONNECTION_ACCESS_VERBS.filter((verb) => {
    const action = CONNECTION_ACTIONS[verb];
    const on = rows.filter((row) => row.action === action && covers(row));
    return on.some((row) => row.effect === "allow") && !on.some((row) => row.effect === "deny");
  });
}

export async function readConnectionAccess(
  options: Pick<ChatServerOptions, "clientInstanceId" | "stores">,
  caller: { actor: AuthenticatedUser; access: ActorAccess },
  assetId: string
): Promise<ConnectionAccess> {
  const { clientInstanceId, stores } = options;
  const names =
    hasAuthScope(caller.actor, USER_ADMIN_READ_SCOPE) &&
    caller.access.authorize(NAMES_HOLDERS).allowed;

  // The roles: the built-in ones as they are now, from `superadmin` down, then, for a reader
  // who manages users, the custom ones by name. `superadmin` is the floor and never stored.
  const stored = await stores.roles.listRoles({ clientInstanceId });
  const roles: { id: string; name: string; builtIn: boolean; grants: RoleGrant[] }[] = [
    ...[...BUILT_IN_ROLES]
      .reverse()
      .map(
        (id) => stored.find((role) => role.id === id) ?? unstoredBuiltInRole(clientInstanceId, id)
      ),
    ...(names
      ? stored
          .filter((role) => !role.builtIn)
          .sort((left, right) => left.name.localeCompare(right.name))
      : [])
  ];
  const roleViews: ConnectionAccess["roles"] = roles.flatMap((role) => {
    const verbs = verbsOnConnection(role.grants, assetId);
    return verbs.length === 0
      ? []
      : [{ id: role.id, name: role.name, builtIn: role.builtIn, verbs }];
  });
  if (!names) {
    return { roles: roleViews, holders: [], holdersShown: false };
  }

  // The rows of people, groups and principals: on this Connection, and on every Connection.
  const namesPrincipals = seesPrincipals(caller.actor, caller.access);
  const read = (filter: { action?: string; scopeKind: "instance" | "asset"; scopeId?: string }) =>
    stores.access.listGrants({
      clientInstanceId,
      ...filter,
      // The user list hides superadmins from everyone else, and so do the rows they hold.
      excludeSuperadminHolders: !isSuperadmin(caller.actor),
      excludeServicePrincipalHolders: !namesPrincipals,
      excludeOwnedPrincipalHolders: true,
      page: { limit: MAX_GRANT_ROWS }
    });
  const rows = (
    await Promise.all([
      read({ scopeKind: "asset", scopeId: assetId }),
      ...Object.values(CONNECTION_ACTIONS).map((action) => read({ action, scopeKind: "instance" }))
    ])
  ).flat();
  const byHolder = new Map<string, { kind: Holder["kind"]; id: string; rows: Row[] }>();
  for (const row of rows) {
    // A role's rows are the role's, read above. A principal's only where the reader sees them.
    if (row.holderKind === "role") continue;
    if (row.holderKind === "service_principal" && !namesPrincipals) continue;
    const key = `${row.holderKind}\u0000${row.holderId}`;
    const entry = byHolder.get(key) ?? { kind: row.holderKind, id: row.holderId, rows: [] };
    entry.rows.push(row);
    byHolder.set(key, entry);
  }

  const principals = namesPrincipals
    ? new Map(
        (await stores.apiAccess.listServicePrincipals({ clientInstanceId })).map((principal) => [
          String(principal.id),
          principal
        ])
      )
    : undefined;
  const holders: Holder[] = [];
  for (const entry of byHolder.values()) {
    const verbs = verbsOnConnection(entry.rows, assetId);
    if (verbs.length === 0) continue;
    if (entry.kind === "user") {
      const user = await stores.users.getUser({ clientInstanceId, userId: asUserId(entry.id) });
      holders.push({ kind: "user", id: entry.id, title: user?.displayLabel ?? entry.id, verbs });
    } else if (entry.kind === "service_principal") {
      const principal = principals?.get(entry.id);
      holders.push({
        kind: "service_principal",
        id: entry.id,
        title: principal?.displayLabel ?? entry.id,
        ...(principal?.status === "disabled" ? { disabled: true } : {}),
        verbs
      });
    } else {
      holders.push({ kind: "group", id: entry.id, title: entry.id, verbs });
    }
  }
  // People first, then groups, then service principals, each by name.
  const rank = { user: 0, group: 1, service_principal: 2 } as const;
  holders.sort(
    (left, right) => rank[left.kind] - rank[right.kind] || left.title.localeCompare(right.title)
  );
  return { roles: roleViews, holders, holdersShown: true };
}
