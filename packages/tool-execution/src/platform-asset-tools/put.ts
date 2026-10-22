import type {
  ConversationId,
  OperationAuthorization,
  OperationAuthorizeContext,
  OperationBeforeEvent,
  PolicyValue,
  ToolExecutionContext
} from "@work-shape/catalyst-core";
import { defineTool, toolSuccess, type AnyToolDefinition } from "@work-shape/catalyst-tool-sdk";
import { z } from "zod";
import { PLATFORM_ASSET_TOOLS } from "./names";
import {
  configSchema,
  draftConflictDetailsSchema,
  issueSchema,
  kindSchema,
  nameSchema,
  type PlatformAssetFile,
  type PlatformAssetWrite
} from "./shapes";

const { put } = PLATFORM_ASSET_TOOLS;

/** What a save writes: the config, or the files of a kind written as files. */
export interface PlatformAssetPut {
  config?: Record<string, unknown>;
  files?: PlatformAssetFile[];
  /** The revision the save is based on. Missing for the save that creates the asset. */
  expectedRevision?: number;
  expectedDraftRevision?: number | null;
  /**
   * The kind and the name of the asset the save creates; with `expectedRevision`, of a draft
   * this conversation created, where the save is not of the subject.
   */
  kind?: string;
  name?: string;
}

/** What carries out the tool that saves an asset, and what its call asks before it runs. */
export interface PlatformAssetPutCalls {
  /**
   * Saves the subject's draft at `expectedRevision`, or the draft of the asset `kind` and
   * `name` name where this conversation created it. Without a revision it creates the asset
   * they name: the subject in a conversation about no asset yet, else a draft beside it.
   */
  put(context: ToolExecutionContext, input: PlatformAssetPut): Promise<PlatformAssetWrite>;
  /** Checks the same write before the person is offered its confirmation. */
  authorizePut(
    input: PlatformAssetPut,
    context: OperationAuthorizeContext
  ): Promise<OperationAuthorization>;
  /**
   * What an administrator's setting on the operation a save projects asks for the subject of a
   * conversation, or nothing where no setting matches it. A save is never looser than it. In a
   * conversation about no asset yet it is what a setting asks for the asset the first save
   * names, where it would be: its kind and its owner.
   */
  putPolicyFloor(
    conversationId: ConversationId,
    input: PlatformAssetPut
  ): Promise<PolicyValue | undefined>;
  /**
   * The before-event of a save: `asset.before_write` of the conversation's subject, or of the
   * asset a first save creates.
   */
  putBeforeEvents(
    conversationId: ConversationId,
    input: PlatformAssetPut
  ): Promise<readonly OperationBeforeEvent[]>;
}

const putOutputSchema = z.union([
  z.object({
    saved: z.literal(true),
    revision: z.number().int(),
    publishedRevision: z.number().int().optional(),
    draftRevision: z.number().int().nullable().optional(),
    created: z.literal(true).optional(),
    kind: z.string().optional(),
    name: z.string().optional(),
    title: z.string().optional(),
    workspaceId: z.string().optional(),
    besideSubject: z.literal(true).optional()
  }),
  z.object({ saved: z.literal(false), issues: z.array(issueSchema) }),
  z.object({
    saved: z.literal(false),
    conflict: z.literal("REVISION_CONFLICT"),
    message: z.string(),
    details: draftConflictDetailsSchema.optional()
  })
]);

/** The tool that saves a draft, or creates an asset. */
export function createPutAssetTool(calls: PlatformAssetPutCalls): AnyToolDefinition {
  return defineTool({
    name: put.name,
    title: { en: "Save asset", de: "Asset speichern" },
    summary: {
      en: "Saves a draft, or creates an agent or skill after confirmation.",
      de: "Speichert einen Entwurf oder legt nach Bestätigung einen Agenten oder Skill an."
    },
    group: "platform",
    icon: "guide",
    effect: put.effect,
    description: [
      "Save the definition of the asset you opened, or create a new asset. Existing agent changes save the shared draft; Apps, Workflows and Data Stores save drafts. The person sees the saved change beside the chat.",
      "Choosing a View, an App or a Workflow: references/apps/app-or-workflow.md in 'platform-docs'.",
      "A draft save changes nothing that runs: it publishes nothing and starts nothing, and the published revision stays what it is until a person publishes the draft. That is why it runs on your call without a confirmation, unless an administrator set it stricter. When the person asks to publish an App or Workflow, call assets.publish to offer their confirmation; nothing goes live before their click.",
      "Send the whole config and, as 'expectedRevision', the revision you read. A kind written as files, such as a Data Store, is sent as 'files' instead: every file of the asset, its manifest among them, as a read of it lists them. Answers the new draft revision; or the issues the definition is refused for, with nothing saved; or REVISION_CONFLICT where somebody saved since you read: read again, apply your change to what is there now and save with the new revision.",
      "For an existing agent, every Build conversation and author shares one pending draft. The live agent stays unchanged until a person publishes the draft. Send the live 'revision' as 'expectedRevision' and the 'draftRevision' as 'expectedDraftRevision', null when no draft is pending. A draft conflict identifies its current revision, last author and change time: read again and apply your change to the shared draft before saving.",
      "Creating an agent or skill waits for the person's confirmation of the exact call, unless an administrator's setting asks an approval. Where platform.context lists createApproval on the skill kind, creating a skill files a request and creates nothing until one of createApproval.approverNames approves it: say so and name them. Nothing is written before the required decision, and it is live only after a successful save. Report the workspaceId from the successful result as the actual owner; a name prefix never selects an owner or workspace. A new agent stays unavailable: direct the person to Studio > Agents > the agent > Available in > Selected workspaces, select the requested workspace and Save changes (German: Studio > Agenten > Verfügbar in > Ausgewählte Arbeitsbereiche > Änderungen speichern). Never report that it is available before this step.",
      "A skill that exists is refused: the person changes it on the skill's page. Read it first and explain the exact outcome in saveApproval, including its approverNames when approval is required. Say what you would change, never that it has already changed.",
      `To make a new asset, leave 'expectedRevision' out and name its 'kind' and 'name'. That save creates a Workflow or a Data Store as a draft (a Data Store with its first migration among its files), or an agent or a skill. In a conversation that is about no asset yet it becomes the asset the conversation is about and the person is taken to its page. An agent made so is offered to nobody until a person makes it available on its page. Read ${PLATFORM_ASSET_TOOLS.get.name} of a similar asset first where you do not know the shape of the kind's config. For a new agent leave model settings out unless the person explicitly requests a model change; never copy modelBindingId, provider or model from the example. Add read_skill whenever skillNames is nonempty.`,
      "You may also create one while the conversation is about another asset, such as the Workflow or the Data Store an App needs: say first what you create and why, in a sentence such as \"Dafür legen wir zuerst den Workflow an.\" Such a draft stays beside the asset the conversation is about: the answer has 'besideSubject', the conversation stays about that asset and the person stays on the page they are on, offered a link to the new draft. Build what an App needs first and the App last.",
      "Without a new asset to make, the save works on the asset this conversation is about, naming none: open an asset that existed before with " +
        PLATFORM_ASSET_TOOLS.open.name +
        " first, which makes it the one the conversation is about. To keep saving a draft this conversation created beside that asset, name its 'kind' and 'name' with 'expectedRevision'. Any other asset is refused: an asset that existed before changes only as the asset the conversation is about."
    ].join(" "),
    inputSchema: z
      .object({
        config: configSchema.optional(),
        files: z
          .array(
            z.object({
              path: z.string().min(1).describe("The path of the file within the asset."),
              text: z.string().describe("The whole text of the file.")
            })
          )
          .optional()
          .describe(
            "For a kind written as files, such as a Data Store: every file of the asset, the manifest among them. A file left out is deleted. Send it instead of 'config'."
          ),
        expectedDraftRevision: z
          .number()
          .int()
          .positive()
          .nullable()
          .optional()
          .describe(
            "For an existing agent, the draftRevision read, null where none is pending. Separate from its live expectedRevision."
          ),
        expectedRevision: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            "The 'revision' the last read of the asset answered. Leave it out only for the save that creates an asset."
          ),
        kind: kindSchema
          .optional()
          .describe(
            "For the save that creates an asset: its kind, one of workflow, data_store, agent or skill. With 'expectedRevision': the kind of a draft this conversation created, to save it beside the asset the conversation is about."
          ),
        name: nameSchema
          .optional()
          .describe(
            "For the save that creates an asset: its name, which the config names too. With 'expectedRevision': the name of a draft this conversation created."
          )
      })
      // The owner of a new asset is the conversation's, never the call's: a call that names an
      // owner, a workspace or a target is refused, not quietly read (studio-chat-entry.md, 4a).
      .strict(),
    outputSchema: putOutputSchema,
    authorize: (input, context) => calls.authorizePut(input, context),
    // Draft saves need no confirmation by default. The call's policy floor below holds
    // live first saves for confirmation and keeps stricter administrative settings.
    permission: { mode: "allow" },
    // A setting on the operation this projects holds for the save of the agent too.
    policyFloor: ({ conversationId }, input) => calls.putPolicyFloor(conversationId, input),
    // The guardrails on asset writes answer the agent's save as they answer a person's.
    beforeEvents: (input, { conversationId }) => calls.putBeforeEvents(conversationId, input),
    async execute(input, context) {
      const written = await calls.put(context, input);
      return toolSuccess(written, {
        auditSummary: {
          action: put.name,
          ...(written.saved && written.created ? { subject: written.name } : {}),
          metadata: written.saved
            ? {
                saved: true,
                revision: written.revision,
                ...(written.created
                  ? {
                      created: true,
                      kind: written.kind,
                      ...(written.besideSubject ? { besideSubject: true } : {})
                    }
                  : {})
              }
            : {
                saved: false,
                ...("issues" in written
                  ? { issueCount: written.issues.length }
                  : { conflict: written.conflict })
              }
        }
      });
    }
  });
}
