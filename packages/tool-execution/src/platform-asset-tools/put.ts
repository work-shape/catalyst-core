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
      "Save the definition of the asset this conversation is about, or create a new asset. The person sees the change beside the chat. A save writes a draft and runs on your call: it publishes and starts nothing (to publish, call assets.publish).",
      "When to use a View, an App or a Workflow: references/apps/app-or-workflow.md in 'platform-docs'.",
      "Send the whole config with the 'revision' you read as 'expectedRevision'; for an existing agent also its 'draftRevision' as 'expectedDraftRevision' (null when none is pending), since every author shares one draft. A kind written as files, such as a Data Store, sends 'files' instead: every file, its manifest among them. Answers the new revision; or the issues, with nothing saved; or REVISION_CONFLICT: read again, apply your change to what is there now and save with the new revision.",
      `To create, leave 'expectedRevision' out and name 'kind' and 'name'. Where you do not know the shape of the kind's config, read a similar asset with ${PLATFORM_ASSET_TOOLS.get.name} first. An existing skill is refused: say what you would change.`,
      "In a conversation about another asset you may create what it needs, such as the Workflow or Data Store of an App: say first what you create and why, such as \"Dafür legen wir zuerst den Workflow an.\" The answer has 'besideSubject', and the conversation stays about its asset. Build what an App needs first and the App last.",
      `Without 'kind' and 'name' the save works on the asset this conversation is about: open one that existed before with ${PLATFORM_ASSET_TOOLS.open.name} first. With them and 'expectedRevision' it saves a draft this conversation created; any other asset is refused.`
    ].join(" "),
    inputSchema: z
      .object({
        config: configSchema.optional(),
        files: z
          .array(
            z.object({
              path: z.string().min(1),
              text: z.string().describe("The whole text.")
            })
          )
          .optional()
          .describe("Every file of an asset written as files; a file left out is deleted."),
        expectedDraftRevision: z
          .number()
          .int()
          .positive()
          .nullable()
          .optional()
          .describe("For an existing agent: the draftRevision read, null where none is pending."),
        expectedRevision: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("The 'revision' last read. Left out only to create an asset."),
        kind: kindSchema
          .optional()
          .describe(
            "To create: workflow, data_store, agent or skill. Else a draft this conversation created."
          ),
        name: nameSchema
          .optional()
          .describe(
            "To create: its name, as the config names it. Else a draft this conversation created."
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
