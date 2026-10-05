import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, like } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { fromNodeHeaders } from "better-auth/node";
import postgres from "postgres";
import {
  AppError,
  FIRST_PARTY_AUTH_SCOPES,
  type AuthenticatedUser,
  type ClientInstanceId
} from "@vivd-catalyst/core";
import {
  authAccounts,
  authSessions,
  authUsers,
  authVerifications,
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

export interface FindStandalonePasswordSignInInput {
  email: string;
}

export interface CreateStandalonePasswordSetupTokenInput {
  externalUserId: string;
  ttlMs: number;
}

export interface CompleteStandalonePasswordSetupInput {
  token: string;
  password: string;
}

export interface CompletedStandalonePasswordSetup {
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
  findPasswordSignIn(
    input: FindStandalonePasswordSignInInput
  ): Promise<StandalonePasswordSignIn | undefined>;
  /** Issues a single-use emailed-link token; any earlier token for the user stops working. */
  createPasswordSetupToken(input: CreateStandalonePasswordSetupTokenInput): Promise<string>;
  completePasswordSetup(
    input: CompleteStandalonePasswordSetupInput
  ): Promise<CompletedStandalonePasswordSetup>;
  close(): Promise<void>;
}

type StandaloneAuthDatabase = PostgresJsDatabase<typeof standaloneAuthSchema>;
type AuthUserRow = typeof authUsers.$inferSelect;
type StandaloneProfileRow = typeof standaloneAuthProfiles.$inferSelect;

interface BetterAuthSessionApi {
  api: {
    getSession(input: { headers: Headers }): Promise<{
      user: {
        id: string;
        email: string;
        emailVerified?: boolean;
      };
    } | null>;
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
      disableSignUp: true,
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
    findPasswordSignIn: (input) => profileStore.findPasswordSignIn(input),
    createPasswordSetupToken: (input) => profileStore.createPasswordSetupToken(input),
    completePasswordSetup: (input) => profileStore.completePasswordSetup(input),
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
      scopes: [...FIRST_PARTY_AUTH_SCOPES]
    };
  }
}

class StandaloneAuthProfileStore {
  constructor(
    private readonly db: StandaloneAuthDatabase,
    private readonly clientInstanceId: ClientInstanceId
  ) {}

  async getProfile(
    authUserId: string,
    db: Pick<StandaloneAuthDatabase, "select"> = this.db
  ): Promise<StandaloneProfileRow | undefined> {
    const [row] = await db
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

  async findPasswordSignIn(
    input: FindStandalonePasswordSignInInput
  ): Promise<StandalonePasswordSignIn | undefined> {
    const email = input.email.trim().toLowerCase();
    const [row] = await this.db
      .select({
        externalUserId: standaloneAuthProfiles.externalUserId,
        displayLabel: standaloneAuthProfiles.displayLabel,
        email: authUsers.email,
        emailVerified: authUsers.emailVerified
      })
      .from(standaloneAuthProfiles)
      .innerJoin(authUsers, eq(authUsers.id, standaloneAuthProfiles.authUserId))
      .where(
        and(
          eq(standaloneAuthProfiles.clientInstanceId, this.clientInstanceId),
          eq(authUsers.email, email)
        )
      )
      .limit(1);
    return row;
  }

  async createPasswordSetupToken(input: CreateStandalonePasswordSetupTokenInput): Promise<string> {
    const profile = await this.getProfileByExternalUserId(input.externalUserId);
    if (!profile) {
      throw new AppError("NOT_FOUND", "No standalone auth account exists for this user");
    }
    const token = randomBytes(32).toString("base64url");
    const now = new Date();
    await this.db.transaction(async (tx) => {
      await tx.delete(authVerifications).where(passwordSetupTokensOf(profile.authUserId));
      await tx.insert(authVerifications).values({
        id: createAuthId("ver"),
        identifier: passwordSetupIdentifier(token),
        value: profile.authUserId,
        expiresAt: new Date(now.getTime() + input.ttlMs),
        createdAt: now,
        updatedAt: now
      });
    });
    return token;
  }

  async completePasswordSetup(
    input: CompleteStandalonePasswordSetupInput
  ): Promise<CompletedStandalonePasswordSetup> {
    // Hashing is slow, so it happens before the transaction opens.
    const passwordHash = await hashPassword(input.password);
    // One transaction: a failed write must not burn the link. Deleting first still makes the
    // token single-use under concurrent submissions, because the second delete waits for the
    // first transaction and then finds no row.
    return this.db.transaction(async (tx) => {
      const [verification] = await tx
        .delete(authVerifications)
        .where(eq(authVerifications.identifier, passwordSetupIdentifier(input.token)))
        .returning();
      const profile =
        verification && verification.expiresAt.getTime() > Date.now()
          ? await this.getProfile(verification.value, tx)
          : undefined;
      if (!profile) {
        throw new AppError("VALIDATION_FAILED", "This link is invalid or has expired");
      }
      await this.writeCredentialAccount(tx, profile.authUserId, passwordHash);
      await tx.delete(authSessions).where(eq(authSessions.userId, profile.authUserId));
      return { externalUserId: profile.externalUserId };
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
    await this.writeCredentialAccount(this.db, authUserId, await hashPassword(password));
  }

  private async writeCredentialAccount(
    db: Pick<StandaloneAuthDatabase, "insert" | "delete">,
    authUserId: string,
    passwordHash: string
  ): Promise<void> {
    const now = new Date();
    await db
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
    // A changed password invalidates every outstanding emailed setup link.
    await db.delete(authVerifications).where(passwordSetupTokensOf(authUserId));
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

const PASSWORD_SETUP_IDENTIFIER_PREFIX = "password-setup:";

/** Only the hash is stored, so a database read does not yield usable links. */
function passwordSetupIdentifier(token: string): string {
  return `${PASSWORD_SETUP_IDENTIFIER_PREFIX}${createHash("sha256").update(token).digest("hex")}`;
}

function passwordSetupTokensOf(authUserId: string) {
  return and(
    eq(authVerifications.value, authUserId),
    like(authVerifications.identifier, `${PASSWORD_SETUP_IDENTIFIER_PREFIX}%`)
  );
}

function createAuthId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}
