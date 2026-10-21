import { connectionConfigSchema } from "@work-shape/catalyst-config-schema";
import {
  AppError,
  type CatalogueCategory,
  CONNECTION_REFUSALS,
  findConnectorTypeIssues,
  type CataloguePart,
  type ConnectionCatalogueLink,
  type ConnectorTypeDefinition,
  type ConnectorTypeRegistry,
  type JsonObject,
  type LocalizedStringConfig
} from "@work-shape/catalyst-core";
import type { EgressAllowEntry } from "../egress";
import {
  entryParts,
  partSettings,
  type CatalogueEntry,
  type CatalogueEntryOperation,
  type CatalogueEntryPart
} from "./entry";

// The catalogue of one instance: the entries the release ships, which of them the operator
// offers (`catalogue.entries`), and what New connection shows of each. An entry recommends
// and the admin enables: what is built here grants nothing, enables no operation and opens
// no host. Only a named entry's hosts join the egress list, and only a named entry is
// installed.

/** A field of a part as the dialog reads it. */
export interface CatalogueFieldView {
  label: LocalizedStringConfig;
  help?: LocalizedStringConfig;
  optional: boolean;
  /** The dotted path in `settings`; absent for the secret. */
  setting?: string;
  secret: boolean;
  default?: string;
}

/** An operation a tools part proposes, as the review step lists it. Nothing in it is enabled. */
export interface CatalogueOperationView {
  name: string;
  title?: string;
  description?: string;
  effect: CatalogueEntryOperation["effect"];
  /** Ticked in the review step. Only ever true for a reading operation. */
  recommended: boolean;
  /** What a Connection's operation declares of itself, and a tighter policy, where it has them. */
  declaration?: JsonObject;
}

export interface CataloguePartView {
  part: CataloguePart;
  connectorType: string;
  /** The default id of the Connection the part makes. */
  name: string;
  title?: LocalizedStringConfig;
  description: LocalizedStringConfig;
  authScheme: string;
  /** Fixed settings, beside what the fields fill in. */
  settings: JsonObject;
  fields: CatalogueFieldView[];
  prerequisites: { text: LocalizedStringConfig; value?: string }[];
  /** The hosts the part reaches, as a person reads them. */
  hosts: string[];
  operations: CatalogueOperationView[];
  sharedAccountNote: LocalizedStringConfig;
  /** A Knowledge Base can sync documents through the Connection. */
  documentSource: boolean;
}

export interface CatalogueEntryView {
  id: string;
  version: number;
  service: string;
  title: LocalizedStringConfig;
  description: LocalizedStringConfig;
  category: CatalogueCategory;
  examplePrompts: LocalizedStringConfig[];
  mark: { color?: string; logo?: string };
  /** The operator names it in `catalogue.entries`: it can be installed. */
  offered: boolean;
  /** The parts whose Connector type this build registers. */
  parts: CataloguePartView[];
}

export interface Catalogue {
  /** Every entry the release ships, offered or not, by id. */
  readonly entries: readonly CatalogueEntryView[];
  /** The hosts of the offered entries: they join the operator's `egress.allow`. */
  readonly egress: readonly EgressAllowEntry[];
  /**
   * Why a Connection may not name this link, or nothing. Asked when a write sets or changes a
   * Connection's `catalogue`: the entry must be offered and its part of the Connection's type.
   */
  linkIssue(link: ConnectionCatalogueLink, connectorType: string): string | undefined;
}

/** The part's fields, auth scheme and fixed settings: its own, or its Connector type's form. */
function resolvePart(
  entry: CatalogueEntry,
  part: CataloguePart,
  definition: CatalogueEntryPart,
  type: ConnectorTypeDefinition
): { fields: CatalogueFieldView[]; authScheme: string; settings: JsonObject } {
  if (type.discover !== undefined) {
    refuse(
      entry,
      `its ${part} part names the Connector type '${type.type}', which reads its operations from the outside system; such a part arrives with CAT-4`
    );
  }
  if (definition.fields !== undefined && definition.authScheme !== undefined) {
    return {
      fields: definition.fields.map((field) => ({
        label: field.label,
        ...(field.help === undefined ? {} : { help: field.help }),
        optional: field.optional === true,
        ...(field.setting === undefined ? {} : { setting: field.setting }),
        secret: field.secret === true,
        ...(field.default === undefined ? {} : { default: field.default })
      })),
      authScheme: definition.authScheme,
      settings: partSettings(definition)
    };
  }
  const form = type.form;
  if (form === undefined) {
    refuse(
      entry,
      `its ${part} part names no fields, and the Connector type '${type.type}' has no form to take them from`
    );
  }
  // The type's form is written once: its fields fill the part's step.
  return {
    fields: form.fields.map((field) => ({
      label: field.label,
      ...(field.help === undefined ? {} : { help: field.help }),
      optional: field.optional === true,
      ...(field.setting === undefined ? {} : { setting: field.setting }),
      secret: field.secret === true
    })),
    authScheme: form.authScheme,
    settings: { ...structuredClone(form.settings ?? {}), ...partSettings(definition) }
  };
}

function refuse(entry: Pick<CatalogueEntry, "id">, message: string): never {
  throw new AppError("VALIDATION_FAILED", `Catalogue entry '${entry.id}': ${message}`);
}

function setAt(target: JsonObject, path: readonly string[], value: string): void {
  const [head, ...rest] = path;
  if (head === undefined) return;
  if (rest.length === 0) {
    target[head] = value;
    return;
  }
  const current = target[head];
  const child: JsonObject =
    typeof current === "object" && current !== null && !Array.isArray(current)
      ? { ...current }
      : {};
  setAt(child, rest, value);
  target[head] = child;
}

function operationView(operation: CatalogueEntryOperation): CatalogueOperationView {
  const { name, title, description, effect, recommended, policy, ...request } = operation;
  const declaration: JsonObject = {
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(policy === undefined ? {} : { policy }),
    ...Object.fromEntries(
      Object.entries(structuredClone(request)).filter(([, value]) => value !== undefined)
    )
  };
  return {
    name,
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    effect,
    // A changing operation is never ticked in advance, whatever an entry says.
    recommended: recommended && effect === "reading",
    ...(Object.keys(declaration).length === 0 ? {} : { declaration })
  };
}

/**
 * Checks a part as the instance would check the Connection it makes with every proposed
 * operation accepted: the definition's schema, the Connector type's settings, auth schemes and
 * declarations, and that the type's target lies on the part's own egress list. A setting a
 * field fills is checked with the field's default, or not at all where it has none.
 */
function checkPart(
  entry: CatalogueEntry,
  part: CataloguePart,
  definition: CatalogueEntryPart,
  type: ConnectorTypeDefinition,
  resolved: ReturnType<typeof resolvePart>,
  registry: ConnectorTypeRegistry
): void {
  const settings = structuredClone(resolved.settings);
  for (const field of resolved.fields) {
    if (field.setting !== undefined && field.default !== undefined) {
      setAt(settings, field.setting.split("."), field.default);
    }
  }
  const filled = new Set(
    resolved.fields.flatMap((field) =>
      field.setting === undefined || field.default !== undefined
        ? []
        : [field.setting.split(".")[0]]
    )
  );
  const operations = definition.operations.map((operation) => {
    const view = operationView(operation);
    return {
      ...view.declaration,
      name: view.name,
      effect: view.effect,
      exposure: ["agent"],
      enabled: true
    };
  });
  const probe = connectionConfigSchema.safeParse({
    name: definition.name,
    displayName: entry.id,
    service: entry.service,
    catalogue: { entry: entry.id, part, version: entry.version },
    connectorType: type.type,
    ownerPrincipalId: "system",
    settings,
    authScheme: resolved.authScheme,
    operations,
    enabled: true,
    origin: "runtime"
  });
  if (!probe.success) {
    refuse(
      entry,
      `its ${part} part: ${probe.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`
    );
  }
  const issues = findConnectorTypeIssues(registry, probe.data).filter(
    (issue) => !(issue.path?.[0] === "settings" && filled.has(String(issue.path[1] ?? "")))
  );
  if (issues.length > 0) {
    refuse(
      entry,
      `its ${part} part: ${issues.map((issue) => `${(issue.path ?? []).join(".")}: ${issue.message}`).join("; ")}`
    );
  }
  const secretFields = resolved.fields.filter((field) => field.secret).length;
  if ((resolved.authScheme === "none") !== (secretFields === 0)) {
    refuse(entry, `its ${part} part asks for a secret exactly where its auth scheme sends one`);
  }
  const parsed = type.settingsSchema.safeParse(settings);
  if (!parsed.success) return;
  let target;
  try {
    target = type.target(parsed.data);
  } catch {
    return;
  }
  const listed = definition.egress.some(
    (host) =>
      host.protocol === target.protocol &&
      host.host.toLowerCase() === target.host.toLowerCase() &&
      host.port === target.port
  );
  if (!listed) {
    refuse(
      entry,
      `its ${part} part reaches ${target.host}:${target.port}, which is not on its own egress list`
    );
  }
}

function hostLabel(host: EgressAllowEntry): string {
  const usual =
    (host.protocol === "https" && host.port === 443) ||
    (host.protocol === "http" && host.port === 80);
  return usual ? host.host : `${host.host}:${host.port}`;
}

/**
 * The catalogue of an instance. Every entry the release ships is checked here, offered or
 * not, so a broken entry stops the start. The start also stops where `named` lists an entry
 * the release does not ship, or one with no part this build can install.
 */
export function createCatalogue(input: {
  entries: readonly CatalogueEntry[];
  named: readonly string[];
  connectorTypes: ConnectorTypeRegistry;
}): Catalogue {
  const byId = new Map<string, CatalogueEntry>();
  for (const entry of input.entries) {
    if (byId.has(entry.id)) refuse(entry, "the release ships it more than once");
    byId.set(entry.id, entry);
  }
  for (const id of input.named) {
    if (!byId.has(id)) {
      throw new AppError(
        "VALIDATION_FAILED",
        `catalogue.entries names '${id}', an entry this release does not ship`
      );
    }
  }
  const named = new Set(input.named);
  const views: CatalogueEntryView[] = [];
  const egress: EgressAllowEntry[] = [];
  for (const entry of [...byId.values()].sort((left, right) => (left.id < right.id ? -1 : 1))) {
    const offered = named.has(entry.id);
    const parts: CataloguePartView[] = [];
    for (const { part, definition } of entryParts(entry)) {
      const type = input.connectorTypes.get(definition.connectorType);
      // A part of a type this build does not register is not offered.
      if (type === undefined) continue;
      const resolved = resolvePart(entry, part, definition, type);
      checkPart(entry, part, definition, type, resolved, input.connectorTypes);
      parts.push({
        part,
        connectorType: type.type,
        name: definition.name,
        ...(definition.title === undefined ? {} : { title: definition.title }),
        description: definition.description,
        authScheme: resolved.authScheme,
        settings: resolved.settings,
        fields: resolved.fields,
        prerequisites: definition.prerequisites.map((line) => ({
          text: line.text,
          ...(line.value === undefined ? {} : { value: line.value })
        })),
        hosts: definition.egress.map(hostLabel),
        operations: definition.operations.map(operationView),
        sharedAccountNote: definition.sharedAccountNote,
        documentSource: type.documentSource !== undefined
      });
      if (offered) egress.push(...definition.egress);
    }
    if (offered && parts.length === 0) {
      throw new AppError(
        "VALIDATION_FAILED",
        `catalogue.entries names '${entry.id}', and this build registers the Connector type of none of its parts (${entryParts(
          entry
        )
          .map(({ definition }) => definition.connectorType)
          .join(", ")})`
      );
    }
    views.push({
      id: entry.id,
      version: entry.version,
      service: entry.service,
      title: entry.title,
      description: entry.description,
      category: entry.category,
      examplePrompts: entry.examplePrompts,
      mark: entry.mark.logo === undefined ? { color: entry.mark.color } : { logo: entry.mark.logo },
      offered,
      parts
    });
  }
  const entries = Object.freeze(views);
  return Object.freeze({
    entries,
    egress: Object.freeze(egress),
    linkIssue(link: ConnectionCatalogueLink, connectorType: string): string | undefined {
      const entry = entries.find((candidate) => candidate.id === link.entry);
      if (entry === undefined || !entry.offered) {
        return `${CONNECTION_REFUSALS.catalogueEntryNotOffered}: this instance does not offer the catalogue entry '${link.entry}'`;
      }
      const part = entry.parts.find((candidate) => candidate.part === link.part);
      if (part === undefined) {
        return `${CONNECTION_REFUSALS.catalogueEntryNotOffered}: the catalogue entry '${link.entry}' has no ${link.part} part on this instance`;
      }
      if (part.connectorType !== connectorType) {
        return `${CONNECTION_REFUSALS.catalogueEntryNotOffered}: the ${link.part} part of '${link.entry}' makes a Connection of type '${part.connectorType}', not '${connectorType}'`;
      }
      if (link.version !== entry.version) {
        return `${CONNECTION_REFUSALS.catalogueEntryNotOffered}: the catalogue entry '${link.entry}' is at version ${entry.version}, not ${link.version}`;
      }
      return undefined;
    }
  });
}
