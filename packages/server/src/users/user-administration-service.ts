import type { StorePage } from "@work-shape/catalyst-core";
import { randomBytes } from "node:crypto";
import { STANDALONE_AUTH_SOURCE } from "@work-shape/catalyst-auth";
import {
  AppError,
  isSuperadmin,
  asUserId,
  unknownLegacyEntries,
  auditActorFromIdentity,
  auditActorFromUser,
  isAuthenticatedServicePrincipal,
  type AuthenticatedIdentity,
  type OperationExecutionContext,
  type AuthenticatedUser,
  type RuntimeCallContext,
  type UserId,
  type UserRecord,
  userInDeletionError,
  type UserRole,
  type UserStatus
} from "@work-shape/catalyst-core";
import { requestAccountDeletion } from "../deletion/account-deletion";
import type { ChatServerOptions } from "../types";
import { recordGovernanceAccess } from "../access/governance-actions";
import { createPasswordSetupLink, PLATFORM_INVITATION_VALID_DAYS } from "./password-setup-service";
import type { DeletionOutcome } from "../deletion/subject-deletion";
import { withRightsHeld } from "../access/rights-held";
import {
  changedPermissionEntries,
  requireMayAdministerUser,
  requireUserAdministration
} from "../access/user-administration-rights";
import { isKnownRole } from "../access/role-rights";
import { requireActiveSuperadminRemains } from "./last-superadmin";

/** What a changing user administration operation takes from its Operation Run. */
type ChangeContext = Pick<
  OperationExecutionContext,
  "actor" | "access" | "audit" | "correlationId"
>;
/** The call under the rights locks, with the password sign-ins its change created so far. */
type HeldChangeContext = ChangeContext & { createdSignIns: string[] };

interface CreateUserCommand {
  displayLabel: string;
  email?: string;
  roles?: UserRole[];
  permissionRefs?: string[];
  permissions?: string[];
  status?: UserStatus;
  passwordSignIn?: {
    password: string;
  };
}

interface UpdateUserCommand {
  userId: UserId;
  displayLabel?: string;
  email?: string | null;
  roles?: UserRole[];
  permissionRefs?: string[];
  permissions?: string[];
  status?: UserStatus;
}

interface UpsertUserIdentityCommand {
  userId: UserId;
  authSource: string;
  externalUserId: string;
  displayLabel?: string;
  email?: string;
  emailVerified?: boolean;
}

interface DeleteUserIdentityCommand {
  userId: UserId;
  authSource: string;
  externalUserId: string;
}

interface DeleteUserCommand {
  userId: UserId;
}

interface SendUserInvitationCommand {
  userId: UserId;
}

interface ResetUserTwoFactorCommand {
  userId: UserId;
}

/** The refusal of a reset of one's own second factor. */
export const OWN_TWO_FACTOR_MESSAGE =
  "Nobody resets their own two-factor sign-in: turn it off in Settings, or ask another admin";

interface ResetUserPasswordCommand {
  userId: UserId;
  password: string;
}

export class UserAdministrationWorkflow {
  constructor(private readonly options: ChatServerOptions) {}

  async listUsers(
    user: AuthenticatedUser,
    context: RuntimeCallContext,
    page?: StorePage
  ): Promise<UserRecord[]> {
    await this.recordAccess(user, context, "governance.users_viewed");
    const users = await this.options.stores.users.listUsers({
      clientInstanceId: this.options.clientInstanceId,
      page,
      excludeSuperadmins: !isSuperadmin(user)
    });
    return this.withTwoFactorState(
      isSuperadmin(user) ? users : users.filter((candidate) => !isSuperadmin(candidate))
    );
  }

  /** Each user with a password sign-in, with whether it has a second factor. */
  private async withTwoFactorState(
    users: UserRecord[]
  ): Promise<(UserRecord & { twoFactorEnabled?: boolean })[]> {
    const auth = this.options.standaloneAuth;
    if (!auth) {
      return users;
    }
    const signInOf = (user: UserRecord) =>
      user.identities.find((identity) => identity.authSource === STANDALONE_AUTH_SOURCE)
        ?.externalUserId;
    const signIns = users.flatMap((user) => signInOf(user) ?? []);
    const enrolled = await auth.twoFactorEnrolled(signIns);
    return users.map((user) => {
      const signIn = signInOf(user);
      return signIn === undefined ? user : { ...user, twoFactorEnabled: enrolled.has(signIn) };
    });
  }

  async createUser(
    operationId: string,
    context: ChangeContext,
    command: CreateUserCommand
  ): Promise<UserRecord> {
    personOf(context.actor);
    this.requireAssignablePermissions(command.permissions);
    if (command.passwordSignIn && !command.email) {
      throw new AppError("VALIDATION_FAILED", "Email is required to create a password sign-in");
    }
    const { passwordSignIn } = command;
    const created = await this.whileRightsHeld(context, undefined, async (held, now) => {
      await requireUserAdministration(held.options, operationId, now, {
        displayLabel: command.displayLabel,
        roles: command.roles,
        permissionRefs: command.permissionRefs,
        permissions: command.permissions
      });
      await held.requireKnownRoles(command.roles ?? []);
      const user = await held.options.stores.users.createUser({
        clientInstanceId: this.options.clientInstanceId,
        displayLabel: command.displayLabel,
        email: command.email,
        roles: command.roles,
        permissionRefs: command.permissionRefs,
        permissions: command.permissions,
        grantedBy: asUserId(now.actor.id),
        status: command.status
      });
      return passwordSignIn ? held.attachPasswordSignIn(now, user, passwordSignIn.password) : user;
    });
    await this.recordUserMutation(context, "user.created", created);
    if (passwordSignIn)
      await this.recordPassword(context, created, "user.password_sign_in_created");
    return created;
  }

  async updateUser(
    operationId: string,
    context: ChangeContext,
    command: UpdateUserCommand
  ): Promise<UserRecord> {
    personOf(context.actor);
    const change = {
      roles: command.roles,
      permissionRefs: command.permissionRefs,
      permissions: command.permissions
    };
    const updated = await this.whileRightsHeld(context, command.userId, async (held, now) => {
      await requireUserAdministration(held.options, operationId, now, {
        userId: command.userId,
        ...change
      });
      const existing = await held.getUserOrThrow(command.userId);
      requireNotInDeletion(existing);
      held.requireAssignablePermissions(command.permissions, existing.permissions);
      await held.requireKnownRoles(
        (command.roles ?? []).filter((role) => !existing.roles.includes(role))
      );
      await requireActiveSuperadminRemains(held.options, existing, {
        roles: command.roles ?? existing.roles,
        status: command.status ?? existing.status
      });
      return held.options.stores.users.updateUser({
        clientInstanceId: this.options.clientInstanceId,
        userId: command.userId,
        displayLabel: command.displayLabel,
        email: command.email,
        roles: command.roles,
        permissionRefs: command.permissionRefs,
        permissions: command.permissions,
        grantedBy: asUserId(now.actor.id),
        status: command.status
      });
    });
    await this.recordUserMutation(context, "user.updated", updated);
    return updated;
  }

  async deleteUser(
    operationId: string,
    context: ChangeContext,
    command: DeleteUserCommand
  ): Promise<DeletionOutcome<UserRecord>> {
    const actor = personOf(context.actor);
    if (command.userId === actor.id) {
      throw new AppError(
        "VALIDATION_FAILED",
        "Nobody deletes their own user account through user administration"
      );
    }
    return requestAccountDeletion(
      this.options,
      {
        userId: command.userId,
        requestedBy: "admin",
        actor: auditActorFromUser(actor),
        actorUserId: asUserId(actor.id),
        correlationId: context.correlationId
      },
      (mark) =>
        this.whileRightsHeld(context, command.userId, async (held, now) => {
          await requireUserAdministration(held.options, operationId, now, {
            userId: command.userId,
            deletes: true
          });
          // The mark refuses to delete the last active superadmin.
          await held.getUserOrThrow(command.userId);
          return mark(held.options.stores);
        })
    );
  }

  async upsertIdentity(
    operationId: string,
    context: ChangeContext,
    command: UpsertUserIdentityCommand
  ): Promise<UserRecord> {
    personOf(context.actor);
    const updated = await this.whileRightsHeld(context, command.userId, async (held, now) => {
      await requireUserAdministration(held.options, operationId, now, { userId: command.userId });
      requireNotInDeletion(await held.getUserOrThrow(command.userId));
      return held.options.stores.users.upsertUserIdentity({
        clientInstanceId: this.options.clientInstanceId,
        userId: command.userId,
        authSource: command.authSource,
        externalUserId: command.externalUserId,
        displayLabel: command.displayLabel,
        email: command.email,
        emailVerified: command.emailVerified
      });
    });
    const { audit: auditRecorder } = context;
    await auditRecorder.record({
      type: "user.identity_upserted",
      status: "success",
      actor: auditActorFromIdentity(context.actor),
      subject: updated.id,
      correlationId: context.correlationId,
      metadata: {
        authSource: command.authSource,
        externalUserId: command.externalUserId,
        emailVerified: command.emailVerified ?? false
      }
    });
    return updated;
  }

  async deleteIdentity(
    operationId: string,
    context: ChangeContext,
    command: DeleteUserIdentityCommand
  ): Promise<UserRecord> {
    personOf(context.actor);
    const updated = await this.whileRightsHeld(context, command.userId, async (held, now) => {
      await requireUserAdministration(held.options, operationId, now, { userId: command.userId });
      requireNotInDeletion(await held.getUserOrThrow(command.userId));
      return held.options.stores.users.deleteUserIdentity({
        clientInstanceId: this.options.clientInstanceId,
        userId: command.userId,
        authSource: command.authSource,
        externalUserId: command.externalUserId
      });
    });
    const { audit: auditRecorder } = context;
    await auditRecorder.record({
      type: "user.identity_deleted",
      status: "success",
      actor: auditActorFromIdentity(context.actor),
      subject: updated.id,
      correlationId: context.correlationId,
      metadata: {
        authSource: command.authSource,
        externalUserId: command.externalUserId
      }
    });
    return updated;
  }

  /**
   * Sets a user's password. The password goes to the auth store, which keeps its own slow
   * hash, and nowhere else: no audit row, log line or answer names it. The operation is
   * registered as `secret` and marks the password in its hashed input, so the run keeps
   * neither an answer nor a hash of the password, and a repeated call sets nothing.
   */
  async resetPassword(
    operationId: string,
    context: ChangeContext,
    command: ResetUserPasswordCommand
  ): Promise<{ ok: true }> {
    personOf(context.actor);
    const setPassword = this.options.standaloneAuth?.setPassword;
    if (!setPassword) {
      throw new AppError(
        "VALIDATION_FAILED",
        "Password reset requires standalone auth to be enabled for this client instance"
      );
    }
    const { user, created } = await this.whileRightsHeld(
      context,
      command.userId,
      async (held, now) => {
        await requireUserAdministration(held.options, operationId, now, { userId: command.userId });
        const current = await held.getUserOrThrow(command.userId);
        requireNotInDeletion(current);
        const identity = current.identities.find(
          (candidate) => candidate.authSource === STANDALONE_AUTH_SOURCE
        );
        if (!identity) {
          return {
            user: await held.attachPasswordSignIn(now, current, command.password),
            created: true
          };
        }
        // The last step before the commit, after the check: a password set is not taken back.
        await setPassword({ externalUserId: identity.externalUserId, password: command.password });
        return { user: current, created: false };
      }
    );
    await this.recordPassword(
      context,
      user,
      created ? "user.password_sign_in_created" : "user.password_reset"
    );
    return { ok: true };
  }

  /**
   * An admin's reset of a user's two-factor sign-in (TWO-FACTOR-1): the factor and every
   * trusted browser are deleted, the flag cleared and the person's sessions ended, so their next
   * sign-in with the password reaches the setup. Never on one's own account. The admin confirms
   * who asks outside the instance first; nothing of the factor is in the answer or the audit.
   */
  async resetTwoFactor(
    operationId: string,
    context: ChangeContext,
    command: ResetUserTwoFactorCommand
  ): Promise<{ ok: true; hadFactor: boolean }> {
    personOf(context.actor);
    const reset = this.options.standaloneAuth?.resetTwoFactor;
    if (!reset) {
      throw new AppError(
        "VALIDATION_FAILED",
        "Two-factor sign-in requires standalone auth to be enabled for this client instance"
      );
    }
    if (command.userId === context.actor.id) {
      throw new AppError("FORBIDDEN", OWN_TWO_FACTOR_MESSAGE, {
        reason: "holder_not_administrable"
      });
    }
    const { user, hadFactor } = await this.whileRightsHeld(
      context,
      command.userId,
      async (held, now) => {
        await requireUserAdministration(held.options, operationId, now, { userId: command.userId });
        const current = await held.getUserOrThrow(command.userId);
        requireNotInDeletion(current);
        const identity = current.identities.find(
          (candidate) => candidate.authSource === STANDALONE_AUTH_SOURCE
        );
        if (!identity) {
          throw new AppError(
            "VALIDATION_FAILED",
            "This user has no password sign-in, so there is no two-factor sign-in to reset"
          );
        }
        // The last step before the commit, after the check: a deleted factor is not taken back.
        const result = await reset({ externalUserId: identity.externalUserId });
        return { user: current, hadFactor: result.hadFactor };
      }
    );
    await context.audit.record({
      type: "user.two_factor_reset",
      status: "success",
      actor: auditActorFromIdentity(context.actor),
      subject: user.id,
      correlationId: context.correlationId,
      metadata: { authSource: STANDALONE_AUTH_SOURCE, hadFactor }
    });
    return { ok: true, hadFactor };
  }

  /**
   * Emails a single-use link that lets the user set their own password. A user without a
   * password sign-in gets one with an unguessable placeholder password first; an existing
   * password keeps working until the link is used.
   */
  async sendInvitation(
    operationId: string,
    context: ChangeContext,
    command: SendUserInvitationCommand
  ): Promise<{ ok: true }> {
    const actor = personOf(context.actor);
    const { mail, standaloneAuth } = this.options;
    if (!mail || !standaloneAuth) {
      throw new AppError(
        "VALIDATION_FAILED",
        "Invitations require mail and standalone auth to be enabled for this client instance"
      );
    }
    let user = await this.getUserOrThrow(command.userId);
    await requireMayAdministerUser(this.options, operationId, context, user);
    if (user.status !== "active") {
      throw new AppError("VALIDATION_FAILED", "Only active users can be invited");
    }
    if (!user.identities.some((identity) => identity.authSource === STANDALONE_AUTH_SOURCE)) {
      user = await this.whileRightsHeld(context, command.userId, async (held, now) => {
        await requireUserAdministration(held.options, operationId, now, { userId: command.userId });
        const current = await held.getUserOrThrow(command.userId);
        if (current.status !== "active") {
          throw new AppError("VALIDATION_FAILED", "Only active users can be invited");
        }
        return held.attachPasswordSignIn(now, current, randomBytes(32).toString("base64url"));
      });
      await this.recordPassword(context, user, "user.password_sign_in_created");
    }
    const identity = user.identities.find(
      (candidate) => candidate.authSource === STANDALONE_AUTH_SOURCE
    );
    const email = identity?.email ?? user.email;
    if (!identity || !email) {
      throw new AppError("VALIDATION_FAILED", "Email is required to send an invitation");
    }
    if (user.email && user.email.trim().toLowerCase() !== email.trim().toLowerCase()) {
      // The password sign-in keeps the address it was created with; changing the user's email
      // does not move it, so the link would go to the old address.
      throw new AppError(
        "CONFLICT",
        "The user's email no longer matches the email of their password sign-in, so an invitation cannot be sent"
      );
    }

    const token = await standaloneAuth.createPasswordSetupToken({
      externalUserId: identity.externalUserId,
      ttlMs: PLATFORM_INVITATION_VALID_DAYS * 24 * 60 * 60 * 1000
    });
    const result = await mail.sender.send({
      template: "platform-invitation",
      to: { email, displayLabel: user.displayLabel },
      locale: this.options.config.localization.defaultLocale,
      params: {
        link: createPasswordSetupLink(mail.appUrl, token),
        validDays: PLATFORM_INVITATION_VALID_DAYS,
        inviterLabel: actor.displayLabel
      }
    });
    const { audit: auditRecorder } = context;
    await auditRecorder.record({
      type: "user.invitation_sent",
      status: result.ok ? "success" : "failed",
      actor: auditActorFromIdentity(context.actor),
      subject: user.id,
      correlationId: context.correlationId,
      metadata: {
        template: "platform-invitation",
        ...(result.ok ? {} : { reason: result.reason })
      }
    });
    if (!result.ok) {
      throw new AppError("INTERNAL", "The invitation email could not be sent", undefined, {
        exposeMessage: true
      });
    }
    return { ok: true };
  }

  /**
   * Creates the user's password sign-in in the auth store and attaches it to the user. Called
   * under the rights locks after the check (`whileRightsHeld`), so nothing of the auth store
   * changes for a call the check refuses; a sign-in it creates is noted in `now`, so a failure
   * after it removes it again.
   */
  private async attachPasswordSignIn(
    now: HeldChangeContext,
    user: UserRecord,
    password: string
  ): Promise<UserRecord> {
    const auth = this.options.standaloneAuth;
    if (!auth) {
      throw new AppError(
        "VALIDATION_FAILED",
        "Password sign-in requires standalone auth to be enabled for this client instance"
      );
    }
    if (!user.email) {
      throw new AppError("VALIDATION_FAILED", "Email is required to create a password sign-in");
    }
    await this.requireAvailablePasswordEmail(user);
    const before = await auth.findPasswordSignIn({ email: user.email });
    const signIn = await auth.setOrCreatePasswordSignIn({
      email: user.email,
      displayLabel: user.displayLabel,
      roles: user.roles,
      permissionRefs: user.permissionRefs,
      permissions: user.permissions,
      password
    });
    if (!before) now.createdSignIns.push(signIn.externalUserId);
    await this.requireAvailablePasswordIdentity(user, signIn.externalUserId);
    return this.options.stores.users.upsertUserIdentity({
      clientInstanceId: this.options.clientInstanceId,
      userId: user.id,
      authSource: STANDALONE_AUTH_SOURCE,
      externalUserId: signIn.externalUserId,
      displayLabel: signIn.displayLabel,
      email: signIn.email,
      emailVerified: signIn.emailVerified
    });
  }

  private async recordPassword(
    context: ChangeContext,
    user: UserRecord,
    type: "user.password_sign_in_created" | "user.password_reset"
  ): Promise<void> {
    await context.audit.record({
      type,
      status: "success",
      actor: auditActorFromIdentity(context.actor),
      subject: user.id,
      correlationId: context.correlationId,
      metadata: { authSource: STANDALONE_AUTH_SOURCE }
    });
  }

  /**
   * `withRightsHeld` for a change of users: the workflow on the transaction's stores and the
   * call with the caller's rights now. The auth store keeps its own tables outside the
   * transaction, so a password sign-in the change created is removed again when the change
   * fails, its commit included.
   */
  private async whileRightsHeld<Result>(
    context: ChangeContext,
    userId: string | undefined,
    change: (held: UserAdministrationWorkflow, now: HeldChangeContext) => Promise<Result>
  ): Promise<Result> {
    const createdSignIns: string[] = [];
    try {
      return await withRightsHeld(
        this.options,
        {
          actor: context.actor,
          access: context.access,
          ...(userId === undefined ? {} : { userId })
        },
        ({ options, actor, access }) =>
          change(new UserAdministrationWorkflow(options), {
            ...context,
            actor,
            access,
            createdSignIns
          })
      );
    } catch (error) {
      for (const externalUserId of createdSignIns) {
        await this.options.standaloneAuth
          ?.deletePasswordSignIn({ externalUserId })
          .catch((undoError: unknown) =>
            this.options.logger.error(
              { err: undoError },
              "A password sign-in created by a refused change could not be removed"
            )
          );
      }
      throw error;
    }
  }

  private async requireAvailablePasswordEmail(user: UserRecord): Promise<void> {
    const normalizedEmail = user.email?.trim().toLowerCase();
    if (!normalizedEmail) {
      return;
    }
    const users = await this.options.stores.users.listUsers({
      clientInstanceId: this.options.clientInstanceId
    });
    const conflict = users.find(
      (candidate) =>
        candidate.id !== user.id &&
        (candidate.email?.trim().toLowerCase() === normalizedEmail ||
          candidate.identities.some(
            (identity) =>
              identity.authSource === STANDALONE_AUTH_SOURCE &&
              identity.email?.trim().toLowerCase() === normalizedEmail
          ))
    );
    if (conflict) {
      throw new AppError(
        "VALIDATION_FAILED",
        "Another user already uses this email, so a password sign-in would be ambiguous"
      );
    }
  }

  private async requireAvailablePasswordIdentity(
    user: UserRecord,
    externalUserId: string
  ): Promise<void> {
    const users = await this.options.stores.users.listUsers({
      clientInstanceId: this.options.clientInstanceId
    });
    const conflict = users.find(
      (candidate) =>
        candidate.id !== user.id &&
        candidate.identities.some(
          (identity) =>
            identity.authSource === STANDALONE_AUTH_SOURCE &&
            identity.externalUserId === externalUserId
        )
    );
    if (conflict) {
      throw new AppError(
        "VALIDATION_FAILED",
        "This password sign-in is already linked to another user"
      );
    }
  }

  private async getUserOrThrow(userId: UserId): Promise<UserRecord> {
    const users = await this.options.stores.users.listUsers({
      clientInstanceId: this.options.clientInstanceId
    });
    const user = users.find((candidate) => candidate.id === userId);
    if (!user) {
      throw new AppError("NOT_FOUND", "User not found");
    }
    return user;
  }

  private requireAssignablePermissions(
    permissions: readonly string[] | undefined,
    existingPermissions: readonly string[] = []
  ): void {
    // A list entry is a key or its revocation. Anything else held no right before and has no
    // row to be written as.
    const [unknown] = unknownLegacyEntries(permissions ?? []);
    if (unknown !== undefined) {
      throw new AppError("VALIDATION_FAILED", `'${unknown}' is not a permission`);
    }
    if (
      changedPermissionEntries(permissions, existingPermissions).includes("config_assets.release")
    ) {
      throw new AppError(
        "VALIDATION_FAILED",
        "Release permission can only be carried by service tokens"
      );
    }
  }

  /** A role given to a person is one the instance has: a built-in one or a stored custom role. */
  private async requireKnownRoles(roles: readonly string[]): Promise<void> {
    const options = {
      clientInstanceId: this.options.clientInstanceId,
      access: this.options.stores.access,
      roles: this.options.stores.roles
    };
    for (const role of roles) {
      if (!(await isKnownRole(options, role))) {
        throw new AppError("VALIDATION_FAILED", `'${role}' is not a role of this instance`, {
          reason: "unknown_role"
        });
      }
    }
  }

  // The list is a plain read and records its access itself.
  private async recordAccess(
    user: AuthenticatedUser,
    context: RuntimeCallContext,
    auditType: string
  ): Promise<void> {
    await recordGovernanceAccess({ options: this.options, user, context, auditType });
  }

  private async recordUserMutation(
    context: ChangeContext,
    type: string,
    user: UserRecord
  ): Promise<void> {
    const { audit: auditRecorder } = context;
    await auditRecorder.record({
      type,
      status: "success",
      actor: auditActorFromIdentity(context.actor),
      subject: user.id,
      correlationId: context.correlationId,
      metadata: {
        status: user.status,
        roles: user.roles,
        permissionRefs: user.permissionRefs,
        permissions: user.permissions
      }
    });
  }
}

/**
 * The early answer for a user whose deletion was requested. The store refuses the same in the
 * statement that writes, for a deletion requested after this check. Only the deletion can be
 * asked again.
 */
function requireNotInDeletion(user: UserRecord): void {
  if (user.status === "deleting") throw userInDeletionError();
}

function personOf(actor: AuthenticatedIdentity): AuthenticatedUser {
  if (isAuthenticatedServicePrincipal(actor)) {
    throw new AppError("FORBIDDEN", "Service principals cannot access user-scoped routes");
  }
  return actor;
}
