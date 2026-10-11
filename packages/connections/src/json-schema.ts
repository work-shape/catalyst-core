import { createHash } from "node:crypto";
import type { JsonObject, JsonValue } from "@vivd-catalyst/core";
import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { z } from "zod";

// The one file that knows the JSON Schema validator. An operation of a Connection describes
// its input and its output as JSON Schema, which an outside system may have written. A schema
// is compiled here and nowhere else, never fetches anything, and a schema that does not
// compile is an answer, not a failure of the process.

/**
 * How many compiled schemas this process keeps, by the fingerprint of the schema. One schema
 * is compiled once for all its calls. When the bound is reached the schema that was compiled
 * first is dropped and compiled again at its next use. Each schema is compiled by a validator
 * of its own, so a dropped schema leaves nothing behind.
 */
export const JSON_SCHEMA_CACHE_MAX_ENTRIES = 2_000;

/**
 * The largest schema that is compiled, in bytes of its JSON. A tool of an outside system
 * describes its input in a few kilobytes. A larger schema answers `ok: false`.
 */
export const JSON_SCHEMA_MAX_BYTES = 256 * 1024;

/** How deep a schema may nest objects and arrays. A deeper one answers `ok: false`. */
export const JSON_SCHEMA_MAX_DEPTH = 64;

/**
 * How many objects, arrays and values a schema may hold. It bounds what compiling one costs
 * before its bytes are counted. A larger schema answers `ok: false`.
 */
export const JSON_SCHEMA_MAX_NODES = 20_000;

/** How many issues one validation reports. A refused value names its first faults only. */
export const JSON_SCHEMA_MAX_ISSUES = 20;

/** Where a value does not fit, and why. It never repeats a value of what was checked. */
export interface JsonSchemaIssue {
  /** The place in the checked value, as the segments of a JSON pointer. */
  path: string[];
  message: string;
}

export type CompiledJsonSchema =
  { ok: true; validate(value: unknown): JsonSchemaIssue[] } | { ok: false };

const DRAFT_07 = /^https?:\/\/json-schema\.org\/draft-07\/schema#?$/u;
const DRAFT_2020_12 = /^https?:\/\/json-schema\.org\/draft\/2020-12\/schema#?$/u;

/**
 * No `loadSchema` is set and compilation is synchronous, so a `$ref` to another document is
 * never fetched and fails the compilation. Unknown keywords and formats are tolerated: a tool
 * of an outside system annotates freely, and an annotation checks nothing.
 */
const AJV_OPTIONS = {
  strict: false,
  validateFormats: false,
  allErrors: false,
  addUsedSchema: false,
  // A validator that cannot build its code would print that code. Nothing of a schema an
  // outside system wrote goes to a log from here.
  logger: false
} as const;

/**
 * A validator for one schema. It is made for that schema alone and lives as long as the
 * compiled function does: a validator keeps what it compiled, and its ids, for good, so one
 * that served every schema would grow with every schema this process ever saw.
 */
function validatorFor(schema: JsonObject): Ajv | Ajv2020 | undefined {
  const dialect = schema.$schema;
  if (dialect === undefined) return new Ajv2020(AJV_OPTIONS);
  if (typeof dialect !== "string") return undefined;
  if (DRAFT_2020_12.test(dialect)) return new Ajv2020(AJV_OPTIONS);
  if (DRAFT_07.test(dialect)) return new Ajv(AJV_OPTIONS);
  return undefined;
}

const cache = new Map<string, CompiledJsonSchema>();

/**
 * Whether the schema is within the bounds of depth and node count. The walk stops at the
 * first bound it passes, so it costs no more than the bounds allow whatever it is handed.
 */
function withinShapeBounds(schema: JsonObject): boolean {
  let nodes = 0;
  const visit = (value: JsonValue, depth: number): boolean => {
    nodes += 1;
    if (nodes > JSON_SCHEMA_MAX_NODES) return false;
    if (typeof value !== "object" || value === null) return true;
    if (depth >= JSON_SCHEMA_MAX_DEPTH) return false;
    const children = Array.isArray(value) ? value : Object.values(value);
    return children.every((child) => visit(child, depth + 1));
  };
  return visit(schema, 0);
}

/**
 * The key a schema is cached under, or nothing for a schema that is over a bound. The shape
 * is measured before the schema is serialized, so a schema too deep to serialize is refused
 * and never throws.
 */
function measure(schema: JsonObject): string | undefined {
  if (!withinShapeBounds(schema)) return undefined;
  const serialized = JSON.stringify(schema);
  if (Buffer.byteLength(serialized, "utf8") > JSON_SCHEMA_MAX_BYTES) return undefined;
  return createHash("sha256").update(serialized).digest("hex");
}

/** What `measure` said of a schema object, so a schema in use is measured once. */
const measured = new WeakMap<JsonObject, { key: string | undefined }>();

function cacheKeyOf(schema: JsonObject): string | undefined {
  const known = measured.get(schema);
  if (known) return known.key;
  const key = measure(schema);
  measured.set(schema, { key });
  return key;
}

function pathOf(pointer: string): string[] {
  return pointer
    .split("/")
    .slice(1)
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}

/** How long the sentence of one issue may be. A schema's own pattern can be long. */
const JSON_SCHEMA_ISSUE_MAX_CHARS = 200;

/**
 * The broken rule in the validator's words. They are made of the keyword and of the schema,
 * such as the name of a required property, and never of the checked value. `params` can hold
 * a key of the value and is left out.
 */
function issueOf(error: ErrorObject): JsonSchemaIssue {
  const message = error.message ?? `does not fit '${error.keyword}'`;
  return {
    path: pathOf(error.instancePath),
    message: message.slice(0, JSON_SCHEMA_ISSUE_MAX_CHARS)
  };
}

function compile(schema: JsonObject): CompiledJsonSchema {
  let check: ValidateFunction;
  try {
    const validator = validatorFor(schema);
    if (!validator) return { ok: false };
    check = validator.compile(schema);
  } catch {
    // A `$ref` that leaves the schema, a malformed keyword, a pattern that is no expression.
    return { ok: false };
  }
  return {
    ok: true,
    validate(value) {
      if (check(value)) return [];
      return (check.errors ?? []).slice(0, JSON_SCHEMA_MAX_ISSUES).map(issueOf);
    }
  };
}

/**
 * Compiles a JSON Schema of draft 2020-12 or draft-07. A schema that names another dialect,
 * refers to another document, is over a bound of this file or is malformed
 * answers `ok: false` and throws nothing.
 */
export function compileJsonSchema(schema: JsonObject): CompiledJsonSchema {
  const key = cacheKeyOf(schema);
  if (key === undefined) return { ok: false };
  const cached = cache.get(key);
  if (cached) return cached;
  const compiled = compile(schema);
  if (cache.size >= JSON_SCHEMA_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, compiled);
  return compiled;
}

/**
 * The schema as the operations layer reads one. Its issues name the place and the broken
 * rule and never a value. A schema that does not compile refuses every value: nothing passes
 * a check that cannot be made.
 */
export function jsonSchemaAsZod(schema: JsonObject): z.ZodType {
  return z.unknown().superRefine((value, context) => {
    const compiled = compileJsonSchema(schema);
    if (!compiled.ok) {
      context.addIssue({
        code: "custom",
        message: "The schema of this operation cannot be checked"
      });
      return;
    }
    for (const issue of compiled.validate(value)) {
      context.addIssue({ code: "custom", path: issue.path, message: issue.message });
    }
  });
}
