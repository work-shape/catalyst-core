import { AppError } from "./errors";

export interface ViewerScopeBinding {
  start: number;
  end: number;
  dimension: string;
  all: boolean;
}

/**
 * One token of executable SQL: a word (an unquoted identifier or keyword, its ASCII letters
 * folded to lower case as Postgres folds them), a quoted identifier with its quotes undone, a
 * viewer binding, or any other single character. Strings and comments are no tokens.
 */
export type SqlToken =
  | { kind: "word" | "quoted"; start: number; end: number; text: string; unicode?: true }
  | ({ kind: "viewer"; text: string } & ViewerScopeBinding)
  | { kind: "symbol"; start: number; end: number; text: string };

/** Read executable tokens only. Strings, identifiers and nested comments never bind a viewer. */
export function sqlTokens(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
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
      const start = index;
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
      if (quote === '"')
        tokens.push({
          kind: "quoted",
          start,
          end: index,
          text: sql.slice(start + 1, index - 1).replaceAll('""', '"'),
          // U&"..." spells an identifier with escapes, which no reader here undoes.
          ...(/(?:^|[^\p{L}\p{N}_$])[uU]&$/u.test(sql.slice(0, start))
            ? { unicode: true as const }
            : {})
        });
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
      tokens.push({
        kind: "viewer",
        text: binding[0],
        start: index,
        end: index + binding[0].length,
        dimension: binding[2],
        all: binding[1] === "scope_all"
      });
      index += binding[0].length;
      continue;
    }
    // A number ends where a word begins, so `1findings` holds the word `findings`.
    const word = /^(?:[0-9]+|[\p{L}_][\p{L}\p{N}_$]*)/u.exec(rest)?.[0];
    if (word) {
      tokens.push({
        kind: "word",
        start: index,
        end: index + word.length,
        text: word.replace(/[A-Z]+/gu, (letters) => letters.toLowerCase())
      });
      index += word.length;
      continue;
    }
    if (!/^\s/u.test(rest))
      tokens.push({ kind: "symbol", start: index, end: index + 1, text: sql.charAt(index) });
    index++;
  }
  return tokens;
}

export function viewerScopeBindings(sql: string): ViewerScopeBinding[] {
  return sqlTokens(sql).flatMap((token) =>
    token.kind === "viewer"
      ? [{ start: token.start, end: token.end, dimension: token.dimension, all: token.all }]
      : []
  );
}
