import { APP_AUDIENCES } from "@work-shape/catalyst-asset-schemas";
import { defineTool, toolFailed } from "@work-shape/catalyst-tool-sdk";
import { z } from "zod";

/** Describes the existing asset operation; the operation runner owns every publish gate. */
export const APP_PUBLISH_TOOL_NAME = "assets.publish";

export function createAppPublishTool() {
  return defineTool({
    name: APP_PUBLISH_TOOL_NAME,
    title: { en: "Share App", de: "App teilen" },
    group: "platform",
    icon: "app",
    effect: "changing",
    description:
      "Ask the person to publish a saved App revision. Use only when they ask to share or publish it. Give kind app, its name and revision, and suggest audience self, workspace or instance. The person chooses For whom and confirms before anything goes live; their choice replaces your suggestion. Omit audience to suggest Only me on a first publish or keep the live audience later. This never publishes another asset kind, and never bypasses rights or an approver's review.",
    inputSchema: z.object({
      kind: z.literal("app"),
      name: z.string().min(1),
      revision: z.number().int().positive(),
      workspaceId: z.string().optional(),
      audience: z.enum(APP_AUDIENCES).optional()
    }),
    execute: () => toolFailed("handler_failed", "Call App publishing through the operation runner")
  });
}
