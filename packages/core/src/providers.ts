import { z } from "zod";
import { AppError } from "./errors";
import type { Logger } from "./logger";
import { secretRefFields, SecretNotResolvedError, type SecretResolver } from "./secrets";

/** What an instance takes from outside its own processes. A closed list. */
export const PROVIDER_PORTS = ["models", "mail", "objectStorage", "sandbox", "secrets"] as const;
export type ProviderPort = (typeof PROVIDER_PORTS)[number];

/**
 * Where a provider processes the data an instance sends it. Product-owned and closed: a vendor's
 * own region name is a separate field of its adapter, such as `bucketRegion`.
 */
export const PROVIDER_REGIONS = ["eu", "global"] as const;
export type ProviderRegion = (typeof PROVIDER_REGIONS)[number];

/**
 * Fields of an entry that belong to the port and are read by the product whatever adapter
 * serves it. Everything else in an entry belongs to the chosen adapter's schema.
 */
export const PROVIDER_PORT_FIELDS: Record<ProviderPort, readonly string[]> = {
  models: ["model", "api", "reasoningEffort", "contextManagement"],
  mail: ["appUrl", "sender"],
  objectStorage: [],
  sandbox: [],
  secrets: []
};

export interface ProviderCreateContext {
  secrets: SecretResolver;
  logger: Logger;
}

/** Display fields of a configured provider. Never a secret value. */
export type ProviderDescription = Record<string, string | number | boolean>;

export type ProviderCheckResult = { ok: true } | { ok: false; errorClass: string };

export interface ProviderDefinitionInput<
  Port extends ProviderPort,
  Schema extends z.ZodObject,
  Instance
> {
  port: Port;
  /** The value of `provider` in an entry, such as `openai-compatible` or `docker`. */
  type: string;
  /** Owned by the adapter. A field that takes a secret is `secretRef()`. */
  configSchema: Schema;
  /** True when data leaves the instance. The entry must then state a `region`. */
  external: boolean;
  create(config: z.output<Schema>, context: ProviderCreateContext): Instance | Promise<Instance>;
  /** Never a prompt, a mail or a user-visible write. */
  check?(instance: Instance): Promise<ProviderCheckResult>;
  describe(config: z.output<Schema>): ProviderDescription;
}

/** Where an entry sits in the instance config, for messages: `infrastructure.models.azure-eu`. */
export interface ProviderEntry {
  path: string;
  entry: unknown;
}

export interface ValidatedProviderEntry {
  port: ProviderPort;
  type: string;
  external: boolean;
  region?: ProviderRegion;
  /** Field name and secret name of every secret the entry refers to. */
  secrets: { field: string; name: string }[];
  description: ProviderDescription;
}

export interface ProviderDefinition<Port extends ProviderPort = ProviderPort, Instance = unknown> {
  readonly port: Port;
  readonly type: string;
  readonly external: boolean;
  readonly configSchema: z.ZodObject;
  /** Validates an entry against the adapter's schema and the region rule. Reads no secret. */
  validate(entry: ProviderEntry): ValidatedProviderEntry;
  /** Validates, resolves every secret the entry names, then creates the provider. */
  create(entry: ProviderEntry, context: ProviderCreateContext): Promise<Instance>;
  /**
   * Optional until provider checks ship. Declared as a method so a definition for one instance
   * type is also a definition of an unknown one, which is how the registry holds it.
   */
  check?(instance: Instance): Promise<ProviderCheckResult>;
}

const providerRegionSchema = z.enum(PROVIDER_REGIONS);

/** The one way a provider enters the product: its port, its type, its schema and its factory. */
export function defineProvider<Port extends ProviderPort, Schema extends z.ZodObject, Instance>(
  input: ProviderDefinitionInput<Port, Schema, Instance>
): ProviderDefinition<Port, Instance> {
  const secretFields = secretRefFields(input.configSchema);
  const portFields = new Set(["provider", "region", ...PROVIDER_PORT_FIELDS[input.port]]);

  function parse(entry: ProviderEntry): {
    config: z.output<Schema>;
    validated: ValidatedProviderEntry;
  } {
    if (!isRecord(entry.entry)) {
      throw infrastructureError(entry.path, "must be an object with a 'provider'");
    }
    const region = readRegion(entry, input);
    const adapterFields = Object.fromEntries(
      Object.entries(entry.entry).filter(([key]) => !portFields.has(key))
    );
    const unknownField = Object.keys(adapterFields).find(
      (key) => !(key in input.configSchema.shape)
    );
    if (unknownField !== undefined) {
      throw infrastructureError(
        `${entry.path}.${unknownField}`,
        `is not a setting of the '${input.type}' provider`
      );
    }
    const parsed = input.configSchema.safeParse(adapterFields);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = issue?.path.join(".") ?? "";
      throw infrastructureError(
        field ? `${entry.path}.${field}` : entry.path,
        issue ? `is invalid: ${issue.message}` : "is invalid"
      );
    }
    const config = parsed.data;
    return {
      config,
      validated: {
        port: input.port,
        type: input.type,
        external: input.external,
        ...(region ? { region } : {}),
        secrets: secretFields.flatMap((field) => {
          const name: unknown = Reflect.get(config, field);
          return typeof name === "string" ? [{ field, name }] : [];
        }),
        description: input.describe(config)
      }
    };
  }

  return {
    port: input.port,
    type: input.type,
    external: input.external,
    configSchema: input.configSchema,
    ...(input.check ? { check: input.check } : {}),
    validate(entry) {
      return parse(entry).validated;
    },
    async create(entry, context) {
      const { config, validated } = parse(entry);
      for (const secret of validated.secrets) {
        try {
          await context.secrets.resolve(secret.name);
        } catch (error) {
          if (error instanceof SecretNotResolvedError) {
            throw infrastructureError(
              `${entry.path}.${secret.field}`,
              `names the secret '${secret.name}', which does not resolve`
            );
          }
          throw error;
        }
      }
      return input.create(config, context);
    }
  };
}

/** Every provider an instance can run on. Client assembly builds one at startup. */
export class ProviderRegistry {
  private readonly definitions = new Map<string, ProviderDefinition>();

  constructor(definitions: readonly ProviderDefinition[] = []) {
    for (const definition of definitions) {
      this.register(definition);
    }
  }

  register(definition: ProviderDefinition): void {
    const key = registryKey(definition.port, definition.type);
    if (this.definitions.has(key)) {
      throw new AppError(
        "VALIDATION_FAILED",
        `Provider '${definition.type}' is registered twice for the port '${definition.port}'`
      );
    }
    this.definitions.set(key, definition);
  }

  list(): ProviderDefinition[] {
    return [...this.definitions.values()];
  }

  /** The definition an entry names. An unknown type names the port, the field and the choices. */
  find(port: ProviderPort, entry: ProviderEntry): ProviderDefinition {
    const type = isRecord(entry.entry) ? entry.entry.provider : undefined;
    const definition =
      typeof type === "string" ? this.definitions.get(registryKey(port, type)) : undefined;
    if (!definition) {
      const known = this.list()
        .filter((candidate) => candidate.port === port)
        .map((candidate) => candidate.type)
        .sort();
      throw infrastructureError(
        `${entry.path}.provider`,
        `${typeof type === "string" ? `'${type}' is` : "is"} not a registered provider for the port '${port}'; registered: ${known.join(", ") || "none"}`
      );
    }
    return definition;
  }

  validate(port: ProviderPort, entry: ProviderEntry): ValidatedProviderEntry {
    return this.find(port, entry).validate(entry);
  }
}

/**
 * Creates the provider an entry names from the typed definitions of one port. A type that is
 * not among them stops startup and names the port and the field.
 */
export async function createProvider<Port extends ProviderPort, Instance>(
  definitions: readonly ProviderDefinition<Port, Instance>[],
  port: Port,
  entry: ProviderEntry,
  context: ProviderCreateContext
): Promise<Instance> {
  if (entry.entry === undefined) {
    throw infrastructureError(entry.path, "is required and names the provider to use");
  }
  const type = isRecord(entry.entry) ? entry.entry.provider : undefined;
  const definition = definitions.find(
    (candidate) => candidate.port === port && candidate.type === type
  );
  if (!definition) {
    throw infrastructureError(
      `${entry.path}.provider`,
      `${typeof type === "string" ? `'${type}' is` : "is"} not a registered provider for the port '${port}'; registered: ${
        definitions
          .map((candidate) => candidate.type)
          .sort()
          .join(", ") || "none"
      }`
    );
  }
  return definition.create(entry, context);
}

function readRegion(
  entry: ProviderEntry,
  definition: { type: string; external: boolean }
): ProviderRegion | undefined {
  const raw: unknown = isRecord(entry.entry) ? entry.entry.region : undefined;
  if (!definition.external) {
    if (raw !== undefined) {
      throw infrastructureError(
        `${entry.path}.region`,
        `must be absent: the '${definition.type}' provider keeps data inside the instance`
      );
    }
    return undefined;
  }
  const region = providerRegionSchema.safeParse(raw);
  if (!region.success) {
    throw infrastructureError(
      `${entry.path}.region`,
      `is required and must be one of ${PROVIDER_REGIONS.join(", ")}: the '${definition.type}' provider sends data outside the instance`
    );
  }
  return region.data;
}

/** A startup failure in the `infrastructure` section. The message names the field, no value. */
export function infrastructureError(field: string, reason: string): AppError {
  return new AppError("VALIDATION_FAILED", `'${field}' ${reason}`, { field });
}

function registryKey(port: ProviderPort, type: string): string {
  return `${port}:${type}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
