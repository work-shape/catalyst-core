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

/**
 * What the providers of a port create. The package that owns a port's interface adds its line
 * by declaration merging, so the registry hands back that type and a definition for the port
 * must create it. A port without a line here creates a value the registry cannot type.
 */
export interface ProviderInstances {
  secrets: SecretResolver;
}

export type ProviderInstance<Port extends ProviderPort> = Port extends keyof ProviderInstances
  ? ProviderInstances[Port]
  : unknown;

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
  /**
   * True when data leaves the instance. The entry must then state a `region`. A function when
   * it depends on the entry, such as an engine that is local unless an endpoint names a host.
   */
  external: boolean | ((config: z.output<Schema>) => boolean);
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
    const external = typeof input.external === "function" ? input.external(config) : input.external;
    const region = readRegion(entry, { type: input.type, external });
    return {
      config,
      validated: {
        port: input.port,
        type: input.type,
        external,
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
              describeUnresolvedSecret(error)
            );
          }
          throw error;
        }
      }
      return input.create(config, context);
    }
  };
}

/** A definition as the registry holds it: its instance is the one its port creates. */
export type RegisteredProviderDefinition = {
  [Port in ProviderPort]: ProviderDefinition<Port, ProviderInstance<Port>>;
}[ProviderPort];

type DefinitionsByPort = {
  [Port in ProviderPort]: Map<string, ProviderDefinition<Port, ProviderInstance<Port>>>;
};

/**
 * Every provider an instance can run on. Client assembly builds one at startup from the
 * platform's own providers and the ones capabilities bring, and every provider of a typed port
 * is created through it.
 */
export class ProviderRegistry {
  private readonly definitions: DefinitionsByPort = {
    models: new Map(),
    mail: new Map(),
    objectStorage: new Map(),
    sandbox: new Map(),
    secrets: new Map()
  };

  constructor(definitions: readonly RegisteredProviderDefinition[] = []) {
    for (const definition of definitions) {
      this.register(definition);
    }
  }

  register<Port extends ProviderPort>(
    definition: ProviderDefinition<Port, ProviderInstance<Port>>
  ): void {
    const ofPort = this.definitions[definition.port];
    if (ofPort.has(definition.type)) {
      throw new AppError(
        "VALIDATION_FAILED",
        `Provider '${definition.type}' is registered twice for the port '${definition.port}'`
      );
    }
    ofPort.set(definition.type, definition);
  }

  /** The definition an entry names. An unknown type names the port, the field and the choices. */
  find<Port extends ProviderPort>(
    port: Port,
    entry: ProviderEntry
  ): ProviderDefinition<Port, ProviderInstance<Port>> {
    return findDefinition([...this.definitions[port].values()], port, entry);
  }

  validate(port: ProviderPort, entry: ProviderEntry): ValidatedProviderEntry {
    return this.find(port, entry).validate(entry);
  }

  /** Validates the entry, resolves the secrets it names and creates the provider it names. */
  async create<Port extends ProviderPort>(
    port: Port,
    entry: ProviderEntry,
    context: ProviderCreateContext
  ): Promise<ProviderInstance<Port>> {
    if (entry.entry === undefined) {
      throw infrastructureError(entry.path, "is required and names the provider to use");
    }
    return this.find(port, entry).create(entry, context);
  }
}

/**
 * Creates the provider an entry names from the typed definitions of one slot, for a slot whose
 * instance type is narrower than its port's, such as each of the two object stores. A type that
 * is not among them stops startup and names the port and the field.
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
  return findDefinition(definitions, port, entry).create(entry, context);
}

function findDefinition<Port extends ProviderPort, Instance>(
  definitions: readonly ProviderDefinition<Port, Instance>[],
  port: Port,
  entry: ProviderEntry
): ProviderDefinition<Port, Instance> {
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
  return definition;
}

/** Names the secret only when the error carries a name, which it does for a checked name. */
function describeUnresolvedSecret(error: SecretNotResolvedError): string {
  const which = error.kind === "absent" ? "does not resolve" : error.reason;
  return error.secretName
    ? `names the secret '${error.secretName}', which ${which}`
    : `names a secret that ${which}`;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
