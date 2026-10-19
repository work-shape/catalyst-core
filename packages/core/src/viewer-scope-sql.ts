import type { ScopedTables } from "@work-shape/catalyst-asset-schemas";
import { AppError } from "./errors";

export interface ViewerScopeBinding {
  start: number;
  end: number;
  dimension: string;
  all: boolean;
}

/** Read executable tokens only. Strings, identifiers and nested comments never bind a viewer. */
export function viewerScopeBindings(sql: string): ViewerScopeBinding[] {
  const bindings: ViewerScopeBinding[] = [];
  let index = 0;
  while (index < sql.length) {
    const rest = sql.slice(index);
    if (rest.startsWith("--")) {
      const end = sql.indexOf("\n", index);
      index = end < 0 ? sql.length : end;
      continue;
    }
    if (rest.startsWith("/*")) {
      let depth = 1;
      index += 2;
      while (index < sql.length && depth) {
        if (sql.startsWith("/*", index)) {
          depth++;
          index += 2;
        } else if (sql.startsWith("*/", index)) {
          depth--;
          index += 2;
        } else index++;
      }
      if (depth) throw new AppError("VALIDATION_FAILED", "The SQL comment never ends");
      continue;
    }
    const quote = sql[index];
    if (quote === "'" || quote === '"') {
      const escapes = quote === "'" && /(?:^|[^\p{L}\p{N}_$])[eE]$/u.test(sql.slice(0, index));
      index++;
      let closed = false;
      while (index < sql.length) {
        if (escapes && sql[index] === "\\") {
          index += 2;
          continue;
        }
        if (sql[index++] !== quote) continue;
        if (sql[index] === quote) {
          index++;
          continue;
        }
        closed = true;
        break;
      }
      if (!closed) throw new AppError("VALIDATION_FAILED", "The SQL quoted value never ends");
      continue;
    }
    const dollar = /^\$(?:[\p{L}_][\p{L}\p{N}_]*)?\$/u.exec(rest);
    if (dollar) {
      const end = sql.indexOf(dollar[0], index + dollar[0].length);
      if (end < 0)
        throw new AppError("VALIDATION_FAILED", "The SQL dollar-quoted value never ends");
      index = end + dollar[0].length;
      continue;
    }
    if (/^\$viewer\.(?:scope_all|scope)(?![\p{L}\p{N}_$])/u.test(rest)) {
      const binding = /^\$viewer\.(scope_all|scope)\(\s*'([a-z][a-z0-9_]{0,62})'\s*\)/u.exec(rest);
      if (!binding?.[2])
        throw new AppError(
          "VALIDATION_FAILED",
          "A viewer scope binding names its dimension as $viewer.scope('dimension') or $viewer.scope_all('dimension')"
        );
      bindings.push({
        start: index,
        end: index + binding[0].length,
        dimension: binding[2],
        all: binding[1] === "scope_all"
      });
      index += binding[0].length;
      continue;
    }
    const word = /^[\p{L}\p{N}_][\p{L}\p{N}_$]*/u.exec(rest);
    index += word?.[0].length ?? 1;
  }
  return bindings;
}

/** Static publish check: every declared table must bind its dimension, including reads through a view. */
export function requireScopeBindings(
  sql: string,
  tables: ScopedTables | undefined,
  action: string
): void {
  const bindings = viewerScopeBindings(sql);
  for (const [table, metadata] of Object.entries(tables ?? {})) {
    for (const dimension of Object.keys(metadata.scope)) {
      if (!bindings.some((binding) => binding.dimension === dimension && !binding.all))
        throw new AppError(
          "VALIDATION_FAILED",
          `Action '${action}' reads scoped table '${table}' without $viewer.scope('${dimension}')`,
          { reason: "scope_binding_required", action, table }
        );
    }
  }
}
