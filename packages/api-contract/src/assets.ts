import { z } from "zod";
import { agentAvailabilitySchema, configAssetConfigSchema } from "./configuration";
import { timestampSchema } from "./shared";

/** How many puts and deletes one `assets.sync` call may carry. */
export const ASSET_SYNC_MAX_ITEMS = 200;

/**
 * How many items a release may hold: a batch of a holder of the release right, which is applied
 * in one transaction so that a release lands whole or not at all. Each item costs a handful of
 * statements in that transaction, and the request body limit of the server bounds the bytes.
 */
export const ASSET_RELEASE_SYNC_MAX_ITEMS = 2000;

/** Who owns an asset: the instance, or one workspace. */
export const assetScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("instance") }),
  z.object({ kind: z.literal("workspace"), workspaceId: z.string() })
]);

const revisionNumberSchema = z.number().int().positive();

const NUL = "\u0000";
const NUL_REFUSAL = "A name must not contain a NUL byte";

/** Text that names assets, whole or in part. No store holds a NUL byte, so none is accepted. */
function nameText<Schema extends z.ZodType<string>>(schema: Schema) {
  return schema.refine((value) => !value.includes(NUL), NUL_REFUSAL);
}

/** A definition as a call carries it. Its kind reads it; only the name is looked at here. */
const assetDefinitionSchema = configAssetConfigSchema.refine(
  (config) => typeof config.name !== "string" || !config.name.includes(NUL),
  { path: ["name"], message: NUL_REFUSAL }
);

/**
 * The scope a call addresses. Without it the call means the instance's own assets. An asset a
 * workspace owns is reached only by naming that workspace.
 */
const workspaceIdSchema = z.string().min(1).optional();

/**
 * Set on the one asset that is the instance's default of its kind, and left out on every
 * other. Only a kind that holds an instance default, such as the agent, ever carries it.
 */
const isDefaultSchema = z.literal(true).optional();

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
  isDefault: isDefaultSchema,
  /**
   * What the kind says of the asset beside its name, by the kind's own keys: a Connection
   * names its `connectorType`, its `origin` and whether it is `enabled`.
   */
  attributes: z.record(z.string(), z.union([z.string(), z.boolean()])).optional(),
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
  isDefault: isDefaultSchema,
  /**
   * The workspaces the asset is offered in, for a kind that is offered per workspace. Left
   * out where none is stored: such an asset is hidden in every workspace.
   */
  availability: agentAvailabilitySchema.optional(),
  updatedAt: timestampSchema
});

/** Something a write did that its caller should know and that did not refuse it. */
export const assetWarningSchema = z.object({ code: z.string(), message: z.string() });

export const listAssetsQuerySchema = z.object({
  /** Only names that start with this text, such as a Namespace prefix. */
  prefix: nameText(z.string().min(1).max(200)).optional(),
  /** Only names that contain this text, whatever the case. */
  text: nameText(z.string().min(1).max(200)).optional(),
  workspaceId: workspaceIdSchema
});

export const assetScopeQuerySchema = z.object({ workspaceId: workspaceIdSchema });

export const putAssetRequestSchema = z.object({
  config: assetDefinitionSchema,
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

export const setAssetDefaultRequestSchema = z.object({
  /** The asset that becomes the instance's default of its kind, or `null` for none. */
  name: nameText(z.string().min(1)).nullable(),
  /**
   * The id of the named asset as the caller read it. Given, the call is refused with a
   * conflict where the name is held by another asset by now. Left out, nothing is compared.
   */
  expectedAssetId: z.string().min(1).optional()
});

export const setAssetDefaultResponseSchema = z.object({
  /** The version of the instance's whole asset set after the change. */
  version: z.number().int().positive()
});

export const setAssetAvailabilityRequestSchema = z.object({
  mode: agentAvailabilitySchema.shape.mode,
  // Both apply to `selected` only and are ignored for `all`.
  personalWorkspaces: z.boolean().optional(),
  collaborationWorkspaceIds: z.array(z.string().min(1)).optional(),
  /** The id of the asset as the caller read it. Another asset of the name is a conflict. */
  expectedAssetId: z.string().min(1).optional(),
  /**
   * The availability the caller read, or `null` where it read none. Given, the call is
   * refused with a conflict where the stored one differs by now, and nothing is written.
   * Left out, the call replaces whatever is stored.
   */
  expectedAvailability: agentAvailabilitySchema.nullable().optional()
});

export const validateAssetRequestSchema = z.object({
  config: assetDefinitionSchema,
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
    config: assetDefinitionSchema,
    /** The revision the caller last read. Left out, the item creates the asset. */
    expectedRevision: revisionNumberSchema.optional()
  }),
  z.object({
    type: z.literal("delete"),
    kind: z.string().min(1),
    name: nameText(z.string().min(1)),
    expectedRevision: revisionNumberSchema
  })
]);

export const syncAssetsRequestSchema = z.object({
  /**
   * The prefix of the one Namespace the batch belongs to. No item may name an asset outside it.
   * Only a holder of the release right may leave it out: a release names any asset of the
   * instance.
   */
  namespace: nameText(z.string().min(1)).optional(),
  /**
   * At most `ASSET_SYNC_MAX_ITEMS` items, or `ASSET_RELEASE_SYNC_MAX_ITEMS` for a holder of
   * the release right. A batch without items names the default agent.
   */
  items: z.array(assetSyncItemSchema).max(ASSET_RELEASE_SYNC_MAX_ITEMS),
  /**
   * The agent that becomes the instance default with this batch, or `null` for none. Only a
   * holder of the release right may name it. Left out, a release keeps the stored default.
   */
  defaultAgentName: nameText(z.string().min(1)).nullable().optional(),
  /**
   * The default agent the caller last read. Given, a batch made against another is refused,
   * whether or not it changes the default. Only a holder of the release right may send it.
   */
  expectedDefaultAgentName: nameText(z.string().min(1)).nullable().optional()
});

export const assetSyncAppliedItemSchema = z.discriminatedUnion("status", [
  z.object({
    type: z.enum(["put", "delete"]),
    kind: z.string(),
    name: z.string(),
    status: z.literal("applied"),
    revision: revisionNumberSchema
  }),
  // A delete in a release of an asset that is not there: nothing was written for it.
  z.object({
    type: z.literal("delete"),
    kind: z.string(),
    name: z.string(),
    status: z.literal("absent")
  })
]);

export const syncAssetsResponseSchema = z.object({
  version: z.number().int().positive(),
  items: z.array(assetSyncAppliedItemSchema),
  /** Agents a release wrote that are available in no workspace afterwards. */
  hiddenAgentNames: z.array(z.string()).optional(),
  warnings: z.array(assetWarningSchema)
});

/** The answer for a batch a sync would apply. One it would refuse answers the sync's error. */
export const checkAssetSyncResponseSchema = z.object({ valid: z.literal(true) });

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
