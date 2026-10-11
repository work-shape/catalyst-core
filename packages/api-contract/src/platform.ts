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
  /**
   * The actions of the listed kinds the caller can use on the instance's own assets as a
   * whole, whatever their names. A right in one Namespace or on one asset is not among them.
   */
  actions: z.array(z.string()),
  /**
   * The read actions of the listed kinds a grant allows the caller on one asset or on what one
   * workspace owns. Which assets those are, the kind's list says: a deny or a deleted asset can
   * leave it empty.
   */
  assetActions: z.array(z.string()),
  namespaces: z.array(platformContextNamespaceSchema)
});

export type PlatformContext = z.infer<typeof platformContextSchema>;
