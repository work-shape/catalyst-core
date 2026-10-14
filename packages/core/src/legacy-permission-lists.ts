import {
  LEGACY_PERMISSION_ACTIONS,
  PERMISSIONS,
  isPermission,
  type LegacyRowView,
  type Permission,
  type PermissionGrant,
  type PlatformAction
} from "./permissions";

// The legacy permission list of a user or a service principal as their instance-wide grant
// rows say it (AP-4), until the User page shows the rows one by one.

/**
 * Who wrote a grant row that a legacy permission list stands for when no person did: the
 * migration of the lists, a first sign-in whose claims bring a list, a seed.
 */
export const LEGACY_LIST_GRANTOR = "legacy_permission_list";

/** One instance-wide row that a key of a legacy list stands for. */
export interface LegacyGrantRow {
  action: PlatformAction;
  effect: PermissionGrant["effect"];
}

/** What a holder's instance-wide rows, or a legacy list, say about one key. */
type LegacyKeyState = PermissionGrant["effect"] | "none" | "partial";

function keyStateOfRows(rows: readonly LegacyRowView[], key: Permission): LegacyKeyState {
  const effects = LEGACY_PERMISSION_ACTIONS[key].map(
    (action) =>
      rows.find((row) => row.scopeKind === "instance" && row.action === action)?.effect ?? "none"
  );
  const [first] = effects;
  return first !== undefined && effects.every((effect) => effect === first) ? first : "partial";
}

/** A revocation wins over an entry of the same key, as it did in the list. */
function keyStateOfList(entries: readonly string[], key: Permission): LegacyKeyState {
  if (entries.includes(`!${key}`)) return "deny";
  return entries.includes(key) ? "allow" : "none";
}

/**
 * The legacy list a holder's instance-wide rows add up to: a key whose actions are all
 * allowed, `!key` for one whose actions are all denied. A key whose actions differ is in
 * neither form. The Users and API access screens read and write this list until the User
 * page shows rows one by one.
 */
export function legacyPermissionList(rows: readonly LegacyRowView[]): string[] {
  return PERMISSIONS.flatMap((key) => {
    const state = keyStateOfRows(rows, key);
    return state === "allow" ? [key] : state === "deny" ? [`!${key}`] : [];
  });
}

/** The instance-wide rows a legacy list stands for, and nothing for an entry it does not know. */
export function legacyGrantRows(entries: readonly string[]): LegacyGrantRow[] {
  return PERMISSIONS.flatMap((key) => {
    const state = keyStateOfList(entries, key);
    return state === "allow" || state === "deny"
      ? LEGACY_PERMISSION_ACTIONS[key].map((action) => ({ action, effect: state }))
      : [];
  });
}

/** The rows to remove and to write so that a holder's rows say what a submitted list says. */
export interface LegacyGrantChange {
  remove: PlatformAction[];
  add: LegacyGrantRow[];
}

/**
 * Changes only the keys whose state the list changes, so a row keeps who wrote it and when.
 * A key the list does not name keeps rows whose actions differ: the list cannot show them.
 */
export function legacyGrantChange(
  rows: readonly LegacyRowView[],
  entries: readonly string[]
): LegacyGrantChange {
  const change: LegacyGrantChange = { remove: [], add: [] };
  for (const key of PERMISSIONS) {
    const before = keyStateOfRows(rows, key);
    const after = keyStateOfList(entries, key);
    if (before === after || (before === "partial" && after === "none")) continue;
    change.remove.push(...LEGACY_PERMISSION_ACTIONS[key]);
    if (after === "allow" || after === "deny") {
      change.add.push(
        ...LEGACY_PERMISSION_ACTIONS[key].map((action) => ({ action, effect: after }))
      );
    }
  }
  return change;
}

/** The entries of a submitted list that are neither a key nor the revocation of one. */
export function unknownLegacyEntries(entries: readonly string[]): string[] {
  return entries.filter((entry) => !isPermission(entry.startsWith("!") ? entry.slice(1) : entry));
}
