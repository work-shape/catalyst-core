import { AppError } from "./errors";
import type { CollaborationWorkspaceId } from "./ids";

/** Who owns an asset: the instance, or one workspace. */
export type AssetScope =
  { kind: "instance" } | { kind: "workspace"; workspaceId: CollaborationWorkspaceId };

export const INSTANCE_ASSET_SCOPE: AssetScope = Object.freeze({ kind: "instance" });

export function assetScopesEqual(left: AssetScope, right: AssetScope): boolean {
  return left.kind === "workspace"
    ? right.kind === "workspace" && left.workspaceId === right.workspaceId
    : right.kind === "instance";
}

export interface AssetValidationIssue {
  message: string;
  path?: PropertyKey[];
}

/** What a kind's schema must answer. A schema library's object fits without being named here. */
export interface AssetKindSchema<Definition> {
  safeParse(
    input: unknown
  ):
    | { success: true; data: Definition }
    | { success: false; error: { issues: AssetValidationIssue[] } };
}

/** The names a kind accepts. `description` is the sentence a refused name is answered with. */
export interface AssetNameRule {
  pattern: RegExp;
  maxLength?: number;
  description: string;
}

/** The action names the rights of a kind are checked as. */
export interface AssetKindActions {
  read: string;
  write: string;
  delete: string;
}

/** What a validator may look up besides the definitions it checks. */
export interface AssetValidationContext {
  /** The definitions of one kind as they stand once the change is applied. */
  definitions(kind: string): readonly unknown[];
  /**
   * Whether the change adds or changes this definition. A rule that tolerates what is stored
   * already asks, so a stored asset never stands in the way of a write to another one.
   */
  changes(kind: string, name: string): boolean;
}

/** What a list shows of one asset without knowing its kind. */
export interface AssetSummary {
  name: string;
  title: string;
  description?: string;
}

export interface AssetKindDefinition<Definition, Kind extends string = string> {
  /** The id, such as `agent` or `knowledge_base`. */
  kind: Kind;
  /** The collection name, such as `agents`. Unique among the registered kinds. */
  plural: string;
  schema: AssetKindSchema<Definition>;
  nameRule: AssetNameRule;
  actions: AssetKindActions;
  /**
   * Reference and cross-asset checks of this kind's definitions the schema accepted. All of
   * them are handed over at once, so a kind decides the order of its issues across them.
   */
  validate(
    context: AssetValidationContext,
    definitions: readonly Definition[]
  ): AssetValidationIssue[];
  /**
   * The instance's own rules for a write, asked only once no schema, name or reference issue
   * is left. Returns issues or throws the refusal itself.
   */
  validateWrite?(
    context: AssetValidationContext,
    definitions: readonly Definition[]
  ): AssetValidationIssue[];
  summarize(definition: Definition): AssetSummary;
}

/** A definition the schema or the name rule refused, with its place among those read. */
export interface RefusedAssetDefinition {
  index: number;
  /** The name the definition carries, where it has one. */
  name?: string;
  issues: AssetValidationIssue[];
}

/**
 * What a kind made of the definitions it was handed. The accepted ones stay with the reading
 * in the kind's own type, so the checks run over them without a second parse.
 */
export interface AssetKindReading {
  /** The accepted definitions as the schema reads them, defaults applied, in input order. */
  readonly accepted: readonly unknown[];
  readonly refused: readonly RefusedAssetDefinition[];
  /** The kind's reference and cross-asset checks over the accepted definitions. */
  validate(context: AssetValidationContext): AssetValidationIssue[];
  /** The instance's own rules for a write over the accepted definitions. */
  validateWrite(context: AssetValidationContext): AssetValidationIssue[];
}

/**
 * A kind as the registry holds it. The definition type is closed over: `read` parses what a
 * caller received with the kind's schema, so shared code handles every kind without knowing
 * its definition.
 */
export interface RegisteredAssetKind<Kind extends string = string> {
  readonly kind: Kind;
  readonly plural: string;
  readonly nameRule: AssetNameRule;
  readonly actions: Readonly<AssetKindActions>;
  /** Reads definitions: the schema first, then the name rule. The checks follow on the reading. */
  read(definitions: readonly unknown[]): AssetKindReading;
  /** Throws `VALIDATION_FAILED` for a definition the schema refuses. */
  summarize(definition: unknown): AssetSummary;
}

const KIND_ID_PATTERN = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/u;

export function assetNameIssue(
  kind: Pick<RegisteredAssetKind, "nameRule">,
  name: string
): AssetValidationIssue | undefined {
  const { pattern, maxLength, description } = kind.nameRule;
  return pattern.test(name) && (maxLength === undefined || name.length <= maxLength)
    ? undefined
    : { message: description, path: ["name"] };
}

export function defineAssetKind<Definition, Kind extends string>(
  definition: AssetKindDefinition<Definition, Kind>
): RegisteredAssetKind<Kind> {
  for (const [field, value] of [
    ["kind", definition.kind],
    ["plural", definition.plural]
  ] as const) {
    if (!KIND_ID_PATTERN.test(value)) {
      throw new AppError(
        "VALIDATION_FAILED",
        `Asset kind ${field} '${value}' must be lowercase words joined by underscores`
      );
    }
  }
  const nameRule = Object.freeze({ ...definition.nameRule });
  return Object.freeze({
    kind: definition.kind,
    plural: definition.plural,
    nameRule,
    actions: Object.freeze({ ...definition.actions }),
    read(inputs: readonly unknown[]): AssetKindReading {
      const accepted: Definition[] = [];
      const refused: RefusedAssetDefinition[] = [];
      for (const [index, input] of inputs.entries()) {
        const parsed = definition.schema.safeParse(input);
        if (!parsed.success) {
          const name = readName(input);
          refused.push({
            index,
            ...(name === undefined ? {} : { name }),
            issues: parsed.error.issues.map(({ message, path }) => ({ message, path }))
          });
          continue;
        }
        const { name } = definition.summarize(parsed.data);
        const nameIssue = assetNameIssue({ nameRule }, name);
        if (nameIssue) {
          refused.push({ index, name, issues: [nameIssue] });
        } else {
          accepted.push(parsed.data);
        }
      }
      return {
        accepted,
        refused,
        validate: (context) => definition.validate(context, accepted),
        validateWrite: (context) => definition.validateWrite?.(context, accepted) ?? []
      };
    },
    summarize(input: unknown) {
      const parsed = definition.schema.safeParse(input);
      if (!parsed.success) {
        throw new AppError("VALIDATION_FAILED", `The ${definition.kind} definition is invalid`, {
          issues: parsed.error.issues.map(({ message, path }) => ({
            message,
            path: path?.map(String)
          }))
        });
      }
      return definition.summarize(parsed.data);
    }
  });
}

function readName(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || !("name" in input)) {
    return undefined;
  }
  return typeof input.name === "string" ? input.name : undefined;
}

/** The kinds this build ships, in registration order. */
export interface AssetKindRegistry<Kind extends RegisteredAssetKind = RegisteredAssetKind> {
  readonly kinds: readonly Kind[];
  get(kind: string): Kind | undefined;
  /** Throws `VALIDATION_FAILED` for a kind nothing registered. */
  require(kind: string): Kind;
}

/** Refuses a kind id or a plural that two registrations share: each names one collection. */
export function createAssetKindRegistry<Kind extends RegisteredAssetKind>(
  kinds: readonly Kind[]
): AssetKindRegistry<Kind> {
  const byKind = new Map<string, Kind>();
  const plurals = new Set<string>();
  for (const kind of kinds) {
    if (byKind.has(kind.kind)) {
      throw new AppError(
        "VALIDATION_FAILED",
        `Asset kind '${kind.kind}' is registered more than once`
      );
    }
    if (plurals.has(kind.plural)) {
      throw new AppError(
        "VALIDATION_FAILED",
        `Asset kind plural '${kind.plural}' is registered more than once`
      );
    }
    byKind.set(kind.kind, kind);
    plurals.add(kind.plural);
  }
  const registered = Object.freeze([...kinds]);
  return {
    kinds: registered,
    get: (kind) => byKind.get(kind),
    require(kind) {
      const found = byKind.get(kind);
      if (!found) {
        throw new AppError("VALIDATION_FAILED", `Asset kind '${kind}' is not registered`);
      }
      return found;
    }
  };
}

/**
 * The Namespace an asset name belongs to. It is derived from the name and stored nowhere:
 * registered prefixes cannot overlap, so at most one matches.
 */
export function findNamespaceOfAssetName<Entry extends { prefix: string }>(
  namespaces: readonly Entry[],
  name: string
): Entry | undefined {
  return namespaces.find((namespace) => name.startsWith(namespace.prefix));
}
