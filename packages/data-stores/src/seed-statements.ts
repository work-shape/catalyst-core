// The statements of one seed file, so that a failure of the build of a test copy names the
// statement it stopped at. The split follows the lexical rules of Postgres that can hide a
// semicolon: quoted strings and names, escape strings, dollar quotes and both kinds of
// comment. Whatever it gets wrong, Postgres still runs only what the file says: each part runs
// as one statement of its own, held in the copy's one transaction.

const DOLLAR_TAG = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/u;

/** The statements of the text in their order, without the semicolons between them and without empty ones. */
export function splitSeedStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let index = 0;
  const push = (end: number) => {
    const statement = sql.slice(start, end).trim();
    if (statement !== "" && !onlyComments(statement)) statements.push(statement);
  };
  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];
    if (char === "-" && next === "-") {
      const end = sql.indexOf("\n", index);
      index = end === -1 ? sql.length : end + 1;
    } else if (char === "/" && next === "*") {
      index = blockCommentEnd(sql, index);
    } else if (char === "'") {
      const escaped =
        index > 0 && /[eE]/u.test(sql[index - 1] ?? "") && !wordBefore(sql, index - 1);
      index = quotedEnd(sql, index, "'", escaped);
    } else if (char === '"') {
      index = quotedEnd(sql, index, '"', false);
    } else if (char === "$" && !wordBefore(sql, index)) {
      const tag = DOLLAR_TAG.exec(sql.slice(index))?.[0];
      if (tag) {
        const end = sql.indexOf(tag, index + tag.length);
        index = end === -1 ? sql.length : end + tag.length;
      } else {
        index += 1;
      }
    } else if (char === ";") {
      push(index);
      index += 1;
      start = index;
    } else {
      index += 1;
    }
  }
  push(sql.length);
  return statements;
}

/** Whether the character before `index` continues a word, so `$` or `E` there is part of a name. */
function wordBefore(sql: string, index: number): boolean {
  return index > 0 && /[A-Za-z0-9_$]/u.test(sql[index - 1] ?? "");
}

function quotedEnd(sql: string, open: number, quote: string, backslashes: boolean): number {
  let index = open + 1;
  while (index < sql.length) {
    const char = sql[index];
    if (backslashes && char === "\\") {
      index += 2;
    } else if (char === quote) {
      // A doubled quote stands for one and does not close.
      if (sql[index + 1] === quote) index += 2;
      else return index + 1;
    } else {
      index += 1;
    }
  }
  return sql.length;
}

/** Postgres nests block comments. */
function blockCommentEnd(sql: string, open: number): number {
  let depth = 0;
  let index = open;
  while (index < sql.length) {
    if (sql[index] === "/" && sql[index + 1] === "*") {
      depth += 1;
      index += 2;
    } else if (sql[index] === "*" && sql[index + 1] === "/") {
      depth -= 1;
      index += 2;
      if (depth === 0) return index;
    } else {
      index += 1;
    }
  }
  return sql.length;
}

function onlyComments(statement: string): boolean {
  return splitless(statement).trim() === "";
}

/** The text with its comments taken out, for telling a statement from a run of comments. */
function splitless(statement: string): string {
  let out = "";
  let index = 0;
  while (index < statement.length) {
    if (statement[index] === "-" && statement[index + 1] === "-") {
      const end = statement.indexOf("\n", index);
      index = end === -1 ? statement.length : end + 1;
    } else if (statement[index] === "/" && statement[index + 1] === "*") {
      index = blockCommentEnd(statement, index);
    } else {
      out += statement[index];
      index += 1;
    }
  }
  return out;
}
