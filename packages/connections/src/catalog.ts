import { createHash } from "node:crypto";
import {
  CONNECTION_OPERATION_NAME_MAX_LENGTH,
  CONNECTION_OPERATION_NAME_PATTERN,
  type ConnectionCatalog,
  type ConnectionCatalogEntry,
  type ConnectionOperationConfig,
  type ConnectionOperationStatus,
  type ConnectorOperationDescriptor,
  type ConnectorTypeDefinition,
  type JsonObject,
  type JsonValue
} from "@vivd-catalyst/core";
import { z } from "zod";
import {
  compileJsonSchema,
  isJsonSchemaWithinBounds,
  measureOutsideJsonSchema
} from "./json-schema";

// What a discovery leaves behind and what it makes callable. Pure: nothing here reads or
// writes a store or opens a connection. A discovery never widens anything: a tool is callable
// only while the Connection's accepted list names it and its descriptor is the accepted one.

function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Whether the schemas of a descriptor are ones the platform compiles: within the bounds of a
 * JSON Schema here. A descriptor that is not is no operation, and nothing walks its schemas:
 * a fingerprint follows a schema as deep as it goes, and one deeper than the stack would end
 * the read of a catalog with an error where it should end with one operation less.
 */
function hasUsableSchemas(descriptor: ConnectorOperationDescriptor): boolean {
  return (
    isJsonSchemaWithinBounds(descriptor.inputSchema) &&
    (descriptor.outputSchema === undefined || isJsonSchemaWithinBounds(descriptor.outputSchema))
  );
}

/**
 * The fingerprint of a descriptor: sha256, hex, over the canonical JSON (keys sorted) of its
 * name, description, input schema, output schema and proposed effect. The description is
 * part of it, because a changed description is what a model reads. Only a descriptor with
 * usable schemas is handed to it.
 */
export function fingerprintOperation(descriptor: ConnectorOperationDescriptor): string {
  const fingerprinted: JsonObject = {
    name: descriptor.name,
    description: descriptor.description,
    inputSchema: descriptor.inputSchema,
    proposedEffect: descriptor.proposedEffect
  };
  if (descriptor.outputSchema !== undefined) fingerprinted.outputSchema = descriptor.outputSchema;
  return createHash("sha256").update(canonicalJson(fingerprinted)).digest("hex");
}

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema)
  ])
);
const jsonObjectSchema = z.record(z.string(), jsonValueSchema);
const fingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/u);

const catalogSchema = z
  .object({
    version: z.literal(1),
    discoveredAt: z.string(),
    entries: z.array(
      z
        .object({
          name: z.string(),
          description: z.string(),
          inputSchema: jsonObjectSchema,
          outputSchema: jsonObjectSchema.optional(),
          proposedEffect: z.enum(["reading", "changing"]),
          fingerprint: fingerprintSchema
        })
        .strict()
    ),
    pinned: z.record(z.string(), fingerprintSchema)
  })
  .strict();

/**
 * The catalog a `connection_state` row holds, or nothing where the stored value has any other
 * shape. A catalog of a later version is read as none, so its Connection is discovered again
 * and no reader guesses at a shape it does not know.
 */
export function readConnectionCatalog(
  stored: JsonValue | undefined
): ConnectionCatalog | undefined {
  if (stored === undefined) return undefined;
  const parsed = catalogSchema.safeParse(stored);
  if (!parsed.success) return undefined;
  const { entries, pinned, ...rest } = parsed.data;
  return {
    ...rest,
    entries: entries.map(({ outputSchema, ...entry }) => ({
      ...entry,
      ...(outputSchema === undefined ? {} : { outputSchema })
    })),
    pinned
  };
}

/** The pin of one operation. Read as an own entry: a tool may be named `constructor`. */
function pinOf(pinned: Record<string, string>, name: string): string | undefined {
  return Object.hasOwn(pinned, name) ? pinned[name] : undefined;
}

function acceptableName(name: string): boolean {
  return (
    name.length <= CONNECTION_OPERATION_NAME_MAX_LENGTH &&
    CONNECTION_OPERATION_NAME_PATTERN.test(name)
  );
}

/**
 * The catalog after one discovery. Every discovered tool is an entry with its fingerprint. An
 * accepted operation that is seen for the first time is pinned to what was seen, unless the
 * Connection's config names another fingerprint for it. Every earlier pin is kept as it is,
 * also for a tool this discovery did not list or lists differently, so nothing an outside
 * system sends later replaces what was accepted. A tool nobody accepted gets no pin.
 */
export function buildConnectionCatalog(input: {
  discovered: readonly ConnectorOperationDescriptor[];
  accepted: readonly ConnectionOperationConfig[];
  previous: ConnectionCatalog | undefined;
  now: string;
}): ConnectionCatalog {
  const entries = new Map<string, ConnectionCatalogEntry>();
  for (const descriptor of input.discovered) {
    // A type leaves out a name that cannot end an operation name. One that arrives here anyway
    // is left out too, and of two tools of one name the first stands. So is a tool whose
    // schema the platform would not compile: it is checked before anything walks the schema.
    if (!acceptableName(descriptor.name) || entries.has(descriptor.name)) continue;
    if (!hasUsableSchemas(descriptor)) continue;
    entries.set(descriptor.name, {
      name: descriptor.name,
      description: descriptor.description,
      inputSchema: descriptor.inputSchema,
      ...(descriptor.outputSchema === undefined ? {} : { outputSchema: descriptor.outputSchema }),
      proposedEffect: descriptor.proposedEffect,
      fingerprint: fingerprintOperation(descriptor)
    });
  }
  const pinned: Record<string, string> = { ...input.previous?.pinned };
  for (const operation of input.accepted) {
    const entry = entries.get(operation.name);
    if (!entry || pinOf(pinned, operation.name) !== undefined) continue;
    // Config that names a fingerprint has accepted exactly that descriptor. A different one
    // is not pinned behind its back: it would become the accepted one if the line were removed.
    if (
      operation.schemaFingerprint !== undefined &&
      operation.schemaFingerprint !== entry.fingerprint
    ) {
      continue;
    }
    pinned[operation.name] = entry.fingerprint;
  }
  return { version: 1, discoveredAt: input.now, entries: [...entries.values()], pinned };
}

/**
 * Whether both schemas of a descriptor of the release can be checked. One that cannot is not
 * callable. They are the release's own, so they are compiled here.
 */
function schemasCompile(descriptor: ConnectorOperationDescriptor): boolean {
  return (
    compileJsonSchema(descriptor.inputSchema).ok &&
    (descriptor.outputSchema === undefined || compileJsonSchema(descriptor.outputSchema).ok)
  );
}

/**
 * Whether both schemas of a descriptor an outside system wrote are within the bounds of such
 * a schema. Nothing is compiled here: that happens in a worker thread, at the discovery that
 * stored the descriptor and again at a call (`schema-check.ts`).
 */
function schemasWithinOutsideBounds(descriptor: ConnectorOperationDescriptor): boolean {
  return (
    measureOutsideJsonSchema(descriptor.inputSchema).ok &&
    (descriptor.outputSchema === undefined || measureOutsideJsonSchema(descriptor.outputSchema).ok)
  );
}

/**
 * Whether the operations of a type are described by an outside system: a type without a
 * catalog of its own reads them at a discovery. Their schemas are untrusted and are compiled
 * and checked in a worker thread only.
 */
export function describedByOutsideSystem(type: Pick<ConnectorTypeDefinition, "catalog">): boolean {
  return type.catalog === undefined;
}

export interface ConnectionOperationState {
  status: ConnectionOperationStatus;
  /**
   * The operation as the type's catalog or the last discovery describes it, where one of them
   * lists it. It is present for an operation that is not `ready` too, so a page can show what
   * was read: only `ready` makes it callable.
   */
  descriptor?: ConnectorOperationDescriptor;
  /** The fingerprint that was read, where it is not the accepted one. */
  discoveredFingerprint?: string;
}

/**
 * Whether one accepted operation can be called. The accepted fingerprint is the one config
 * names, else the pin of the first discovery. A type with a static catalog needs no stored
 * catalog: its descriptor is the release's own. A fingerprint config names is checked against
 * it all the same.
 */
export function connectionOperationStatus(input: {
  type: ConnectorTypeDefinition;
  operation: ConnectionOperationConfig;
  catalog: ConnectionCatalog | undefined;
}): ConnectionOperationState {
  const { type, operation, catalog } = input;
  let descriptor: ConnectorOperationDescriptor | undefined;
  let fingerprint: string | undefined;
  let accepted: string | undefined;
  if (type.catalog) {
    descriptor = type.catalog.find(
      (candidate) => candidate.name === operation.name && hasUsableSchemas(candidate)
    );
    fingerprint = descriptor ? fingerprintOperation(descriptor) : undefined;
    accepted = operation.schemaFingerprint ?? fingerprint;
  } else {
    if (!catalog) {
      return { status: operation.enabled ? "awaiting_discovery" : "disabled" };
    }
    const entry = catalog.entries.find((candidate) => candidate.name === operation.name);
    descriptor = entry;
    fingerprint = entry?.fingerprint;
    accepted = operation.schemaFingerprint ?? pinOf(catalog.pinned, operation.name);
  }
  if (!operation.enabled) {
    return { status: "disabled", ...(descriptor ? { descriptor } : {}) };
  }
  if (!descriptor || fingerprint === undefined) {
    return { status: "unknown" };
  }
  if (accepted === undefined) {
    // Listed by a discovery that ran before the operation was accepted. The next one pins it.
    return { status: "awaiting_discovery", descriptor };
  }
  if (accepted !== fingerprint) {
    return { status: "needs_review", descriptor, discoveredFingerprint: fingerprint };
  }
  const checkable = describedByOutsideSystem(type)
    ? schemasWithinOutsideBounds(descriptor)
    : schemasCompile(descriptor);
  return checkable ? { status: "ready", descriptor } : { status: "unknown" };
}
