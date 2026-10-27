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
      "Offer the publish confirmation card for a saved App or Workflow draft when the person asks to share or publish it, or at the end of a build step that leads to going live: give the kind, name and the revision you saved. Nothing goes live before they confirm. For an App, read apps.publish_review first and name in workflows each Workflow it lists as pending and in dataStores each Data Store it lists as pending, each with its draftRevision: one confirmation publishes the stores and applies their migrations, then the Workflows and the App, or none of the App and its Workflows. An App's audience (self, workspace or instance) is only your suggestion; the person chooses. Omitted, it suggests Only me on a first publish and keeps the live audience later. A Workflow takes no audience.",
    inputSchema: z.object({
      kind: z.enum(["app", WORKFLOW_ASSET_KIND]),
      name: z.string().min(1),
      revision: z.number().int().positive(),
      workspaceId: z.string().optional(),
      audience: z.enum(APP_AUDIENCES).optional(),
      workflows: z
        .array(z.object({ name: z.string().min(1), revision: z.number().int().positive() }))
        .optional(),
      dataStores: z
        .array(z.object({ name: z.string().min(1), revision: z.number().int().positive() }))
        .optional()
    }),
    execute: () => toolFailed("handler_failed", "Call publishing through the operation runner")
  });
}
