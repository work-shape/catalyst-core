import { timestampSchema } from "./shared";
import { FIRST_PARTY_AUTH_SCOPES } from "@vivd-catalyst/core";
import { z } from "zod";

export const authScopeSchema = z.enum(FIRST_PARTY_AUTH_SCOPES);

export const chatSessionAuthScopeSchema = z.enum([
  "me:read",
  "me:delete",
  "config:read",
  "conversation:read",
  "conversation:write",
  "collaboration_workspace:read",
  "collaboration_workspace:manage",
  "run:start",
  "run:observe",
  "run:cancel",
  "run:command"
]);

export const authPrincipalSchema = z.object({
  kind: z.enum(["user", "service"]),
  id: z.string(),
  displayLabel: z.string(),
  clientInstanceId: z.string(),
  authSource: z.string(),
  externalUserId: z.string().optional()
});

export const delegatedActorSchema = z.object({
  kind: z.literal("service_principal").default("service_principal"),
  id: z.string(),
  displayLabel: z.string().optional(),
  authSource: z.string()
});

export const apiUserSchema = z.object({
  id: z.string(),
  externalUserId: z.string(),
  displayLabel: z.string(),
  email: z.string().optional(),
  emailVerified: z.boolean().optional(),
  roles: z.array(z.string()),
  permissionRefs: z.array(z.string()),
  permissions: z.array(z.string()),
  clientInstanceId: z.string(),
  authSource: z.string(),
  principal: authPrincipalSchema.optional(),
  subjectUserId: z.string().optional(),
  delegatedActor: delegatedActorSchema.optional(),
  scopes: z.array(authScopeSchema).optional()
});

export const issueSessionTokenRequestSchema = z.object({
  externalUserId: z.string().min(1),
  displayLabel: z.string().min(1),
  email: z.string().email().optional(),
  emailVerified: z.boolean().optional(),
  roles: z.array(z.string()).optional(),
  permissionRefs: z.array(z.string()).optional(),
  permissions: z.array(z.string()).optional(),
  correlationId: z.string().optional(),
  scopes: z.array(authScopeSchema.exclude(["*"])).optional(),
  delegatedActor: delegatedActorSchema.optional()
});

export const issueSessionTokenResponseSchema = z.object({
  chatSessionToken: z.string(),
  expiresAt: timestampSchema
});

export const exchangeApiKeyResponseSchema = z.object({
  accessToken: z.string(),
  expiresAt: timestampSchema
});

/** What an administrator sets. */
export const userStatusSchema = z.enum(["active", "disabled"]);
/**
 * The status a user is read with. `deleting`: the deletion of the account was accepted, the
 * user is closed and their data is being removed.
 */
export const administeredUserStatusSchema = z.enum(["active", "disabled", "deleting"]);

export const administeredUserIdentitySchema = z.object({
  clientInstanceId: z.string(),
  userId: z.string(),
  authSource: z.string(),
  externalUserId: z.string(),
  displayLabel: z.string().optional(),
  email: z.string().optional(),
  emailVerified: z.boolean(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  lastAuthenticatedAt: timestampSchema.optional()
});

export const administeredUserSchema = z.object({
  id: z.string(),
  clientInstanceId: z.string(),
  displayLabel: z.string(),
  email: z.string().optional(),
  roles: z.array(z.string()),
  permissionRefs: z.array(z.string()),
  permissions: z.array(z.string()),
  status: administeredUserStatusSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  lastAuthenticatedAt: timestampSchema.optional(),
  identities: z.array(administeredUserIdentitySchema)
});

export const administeredUserPasswordSignInRequestSchema = z.object({
  password: z.string().min(8)
});

export const createAdministeredUserRequestSchema = z.object({
  displayLabel: z.string().min(1),
  email: z.string().email().optional(),
  roles: z.array(z.string()).optional(),
  permissionRefs: z.array(z.string()).optional(),
  permissions: z.array(z.string()).optional(),
  status: userStatusSchema.optional(),
  passwordSignIn: administeredUserPasswordSignInRequestSchema.optional()
});

export const updateAdministeredUserRequestSchema = z.object({
  displayLabel: z.string().min(1).optional(),
  email: z.string().email().nullable().optional(),
  roles: z.array(z.string()).optional(),
  permissionRefs: z.array(z.string()).optional(),
  permissions: z.array(z.string()).optional(),
  status: userStatusSchema.optional()
});

export const updateCurrentUserRequestSchema = z.object({
  displayLabel: z.string().min(1)
});

export const changeCurrentUserPasswordRequestSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8)
});

export const changeCurrentUserPasswordResponseSchema = z.object({
  ok: z.literal(true)
});

export const deleteCurrentUserResponseSchema = z.object({
  ok: z.literal(true)
});

export const upsertAdministeredUserIdentityRequestSchema = z.object({
  authSource: z.string().min(1),
  externalUserId: z.string().min(1),
  displayLabel: z.string().min(1).optional(),
  email: z.string().email().optional(),
  emailVerified: z.boolean().optional()
});

export const resetAdministeredUserPasswordRequestSchema = z.object({
  password: z.string().min(8)
});

export const resetAdministeredUserPasswordResponseSchema = z.object({
  ok: z.literal(true)
});

export const requestPasswordResetRequestSchema = z.object({
  email: z.string().email()
});

export const requestPasswordResetResponseSchema = z.object({
  ok: z.literal(true)
});

export const completePasswordSetupRequestSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8)
});

export const completePasswordSetupResponseSchema = z.object({
  ok: z.literal(true)
});

export const sendAdministeredUserInvitationResponseSchema = z.object({
  ok: z.literal(true)
});

export const servicePrincipalStatusSchema = z.enum(["active", "disabled"]);

export const servicePrincipalPermissionSchema = z.enum([
  "config_assets.read",
  "config_assets.release"
]);

export const apiCredentialScopeSchema = z.enum(["config_assets:read", "config_assets:release"]);

export const apiCredentialSchema = z.object({
  id: z.string(),
  clientInstanceId: z.string(),
  servicePrincipalId: z.string(),
  name: z.string(),
  keyPrefix: z.string(),
  scopes: z.array(apiCredentialScopeSchema).optional(),
  createdAt: timestampSchema,
  expiresAt: timestampSchema.optional(),
  revokedAt: timestampSchema.optional(),
  lastUsedAt: timestampSchema.optional()
});

export const servicePrincipalSchema = z.object({
  id: z.string(),
  clientInstanceId: z.string(),
  displayLabel: z.string(),
  description: z.string().optional(),
  status: servicePrincipalStatusSchema,
  permissionRefs: z.array(z.string()),
  permissions: z.array(servicePrincipalPermissionSchema),
  createdByUserId: z.string().optional(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  lastUsedAt: timestampSchema.optional()
});

export const servicePrincipalDetailSchema = z.object({
  principal: servicePrincipalSchema,
  credentials: z.array(apiCredentialSchema)
});

export const createServicePrincipalRequestSchema = z.object({
  displayLabel: z.string().trim().min(1),
  description: z.string().trim().min(1).optional(),
  status: servicePrincipalStatusSchema.optional(),
  permissions: z.array(servicePrincipalPermissionSchema).optional()
});

export const updateServicePrincipalRequestSchema = z
  .object({
    displayLabel: z.string().trim().min(1).optional(),
    description: z.string().trim().min(1).nullable().optional(),
    status: servicePrincipalStatusSchema.optional(),
    permissions: z.array(servicePrincipalPermissionSchema).optional()
  })
  .refine((value) => Object.values(value).some((entry) => entry !== undefined), {
    message: "At least one service principal field must be provided"
  });

export const createApiCredentialRequestSchema = z.object({
  name: z.string().trim().min(1),
  scopes: z.array(apiCredentialScopeSchema).optional(),
  expiresAt: timestampSchema.optional()
});

export const createApiCredentialResponseSchema = z.object({
  credential: apiCredentialSchema,
  secret: z.string()
});

export const auditActorSchema = z.object({
  userId: z.string().optional(),
  externalUserId: z.string().optional(),
  displayLabel: z.string(),
  roles: z.array(z.string()),
  principalKind: z.enum(["user", "service"]).optional(),
  principalId: z.string().optional(),
  principalDisplayLabel: z.string().optional(),
  credentialId: z.string().optional(),
  subjectUserId: z.string().optional(),
  delegatedActor: delegatedActorSchema.optional()
});

export type ApiUser = z.infer<typeof apiUserSchema>;
export type AuthScope = z.infer<typeof authScopeSchema>;
export type ChatSessionAuthScope = z.infer<typeof chatSessionAuthScopeSchema>;
export type AuthPrincipal = z.infer<typeof authPrincipalSchema>;
export type DelegatedActor = z.infer<typeof delegatedActorSchema>;
export type AdministeredUser = z.infer<typeof administeredUserSchema>;
export type AdministeredUserIdentity = z.infer<typeof administeredUserIdentitySchema>;
export type CreateAdministeredUserRequest = z.infer<typeof createAdministeredUserRequestSchema>;
export type UpdateAdministeredUserRequest = z.infer<typeof updateAdministeredUserRequestSchema>;
export type UpdateCurrentUserRequest = z.infer<typeof updateCurrentUserRequestSchema>;
export type ChangeCurrentUserPasswordRequest = z.infer<
  typeof changeCurrentUserPasswordRequestSchema
>;
export type UpsertAdministeredUserIdentityRequest = z.infer<
  typeof upsertAdministeredUserIdentityRequestSchema
>;
export type ResetAdministeredUserPasswordRequest = z.infer<
  typeof resetAdministeredUserPasswordRequestSchema
>;
export type ServicePrincipalPermission = z.infer<typeof servicePrincipalPermissionSchema>;
export type ApiCredentialScope = z.infer<typeof apiCredentialScopeSchema>;
export type ApiCredential = z.infer<typeof apiCredentialSchema>;
export type ServicePrincipal = z.infer<typeof servicePrincipalSchema>;
export type ServicePrincipalDetail = z.infer<typeof servicePrincipalDetailSchema>;
export type CreateServicePrincipalRequest = z.infer<typeof createServicePrincipalRequestSchema>;
export type UpdateServicePrincipalRequest = z.infer<typeof updateServicePrincipalRequestSchema>;
export type CreateApiCredentialRequest = z.infer<typeof createApiCredentialRequestSchema>;
export type CreateApiCredentialResponse = z.infer<typeof createApiCredentialResponseSchema>;
export type AuditActor = z.infer<typeof auditActorSchema>;
