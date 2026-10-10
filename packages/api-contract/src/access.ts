import {
  NAMESPACE_PREFIX_MAX_LENGTH,
  NAMESPACE_PREFIX_MIN_LENGTH,
  NAMESPACE_PREFIX_PATTERN
} from "@vivd-catalyst/core";
import { z } from "zod";
import { listQuerySchema, timestampSchema } from "./shared";

export const grantHolderKindSchema = z.enum(["user", "service_principal", "role", "group"]);
export const grantScopeKindSchema = z.enum(["instance", "workspace", "namespace", "asset"]);
export const grantEffectSchema = z.enum(["allow", "deny"]);

/** One row of who may do an action on a scope. A matching deny wins over every allow. */
export const permissionGrantSchema = z.object({
  id: z.string(),
  holderKind: grantHolderKindSchema,
  holderId: z.string(),
  action: z.string(),
  effect: grantEffectSchema,
  scopeKind: grantScopeKindSchema,
  /** The asset id for asset scope, the workspace id for workspace scope. */
  scopeId: z.string().optional(),
  /** The registered prefix, for Namespace scope. */
  namespace: z.string().optional(),
  /** Left out when the user who wrote the row is hidden from the caller. */
  grantedBy: z.string().optional(),
  createdAt: timestampSchema
});

/**
 * The row shape takes every holder and scope kind. Which of them can be written is the
 * server's answer: `details.reason` is `invalid_scope`, `action_not_grantable`,
 * `unknown_action`, `unknown_holder`, `unknown_namespace` or `duplicate_grant`.
 */
export const createPermissionGrantRequestSchema = z.object({
  holderKind: grantHolderKindSchema,
  holderId: z.string().min(1),
  action: z.string().min(1),
  scopeKind: grantScopeKindSchema,
  scopeId: z.string().min(1).optional(),
  namespace: z.string().min(1).optional(),
  effect: grantEffectSchema.default("allow")
});

export const listPermissionGrantsQuerySchema = listQuerySchema.extend({
  holderKind: grantHolderKindSchema.optional(),
  holderId: z.string().min(1).optional(),
  action: z.string().min(1).optional(),
  scopeKind: grantScopeKindSchema.optional()
});

export const effectivePermissionsQuerySchema = z.object({
  holderKind: z.enum(["user", "service_principal"]),
  holderId: z.string().min(1)
});

/** Everything that allows or denies a holder something, each with the source that says so. */
export const effectivePermissionsSchema = z.object({
  /** A holder that is not active holds nothing, whatever the entries say. */
  holderActive: z.boolean(),
  items: z.array(
    z.object({
      action: z.string(),
      effect: grantEffectSchema,
      scopeKind: grantScopeKindSchema,
      scopeId: z.string().optional(),
      namespace: z.string().optional(),
      source: z.enum(["role", "legacy", "legacy_ref", "grant"])
    })
  )
});

export const namespacePrefixSchema = z
  .string()
  .min(NAMESPACE_PREFIX_MIN_LENGTH)
  .max(NAMESPACE_PREFIX_MAX_LENGTH)
  .regex(NAMESPACE_PREFIX_PATTERN);

/**
 * Keeps one Namespace record small. An instance registers tens of tools and model bindings; a
 * longer list is refused as a validation error that names this limit.
 */
export const NAMESPACE_ALLOWLIST_MAX_ENTRIES = 500;

/** `null` does not restrict; an empty list allows nothing. */
const namespaceAllowlistSchema = z
  .array(z.string().min(1))
  .max(NAMESPACE_ALLOWLIST_MAX_ENTRIES, {
    message: `A Namespace allowlist holds at most ${NAMESPACE_ALLOWLIST_MAX_ENTRIES} entries`
  })
  .nullable();

export const namespaceSchema = z.object({
  prefix: z.string(),
  displayName: z.string(),
  allowedToolNames: namespaceAllowlistSchema,
  allowedModelBindingIds: namespaceAllowlistSchema,
  /** Left out when the user who registered it is hidden from the caller. */
  createdBy: z.string().optional(),
  createdAt: timestampSchema
});

export const namespaceUsageSchema = namespaceSchema.extend({
  /** Grant rows that name the prefix. While there is one, the Namespace cannot be deleted. */
  grantCount: z.number().int().nonnegative(),
  /** Active agents and skills whose names start with the prefix. */
  assetCount: z.number().int().nonnegative()
});

export const createNamespaceRequestSchema = z.object({
  prefix: namespacePrefixSchema,
  displayName: z.string().trim().min(1).max(120),
  allowedToolNames: namespaceAllowlistSchema.optional(),
  allowedModelBindingIds: namespaceAllowlistSchema.optional()
});

/** The prefix is fixed. A list left out is kept as it is. */
export const updateNamespaceRequestSchema = z.object({
  displayName: z.string().trim().min(1).max(120).optional(),
  allowedToolNames: namespaceAllowlistSchema.optional(),
  allowedModelBindingIds: namespaceAllowlistSchema.optional()
});
