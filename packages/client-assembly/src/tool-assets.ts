import {
  ASSET_OWNER_KINDS,
  AppError,
  TOOL_ACTIONS,
  TOOL_ASSET_KIND,
  TOOL_NAME_MAX_LENGTH,
  TOOL_NAME_PATTERN,
  TOOL_NAME_RULE,
  TOOL_RESULT_DEFAULT_REPLY,
  defineAssetKind,
  isJsonObject,
  liveRevisionId,
  answerAsTool,
  personalDataConversation,
  registerOperationStopResult,
  toolAssetConfigSchema,
  toolCallOperationName,
  toolCodeTimeoutSeconds,
  toolNameSchema,
  toolOfOperationName,
  unknownToJsonValue,
  type AgentRunId,
  type ClientInstanceId,
  type ConfigAssetRecord,
  type ConversationId,
  type OperationExecutionContext,
  type ConfigAssetStore,
  type DataToolDescriptor,
  type DataToolSource,
  type JsonObject,
  type LocaleCode,
  type OperationDefinition,
  type OperationResolutionStores,
  type OperationResource,
  type OperationSource,
  type CodeToolConfig,
  type ResultToolConfig,
  type ToolAssetConfig
} from "@work-shape/catalyst-core";
import {
  outsideJsonSchemaAsZod,
  outsideSchemaChecker,
  type OutsideSchemaChecker
} from "@work-shape/catalyst-connections";
import { resolveLocalizedString } from "@work-shape/catalyst-config-schema";
import { workflowAssetKindOf, type WorkflowAssetKind } from "@work-shape/catalyst-server";
import { z } from "zod";
import type { ModuleSeam } from "./module-assembly";
import {
  TOOL_CODE_START_GRACE_MS,
  createToolCodeCallClient,
  toolCodeCallAnswer,
  type ToolCodeCallClient
} from "./tool-code-calls";

// Tools an instance adds without a release (TOOL-1, platform-access.md, section 3a). A tool
// of type `result` holds no code: it checks the agent's input against the declared JSON Schema
// and writes it as the conversation's structured result. A tool of type `code` runs a handler
// of its own files in the sandbox of Workflow code steps, on the command worker
// (`tool-code-calls.ts`), and answers with what the handler answered. A published tool
// contributes one operation, `tool.<name>.call`, which an agent lists like a Connection's.
// Nothing of it reaches outside the conversation it is called in: a handler has no network.

/** How long one call of a `result` tool may run, in milliseconds: one schema check in a thread. */
const TOOL_CALL_TIMEOUT_MS = 15_000;

/** How many published tools one listing of the instance's operations reads at most. */
const TOOL_LIST_MAX = 500;

/** What a call answers the agent: no value of its input. */
const toolCallOutputSchema = z.object({
  key: z.string(),
  kind: z.string(),
  schemaVersion: z.number(),
  message: z.string()
});

/** A value as a JSON object, or an empty object where it is none. */
function jsonObjectOf(value: unknown): JsonObject {
  const json = unknownToJsonValue(value);
  return isJsonObject(json) ? json : {};
}

function parseTool(config: unknown): ToolAssetConfig | undefined {
  const parsed = toolAssetConfigSchema.safeParse(config);
  return parsed.success ? parsed.data : undefined;
}

/** A published tool: its definition as published, and the revision a waiting call is pinned to. */
interface PublishedTool {
  asset: ConfigAssetRecord;
  config: ToolAssetConfig;
  revisionId: string;
}

function publishedTool(asset: ConfigAssetRecord | undefined): PublishedTool | undefined {
  if (!asset || asset.status !== "active" || !asset.publishedConfig) return undefined;
  const revisionId = liveRevisionId(asset, { lifecycle: "draft_published" });
  const config = parseTool(asset.publishedConfig);
  return revisionId !== undefined && config ? { asset, config, revisionId } : undefined;
}

function toolResource(asset: ConfigAssetRecord, title: string): OperationResource {
  return {
    kind: TOOL_ASSET_KIND,
    id: asset.id,
    name: asset.name,
    title,
    ...(asset.scope.kind === "workspace" ? { workspaceId: asset.scope.workspaceId } : {})
  };
}

/** The text in English, or the other language where English is missing. */
function textOf(value: ToolAssetConfig["title"], locale: LocaleCode = "en"): string {
  return resolveLocalizedString(value, locale, "en") ?? "";
}

/** The schema check of the tool's input, in the checker's thread. */
function inputSchemaOf(
  config: ToolAssetConfig,
  checker: OutsideSchemaChecker,
  warn: (reason: string | undefined) => void
): z.ZodType {
  return outsideJsonSchemaAsZod(jsonObjectOf(config.input), checker, warn);
}

/** What a call of a published tool needs beside its definition. */
interface ToolCallPorts {
  checker: OutsideSchemaChecker;
  warn: (tool: string, reason: string | undefined) => void;
  /** Where the handler of a code tool runs. Missing where this process runs none. */
  codeCalls?: ToolCodeCallClient;
  /** Whether a conversation holds personal data: an HTML display then runs no script. */
  personalConversation?(conversationId: ConversationId, runId: AgentRunId): Promise<boolean>;
}

/** What a `result` tool's call writes: the agent's input as the result of its display kind. */
function resultCall(config: ResultToolConfig, input: unknown) {
  const key = config.result.key ?? config.name;
  const schemaVersion = config.result.schemaVersion ?? 1;
  return answerAsTool({
    status: "success",
    output: {
      key,
      kind: config.result.kind,
      schemaVersion,
      message: config.result.reply ?? TOOL_RESULT_DEFAULT_REPLY
    },
    structuredResult: {
      key,
      kind: config.result.kind,
      schemaVersion,
      title: config.result.title,
      data: jsonObjectOf(input)
    }
  });
}

/** A `code` tool's call: its handler run on the command worker, waited for here. */
async function codeCall(
  tool: PublishedTool & { config: CodeToolConfig },
  input: unknown,
  context: OperationExecutionContext,
  origin: Extract<OperationExecutionContext["origin"], { kind: "agent" }>,
  ports: ToolCallPorts
) {
  const { config, revisionId, asset } = tool;
  const timeoutSeconds = toolCodeTimeoutSeconds(config);
  if (!ports.codeCalls) {
    return answerAsTool({
      status: "failed",
      error: {
        code: "handler_failed",
        message: "This process runs no code tools.",
        details: { reason: "no_worker" }
      }
    });
  }
  const { signal, deadline } = context.runtime;
  const waiting = ports.codeCalls
    .run({
      clientInstanceId: asset.clientInstanceId,
      conversationId: origin.conversationId,
      tool: config.name,
      revisionId,
      input: jsonObjectOf(input),
      timeoutSeconds,
      correlationId: context.correlationId,
      ...(deadline ? { deadline } : {}),
      ...(signal ? { signal } : {})
    })
    .then(async (result) =>
      toolCodeCallAnswer({
        tool: config.name,
        timeoutSeconds,
        result,
        // Unknown counts as personal, as for `show_view`.
        personal:
          result.status === "ended" &&
          ((await ports.personalConversation?.(origin.conversationId, origin.agentRunId)) ?? true)
      })
    );
  // An executor that stops the call at its deadline answers with this wait's own result.
  registerOperationStopResult(
    signal,
    waiting.then((result) => (result.status === "success" ? undefined : result))
  );
  return answerAsTool(await waiting);
}

/** The operation of one published tool. */
function definitionOf(tool: PublishedTool, ports: ToolCallPorts): OperationDefinition {
  const { asset, config, revisionId } = tool;
  const resource = toolResource(asset, textOf(config.title));
  return {
    name: toolCallOperationName(config.name),
    title: textOf(config.title),
    description: config.description,
    // It replaces the conversation's result or shows a display. The platform starts it at
    // `allow`, as `structured_data.publish`: it writes only into the caller's own
    // conversation, and a code tool's handler reaches nothing outside its sandbox.
    effect: "changing",
    changeClass: "reversible",
    defaultPolicy: "allow",
    // A draft agent's Try conversation is its own test target: the call writes only there.
    draftTarget: "test",
    scope: null,
    auth: "principal",
    action: null,
    authorize: (_input, context) => {
      // It needs a conversation: an App, a Workflow step and an outside client have none.
      if (context.origin.kind !== "agent") {
        return { allowed: false, action: "tool.call_from_agent", reason: "no_grant" };
      }
      return { allowed: true };
    },
    inputSchema: inputSchemaOf(config, ports.checker, (reason) => ports.warn(config.name, reason)),
    outputSchema: config.type === "result" ? toolCallOutputSchema : z.unknown(),
    inputJsonSchema: jsonObjectOf(config.input),
    resource: () => resource,
    timeoutMs:
      config.type === "result"
        ? TOOL_CALL_TIMEOUT_MS
        : toolCodeTimeoutSeconds(config) * 1_000 + 2 * TOOL_CODE_START_GRACE_MS,
    async execute(input, context) {
      const origin = context.origin;
      if (origin.kind !== "agent") {
        throw new AppError("FORBIDDEN", "A tool is called by an agent in a conversation");
      }
      // A call that waited for a confirmation runs only while its revision is still published.
      if (origin.toolRevisionId !== undefined && origin.toolRevisionId !== revisionId) {
        throw new AppError(
          "CONFLICT",
          "The tool was published again after this call was made, so nothing was written. Call it again.",
          { reason: "tool_revision_changed" },
          { exposeMessage: true }
        );
      }
      return config.type === "result"
        ? resultCall(config, input)
        : codeCall({ ...tool, config }, input, context, origin, ports);
    }
  };
}

interface ToolSourceDeps {
  clientInstanceId: ClientInstanceId;
  store: Pick<ConfigAssetStore, "getConfigAsset" | "listPublishedConfigAssets">;
  checker?: OutsideSchemaChecker;
  warn?(input: { tool: string; reason: string | undefined }): void;
  /** Where the handlers of code tools run. Without it a code tool's call fails. */
  codeCalls?: ToolCodeCallClient;
  personalConversation?(conversationId: ConversationId, runId: AgentRunId): Promise<boolean>;
}

/** The operations of every published tool. A draft is never read here. */
export function createToolOperationSource(deps: ToolSourceDeps): OperationSource {
  const ports: ToolCallPorts = {
    checker: deps.checker ?? outsideSchemaChecker(),
    warn: (tool, reason) => deps.warn?.({ tool, reason }),
    ...(deps.codeCalls ? { codeCalls: deps.codeCalls } : {}),
    ...(deps.personalConversation ? { personalConversation: deps.personalConversation } : {})
  };
  const read = async (name: string, stores?: OperationResolutionStores) =>
    publishedTool(
      await (stores?.configAssets ?? deps.store).getConfigAsset({
        clientInstanceId: deps.clientInstanceId,
        kind: TOOL_ASSET_KIND,
        name
      })
    );
  return {
    async resolve(name, stores) {
      const tool = toolOfOperationName(name);
      if (tool === undefined) return undefined;
      const published = await read(tool, stores);
      return published && definitionOf(published, ports);
    },
    async resolveMany(names, stores) {
      const wanted = [...new Set(names.flatMap((name) => toolOfOperationName(name) ?? []))];
      if (wanted.length === 0) return [];
      // Inside a caller's transaction its own readers are asked, one name at a time, so the
      // lookup borrows no second connection.
      if (stores) {
        const found = await Promise.all(wanted.map((tool) => read(tool, stores)));
        return found.flatMap((published) => (published ? [definitionOf(published, ports)] : []));
      }
      const assets = await deps.store.listPublishedConfigAssets({
        clientInstanceId: deps.clientInstanceId,
        kind: TOOL_ASSET_KIND,
        names: wanted,
        limit: wanted.length
      });
      return assets.flatMap((asset) => {
        const published = publishedTool(asset);
        return published ? [definitionOf(published, ports)] : [];
      });
    },
    async list() {
      const assets = await deps.store.listPublishedConfigAssets({
        clientInstanceId: deps.clientInstanceId,
        kind: TOOL_ASSET_KIND,
        limit: TOOL_LIST_MAX + 1
      });
      return {
        operations: assets.slice(0, TOOL_LIST_MAX).flatMap((asset) => {
          const published = publishedTool(asset);
          return published ? [definitionOf(published, ports)] : [];
        }),
        truncated:
          assets.length > TOOL_LIST_MAX
            ? [{ prefix: "tool.", limit: TOOL_LIST_MAX, limitName: "TOOL_LIST_MAX" }]
            : []
      };
    }
  };
}

/** The tools an agent lists that are published now, as the model is offered them. */
export function createToolAssetToolSource(deps: ToolSourceDeps): DataToolSource {
  return {
    async describe(toolNames) {
      const wanted = toolNames.flatMap((name) => {
        const tool = toolOfOperationName(name);
        return tool === undefined ? [] : [{ name, tool }];
      });
      if (wanted.length === 0) return [];
      const tools = [...new Set(wanted.map((entry) => entry.tool))];
      const published = new Map(
        (
          await deps.store.listPublishedConfigAssets({
            clientInstanceId: deps.clientInstanceId,
            kind: TOOL_ASSET_KIND,
            names: tools,
            limit: tools.length
          })
        ).flatMap((asset) => {
          const tool = publishedTool(asset);
          return tool ? [[asset.name, tool]] : [];
        })
      );
      return wanted.flatMap(({ name, tool }): DataToolDescriptor[] => {
        const found = published.get(tool);
        return found
          ? [
              {
                name,
                description: found.config.description,
                inputJsonSchema: jsonObjectOf(found.config.input),
                effect: "changing",
                revisionId: found.revisionId
              }
            ]
          : [];
      });
    }
  };
}

/**
 * The kind `tool`: a draft until a holder of `tool.publish` publishes it, owned by the instance
 * or by one workspace. Its input schema is compiled at every write in the thread that checks
 * schemas a builder wrote, so a schema that does not compile, or is over a bound, is refused
 * before it is stored.
 */
export function createToolAssetKind(
  options: { checker?: OutsideSchemaChecker; defaultLocale?: LocaleCode } = {}
): WorkflowAssetKind {
  const checker = () => options.checker ?? outsideSchemaChecker();
  return workflowAssetKindOf({
    ...defineAssetKind({
      kind: TOOL_ASSET_KIND,
      plural: "tools",
      schema: toolAssetConfigSchema,
      nameRule: {
        pattern: TOOL_NAME_PATTERN,
        maxLength: TOOL_NAME_MAX_LENGTH,
        description: TOOL_NAME_RULE,
        schema: toolNameSchema
      },
      actions: { ...TOOL_ACTIONS },
      lifecycle: "draft_published",
      owners: [...ASSET_OWNER_KINDS],
      // A tool names no other asset.
      validate: () => [],
      summarize: (tool: ToolAssetConfig, locale = options.defaultLocale ?? "en") => {
        const summary =
          tool.summary === undefined
            ? undefined
            : resolveLocalizedString(tool.summary, locale, "en");
        return {
          name: tool.name,
          title: textOf(tool.title, locale),
          ...(summary === undefined ? {} : { description: summary }),
          attributes: {
            type: tool.type,
            ...(tool.type === "result"
              ? { resultKind: tool.result.kind }
              : { runtime: tool.runtime }),
            ...(tool.icon === undefined ? {} : { icon: tool.icon })
          }
        };
      }
    }),
    async assertScopedWrite({ definition }) {
      const tool = parseTool(definition);
      if (!tool) return;
      const refusal = await checker().refusalOf(jsonObjectOf(tool.input));
      if (refusal !== undefined) {
        throw new AppError(
          "VALIDATION_FAILED",
          `The input schema of tool '${tool.name}' cannot be used: ${refusal}`,
          {
            reason: "tool_input_schema_unusable",
            issues: [{ message: `The input schema cannot be used: ${refusal}`, path: ["input"] }]
          }
        );
      }
    }
  });
}

/**
 * The seam of tool assets. They belong to no module: the kind is on in every instance, as
 * agents and skills are, because a tool asset reaches nothing a module would switch off.
 */
export const assembleToolAssets: ModuleSeam = (parts) => {
  const deps: ToolSourceDeps = {
    clientInstanceId: parts.clientInstanceId,
    store: parts.stores.configAssets,
    codeCalls: createToolCodeCallClient({ stores: parts.stores }),
    personalConversation: (conversationId, runId) =>
      personalDataConversation(parts.stores, parts.clientInstanceId, conversationId, runId),
    warn: ({ tool, reason }) =>
      parts.logger.warn(
        { tool, checked: "input", reason },
        "A check by the input schema of a tool asset gave no answer"
      )
  };
  return {
    assetKinds: [createToolAssetKind({ defaultLocale: parts.config.localization.defaultLocale })],
    operationSources: () => [createToolOperationSource(deps)],
    start: () => ({ dataToolSources: [createToolAssetToolSource(deps)] })
  };
};
