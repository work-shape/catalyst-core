import {
  ASSET_OWNER_KINDS,
  AppError,
  POLICY_VALUES,
  TOOL_ACTIONS,
  TOOL_ASSET_KIND,
  TOOL_NAME_MAX_LENGTH,
  TOOL_NAME_PATTERN,
  TOOL_NAME_RULE,
  TOOL_RESULT_DEFAULT_REPLY,
  connectionOperationName,
  defineAssetKind,
  getSubjectUserId,
  isAppError,
  isAuthenticatedServicePrincipal,
  isJsonObject,
  operationDenialError,
  parseConnectionOperationName,
  resolvePolicy,
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
  type AuthenticatedIdentity,
  type ClientInstanceId,
  type CollaborationWorkspaceId,
  type ConfigAssetRecord,
  type ConversationId,
  type OperationExecutionContext,
  type ConfigAssetStore,
  type DataToolDescriptor,
  type DataToolSource,
  type JsonObject,
  type LocaleCode,
  type OperationDefinition,
  type OperationOrigin,
  type OperationResult,
  type OperationResolutionStores,
  type OperationResource,
  type OperationSource,
  type CodeToolConfig,
  type PolicyValue,
  type ResultToolConfig,
  type ToolAssetConfig,
  type ToolCodeCallRequest,
  type ToolCodeCallRequestAnswer
} from "@work-shape/catalyst-core";
import { runOperation } from "@work-shape/catalyst-tool-execution";
import {
  outsideJsonSchemaAsZod,
  outsideSchemaChecker,
  type OutsideSchemaChecker
} from "@work-shape/catalyst-connections";
import { resolveLocalizedString } from "@work-shape/catalyst-config-schema";
import {
  workflowAssetKindOf,
  type OperationCalls,
  type WorkflowAssetKind
} from "@work-shape/catalyst-server";
import { z } from "zod";
import type { ModuleSeam } from "./module-assembly";
import {
  TOOL_CODE_END_GRACE_MS,
  toolCodeCallMaxWaitMs,
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
// A handler has no network. It reaches outside only through the Connection operations its tool
// declares (TOOL-2c): each request is carried out here, as the tool's caller, as its own
// Operation Run whose origin is the tool's call, and the policy of every declared operation is
// asked once, on the tool's call, before the handler starts.

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
  /**
   * The call path a handler's requests are carried out on, and whose policy the tool's call
   * asks for the operations it declares. Missing where this process has none: a handler's
   * request is then refused.
   */
  operations?(): Pick<OperationCalls, "registry" | "deps"> | undefined;
  /** What the policy asked of each declared operation where a tool's call was admitted. */
  admitted: AdmittedPolicies;
}

/**
 * What the policy asked of each Connection operation a code tool declares, as the call of the
 * tool was admitted, by the agent's run and tool call: the most a call its handler makes then
 * runs without asking anybody. The admission and the execution of one call are one process:
 * a call that waited is admitted again, there, before it executes. Read once; what is never
 * read goes after a while.
 */
class AdmittedPolicies {
  private readonly entries = new Map<
    string,
    { at: number; asked: ReadonlyMap<string, PolicyValue> }
  >();

  private static readonly KEEP_MS = 10 * 60 * 1_000;
  private static readonly MOST = 1_000;

  set(origin: OperationOrigin, asked: ReadonlyMap<string, PolicyValue>): void {
    if (origin.kind !== "agent") return;
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.at <= AdmittedPolicies.KEEP_MS && this.entries.size < AdmittedPolicies.MOST)
        break;
      this.entries.delete(key);
    }
    const key = AdmittedPolicies.keyOf(origin);
    this.entries.delete(key);
    this.entries.set(key, { at: now, asked });
  }

  take(origin: Extract<OperationOrigin, { kind: "agent" }>) {
    const key = AdmittedPolicies.keyOf(origin);
    const entry = this.entries.get(key);
    this.entries.delete(key);
    return entry?.asked;
  }

  private static keyOf(origin: Extract<OperationOrigin, { kind: "agent" }>): string {
    return `${origin.agentRunId}\u0000${origin.toolCallId}`;
  }
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
  // The most each declared operation's calls run without asking anybody: what the policy asked
  // of it as the tool's call was admitted, and no more than it asks as the handler starts. An
  // operation the admission did not ask about runs only where the policy allows it.
  const operations = ports.operations?.();
  const admitted = ports.admitted.take(origin);
  const asked = new Map<string, PolicyValue>();
  if (operations && (config.connections ?? []).length > 0) {
    const now = await declaredPolicies(config.connections ?? [], operations, {
      origin,
      actor: context.actor,
      ...(context.workspaceId === undefined ? {} : { workspaceId: context.workspaceId })
    });
    for (const [name, value] of now) {
      asked.set(name, looserPolicy(value, admitted?.get(name) ?? "allow"));
    }
  }
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
      ...(signal ? { signal } : {}),
      onRequest: (request) => connectionRequest(config, request, context, origin, asked, ports)
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

function refused(code: string, message: string): ToolCodeCallRequestAnswer {
  return { ok: false, error: { code, message } };
}

/** What a handler is answered of the run of its request. */
function requestAnswerOf(result: OperationResult): ToolCodeCallRequestAnswer {
  switch (result.status) {
    case "done":
      return { ok: true, output: unknownToJsonValue(result.output) };
    case "dry_run":
      // A changing call of a draft that went to no test target: nothing was changed.
      return { ok: true, output: unknownToJsonValue(result.output ?? null), simulated: true };
    case "failed":
      return refused(result.error.code, result.error.message);
    case "denied": {
      // The policy asks more of the call than it asked when the handler started.
      if (result.reason.kind === "policy" && result.reason.reason === "confirmation_required") {
        return refused(
          "connection_call_waits",
          "The Connection call would need somebody's confirmation or approval, and was not made."
        );
      }
      const error = operationDenialError(result.reason);
      return refused(error.code.toLowerCase(), error.message);
    }
    case "pending_confirmation":
    case "pending_approval":
    case "expired":
    case "running":
      // A call of a handler waits for nobody (see `byTool` of the agent origin).
      return refused("connection_call_waits", "The Connection call would wait, and was not made.");
  }
}

/**
 * Carries out one request of a code tool's handler: a call of a Connection operation the tool
 * declares, as the tool's caller and from the tool's call. It is an Operation Run of its own,
 * authorized, recorded and audited as the agent's own call of the operation would be, so it
 * needs `connection.use` on the Connection. Its policy was asked on the tool's call. In a draft
 * agent's Try it goes where a Try call of the operation goes: the Connection's test credential.
 */
async function connectionRequest(
  config: CodeToolConfig,
  request: ToolCodeCallRequest,
  context: OperationExecutionContext,
  origin: Extract<OperationOrigin, { kind: "agent" }>,
  /** What the policy asked of each declared operation as the handler started. */
  asked: ReadonlyMap<string, PolicyValue>,
  ports: ToolCallPorts
): Promise<ToolCodeCallRequestAnswer> {
  const name = connectionOperationName(request.connection, request.operation);
  if (!(config.connections ?? []).includes(name)) {
    return refused(
      "connection_not_declared",
      `The tool does not declare '${name}' in its connections, so its handler may not call it.`
    );
  }
  const operations = ports.operations?.();
  // A Workflow test run's agent step acts within its principal's rights, which the call here
  // could not bound: it is refused rather than made with the person's rights alone.
  if (!operations || origin.boundBy !== undefined) {
    return refused("connection_unavailable", "A handler cannot call a Connection here.");
  }
  const definition = await operations.registry.resolve(name);
  if (!definition) {
    return refused("connection_unavailable", `The operation '${name}' does not exist now.`);
  }
  const { toolRevisionId: _revision, ...rest } = origin;
  try {
    const outcome = await runOperation(
      {
        operation: name,
        effect: definition.effect,
        input: request.input,
        actor: context.actor,
        origin: { ...rest, byTool: { runId: context.runId, asked: asked.get(name) ?? "allow" } },
        ...(context.workspaceId === undefined ? {} : { workspaceId: context.workspaceId }),
        correlationId: context.correlationId,
        ...(origin.draft ? { draft: { ...origin.draft } } : {})
      },
      operations.deps,
      {
        ...(context.runtime.signal ? { signal: context.runtime.signal } : {}),
        ...(context.runtime.deadline ? { deadline: context.runtime.deadline } : {}),
        ...(context.runtime.locale ? { locale: context.runtime.locale } : {}),
        ...(context.runtime.modelRoutes ? { modelRoutes: context.runtime.modelRoutes } : {}),
        ...(context.runtime.firstPartyRun ? { firstPartyRun: true as const } : {})
      }
    );
    return requestAnswerOf(outcome.result);
  } catch (error) {
    // An input the operation does not take, or one the surface refused before a run existed.
    if (isAppError(error) && error.exposeMessage) {
      return refused(
        error.code === "VALIDATION_FAILED" ? "input_invalid" : error.code.toLowerCase(),
        error.message
      );
    }
    return refused("failed", "The Connection call failed.");
  }
}

function looserPolicy(left: PolicyValue, right: PolicyValue): PolicyValue {
  return POLICY_VALUES.indexOf(left) <= POLICY_VALUES.indexOf(right) ? left : right;
}

function stricterPolicy(left: PolicyValue | undefined, right: PolicyValue): PolicyValue {
  return left !== undefined && POLICY_VALUES.indexOf(left) >= POLICY_VALUES.indexOf(right)
    ? left
    : right;
}

/**
 * What the policy asks of each Connection operation a code tool declares, of this caller in this
 * workspace: by its default, the admin's settings, its own floor, a personal conversation's
 * floor on a change, and the person's Ask me or Never. The strictest is the floor of the tool's
 * call, so a `confirm` is asked once, on the tool's call, before the handler starts, and a
 * `deny` refuses it. Each value is also the most a handler's call of that operation then runs
 * without asking (`byTool.asked`). An `approval` of an operation whose calls never wait for one,
 * a personal Connection's or one whose answer holds a secret, is a `deny`: such a call is
 * refused where it is made outside a tool too. A declared operation that no longer exists asks
 * nothing: its call fails in the handler.
 */
async function declaredPolicies(
  declared: readonly string[],
  operations: Pick<OperationCalls, "registry" | "deps">,
  call: {
    origin: OperationOrigin;
    actor?: AuthenticatedIdentity;
    workspaceId?: CollaborationWorkspaceId;
  }
): Promise<Map<string, PolicyValue>> {
  const asked = new Map<string, PolicyValue>();
  if (declared.length === 0) return asked;
  const { policy } = operations.deps;
  const targets = await operations.registry.resolveMany(declared);
  const centralSettings = await policy.centralSettings();
  const { actor, origin } = call;
  const person =
    actor && !isAuthenticatedServicePrincipal(actor) && policy.personSetting
      ? (operation: string) =>
          policy.personSetting?.({ userId: getSubjectUserId(actor), operation })
      : undefined;
  const personal =
    origin.kind === "agent" && policy.personalConversation
      ? await policy.personalConversation(origin.conversationId, origin.agentRunId)
      : false;
  for (const name of declared) {
    const target = targets.get(name);
    if (!target) continue;
    let own = await target.policyFloorOf?.(origin, undefined, actor, call.workspaceId);
    // A change in a conversation that holds personal data asks, as the agent's own call does.
    if (personal && target.effect === "changing" && !target.personalConnection) {
      own = stricterPolicy(own, "confirm");
    }
    const setting = await person?.(name);
    const resource = target.resource(undefined);
    let value = resolvePolicy({
      definition: {
        ...target,
        ...(own === undefined ? {} : { policyFloor: stricterPolicy(target.policyFloor, own) })
      },
      // Read as the caller's own confirmation would count: the value that is set, not what a
      // surface makes of it.
      origin: { kind: "user" },
      instanceDefaults: policy.instanceDefaults,
      centralSettings,
      targets: [
        { workspaceId: call.workspaceId ?? resource?.workspaceId, assetKind: resource?.kind }
      ],
      // Ask me and Never hold; Always allow lowers nothing a whole tool asks.
      ...(setting && setting !== "always_allow"
        ? { person: { setting, mayAlwaysAllow: false } }
        : {}),
      callerCanConfirm: true,
      canPause: true
    }).value;
    if (value === "approval" && (target.personalConnection || target.secret)) value = "deny";
    asked.set(name, value);
  }
  return asked;
}

/** The strictest of what the declared operations ask: the floor of the tool's call. */
function strictestOf(asked: ReadonlyMap<string, PolicyValue>): PolicyValue | undefined {
  let floor: PolicyValue | undefined;
  for (const value of asked.values()) floor = stricterPolicy(floor, value);
  return floor === "allow" ? undefined : floor;
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
    // conversation, and a code tool's handler reaches outside its sandbox only through the
    // Connection operations it declares, whose policy is the call's floor. `changing` is the
    // strictest effect, so no declared operation's effect is stricter than the tool's.
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
    ...(config.type === "code" && (config.connections ?? []).length > 0
      ? {
          policyFloorOf: async (origin, _input, actor, workspaceId) => {
            const operations = ports.operations?.();
            if (!operations) return undefined;
            const asked = await declaredPolicies(config.connections ?? [], operations, {
              origin,
              ...(actor ? { actor } : {}),
              ...(workspaceId === undefined ? {} : { workspaceId })
            });
            // Kept for the execution of this call, which follows its admission here.
            ports.admitted.set(origin, asked);
            return strictestOf(asked);
          }
        }
      : {}),
    timeoutMs:
      config.type === "result"
        ? TOOL_CALL_TIMEOUT_MS
        : toolCodeCallMaxWaitMs(toolCodeTimeoutSeconds(config)) + TOOL_CODE_END_GRACE_MS,
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
  /** See `operations` of the call's ports. */
  operations?(): Pick<OperationCalls, "registry" | "deps"> | undefined;
}

/** The operations of every published tool. A draft is never read here. */
export function createToolOperationSource(deps: ToolSourceDeps): OperationSource {
  const ports: ToolCallPorts = {
    checker: deps.checker ?? outsideSchemaChecker(),
    warn: (tool, reason) => deps.warn?.({ tool, reason }),
    ...(deps.codeCalls ? { codeCalls: deps.codeCalls } : {}),
    ...(deps.personalConversation ? { personalConversation: deps.personalConversation } : {}),
    ...(deps.operations ? { operations: deps.operations } : {}),
    admitted: new AdmittedPolicies()
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
 * Refuses a code tool that declares an operation that is no Connection's operation now. Each is
 * asked of the call path as a call of it would be: a Connection's accepted operation resolves,
 * whether or not it can be reached at this moment.
 */
async function assertDeclaredConnections(
  tool: CodeToolConfig,
  operations: Pick<OperationCalls, "registry"> | undefined
): Promise<void> {
  const declared = tool.connections ?? [];
  if (declared.length === 0) return;
  const found = operations ? await operations.registry.resolveMany(declared) : new Map();
  const issues = declared.flatMap((name, at) =>
    found.has(name) && parseConnectionOperationName(name) !== undefined
      ? []
      : [{ message: `'${name}' is no operation of a Connection`, path: ["connections", at] }]
  );
  if (issues.length === 0) return;
  throw new AppError(
    "VALIDATION_FAILED",
    `The tool '${tool.name}' declares Connection operations that do not exist: ${issues
      .map((issue) => issue.message.split("'")[1])
      .join(", ")}`,
    { reason: "tool_connection_unknown", issues }
  );
}

/**
 * The kind `tool`: a draft until a holder of `tool.publish` publishes it, owned by the instance
 * or by one workspace. Its input schema is compiled at every write in the thread that checks
 * schemas a builder wrote, so a schema that does not compile, or is over a bound, is refused
 * before it is stored.
 */
export function createToolAssetKind(
  options: {
    checker?: OutsideSchemaChecker;
    defaultLocale?: LocaleCode;
    /**
     * Where the Connection operations a code tool declares are looked up at a write. Without
     * it a tool that declares one is refused: nothing could tell it is real.
     */
    operations?(): Pick<OperationCalls, "registry"> | undefined;
  } = {}
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
      if (tool.type === "code") await assertDeclaredConnections(tool, options.operations?.());
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
  // The call path exists once the operation sources are asked for, after the kinds are built.
  let operations: OperationCalls | undefined;
  const deps: ToolSourceDeps = {
    clientInstanceId: parts.clientInstanceId,
    store: parts.stores.configAssets,
    codeCalls: createToolCodeCallClient({ stores: parts.stores }),
    personalConversation: (conversationId, runId) =>
      personalDataConversation(parts.stores, parts.clientInstanceId, conversationId, runId),
    operations: () => operations,
    warn: ({ tool, reason }) =>
      parts.logger.warn(
        { tool, checked: "input", reason },
        "A check by the input schema of a tool asset gave no answer"
      )
  };
  return {
    assetKinds: [
      createToolAssetKind({
        defaultLocale: parts.config.localization.defaultLocale,
        operations: () => operations
      })
    ],
    operationSources: (runtime) => {
      operations = runtime.operationCalls;
      return [createToolOperationSource(deps)];
    },
    start: () => ({ dataToolSources: [createToolAssetToolSource(deps)] })
  };
};
