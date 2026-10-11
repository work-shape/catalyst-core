import { createHash } from "node:crypto";
import type { JsonObject } from "@vivd-catalyst/core";
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
 * first is dropped and compiled again at its next use.
 */
export const JSON_SCHEMA_CACHE_MAX_ENTRIES = 2_000;

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
  // The compiled function is kept by this file under the bound above, not by the validator.
  addUsedSchema: false
} as const;

const draft2020 = new Ajv2020(AJV_OPTIONS);
const draft07 = new Ajv(AJV_OPTIONS);

function validatorFor(schema: JsonObject): Ajv | Ajv2020 | undefined {
  const dialect = schema.$schema;
  if (dialect === undefined) return draft2020;
  if (typeof dialect !== "string") return undefined;
  if (DRAFT_2020_12.test(dialect)) return draft2020;
  if (DRAFT_07.test(dialect)) return draft07;
  return undefined;
}

const cache = new Map<string, CompiledJsonSchema>();
const cacheKeys = new WeakMap<JsonObject, string>();

function cacheKeyOf(schema: JsonObject): string {
  const known = cacheKeys.get(schema);
  if (known !== undefined) return known;
  const key = createHash("sha256").update(JSON.stringify(schema)).digest("hex");
  cacheKeys.set(schema, key);
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
  const validator = validatorFor(schema);
  if (!validator) return { ok: false };
  let check: ValidateFunction;
  try {
    check = validator.compile(schema);
  } catch {
    // A `$ref` that leaves the schema, a malformed keyword, a pattern that is no expression.
    return { ok: false };
  } finally {
    // The validator keeps every schema it compiled by identity. Nothing is to stay there.
    validator.removeSchema(schema);
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
 * refers to another document or is malformed answers `ok: false` and throws nothing.
 */
export function compileJsonSchema(schema: JsonObject): CompiledJsonSchema {
  const key = cacheKeyOf(schema);
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
