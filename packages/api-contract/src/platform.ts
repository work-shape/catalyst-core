import { z } from "zod";

/** One registered asset kind with the action names its rights are checked as. */
export const platformAssetKindSchema = z.object({
  kind: z.string(),
  plural: z.string(),
  /**
   * `active`: the newest write is what the kind's users are served. `draft_published`: a write
   * moves a draft, and `assets.publish` moves what its users are served.
   */
  lifecycle: z.enum(["active", "draft_published"]),
  /** `config`: a revision is its config. `files`: a revision holds a set of files beside it. */
  representation: z.enum(["config", "files"]),
  actions: z.object({
    read: z.string(),
    write: z.string(),
    delete: z.string(),
    /** Named by a kind with the lifecycle `draft_published`. */
    publish: z.string().optional(),
    /**
     * Only for a kind whose assets are used through a right of their own: a Connection, or a
     * kind whose published revision has users of its own.
     */
    use: z.string().optional()
  }),
  /** The file of a `files` kind that holds its manifest. */
  manifestFile: z.string().optional(),
  /** What a write of a `files` kind is held to, by the names of the limits. */
  limits: z
    .object({
      FILE_SET_MAX_FILES: z.number().int().positive(),
      FILE_SET_MAX_FILE_BYTES: z.number().int().positive(),
      FILE_SET_MAX_TOTAL_BYTES: z.number().int().positive(),
      ASSET_PUT_FILES_MAX_BYTES: z.number().int().positive(),
      ASSET_GET_FILES_MAX_BYTES: z.number().int().positive()
    })
    .optional()
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
