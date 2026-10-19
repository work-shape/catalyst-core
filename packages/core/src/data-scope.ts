import type { ScopeAssignmentInput } from "@work-shape/catalyst-asset-schemas";
export {
  dataScopeNameSchema,
  dataScopesSchema,
  scopeAssignmentInputSchema,
  type ScopeAssignmentInput,
  type DataScopes
} from "@work-shape/catalyst-asset-schemas";

export type DataScope = "all" | readonly string[];

/** A person's explicit revocation wins over their own and their groups' allowances. */
export function resolveDataScope(
  assignments: readonly ScopeAssignmentInput[],
  dimension: string
): DataScope {
  const rows = assignments.filter((row) => row.dimension === dimension);
  const denied = rows.filter(
    (row) => row.effect === "deny" && (row.values === "all" || row.values.length > 0)
  );
  if (denied.some((row) => row.values === "all")) return [];
  const allowed = rows.filter((row) => row.effect === "allow");
  // An all allowance with individual exceptions cannot be represented as a finite set.
  // Fail closed rather than silently dropping the person's revocation.
  if (allowed.some((row) => row.values === "all")) return denied.length ? [] : "all";
  const excluded = new Set(denied.flatMap((row) => (row.values === "all" ? [] : [...row.values])));
  return [
    ...new Set(allowed.flatMap((row) => (row.values === "all" ? [] : [...row.values])))
  ].filter((value) => !excluded.has(value));
}

export { scopedTablesSchema, type ScopedTables } from "@work-shape/catalyst-asset-schemas";
