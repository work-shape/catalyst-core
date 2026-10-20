import { workflowScheduleOptionsSchema } from "@work-shape/catalyst-core";
import { z } from "zod";
import { isTimeZone, parseCron } from "../cron";
import { named, notSupported, type StepModule, type StepOf } from "./module";

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
            z.strictObject({ kind: z.literal("parent") })
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
  structural: (step: StepOf<"trigger">, id: string) =>
    step.triggers.flatMap((trigger) =>
      trigger.kind === "schedule" && !parseCron(trigger.cron)
        ? [
            {
              path: `steps.${id}.triggers`,
              message: `'${trigger.cron}' is no cron expression of five fields: minute, hour, day of month, month and day of week`
            }
          ]
        : []
    )
} satisfies StepModule<"trigger">;
