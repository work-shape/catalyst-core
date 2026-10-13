import { createHash } from "node:crypto";
import { isMainThread, parentPort, workerData, type MessagePort } from "node:worker_threads";
import type { JsonObject, JsonValue } from "@vivd-catalyst/core";
import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";

// The one file that knows the JSON Schema validator. An operation of a Connection describes
// its input and its output as JSON Schema, which an outside system may have written. A schema
// is compiled here and nowhere else, never fetches anything, and a schema that does not
// compile is an answer, not a failure of the process.
//
// This file runs in two places. A schema the release wrote, the static catalog of a Connector
// type, is compiled and checked where it is called. A schema an outside system wrote is
// compiled and checked by this same file in a worker thread, which `schema-check.ts` starts
// and stops: compiling such a schema or checking a value by it can take as long as its author
// likes, and a thread that is stopped at a deadline is the only bound on that. The file is the
// entry of that thread, so it imports packages only and no other file of this one.

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

/** The keyword that makes a schema, or a part of one, asynchronous. */
const ASYNC_KEYWORD = "$async";

/**
 * Whether the schema is within the bounds of depth and node count and asynchronous nowhere.
 * The walk stops at the first bound it passes, so it costs no more than the bounds allow
 * whatever it is handed.
 *
 * An asynchronous schema answers a promise, which would read as a value that fits. No schema
 * of an operation needs one: nothing here is fetched while a value is checked. The keyword is
 * refused wherever the walk meets it as a key, whatever it holds and also in a part nothing
 * refers to. That refuses a schema with a property of that very name too, which no ordinary
 * schema has.
 */
function withinShapeBounds(schema: JsonObject): boolean {
  let nodes = 0;
  const visit = (value: JsonValue, depth: number): boolean => {
    nodes += 1;
    if (nodes > JSON_SCHEMA_MAX_NODES) return false;
    if (typeof value !== "object" || value === null) return true;
    if (depth >= JSON_SCHEMA_MAX_DEPTH) return false;
    if (!Array.isArray(value) && Object.hasOwn(value, ASYNC_KEYWORD)) return false;
    const children = Array.isArray(value) ? value : Object.values(value);
    return children.every((child) => visit(child, depth + 1));
  };
  return visit(schema, 0);
}

/**
 * Whether a schema is one this file compiles at all: within its bounds and asynchronous
 * nowhere. Whoever walks a schema of an outside system on its own, to fingerprint it or to
 * store it, asks this first. It throws nothing, however deep the schema is.
 */
export function isJsonSchemaWithinBounds(schema: JsonObject): boolean {
  return cacheKeyOf(schema) !== undefined;
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

/** What a value that could not be checked at all is told. It names no value. */
const UNCHECKABLE: JsonSchemaIssue[] = [{ path: [], message: "is nested too deeply to check" }];

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
  // The walk refused the keyword already. This holds whatever a validator makes of a schema.
  if (ASYNC_KEYWORD in check) return { ok: false };
  return {
    ok: true,
    validate(value) {
      let fits: unknown;
      try {
        fits = check(value);
      } catch {
        // A schema that refers to itself follows a value as deep as it goes. One that is
        // deeper than the stack is a value that does not fit, not a failure of the process.
        return UNCHECKABLE;
      }
      if (fits === true) return [];
      const issues = (check.errors ?? []).slice(0, JSON_SCHEMA_MAX_ISSUES).map(issueOf);
      // Anything but a plain yes is a no, also where the validator names no fault.
      return issues.length > 0 ? issues : [{ path: [], message: "does not fit the schema" }];
    }
  };
}

/**
 * Compiles a JSON Schema of draft 2020-12 or draft-07. A schema that names another dialect,
 * refers to another document, is asynchronous, is over a bound of this file or is malformed
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
 * The most `$ref`, `$dynamicRef` and `$recursiveRef` a schema of an outside system may hold.
 * Each one is a jump a check follows, and a schema that refers to itself through many of them
 * multiplies the work of one check. A schema with more is refused before it is compiled.
 */
export const OUTSIDE_SCHEMA_MAX_REFS = 200;

/**
 * The most regular expressions a schema of an outside system may hold: every `pattern` and
 * every key of a `patternProperties`. A schema with more is refused before it is compiled.
 */
export const OUTSIDE_SCHEMA_MAX_PATTERNS = 100;

/** The longest regular expression of a schema of an outside system, in characters. */
export const OUTSIDE_SCHEMA_PATTERN_MAX_CHARS = 1_000;

/** Why a schema of an outside system is refused before anything compiles it. */
export type OutsideSchemaBoundRefusal =
  /** Over `JSON_SCHEMA_MAX_BYTES` or `JSON_SCHEMA_MAX_NODES`. */
  | "schema_too_large"
  /** Nested deeper than `JSON_SCHEMA_MAX_DEPTH`. */
  | "schema_too_deep"
  | "schema_too_many_refs"
  | "schema_too_many_patterns"
  | "schema_pattern_too_long"
  /** Asynchronous, which no schema of an operation is. */
  | "schema_uncompilable";

const REF_KEYWORDS = new Set(["$ref", "$dynamicRef", "$recursiveRef"]);

/**
 * The first bound a schema of an outside system is over, or nothing. One walk that stops at
 * the first bound it passes, so it costs no more than the bounds allow whatever it is handed
 * and throws nothing however deep the schema is. A `pattern` is counted wherever a text stands
 * under that key, also in an example: the count is a bound, not a reading of the schema.
 */
function outsideShapeRefusal(schema: JsonObject): OutsideSchemaBoundRefusal | undefined {
  let nodes = 0;
  let refs = 0;
  let patterns = 0;
  const pattern = (text: string): OutsideSchemaBoundRefusal | undefined => {
    patterns += 1;
    if (patterns > OUTSIDE_SCHEMA_MAX_PATTERNS) return "schema_too_many_patterns";
    return text.length > OUTSIDE_SCHEMA_PATTERN_MAX_CHARS ? "schema_pattern_too_long" : undefined;
  };
  const visit = (value: JsonValue, depth: number): OutsideSchemaBoundRefusal | undefined => {
    nodes += 1;
    if (nodes > JSON_SCHEMA_MAX_NODES) return "schema_too_large";
    if (typeof value !== "object" || value === null) return undefined;
    if (depth >= JSON_SCHEMA_MAX_DEPTH) return "schema_too_deep";
    if (Array.isArray(value)) {
      for (const child of value) {
        const refusal = visit(child, depth + 1);
        if (refusal) return refusal;
      }
      return undefined;
    }
    if (Object.hasOwn(value, ASYNC_KEYWORD)) return "schema_uncompilable";
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      const child = value[key];
      if (child === undefined) continue;
      if (REF_KEYWORDS.has(key) && typeof child === "string") {
        refs += 1;
        if (refs > OUTSIDE_SCHEMA_MAX_REFS) return "schema_too_many_refs";
      }
      if (key === "pattern" && typeof child === "string") {
        const refusal = pattern(child);
        if (refusal) return refusal;
      }
      if (key === "patternProperties" && typeof child === "object" && child !== null) {
        for (const expression of Object.keys(child)) {
          const refusal = pattern(expression);
          if (refusal) return refusal;
        }
      }
      const refusal = visit(child, depth + 1);
      if (refusal) return refusal;
    }
    return undefined;
  };
  return visit(schema, 0);
}

/** A schema of an outside system as the worker is handed it, or why it is handed none. */
export type MeasuredOutsideSchema =
  { ok: true; key: string; serialized: string } | { ok: false; refusal: OutsideSchemaBoundRefusal };

function measureOutside(schema: JsonObject): MeasuredOutsideSchema {
  const refusal = outsideShapeRefusal(schema);
  if (refusal) return { ok: false, refusal };
  const serialized = JSON.stringify(schema);
  if (Buffer.byteLength(serialized, "utf8") > JSON_SCHEMA_MAX_BYTES) {
    return { ok: false, refusal: "schema_too_large" };
  }
  return { ok: true, key: createHash("sha256").update(serialized).digest("hex"), serialized };
}

const measuredOutside = new WeakMap<JsonObject, MeasuredOutsideSchema>();

/**
 * Measures a schema of an outside system: its bounds, and the fingerprint and the JSON it is
 * handed to the worker by. It compiles nothing and runs no expression of the schema, so it is
 * safe where the request is served. A schema object is measured once.
 */
export function measureOutsideJsonSchema(schema: JsonObject): MeasuredOutsideSchema {
  const known = measuredOutside.get(schema);
  if (known) return known;
  const measured = measureOutside(schema);
  measuredOutside.set(schema, measured);
  return measured;
}

// The worker's side. The thread `schema-check.ts` starts runs this file with the role below in
// its `workerData`, and nothing else does: loaded anywhere else, the lines after this comment
// define functions and start nothing.

/** What `workerData` names the thread by, so no other thread that loads this file serves. */
export const JSON_SCHEMA_WORKER_ROLE = "connections.json-schema-check";

/** What the thread is started with. */
export interface JsonSchemaWorkerData {
  role: typeof JSON_SCHEMA_WORKER_ROLE;
  /** How many compiled schemas the thread keeps. The one used longest ago is dropped. */
  cacheMaxEntries: number;
}

/**
 * One check. `schema` is the schema's JSON and is sent where the thread may not hold the key.
 * `value` is the JSON of what is checked. Without one the schema is compiled and nothing more.
 */
export interface JsonSchemaCheckRequest {
  id: number;
  key: string;
  schema?: string;
  value?: string;
}

export type JsonSchemaCheckAnswer =
  /** The thread started and takes requests. Sent once, before any other answer. */
  | { kind: "ready" }
  /** The thread does not hold the key. The request is sent again with the schema. */
  | { kind: "missing"; id: number }
  | { kind: "uncompilable"; id: number }
  | { kind: "checked"; id: number; issues: JsonSchemaIssue[] };

function isWorkerData(value: unknown): value is JsonSchemaWorkerData {
  return (
    typeof value === "object" &&
    value !== null &&
    "role" in value &&
    value.role === JSON_SCHEMA_WORKER_ROLE &&
    "cacheMaxEntries" in value &&
    typeof value.cacheMaxEntries === "number"
  );
}

function isCheckRequest(value: unknown): value is JsonSchemaCheckRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "number" &&
    "key" in value &&
    typeof value.key === "string" &&
    (!("schema" in value) || typeof value.schema === "string") &&
    (!("value" in value) || typeof value.value === "string")
  );
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Answers checks until the thread is stopped. A schema is compiled at its first request and
 * kept by its key, at most `cacheMaxEntries` of them. The main thread measured the schema
 * before it sent it, so nothing over a bound arrives here.
 */
function serveChecks(port: MessagePort, cacheMaxEntries: number): void {
  const compiled = new Map<string, CompiledJsonSchema>();
  const compiledFor = (request: JsonSchemaCheckRequest): CompiledJsonSchema | undefined => {
    const held = compiled.get(request.key);
    if (held) {
      // Used now, so it is the last to be dropped.
      compiled.delete(request.key);
      compiled.set(request.key, held);
      return held;
    }
    if (request.schema === undefined) return undefined;
    let made: CompiledJsonSchema = { ok: false };
    try {
      const schema: unknown = JSON.parse(request.schema);
      if (isJsonObject(schema)) made = compile(schema);
    } catch {
      // No JSON, which the main thread never sends.
    }
    if (compiled.size >= Math.max(1, cacheMaxEntries)) {
      const oldest = compiled.keys().next();
      if (!oldest.done) compiled.delete(oldest.value);
    }
    compiled.set(request.key, made);
    return made;
  };
  const answerTo = (request: JsonSchemaCheckRequest): JsonSchemaCheckAnswer => {
    const { id } = request;
    const schema = compiledFor(request);
    if (!schema) return { kind: "missing", id };
    if (!schema.ok) return { kind: "uncompilable", id };
    if (request.value === undefined) return { kind: "checked", id, issues: [] };
    let value: unknown;
    try {
      value = JSON.parse(request.value);
    } catch {
      // Nested deeper than the stack. It is a value that does not fit.
      return { kind: "checked", id, issues: UNCHECKABLE };
    }
    return { kind: "checked", id, issues: schema.validate(value) };
  };
  port.on("message", (message: unknown) => {
    if (isCheckRequest(message)) port.postMessage(answerTo(message));
  });
  const ready: JsonSchemaCheckAnswer = { kind: "ready" };
  port.postMessage(ready);
}

if (!isMainThread && parentPort && isWorkerData(workerData)) {
  serveChecks(parentPort, workerData.cacheMaxEntries);
}
