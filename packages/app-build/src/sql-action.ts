import {
  DATA_STORE_INSERT_CONFLICT_MODES,
  DATA_STORE_SCALAR_TYPES,
  OPERATION_EFFECTS
} from "@work-shape/catalyst-core";
import { APP_ACTION_MAX_PARAMETERS, type SqlActionParameter } from "./action-input";

// The statement of an `sql` action: one file `actions/<name>.sql`. Its first lines are the
// header, where each `-- @param <name> <type>` declares one parameter. The statement below the
// header names a parameter as `$name`. The build reads the file as text and never runs it.
//
// A reading action is one SELECT or WITH statement. The build writes it into the manifest with
// every `$name` replaced by the position of its parameter, and the parameters in that order.
// The database binds a value to a position; no value is ever written into the statement.
//
// A changing action is one INSERT of one row whose values are parameters. The build writes no
// statement for it: it writes the table and which parameter goes into which column, which is
// the input of the store's own insert. So a change of an App is made by the same operation,
// under the same size limit and with the same right, as every other insert into the store.
//
// What a file may be is checked here so that its author is told at the build. It is a
// courtesy and no boundary: the store's role and its transaction decide what a statement does.
//
// The reading below follows how PostgreSQL splits a statement into tokens, as far as it takes
// to know where a `$name` stands for a parameter: not inside a string, a quoted name, a
// comment or a dollar-quoted text.

/** What the name of a statement file ends with. */
export const APP_SQL_ACTION_FILE_SUFFIX = ".sql";
/**
 * A statement file is one query and its header. One larger than this is refused before a
 * character of it is read. A position is at most a character longer than the shortest name it
 * replaces, so a file of this size compiles to a statement of at most 18,432 characters, which
 * is within the 20,000 one query of a Data Store takes.
 */
export const APP_SQL_ACTION_FILE_MAX_BYTES = 12 * 1024;

const PARAMETER_TYPES: readonly SqlActionParameter["type"][] = DATA_STORE_SCALAR_TYPES.flatMap(
  (type) => [type, `${type}[]`] as const
);

const HEADER_DIRECTIVE = /^\s*--\s*@(\w+)\s*(.*)$/u;
const PARAMETER_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/u;
/** A name, a key word or a number: the `$` inside one is part of it and starts nothing. */
const WORD = /[\p{L}\p{N}_][\p{L}\p{N}_$]*/uy;
const DOLLAR_QUOTE = /\$(?:[\p{L}_][\p{L}\p{N}_]*)?\$/uy;
const PLACEHOLDER = /\$([A-Za-z_][A-Za-z0-9_]*)/uy;
const VIEWER_SCOPE = /\$viewer\.(scope_all|scope|groups)(?![\p{L}\p{N}_$])/uy;
const POSITION = /\$\d+/uy;

const NAME = String.raw`[A-Za-z_][A-Za-z0-9_]*|"(?:[^"]|"")+"`;
const VALUE = String.raw`\$[A-Za-z_][A-Za-z0-9_]*`;
/** The one form of a changing statement: a row of parameters into named columns of one table. */
const INSERT = new RegExp(
  String.raw`^\s*insert\s+into\s+(?:public\s*\.\s*)?(${NAME})\s*\(((?:\s*(?:${NAME})\s*,)*\s*(?:${NAME})\s*)\)\s*values\s*\(((?:\s*${VALUE}\s*,)*\s*${VALUE}\s*)\)\s*(on\s+conflict\s+do\s+nothing\s*)?;?\s*$`,
  "iu"
);
const READ = /^\s*(?:select|with)\b[^;]*;?\s*$/iu;

interface SqlActionFault {
  message: string;
  /** Counts from 1, in the file. */
  line: number;
  /** The statement is not of a form an action of its effect may have. */
  notAllowed?: true;
}

type DeclaredParameter = SqlActionParameter & { optional: boolean };

/** What the store's insert is told for a changing action: the table, and a parameter per column. */
interface SqlActionInsert {
  table: string;
  columns: { column: string; parameter: string }[];
  /** `skip` where the statement ends with `on conflict do nothing`. */
  onConflict: (typeof DATA_STORE_INSERT_CONFLICT_MODES)[number];
}

type CompiledSqlStatement =
  | {
      effect: "reading";
      /** The statement with positions in place of names. */
      statement: string;
      /** The parameters in the order of their positions, and whether a call may leave one out. */
      parameters: DeclaredParameter[];
    }
  | { effect: "changing"; insert: SqlActionInsert; parameters: DeclaredParameter[] }
  | { faults: SqlActionFault[] };

/**
 * Compiles the text of a statement file for an action of the given effect. It answers what
 * the manifest keeps of it, or every fault with its line.
 */
export function compileSqlStatement(
  text: string,
  effect: (typeof OPERATION_EFFECTS)[number]
): CompiledSqlStatement {
  const lines = text.split("\n");
  const faults: SqlActionFault[] = [];
  const parameters: (SqlActionParameter & { optional: boolean })[] = [];
  const declaredAt = new Map<string, number>();
  let headerLines = 0;
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed !== "" && !trimmed.startsWith("--")) break;
    headerLines = index + 1;
    const directive = HEADER_DIRECTIVE.exec(line);
    if (!directive) continue;
    const declared = readParameter(directive[1] ?? "", directive[2] ?? "");
    if ("message" in declared) {
      faults.push({ message: declared.message, line: index + 1 });
    } else if (parameters.some(({ name }) => name === declared.name)) {
      faults.push({
        message: `The parameter '${declared.name}' is declared twice.`,
        line: index + 1
      });
    } else {
      parameters.push(declared);
      declaredAt.set(declared.name, index + 1);
    }
  }
  if (parameters.length > APP_ACTION_MAX_PARAMETERS) {
    faults.push({
      message: `The statement declares ${parameters.length} parameters. It has at most ${APP_ACTION_MAX_PARAMETERS} (APP_ACTION_MAX_PARAMETERS).`,
      line: 1
    });
  }
  // A header that was not read leaves names undeclared: its faults are told alone.
  if (faults.length > 0) return { faults };
  const body = lines.slice(headerLines).join("\n");
  if (body.trim() === "") {
    return {
      faults: [{ message: "The file holds no statement below its header.", line: lines.length }]
    };
  }
  const positions = new Map(parameters.map(({ name }, index) => [name, index + 1]));
  const used = new Set<string>();
  const lineAt = (offset: number) =>
    headerLines + 1 + (body.slice(0, offset).split("\n").length - 1);
  let statement = "";
  // The statement as its form is read: a comment is a blank and a string is an empty one.
  let form = "";
  let index = 0;
  while (index < body.length) {
    const span = readSpan(body, index);
    if ("fault" in span) {
      faults.push({ message: span.fault, line: lineAt(index) });
      return { faults };
    }
    form +=
      span.masked === "comment" ? " " : span.masked === "text" ? "''" : body.slice(index, span.end);
    if (span.placeholder === undefined) {
      statement += body.slice(index, span.end);
    } else {
      const position = positions.get(span.placeholder);
      if (position === undefined) {
        faults.push({
          message: `The statement names '$${span.placeholder}', which the header does not declare. Add '-- @param ${span.placeholder} <type>' above the statement.`,
          line: lineAt(index)
        });
      } else {
        used.add(span.placeholder);
        statement += `$${position}`;
      }
    }
    index = span.end;
  }
  for (const { name } of parameters) {
    if (!used.has(name)) {
      faults.push({
        message: `The parameter '${name}' is declared and the statement never names '$${name}'. Use it or remove its line.`,
        line: declaredAt.get(name) ?? 1
      });
    }
  }
  if (faults.length > 0) return { faults };
  if (effect === "reading") {
    return READ.test(form)
      ? { effect, statement: statement.trim(), parameters }
      : {
          faults: [
            {
              message:
                "A reading action is one SELECT or WITH statement. This file holds something else, or more than one statement. Declare an action that adds a row as changing.",
              line: headerLines + 1,
              notAllowed: true
            }
          ]
        };
  }
  const insert = readInsert(form);
  return "message" in insert
    ? { faults: [{ message: insert.message, line: headerLines + 1, notAllowed: true }] }
    : { effect, insert, parameters };
}

/** A name as the database reads it: a bare one in lower case, a quoted one as it is written. */
function nameOf(written: string): string {
  return written.startsWith('"')
    ? written.slice(1, -1).replaceAll('""', '"')
    : written.toLowerCase();
}

/** Reads the one form of a changing statement into what the store's insert takes. */
function readInsert(form: string): SqlActionInsert | { message: string } {
  const read = INSERT.exec(form);
  const names = read?.[2]?.match(new RegExp(NAME, "gu")) ?? [];
  const values = read?.[3]?.match(new RegExp(VALUE, "gu")) ?? [];
  if (!read?.[1] || names.length === 0) {
    return {
      message:
        "A changing action is one INSERT of one row whose values are parameters: 'insert into <table> (<column>, ...) values ($<parameter>, ...)', with 'on conflict do nothing' after it where a row that exists is left out. An update, a delete, an expression or a fixed value in the row is not available yet."
    };
  }
  const columns = names.map(nameOf);
  const twice = columns.find((column, position) => columns.indexOf(column) !== position);
  if (names.length !== values.length || twice !== undefined) {
    return {
      message:
        twice === undefined
          ? `The INSERT names ${names.length} columns and gives ${values.length} values. Give one parameter for each column.`
          : `The INSERT names the column '${twice}' twice.`
    };
  }
  return {
    table: nameOf(read[1]),
    columns: columns.map((column, position) => ({
      column,
      parameter: (values[position] ?? "").slice(1)
    })),
    onConflict: read[4] === undefined ? "fail" : "skip"
  };
}

/** One line of the header that starts with `@`: a parameter, or something the format lacks. */
function readParameter(
  directive: string,
  rest: string
): (SqlActionParameter & { optional: boolean }) | { message: string } {
  const form = "'-- @param <name> <type>' or '-- @param <name> <type> optional'";
  if (directive !== "param") {
    return { message: `'@${directive}' is no line of a header. A header line is ${form}.` };
  }
  const [name = "", typeName = "", optional, ...further] = rest.split(/\s+/u).filter(Boolean);
  if (name === "scope") {
    return {
      message:
        "'scope' is reserved for data scope (SCOPE-1/2). Use a named Mandant parameter such as 'mandant_nr' until those slices arrive."
    };
  }
  if (!PARAMETER_NAME.test(name)) {
    return {
      message: `'${name}' cannot be the name of a parameter. A name has letters, digits and '_', at most 63, and the line is ${form}.`
    };
  }
  const type = PARAMETER_TYPES.find((candidate) => candidate === typeName);
  if (type === undefined) {
    return {
      message: `The parameter '${name}' has the type '${typeName}'. A type is one of ${DATA_STORE_SCALAR_TYPES.join(", ")}, or one of them followed by '[]' for a list.`
    };
  }
  if ((optional !== undefined && optional !== "optional") || further.length > 0) {
    return {
      message: `The line of the parameter '${name}' holds more than a name, a type and 'optional'. The line is ${form}.`
    };
  }
  return { name, type, optional: optional === "optional" };
}

/**
 * What starts at `index`: a stretch of the statement that is copied as it is, up to `end`, or
 * the name of a parameter. A text that never ends is a fault.
 */
function readSpan(
  sql: string,
  index: number
): { end: number; placeholder?: string; masked?: "comment" | "text" } | { fault: string } {
  const two = sql.slice(index, index + 2);
  if (two === "--") {
    const newline = sql.indexOf("\n", index);
    return { end: newline === -1 ? sql.length : newline, masked: "comment" };
  }
  if (two === "/*") {
    return masked(blockCommentEnd(sql, index), "comment");
  }
  const character = sql.charAt(index);
  if (character === "'") {
    // A string that starts with E or e reads a backslash as the start of an escape.
    const escapes = /(?:^|[^\p{L}\p{N}_$])[eE]$/u.test(sql.slice(Math.max(0, index - 2), index));
    return masked(quotedEnd(sql, index, "'", escapes, "A string"), "text");
  }
  if (character === '"') {
    return quotedEnd(sql, index, '"', false, "A quoted name");
  }
  if (character === "$") {
    const quote = matchAt(DOLLAR_QUOTE, sql, index);
    if (quote !== undefined) {
      const close = sql.indexOf(quote[0], index + quote[0].length);
      return close === -1
        ? { fault: `The text that starts with ${quote[0]} never ends.` }
        : { end: close + quote[0].length, masked: "text" };
    }
    const viewerScope = matchAt(VIEWER_SCOPE, sql, index);
    if (viewerScope !== undefined) {
      return {
        fault:
          viewerScope[1] === "groups"
            ? "'$viewer.groups' was dropped by SCOPE-0. Viewer data scope arrives with SCOPE-1 as '$viewer.scope' and '$viewer.scope_all'."
            : `'${viewerScope[0]}' is reserved for viewer data scope (SCOPE-1); scoped Connection operations arrive with SCOPE-2. These slices are not built yet.`
      };
    }
    const placeholder = matchAt(PLACEHOLDER, sql, index);
    if (placeholder?.[1] !== undefined) {
      return { end: index + placeholder[0].length, placeholder: placeholder[1] };
    }
    const position = matchAt(POSITION, sql, index);
    if (position !== undefined) {
      return {
        fault: `The statement names '${position[0]}'. A parameter is named, as '$name', and declared in the header.`
      };
    }
    return { end: index + 1 };
  }
  const word = matchAt(WORD, sql, index);
  return { end: index + (word?.[0].length ?? 1) };
}

function masked<Kind extends "comment" | "text">(
  span: { end: number } | { fault: string },
  kind: Kind
): { end: number; masked: Kind } | { fault: string } {
  return "fault" in span ? span : { ...span, masked: kind };
}

function matchAt(pattern: RegExp, text: string, index: number): RegExpExecArray | undefined {
  pattern.lastIndex = index;
  return pattern.exec(text) ?? undefined;
}

function quotedEnd(
  sql: string,
  start: number,
  quote: string,
  escapes: boolean,
  what: string
): { end: number } | { fault: string } {
  let index = start + 1;
  while (index < sql.length) {
    const character = sql.charAt(index);
    if (escapes && character === "\\") {
      index += 2;
    } else if (character !== quote) {
      index += 1;
    } else if (sql.charAt(index + 1) === quote) {
      index += 2;
    } else {
      return { end: index + 1 };
    }
  }
  return { fault: `${what} of the statement never ends.` };
}

/** A block comment ends where every comment opened inside it has ended. */
function blockCommentEnd(sql: string, start: number): { end: number } | { fault: string } {
  let depth = 0;
  let index = start;
  while (index < sql.length) {
    const two = sql.slice(index, index + 2);
    if (two === "/*") {
      depth += 1;
      index += 2;
    } else if (two === "*/") {
      depth -= 1;
      index += 2;
      if (depth === 0) return { end: index };
    } else {
      index += 1;
    }
  }
  return { fault: "A comment of the statement never ends." };
}
