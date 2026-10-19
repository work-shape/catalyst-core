import { SCHEDULED_START_STATES } from "@work-shape/catalyst-core";
import { defineTool, toolFailed, type AnyToolDefinition } from "@work-shape/catalyst-tool-sdk";

import { z } from "zod";

const scheduledStartFieldsSchema = z.strictObject({
  agentName: z.string().trim().min(1).max(200),
  prompt: z.string().trim().min(1).max(100_000),
  cron: z.string().trim().min(1).max(128),
  timeZone: z.string().trim().min(1).max(100).optional()
});
const createScheduledStartSchema = scheduledStartFieldsSchema.extend({
  collaborationWorkspaceId: z.string().min(1)
});

/** Projections of the same owner-bound operations the Scheduled page calls. */
export const SCHEDULED_START_TOOL_NAMES: readonly string[] = [
  "scheduled_starts.create",
  "scheduled_starts.update",
  "scheduled_starts.list",
  "scheduled_starts.set_state",
  "scheduled_starts.delete"
];

export function createScheduledStartTools(): AnyToolDefinition[] {
  const common = {
    group: "platform",
    icon: "clock",
    execute: () =>
      toolFailed("handler_failed", "Call scheduled prompts through the operation runner")
  } as const;
  const scheduledStartId = z
    .string()
    .min(1)
    .describe("The id returned by scheduled_starts.list or create.");
  return [
    defineTool({
      ...common,
      name: "scheduled_starts.create",
      title: { en: "Schedule prompt", de: "Prompt planen" },
      effect: "changing",
      description:
        "Save a prompt on an agent the person can use in this workspace, to run unattended as them with their current rights. Use platform.context for workspace and instance.timeZone; list available agents there first. Write a five-field cron at the person's wall-clock hour, with an IANA timeZone (German time: Europe/Berlin), defaulting to the instance zone. Never subtract a UTC offset. The confirmation shows agent, prompt and when; nothing is saved until the person allows it. Results are private conversations under Scheduled (Geplant). Calls needing confirmation wait in their Inbox and the next due time is skipped while waiting.",
      inputSchema: createScheduledStartSchema.extend({ timeZone: z.string().min(1).max(100) })
    }),
    defineTool({
      ...common,
      name: "scheduled_starts.update",
      title: { en: "Change scheduled prompt", de: "Geplanten Prompt ändern" },
      effect: "changing",
      description:
        "Change the person's own scheduled prompt after listing it. Supply the complete agent, prompt, cron and IANA zone shown in the confirmation. Nothing changes until Allow. Other people's starts cannot be changed.",
      inputSchema: scheduledStartFieldsSchema.extend({
        scheduledStartId,
        timeZone: z.string().min(1).max(100)
      })
    }),
    defineTool({
      ...common,
      name: "scheduled_starts.list",
      title: { en: "List scheduled prompts", de: "Geplante Prompts lesen" },
      effect: "reading",
      description:
        "List only this person's scheduled prompts, including state and next due time. Optionally filter by collaborationWorkspaceId. Follow nextCursor using cursor with the same filters before claiming a start does not exist.",
      inputSchema: z.object({
        collaborationWorkspaceId: z.string().optional(),
        limit: z.string().optional(),
        cursor: z.string().optional()
      })
    }),
    defineTool({
      ...common,
      name: "scheduled_starts.set_state",
      title: {
        en: "Pause or resume scheduled prompt",
        de: "Geplanten Prompt pausieren oder fortsetzen"
      },
      effect: "changing",
      description:
        "Pause or resume the person's own saved prompt, after listing it to find its id. state paused stops future ticks; active resumes at the next due time. The person confirms the change.",
      inputSchema: z.object({ scheduledStartId, state: z.enum(SCHEDULED_START_STATES) })
    }),
    defineTool({
      ...common,
      name: "scheduled_starts.delete",
      title: { en: "Delete scheduled prompt", de: "Geplanten Prompt löschen" },
      effect: "changing",
      description:
        "Delete the person's own scheduled prompt after they ask, using its id from scheduled_starts.list. Stops future ticks and preserves existing result conversations. The person confirms before deletion.",
      inputSchema: z.object({ scheduledStartId })
    })
  ];
}
