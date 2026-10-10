import { PostgresExecutorError } from "./errors";
import { POSTGRES_PARAMETERS_MAX_COUNT } from "./limits";

export type PostgresScalar = string | number | boolean | null;

const SCALAR_TYPES = ["text", "integer", "number", "boolean", "date", "timestamp"] as const;
type PostgresScalarType = (typeof SCALAR_TYPES)[number];
export type PostgresParameterType = PostgresScalarType | `${PostgresScalarType}[]`;

/**
 * One value of a query. A bare scalar leaves its type to the database, which reads it from
 * the place the parameter stands in. A bare array takes the type its elements share. A
 * declared type decides for itself.
 */
export type PostgresParameter =
  | PostgresScalar
  | readonly PostgresScalar[]
  | { type: PostgresParameterType; value: PostgresScalar | readonly PostgresScalar[] };

/** A parameter as it goes to the server: a type and the value in the server's text form. */
export interface BoundPostgresParameter {
  /** The type's object id. Zero leaves the type to the server. */
  oid: number;
  text: string | null;
}

interface WireType {
  oid: number;
  arrayOid: number;
  /** The text form of a value, or undefined when the value is not one of this type. */
  write(value: string | number | boolean): string | undefined;
}

const WIRE_TYPES: Record<PostgresScalarType, WireType> = {
  text: { oid: 25, arrayOid: 1009, write: (value) => whenString(value) },
  // Bigint and numeric take digits as text too, for values a JSON number cannot hold.
  integer: { oid: 20, arrayOid: 1016, write: (value) => numeral(value, /^-?\d+$/u) },
  number: { oid: 1700, arrayOid: 1231, write: (value) => numeral(value, /^-?\d+(?:\.\d+)?$/u) },
  boolean: {
    oid: 16,
    arrayOid: 1000,
    write: (value) => (typeof value === "boolean" ? (value ? "t" : "f") : undefined)
  },
  date: { oid: 1082, arrayOid: 1182, write: (value) => whenString(value, /^\d{4}-\d\d-\d\d$/u) },
  timestamp: {
    oid: 1184,
    arrayOid: 1185,
    write: (value) =>
      whenString(
        value,
        /^\d{4}-\d\d-\d\d[T ]\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d(?::?\d\d)?)?$/u
      )
  }
};

/**
 * Turns the parameters of a call into typed text values the driver binds. No value is ever
 * written into the query text, and no rejection repeats a value.
 */
export function bindPostgresParameters(
  parameters: readonly PostgresParameter[]
): BoundPostgresParameter[] {
  if (parameters.length > POSTGRES_PARAMETERS_MAX_COUNT) {
    throw new PostgresExecutorError(
      "query_rejected",
      `Queries must not have more than ${POSTGRES_PARAMETERS_MAX_COUNT} parameters`
    );
  }
  return parameters.map((parameter, index) => {
    const bound = bind(parameter);
    if (bound === undefined) {
      throw new PostgresExecutorError(
        "query_rejected",
        `Parameter ${index + 1} does not match its type`
      );
    }
    return bound;
  });
}

function bind(parameter: PostgresParameter): BoundPostgresParameter | undefined {
  if (isScalar(parameter)) return bindUntyped(parameter);
  if (isArray(parameter)) {
    const type = sharedType(parameter);
    return type && bindArray(type, parameter);
  }
  const array = /^(.*)\[\]$/u.exec(parameter.type);
  const type = SCALAR_TYPES.find((name) => name === (array?.[1] ?? parameter.type));
  if (type === undefined) return undefined;
  if (array) return isArray(parameter.value) ? bindArray(type, parameter.value) : undefined;
  if (isArray(parameter.value)) return undefined;
  const text = parameter.value === null ? null : WIRE_TYPES[type].write(parameter.value);
  return text === undefined ? undefined : { oid: WIRE_TYPES[type].oid, text };
}

function bindUntyped(value: PostgresScalar): BoundPostgresParameter | undefined {
  if (value === null || typeof value === "string") return { oid: 0, text: value };
  if (typeof value === "boolean") return { oid: WIRE_TYPES.boolean.oid, text: value ? "t" : "f" };
  return Number.isFinite(value) ? { oid: 0, text: String(value) } : undefined;
}

function bindArray(
  type: PostgresScalarType,
  values: readonly PostgresScalar[]
): BoundPostgresParameter | undefined {
  const texts: (string | null)[] = [];
  for (const value of values) {
    const text = value === null ? null : WIRE_TYPES[type].write(value);
    if (text === undefined) return undefined;
    texts.push(text);
  }
  return { oid: WIRE_TYPES[type].arrayOid, text: arrayLiteral(texts) };
}

/** The server's text form of an array: every element quoted and escaped, a null as `NULL`. */
function arrayLiteral(texts: readonly (string | null)[]): string {
  const elements = texts.map((text) =>
    text === null ? "NULL" : `"${text.replace(/["\\]/gu, "\\$&")}"`
  );
  return `{${elements.join(",")}}`;
}

/** For the statements the executor writes itself. */
export function textParameter(value: string | null): BoundPostgresParameter {
  return { oid: WIRE_TYPES.text.oid, text: value };
}

export function textArrayParameter(values: readonly string[]): BoundPostgresParameter {
  return { oid: WIRE_TYPES.text.arrayOid, text: arrayLiteral(values) };
}

/** The one type the elements of a bare array share. An array without a value is text. */
function sharedType(values: readonly PostgresScalar[]): PostgresScalarType | undefined {
  const kinds = new Set(values.filter((value) => value !== null).map((value) => typeof value));
  if (kinds.size > 1) return undefined;
  if (kinds.has("boolean")) return "boolean";
  if (!kinds.has("number")) return "text";
  return values.every((value) => value === null || Number.isInteger(value)) ? "integer" : "number";
}

function isScalar(parameter: PostgresParameter): parameter is PostgresScalar {
  return parameter === null || typeof parameter !== "object";
}

function isArray(
  value: PostgresParameter | PostgresScalar | readonly PostgresScalar[]
): value is readonly PostgresScalar[] {
  return Array.isArray(value);
}

function whenString(value: string | number | boolean, shape?: RegExp): string | undefined {
  return typeof value === "string" && (shape === undefined || shape.test(value))
    ? value
    : undefined;
}

function numeral(value: string | number | boolean, shape: RegExp): string | undefined {
  const text = typeof value === "number" ? numberText(value) : whenString(value);
  return text !== undefined && shape.test(text) ? text : undefined;
}

/** A JSON number in plain decimal digits. Exponent notation and non-numbers have none. */
function numberText(value: number): string | undefined {
  const text = String(value);
  return Number.isFinite(value) && !text.includes("e") ? text : undefined;
}
