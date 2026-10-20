import {
  NOTICE_ID_PATTERN,
  NOTIFY_CHANNELS,
  workflowInputValueSchema
} from "@work-shape/catalyst-core";
import { z } from "zod";
import { named, type StepModule } from "./module";

export const notifyStep = {
  schema: () =>
    z.strictObject({
      ...named,
      type: z.literal("notify"),
      to: z
        .strictObject({
          users: z.array(z.string().regex(NOTICE_ID_PATTERN)).optional(),
          workspaces: z.array(z.string().regex(NOTICE_ID_PATTERN)).optional()
        })
        .refine(
          (to) => (to.users?.length ?? 0) + (to.workspaces?.length ?? 0) > 0,
          "A notify step needs recipients"
        ),
      channels: z
        .array(z.enum(NOTIFY_CHANNELS))
        .min(1)
        .refine((channels) => channels.includes("inbox"), "A notice always includes inbox"),
      title: workflowInputValueSchema,
      text: workflowInputValueSchema,
      link: z
        .discriminatedUnion("kind", [
          z.strictObject({ kind: z.literal("run") }),
          z.strictObject({
            kind: z.literal("app"),
            workspaceId: z.string().min(1),
            app: z.string().min(1)
          })
        ])
        .optional()
    })
} satisfies StepModule<"notify">;
