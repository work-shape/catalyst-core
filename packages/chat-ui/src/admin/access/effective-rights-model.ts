import type { AccessOrigin, HolderRights } from "@work-shape/catalyst-api-client";
import type { TranslationKey } from "../../shared/i18n";
import { assetKindLabelKey, grantKinds } from "./grant-words";

// The User screen's effective rights, grouped by area as the rights screens group them: the
// role page (AP-5b1) uses the same areas. The server decided every right and named where it
// comes from; this only orders and groups.

type HeldRight = HolderRights["rights"][number];

/** The area of rights that belong to no asset kind: the instance's administration. */
const ADMINISTRATION_AREA = "administration";

/** Rights at one place that come to the same and come from the same entries: one line. */
export interface EffectiveRightRow {
  key: string;
  /** The actions of the line, in the server's order. */
  actions: string[];
  /** The place every right of the line names. */
  place: HeldRight;
  allowed: boolean;
  reason: HeldRight["reason"];
  grantedBy: AccessOrigin[];
  deniedBy: AccessOrigin | undefined;
}

/** The rights of one kind, or of the administration. */
export interface EffectiveRightArea {
  /** The kind, or `administration`. */
  area: string;
  /** The name of the kind; absent for the administration. */
  label: TranslationKey | undefined;
  rows: EffectiveRightRow[];
}

/**
 * The kind an action belongs to, where the interface has words for it. A Builder or Publisher
 * bundle belongs to the workspace it is held in.
 */
export function rightAreaOf(action: string): string {
  const dot = action.indexOf(".");
  const kind = dot < 0 ? "workspace" : action.slice(0, dot);
  return assetKindLabelKey(kind) === undefined ? ADMINISTRATION_AREA : kind;
}

function originKey(origin: AccessOrigin | undefined): string {
  return origin === undefined
    ? ""
    : [origin.source, origin.roleId, origin.effect, origin.scopeKind, origin.scopeId].join(":");
}

/**
 * One area per kind in the order the rights screens list kinds, the administration last. In
 * an area, one line per place, decision and origins, in the server's order.
 */
export function effectiveRightAreas(rights: HolderRights["rights"]): EffectiveRightArea[] {
  const areas = new Map<string, Map<string, EffectiveRightRow>>();
  for (const right of rights) {
    const area = rightAreaOf(right.action);
    const key = [
      right.scopeKind,
      right.scopeId ?? "",
      right.allowed,
      right.reason ?? "",
      right.grantedBy.map(originKey).sort().join("|"),
      originKey(right.deniedBy)
    ].join("\u0000");
    const rows = areas.get(area) ?? new Map<string, EffectiveRightRow>();
    areas.set(area, rows);
    const row = rows.get(key);
    if (row) {
      row.actions.push(right.action);
    } else {
      rows.set(key, {
        key,
        actions: [right.action],
        place: right,
        allowed: right.allowed,
        reason: right.reason,
        grantedBy: right.grantedBy,
        deniedBy: right.deniedBy
      });
    }
  }
  const order = rightAreaOrder();
  return [...areas.entries()]
    .sort(([left], [right]) => order.indexOf(left) - order.indexOf(right))
    .map(([area, rows]) => ({
      area,
      label: area === ADMINISTRATION_AREA ? undefined : assetKindLabelKey(area),
      rows: [...rows.values()]
    }));
}

/** Every area in the order the rights screens show them: each kind, the administration last. */
export function rightAreaOrder(): string[] {
  return [...Object.keys(grantKinds), ADMINISTRATION_AREA];
}

/** The name of an area: its kind's, or the administration's. */
export function rightAreaLabelKey(area: string): TranslationKey {
  return (
    (area === ADMINISTRATION_AREA ? undefined : assetKindLabelKey(area)) ??
    "access.effectiveAreaAdministration"
  );
}
