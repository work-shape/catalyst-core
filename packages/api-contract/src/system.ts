import { timestampSchema } from "./shared";
import { z } from "zod";

export const healthSchema = z.object({
  status: z.literal("ok"),
  clientInstanceId: z.string(),
  time: timestampSchema
});

/**
 * The pinned files a generated view loads from the instance. A change to either file is a new
 * `version`, so an address never serves two contents and can be cached for good.
 */
export const VIEW_RUNTIME = {
  version: "1",
  tailwindFile: "tailwind.js",
  lucideFile: "lucide.js"
} as const;

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
