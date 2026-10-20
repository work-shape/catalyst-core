import {
  AppError,
  type ConversationSubject,
  type ToolExecutionContext
} from "@work-shape/catalyst-core";
import { defineTool, toolSuccess, type AnyToolDefinition } from "@work-shape/catalyst-tool-sdk";
import { z } from "zod";
import { PLATFORM_ASSET_TOOLS } from "./names";
import { readOutputSchema, type PlatformAssetRead } from "./shapes";

const { open, get } = PLATFORM_ASSET_TOOLS;

/** What carries out the tool that reads an asset. */
export interface PlatformAssetGetCalls {
  /**
   * Reads `named`, or the subject where nothing is named. Moves no subject. Another asset is
   * refused as `open` refuses it, but for the move.
   */
  get(context: ToolExecutionContext, named?: ConversationSubject): Promise<PlatformAssetRead>;
}

const readInputSchema = z.object({
  kind: z
    .string()
    .min(1)
    .optional()
    .describe(
      "The kind of the asset to read, as the instance names it: workflow, app or agent, among others. Give it with 'name', or leave both out to read the asset the conversation is about."
    ),
  name: z
    .string()
    .min(1)
    .optional()
    .describe("The name of the asset, its id within its kind. Give it with 'kind'.")
});

/** The asset a read names, or nothing where it names none. Refuses a read that names half of one. */
function namedAsset(input: z.infer<typeof readInputSchema>): ConversationSubject | undefined {
  if (input.kind === undefined && input.name === undefined) return undefined;
  if (input.kind === undefined || input.name === undefined) {
    throw new AppError(
      "VALIDATION_FAILED",
      "Name the asset with both 'kind' and 'name', or with neither to read the asset this conversation is about",
      { reason: "asset_half_named" },
      { exposeMessage: true }
    );
  }
  return { kind: input.kind, name: input.name };
}

/** The tool that reads an asset, the subject or another one, and moves nothing. */
export function createGetAssetTool(calls: PlatformAssetGetCalls): AnyToolDefinition {
  return defineTool({
    name: get.name,
    title: { en: "Read asset", de: "Asset lesen" },
    summary: {
      en: "Reads the definition of a Workflow, an App or an agent.",
      de: "Liest die Definition eines Workflows, einer App oder eines Agenten."
    },
    group: "platform",
    icon: "guide",
    effect: get.effect,
    description: [
      "Read the definition of an asset of the platform, such as a Workflow, an App or an agent: its config and the revision it is at.",
      `Without 'kind' and 'name' it reads the asset the conversation is about. With them it reads that asset and changes nothing: the conversation stays about what it was, and the person sees nothing beside the chat. To work on that asset, open it with ${open.name}.`,
      "It reads with the rights of the person you act for: an asset they may not read is answered as one that does not exist. A conversation shared with a workspace reads no asset but the one it is about.",
      "Answers the draft where one differs from the published revision, and says which of the two it shows. 'publishedRevision' is the revision that runs; it is missing while nothing is published, and on a kind without drafts, such as a skill. When saveApproval is present, this person's save files a request and changes nothing until approval; name its approverNames. Without it, an authorized save applies immediately. For an agent with a shared pending draft, a holder of agent.write reads its draft content: 'revision' and 'publishedRevision' name the live revision and 'draftRevision' names the draft, null when none is pending.",
      "Read before you change anything, and send the 'revision' you read as 'expectedRevision' when you save. For an agent also send 'draftRevision' as 'expectedDraftRevision', null where no draft was pending."
    ].join(" "),
    inputSchema: readInputSchema,
    outputSchema: readOutputSchema,
    async execute(input, context) {
      const read = await calls.get(context, namedAsset(input));
      return toolSuccess(read, {
        auditSummary: {
          action: get.name,
          subject: read.name,
          metadata: { kind: read.kind, revision: read.revision, shows: read.shows }
        }
      });
    }
  });
}
