import {
  releaseConnectionConfigSchema,
  type ReleaseConnectionConfig,
  type ReleaseConnectionInput
} from "@work-shape/catalyst-config-schema";
import { AppError, type JsonObject } from "@work-shape/catalyst-core";
import { settingsWithScopes, type Catalogue, type CataloguePartView } from "./catalogue";

/** Expand references before the seed reads secrets or writes any asset. */
export function expandReleaseConnections(
  connections: Readonly<Record<string, ReleaseConnectionInput>>,
  catalogue?: Pick<Catalogue, "entries">
): Record<string, ReleaseConnectionConfig> {
  return Object.fromEntries(
    Object.entries(connections).map(([name, config]) => {
      if (!("fromEntry" in config)) return [name, config];
      const fail: (message: string) => never = (message) => {
        throw new AppError(
          "VALIDATION_FAILED",
          `connections.${name}: catalogue entry '${config.fromEntry}': ${message}`
        );
      };
      const entry = catalogue?.entries.find((candidate) => candidate.id === config.fromEntry);
      if (entry === undefined) fail("unknown entry in this release");
      if (!entry.offered) fail("not offered; name it in catalogue.entries first");
      const part =
        config.part === undefined && entry.parts.length === 1
          ? entry.parts[0]
          : entry.parts.find((candidate) => candidate.part === config.part);
      if (part === undefined)
        fail(
          config.part === undefined
            ? "choose a part explicitly with 'part: tools' or 'part: source'"
            : `the '${config.part}' part is not offered on this instance`
        );
      if (!part.credentialModes.includes("shared"))
        fail("release Connections require shared mode; install this personal part at runtime");
      const { fromEntry: _fromEntry, part: _part, settings, operations, ...overrides } = config;
      return [
        name,
        releaseConnectionConfigSchema.parse({
          connectorType: part.connectorType,
          authScheme: part.authScheme,
          service: entry.service,
          catalogue: { entry: entry.id, part: part.part, version: entry.version },
          ...overrides,
          settings: settingsWithScopes(
            part,
            mergeSettings(defaultSettings(part), settings),
            operations ?? part.operations
          ),
          // Only an explicit operator list accepts exposures. An entry grants none.
          operations:
            operations ??
            part.operations.map((operation) => ({
              ...operation.declaration,
              name: operation.name,
              effect: operation.effect,
              exposure: []
            }))
        })
      ];
    })
  );
}

function defaultSettings(part: CataloguePartView): JsonObject {
  const settings = structuredClone(part.settings);
  for (const field of part.fields) {
    if (field.setting === undefined || field.default === undefined) continue;
    let target = settings;
    const keys = field.setting.split(".");
    const last = keys.pop();
    for (const key of keys) {
      const value = Object.hasOwn(target, key) ? target[key] : undefined;
      const child = isObject(value) ? value : {};
      Object.defineProperty(target, key, {
        value: child,
        enumerable: true,
        writable: true,
        configurable: true
      });
      target = child;
    }
    if (last !== undefined)
      Object.defineProperty(target, last, {
        value: field.default,
        enumerable: true,
        writable: true,
        configurable: true
      });
  }
  return settings;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Settings merge recursively; an explicit scalar or array replaces the default. */
function mergeSettings(base: JsonObject, overrides: JsonObject): JsonObject {
  const result = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    const previous = result[key];
    Object.defineProperty(result, key, {
      value: isObject(previous) && isObject(value) ? mergeSettings(previous, value) : value,
      enumerable: true,
      writable: true,
      configurable: true
    });
  }
  return result;
}

/** Pure runtime expansion; secrets are entered separately through connections.set_secret. */
export function expandCataloguePart(
  part: CataloguePartView,
  input: {
    settings?: JsonObject;
    operations: readonly { name: string; enabled?: boolean }[];
    credentialMode?: CataloguePartView["defaultCredentialMode"];
  }
) {
  const credentialMode = input.credentialMode ?? part.defaultCredentialMode;
  if (!part.credentialModes.includes(credentialMode))
    throw new AppError(
      "VALIDATION_FAILED",
      "The catalogue part does not allow this credential mode"
    );
  return {
    connectorType: part.connectorType,
    authScheme: part.authScheme,
    credentialMode,
    settings: settingsWithScopes(
      part,
      mergeSettings(defaultSettings(part), input.settings ?? {}),
      input.operations
    ),
    operations: part.operations
      .filter((operation) =>
        input.operations.some(
          (selected) => selected.name === operation.name && selected.enabled !== false
        )
      )
      .map((operation) => ({
        ...operation.declaration,
        name: operation.name,
        effect: operation.effect,
        enabled: true,
        exposure: []
      }))
  };
}
