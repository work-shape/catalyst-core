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

/** What a validator may look up besides the definition it checks. */
export interface AssetValidationContext {
  /** The definitions of one kind as they stand once the change is applied. */
  definitions(kind: string): readonly unknown[];
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
  /** Reference and cross-asset checks of one definition the schema accepted. */
  validate(context: AssetValidationContext, definition: Definition): AssetValidationIssue[];
  summarize(definition: Definition): AssetSummary;
}

/**
 * A kind as the registry holds it. The definition type is closed over: `validate` and
 * `summarize` take what a caller received and parse it with the kind's schema first, so shared
 * code handles every kind without knowing its definition.
 */
export interface RegisteredAssetKind<Kind extends string = string> {
  readonly kind: Kind;
  readonly plural: string;
  readonly nameRule: AssetNameRule;
  readonly actions: Readonly<AssetKindActions>;
  /** Schema issues, then the name rule, then the kind's own checks. Empty when valid. */
  validate(context: AssetValidationContext, definition: unknown): AssetValidationIssue[];
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
    validate(context: AssetValidationContext, input: unknown) {
      const parsed = definition.schema.safeParse(input);
      if (!parsed.success) {
        return parsed.error.issues.map(({ message, path }) => ({ message, path }));
      }
      const nameIssue = assetNameIssue({ nameRule }, definition.summarize(parsed.data).name);
      return nameIssue ? [nameIssue] : definition.validate(context, parsed.data);
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
