import { timestampSchema } from "./shared";
import { z } from "zod";

export const healthSchema = z.object({
  status: z.literal("ok"),
  clientInstanceId: z.string(),
  time: timestampSchema
});

export const capturedMailSchema = z.object({
  id: z.string(),
  to: z.object({
    email: z.string(),
    displayLabel: z.string().optional()
  }),
  subject: z.string(),
  text: z.string(),
  html: z.string(),
  sentAt: timestampSchema
});

export type Health = z.infer<typeof healthSchema>;
export type CapturedMail = z.infer<typeof capturedMailSchema>;
