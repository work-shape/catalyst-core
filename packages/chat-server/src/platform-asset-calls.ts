import { APP_ASSET_KIND } from "@vivd-catalyst/api-contract";
import {
  AppError,
  CONNECTION_OPERATION_PREFIX,
  DATA_STORE_OPERATION_PREFIX,
  KNOWLEDGE_OPERATION_PREFIX,
  createAuthorizer,
  isPageId,
  moduleOffError,
  operationDenialError,
  POLICY_VALUES,
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
  type PolicyValue,
  type ToolExecutionContext
} from "@vivd-catalyst/core";
import {
  PLATFORM_ASSET_LIST_MAX,
  PLATFORM_ASSET_OPEN_NEEDS_PERSON,
  PLATFORM_ASSET_TOOLS,
  platformAssetWriteRefusal,
  type PlatformAssetCalls,
  type PlatformAssetFound,
  type PlatformCallableOperation
} from "@vivd-catalyst/tool-execution";
import { z } from "zod";
import {
  DRAFT_CHANGED_ELSEWHERE,
  DRAFT_MOVED_TO_OTHER_PAGE,
  askAboutDraft,
  draftNotWritten,
  draftRefusal
} from "./apps/page-app-drafts";
import { PageApps } from "./apps/page-apps";
import type { AssetCall } from "./asset-access";
import { assetWriteEvent } from "./asset-guardrail-events";
import { readDefinitionName } from "./asset-kinds/shared";
import { AssetWorkflow } from "./asset-workflow";
import { readPlatformContext } from "./platform-context";
import { findWorkspaceFiles } from "./workspace-files";
import type { AssetWorkflowOptions } from "./types";

// What carries the agent's asset tools out: the workflow of the asset operations of the API,
// called for the person the agent acts for, on the subject of the conversation the call came
// from, and the reads that find what is on the platform. Opening an asset makes it the subject,
// and so does keeping a Page of the conversation as an App; nothing else does. Nothing of an
// asset is decided here: the right, the checks of a
// definition, the revision and the audit rows are the ones a call of `assets.get`,
// `assets.validate`, `assets.put`, `assets.list`, `workspaces.files.list` and
// `platform.context.get` has.

/** The module whose switch turns changing assets through `assets.put` on and off. */
const ASSET_WRITE_OPERATION = "assets.put";
/** The operations a Page's way into an App projects, beside `assets.put` of the App. */
const APP_FROM_PAGE_OPERATIONS = {
  create: "apps.create_from_page",
  draft: "apps.update_from_page"
} as const;

/** How many revisions of an App back a save of a Page looks for one written from that Page. */
const APP_REVISIONS_LOOKED_BACK = 200;

const stricterOf = (left: PolicyValue | undefined, right: PolicyValue): PolicyValue =>
  left === undefined || POLICY_VALUES.indexOf(right) > POLICY_VALUES.indexOf(left) ? right : left;

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
    `This conversation is about no asset yet. Open the one to work on with ${PLATFORM_ASSET_TOOLS.open.name}, naming its kind and its name, and then change it`,
    { reason: "conversation_without_subject" },
    { exposeMessage: true }
  );

const sameSubject = (left: ConversationSubject, right: ConversationSubject | undefined) =>
  right !== undefined && left.kind === right.kind && left.name === right.name;

export function createPlatformAssetCalls(options: AssetWorkflowOptions): PlatformAssetCalls {
  const workflow = new AssetWorkflow(options);
  const pageApps = new PageApps(options);

  /** The conversation the call came from, where it came from one. */
  async function conversationOfCall(
    context: ToolExecutionContext
  ): Promise<Conversation | undefined> {
    const conversationId = context.toolRequest?.conversationId;
    return conversationId
      ? options.stores.conversations.getConversation(options.clientInstanceId, conversationId)
      : undefined;
  }

  /** The conversation the call came from. Refuses a call that came from none. */
  async function conversationOf(context: ToolExecutionContext): Promise<Conversation> {
    const conversation = await conversationOfCall(context);
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
   * Refuses to open or read an asset in a transcript that others read. A member of a Shared
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
      "This conversation is shared with its workspace, and an asset is opened and read only in a conversation of the person's own. Ask the person to start a new conversation, or to open the asset's page and choose Edit with the agent",
      { reason: "subject_conversation_shared" },
      { exposeMessage: true }
    );
  }

  /**
   * The strictest value an administrator set on any of `operations` for the asset at
   * `address`, read as the value that was set: a tool's own mode stands where no setting names
   * the operation, since the instance default for changes is one an agent's call cannot meet.
   */
  async function centralFloor(
    operations: readonly string[],
    address: { kind: string; name?: string; workspaceId?: string }
  ): Promise<PolicyValue | undefined> {
    const policy = options.operationCalls?.deps.policy;
    if (!policy) return undefined;
    const centralSettings = await policy.centralSettings();
    const targets = await workflow.policyTargets(address);
    let floor: PolicyValue | undefined;
    for (const name of operations) {
      const asked = resolvePolicy({
        definition: { name, effect: "changing", defaultPolicy: "allow" },
        origin: { kind: "user" },
        instanceDefaults: policy.instanceDefaults,
        centralSettings,
        targets,
        callerCanConfirm: true,
        canPause: true
      });
      if (asked.source === "central_setting") floor = stricterOf(floor, asked.value);
    }
    return floor;
  }

  /** Whether a revision of the App `name` was ever written from the Page `fromPage` names. */
  async function wasWrittenFrom(
    name: string,
    fromPage: (origin: { pageId: string; conversationId: string }) => boolean
  ): Promise<boolean> {
    const revisions = await options.configAssets.store.listConfigAssetRevisions({
      clientInstanceId: options.clientInstanceId,
      kind: APP_ASSET_KIND,
      name,
      newestFirst: true,
      page: { limit: APP_REVISIONS_LOOKED_BACK }
    });
    return revisions.some(({ origin }) => origin?.kind === "page" && fromPage(origin));
  }

  /**
   * Refuses to move the subject onto an asset of the instance. Such an asset becomes the
   * subject only by a person's step: the person started the conversation from its page. The
   * agent's own open is no such step, since a document or a tool's answer the agent read can
   * ask for it, and the person may change every asset of the instance. Until the host asks the
   * person to confirm such an open, the agent is refused it. An asset of the conversation's
   * workspace, such as an App, opens as before.
   */
  async function requireWorkspaceAsset(named: ConversationSubject): Promise<void> {
    const row = await options.configAssets.store.getConfigAsset({
      clientInstanceId: options.clientInstanceId,
      kind: named.kind,
      name: named.name
    });
    if (row?.scope.kind === "workspace") return;
    throw new AppError(
      "FORBIDDEN",
      `This ${named.kind} belongs to the whole instance, and only the person makes such an asset what a conversation is about, by starting the conversation from its page. You can read it with ${PLATFORM_ASSET_TOOLS.get.name}. To change it, ask the person to open its page and choose Edit with the agent`,
      { reason: PLATFORM_ASSET_OPEN_NEEDS_PERSON },
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

  /**
   * Where the operations find an asset. An asset of a workspace, such as an App, is read and
   * saved in a conversation of that workspace, and is missing from every other one.
   */
  async function addressOf(
    conversation: Conversation,
    subject: ConversationSubject
  ): Promise<ConversationSubject & { workspaceId?: string }> {
    const row = await options.configAssets.store.getConfigAsset({
      clientInstanceId: options.clientInstanceId,
      kind: subject.kind,
      name: subject.name
    });
    if (row?.scope.kind !== "workspace") return subject;
    if (row.scope.workspaceId !== conversation.collaborationWorkspaceId) {
      throw subjectUnavailable();
    }
    return { ...subject, workspaceId: row.scope.workspaceId };
  }

  /** The asset the conversation is about, where the operations find it, and the call. */
  async function bound(context: ToolExecutionContext): Promise<{
    subject: ConversationSubject;
    address: ConversationSubject & { workspaceId?: string };
    call: AssetCall;
  }> {
    const conversation = await conversationOf(context);
    const subject = conversation.subject;
    if (!subject) throw withoutSubject();
    return {
      subject,
      address: await addressOf(conversation, subject),
      call: await callOf(context)
    };
  }

  /** Reads an asset of the conversation, as the agent reads one. */
  async function readAsset(
    context: ToolExecutionContext,
    conversation: Conversation,
    asset: ConversationSubject
  ): ReturnType<PlatformAssetCalls["get"]> {
    const address = await addressOf(conversation, asset);
    const call = await callOf(context);
    allowed(await workflow.reads.authorizeGet(call.access, address));
    const read = await workflow.reads.get(call, address);
    const published = "publishedRevision" in read ? read.publishedRevision : undefined;
    return {
      kind: read.kind,
      name: read.name,
      config: read.config ?? {},
      revision: read.revision,
      ...(published === undefined ? {} : { publishedRevision: published }),
      shows: published !== undefined && published === read.revision ? "published" : "draft"
    };
  }

  /** The name people read for an asset, as a list shows it: its name where none is told. */
  function titleOf(kind: string, name: string, config: JsonObject): string {
    const assetKind = options.configAssets.kinds.kinds.find((each) => each.kind === kind);
    try {
      return assetKind?.summarize(config).title ?? name;
    } catch {
      return name;
    }
  }

  /** The kinds that exist here: a kind of a module that is off does not. */
  const existingKinds = () =>
    options.configAssets.kinds.kinds.filter(
      (kind) => options.modules.offModuleOf("kind", kind.kind) === undefined
    );

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
    async open(context, named) {
      const conversation = await conversationOf(context);
      const moves = !sameSubject(named, conversation.subject);
      if (moves) {
        // Another asset is opened as one the conversation could have been made about, and
        // only where no person's step is needed for it.
        await requireReadableSubject(options, context.user, named);
        await requireOwnTranscript(conversation);
        await requireWorkspaceAsset(named);
      }
      const read = await readAsset(context, conversation, named);
      // Set once the read stood: a refused open leaves the conversation about what it was.
      if (moves) {
        await options.stores.conversations.setConversationSubject({
          clientInstanceId: options.clientInstanceId,
          conversationId: conversation.id,
          subject: named
        });
      }
      return { ...read, title: titleOf(read.kind, read.name, read.config) };
    },

    async get(context, named) {
      const conversation = await conversationOf(context);
      const asset = named ?? conversation.subject;
      if (!asset) throw withoutSubject();
      if (named !== undefined && !sameSubject(named, conversation.subject)) {
        // Another asset is told as the subject would be: one that does not exist and one the
        // person may not read alike. Its definition reaches no transcript that members read
        // who may not read it, as the subject's does not.
        await requireReadableSubject(options, context.user, named);
        await requireOwnTranscript(conversation);
      }
      return readAsset(context, conversation, asset);
    },

    async validate(context, config) {
      const { subject, address, call } = await bound(context);
      const mismatch = otherName(subject, config);
      if (mismatch) return { issues: [mismatch] };
      const input = {
        kind: subject.kind,
        config,
        ...(address.workspaceId === undefined ? {} : { workspaceId: address.workspaceId })
      };
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
      // The save reaches the subject and no asset the model names. An asset of the instance is
      // the subject only where a person's step made it so: `open` moves no subject onto one.
      const { subject, address, call } = await bound(context);
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
      const write = { ...address, config: input.config, expectedRevision: input.expectedRevision };
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

    async saveAsAppBeforeEvents(conversationId, input) {
      const { clientInstanceId, stores } = options;
      const conversation = await stores.conversations.getConversation(
        clientInstanceId,
        conversationId
      );
      // A conversation that is gone, or a Page it does not hold, is refused by the save itself.
      if (!conversation) return [];
      return [
        pageApps.writeEvent({
          app: input.name,
          title: input.title,
          workspaceId: conversation.collaborationWorkspaceId,
          fileSetId: input.fileSetId,
          page: () => pageApps.named(conversation.id, input.page).catch(() => undefined)
        })
      ];
    },

    async saveAsApp(context, input) {
      const conversation = await conversationOf(context);
      // The App becomes the subject, which a conversation others read never has. It is the App
      // this call creates, in the conversation's own workspace: never an asset of the instance,
      // which only a person's step makes a subject.
      // The Page revision written is the one the guardrails read, or a held call kept.
      await requireOwnTranscript(conversation);
      const page = await pageApps.named(conversation.id, input.page);
      const created = await pageApps.create(
        await callOf(context),
        page,
        {
          name: input.name,
          title: input.title,
          workspaceId: conversation.collaborationWorkspaceId,
          fileSetId: input.fileSetId
        },
        context.beforeEvents
      );
      await options.stores.conversations.setConversationSubject({
        clientInstanceId: options.clientInstanceId,
        conversationId: conversation.id,
        subject: { kind: APP_ASSET_KIND, name: created.name }
      });
      return { kind: "app", name: created.name, title: input.title, revision: created.revision };
    },

    async saveIntoSubjectApp(context, input) {
      const conversation = await conversationOfCall(context);
      const subject = conversation?.subject;
      if (!conversation || subject?.kind !== APP_ASSET_KIND) return undefined;
      const row = await options.configAssets.store.getConfigAsset({
        clientInstanceId: options.clientInstanceId,
        kind: APP_ASSET_KIND,
        name: subject.name
      });
      if (
        row?.status !== "active" ||
        row.scope.kind !== "workspace" ||
        row.scope.workspaceId !== conversation.collaborationWorkspaceId
      ) {
        return undefined;
      }
      const app = { name: row.name, title: titleOf(APP_ASSET_KIND, row.name, row.config ?? {}) };
      // Only the App this Page became, or was put into, is written by the Page's saves.
      const origin = await options.configAssets.store.getConfigAssetPageOrigin({
        clientInstanceId: options.clientInstanceId,
        assetId: row.id
      });
      const fromThisPage = (named: { pageId: string; conversationId: string } | undefined) =>
        named?.pageId === input.pageId && named.conversationId === conversation.id;
      if (!fromThisPage(origin) || !isPageId(input.pageId)) {
        // Another Page was put into the App since this one wrote it: the draft moved away.
        return (await wasWrittenFrom(row.name, fromThisPage))
          ? draftNotWritten(app, DRAFT_MOVED_TO_OTHER_PAGE)
          : undefined;
      }
      const page = await options.stores.pages.getPage({
        clientInstanceId: options.clientInstanceId,
        conversationId: conversation.id,
        pageId: input.pageId
      });
      if (!page) return undefined;
      if (row.revisionOrigin?.kind !== "page" || row.revisionOrigin.pageId !== page.id) {
        return draftNotWritten(app, DRAFT_CHANGED_ELSEWHERE);
      }
      // The revision the save just stored is the draft, which the guardrails answer first.
      const asked = await askAboutDraft(options.operationCalls?.deps.events, context, pageApps, {
        app: row.name,
        workspaceId: row.scope.workspaceId,
        fileSetId: input.fileSetId,
        page
      });
      if ("refusal" in asked) return draftNotWritten(app, asked.refusal);
      const { event, warnings } = asked;
      try {
        const updated = await pageApps.update(
          await callOf(context),
          page,
          {
            app: row.name,
            workspaceId: row.scope.workspaceId,
            expectedRevision: row.revision,
            link: false,
            fileSetId: input.fileSetId
          },
          [event]
        );
        return {
          ...app,
          saved: true,
          revision: updated.revision,
          ...(warnings.length > 0 ? { warnings } : {})
        };
      } catch (error) {
        // The Page is saved either way: a write of the App that did not happen is the answer's,
        // not a failed save.
        return draftNotWritten(app, draftRefusal(error, options.logger));
      }
    },

    async putPolicyFloor(conversationId) {
      const conversation = await options.stores.conversations.getConversation(
        options.clientInstanceId,
        conversationId
      );
      const subject = conversation?.subject;
      return subject ? centralFloor([ASSET_WRITE_OPERATION], subject) : undefined;
    },

    async pageAppPolicyFloor(conversationId, write) {
      const conversation = await options.stores.conversations.getConversation(
        options.clientInstanceId,
        conversationId
      );
      if (!conversation) return undefined;
      const workspaceId = conversation.collaborationWorkspaceId;
      if (write === "create") {
        return centralFloor([APP_FROM_PAGE_OPERATIONS.create, ASSET_WRITE_OPERATION], {
          kind: APP_ASSET_KIND,
          workspaceId
        });
      }
      // A save of a Page writes an App only where the conversation is about one.
      const subject = conversation.subject;
      if (subject?.kind !== APP_ASSET_KIND) return undefined;
      return centralFloor([APP_FROM_PAGE_OPERATIONS.draft, ASSET_WRITE_OPERATION], {
        ...subject,
        workspaceId
      });
    },

    async putBeforeEvents(conversationId, config) {
      const conversation = await options.stores.conversations.getConversation(
        options.clientInstanceId,
        conversationId
      );
      const subject = conversation?.subject;
      // A conversation without a subject saves nothing: the save itself refuses it.
      if (!subject) return [];
      return [assetWriteEvent({ kind: subject.kind, name: subject.name, config })];
    },

    async readContext(context) {
      const call = await callOf(context);
      const read = await readPlatformContext(options, call);
      const kinds = existingKinds();
      const existing = new Set<string>(kinds.flatMap((kind) => Object.values(kind.actions)));
      const ofExisting = (actions: string[]) => actions.filter((action) => existing.has(action));
      return {
        instance: { name: read.instance.name },
        modules: options.modules.modules.filter((module) => module.enabled).map(({ name }) => name),
        kinds: kinds.map((kind) => ({
          kind: kind.kind,
          plural: kind.plural,
          hasDraft: kind.lifecycle === "draft_published"
        })),
        actions: ofExisting(read.actions),
        assetActions: ofExisting(read.assetActions),
        namespaces: read.namespaces.flatMap((namespace) => {
          const actions = ofExisting(namespace.actions);
          return actions.length > 0 ? [{ ...namespace, actions }] : [];
        })
      };
    },

    async listAssets(context, input) {
      const conversation = await conversationOfCall(context);
      const call = await callOf(context);
      const kinds = existingKinds().filter(
        (kind) => input.kind === undefined || kind.kind === input.kind
      );
      if (kinds.length === 0) {
        throw new AppError(
          "NOT_FOUND",
          `This platform has no kind '${input.kind}'. platform.context lists the kinds it has`,
          { reason: "unknown_kind" },
          { exposeMessage: true }
        );
      }
      // What the instance owns, and what the workspace of the conversation owns.
      const workspaces = [undefined, conversation?.collaborationWorkspaceId];
      const assets: PlatformAssetFound[] = [];
      for (const kind of kinds) {
        for (const workspaceId of workspaces) {
          const room = PLATFORM_ASSET_LIST_MAX - assets.length;
          // One more than there is room for says whether the list is cut.
          const listed = await workflow.reads.list(
            call,
            {
              kind: kind.kind,
              ...(input.text === undefined ? {} : { text: input.text }),
              ...(workspaceId === undefined ? {} : { workspaceId })
            },
            { limit: room + 1 }
          );
          for (const asset of listed.slice(0, room)) {
            assets.push({
              kind: asset.kind,
              name: asset.name,
              title: asset.title,
              ...(asset.description === undefined ? {} : { description: asset.description })
            });
          }
          if (listed.length > room) return { assets, truncated: true };
        }
      }
      return { assets, truncated: false };
    },

    async listFiles(context, input) {
      const conversation = await conversationOfCall(context);
      if (!conversation) {
        throw new AppError("NOT_FOUND", "This conversation is not available");
      }
      // One more than is answered says whether the list is cut.
      const found = await findWorkspaceFiles(options, {
        user: context.user,
        collaborationWorkspaceId: conversation.collaborationWorkspaceId,
        ...input,
        page: { limit: PLATFORM_ASSET_LIST_MAX + 1 }
      });
      return {
        files: found
          .slice(0, PLATFORM_ASSET_LIST_MAX)
          .map((file) =>
            file.conversation.id === conversation.id ? { ...file, inThisConversation: true } : file
          ),
        truncated: found.length > PLATFORM_ASSET_LIST_MAX
      };
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
