import { APP_AUDIENCES, WORKFLOW_ASSET_KIND } from "@work-shape/catalyst-core";
import { defineTool, toolFailed } from "@work-shape/catalyst-tool-sdk";
import { z } from "zod";

/** Describes the existing asset operation; the operation runner owns every publish gate. */
export const APP_PUBLISH_TOOL_NAME = "assets.publish";

export function createAppPublishTool() {
  return defineTool({
    name: APP_PUBLISH_TOOL_NAME,
    title: { en: "Publish", de: "Veröffentlichen" },
    group: "platform",
    icon: "app",
    effect: "changing",
    description:
      "Ask the person to publish a saved App or Workflow draft. Use only when they ask to share or publish it. Give kind app or workflow, its name and the revision you saved. Nothing goes live until the person confirms. For an App, you may suggest audience self, workspace or instance; the person chooses For whom, and their choice replaces your suggestion. Omit audience to suggest Only me on a first publish or keep the live audience later. A Workflow takes no audience: its confirmation shows what it runs, when and as which account. This never publishes another asset kind, and never bypasses rights or an approver's review.",
    inputSchema: z.object({
      kind: z.enum(["app", WORKFLOW_ASSET_KIND]),
      name: z.string().min(1),
      revision: z.number().int().positive(),
      workspaceId: z.string().optional(),
      audience: z.enum(APP_AUDIENCES).optional()
    }),
    execute: () => toolFailed("handler_failed", "Call publishing through the operation runner")
  });
}
