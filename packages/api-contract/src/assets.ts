import { z } from "zod";
import { configAssetConfigSchema } from "./configuration";
import { timestampSchema } from "./shared";

/** How many puts and deletes one `assets.sync` call may carry. */
export const ASSET_SYNC_MAX_ITEMS = 200;

/** Who owns an asset: the instance, or one workspace. */
export const assetScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("instance") }),
  z.object({ kind: z.literal("workspace"), workspaceId: z.string() })
]);

const revisionNumberSchema = z.number().int().positive();

/**
 * The scope a call addresses. Without it the call means the instance's own assets. An asset a
 * workspace owns is reached only by naming that workspace.
 */
const workspaceIdSchema = z.string().min(1).optional();

/** One asset as a list shows it: what every kind can say about itself, without its content. */
export const assetSummarySchema = z.object({
  /** What an asset-scoped grant names as its `scopeId`. */
  id: z.string(),
  kind: z.string(),
  name: z.string(),
  title: z.string(),
  description: z.string().optional(),
  scope: assetScopeSchema,
  /** The prefix of the Namespace the name belongs to, where it belongs to one. */
  namespace: z.string().optional(),
  revision: revisionNumberSchema,
  updatedAt: timestampSchema
});

export const assetSchema = z.object({
  id: z.string(),
  kind: z.string(),
  name: z.string(),
  scope: assetScopeSchema,
  namespace: z.string().optional(),
  revision: revisionNumberSchema,
  config: configAssetConfigSchema,
  updatedAt: timestampSchema
});

/** Something a write did that its caller should know and that did not refuse it. */
export const assetWarningSchema = z.object({ code: z.string(), message: z.string() });

export const listAssetsQuerySchema = z.object({
  /** Only names that start with this text, such as a Namespace prefix. */
  prefix: z.string().min(1).max(200).optional(),
  /** Only names that contain this text, whatever the case. */
  text: z.string().min(1).max(200).optional(),
  workspaceId: workspaceIdSchema
});

export const assetScopeQuerySchema = z.object({ workspaceId: workspaceIdSchema });

export const putAssetRequestSchema = z.object({
  config: configAssetConfigSchema,
  /**
   * The revision the caller last read. Left out, the call creates the asset and is refused
   * when the name exists.
   */
  expectedRevision: revisionNumberSchema.optional(),
  workspaceId: workspaceIdSchema
});

export const assetWriteResponseSchema = z.object({
  /** The version of the instance's whole asset set after the write. */
  version: z.number().int().positive(),
  /** The revision the write left the asset at. A delete is a revision too. */
  revision: revisionNumberSchema,
  warnings: z.array(assetWarningSchema)
});

export const deleteAssetRequestSchema = z.object({
  /** The revision the caller last read. A delete is never made blind. */
  expectedRevision: revisionNumberSchema,
  workspaceId: workspaceIdSchema
});

export const revertAssetRequestSchema = z.object({
  /** The revision whose content becomes the asset's content again. */
  revision: revisionNumberSchema,
  /** The revision the asset is at now, a deleted asset's last one included. */
  expectedRevision: revisionNumberSchema,
  workspaceId: workspaceIdSchema
});

export const validateAssetRequestSchema = z.object({
  config: configAssetConfigSchema,
  workspaceId: workspaceIdSchema
});

export const assetValidationIssueSchema = z.object({
  message: z.string(),
  path: z.array(z.string()).optional()
});

export const validateAssetResponseSchema = z.object({
  valid: z.boolean(),
  issues: z.array(assetValidationIssueSchema)
});

export const assetSyncItemSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("put"),
    kind: z.string().min(1),
    config: configAssetConfigSchema,
    /** The revision the caller last read. Left out, the item creates the asset. */
    expectedRevision: revisionNumberSchema.optional()
  }),
  z.object({
    type: z.literal("delete"),
    kind: z.string().min(1),
    name: z.string().min(1),
    expectedRevision: revisionNumberSchema
  })
]);

export const syncAssetsRequestSchema = z.object({
  /** The prefix of the one Namespace the batch belongs to. No item may name an asset outside it. */
  namespace: z.string().min(1),
  items: z.array(assetSyncItemSchema).min(1).max(ASSET_SYNC_MAX_ITEMS)
});

export const assetSyncAppliedItemSchema = z.object({
  type: z.enum(["put", "delete"]),
  kind: z.string(),
  name: z.string(),
  status: z.literal("applied"),
  revision: revisionNumberSchema
});

export const syncAssetsResponseSchema = z.object({
  version: z.number().int().positive(),
  items: z.array(assetSyncAppliedItemSchema),
  warnings: z.array(assetWarningSchema)
});

/**
 * One item of a refused `assets.sync`, in `details.items` of the error. Nothing of the batch
 * was applied: `refused` names an item that stopped it and says why, `not_applied` an item
 * that would have been written.
 */
export const assetSyncRefusedItemSchema = z.object({
  index: z.number().int().nonnegative(),
  type: z.enum(["put", "delete"]),
  kind: z.string(),
  name: z.string().optional(),
  status: z.enum(["refused", "not_applied"]),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      action: z.string().optional(),
      currentRevision: revisionNumberSchema.nullable().optional()
    })
    .optional()
});

export type AssetScope = z.infer<typeof assetScopeSchema>;
export type AssetSummary = z.infer<typeof assetSummarySchema>;
export type Asset = z.infer<typeof assetSchema>;
export type AssetSyncItem = z.infer<typeof assetSyncItemSchema>;
export type AssetSyncRefusedItem = z.infer<typeof assetSyncRefusedItemSchema>;
