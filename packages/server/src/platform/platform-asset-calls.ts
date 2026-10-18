import { APP_ASSET_KIND } from "@work-shape/catalyst-api-contract";
import {
  AppError,
  moduleOffError,
  operationDenialError,
  unknownToJsonValue,
  type AuditRecorder,
  type Conversation,
  type ConversationSubject,
  type JsonObject,
  type OperationAuthorization,
  type OperationDefinition,
  type ToolExecutionContext
} from "@work-shape/catalyst-core";
import {
  PLATFORM_ASSET_LIST_MAX,
  PLATFORM_ASSET_TOOLS,
  platformAssetWriteRefusal,
  type AppSaveInput,
  type AppSaved,
  type PlatformAssetCalls,
  type PlatformAssetPut,
  type PlatformAssetFound,
  type PlatformCallableOperation
} from "@work-shape/catalyst-tool-execution";
import { z } from "zod";
import {
  DRAFT_CHANGED_ELSEWHERE,
  DRAFT_MOVED_TO_OTHER_PAGE,
  DRAFT_OF_OTHER_FOLDER,
  askAboutDraft,
  draftNotWritten,
  draftRefusal
} from "../apps/page-app-drafts";
import { wasKeptByFormerSave } from "../apps/former-page-saves";
import { PageApps } from "../apps/page-apps";
import type { AssetCall } from "../assets/asset-access";
import { assetWriteEvent } from "../guardrails/asset-guardrail-events";
import { readDefinitionName } from "../asset-kinds/shared";
import { AssetWorkflow } from "../assets/asset-service";
import { callableByAudience, listingOrigin } from "./platform-operations-audience";
import { createPlatformAssetPolicy } from "./platform-asset-policy";
import { readPlatformContext } from "./platform-context";
import { workflowAuthoringContext } from "./workflow-authoring-context";
import {
  CREATED_FROM_CHAT,
  accessOf,
  createUnnamed,
  notOfConversation,
  ofInstance,
  ownerOf,
  requireOwnTranscript,
  requireReadableSubject,
  subjectUnavailable
} from "../conversations/platform-asset-subject";
import { resolveOperationResource } from "../operations/operation-resource";
import { findWorkspaceFiles } from "../workspaces/workspace-files";
import type { AssetWorkflowOptions } from "../types";

// What carries the agent's asset tools out: the workflow of the asset operations of the API,
// called for the person the agent acts for, on the subject of the conversation the call came
// from and on the drafts that conversation created (BUILD-ALL-1), and the reads that find what
// is on the platform. Opening an asset makes it the subject, and so do the first save of a
// conversation about none and saving what the conversation opened as an App; nothing else
// does. A draft created while the conversation has a subject stays beside it. Nothing of an
// asset is decided here: the right, the checks of a
// definition, the revision and the audit rows are the ones a call of `assets.get`,
// `assets.validate`, `assets.put`, `assets.list`, `workspaces.files.list` and
// `platform.context.get` has.

const PROPOSED_KIND = "agent";

/** The module whose switch turns changing assets through `assets.put` on and off. */
const ASSET_WRITE_OPERATION = "assets.put";
/** The operations a Page's way into an App projects, beside `assets.put` of the App. */
const APP_FROM_PAGE_OPERATIONS = {
  create: "apps.create_from_page",
  draft: "apps.update_from_page"
} as const;

/** How many revisions of an App back a save of a Page looks for one written from that Page. */
const APP_REVISIONS_LOOKED_BACK = 200;

/** How many operations one list answers. The list has no pages, so this is its bound. */
const CALLABLE_OPERATION_LIST_MAX = 200;

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
    `This conversation is about no asset yet. Open the one to work on with ${PLATFORM_ASSET_TOOLS.open.name}, naming its kind and its name, and then change it. To make a new one, save it with ${PLATFORM_ASSET_TOOLS.put.name}, leaving 'expectedRevision' out and naming its 'kind' and 'name'`,
    { reason: "conversation_without_subject" },
    { exposeMessage: true }
  );

const sameSubject = (left: ConversationSubject, right: ConversationSubject | undefined) =>
  right !== undefined && left.kind === right.kind && left.name === right.name;

/** The asset a save with a revision names by kind and name, where it names a whole one. */
const namedBy = (input: { kind?: string; name?: string }): ConversationSubject | undefined =>
  input.kind !== undefined && input.name !== undefined
    ? { kind: input.kind, name: input.name }
    : undefined;

export function createPlatformAssetCalls(options: AssetWorkflowOptions): PlatformAssetCalls {
  const workflow = new AssetWorkflow(options);
  const { centralFloor, putFloor } = createPlatformAssetPolicy(options, workflow);

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
   * A later save in a conversation about the App `name`: the Page's revision becomes the App's
   * next draft revision. Only the App this Page became, or was put into, is written; a draft
   * written elsewhere since is not written over, and the answer says why.
   */
  async function saveIntoSubjectApp(
    context: ToolExecutionContext,
    conversation: Conversation,
    name: string,
    input: AppSaveInput
  ): Promise<AppSaved> {
    const row = await options.configAssets.store.getConfigAsset({
      clientInstanceId: options.clientInstanceId,
      kind: APP_ASSET_KIND,
      name
    });
    if (
      row?.status !== "active" ||
      row.scope.kind !== "workspace" ||
      row.scope.workspaceId !== conversation.collaborationWorkspaceId
    ) {
      throw subjectUnavailable();
    }
    const app = { name: row.name, title: titleOf(APP_ASSET_KIND, row.name, row.config ?? {}) };
    const page = await pageApps.named(conversation.id, input.page);
    const origin = await options.configAssets.store.getConfigAssetPageOrigin({
      clientInstanceId: options.clientInstanceId,
      assetId: row.id
    });
    const fromThisPage = (named: { pageId: string; conversationId: string } | undefined) =>
      named?.pageId === page.id && named.conversationId === conversation.id;
    // The folder the former `page.save` kept under another name is the App's folder still: its
    // first save moves the App to the Page of the path.
    const linkFormer =
      !fromThisPage(origin) &&
      origin?.conversationId === conversation.id &&
      (await wasKeptByFormerSave(options.stores.conversations, {
        clientInstanceId: options.clientInstanceId,
        conversationId: conversation.id,
        pageId: origin.pageId,
        pageName: page.name
      }));
    if (!fromThisPage(origin) && !linkFormer) {
      // Another Page was put into the App since this one wrote it: the draft moved away.
      return draftNotWritten(
        app,
        (await wasWrittenFrom(row.name, fromThisPage))
          ? DRAFT_MOVED_TO_OTHER_PAGE
          : DRAFT_OF_OTHER_FOLDER
      );
    }
    const draftPageId = linkFormer ? origin?.pageId : page.id;
    if (row.revisionOrigin?.kind !== "page" || row.revisionOrigin.pageId !== draftPageId) {
      return draftNotWritten(app, DRAFT_CHANGED_ELSEWHERE);
    }
    // The revision the preview shows is the draft, which the guardrails answer first.
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
          link: linkFormer,
          fileSetId: input.fileSetId
        },
        [event]
      );
      return {
        kind: "app",
        ...app,
        saved: true,
        created: false,
        revision: updated.revision,
        ...(warnings.length > 0 ? { warnings } : {})
      };
    } catch (error) {
      // A write of the App that did not happen is the answer's, not a failed call.
      return draftNotWritten(app, draftRefusal(error, options.logger));
    }
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

  /** Whether the conversation created the asset `named` and it is still the one it created. */
  const createdHere = (conversation: Conversation, named: ConversationSubject) =>
    options.stores.conversations.createdAsset({
      clientInstanceId: options.clientInstanceId,
      conversationId: conversation.id,
      kind: named.kind,
      name: named.name
    });

  /**
   * The asset a check or a save reaches, where the operations find it, and the call: the
   * subject where the call names none or names the subject, else a draft this conversation
   * created. Any other asset is refused, whatever the model names.
   */
  async function bound(
    context: ToolExecutionContext,
    named?: ConversationSubject
  ): Promise<{
    conversation: Conversation;
    subject: ConversationSubject;
    address: ConversationSubject & { workspaceId?: string };
    call: AssetCall;
  }> {
    const conversation = await conversationOf(context);
    let target = conversation.subject;
    if (named !== undefined && !sameSubject(named, target)) {
      if (!(await createdHere(conversation, named))) {
        throw notOfConversation(conversation.subject, named);
      }
      target = named;
    }
    if (!target) throw withoutSubject();
    return {
      conversation,
      subject: target,
      address: await addressOf(conversation, target),
      call: await callOf(context)
    };
  }

  /**
   * The asset a save writes, for its policy and its guardrails: the asset a save without a
   * revision creates, the created draft a save names, or the subject. Nothing where the save
   * names none of them, which the save itself refuses.
   */
  async function putTarget(
    conversation: Conversation,
    input: PlatformAssetPut
  ): Promise<(ConversationSubject & { workspaceId?: string }) | undefined> {
    if (input.expectedRevision === undefined) {
      const kind = creatableKinds().find((candidate) => candidate.kind === input.kind);
      if (kind === undefined || input.name === undefined) return undefined;
      return { kind: kind.kind, name: input.name, ...ownerOf(kind, conversation) };
    }
    const named = namedBy(input);
    if (named !== undefined && !sameSubject(named, conversation.subject)) {
      if (!(await createdHere(conversation, named))) return undefined;
      return addressOf(conversation, named).catch(() => undefined);
    }
    return conversation.subject;
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
    const proposed =
      asset.kind === "agent" &&
      call.access.authorize("agent.write", {
        kind: "agent",
        name: asset.name,
        assetId: read.id,
        ...(address.workspaceId ? { workspaceId: address.workspaceId } : {})
      }).allowed
        ? await workflow.agentDrafts.get(call, address)
        : undefined;
    const published =
      asset.kind === "agent"
        ? read.revision
        : "publishedRevision" in read
          ? read.publishedRevision
          : undefined;
    const revision = read.revision;
    return {
      kind: read.kind,
      name: read.name,
      config: proposed?.config ?? read.config ?? {},
      revision,
      ...(asset.kind === "agent" ? { draftRevision: proposed?.revision ?? null } : {}),
      ...(published === undefined ? {} : { publishedRevision: published }),
      shows: !proposed && published !== undefined && published === revision ? "published" : "draft",
      ...(address.workspaceId === undefined ? {} : { workspaceId: address.workspaceId })
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

  /** What a save writes: its config, or the files of a kind written as files. */
  const contentOf = (input: PlatformAssetPut) => ({
    ...(input.config === undefined ? {} : { config: input.config }),
    ...(input.files === undefined ? {} : { files: input.files })
  });

  /** The kinds a first save of a conversation creates, as far as they exist here. */
  const creatableKinds = () =>
    existingKinds().filter((kind) => CREATED_FROM_CHAT.includes(kind.kind));

  /**
   * A save without a revision: it creates the asset the call names, as `assets.put` with no
   * revision creates one, with the right, the checks and the audit of the person, and notes it
   * as this conversation's own. In a conversation about no asset yet it becomes the subject: the
   * save is the person's step that makes even an asset of the instance the subject, since nothing
   * existed that it could reach (manager, 2026-10-14). In a conversation about an asset it stays
   * a draft beside the subject, which the conversation may keep saving and moves nobody
   * (BUILD-ALL-1). An agent made so is offered nowhere.
   */
  async function create(
    context: ToolExecutionContext,
    input: PlatformAssetPut
  ): ReturnType<PlatformAssetCalls["put"]> {
    const conversation = await conversationOf(context);
    const beside = conversation.subject !== undefined;
    const kind = creatableKinds().find((candidate) => candidate.kind === input.kind);
    if (input.name === undefined || kind === undefined) {
      throw createUnnamed(creatableKinds().map((each) => each.kind));
    }
    // The new asset is the conversation's own, which a conversation others read never has.
    await requireOwnTranscript(options, conversation);
    const off = options.modules.offModuleOf("operation", ASSET_WRITE_OPERATION);
    if (off !== undefined) throw moduleOffError(off);
    const named = { kind: kind.kind, name: input.name };
    const mismatch = input.config === undefined ? undefined : otherName(named, input.config);
    if (mismatch) return { saved: false, issues: [mismatch] };
    const call = await callOf(context);
    const write = {
      ...named,
      ...ownerOf(kind, conversation),
      ...contentOf(input),
      expectedRevision: null,
      ...(kind.hasWorkspaceAvailability ? { availableIn: "nowhere" as const } : {})
    };
    let revision: number;
    try {
      allowed(await workflow.authorizeRevisionWrite(call.access, write, "write"));
      revision = (await workflow.put(call, write)).revision;
    } catch (error) {
      const refused = platformAssetWriteRefusal(error);
      if (refused) return refused;
      throw error;
    }
    const row = await options.configAssets.store.getConfigAsset({
      clientInstanceId: options.clientInstanceId,
      ...named
    });
    if (row) {
      await options.stores.conversations.recordCreatedAsset({
        clientInstanceId: options.clientInstanceId,
        conversationId: conversation.id,
        assetId: row.id,
        revision,
        createdAt: new Date().toISOString()
      });
    }
    if (!beside) {
      await options.stores.conversations.setConversationSubject({
        clientInstanceId: options.clientInstanceId,
        conversationId: conversation.id,
        subject: named
      });
    }
    const read = await readAsset(context, conversation, named);
    return {
      saved: true,
      revision,
      created: true,
      kind: named.kind,
      name: named.name,
      title: titleOf(named.kind, named.name, read.config),
      ...ownerOf(kind, conversation),
      ...(beside ? { besideSubject: true as const } : {})
    };
  }

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
        // Another asset is opened as one the conversation could have been made about.
        await requireReadableSubject(options, context.user, named);
        await requireOwnTranscript(options, conversation);
      }
      const read = await readAsset(context, conversation, named);
      const opened = { ...read, title: titleOf(read.kind, read.name, read.config) };
      if (!moves) return opened;
      // An asset of the instance becomes the subject only by a person's step: the agent's own
      // open is none, since a document or a tool's answer the agent read can ask for it, and
      // the person may change every asset of the instance. The person is offered to go to it,
      // and going there makes it the subject (`conversations.subject.open`).
      if (await ofInstance(options, named)) return { ...opened, awaitsPerson: true };
      // Set once the read stood: a refused open leaves the conversation about what it was.
      await options.stores.conversations.setConversationSubject({
        clientInstanceId: options.clientInstanceId,
        conversationId: conversation.id,
        subject: named
      });
      return opened;
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
        await requireOwnTranscript(options, conversation);
      }
      return readAsset(context, conversation, asset);
    },

    async validate(context, config, named) {
      const { subject, address, call } = await bound(context, named);
      const mismatch = otherName(subject, config);
      if (mismatch) return { issues: [mismatch] };
      const input = {
        kind: subject.kind,
        config,
        ...(address.workspaceId === undefined ? {} : { workspaceId: address.workspaceId })
      };
      allowed(await workflow.authorizeValidate(call.access, input));
      try {
        const { issues, warnings } = await workflow.validate(call, input);
        return {
          ...(warnings ? { warnings } : {}),
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
      if (input.expectedRevision === undefined) return create(context, input);
      // The save reaches the subject, or a draft this conversation created where the save names
      // one, and no other asset the model names. An asset of the instance is the subject only
      // where a person's step, or this conversation's own first save, made it.
      const { conversation, subject, address, call } = await bound(context, namedBy(input));
      const kind = options.configAssets.kinds.kinds.find(
        (candidate) => candidate.kind === subject.kind
      );
      // A Page is saved with its own tool, and a kind of a module that is off is none here.
      if (kind === undefined) throw subjectUnavailable();
      // A kind without a draft is live with every write. This tool moves a draft and nothing
      // else; an agent's save of an agent writes the conversation's proposal instead.
      const proposes = kind.kind === PROPOSED_KIND;
      if (kind.lifecycle !== "draft_published" && !proposes) {
        throw new AppError(
          "VALIDATION_FAILED",
          `An asset of the kind '${subject.kind}' has no draft: a save of it would be live at once, and this tool saves drafts only`,
          { reason: "no_draft" },
          { exposeMessage: true }
        );
      }
      const off = options.modules.offModuleOf("operation", ASSET_WRITE_OPERATION);
      if (off !== undefined) throw moduleOffError(off);
      const mismatch = input.config === undefined ? undefined : otherName(subject, input.config);
      if (mismatch) return { saved: false, issues: [mismatch] };
      const write = {
        ...address,
        ...contentOf(input),
        expectedRevision: input.expectedRevision,
        expectedDraftRevision: input.expectedDraftRevision ?? null
      };
      try {
        allowed(await workflow.authorizeRevisionWrite(call.access, write, "write"));

        const written = await workflow.put(
          { ...call, buildConversationId: conversation.id },
          write
        );
        return proposes
          ? {
              saved: true,
              revision:
                "publishedRevision" in written
                  ? (written.publishedRevision ?? written.revision)
                  : written.revision,
              draftRevision: written.revision,
              publishedRevision:
                "publishedRevision" in written ? written.publishedRevision : undefined
            }
          : { saved: true, revision: written.revision };
      } catch (error) {
        const refused = platformAssetWriteRefusal(error);
        if (refused) return refused;
        throw error;
      }
    },

    async appSaveBeforeEvents(conversationId, input) {
      const { clientInstanceId, stores } = options;
      const conversation = await stores.conversations.getConversation(
        clientInstanceId,
        conversationId
      );
      // A conversation that is gone, or a Page it does not hold, is refused by the save itself.
      // A later save asks the guardrails when it writes the draft.
      if (!conversation || conversation.subject?.kind === APP_ASSET_KIND) return [];
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

    async saveApp(context, input) {
      const conversation = await conversationOf(context);
      const subject = conversation.subject;
      if (subject?.kind === APP_ASSET_KIND) {
        return saveIntoSubjectApp(context, conversation, subject.name, input);
      }
      // The App becomes the subject, which a conversation others read never has. It is the App
      // this call creates, in the conversation's own workspace: never an asset of the instance,
      // which only a person's step makes a subject.
      // The Page revision written is the one the guardrails read, or a held call kept.
      await requireOwnTranscript(options, conversation);
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
      return {
        kind: "app",
        name: created.name,
        title: input.title,
        saved: true,
        created: true,
        revision: created.revision
      };
    },

    async putPolicyFloor(conversationId, input) {
      const conversation = await options.stores.conversations.getConversation(
        options.clientInstanceId,
        conversationId
      );
      if (!conversation) return undefined;
      // A create asks what a setting asks of the asset it names, where it would be, as
      // `assets.put` of the API asks it: its name places it in a Namespace. A save the call
      // itself refuses asks nothing here.
      const target = await putTarget(conversation, input);
      return target ? putFloor(target, input.expectedRevision !== undefined) : undefined;
    },

    async appSavePolicyFloor(conversationId) {
      const conversation = await options.stores.conversations.getConversation(
        options.clientInstanceId,
        conversationId
      );
      if (!conversation) return undefined;
      const workspaceId = conversation.collaborationWorkspaceId;
      // A save in a conversation about an App writes its draft; any other save creates one.
      const subject = conversation.subject;
      if (subject?.kind === APP_ASSET_KIND) {
        return centralFloor([APP_FROM_PAGE_OPERATIONS.draft, ASSET_WRITE_OPERATION], {
          ...subject,
          workspaceId
        });
      }
      return centralFloor([APP_FROM_PAGE_OPERATIONS.create, ASSET_WRITE_OPERATION], {
        kind: APP_ASSET_KIND,
        workspaceId
      });
    },

    async putBeforeEvents(conversationId, input) {
      const conversation = await options.stores.conversations.getConversation(
        options.clientInstanceId,
        conversationId
      );
      if (!conversation) return [];
      // A create names the asset it creates, a save of a created draft names that draft, and
      // any other save writes the subject. A save the call itself refuses has no event.
      const target = await putTarget(conversation, input);
      if (!target) return [];
      return [assetWriteEvent({ kind: target.kind, name: target.name, ...contentOf(input) })];
    },

    async readContext(context, input) {
      const call = await callOf(context);
      const read = await readPlatformContext(options, call);
      const kinds = existingKinds();
      const existing = new Set<string>(kinds.flatMap((kind) => Object.values(kind.actions)));
      const ofExisting = (actions: string[]) => actions.filter((action) => existing.has(action));
      return {
        ...(await workflowAuthoringContext(
          options,
          call,
          input,
          options.modules.isEnabled("workflows")
        )),
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

    async listOperations(context, audience) {
      // The list is of the instance, so it needs no subject: an agent asks it while it builds
      // a Page, before the conversation is about any asset.
      const conversation = await conversationOf(context);
      const call = await callOf(context);
      const listing = await options.operationCalls?.registry.list({});
      const candidates = (listing?.operations ?? [])
        .filter((definition) => callableByAudience(definition.name, audience))
        .sort((left, right) => (left.name < right.name ? -1 : 1));
      const visible = async (definition: OperationDefinition): Promise<boolean> => {
        try {
          const { resource, resourceNotFound } = await resolveOperationResource(
            options,
            definition.resource({})
          );
          if (resourceNotFound) return false;
          if (definition.action !== null) {
            return call.access.authorize(definition.action, resource).allowed;
          }
          const decision = await definition.authorize(
            {},
            {
              actor: call.actor,
              origin: listingOrigin(audience, conversation.id),
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
