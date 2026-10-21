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
        "Try one named action of the saved draft of an App, exactly as the person's click on its button in the draft does, and see its answer. Only the conversation's subject App or an App this conversation created.",
        "Reading actions read live. Changing actions are simulated (status dry_run, with what they would have done) unless the person switched on Run live once. A workflow action starts a test run of the Workflow it calls: its draft where the person may write that Workflow, else its published revision, never a live run. The answer names the test run as workflowRun with its runId and which revision runs; follow it with workflows.get_run and workflows.list_step_runs and report each step's target and result.",
        "Use this to try an App and the Workflow behind it before anything is published. Never ask the person to publish in order to try something."
      ].join(" "),
      inputSchema: z.object({
        app,
        action: z.string().min(1).describe("The name of the action in the App's manifest."),
        input: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("The action's parameters, by name, as the App's page passes them.")
      }),
      execute
    }),
    defineTool({
      ...presentation,
      name: "apps.publish_review",
      title: { en: "Review App publish", de: "Veröffentlichung der App prüfen" },
      effect: "reading",
      description: [
        "Read what publishing an App's draft comes to, before you ask the person: the App and each Workflow its actions call, whether each has a pending draft, the sentence its publish question leads with, and what would refuse each publish now (a missing right or a check). It changes nothing. Only the conversation's subject App or an App this conversation created.",
        "Workflows come children first, and pending ones are made live with the App by one Publish: when the person wants it live and ready is true, call assets.publish with kind app, the App's draftRevision and, in workflows, each pending Workflow with its draftRevision, and tell them in one sentence what that one click makes live. Name every refusal and who can resolve it; never claim anything is live."
      ].join(" "),
      inputSchema: z.object({ app }),
      execute
    })
  ];
}
