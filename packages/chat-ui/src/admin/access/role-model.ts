import {
  ApiError,
  type EffectivePermissions,
  type Role,
  type RoleGrantInput
} from "@work-shape/catalyst-api-client";
import {
  ACTIONS,
  authorizeHeldRights,
  isBuiltInRole,
  isPlatformAction,
  isSuperadminGrantedAction,
  type PlatformAction
} from "@work-shape/catalyst-core";
import type { TranslationKey } from "../../shared/i18n";
import { refusalDetail, refusalReason } from "./access-model";
import { rightAreaOf, rightAreaOrder } from "./effective-rights-model";
import { giverAccess } from "./grant-options";
import type { SentencePlace } from "./grant-sentences";

// Instance > Access > Roles (ADR-0028): what the role list and a role's page show and send.
// The server decides every write again; these rules only keep the page from offering what it
// would refuse.

export type RoleGrant = Role["grants"][number];

/** The right that edits, resets and decides for `user` and `admin` (Felix, 2026-10-21). */
export const EDIT_BUILT_IN_ROLES_ACTION = "roles.edit_built_in";

/** The right every role write asks for. */
const MANAGE_USERS_ACTION = "users.manage";

/**
 * The areas a role's page groups its rights by: the areas of the User screen's effective
 * rights (`effective-rights-model.ts`), each kind in the order the rights screens list kinds and
 * the administration last, without an area no role can hold a right of.
 */
export const ROLE_AREAS: readonly string[] = rightAreaOrder().filter(
  (area) => roleAreaActions(area).length > 0
);
export type RoleArea = string;

export const roleAreaOf = rightAreaOf;

/** The actions a role can hold, in core's order: every one but `assets.release`. */
export function roleAreaActions(area: string): PlatformAction[] {
  return ACTIONS.filter((action) => action !== "assets.release" && rightAreaOf(action) === area);
}

/** The words of a built-in role's name and of what it is for; a custom role says its own. */
export function roleLabelKey(roleId: string): TranslationKey | undefined {
  switch (roleId) {
    case "user":
      return "settings.accessLevelUser";
    case "admin":
      return "settings.accessLevelAdmin";
    case "superadmin":
      return "settings.accessLevelSuperadmin";
    default:
      return undefined;
  }
}

export function roleDescriptionKey(roleId: string): TranslationKey | undefined {
  switch (roleId) {
    case "user":
      return "access.roleUserDescription";
    case "admin":
      return "access.roleAdminDescription";
    case "superadmin":
      return "access.roleSuperadminDescription";
    default:
      return undefined;
  }
}

/** One place's grants of an area, as one row of sentences says them. */
export interface RoleGrantPlace {
  key: string;
  place: SentencePlace;
  grants: RoleGrant[];
}

/**
 * The grants of a role by area, every area in the page's order, each area's grants by place:
 * the whole instance first, then each workspace and each asset. A grant on one asset names the
 * asset's kind by its action, since a role's grant carries no more of its asset.
 */
export function roleGrantsByArea(
  grants: readonly RoleGrant[]
): { area: RoleArea; grants: RoleGrant[]; places: RoleGrantPlace[] }[] {
  return ROLE_AREAS.map((area) => {
    const inArea = grants.filter((grant) => roleAreaOf(grant.action) === area);
    const places = new Map<string, RoleGrantPlace>();
    for (const grant of inArea) {
      const key = `${grant.scopeKind}:${grant.scopeId ?? ""}`;
      const kind = grant.action.slice(0, Math.max(grant.action.indexOf("."), 0));
      const entry = places.get(key) ?? {
        key,
        place: {
          scopeKind: grant.scopeKind,
          ...(grant.scopeId === undefined ? {} : { scopeId: grant.scopeId }),
          ...(grant.scopeKind === "asset" ? { scopeAsset: { kind, active: true } } : {})
        },
        grants: []
      };
      entry.grants.push(grant);
      places.set(key, entry);
    }
    const rank = { instance: 0, workspace: 1, asset: 2 } as const;
    return {
      area,
      grants: inArea,
      places: [...places.values()].sort((a, b) => rank[a.place.scopeKind] - rank[b.place.scopeKind])
    };
  });
}

/** Who edits a role on this page, as far as the page can tell before the server answers. */
export interface RoleEditor {
  /** The editor holds the role `superadmin`, the one who gives the rights only it hands out. */
  superadmin: boolean;
  /** The editor's own effective rights; absent while they load. */
  rights: EffectivePermissions | undefined;
}

/** Whether the editor holds the action on the whole instance, as the rule of no escalation asks. */
export function editorHolds(editor: RoleEditor, action: string): boolean {
  return authorizeHeldRights(giverAccess(editor.rights), [{ action }], { gives: { label: "" } })
    .allowed;
}

/**
 * Whether the editor may change the role at all: never `superadmin`, `user` and `admin` with
 * `roles.edit_built_in`, and a custom role with `users.manage`, which every role write asks.
 */
export function canEditRole(role: Pick<Role, "id" | "editable">, editor: RoleEditor): boolean {
  if (!role.editable || !editorHolds(editor, MANAGE_USERS_ACTION)) return false;
  return !isBuiltInRole(role.id) || editorHolds(editor, EDIT_BUILT_IN_ROLES_ACTION);
}

/** Why a right cannot be ticked or unticked for the whole instance, or nothing where it can. */
export type RightLock = "superadminOnly" | "refusedByRole" | "notHeld";

/** One right of an area as the area's dialog offers it on the whole instance. */
export interface AreaRightChoice {
  action: PlatformAction;
  checked: boolean;
  lock?: RightLock;
}

const instanceGrantOf = (grants: readonly RoleGrant[], action: string) =>
  grants.find((grant) => grant.action === action && grant.scopeKind === "instance");

/**
 * The rights of an area for the dialog: ticked where the role allows the action on the whole
 * instance. Only a superadmin ticks or unticks a right only a superadmin hands out; a right the
 * role refuses is not ticked over its refusal; and a right is ticked only by who holds it,
 * while anybody may untick one.
 */
export function areaRightChoices(
  area: RoleArea,
  grants: readonly RoleGrant[],
  editor: RoleEditor
): AreaRightChoice[] {
  return roleAreaActions(area).map((action) => {
    const grant = instanceGrantOf(grants, action);
    const checked = grant?.effect === "allow";
    const lock: RightLock | undefined =
      isSuperadminGrantedAction(action) && !editor.superadmin
        ? "superadminOnly"
        : grant?.effect === "deny"
          ? "refusedByRole"
          : !checked && !editorHolds(editor, action)
            ? "notHeld"
            : undefined;
    return { action, checked, ...(lock === undefined ? {} : { lock }) };
  });
}

/**
 * The role's grants with the area's instance-wide allows replaced by the ticked actions. Every
 * other grant, a refusal and a grant in one place among them, stays as it is and where it is.
 */
export function withAreaAllows(
  grants: readonly RoleGrant[],
  area: RoleArea,
  ticked: readonly string[]
): RoleGrantInput[] {
  const inArea = new Set<string>(roleAreaActions(area));
  const kept = grants.filter(
    (grant) =>
      !(grant.scopeKind === "instance" && grant.effect === "allow" && inArea.has(grant.action))
  );
  const added = roleAreaActions(area)
    .filter((action) => ticked.includes(action))
    .map((action) => ({ action, effect: "allow" as const, scopeKind: "instance" as const }));
  return [...kept, ...added].map(grantInput);
}

/** The role's grants without one of them. */
export function withoutGrant(grants: readonly RoleGrant[], removed: RoleGrant): RoleGrantInput[] {
  return grants.filter((grant) => !sameGrant(grant, removed)).map(grantInput);
}

function sameGrant(a: RoleGrant, b: RoleGrant): boolean {
  return (
    a.action === b.action &&
    a.effect === b.effect &&
    a.scopeKind === b.scopeKind &&
    a.scopeId === b.scopeId
  );
}

function grantInput(grant: RoleGrant): RoleGrantInput {
  return {
    action: grant.action,
    effect: grant.effect,
    scopeKind: grant.scopeKind,
    ...(grant.scopeId === undefined ? {} : { scopeId: grant.scopeId })
  };
}

/** The grants a new role copies from another, as the create call takes them. */
export function copiedGrants(role: Pick<Role, "grants">): RoleGrantInput[] {
  return role.grants.map(grantInput);
}

/** Why the server would refuse a role write before it is sent, as far as the page can tell. */
export type RoleChangeBlock = { kind: "needsRight"; action: string } | { kind: "superadminOnly" };

const grantKey = (grant: RoleGrant) =>
  [grant.action, grant.effect, grant.scopeKind, grant.scopeId ?? ""].join("|");

/**
 * What the server asks of a change from one set of grants to another (role-service
 * `authorizeWrite`): only a superadmin adds or removes a right only a superadmin hands out, and
 * the editor holds every right the change adds and every right a deny it lifts refused. A right
 * in one place is left to the server.
 */
function roleChangeBlock(
  before: readonly RoleGrant[],
  after: readonly RoleGrant[],
  editor: RoleEditor
): RoleChangeBlock | undefined {
  const had = new Set(before.map(grantKey));
  const has = new Set(after.map(grantKey));
  const added = after.filter((grant) => !had.has(grantKey(grant)));
  const removed = before.filter((grant) => !has.has(grantKey(grant)));
  if (
    !editor.superadmin &&
    [...added, ...removed].some((grant) => isSuperadminGrantedAction(grant.action))
  ) {
    return { kind: "superadminOnly" };
  }
  const missing = [...added, ...removed.filter((grant) => grant.effect === "deny")].find(
    (grant) => grant.scopeKind === "instance" && !editorHolds(editor, grant.action)
  );
  return missing === undefined ? undefined : { kind: "needsRight", action: missing.action };
}

/** Why "Reset to default" would be refused, or nothing. */
export function resetBlock(role: Role, editor: RoleEditor): RoleChangeBlock | undefined {
  return role.defaultGrants === undefined
    ? undefined
    : roleChangeBlock(role.grants, role.defaultGrants, editor);
}

/**
 * The grants once a pending action is applied, as the server writes them: an added action
 * becomes the role's allow on the instance in place of a refusal of it; a removed one takes
 * only that allow away.
 */
function pendingAppliedGrants(
  grants: readonly RoleGrant[],
  entry: Role["pendingActions"][number]
): RoleGrant[] {
  const onInstance = (grant: RoleGrant) =>
    grant.action === entry.action && grant.scopeKind === "instance";
  return entry.change === "added"
    ? [
        ...grants.filter((grant) => !onInstance(grant)),
        { action: entry.action, effect: "allow", scopeKind: "instance" }
      ]
    : grants.filter((grant) => !(onInstance(grant) && grant.effect === "allow"));
}

/** Why applying a pending action would be refused, or nothing. */
export function pendingApplyBlock(
  role: Role,
  entry: Role["pendingActions"][number],
  editor: RoleEditor
): RoleChangeBlock | undefined {
  return roleChangeBlock(role.grants, pendingAppliedGrants(role.grants, entry), editor);
}

/** The roles with actions a release changed that nobody decided yet. */
export function rolesWithPending(roles: readonly Role[] | undefined): Role[] {
  return (roles ?? []).filter((role) => role.pendingActions.length > 0);
}

/** How a role write failed, as far as the page has its own sentence for it. */
export type RoleWriteFailure =
  | { kind: "nameTaken" }
  | { kind: "inUse" }
  | { kind: "needsRight"; action: PlatformAction }
  | { kind: "superadminOnly" }
  | { kind: "other" };

export function roleWriteFailure(error: unknown): RoleWriteFailure {
  const reason = refusalReason(error);
  if (reason === "role_name_taken") return { kind: "nameTaken" };
  if (reason === "role_in_use") return { kind: "inUse" };
  if (!(error instanceof ApiError) || error.status !== 403) return { kind: "other" };
  // A refusal names the right the caller lacks, or the operation where only a superadmin may.
  const action = refusalDetail(error, "action");
  if (action !== undefined && isPlatformAction(action)) return { kind: "needsRight", action };
  return action?.startsWith("roles.") ? { kind: "superadminOnly" } : { kind: "other" };
}
