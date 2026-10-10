import type { JsonObject, JsonValue } from "@vivd-catalyst/core";

/**
 * The driver hands every value over as the server's text. These readers give each type its
 * JSON form: `bigint` and `numeric` stay text so no digit is lost, a date stays `2024-05-01`,
 * a timestamp becomes ISO 8601, and what has no reader here stays the server's text.
 */
export type PostgresValueReader = (raw: string) => JsonValue;

const asNumber: PostgresValueReader = (raw) => {
  const value = Number(raw);
  // `NaN` and the infinities have no JSON number.
  return Number.isFinite(value) ? value : raw;
};

const asJson: PostgresValueReader = (raw) => {
  const parsed: unknown = JSON.parse(raw);
  return jsonValue(parsed);
};

/**
 * What `JSON.parse` returned, as a JSON value. Every key of an object becomes a property of
 * its own, at any depth: assigning `__proto__` would change the object instead.
 */
function jsonValue(value: unknown): JsonValue {
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) return value.map(jsonValue);
  if (typeof value !== "object" || value === null) return null;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]: [string, unknown]) => [key, jsonValue(nested)])
  );
}

/** `2024-05-01 10:00:00.5+00` as `2024-05-01T10:00:00.5Z`. Other forms, such as `infinity`, stay. */
const asIsoTimestamp: PostgresValueReader = (raw) => {
  const match = /^(\d{4,}-\d\d-\d\d) (\d\d:\d\d:\d\d(?:\.\d+)?)(?:([+-]\d\d)(?::(\d\d))?)?$/u.exec(
    raw
  );
  if (!match) return raw;
  const [, date = "", time = "", hours, minutes = "00"] = match;
  const local = `${date}T${time}`;
  if (hours === undefined) return local;
  return hours === "+00" && minutes === "00" ? `${local}Z` : `${local}${hours}:${minutes}`;
};

/** By the object id of the type: boolean, the small numbers, json and jsonb, the timestamps. */
const SCALAR_READERS = new Map<number, PostgresValueReader>([
  [16, (raw) => raw === "t"],
  [21, asNumber],
  [23, asNumber],
  [26, asNumber],
  [700, asNumber],
  [701, asNumber],
  [114, asJson],
  [3802, asJson],
  [1114, asIsoTimestamp],
  [1184, asIsoTimestamp]
]);

export interface PostgresValueType {
  oid: number;
  /** Set for an array type: the type of its elements and the character between them. */
  element?: { oid: number; delimiter: string };
}

export function postgresValueReader(type: PostgresValueType): PostgresValueReader {
  const { element } = type;
  if (element === undefined) return SCALAR_READERS.get(type.oid) ?? ((raw) => raw);
  const readElement = postgresValueReader({ oid: element.oid });
  // The vector types are arrays to the catalog and write themselves without braces.
  return (raw) => (/^[[{]/u.test(raw) ? readArray(raw, element.delimiter, readElement) : raw);
}

/**
 * The key of each column in a row. A key stands for one column, so a column whose name an
 * earlier column has gets the next free number as a suffix: `id`, `id_2`, `id_3`.
 */
export function postgresRowKeys(names: readonly string[]): string[] {
  const taken = new Set<string>();
  return names.map((name) => {
    let key = name;
    for (let number = 2; taken.has(key); number += 1) key = `${name}_${number}`;
    taken.add(key);
    return key;
  });
}

/**
 * A row as the driver returned it, one value per column in order, read column by column. Null
 * stays null. Every key becomes a property of the row's own, `__proto__` included.
 */
export function readPostgresRow(
  values: readonly unknown[],
  columns: readonly { key: string; read: PostgresValueReader }[]
): JsonObject {
  return Object.fromEntries(
    columns.map((column, index) => {
      const raw = values[index];
      return [column.key, typeof raw === "string" ? column.read(raw) : null];
    })
  );
}

/**
 * Reads the server's array text, such as `{1,NULL,"a \"b\"",{2}}` or `[0:1]={1,2}`. Only an
 * unquoted `NULL` is null.
 */
function readArray(
  literal: string,
  delimiter: string,
  readElement: PostgresValueReader
): JsonValue[] {
  // A dimension prefix ends at the first brace.
  let index = literal.indexOf("{");

  function quoted(): string {
    let text = "";
    index += 1;
    while (index < literal.length && literal.charAt(index) !== '"') {
      if (literal.charAt(index) === "\\") index += 1;
      text += literal.charAt(index);
      index += 1;
    }
    index += 1;
    return text;
  }

  function bare(): string {
    const start = index;
    while (index < literal.length && !`${delimiter}}`.includes(literal.charAt(index))) index += 1;
    return literal.slice(start, index);
  }

  function array(): JsonValue[] {
    const items: JsonValue[] = [];
    index += 1;
    while (index < literal.length && literal.charAt(index) !== "}") {
      const char = literal.charAt(index);
      if (char === delimiter) index += 1;
      else if (char === "{") items.push(array());
      else if (char === '"') items.push(readElement(quoted()));
      else {
        const text = bare();
        items.push(text === "NULL" ? null : readElement(text));
      }
    }
    index += 1;
    return items;
  }

  return array();
}
