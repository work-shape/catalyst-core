import { PostgresExecutorError } from "./errors";
import { POSTGRES_QUERY_TEXT_MAX_CHARS } from "./limits";

/**
 * Refuses a query that is plainly not one read-only statement, so its author gets a clear
 * answer before the database is asked. This is a courtesy, not the boundary: the read-only
 * transaction and the database role decide what a query can do.
 */
export function screenPostgresQuery(query: string): void {
  if (query.length > POSTGRES_QUERY_TEXT_MAX_CHARS) {
    throw rejected(`Queries must not be longer than ${POSTGRES_QUERY_TEXT_MAX_CHARS} characters`);
  }
  const normalized = maskLiteralsAndComments(query).trim().replace(/;+$/u, "").trim();
  if (!/^(select|with)\b/iu.test(normalized)) {
    throw rejected("Queries must be read-only SELECT or WITH statements");
  }
  if (/;\s*\S/u.test(normalized)) {
    throw rejected("Queries must contain a single statement");
  }
  if (
    /\bfor\s+(?:no\s+key\s+)?update\b/iu.test(normalized) ||
    /\bfor\s+(?:key\s+)?share\b/iu.test(normalized)
  ) {
    throw rejected("Queries must not request row locks");
  }
  if (containsDisallowedToken(normalized)) {
    throw rejected("Queries must not contain write, DDL, transaction, or session-control SQL");
  }
}

function rejected(message: string): PostgresExecutorError {
  return new PostgresExecutorError("query_rejected", message);
}

const DISALLOWED_TOKENS = new Set([
  "alter",
  "analyze",
  "call",
  "copy",
  "create",
  "delete",
  "discard",
  "do",
  "drop",
  "execute",
  "grant",
  "insert",
  "listen",
  "lock",
  "merge",
  "notify",
  "refresh",
  "reset",
  "revoke",
  "set",
  "truncate",
  "update",
  "vacuum"
]);

function containsDisallowedToken(sql: string): boolean {
  for (const match of sql.matchAll(/\b[a-z_][a-z0-9_]*\b/giu)) {
    if (DISALLOWED_TOKENS.has(match[0].toLowerCase())) return true;
  }
  return /\bselect\b[\s\S]*\binto\b/iu.test(sql);
}

/** Blanks out string literals, quoted identifiers and comments, keeping every position. */
function maskLiteralsAndComments(sql: string): string {
  let output = "";
  let index = 0;
  while (index < sql.length) {
    const end = maskedSpanEnd(sql, index);
    if (end === undefined) {
      output += sql.charAt(index);
      index += 1;
    } else {
      output += " ".repeat(end - index);
      index = end;
    }
  }
  return output;
}

/** Where the literal, quoted identifier or comment that starts at `start` ends, if one does. */
function maskedSpanEnd(sql: string, start: number): number | undefined {
  const char = sql.charAt(start);
  const pair = sql.slice(start, start + 2);
  if (char === "'" || char === '"') return quotedEnd(sql, start, char);
  if (pair === "--") return endAt(sql, sql.indexOf("\n", start + 2), 0);
  if (pair === "/*") return endAt(sql, sql.indexOf("*/", start + 2), 2);
  if (char !== "$") return undefined;
  const tag = /^\$(?:[a-z_][a-z0-9_]*)?\$/iu.exec(sql.slice(start))?.[0];
  if (tag === undefined) return undefined;
  return endAt(sql, sql.indexOf(tag, start + tag.length), tag.length);
}

function endAt(sql: string, closeIndex: number, closeLength: number): number {
  return closeIndex === -1 ? sql.length : closeIndex + closeLength;
}

function quotedEnd(sql: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < sql.length) {
    if (sql.charAt(index) !== quote) index += 1;
    else if (sql.charAt(index + 1) === quote) index += 2;
    else return index + 1;
  }
  return sql.length;
}
