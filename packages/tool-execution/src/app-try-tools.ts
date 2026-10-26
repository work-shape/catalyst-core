import { defineTool, toolFailed, type AnyToolDefinition } from "@work-shape/catalyst-tool-sdk";
import { z } from "zod";

/** Agent projections of the App operations that try a draft and review its publish (DP-2). */
export const APP_TRY_TOOL_NAMES: readonly string[] = ["apps.try_action", "apps.publish_review"];

/**
 * Descriptions for the model of two existing operations. The tool runner calls the registered
 * operations: the same rights, subject check, draft context and run as the API.
 */
export function createAppTryTools(): AnyToolDefinition[] {
  const presentation = { group: "platform", icon: "app" } as const;
  const app = z
    .string()
    .min(1)
    .describe("The id of the conversation's subject App, or of an App this conversation created.");
  const execute = () => toolFailed("handler_failed", "Call App tools through the operation runner");
  return [
    defineTool({
      ...presentation,
      name: "apps.try_action",
      title: { en: "Try App action", de: "App-Aktion ausprobieren" },
      effect: "changing",
      permission: { mode: "allow" },
      description: [
        "Try one named action of an App's saved draft as the person's click in the draft does, and see its answer: the conversation's subject App or one this conversation created.",
        "Reading actions read live; changing ones are simulated (dry_run, with what they would have done) unless the person switched on Run live once. A workflow action starts a test run, never a live run: its answer names workflowRun; follow it with workflows.get_run and workflows.list_step_runs and report each step's target and result."
      ].join(" "),
      inputSchema: z.object({
        app,
        action: z.string().min(1).describe("The name of the action in the App's manifest."),
        input: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("The action's parameters by name.")
      }),
      execute
    }),
    defineTool({
      ...presentation,
      name: "apps.publish_review",
      title: { en: "Review App publish", de: "Veröffentlichung der App prüfen" },
      effect: "reading",
      description: [
        "Read what publishing an App's draft comes to, changing nothing: the App, each Workflow its actions call, children first, and each Data Store it binds with a pending draft and the migrations that would apply, whether each has a pending draft, the sentence its publish question leads with, and what would refuse each publish now. The conversation's subject App or one this conversation created.",
        "When the person wants it live and ready is true, call assets.publish with the App's draftRevision and each pending Workflow in workflows. Name every refusal and who can resolve it; never claim anything is live.",
        "Each entry has 'href', the path of its page. Link the place with its href when the person must act there, as [its title](href), and never build a path yourself."
      ].join(" "),
      inputSchema: z.object({ app }),
      execute
    })
  ];
}
