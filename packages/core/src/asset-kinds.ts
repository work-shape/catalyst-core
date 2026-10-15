import { isStorableText } from "@vivd-catalyst/asset-schemas";
import { AppError } from "./errors";
import type { CollaborationWorkspaceId } from "./ids";
import type { LocaleCode } from "./localization";

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
  /** The fixed code of the check that found it, where the check names one. */
  code?: string;
}

/** The code of a text or a key of a definition that the store cannot hold. */
const ASSET_TEXT_NOT_STORABLE = "text_not_storable";

/** How many texts of one definition are named before the list ends. */
const UNSTORABLE_TEXT_ISSUES_MAX = 20;

/**
 * Every text and every key of a definition that the store cannot hold, by the path of the
 * value. A key is named by the object that has it, so no path and no message carries the text
 * itself: a refusal is stored with its run. Walked without recursion, since a definition is
 * as deep as its sender made it.
 */
function unstorableTextIssues(input: unknown): AssetValidationIssue[] {
  const issues: AssetValidationIssue[] = [];
  const open: { value: unknown; path: PropertyKey[] }[] = [{ value: input, path: [] }];
  for (
    let next = open.pop();
    next && issues.length < UNSTORABLE_TEXT_ISSUES_MAX;
    next = open.pop()
  ) {
    const { value, path } = next;
    if (typeof value === "string") {
      if (!isStorableText(value)) {
        issues.push({
          path,
          code: ASSET_TEXT_NOT_STORABLE,
          message:
            "The text has a NUL character or half of a surrogate pair in it, which a definition cannot hold"
        });
      }
    } else if (Array.isArray(value)) {
      value.forEach((item: unknown, index) => open.push({ value: item, path: [...path, index] }));
    } else if (typeof value === "object" && value !== null) {
      const entries = Object.entries(value);
      if (entries.some(([key]) => !isStorableText(key))) {
        issues.push({
          path,
          code: ASSET_TEXT_NOT_STORABLE,
          message:
            "A key of this object has a NUL character or half of a surrogate pair in it, which a definition cannot hold"
        });
        continue;
      }
      for (const [key, item] of entries) open.push({ value: item, path: [...path, key] });
    }
  }
  return issues;
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
  /** Moves the published pointer. Only a `draft_published` kind names it. */
  publish?: string;
  /**
   * Decides a publish that waits for an approval, and makes its holder's own publish the
   * approval a guardrail on the kind's publish asks for. Only a `draft_published` kind whose
   * publish a guardrail can hold names it.
   */
  approve?: string;
  /**
   * Where using an asset of the kind is a right of its own: calling through a Connection, or
   * opening the published revision of a kind with users of its own.
   */
  use?: string;
}

/**
 * Which revision of an asset is live. `active`: the newest write is. `draft_published`: a
 * write moves a draft pointer, and a publish moves the pointer its users are served from.
 */
export type AssetLifecycle = "active" | "draft_published";

/** What a revision holds: its config alone, or a config with an immutable file set. */
export type AssetRepresentation = "config" | "files";
/**
 * Where the files of a revision of a `files` kind are kept: as a file set, or as a commit of
 * the repository of the asset, with the ledger of its bundles.
 */
export type AssetContent = "file_set" | "repository";

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
  /**
   * What a list shows of the asset beside its name, by the kind's own keys, such as the
   * connector type of a Connection. Nothing of it is secret and nothing of it decides a right.
   */
  attributes?: Readonly<Record<string, string | boolean>>;
}

export interface AssetKindDefinition<Definition, Kind extends string = string> {
  /** The id, such as `agent` or `knowledge_base`. */
  kind: Kind;
  /** The collection name, such as `agents`. Unique among the registered kinds. */
  plural: string;
  schema: AssetKindSchema<Definition>;
  nameRule: AssetNameRule;
  actions: AssetKindActions;
  /** `active` when left out. */
  lifecycle?: AssetLifecycle;
  /** `config` when left out. */
  representation?: AssetRepresentation;
  /** The file of a `files` kind that holds its manifest, such as `app.yaml`. */
  manifestFile?: string;
  /** How a `files` kind keeps the files of a revision. `file_set` when left out. */
  content?: AssetContent;
  /** Who may own an asset of the kind. The instance alone when left out. */
  owners?: readonly AssetScope["kind"][];
  /**
   * A draft of the kind calls operations, as an App's actions and a Workflow's steps do, and
   * a changing call of it is simulated unless "Run live once" is switched on (ADR-0031).
   * Only a `draft_published` kind has such a draft.
   */
  draftCalls?: true;
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
  /**
   * What a list shows of a definition. A kind whose names and descriptions hold several
   * languages answers them in `locale`, and in the instance's default without one.
   */
  summarize(definition: Definition, locale?: LocaleCode): AssetSummary;
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
  readonly lifecycle: AssetLifecycle;
  readonly representation: AssetRepresentation;
  /** Set for a `files` kind alone. */
  readonly content?: AssetContent;
  readonly manifestFile?: string;
  readonly owners: readonly AssetScope["kind"][];
  /** Whether a draft of the kind calls operations, which "Run live once" switches live. */
  readonly draftCalls: boolean;
  /** Reads definitions: the schema first, then the name rule. The checks follow on the reading. */
  read(definitions: readonly unknown[]): AssetKindReading;
  /** Throws `VALIDATION_FAILED` for a definition the schema refuses. */
  summarize(definition: unknown, locale?: LocaleCode): AssetSummary;
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
  const lifecycle = definition.lifecycle ?? "active";
  const representation = definition.representation ?? "config";
  if (lifecycle === "draft_published" && definition.actions.publish === undefined) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Asset kind '${definition.kind}' has a published revision and names no publish action`
    );
  }
  if (representation === "files" && definition.manifestFile === undefined) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Asset kind '${definition.kind}' holds files and names no manifest file`
    );
  }
  if (definition.draftCalls && lifecycle !== "draft_published") {
    throw new AppError(
      "VALIDATION_FAILED",
      `Asset kind '${definition.kind}' calls operations from a draft and has no draft`
    );
  }
  if (definition.content !== undefined && representation !== "files") {
    throw new AppError(
      "VALIDATION_FAILED",
      `Asset kind '${definition.kind}' names how its files are kept and holds no files`
    );
  }
  const nameRule = Object.freeze({ ...definition.nameRule });
  return Object.freeze({
    kind: definition.kind,
    plural: definition.plural,
    nameRule,
    actions: Object.freeze({ ...definition.actions }),
    lifecycle,
    representation,
    ...(definition.manifestFile === undefined ? {} : { manifestFile: definition.manifestFile }),
    ...(representation === "files" ? { content: definition.content ?? "file_set" } : {}),
    owners: Object.freeze([...(definition.owners ?? ["instance"])]),
    draftCalls: definition.draftCalls === true,
    read(inputs: readonly unknown[]): AssetKindReading {
      const accepted: Definition[] = [];
      const refused: RefusedAssetDefinition[] = [];
      for (const [index, input] of inputs.entries()) {
        // Asked before the schema, which lets through what it does not name.
        const unstorable = unstorableTextIssues(input);
        if (unstorable.length > 0) {
          refused.push({ index, issues: unstorable });
          continue;
        }
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
    summarize(input: unknown, locale?: LocaleCode) {
      const parsed = definition.schema.safeParse(input);
      if (!parsed.success) {
        throw new AppError("VALIDATION_FAILED", `The ${definition.kind} definition is invalid`, {
          issues: parsed.error.issues.map(({ message, path }) => ({
            message,
            path: path?.map(String)
          }))
        });
      }
      return definition.summarize(parsed.data, locale);
    }
  });
}

function readName(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || !("name" in input)) {
    return undefined;
  }
  return typeof input.name === "string" ? input.name : undefined;
}

/**
 * The revision of an asset its users are served: the active one of an `active` kind, the
 * published one of a `draft_published` kind, and nothing before the first publish. Every
 * reader that serves an asset's content to its users asks here, so none of them returns a
 * draft.
 */
export function liveRevisionId(
  asset: { activeRevisionId: string; publishedRevisionId?: string },
  kind: Pick<RegisteredAssetKind, "lifecycle">
): string | undefined {
  return kind.lifecycle === "draft_published" ? asset.publishedRevisionId : asset.activeRevisionId;
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
    // A kind that checks who makes a revision live needs one moment at which a revision goes
    // live: a publish. A kind without a draft goes live with every put, file write and sync,
    // which ask nothing, so its check would hold for a revert alone.
    if (
      "authorizeLive" in kind &&
      kind.authorizeLive !== undefined &&
      kind.lifecycle !== "draft_published"
    ) {
      throw new AppError(
        "VALIDATION_FAILED",
        `Asset kind '${kind.kind}' checks who makes a revision live and has no published revision: only a kind with the lifecycle 'draft_published' may set 'authorizeLive'`
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
