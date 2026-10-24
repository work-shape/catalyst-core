import type { DataStoreMigration } from "./data-store-head";

// What a Data Store never published will hold, read from the SQL of its draft's migrations: its
// tables and their fields, so a page can say it in words before there is a database to ask. A
// statement this reading does not know is passed over; where it knows none, there is nothing to
// say and the page shows the migrations alone. The database stays what decides once published.

/** One field of a table, as the draft's migrations leave it. */
export interface DraftField {
  name: string;
  /** The product's word for the type where it has one (`text`, `integer`, …), else the SQL type. */
  type: string;
  /** The type as the migration writes it. */
  nativeType: string;
  /** The field may stay empty. */
  nullable: boolean;
  /** The field is part of the table's key. */
  primaryKey: boolean;
  /** The values a check allows it, where one names them. */
  allowed?: readonly string[];
  /** What a `comment on column` says of it. */
  comment?: string;
}

/** One table of the draft. */
export interface DraftTable {
  name: string;
  fields: DraftField[];
  /** What a `comment on table` says of it. */
  comment?: string;
}

/** The tables the migrations create, in the order they are created, with their fields. */
export function draftTablesOf(migrations: readonly DataStoreMigration[]): DraftTable[] {
  const tables = new Map<string, DraftTable>();
  for (const migration of migrations) {
    for (const statement of statementsOf(withoutComments(migration.sql))) {
      apply(tables, statement);
    }
  }
  return [...tables.values()].filter((table) => table.fields.length > 0);
}

const IDENT = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][\w$]*)`;
const QUALIFIED = String.raw`(${IDENT}(?:\s*\.\s*${IDENT})?)`;

const CREATE_TABLE = new RegExp(
  String.raw`^create\s+(?:(?:global\s+|local\s+)?(?:temporary|temp|unlogged)\s+)?table\s+(?:if\s+not\s+exists\s+)?${QUALIFIED}\s*\(([\s\S]*)\)[^)]*$`,
  "iu"
);
const ALTER_TABLE = new RegExp(
  String.raw`^alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?${QUALIFIED}\s+([\s\S]*)$`,
  "iu"
);
const DROP_TABLE = new RegExp(String.raw`^drop\s+table\s+(?:if\s+exists\s+)?${QUALIFIED}`, "iu");
const COMMENT_ON = new RegExp(
  String.raw`^comment\s+on\s+(table|column)\s+(${IDENT}(?:\s*\.\s*${IDENT}){0,2})\s+is\s+'((?:[^']|'')*)'\s*$`,
  "iu"
);

/** The words after a column's type that begin its constraints. */
const CONSTRAINT_WORDS = new Set([
  "not",
  "null",
  "default",
  "primary",
  "references",
  "check",
  "unique",
  "generated",
  "constraint",
  "collate"
]);

const TABLE_CONSTRAINT =
  /^(?:constraint\s|primary\s+key|unique\b|check\b|foreign\s+key|exclude\b|like\s)/iu;

function apply(tables: Map<string, DraftTable>, statement: string): void {
  const create = CREATE_TABLE.exec(statement);
  if (create) {
    const name = lastPart(create[1] ?? "");
    const table: DraftTable = { name, fields: [] };
    const keys: string[] = [];
    const checks: string[] = [];
    for (const item of splitTopLevel(create[2] ?? "")) {
      if (TABLE_CONSTRAINT.test(item)) {
        keys.push(...primaryKeyColumns(item));
        checks.push(item);
        continue;
      }
      const field = fieldOf(item);
      if (field) table.fields.push(field);
    }
    for (const field of table.fields) {
      if (keys.includes(field.name)) {
        field.primaryKey = true;
        field.nullable = false;
      }
      field.allowed ??= checks.map((check) => allowedValues(check, field.name)).find(Boolean);
      if (field.allowed === undefined) delete field.allowed;
    }
    tables.set(name, table);
    return;
  }
  const alter = ALTER_TABLE.exec(statement);
  if (alter) {
    const table = tables.get(lastPart(alter[1] ?? ""));
    if (!table) return;
    for (const action of splitTopLevel(alter[2] ?? "")) {
      const add = /^add\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?([\s\S]+)$/iu.exec(action);
      if (add && !TABLE_CONSTRAINT.test(add[1] ?? "")) {
        const field = fieldOf(add[1] ?? "");
        if (field) table.fields.push(field);
        continue;
      }
      const drop = new RegExp(
        String.raw`^drop\s+(?:column\s+)?(?:if\s+exists\s+)?(${IDENT})`,
        "iu"
      ).exec(action);
      if (drop) {
        const gone = unquote(drop[1] ?? "");
        table.fields = table.fields.filter((field) => field.name !== gone);
        continue;
      }
      const rename = new RegExp(
        String.raw`^rename\s+(?:column\s+)?(${IDENT})\s+to\s+(${IDENT})$`,
        "iu"
      ).exec(action);
      if (rename) {
        const field = table.fields.find((each) => each.name === unquote(rename[1] ?? ""));
        if (field) field.name = unquote(rename[2] ?? "");
      }
    }
    return;
  }
  const drop = DROP_TABLE.exec(statement);
  if (drop) {
    tables.delete(lastPart(drop[1] ?? ""));
    return;
  }
  const comment = COMMENT_ON.exec(statement);
  if (comment) {
    const parts = splitIdentifiers(comment[2] ?? "");
    const text = (comment[3] ?? "").replaceAll("''", "'").trim();
    if (text === "") return;
    if (comment[1]?.toLowerCase() === "table") {
      const table = tables.get(parts.at(-1) ?? "");
      if (table) table.comment = text;
      return;
    }
    const table = tables.get(parts.at(-2) ?? "");
    const field = table?.fields.find((each) => each.name === parts.at(-1));
    if (field) field.comment = text;
  }
}

/** A column definition: its name, its type and what its constraints say. */
function fieldOf(definition: string): DraftField | undefined {
  const named = new RegExp(String.raw`^(${IDENT})\s+([\s\S]+)$`, "u").exec(definition.trim());
  if (!named) return undefined;
  const name = unquote(named[1] ?? "");
  const words = tokens(named[2] ?? "");
  const typeWords: string[] = [];
  let rest = 0;
  while (rest < words.length && !CONSTRAINT_WORDS.has((words[rest] ?? "").toLowerCase())) {
    typeWords.push(words[rest] ?? "");
    rest += 1;
  }
  if (typeWords.length === 0) return undefined;
  const nativeType = typeWords.join(" ").replace(/\s+\(/gu, "(").toLowerCase();
  const constraints = words.slice(rest).join(" ");
  const primaryKey = /\bprimary\s+key\b/iu.test(constraints);
  const allowed = allowedValues(constraints, name);
  return {
    name,
    type: productType(nativeType),
    nativeType,
    nullable: !primaryKey && !/\bnot\s+null\b/iu.test(constraints),
    primaryKey,
    ...(allowed ? { allowed } : {})
  };
}

/** The product's word for a SQL type, as the page of a published store names it. */
function productType(nativeType: string): string {
  const list = /\[\]$/u.test(nativeType) || /^_/u.test(nativeType);
  const base = nativeType
    .replace(/\[\]$/u, "")
    .replace(/\(.*\)/u, "")
    .trim();
  const word = PRODUCT_TYPES.find(([pattern]) => pattern.test(base))?.[1];
  if (word === undefined) return nativeType;
  return list ? `${word}[]` : word;
}

const PRODUCT_TYPES: readonly (readonly [RegExp, string])[] = [
  [/^(?:text|varchar|character varying|char|character|citext|bpchar)$/u, "text"],
  [/^(?:smallint|integer|int|int2|int4|int8|bigint|smallserial|serial|bigserial)$/u, "integer"],
  [/^(?:numeric|decimal|real|double precision|float|float4|float8)$/u, "number"],
  [/^(?:boolean|bool)$/u, "boolean"],
  [/^date$/u, "date"],
  [/^(?:timestamp|timestamptz|timestamp with(?:out)? time zone)$/u, "timestamp"]
];

/** The values `check (name in ('a', 'b'))` allows the column, where a check says so. */
function allowedValues(text: string, column: string): string[] | undefined {
  const pattern = new RegExp(
    String.raw`check\s*\(\s*"?${escapeRegExp(column)}"?\s+in\s*\(((?:\s*'(?:[^']|'')*'\s*,?)+)\)\s*\)`,
    "iu"
  );
  const match = pattern.exec(text);
  if (!match) return undefined;
  const values = [...(match[1] ?? "").matchAll(/'((?:[^']|'')*)'/gu)].map((value) =>
    (value[1] ?? "").replaceAll("''", "'")
  );
  return values.length > 0 ? values : undefined;
}

/** The columns `primary key (a, b)` names, where the item is that constraint. */
function primaryKeyColumns(item: string): string[] {
  const match = /primary\s+key\s*\(([^)]*)\)/iu.exec(item);
  return match ? splitTopLevel(match[1] ?? "").map(unquote) : [];
}

/** The SQL without its comments; text in quotes stays as it is. */
function withoutComments(sql: string): string {
  let out = "";
  for (let at = 0; at < sql.length; at++) {
    const char = sql[at];
    if (char === "'" || char === '"') {
      const end = closing(sql, at, char);
      out += sql.slice(at, end + 1);
      at = end;
    } else if (char === "-" && sql[at + 1] === "-") {
      const end = sql.indexOf("\n", at);
      at = end === -1 ? sql.length : end - 1;
    } else if (char === "/" && sql[at + 1] === "*") {
      const end = sql.indexOf("*/", at + 2);
      at = end === -1 ? sql.length : end + 1;
      out += " ";
    } else {
      out += char;
    }
  }
  return out;
}

/** The statements of a migration, split at semicolons outside quotes. */
function statementsOf(sql: string): string[] {
  return splitTopLevel(sql, ";");
}

/** The parts of a text split at a separator outside quotes and brackets, trimmed. */
function splitTopLevel(text: string, separator = ","): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (char === "'" || char === '"') {
      at = closing(text, at, char);
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
    } else if (char === separator && depth === 0) {
      parts.push(text.slice(start, at));
      start = at + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim().replace(/\s+/gu, " ")).filter((part) => part !== "");
}

/** The words of a column's type and constraints; a bracket stays with the word before it. */
function tokens(text: string): string[] {
  const words: string[] = [];
  let word = "";
  let depth = 0;
  for (let at = 0; at < text.length; at++) {
    const char = text[at] ?? "";
    if (char === "'" || char === '"') {
      const end = closing(text, at, char);
      word += text.slice(at, end + 1);
      at = end;
    } else if (char === "(") {
      depth += 1;
      word += char;
    } else if (char === ")") {
      depth -= 1;
      word += char;
    } else if (/\s/u.test(char) && depth === 0) {
      // A bracket after a space still belongs to the word before it: `numeric (12, 2)`.
      if (word !== "" && !/^\s*\(/u.test(text.slice(at))) {
        words.push(word);
        word = "";
      }
    } else {
      word += char;
    }
  }
  if (word !== "") words.push(word);
  return words;
}

/** Where the quote that opens at `at` closes; a doubled quote is part of the text. */
function closing(text: string, at: number, quote: string): number {
  let end = at + 1;
  while (end < text.length) {
    if (text[end] === quote) {
      if (text[end + 1] === quote) {
        end += 2;
        continue;
      }
      return end;
    }
    end += 1;
  }
  return text.length - 1;
}

function splitIdentifiers(text: string): string[] {
  return [...text.matchAll(new RegExp(IDENT, "gu"))].map((match) => unquote(match[0]));
}

function lastPart(qualified: string): string {
  return splitIdentifiers(qualified).at(-1) ?? qualified;
}

function unquote(identifier: string): string {
  const trimmed = identifier.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1).replaceAll('""', '"')
    : trimmed.toLowerCase();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
