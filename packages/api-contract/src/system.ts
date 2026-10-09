import { timestampSchema } from "./shared";
import { z } from "zod";

export const healthSchema = z.object({
  status: z.literal("ok"),
  clientInstanceId: z.string(),
  time: timestampSchema
});

/** The database answers and holds every migration this release was built with. */
export const readySchema = z.object({
  status: z.literal("ready"),
  /** The newest migration of this release. */
  migration: z.string()
});

/**
 * Why this process cannot serve. `missing` names the migrations of this release the database
 * lacks, oldest first, and is present when the database is behind.
 */
export const notReadySchema = z.object({
  status: z.literal("not_ready"),
  reason: z.enum(["database_unreachable", "database_behind"]),
  missing: z.array(z.string()).optional()
});

/** Either answer of `/ready`. */
export const readinessSchema = z.discriminatedUnion("status", [readySchema, notReadySchema]);

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
export type Readiness = z.infer<typeof readinessSchema>;
export type CapturedMail = z.infer<typeof capturedMailSchema>;
