import { defineTool, toolSuccess, type AnyToolDefinition } from "@work-shape/catalyst-tool-sdk";
import { z } from "zod";

// "Einem Agenten geben" in the conversation (CS-5d): the agent offers the person a card that
// gives the approved tools of a Connection to an agent. The card lists the agents the person may
// publish; the person picks one and confirms, and the confirmation gives the Connection's tools
// to that agent with `agents.give_tools`: one live revision with the tools added, and a pending
// draft keeps its content and gains them. The tool reads nothing of the instance and
// changes nothing: the card reads the Connection's tools and the agents with the person's own
// rights, and the person's confirmation is the only write.

export const CONNECTION_OFFER_TOOL_NAME = "platform.connections.offer_to_agent";

/** An asset's id: the card reads the asset of this name with the person's rights. */
const assetName = z.string().trim().min(1).max(200);

const inputSchema = z.object({
  connection: assetName.describe("The id of the Connection whose approved tools are given."),
  agent: assetName
    .optional()
    .describe(
      "The id of the agent the person asked for, chosen first on the card. Leave it out where the person named none."
    )
});

const outputSchema = z.object({
  connection: z.string(),
  agent: z.string().optional()
});

/** The tool that answers the card. */
export function createConnectionOfferTool(): AnyToolDefinition {
  return defineTool({
    name: CONNECTION_OFFER_TOOL_NAME,
    title: { en: "Offer tools to an agent", de: "Tools einem Agenten anbieten" },
    summary: {
      en: "Shows a card that gives a Connection's approved tools to an agent.",
      de: "Zeigt eine Karte, mit der die freigegebenen Tools einer Verbindung an einen Agenten gehen."
    },
    group: "platform",
    icon: "connection",
    effect: "reading",
    description: [
      "Offer the person a card that gives the approved tools of a Connection to an agent: right after they approved the tools, when they ask that an agent may use a Connection, or before you build an App or a Workflow on it, to give them to yourself.",
      "Name the Connection, and the agent where the person named one. The person picks the agent on the card and confirms; it has the tools from its next message, also with an unpublished draft. You never give tools yourself. Given to you, call each reading operation you will use once and build from what it answers.",
      "Offer it only once the way is clear: never in an answer that also asks the person something, nor while the tools are not approved or it is open which agent gets them. After the card, tell the person in one sentence to pick the agent and confirm."
    ].join(" "),
    inputSchema,
    outputSchema,
    execute(input) {
      return toolSuccess(
        {
          connection: input.connection,
          ...(input.agent === undefined ? {} : { agent: input.agent })
        },
        {
          auditSummary: {
            action: CONNECTION_OFFER_TOOL_NAME,
            subject: input.connection,
            metadata: { agentNamed: input.agent !== undefined }
          }
        }
      );
    }
  });
}
