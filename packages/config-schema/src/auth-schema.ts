import { isSecretName, SECRET_NAME_EXPECTATION } from "@work-shape/catalyst-core";
import { z } from "zod";

export const userIdentitySchema = z.object({
  id: z.string().min(1).default("dev-user"),
  externalUserId: z.string().min(1).default("dev-user"),
  displayLabel: z.string().min(1).default("Development User"),
  email: z.string().email().optional(),
  emailVerified: z.boolean().optional(),
  groups: z.array(z.string().min(1).max(200)).max(1000).default([]),
  roles: z.array(z.string().min(1)).default(["user", "admin"]),
  permissionRefs: z.array(z.string().min(1)).default([]),
  permissions: z.array(z.string().min(1)).default([]),
  authSource: z.string().min(1).default("development")
});

export const developmentAuthConfigSchema = z.object({
  enabled: z.boolean().default(false),
  user: userIdentitySchema.prefault({}),
  users: z.array(userIdentitySchema).default([]),
  defaultUserId: z.string().min(1).optional()
});

const standaloneSeedUserSchema = z.object({
  email: z.string().email(),
  emailEnvName: z.string().min(1).optional(),
  displayLabel: z.string().min(1),
  /** The name of a secret, never the password. A refused name is not repeated in a message. */
  passwordEnvName: z.string().min(1).refine(isSecretName, SECRET_NAME_EXPECTATION),
  developmentPassword: z.string().min(8).optional(),
  roles: z.array(z.string().min(1)).default(["user"]),
  permissionRefs: z.array(z.string().min(1)).default([]),
  permissions: z.array(z.string().min(1)).default([])
});

export const standaloneAuthConfigSchema = z.object({
  enabled: z.boolean().default(false),
  baseUrl: z.string().url().optional(),
  trustedOrigins: z.array(z.string().url()).default([]),
  seedUsers: z.array(standaloneSeedUserSchema).default([]),
  /**
   * Two-factor sign-in for accounts with a password (TWO-FACTOR-1). With `required`, every such
   * account sets up a code from an authenticator app before anything else opens, existing
   * sessions included. Without it a person turns it on and off in Settings.
   */
  twoFactor: z
    .object({
      required: z.boolean().default(false)
    })
    .prefault({})
});

export type UserIdentityConfig = z.infer<typeof userIdentitySchema>;

export type StandaloneSeedUserConfig = z.infer<typeof standaloneSeedUserSchema>;
