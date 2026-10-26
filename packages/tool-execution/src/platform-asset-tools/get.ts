import {
  AppError,
  type ConversationSubject,
  type ToolExecutionContext
} from "@work-shape/catalyst-core";
import { defineTool, toolSuccess, type AnyToolDefinition } from "@work-shape/catalyst-tool-sdk";
import { z } from "zod";
import { PLATFORM_ASSET_TOOLS } from "./names";
import { LINK_THE_PAGE, readOutputSchema, withPageHref, type PlatformAssetRead } from "./shapes";

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
    .describe("Such as workflow, app or agent, with 'name'; both left out read the subject."),
  name: z.string().min(1).optional().describe("Its id within its kind, with 'kind'.")
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
      `Read an asset's definition: its config and revision. Without 'kind' and 'name' it reads the asset the conversation is about; with them it reads that asset and changes nothing, and the person sees nothing. To work on it, open it with ${open.name}.`,
      "It reads with the person's rights: an asset they may not read is answered as one that does not exist. A conversation shared with a workspace reads only the asset it is about.",
      "Answers the draft where one differs from the published revision, and says which it shows; 'publishedRevision' is the one that runs. For an agent, 'draftRevision' names its shared pending draft, null when none. When 'saveApproval' is present, a save files a request and changes nothing until one of its approverNames approves; name them. Without it an authorized save applies at once.",
      LINK_THE_PAGE
    ].join(" "),
    inputSchema: readInputSchema,
    outputSchema: readOutputSchema,
    async execute(input, context) {
      const read = await calls.get(context, namedAsset(input));
      return toolSuccess(withPageHref(read), {
        auditSummary: {
          action: get.name,
          subject: read.name,
          metadata: { kind: read.kind, revision: read.revision, shows: read.shows }
        }
      });
    }
  });
}
