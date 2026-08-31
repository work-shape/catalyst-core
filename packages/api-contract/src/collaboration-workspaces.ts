import { z } from "zod";

export const workspaceVisibilitySchema = z.enum(["discoverable", "private"]);
export const workspaceMembershipRoleSchema = z.enum(["owner", "admin", "member"]);
export type WorkspaceMembershipRole = z.infer<typeof workspaceMembershipRoleSchema>;
export const workspaceAccentColorSchema = z.enum([
  "ruby",
  "amber",
  "emerald",
  "sapphire",
  "violet",
  "rose",
  "teal",
  "slate"
]);

export const collaborationWorkspaceSchema = z.object({
  id: z.string(),
  clientInstanceId: z.string(),
  kind: z.enum(["personal", "shared"]),
  name: z.string(),
  description: z.string().nullable(),
  visibility: workspaceVisibilitySchema,
  emoji: z.string().nullable(),
  accentColor: workspaceAccentColorSchema.nullable(),
  personalUserId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const collaborationWorkspaceWithRoleSchema = collaborationWorkspaceSchema.extend({
  role: workspaceMembershipRoleSchema,
  pendingAccessRequestCount: z.number().int().nonnegative()
});

export const collaborationWorkspaceDirectoryItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  emoji: z.string().nullable(),
  accentColor: workspaceAccentColorSchema.nullable(),
  accessState: z.enum(["member", "request_pending", "can_request"])
});

export const workspaceMembershipSchema = z.object({
  collaborationWorkspaceId: z.string(),
  clientInstanceId: z.string(),
  userId: z.string(),
  role: workspaceMembershipRoleSchema,
  createdAt: z.string(),
  updatedAt: z.string()
});

export const workspaceMemberSchema = z.object({
  userId: z.string(),
  displayLabel: z.string(),
  email: z.string().nullable(),
  role: workspaceMembershipRoleSchema
});

export const workspaceAccessRequestSchema = z.object({
  id: z.string(),
  collaborationWorkspaceId: z.string(),
  clientInstanceId: z.string(),
  userId: z.string(),
  createdAt: z.string()
});

export const workspaceAccessRequestItemSchema = z.object({
  userId: z.string(),
  displayLabel: z.string(),
  email: z.string().nullable(),
  createdAt: z.string()
});

const workspaceNameSchema = z.string().trim().min(1).max(120);
const workspaceDescriptionSchema = z.string().trim().max(500).nullable();
const workspaceEmojiSchema = z.string().trim().max(32).nullable();

export const createCollaborationWorkspaceRequestSchema = z.object({
  name: workspaceNameSchema,
  description: workspaceDescriptionSchema.optional(),
  visibility: workspaceVisibilitySchema.optional().default("discoverable"),
  emoji: workspaceEmojiSchema.optional(),
  accentColor: workspaceAccentColorSchema.nullable().optional()
});

export const updateCollaborationWorkspaceRequestSchema = z
  .object({
    name: workspaceNameSchema.optional(),
    description: workspaceDescriptionSchema.optional(),
    visibility: workspaceVisibilitySchema.optional(),
    emoji: workspaceEmojiSchema.optional(),
    accentColor: workspaceAccentColorSchema.nullable().optional()
  })
  .refine((value) => Object.keys(value).length > 0, "At least one workspace setting is required");

export const addWorkspaceMemberRequestSchema = z.object({
  email: z.string().trim().email()
});

export const updateWorkspaceMemberRoleRequestSchema = z.object({
  role: workspaceMembershipRoleSchema
});

export type CollaborationWorkspace = z.infer<typeof collaborationWorkspaceSchema>;
export type CollaborationWorkspaceWithRole = z.infer<typeof collaborationWorkspaceWithRoleSchema>;
export type CollaborationWorkspaceDirectoryItem = z.infer<
  typeof collaborationWorkspaceDirectoryItemSchema
>;
export type WorkspaceMember = z.infer<typeof workspaceMemberSchema>;
export type WorkspaceAccessRequestItem = z.infer<typeof workspaceAccessRequestItemSchema>;
