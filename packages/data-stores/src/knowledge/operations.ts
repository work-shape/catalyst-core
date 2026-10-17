import {
  isAppError,
  KNOWLEDGE_BASE_ACTIONS,
  KNOWLEDGE_BASE_ASSET_KIND,
  KNOWLEDGE_BASE_STATUSES,
  KNOWLEDGE_OPERATION_PREFIX,
  KNOWLEDGE_QUERY_TOOL_NAME,
  knowledgeQueryOperationName,
  type ConfigAssetRecord,
  type DataToolDescriptor,
  type DataToolSource,
  type JsonObject,
  type KnowledgeBaseState,
  type OperationDefinition,
  type OperationResource,
  type OperationSource
} from "@work-shape/catalyst-core";
import {
  POSTGRES_RESULT_MAX_BYTES,
  POSTGRES_RESULT_MAX_ROWS,
  POSTGRES_STATEMENT_TIMEOUT_MS
} from "@work-shape/catalyst-postgres-connector";
import { z } from "zod";
import { queryInputSchema, rowsSchema, RUN_TIMEOUT_MS } from "../operations";
import {
  knowledgeBaseDefinitionSchema,
  knowledgeTargetOf,
  type DataStoreKnowledgeDefinition,
  type KnowledgeBaseDefinition
} from "./definition";
import { removeDocumentsOperation } from "./removal";
import { addFilesOperation } from "./add-files";
import { listDocumentsOperation, retryDocumentsOperation } from "./document-operations";
import { checkKnowledgeBase, type KnowledgeRuntime } from "./runtime";

// The operations of one Knowledge Base, `knowledge.<id>.<part>`, each called through
// `runOperation` like every other operation, and the one agent tool over all of an agent's.
// `query` answers from the published revision with the asker as actor, who needs
// `knowledge_base.use` and no right on the backend. `state` and `check` serve its page.

/** The module the operations belong to. */
const KNOWLEDGE_MODULE = "knowledge";

/** How long the read of a Knowledge Base's state may take. It reads no backend. */
const KNOWLEDGE_STATE_TIMEOUT_MS = 10_000;

/**
 * How long a failed query waits before it checks the Knowledge Base again, in milliseconds. A
 * table that a migration dropped then shows as needing attention on its page, and a busy
 * agent that keeps failing does not check its backend on every call.
 */
const KNOWLEDGE_CHECK_MIN_INTERVAL_MS = 600_000;

/** How many Knowledge Bases one listing of operations reads. More is reported as truncated. */
const KNOWLEDGE_LIST_MAX_COUNT = 1_000;

/** The SQLSTATEs of a query that may mean a described table is gone or no longer readable. */
const MISSING_RELATION_STATES = new Set(["42P01", "42501"]);

/** What a query answers: the rows, and the Knowledge Base and its tables as their source. */
const queryOutputSchema = rowsSchema.extend({
  source: z.object({
    knowledgeBase: z.string(),
    title: z.string(),
    tables: z.array(z.string())
  })
});

const tableCheckSchema = z.object({ name: z.string(), readable: z.boolean() });

/** The state of one Knowledge Base as its page reads it. */
const stateOutputSchema = z.object({
  /** The id of the Knowledge Base's asset. */
  id: z.string(),
  name: z.string(),
  /** `unchecked` until the first check of the published revision. */
  status: z.enum(KNOWLEDGE_BASE_STATUSES),
  /** The revision the last check was of. */
  revision: z.number().int().optional(),
  checkedAt: z.string().optional(),
  tables: z.array(tableCheckSchema),
  problem: z.string().optional()
});

type StateOutput = z.infer<typeof stateOutputSchema>;

/** A Knowledge Base as its operations read it: its published definition and its asset. */
interface PublishedKnowledgeBase<
  Definition extends KnowledgeBaseDefinition = KnowledgeBaseDefinition
> {
  asset: ConfigAssetRecord;
  revision: number;
  definition: Definition;
  resource: OperationResource;
}

/** A published Knowledge Base on a Data Store, which answers `structured` over its tables. */
type StructuredKnowledgeBase = PublishedKnowledgeBase<DataStoreKnowledgeDefinition>;

function isStructured(
  knowledgeBase: PublishedKnowledgeBase
): knowledgeBase is StructuredKnowledgeBase {
  return "backend" in knowledgeBase.definition;
}

function publishedKnowledgeBase(asset: ConfigAssetRecord): PublishedKnowledgeBase | undefined {
  const definition = knowledgeBaseDefinitionSchema.safeParse(asset.publishedConfig);
  if (asset.status !== "active" || !definition.success || asset.publishedRevision === undefined) {
    return undefined;
  }
  return {
    asset,
    revision: asset.publishedRevision,
    definition: definition.data,
    resource: {
      kind: KNOWLEDGE_BASE_ASSET_KIND,
      id: asset.id,
      assetId: asset.id,
      name: asset.name,
      ...(asset.scope.kind === "workspace" ? { workspaceId: asset.scope.workspaceId } : {})
    }
  };
}

async function readKnowledgeBase(
  runtime: KnowledgeRuntime,
  name: string
): Promise<PublishedKnowledgeBase | undefined> {
  const asset = await runtime.stores.configAssets.getConfigAsset({
    clientInstanceId: runtime.clientInstanceId,
    kind: KNOWLEDGE_BASE_ASSET_KIND,
    name
  });
  return asset && publishedKnowledgeBase(asset);
}

/** The Knowledge Base and the last part of a name of the form `knowledge.<id>.<part>`. */
function splitOperationName(name: string): { knowledgeBase: string; part: string } | undefined {
  if (!name.startsWith(KNOWLEDGE_OPERATION_PREFIX)) return undefined;
  const [knowledgeBase, part, ...rest] = name.slice(KNOWLEDGE_OPERATION_PREFIX.length).split(".");
  return knowledgeBase && part && rest.length === 0 ? { knowledgeBase, part } : undefined;
}

function stateOf(
  { asset }: PublishedKnowledgeBase,
  state: KnowledgeBaseState | undefined
): StateOutput {
  return {
    id: asset.id,
    name: asset.name,
    ...(state
      ? {
          status: state.status,
          revision: state.revision,
          checkedAt: state.checkedAt,
          tables: state.tables,
          ...(state.problem === undefined ? {} : { problem: state.problem })
        }
      : { status: "unchecked", tables: [] })
  };
}

/**
 * Checks the published revision again where a query failed as if a described table were gone,
 * at most once per `KNOWLEDGE_CHECK_MIN_INTERVAL_MS`. A failure of the check itself is logged
 * and leaves the query's own failure to its caller.
 */
async function checkAfterFailure(
  runtime: KnowledgeRuntime,
  knowledgeBase: PublishedKnowledgeBase,
  error: unknown
): Promise<void> {
  const sqlState =
    isAppError(error) && typeof error.details === "object" && error.details !== null
      ? Object.entries(error.details).find(([key]) => key === "sqlState")?.[1]
      : undefined;
  if (typeof sqlState !== "string" || !MISSING_RELATION_STATES.has(sqlState)) return;
  const { clientInstanceId, stores } = runtime;
  const last = await stores.knowledgeBases.getKnowledgeBaseState({
    clientInstanceId,
    assetId: knowledgeBase.asset.id
  });
  const due =
    !last ||
    runtime.now().getTime() - Date.parse(last.checkedAt) >= KNOWLEDGE_CHECK_MIN_INTERVAL_MS;
  if (!due) return;
  try {
    await checkKnowledgeBase(runtime, stores, {
      assetId: knowledgeBase.asset.id,
      revision: knowledgeBase.revision,
      definition: knowledgeBase.definition
    });
  } catch (checkError) {
    runtime.logger.warn(
      {
        type: "knowledge_base.check_failed",
        knowledgeBase: knowledgeBase.asset.name,
        errorName: checkError instanceof Error ? checkError.name : "unknown"
      },
      "A Knowledge Base could not be checked after a failed query"
    );
  }
}

function queryOperation(
  runtime: KnowledgeRuntime,
  knowledgeBase: StructuredKnowledgeBase
): OperationDefinition {
  const { definition } = knowledgeBase;
  return {
    name: knowledgeQueryOperationName(definition.name),
    effect: "reading",
    // A read of a customer's rows is recorded, every time.
    recordsEveryCall: true,
    action: KNOWLEDGE_BASE_ACTIONS.use,
    scope: "data_store_rows:read",
    auth: "principal",
    inputSchema: queryInputSchema,
    outputSchema: queryOutputSchema,
    resource: () => knowledgeBase.resource,
    module: KNOWLEDGE_MODULE,
    timeoutMs: RUN_TIMEOUT_MS,
    async execute(input, context) {
      const statement = queryInputSchema.parse(input);
      try {
        const rows = await runtime.backend.query(
          knowledgeTargetOf(definition, knowledgeBase.asset.id),
          statement,
          context.runtime.signal
        );
        return {
          ...rows,
          source: {
            knowledgeBase: definition.name,
            title: definition.title,
            tables: definition.tables.map((table) => table.name)
          }
        };
      } catch (error) {
        await checkAfterFailure(runtime, knowledgeBase, error);
        throw error;
      }
    }
  };
}

function stateOperation(
  runtime: KnowledgeRuntime,
  knowledgeBase: PublishedKnowledgeBase
): OperationDefinition {
  return {
    name: `${KNOWLEDGE_OPERATION_PREFIX}${knowledgeBase.definition.name}.state`,
    effect: "reading",
    action: KNOWLEDGE_BASE_ACTIONS.read,
    scope: "config_assets:read",
    auth: "principal",
    inputSchema: z.strictObject({}),
    outputSchema: stateOutputSchema,
    resource: () => knowledgeBase.resource,
    module: KNOWLEDGE_MODULE,
    timeoutMs: KNOWLEDGE_STATE_TIMEOUT_MS,
    async execute() {
      return stateOf(
        knowledgeBase,
        await runtime.stores.knowledgeBases.getKnowledgeBaseState({
          clientInstanceId: runtime.clientInstanceId,
          assetId: knowledgeBase.asset.id
        })
      );
    }
  };
}

/**
 * Checks the published revision now and keeps what it found. It reads the catalog and no row.
 * Where every table can be read, the Knowledge Base's access is set again to exactly those
 * tables: a grant to its role that a store's migration added by hand is taken back.
 */
function checkOperation(
  runtime: KnowledgeRuntime,
  knowledgeBase: PublishedKnowledgeBase
): OperationDefinition {
  return {
    name: `${KNOWLEDGE_OPERATION_PREFIX}${knowledgeBase.definition.name}.check`,
    effect: "changing",
    // What it writes is the result of the check, which the next check replaces.
    changeClass: "reversible",
    action: KNOWLEDGE_BASE_ACTIONS.write,
    scope: "config_assets:write",
    auth: "principal",
    inputSchema: z.strictObject({}),
    outputSchema: stateOutputSchema,
    resource: () => knowledgeBase.resource,
    module: KNOWLEDGE_MODULE,
    timeoutMs: RUN_TIMEOUT_MS,
    async execute(_input, context) {
      const { signal } = context.runtime;
      const { asset, definition } = knowledgeBase;
      const state = await checkKnowledgeBase(
        runtime,
        runtime.stores,
        { assetId: asset.id, revision: knowledgeBase.revision, definition },
        signal
      );
      if (state.status === "ok") {
        await runtime.backend.grant(
          runtime.stores,
          knowledgeTargetOf(definition, asset.id),
          signal
        );
      }
      return stateOf(knowledgeBase, state);
    }
  };
}

/**
 * The operations of one Knowledge Base by the last part of their names. `query` is answered
 * only on a Data Store; `add_files`, `list_documents` and `retry` only by a Knowledge Base that
 * keeps documents, whose search arrives with KB-7.
 */
const OPERATIONS = {
  query: (runtime: KnowledgeRuntime, knowledgeBase: PublishedKnowledgeBase) =>
    isStructured(knowledgeBase) ? queryOperation(runtime, knowledgeBase) : undefined,
  add_files: (runtime: KnowledgeRuntime, knowledgeBase: PublishedKnowledgeBase) =>
    isStructured(knowledgeBase)
      ? undefined
      : addFilesOperation(runtime, {
          name: knowledgeBase.definition.name,
          assetId: knowledgeBase.asset.id,
          definition: knowledgeBase.definition,
          resource: knowledgeBase.resource
        }),
  list_documents: (runtime: KnowledgeRuntime, knowledgeBase: PublishedKnowledgeBase) => {
    const target = documentsTargetOf(runtime, knowledgeBase);
    return target && listDocumentsOperation(runtime, target);
  },
  retry: (runtime: KnowledgeRuntime, knowledgeBase: PublishedKnowledgeBase) => {
    // Without files the process indexes nothing, so it offers no retry.
    const { files } = runtime;
    const target = documentsTargetOf(runtime, knowledgeBase);
    return files && target && retryDocumentsOperation(runtime, files, target);
  },
  remove_documents: (runtime: KnowledgeRuntime, knowledgeBase: PublishedKnowledgeBase) => {
    const target = documentsTargetOf(runtime, knowledgeBase);
    return runtime.files && target && removeDocumentsOperation(runtime, target);
  },
  state: stateOperation,
  check: checkOperation
} as const;

/** A Knowledge Base that keeps documents, with the store its documents are in. */
function documentsTargetOf(runtime: KnowledgeRuntime, knowledgeBase: PublishedKnowledgeBase) {
  if (isStructured(knowledgeBase)) return undefined;
  const store = runtime.backend.documentStore(
    knowledgeTargetOf(knowledgeBase.definition, knowledgeBase.asset.id)
  );
  return (
    store && {
      name: knowledgeBase.definition.name,
      assetId: knowledgeBase.asset.id,
      resource: knowledgeBase.resource,
      store
    }
  );
}

/** The name of the operation of one part of one Knowledge Base, such as `knowledge.<id>.state`. */
export function knowledgeOperationName(
  knowledgeBase: string,
  part: keyof typeof OPERATIONS
): string {
  return `${KNOWLEDGE_OPERATION_PREFIX}${knowledgeBase}.${part}`;
}

/**
 * The source of every Knowledge Base's operations. `resolve` reads the one a name stands for;
 * `list` names the query of each published one, which a Workflow step may call.
 */
export function createKnowledgeOperationSource(runtime: KnowledgeRuntime): OperationSource {
  return {
    async resolve(name) {
      const split = splitOperationName(name);
      const build = split && Object.entries(OPERATIONS).find(([part]) => part === split.part)?.[1];
      if (!split || !build) return undefined;
      const knowledgeBase = await readKnowledgeBase(runtime, split.knowledgeBase);
      return knowledgeBase && build(runtime, knowledgeBase);
    },
    async list(scope) {
      const assets = await runtime.stores.configAssets.listPublishedConfigAssets({
        clientInstanceId: runtime.clientInstanceId,
        kind: KNOWLEDGE_BASE_ASSET_KIND,
        limit: KNOWLEDGE_LIST_MAX_COUNT + 1
      });
      return {
        operations: assets
          .slice(0, KNOWLEDGE_LIST_MAX_COUNT)
          .flatMap((asset) => publishedKnowledgeBase(asset) ?? [])
          .filter(isStructured)
          .filter(
            ({ resource }) =>
              scope.workspaceId === undefined ||
              resource.workspaceId === undefined ||
              resource.workspaceId === scope.workspaceId
          )
          .map((knowledgeBase) => queryOperation(runtime, knowledgeBase)),
        truncated:
          assets.length > KNOWLEDGE_LIST_MAX_COUNT
            ? [
                {
                  prefix: KNOWLEDGE_OPERATION_PREFIX,
                  limit: KNOWLEDGE_LIST_MAX_COUNT,
                  limitName: "KNOWLEDGE_LIST_MAX_COUNT"
                }
              ]
            : []
      };
    }
  };
}

/** What an agent reads of one Knowledge Base: what it holds and each table with its sentence. */
function knowledgeBaseSection({ definition }: StructuredKnowledgeBase): string {
  return [
    `- ${definition.name} ("${definition.title}"): ${definition.description}`,
    ...definition.tables.map((table) => `  - table ${table.name}: ${table.description}`)
  ].join("\n");
}

/** What the agent is told of the one tool: when to use it and how. */
const KNOWLEDGE_QUERY_TOOL_USE = [
  "Answers questions from the Knowledge Bases assigned to you. Each describes tables of a database; you read their rows with one read-only SQL statement per call.",
  "Use it whenever a question is about what one of them holds, before you answer from what you know yourself, and answer from the rows it returns.",
  'Name the Knowledge Base under "knowledgeBase" by its id. Send one SELECT or WITH statement in PostgreSQL syntax under "sql". Put every value into "parameters" and refer to it as $1, $2 and so on; never write a value into the SQL.',
  'The tables are in the schema "public". Their descriptions below say what a row is. Read the exact columns and types with the same tool before you rely on them, for example: select column_name, data_type from information_schema.columns where table_name = $1.',
  `At most ${POSTGRES_RESULT_MAX_ROWS} rows and ${POSTGRES_RESULT_MAX_BYTES} bytes come back, and "truncated" says when there were more: narrow the statement, aggregate, or page with LIMIT and OFFSET. A statement that runs longer than ${POSTGRES_STATEMENT_TIMEOUT_MS / 1000} seconds is cancelled.`,
  'The answer names its "source": the Knowledge Base and its tables. Say in your reply which Knowledge Base and which tables your answer comes from.',
  "",
  "Your Knowledge Bases:"
].join("\n");

const queryInputJsonSchema: JsonObject = z
  .record(z.string(), z.json())
  .parse(z.toJSONSchema(queryInputSchema, { target: "draft-07", io: "input" }));

/** The input of the one tool: the input of a query and the Knowledge Base it goes to. */
function knowledgeToolInputJsonSchema(knowledgeBases: readonly string[]): JsonObject {
  const properties = z.record(z.string(), z.json()).parse(queryInputJsonSchema.properties ?? {});
  return {
    type: "object",
    properties: {
      knowledgeBase: {
        type: "string",
        enum: [...knowledgeBases],
        description: "The id of the Knowledge Base to read."
      },
      ...properties
    },
    required: ["knowledgeBase", "sql"],
    additionalProperties: false
  };
}

/**
 * What an agent's tool list reads of Knowledge Bases. Asked for the operations of the ones the
 * agent lists, it describes each that is published, and the one tool `knowledge.query` over
 * all of those. The agent is offered that tool alone; the operations are what its calls are.
 * Only text of the definitions reaches the description, nothing read from a database.
 */
export function createKnowledgeToolSource(runtime: KnowledgeRuntime): DataToolSource {
  return {
    async describe(toolNames) {
      const wanted = [
        ...new Set(
          toolNames.flatMap((name) => {
            const split = splitOperationName(name);
            return split?.part === "query" ? [split.knowledgeBase] : [];
          })
        )
      ];
      if (wanted.length === 0) return [];
      const assets = await runtime.stores.configAssets.listPublishedConfigAssets({
        clientInstanceId: runtime.clientInstanceId,
        kind: KNOWLEDGE_BASE_ASSET_KIND,
        names: wanted,
        limit: wanted.length
      });
      // A Knowledge Base that keeps documents has no tables to query: search arrives with KB-7.
      const published = wanted.flatMap((name) => {
        const asset = assets.find((candidate) => candidate.name === name);
        const knowledgeBase = asset && publishedKnowledgeBase(asset);
        return knowledgeBase && isStructured(knowledgeBase) ? [knowledgeBase] : [];
      });
      if (published.length === 0) return [];
      const each = published.map((knowledgeBase): DataToolDescriptor => ({
        name: knowledgeQueryOperationName(knowledgeBase.definition.name),
        effect: "reading",
        description: knowledgeBaseSection(knowledgeBase),
        inputJsonSchema: queryInputJsonSchema
      }));
      return [
        ...each,
        {
          name: KNOWLEDGE_QUERY_TOOL_NAME,
          effect: "reading",
          description: [KNOWLEDGE_QUERY_TOOL_USE, ...each.map((tool) => tool.description)].join(
            "\n"
          ),
          inputJsonSchema: knowledgeToolInputJsonSchema(
            published.map((knowledgeBase) => knowledgeBase.definition.name)
          )
        }
      ];
    }
  };
}
