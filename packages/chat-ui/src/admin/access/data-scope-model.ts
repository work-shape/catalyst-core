import type { ScopeAssignmentsOverview } from "@work-shape/catalyst-api-client";

export type ScopeAssignment = ScopeAssignmentsOverview["assignments"][number];
export type ScopeHolderKind = ScopeAssignment["holderKind"];
export type ScopeValues = ScopeAssignment["values"];

/** A holder as the overview names it: a person, a group or a service principal. */
export interface ScopeHolder {
  kind: ScopeHolderKind;
  id: string;
  name: string;
}

/** Where a person's values on one dimension come from: their own row or one of their groups. */
interface ScopeSource {
  /** `undefined` for the person's own row. */
  group?: string;
  values: ScopeValues;
}

/** One holder's line in the overview of one dimension. */
export interface ScopeRow {
  holder: ScopeHolder;
  /** What the holder is given, by source; a group's or a principal's row has one source. */
  sources: ScopeSource[];
  /** Values the holder's own revocation takes away, or `all`. */
  excluded: ScopeValues | undefined;
  /** A person who sees no value at all: the overview marks them. */
  unassigned: boolean;
  /** The person's groups, as the overview shows them under the name. */
  groups: readonly string[];
}

const holderOrder: Record<ScopeHolderKind, number> = { user: 0, group: 1, service_principal: 2 };

function hasValues(values: ScopeValues | undefined): values is ScopeValues {
  return values === "all" || (values !== undefined && values.length > 0);
}

/** The row of a holder on a dimension with an effect, if it says anything. */
export function rowOf(
  assignments: readonly ScopeAssignment[],
  holder: { kind: ScopeHolderKind; id: string },
  dimension: string,
  effect: ScopeAssignment["effect"]
): ScopeValues | undefined {
  const values = assignments.find(
    (row) =>
      row.dimension === dimension &&
      row.holderKind === holder.kind &&
      row.holderId === holder.id &&
      row.effect === effect
  )?.values;
  return hasValues(values) ? values : undefined;
}

/**
 * The overview of one dimension: every person, each with what they see and where it comes
 * from, then each group and service principal that holds a row. A person's effective scope is
 * the server's; the sources only say why.
 */
export function scopeRows(
  overview: ScopeAssignmentsOverview,
  dimension: string,
  principalName: (id: string) => string
): ScopeRow[] {
  const { assignments } = overview;
  const people = overview.people.map((person): ScopeRow => {
    const holder = { kind: "user" as const, id: person.id, name: person.displayLabel };
    const own = rowOf(assignments, holder, dimension, "allow");
    const sources: ScopeSource[] = [
      ...(own === undefined ? [] : [{ values: own }]),
      ...person.groups.flatMap((group) => {
        const values = rowOf(assignments, { kind: "group", id: group }, dimension, "allow");
        return values === undefined ? [] : [{ group, values }];
      })
    ];
    const effective = person.effective[dimension];
    return {
      holder,
      sources,
      excluded: rowOf(assignments, holder, dimension, "deny"),
      unassigned: effective === undefined || (effective !== "all" && effective.length === 0),
      groups: person.groups
    };
  });
  const others = new Map<string, ScopeRow>();
  for (const row of assignments) {
    if (row.dimension !== dimension || row.holderKind === "user") continue;
    const key = `${row.holderKind}:${row.holderId}`;
    if (others.has(key)) continue;
    const holder: ScopeHolder = {
      kind: row.holderKind,
      id: row.holderId,
      name: row.holderKind === "group" ? row.holderId : principalName(row.holderId)
    };
    const allowed = rowOf(assignments, holder, dimension, "allow");
    const excluded = rowOf(assignments, holder, dimension, "deny");
    if (allowed === undefined && excluded === undefined) continue;
    others.set(key, {
      holder,
      sources: allowed === undefined ? [] : [{ values: allowed }],
      excluded,
      unassigned: false,
      groups: []
    });
  }
  const byName = (left: ScopeRow, right: ScopeRow) =>
    holderOrder[left.holder.kind] - holderOrder[right.holder.kind] ||
    left.holder.name.localeCompare(right.holder.name);
  return [...people.sort(byName), ...[...others.values()].sort(byName)];
}

/** Every group a person belongs to or a row names, by name. */
export function knownGroups(overview: ScopeAssignmentsOverview): string[] {
  return [
    ...new Set([
      ...overview.people.flatMap((person) => person.groups),
      ...overview.assignments.flatMap((row) => (row.holderKind === "group" ? [row.holderId] : []))
    ])
  ].sort((left, right) => left.localeCompare(right));
}

/**
 * Whether the reader may change a holder's rows: nobody changes their own, also not through a
 * group they belong to (the server refuses it as well).
 */
export function isOwnHolder(
  holder: { kind: ScopeHolderKind; id: string },
  self: { id: string; groups: readonly string[] }
): boolean {
  return holder.kind === "user"
    ? holder.id === self.id
    : holder.kind === "group" && self.groups.includes(holder.id);
}
