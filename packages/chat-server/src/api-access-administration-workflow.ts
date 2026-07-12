import type {
  ApiCredentialScope,
  ServicePrincipalPermission
} from "@vivd-catalyst/api-contract";
import {
  AppError,
  asApiCredentialId,
  asServicePrincipalId,
  asUserId,
  auditActorFromUser,
  type ApiCredentialRecord,
  type AuthenticatedUser,
  type RuntimeCallContext,
  type ServicePrincipalRecord
} from "@vivd-catalyst/core";
import { authorizeGovernanceAction } from "./governance-actions";
import type { ChatServerOptions } from "./types";

const SERVICE_PERMISSIONS = new Set<ServicePrincipalPermission>([
  "config_assets.read",
  "config_assets.release"
]);
const CREDENTIAL_SCOPES = new Set<ApiCredentialScope>([
  "config_assets:read",
  "config_assets:release"
]);

export interface ServicePrincipalDetail {
  principal: ServicePrincipalRecord;
  credentials: ApiCredentialRecord[];
}

interface CreateServicePrincipalCommand {
  displayLabel: string;
  description?: string;
  status?: ServicePrincipalRecord["status"];
  permissions?: ServicePrincipalPermission[];
}

interface UpdateServicePrincipalCommand {
  servicePrincipalId: string;
  displayLabel?: string;
  description?: string | null;
  status?: ServicePrincipalRecord["status"];
  permissions?: ServicePrincipalPermission[];
}

interface CreateApiCredentialCommand {
  servicePrincipalId: string;
  name: string;
  scopes?: ApiCredentialScope[];
  expiresAt?: string;
}

export class ApiAccessAdministrationWorkflow {
  constructor(private readonly options: ChatServerOptions) {}

  async listServicePrincipals(
    actor: AuthenticatedUser,
    context: RuntimeCallContext
  ): Promise<ServicePrincipalDetail[]> {
    await this.authorize(actor, context, "api_access.service_principals_viewed");
    const principals = await this.options.apiAccessStore.listServicePrincipals({
      clientInstanceId: this.options.clientInstanceId
    });
    return Promise.all(principals.map((principal) => this.detail(principal)));
  }

  async createServicePrincipal(
    actor: AuthenticatedUser,
    context: RuntimeCallContext,
    command: CreateServicePrincipalCommand
  ): Promise<ServicePrincipalDetail> {
    this.requireSuperadmin(actor, "Service principal creation");
    await this.authorize(actor, context, "api_access.service_principal_create_authorized");
    this.requireServicePermissions(command.permissions);
    const principal = await this.options.apiAccessStore.createServicePrincipal({
      clientInstanceId: this.options.clientInstanceId,
      displayLabel: command.displayLabel,
      description: command.description,
      status: command.status,
      permissionRefs: [],
      permissions: command.permissions ?? [],
      createdByUserId: asUserId(actor.id)
    });
    await this.recordPrincipalMutation(
      actor,
      context,
      "api_access.service_principal_created",
      principal
    );
    return this.detail(principal);
  }

  async updateServicePrincipal(
    actor: AuthenticatedUser,
    context: RuntimeCallContext,
    command: UpdateServicePrincipalCommand
  ): Promise<ServicePrincipalDetail> {
    this.requireSuperadmin(actor, "Service principal updates");
    await this.authorize(actor, context, "api_access.service_principal_update_authorized");
    this.requireServicePermissions(command.permissions);
    const principal = await this.options.apiAccessStore.updateServicePrincipal({
      clientInstanceId: this.options.clientInstanceId,
      servicePrincipalId: asServicePrincipalId(command.servicePrincipalId),
      displayLabel: command.displayLabel,
      description: command.description,
      status: command.status,
      permissions: command.permissions
    });
    await this.recordPrincipalMutation(
      actor,
      context,
      "api_access.service_principal_updated",
      principal
    );
    return this.detail(principal);
  }

  async createApiCredential(
    actor: AuthenticatedUser,
    context: RuntimeCallContext,
    command: CreateApiCredentialCommand
  ): Promise<{ credential: ApiCredentialRecord; secret: string }> {
    this.requireSuperadmin(actor, "API credential creation");
    await this.authorize(actor, context, "api_access.credential_create_authorized");
    this.requireCredentialScopes(command.scopes);
    this.requireFutureExpiry(command.expiresAt);
    const created = await this.options.apiAccessStore.createApiCredential({
      clientInstanceId: this.options.clientInstanceId,
      servicePrincipalId: asServicePrincipalId(command.servicePrincipalId),
      name: command.name,
      scopes: command.scopes,
      expiresAt: command.expiresAt
    });
    await this.options.auditRecorder.record({
      type: "api_access.credential_created",
      status: "success",
      actor: auditActorFromUser(actor),
      subject: created.credential.id,
      correlationId: context.correlationId,
      metadata: {
        servicePrincipalId: created.credential.servicePrincipalId,
        credentialId: created.credential.id,
        keyPrefix: created.credential.keyPrefix,
        scopes: created.credential.scopes ?? [],
        expiresAt: created.credential.expiresAt ?? null
      }
    });
    return created;
  }

  async revokeApiCredential(
    actor: AuthenticatedUser,
    context: RuntimeCallContext,
    credentialId: string
  ): Promise<ApiCredentialRecord> {
    this.requireSuperadmin(actor, "API credential revocation");
    await this.authorize(actor, context, "api_access.credential_revoke_authorized");
    const credential = await this.options.apiAccessStore.revokeApiCredential({
      clientInstanceId: this.options.clientInstanceId,
      credentialId: asApiCredentialId(credentialId)
    });
    await this.options.auditRecorder.record({
      type: "api_access.credential_revoked",
      status: "success",
      actor: auditActorFromUser(actor),
      subject: credential.id,
      correlationId: context.correlationId,
      metadata: {
        servicePrincipalId: credential.servicePrincipalId,
        credentialId: credential.id,
        keyPrefix: credential.keyPrefix
      }
    });
    return credential;
  }

  private async detail(principal: ServicePrincipalRecord): Promise<ServicePrincipalDetail> {
    return {
      principal,
      credentials: await this.options.apiAccessStore.listApiCredentials({
        clientInstanceId: this.options.clientInstanceId,
        servicePrincipalId: principal.id
      })
    };
  }

  private requireServicePermissions(permissions: readonly string[] | undefined): void {
    const invalid = permissions?.find(
      (permission) => !SERVICE_PERMISSIONS.has(permission as ServicePrincipalPermission)
    );
    if (invalid) {
      throw new AppError(
        "VALIDATION_FAILED",
        `Service principals cannot be granted permission '${invalid}'`
      );
    }
  }

  private requireCredentialScopes(scopes: readonly string[] | undefined): void {
    const invalid = scopes?.find(
      (scope) => !CREDENTIAL_SCOPES.has(scope as ApiCredentialScope)
    );
    if (invalid) {
      throw new AppError(
        "VALIDATION_FAILED",
        `API credentials cannot be granted scope '${invalid}'`
      );
    }
  }

  private requireFutureExpiry(expiresAt: string | undefined): void {
    if (expiresAt && Date.parse(expiresAt) <= Date.now()) {
      throw new AppError("VALIDATION_FAILED", "API credential expiry must be in the future");
    }
  }

  private requireSuperadmin(actor: AuthenticatedUser, operation: string): void {
    if (!actor.roles.includes("superadmin")) {
      throw new AppError("FORBIDDEN", `${operation} requires a superadmin role`);
    }
  }

  private authorize(
    actor: AuthenticatedUser,
    context: RuntimeCallContext,
    auditType: string
  ): Promise<void> {
    return authorizeGovernanceAction({
      options: this.options,
      user: actor,
      context,
      requiredPermission: "api_access.manage",
      auditType,
      deniedMessage: "API Access administration requires 'api_access.manage' permission"
    });
  }

  private async recordPrincipalMutation(
    actor: AuthenticatedUser,
    context: RuntimeCallContext,
    type: string,
    principal: ServicePrincipalRecord
  ): Promise<void> {
    await this.options.auditRecorder.record({
      type,
      status: "success",
      actor: auditActorFromUser(actor),
      subject: principal.id,
      correlationId: context.correlationId,
      metadata: {
        servicePrincipalId: principal.id,
        status: principal.status,
        permissions: principal.permissions
      }
    });
  }
}
