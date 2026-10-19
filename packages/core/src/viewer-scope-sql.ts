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

/**
 * Postgres's identifier characters (scan.l `ident_start`, `ident_cont`, `dolq_start`): ASCII
 * letters, `_` and every character outside ASCII, whether or not it is a letter.
 */
const IDENT_START = "A-Za-z_\\u{80}-\\u{10FFFF}";
const IDENT_CONT = `${IDENT_START}0-9`;
const DOLLAR_QUOTE = new RegExp(`^\\$(?:[${IDENT_START}][${IDENT_CONT}]*)?\\$`, "u");
const WORD = new RegExp(`^(?:[0-9]+|[${IDENT_START}][${IDENT_CONT}$]*)`, "u");

/**
 * Read executable tokens only, where Postgres's lexer reads them. Strings, identifiers and
 * nested comments never bind a viewer.
 */
export function sqlTokens(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let index = 0;
  while (index < sql.length) {
    const rest = sql.slice(index);
    if (rest.startsWith("--")) {
      // A line comment ends at a carriage return as well as at a newline.
      const end = rest.search(/[\n\r]/u);
      index = end < 0 ? sql.length : index + end;
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
    // `E'` and `U&"` begin a token only where a word would: inside `type'…'` the `e` is the
    // type name's, as in Postgres's longest match.
    const prefix = /^(?:[eE](?=')|[uU]&(?="))/u.exec(rest)?.[0] ?? "";
    const quote = sql[index + prefix.length];
    if (quote === "'" || quote === '"') {
      const start = index;
      const escapes = quote === "'" && prefix.length > 0;
      const unicode = quote === '"' && prefix.length > 0;
      index += prefix.length + 1;
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
          text: sql.slice(start + prefix.length + 1, index - 1).replaceAll('""', '"'),
          // U&"..." spells an identifier with escapes, which no reader here undoes.
          ...(unicode ? { unicode: true as const } : {})
        });
      continue;
    }
    const dollar = DOLLAR_QUOTE.exec(rest);
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
    const word = WORD.exec(rest)?.[0];
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
