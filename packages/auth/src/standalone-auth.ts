import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { fromNodeHeaders } from "better-auth/node";
import postgres from "postgres";
import {
  AppError,
  AUTH_SCOPE_WILDCARD,
  type AuthenticatedUser,
  type ClientInstanceId
} from "@vivd-catalyst/core";
import {
  authAccounts,
  authSessions,
  authUsers,
  standaloneAuthProfiles,
  standaloneAuthSchema
} from "./standalone-auth-schema";
import type { AuthAdapter, AuthRequest } from "./types";

export interface StandaloneAuthSeedUser {
  email: string;
  displayLabel: string;
  password: string;
  roles: string[];
  permissionRefs: string[];
  permissions: string[];
}

export interface StandaloneAuthOptions {
  clientInstanceId: ClientInstanceId;
  databaseUrl: string;
  secret: string;
  baseUrl: string;
  trustedOrigins?: string[];
  seedUsers?: StandaloneAuthSeedUser[];
}

export const STANDALONE_AUTH_SOURCE = "better-auth";

export interface SetStandalonePasswordInput {
  externalUserId: string;
  password: string;
}

export interface SetOrCreateStandalonePasswordSignInInput {
  email: string;
  displayLabel: string;
  roles: string[];
  permissionRefs: string[];
  permissions: string[];
  password: string;
}

export interface StandalonePasswordSignIn {
  externalUserId: string;
  displayLabel: string;
  email: string;
  emailVerified: boolean;
}

export interface ChangeStandalonePasswordInput {
  externalUserId: string;
  currentPassword: string;
  newPassword: string;
}

export interface DeleteStandalonePasswordSignInInput {
  externalUserId: string;
}

export interface StandaloneAuthRuntime {
  handleRequest(request: Request): Promise<Response>;
  authAdapter: AuthAdapter;
  baseUrl: string;
  seedUsers(): Promise<void>;
  setPassword(input: SetStandalonePasswordInput): Promise<void>;
  setOrCreatePasswordSignIn(
    input: SetOrCreateStandalonePasswordSignInInput
  ): Promise<StandalonePasswordSignIn>;
  changePassword(input: ChangeStandalonePasswordInput): Promise<void>;
  deletePasswordSignIn(input: DeleteStandalonePasswordSignInInput): Promise<void>;
  close(): Promise<void>;
}

type StandaloneAuthDatabase = PostgresJsDatabase<typeof standaloneAuthSchema>;
type AuthUserRow = typeof authUsers.$inferSelect;
type StandaloneProfileRow = typeof standaloneAuthProfiles.$inferSelect;

interface BetterAuthSessionApi {
  api: {
    getSession(input: { headers: Headers }): Promise<
      | {
          user: {
            id: string;
            email: string;
            emailVerified?: boolean;
          };
        }
      | null
    >;
  };
}

export async function createStandaloneAuthRuntime(
  options: StandaloneAuthOptions
): Promise<StandaloneAuthRuntime> {
  const sql = postgres(options.databaseUrl, {
    max: 10
  });
  const db = drizzle(sql, { schema: standaloneAuthSchema });
  const profileStore = new StandaloneAuthProfileStore(db, options.clientInstanceId);
  const auth = betterAuth({
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: standaloneAuthSchema
    }),
    secret: options.secret,
    baseURL: options.baseUrl,
    trustedOrigins: options.trustedOrigins ?? [],
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8
    }
  });

  async function seedUsers(): Promise<void> {
    for (const seedUser of options.seedUsers ?? []) {
      await profileStore.seedUser(seedUser);
    }
  }

  await seedUsers();

  return {
    handleRequest: (request) => auth.handler(request),
    authAdapter: new BetterAuthAdapter(auth, profileStore),
    baseUrl: options.baseUrl,
    seedUsers,
    setPassword: (input) => profileStore.setPassword(input),
    setOrCreatePasswordSignIn: (input) => profileStore.setOrCreatePasswordSignIn(input),
    changePassword: (input) => profileStore.changePassword(input),
    deletePasswordSignIn: (input) => profileStore.deletePasswordSignIn(input),
    async close() {
      await sql.end();
    }
  };
}

class BetterAuthAdapter implements AuthAdapter {
  readonly id = STANDALONE_AUTH_SOURCE;

  constructor(
    private readonly auth: BetterAuthSessionApi,
    private readonly profiles: StandaloneAuthProfileStore
  ) {}

  async authenticate(request: AuthRequest): Promise<AuthenticatedUser> {
    const session = await this.auth.api.getSession({
      headers: fromNodeHeaders(request.headers)
    });
    if (!session) {
      throw new AppError("UNAUTHENTICATED", "Sign in is required");
    }

    const profile = await this.profiles.getProfile(session.user.id);
    if (!profile) {
      throw new AppError("FORBIDDEN", "Signed-in user is not authorized for this client instance");
    }

    return {
      id: profile.authUserId,
      externalUserId: profile.externalUserId,
      displayLabel: profile.displayLabel,
      email: session.user.email,
      emailVerified: session.user.emailVerified ?? false,
      roles: profile.roles,
      permissionRefs: profile.permissionRefs,
      permissions: profile.permissions,
      clientInstanceId: request.clientInstanceId,
      authSource: this.id,
      correlationId: request.correlationId,
      subjectUserId: profile.authUserId,
      principal: {
        kind: "user",
        id: profile.authUserId,
        externalUserId: profile.externalUserId,
        displayLabel: profile.displayLabel,
        clientInstanceId: request.clientInstanceId,
        authSource: this.id
      },
      scopes: [AUTH_SCOPE_WILDCARD]
    };
  }
}

class StandaloneAuthProfileStore {
  constructor(
    private readonly db: StandaloneAuthDatabase,
    private readonly clientInstanceId: ClientInstanceId
  ) {}

  async getProfile(authUserId: string): Promise<StandaloneProfileRow | undefined> {
    const [row] = await this.db
      .select()
      .from(standaloneAuthProfiles)
      .where(
        and(
          eq(standaloneAuthProfiles.clientInstanceId, this.clientInstanceId),
          eq(standaloneAuthProfiles.authUserId, authUserId)
        )
      )
      .limit(1);
    return row;
  }

  async setPassword(input: SetStandalonePasswordInput): Promise<void> {
    const profile = await this.getProfileByExternalUserId(input.externalUserId);
    if (!profile) {
      throw new AppError("NOT_FOUND", "No standalone auth account exists for this user");
    }
    await this.upsertCredentialAccount(profile.authUserId, input.password);
    await this.db.delete(authSessions).where(eq(authSessions.userId, profile.authUserId));
  }

  async setOrCreatePasswordSignIn(
    input: SetOrCreateStandalonePasswordSignInInput
  ): Promise<StandalonePasswordSignIn> {
    const email = input.email.trim().toLowerCase();
    const authUser = await this.upsertAuthUser(email, input.displayLabel);
    await this.upsertCredentialAccount(authUser.id, input.password);
    await this.upsertProfile({
      authUserId: authUser.id,
      externalUserId: authUser.id,
      displayLabel: input.displayLabel,
      roles: input.roles,
      permissionRefs: input.permissionRefs,
      permissions: input.permissions
    });
    await this.db.delete(authSessions).where(eq(authSessions.userId, authUser.id));
    return {
      externalUserId: authUser.id,
      displayLabel: input.displayLabel,
      email,
      emailVerified: true
    };
  }

  async changePassword(input: ChangeStandalonePasswordInput): Promise<void> {
    const profile = await this.getProfileByExternalUserId(input.externalUserId);
    if (!profile) {
      throw new AppError("NOT_FOUND", "No standalone auth account exists for this user");
    }
    const [account] = await this.db
      .select()
      .from(authAccounts)
      .where(
        and(
          eq(authAccounts.accountId, profile.authUserId),
          eq(authAccounts.providerId, "credential")
        )
      )
      .limit(1);
    if (!account?.password) {
      throw new AppError("VALIDATION_FAILED", "No credential password exists for this user");
    }
    const currentPasswordMatches = await verifyPassword({
      hash: account.password,
      password: input.currentPassword
    });
    if (!currentPasswordMatches) {
      throw new AppError("FORBIDDEN", "Current password is incorrect");
    }
    await this.upsertCredentialAccount(profile.authUserId, input.newPassword);
  }

  async deletePasswordSignIn(input: DeleteStandalonePasswordSignInInput): Promise<void> {
    const profile = await this.getProfileByExternalUserId(input.externalUserId);
    if (!profile) {
      return;
    }

    await this.db.transaction(async (tx) => {
      await tx
        .delete(standaloneAuthProfiles)
        .where(
          and(
            eq(standaloneAuthProfiles.clientInstanceId, this.clientInstanceId),
            eq(standaloneAuthProfiles.externalUserId, input.externalUserId)
          )
        );
      await tx.delete(authSessions).where(eq(authSessions.userId, profile.authUserId));

      const remainingProfiles = await tx
        .select({ authUserId: standaloneAuthProfiles.authUserId })
        .from(standaloneAuthProfiles)
        .where(eq(standaloneAuthProfiles.authUserId, profile.authUserId))
        .limit(1);
      if (remainingProfiles.length === 0) {
        await tx.delete(authUsers).where(eq(authUsers.id, profile.authUserId));
      }
    });
  }

  async seedUser(seedUser: StandaloneAuthSeedUser): Promise<void> {
    const email = seedUser.email.toLowerCase();
    const authUser = await this.upsertAuthUser(email, seedUser.displayLabel);
    await this.upsertCredentialAccount(authUser.id, seedUser.password);
    await this.upsertProfile({
      authUserId: authUser.id,
      externalUserId: authUser.id,
      displayLabel: seedUser.displayLabel,
      roles: seedUser.roles,
      permissionRefs: seedUser.permissionRefs,
      permissions: seedUser.permissions
    });
  }

  private async upsertAuthUser(email: string, displayLabel: string): Promise<AuthUserRow> {
    const now = new Date();
    const [row] = await this.db
      .insert(authUsers)
      .values({
        id: createAuthId("usr"),
        name: displayLabel,
        email,
        emailVerified: true,
        createdAt: now,
        updatedAt: now
      })
      .onConflictDoUpdate({
        target: authUsers.email,
        set: {
          name: displayLabel,
          emailVerified: true,
          updatedAt: now
        }
      })
      .returning();
    if (!row) {
      throw new AppError("INTERNAL", `Failed to seed standalone auth user '${email}'`);
    }
    return row;
  }

  private async getProfileByExternalUserId(
    externalUserId: string
  ): Promise<StandaloneProfileRow | undefined> {
    const [profile] = await this.db
      .select()
      .from(standaloneAuthProfiles)
      .where(
        and(
          eq(standaloneAuthProfiles.clientInstanceId, this.clientInstanceId),
          eq(standaloneAuthProfiles.externalUserId, externalUserId)
        )
      )
      .limit(1);
    return profile;
  }

  private async upsertCredentialAccount(authUserId: string, password: string): Promise<void> {
    const now = new Date();
    const passwordHash = await hashPassword(password);
    await this.db
      .insert(authAccounts)
      .values({
        id: createAuthId("acc"),
        accountId: authUserId,
        providerId: "credential",
        userId: authUserId,
        password: passwordHash,
        createdAt: now,
        updatedAt: now
      })
      .onConflictDoUpdate({
        target: [authAccounts.accountId, authAccounts.providerId],
        set: {
          password: passwordHash,
          updatedAt: now
        }
      });
  }

  private async upsertProfile(input: {
    authUserId: string;
    externalUserId: string;
    displayLabel: string;
    roles: string[];
    permissionRefs: string[];
    permissions: string[];
  }): Promise<void> {
    const now = new Date();
    await this.db
      .insert(standaloneAuthProfiles)
      .values({
        clientInstanceId: this.clientInstanceId,
        authUserId: input.authUserId,
        externalUserId: input.externalUserId,
        displayLabel: input.displayLabel,
        roles: input.roles,
        permissionRefs: input.permissionRefs,
        permissions: input.permissions,
        createdAt: now,
        updatedAt: now
      })
      .onConflictDoUpdate({
        target: [standaloneAuthProfiles.clientInstanceId, standaloneAuthProfiles.authUserId],
        set: {
          externalUserId: input.externalUserId,
          displayLabel: input.displayLabel,
          roles: input.roles,
          permissionRefs: input.permissionRefs,
          permissions: input.permissions,
          updatedAt: now
        }
      });
  }
}

function createAuthId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}
