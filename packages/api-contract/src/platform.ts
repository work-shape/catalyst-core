import { z } from "zod";

/** One registered asset kind with the action names its rights are checked as. */
export const platformAssetKindSchema = z.object({
  kind: z.string(),
  plural: z.string(),
  actions: z.object({ read: z.string(), write: z.string(), delete: z.string() })
});

/** A Namespace the caller holds a right in, with the actions that right covers there. */
export const platformContextNamespaceSchema = z.object({
  prefix: z.string(),
  displayName: z.string(),
  actions: z.array(z.string())
});

/** Where a caller is and what it can do there: the first read of an outside editor. */
export const platformContextSchema = z.object({
  instance: z.object({ id: z.string(), name: z.string() }),
  release: z.object({ version: z.string() }),
  kinds: z.array(platformAssetKindSchema),
  namespaces: z.array(platformContextNamespaceSchema)
});

export type PlatformContext = z.infer<typeof platformContextSchema>;
