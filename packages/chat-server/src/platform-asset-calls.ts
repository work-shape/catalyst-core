import {
  AppError,
  CONNECTION_OPERATION_PREFIX,
  DATA_STORE_OPERATION_PREFIX,
  KNOWLEDGE_OPERATION_PREFIX,
  createAuthorizer,
  moduleOffError,
  operationDenialError,
  resolvePolicy,
  unknownToJsonValue,
  type ActorAccess,
  type AuditRecorder,
  type AuthenticatedIdentity,
  type Conversation,
  type ConversationSubject,
  type JsonObject,
  type OperationAuthorization,
  type OperationDefinition,
  type ToolExecutionContext
} from "@vivd-catalyst/core";
import {
  PLATFORM_ASSET_TOOLS,
  platformAssetWriteRefusal,
  type PlatformAssetCalls,
  type PlatformCallableOperation
} from "@vivd-catalyst/tool-execution";
import { z } from "zod";
import type { AssetCall } from "./asset-access";
import { readDefinitionName } from "./asset-kinds/shared";
import { AssetWorkflow } from "./asset-workflow";
import type { AssetWorkflowOptions } from "./types";

// What carries the agent's asset tools out: the workflow of the asset operations of the API,
// called for the person the agent acts for, on the subject of the conversation the call came
// from. A read that names another asset makes that asset the subject. Nothing of an asset is
// decided here: the right, the checks of a definition, the revision and the audit rows are the
// ones a call of `assets.get`, `assets.validate` and `assets.put` has.

/** The module whose switch turns changing assets through `assets.put` on and off. */
const ASSET_WRITE_OPERATION = "assets.put";

/** How many operations one list answers. The list has no pages, so this is its bound. */
const CALLABLE_OPERATION_LIST_MAX = 200;

/** The operations that exist as data and that a step of a Workflow may name. */
const CALLABLE_PREFIXES = [
  CONNECTION_OPERATION_PREFIX,
  DATA_STORE_OPERATION_PREFIX,
  KNOWLEDGE_OPERATION_PREFIX
];

type AssetOptions = Pick<
  AssetWorkflowOptions,
  "clientInstanceId" | "stores" | "authorizer" | "auditRecorder" | "configAssets" | "modules"
>;

const accessOf = (options: AssetOptions, actor: AuthenticatedIdentity): Promise<ActorAccess> =>
  (options.authorizer ?? createAuthorizer(options.stores.access)).forActor(actor);

/** One refusal for a subject that does not exist and for one its caller may not read. */
const subjectUnavailable = () =>
  new AppError(
    "NOT_FOUND",
    "The subject of the conversation is not available",
    { reason: "subject_unavailable" },
    { exposeMessage: true }
  );

/**
 * Refuses a conversation about an asset its creator may not read. A kind the instance does
 * not have, an asset that does not exist and one the caller holds no read right on are told
 * the same way, so the refusal says nothing of what is stored. An asset of a kind without a
 * draft, such as an agent, may be a subject: the agent reads it, and its tools save drafts only.
 */
export async function requireReadableSubject(
  options: AssetWorkflowOptions,
  actor: AuthenticatedIdentity,
  subject: ConversationSubject
): Promise<void> {
  let decision: OperationAuthorization;
  try {
    decision = await new AssetWorkflow(options).authorizeRead(
      await accessOf(options, actor),
      subject
    );
  } catch {
    // The kind is unknown here, or of a module that is off.
    throw subjectUnavailable();
  }
  if (!decision.allowed) throw subjectUnavailable();
  const asset = await options.configAssets.store.getConfigAsset({
    clientInstanceId: options.clientInstanceId,
    kind: subject.kind,
    name: subject.name
  });
  if (asset?.status !== "active") throw subjectUnavailable();
}

const jsonObjectSchema = z.record(z.string(), z.unknown());

/** The input or output of an operation as JSON Schema, where it can be told as one. */
function jsonSchemaOf(given: JsonObject | undefined, schema: z.ZodType): JsonObject | undefined {
  if (given) return given;
  try {
    const derived = jsonObjectSchema.safeParse(z.toJSONSchema(schema, { unrepresentable: "any" }));
    if (!derived.success || Object.keys(derived.data).length <= 1) return undefined;
    const value = unknownToJsonValue(derived.data);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The refusal of a call that names no asset in a conversation about none yet. */
const withoutSubject = () =>
  new AppError(
    "CONFLICT",
    `This conversation is about no asset yet. Read the one to work on with ${PLATFORM_ASSET_TOOLS.get.name}, naming its kind and its name`,
    { reason: "conversation_without_subject" },
    { exposeMessage: true }
  );

const sameSubject = (left: ConversationSubject, right: ConversationSubject | undefined) =>
  right !== undefined && left.kind === right.kind && left.name === right.name;

export function createPlatformAssetCalls(options: AssetWorkflowOptions): PlatformAssetCalls {
  const workflow = new AssetWorkflow(options);

  /** The conversation the call came from. */
  async function conversationOf(context: ToolExecutionContext): Promise<Conversation> {
    const conversationId = context.toolRequest?.conversationId;
    const conversation = conversationId
      ? await options.stores.conversations.getConversation(options.clientInstanceId, conversationId)
      : undefined;
    if (!conversation) {
      throw new AppError(
        "CONFLICT",
        "An asset is read and saved in a conversation, and this call came from none",
        { reason: "call_without_conversation" },
        { exposeMessage: true }
      );
    }
    return conversation;
  }

  /**
   * Refuses to read an asset into a transcript that others read. A member of a Shared
   * Workspace need not hold the read right on the asset, so a conversation about one is its
   * creator's alone, as `createConversation` makes it.
   */
  async function requireOwnTranscript(conversation: Conversation): Promise<void> {
    if (conversation.visibility === "private") return;
    const workspace = await options.stores.workspaces.getWorkspace(
      options.clientInstanceId,
      conversation.collaborationWorkspaceId
    );
    if (workspace?.kind === "personal") return;
    throw new AppError(
      "CONFLICT",
      "This conversation is shared with its workspace, and an asset is read only in a conversation of the person's own. Ask the person to start a new conversation, or to open the asset's page and choose Edit with the agent",
      { reason: "subject_conversation_shared" },
      { exposeMessage: true }
    );
  }

  /** The call as the asset operations take one. */
  async function callOf(context: ToolExecutionContext): Promise<AssetCall> {
    const runId = context.operationRun?.id;
    // The audit rows of the call carry its run, as those of a call of the API do.
    const audit: AuditRecorder = {
      record: (input) =>
        options.auditRecorder.record({
          ...input,
          correlationId: context.correlationId,
          metadata: { ...input.metadata, ...(runId ? { operationRunId: runId } : {}) }
        })
    };
    return {
      actor: context.user,
      access: await accessOf(options, context.user),
      audit,
      correlationId: context.correlationId,
      ...(runId ? { runId } : {})
    };
  }

  /** The asset the conversation is about, and the call as the asset operations take one. */
  async function bound(context: ToolExecutionContext): Promise<{
    subject: ConversationSubject;
    call: AssetCall;
  }> {
    const { subject } = await conversationOf(context);
    if (!subject) throw withoutSubject();
    return { subject, call: await callOf(context) };
  }

  const allowed = (decision: OperationAuthorization): void => {
    if (!decision.allowed) {
      throw operationDenialError({
        kind: "forbidden",
        action: decision.action,
        reason: decision.reason
      });
    }
  };

  /** The one issue of a config that names another asset than the conversation is about. */
  const otherName = (subject: ConversationSubject, config: Record<string, unknown>) =>
    readDefinitionName(config) === subject.name
      ? undefined
      : {
          path: "name",
          code: "subject_mismatch",
          message: `The config names another asset than this conversation is about. 'name' is '${subject.name}'`
        };

  return {
    async get(context, named) {
      const conversation = await conversationOf(context);
      const subject = named ?? conversation.subject;
      if (!subject) throw withoutSubject();
      const moves = !sameSubject(subject, conversation.subject);
      if (moves) {
        // Another asset is read as one the conversation could have been made about.
        await requireReadableSubject(options, context.user, subject);
        await requireOwnTranscript(conversation);
      }
      const call = await callOf(context);
      allowed(await workflow.reads.authorizeGet(call.access, subject));
      const read = await workflow.reads.get(call, subject);
      // Set once the read stood: a refused read leaves the conversation about what it was.
      if (moves) {
        await options.stores.conversations.setConversationSubject({
          clientInstanceId: options.clientInstanceId,
          conversationId: conversation.id,
          subject
        });
      }
      const published = "publishedRevision" in read ? read.publishedRevision : undefined;
      return {
        kind: read.kind,
        name: read.name,
        config: read.config ?? {},
        revision: read.revision,
        ...(published === undefined ? {} : { publishedRevision: published }),
        shows: published !== undefined && published === read.revision ? "published" : "draft"
      };
    },

    async validate(context, config) {
      const { subject, call } = await bound(context);
      const mismatch = otherName(subject, config);
      if (mismatch) return { issues: [mismatch] };
      const input = { kind: subject.kind, config };
      allowed(await workflow.authorizeValidate(call.access, input));
      try {
        const { issues } = await workflow.validate(call, input);
        return {
          issues: issues.map((issue) => ({
            path: (issue.path ?? []).join("."),
            message: issue.message,
            ...(issue.code === undefined ? {} : { code: issue.code })
          }))
        };
      } catch (error) {
        // A kind's own parser refuses a definition by throwing, with its issues and codes.
        const refused = platformAssetWriteRefusal(error);
        if (refused && "issues" in refused) return { issues: refused.issues };
        throw error;
      }
    },

    async put(context, input) {
      const { subject, call } = await bound(context);
      const kind = options.configAssets.kinds.kinds.find(
        (candidate) => candidate.kind === subject.kind
      );
      // A Page is saved with its own tool, and a kind of a module that is off is none here.
      if (kind === undefined) throw subjectUnavailable();
      // A kind without a draft is live with every write. This tool moves a draft and nothing else.
      if (kind.lifecycle !== "draft_published") {
        throw new AppError(
          "VALIDATION_FAILED",
          `An asset of the kind '${subject.kind}' has no draft: a save of it would be live at once, and this tool saves drafts only`,
          { reason: "no_draft" },
          { exposeMessage: true }
        );
      }
      const off = options.modules.offModuleOf("operation", ASSET_WRITE_OPERATION);
      if (off !== undefined) throw moduleOffError(off);
      const mismatch = otherName(subject, input.config);
      if (mismatch) return { saved: false, issues: [mismatch] };
      const write = { ...subject, config: input.config, expectedRevision: input.expectedRevision };
      try {
        allowed(await workflow.authorizeRevisionWrite(call.access, write, "write"));
        const written = await workflow.put(call, write);
        return { saved: true, revision: written.revision };
      } catch (error) {
        const refused = platformAssetWriteRefusal(error);
        if (refused) return refused;
        throw error;
      }
    },

    async putPolicyFloor(conversationId) {
      const policy = options.operationCalls?.deps.policy;
      const conversation = await options.stores.conversations.getConversation(
        options.clientInstanceId,
        conversationId
      );
      const subject = conversation?.subject;
      if (!policy || !subject) return undefined;
      // Read as the value that was set: the tool's own mode stands where no setting names the
      // operation, since the instance default for changes is one an agent's call cannot meet.
      const asked = resolvePolicy({
        definition: { name: ASSET_WRITE_OPERATION, effect: "changing", defaultPolicy: "allow" },
        origin: { kind: "user" },
        instanceDefaults: policy.instanceDefaults,
        centralSettings: await policy.centralSettings(),
        targets: await workflow.policyTargets(subject),
        callerCanConfirm: true,
        canPause: true
      });
      return asked.source === "central_setting" ? asked.value : undefined;
    },

    async listOperations(context) {
      const { call } = await bound(context);
      const listing = await options.operationCalls?.registry.list({});
      const candidates = (listing?.operations ?? [])
        .filter((definition) =>
          CALLABLE_PREFIXES.some((prefix) => definition.name.startsWith(prefix))
        )
        .sort((left, right) => (left.name < right.name ? -1 : 1));
      const visible = async (definition: OperationDefinition): Promise<boolean> => {
        try {
          const resource = definition.resource({});
          if (definition.action !== null) {
            return call.access.authorize(definition.action, resource).allowed;
          }
          const decision = await definition.authorize(
            {},
            {
              actor: call.actor,
              // Asked as a step of a Workflow would call it: an operation that is not exposed
              // to Workflows is none a step may name.
              origin: { kind: "workflow", workflowRunId: "", stepRunId: "" },
              correlationId: call.correlationId,
              access: call.access,
              resource
            }
          );
          return decision.allowed;
        } catch {
          return false;
        }
      };
      const operations: PlatformCallableOperation[] = [];
      let truncated = (listing?.truncated.length ?? 0) > 0;
      for (const definition of candidates) {
        if (!(await visible(definition))) continue;
        if (operations.length >= CALLABLE_OPERATION_LIST_MAX) {
          truncated = true;
          break;
        }
        const inputSchema = jsonSchemaOf(definition.inputJsonSchema, definition.inputSchema);
        const outputSchema = jsonSchemaOf(definition.outputJsonSchema, definition.outputSchema);
        operations.push({
          name: definition.name,
          effect: definition.effect,
          ...(inputSchema ? { inputSchema } : {}),
          ...(outputSchema ? { outputSchema } : {})
        });
      }
      return { operations, truncated };
    }
  };
}
