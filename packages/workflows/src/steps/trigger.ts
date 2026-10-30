import {
  WORKFLOW_TRIGGER_EVENTS,
  WORKFLOW_TRIGGER_EVENT_NAMES,
  WORKFLOW_WEBHOOK_LIMITS,
  isWorkflowTriggerEventName,
  workflowScheduleOptionsSchema,
  type WorkflowTriggerEventName
} from "@work-shape/catalyst-core";
import { z } from "zod";
import { isTimeZone, parseCron } from "../cron";
import { named, notSupported, type StepModule, type StepOf } from "./module";

/** The name of an asset a `platform_event` filter names: an id of the asset kind. */
const sourceName = z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/u, "Name the source by its id");

export const triggerStep = {
  schema: () =>
    z.strictObject({
      ...named,
      type: z.literal("trigger"),
      triggers: z
        .array(
          z.discriminatedUnion("kind", [
            z.strictObject({ kind: z.literal("manual") }),
            z.strictObject({
              kind: z.literal("schedule"),
              cron: z.string().min(1),
              timeZone: z
                .string()
                .min(1)
                .refine(isTimeZone, "Use an IANA time zone such as Europe/Berlin, or UTC")
                .optional(),
              ...workflowScheduleOptionsSchema.shape
            }),
            z.strictObject({ kind: z.literal("parent") }),
            z.strictObject({ kind: z.literal("outside") }),
            z.strictObject({
              kind: z.literal("webhook"),
              perMinute: z
                .number()
                .int()
                .min(1)
                .max(WORKFLOW_WEBHOOK_LIMITS.perMinuteMax)
                .optional()
            }),
            z.strictObject({
              kind: z.literal("platform_event"),
              event: z.custom<WorkflowTriggerEventName>(
                (value) => typeof value === "string" && isWorkflowTriggerEventName(value),
                `A platform event is one of ${WORKFLOW_TRIGGER_EVENT_NAMES.join(", ")}`
              ),
              filter: z.record(z.string(), sourceName).optional()
            })
          ])
        )
        .min(1)
    }),
  // A trigger that is read and never fires would look like one that is kept.
  unsupported: (step: StepOf<"trigger">, at: string) =>
    step.triggers.flatMap((trigger, number) => {
      const here = `${at}.triggers[${number}]`;
      if (trigger.kind !== "schedule") return [];
      // A schedule fires the latest of the due times it missed and skips a due time
      // that meets an open run. The other ways are read and not built.
      return [
        ...(trigger.missed !== undefined && trigger.missed !== "last"
          ? [notSupported(`${here}.missed`, `'missed: ${trigger.missed}'`)]
          : []),
        ...(trigger.overlap !== undefined && trigger.overlap !== "skip"
          ? [notSupported(`${here}.overlap`, `'overlap: ${trigger.overlap}'`)]
          : [])
      ];
    }),
  structural: (step: StepOf<"trigger">, id: string) => [
    ...step.triggers.flatMap((trigger) =>
      trigger.kind === "schedule" && !parseCron(trigger.cron)
        ? [
            {
              path: `steps.${id}.triggers`,
              message: `'${trigger.cron}' is no cron expression of five fields: minute, hour, day of month, month and day of week`
            }
          ]
        : []
    ),
    // One address and one secret per Workflow: a second webhook would share both.
    ...(step.triggers.filter((trigger) => trigger.kind === "webhook").length > 1
      ? [{ path: `steps.${id}.triggers`, message: "A Workflow has at most one webhook trigger" }]
      : []),
    ...step.triggers.flatMap((trigger) => {
      if (trigger.kind !== "platform_event") return [];
      const key = WORKFLOW_TRIGGER_EVENTS[trigger.event].filter;
      return Object.keys(trigger.filter ?? {})
        .filter((field) => field !== key)
        .map((field) => ({
          path: `steps.${id}.triggers`,
          message: `The event '${trigger.event}' is filtered by '${key}' only, not by '${field}'`
        }));
    })
  ]
} satisfies StepModule<"trigger">;
