import {
  GRANT_HOLDER_KINDS,
  WORKSPACE_MEMBER_ACTIONS,
  asCollaborationWorkspaceId,
  asUserId,
  explainAccessEntries,
  type AccessResource,
  type ActorAccess,
  type ConfigAssetRecord,
  type PermissionGrant
} from "@work-shape/catalyst-core";
import { z } from "zod";
import type { DataStoreRuntime } from "./runtime";

// Who reads what a store holds through one way in: the members of the workspace that owns an
// App, and whoever holds the way's right by a grant row. Admins hold every right by their role
// and are no row, so every audience includes them and none lists them. A caller who may not
// administer users is told how many hold a right by a grant and never who.

/**
 * How many grant rows of one right one read looks through. An instance with more answers from
 * the first ones, and `truncated` of the answer says so.
 */
const AUDIENCE_MAX_GRANT_ROWS = 1_000;

/** The right that shows who holds a right: the one that administers users and their grants. */
export const NAMES_HOLDERS = "users.manage";

const holderSchema = z.object({
  kind: z.enum(GRANT_HOLDER_KINDS),
  /** The holder's id: a user's or a service principal's, a role, or a group. */
  name: z.string(),
  /** What people read: a person's or an account's label, or the id where none is known. */
  title: z.string()
});

export const audienceSchema = z.object({
  /** The workspace that owns the asset, whose members hold its use by being members. */
  workspace: z.object({ title: z.string(), members: z.number().int() }).optional(),
  /** Who holds the right by a grant row and may be shown to the caller. */
  holders: z.array(holderSchema),
  /** How many more hold it by a grant row, whom the caller may not be shown. */
  hiddenHolders: z.number().int()
});

type Audience = z.infer<typeof audienceSchema>;
type Holder = z.infer<typeof holderSchema>;
type HolderKey = { kind: Holder["kind"]; id: string };

/** Who reads through the ways in of one store, read once per right and per workspace. */
export interface AudienceReader {
  /** Who holds `action` on the resource: by a grant row, and as a member of its workspace. */
  of(action: string, resource: AccessResource): Promise<Audience>;
  /** More grant rows of a right exist than one read looks through. */
  truncated(): boolean;
  /**
   * Reads the name and the number of members of each workspace named, all in one read, before
   * `of` asks for them one by one.
   */
  readWorkspaces(workspaceIds: readonly string[]): Promise<void>;
}

/** Whether a member of a workspace holds the right on what the workspace owns by being one. */
function isMemberAction(action: string): boolean {
  return WORKSPACE_MEMBER_ACTIONS.some((memberAction) => memberAction === action);
}

/** The resource a right on an asset is asked for, as the evaluator reads it. */
export function assetResource(asset: ConfigAssetRecord): AccessResource {
  return {
    kind: asset.kind,
    name: asset.name,
    assetId: asset.id,
    ...(asset.scope.kind === "workspace" ? { workspaceId: asset.scope.workspaceId } : {})
  };
}

export function createAudienceReader(
  runtime: DataStoreRuntime,
  access: ActorAccess
): AudienceReader {
  const { clientInstanceId, stores } = runtime;
  const named = access.authorize(NAMES_HOLDERS).allowed;
  const grants = new Map<string, Promise<PermissionGrant[]>>();
  const workspaces = new Map<string, Promise<Audience["workspace"]>>();
  const titles = new Map<string, Promise<string>>();
  let truncated = false;

  const rowsOf = (action: string) => {
    let rows = grants.get(action);
    if (!rows) {
      rows = stores.access
        .listGrants({ clientInstanceId, action, page: { limit: AUDIENCE_MAX_GRANT_ROWS + 1 } })
        .then((listed) => {
          if (listed.length > AUDIENCE_MAX_GRANT_ROWS) truncated = true;
          return listed.slice(0, AUDIENCE_MAX_GRANT_ROWS);
        });
      grants.set(action, rows);
    }
    return rows;
  };

  const readWorkspaces = (workspaceIds: readonly string[]) => {
    const unread = [...new Set(workspaceIds)].filter((id) => !workspaces.has(id));
    if (unread.length === 0) return Promise.resolve();
    const counted = stores.workspaces
      .countMembersOfWorkspaces({
        clientInstanceId,
        collaborationWorkspaceIds: unread.map(asCollaborationWorkspaceId)
      })
      .then((rows) => new Map(rows.map((row) => [String(row.id), row])));
    for (const id of unread) {
      workspaces.set(
        id,
        counted.then((rows) => {
          const row = rows.get(id);
          return row && { title: row.name, members: row.members };
        })
      );
    }
    return counted.then(() => undefined);
  };

  const workspaceOf = async (workspaceId: string) => {
    await readWorkspaces([workspaceId]);
    return workspaces.get(workspaceId);
  };

  let principals: Promise<Map<string, string>> | undefined;
  const principalTitles = () =>
    (principals ??= stores.apiAccess
      .listServicePrincipals({ clientInstanceId })
      .then((listed) => new Map(listed.map(({ id, displayLabel }) => [id, displayLabel]))));

  /** What people read of a holder. Only asked where the caller may be shown holders. */
  const titleOf = (kind: Holder["kind"], id: string) => {
    const key = `${kind}:${id}`;
    let read = titles.get(key);
    if (!read) {
      read =
        kind === "user"
          ? stores.users
              .getUser({ clientInstanceId, userId: asUserId(id) })
              .then((user) => user?.displayLabel ?? id)
          : kind === "service_principal"
            ? principalTitles().then((labels) => labels.get(id) ?? id)
            : Promise.resolve(id);
      titles.set(key, read);
    }
    return read;
  };

  return {
    async of(action, resource) {
      const rows = await rowsOf(action);
      // A holder holds the right where its own rows allow it and none of them denies it, as the
      // evaluator decides for one holder.
      const byHolder = new Map<string, { holder: HolderKey; rows: PermissionGrant[] }>();
      for (const row of rows) {
        const key = `${row.holderKind}\u0000${row.holderId}`;
        const entry = byHolder.get(key) ?? {
          holder: { kind: row.holderKind, id: row.holderId },
          rows: []
        };
        entry.rows.push(row);
        byHolder.set(key, entry);
      }
      const holding = [...byHolder.values()].filter(
        ({ rows: own }) =>
          explainAccessEntries(
            // A row is an entry of the holder's own, with what it covers as the row says it.
            own.map((row) => ({ ...row, source: "grant" as const })),
            action,
            resource
          ).decision.allowed
      );
      const holders: Holder[] = named
        ? await Promise.all(
            holding.map(async ({ holder: { kind, id } }) => ({
              kind,
              name: id,
              title: await titleOf(kind, id)
            }))
          )
        : [];
      // Membership gives a few rights on what the workspace owns, such as opening its Apps, and
      // no other one.
      const workspace =
        resource.workspaceId !== undefined && isMemberAction(action)
          ? await workspaceOf(resource.workspaceId)
          : undefined;
      return {
        ...(workspace ? { workspace } : {}),
        holders,
        hiddenHolders: holding.length - holders.length
      };
    },
    truncated: () => truncated,
    readWorkspaces
  };
}
