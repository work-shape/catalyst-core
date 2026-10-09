// How a migration file is read: by the migration step to decide how a migration runs, and by the
// migration lint to decide whether it may ship. Plain JavaScript so the lint runs without a build.

/** Drizzle's statement separator. The migration step sends each part between two as one query. */
export const statementBreakpoint = "--> statement-breakpoint";

const namePattern = String.raw`(?:\{\d+\}|[A-Z_][A-Z0-9_$]*)`;
/** A possibly schema-qualified name in a statement shape; the last part is captured. */
export const qualifiedNamePattern = String.raw`(?:${namePattern}\.)?(${namePattern})`;

/**
 * Splits a migration exactly where the migration step does, then reads the statements of each
 * part. `malformedBreakpoints` lists separator lines that carry more than the separator and
 * comments that look like one without being one.
 * @param {string} text
 * @returns {import("./migration-statements").ParsedMigration}
 */
export function parseMigration(text) {
  const parts = text.split(statementBreakpoint);
  /** @type {string[]} */
  const malformedBreakpoints = [];
  const chunks = parts.map((part, index) => {
    const line = part.slice(0, part.includes("\n") ? part.indexOf("\n") : undefined);
    if (index > 0 && line.trim() !== "")
      malformedBreakpoints.push(`${statementBreakpoint}${line.trimEnd()}`);
    const { statements, comments } = readChunk(part);
    for (const comment of comments)
      if (/statement-breakpoint/iu.test(comment)) malformedBreakpoints.push(`--${comment}`);
    return { text: part, statements };
  });
  return { chunks, malformedBreakpoints };
}

/**
 * The statements of one query text, split at top-level semicolons. A statement keeps the comments
 * that precede it. Its `shape` is what rules match: keywords in upper case, every quoted
 * identifier replaced by `{n}` (its place in `identifiers`) and every string literal by `''`, so
 * a keyword is never found inside a name, a literal or a comment.
 * @param {string} text
 * @returns {import("./migration-statements").MigrationStatement[]}
 */
export function parseSqlChunk(text) {
  return readChunk(text).statements;
}

/** @param {string} text */
function readChunk(text) {
  /** @type {import("./migration-statements").MigrationStatement[]} */
  const statements = [];
  /** @type {string[]} */
  const allComments = [];
  let sql = "";
  let shape = "";
  /** @type {string[]} */
  let identifiers = [];
  /** @type {string[]} */
  let comments = [];
  const end = () => {
    if (sql.trim())
      statements.push({
        sql: sql.trim().replace(/\s+/gu, " "),
        shape: shape.trim().replace(/\s+/gu, " "),
        identifiers,
        comments
      });
    sql = "";
    shape = "";
    identifiers = [];
    comments = [];
  };
  for (let index = 0; index < text.length;) {
    const rest = text.slice(index);
    const dollarQuote = /^\$[A-Za-z_]*\$/u.exec(rest)?.[0];
    const word = /^[A-Za-z_][A-Za-z0-9_$]*/u.exec(rest)?.[0];
    if (rest.startsWith("--")) {
      const line = rest.slice(2, rest.includes("\n") ? rest.indexOf("\n") : undefined);
      comments.push(line.trimEnd());
      allComments.push(line.trimEnd());
      index += 2 + line.length;
    } else if (rest.startsWith("/*")) {
      const close = rest.indexOf("*/");
      const length = close < 0 ? rest.length : close + 2;
      comments.push(rest.slice(2, close < 0 ? rest.length : close).trim());
      allComments.push(rest.slice(2, close < 0 ? rest.length : close).trim());
      index += length;
    } else if (dollarQuote) {
      const close = rest.indexOf(dollarQuote, dollarQuote.length);
      sql += "$$";
      shape += "''";
      index += close < 0 ? rest.length : close + dollarQuote.length;
    } else if (rest[0] === "'") {
      const literal = /^'(?:[^']|'')*'?/u.exec(rest)?.[0] ?? "'";
      sql += "''";
      shape += "''";
      index += literal.length;
    } else if (rest[0] === '"') {
      const quoted = /^"(?:[^"]|"")*"?/u.exec(rest)?.[0] ?? '"';
      sql += quoted;
      shape += `{${identifiers.length}}`;
      identifiers.push(quoted.replace(/^"|"$/gu, "").replaceAll('""', '"'));
      index += quoted.length;
    } else if (word) {
      sql += word;
      shape += word.toUpperCase();
      index += word.length;
    } else if (rest[0] === ";") {
      end();
      index += 1;
    } else {
      sql += rest[0];
      shape += rest[0];
      index += 1;
    }
  }
  end();
  return { statements, comments: allComments };
}

/**
 * The name a shape token stands for: the quoted identifier as written, or the folded bare word.
 * @param {import("./migration-statements").MigrationStatement} statement
 * @param {string} token
 */
export function statementName(statement, token) {
  const quoted = /^\{(\d+)\}$/u.exec(token)?.[1];
  return quoted === undefined ? token.toLowerCase() : (statement.identifiers[Number(quoted)] ?? "");
}

/**
 * True for a statement Postgres refuses inside a transaction because it works concurrently.
 * @param {import("./migration-statements").MigrationStatement} statement
 */
export function runsOutsideTransaction(statement) {
  return /\bCONCURRENTLY\b/u.test(statement.shape);
}

/**
 * The index a `CREATE INDEX CONCURRENTLY` statement builds.
 * @param {import("./migration-statements").MigrationStatement} statement
 * @returns {string | undefined}
 */
export function concurrentIndexName(statement) {
  const token = new RegExp(
    String.raw`^CREATE (?:UNIQUE )?INDEX CONCURRENTLY (?:IF NOT EXISTS )?${qualifiedNamePattern} ON\b`,
    "u"
  ).exec(statement.shape)?.[1];
  return token === undefined ? undefined : statementName(statement, token);
}
