import type { ApiCredentialScope, ServicePrincipalPermission } from "@vivd-catalyst/api-contract";
import {
  AppError,
  isAuthenticatedServicePrincipal,
  isSuperadmin,
  asApiCredentialId,
  asServicePrincipalId,
  asUserId,
  auditActorFromIdentity,
  type ApiCredentialRecord,
  type AuthenticatedUser,
  type OperationAuthorization,
  type OperationAuthorizeContext,
  type OperationExecutionContext,
  type RuntimeCallContext,
  type ServicePrincipalRecord
} from "@vivd-catalyst/core";
import { recordGovernanceAccess } from "./governance-actions";
import type { ChatServerOptions } from "./types";

const SERVICE_PERMISSIONS = new Set<ServicePrincipalPermission>([
  "config_assets.read",
  "config_assets.release"
]);
const CREDENTIAL_SCOPES = new Set<ApiCredentialScope>([
  "config_assets:read",
  "config_assets:release"
]);

/** The right every API access operation asks for. */
const API_ACCESS_ACTION = "api_access.manage";

/** What a changing API access operation takes from its Operation Run. */
type ChangeContext = Pick<OperationExecutionContext, "actor" | "audit" | "correlationId">;

/**
 * Who may change API access: a person who holds `api_access.manage` on the instance and is a
 * superadmin. It is the `authorize` of the four changing operations, so the run records the
 * check and a refusal, and nothing of the operation runs for anybody else. A refusal for the
 * role names the operation, since no right stands for the role.
 */
export function authorizeApiAccessChange(
  operationId: string
): (input: unknown, context: OperationAuthorizeContext) => OperationAuthorization {
  return (_input, caller) => authorizePrincipalAdministration(caller, operationId);
}

/**
 * The one rule on who administers service principals, for every place that asks it: the four
 * changes of API access, and letting a Workflow act as a principal (`workflow-run-as.ts`).
 * A service principal never passes, a Workflow Run's among them.
 */
export function authorizePrincipalAdministration(
  { actor, access }: Pick<OperationAuthorizeContext, "actor" | "access">,
  operationId: string
): OperationAuthorization {
  const right = access.authorize(API_ACCESS_ACTION);
  if (!right.allowed) {
    return { allowed: false, action: API_ACCESS_ACTION, reason: right.reason };
  }
  return !isAuthenticatedServicePrincipal(actor) && isSuperadmin(actor)
    ? { allowed: true }
    : { allowed: false, action: operationId, reason: "no_grant" };
}

export interface ServicePrincipalDetail {
  principal: ServicePrincipalRecord;
  credentials: ApiCredentialRecord[];
}

interface CreateServicePrincipalCommand {
  name?: string;
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

/**
 * What an administrator sees and changes about service principals and their keys. The four
 * changes are registered operations: the caller's right is checked by `authorizeApiAccessChange`
 * before a method here runs.
 */
export class ApiAccessAdministrationWorkflow {
  constructor(private readonly options: ChatServerOptions) {}

  async listServicePrincipals(
    actor: AuthenticatedUser,
    context: RuntimeCallContext
  ): Promise<ServicePrincipalDetail[]> {
    // The list is a plain read with no Operation Run, so it records the access itself.
    await recordGovernanceAccess({
      options: this.options,
      user: actor,
      context,
      auditType: "api_access.service_principals_viewed"
    });
    const principals = await this.options.stores.apiAccess.listServicePrincipals({
      clientInstanceId: this.options.clientInstanceId
    });
    return Promise.all(principals.map((principal) => this.detail(principal)));
  }

  async createServicePrincipal(
    context: ChangeContext,
    command: CreateServicePrincipalCommand
  ): Promise<ServicePrincipalDetail> {
    this.requireServicePermissions(command.permissions);
    const principal = await this.options.stores.apiAccess.createServicePrincipal({
      clientInstanceId: this.options.clientInstanceId,
      name: command.name,
      displayLabel: command.displayLabel,
      description: command.description,
      status: command.status,
      permissionRefs: [],
      permissions: command.permissions ?? [],
      createdByUserId: asUserId(context.actor.id)
    });
    await this.recordPrincipalMutation(context, "api_access.service_principal_created", principal);
    return this.detail(principal);
  }

  async updateServicePrincipal(
    context: ChangeContext,
    command: UpdateServicePrincipalCommand
  ): Promise<ServicePrincipalDetail> {
    this.requireServicePermissions(command.permissions);
    const principal = await this.options.stores.apiAccess.updateServicePrincipal({
      clientInstanceId: this.options.clientInstanceId,
      servicePrincipalId: asServicePrincipalId(command.servicePrincipalId),
      displayLabel: command.displayLabel,
      description: command.description,
      status: command.status,
      permissions: command.permissions
    });
    await this.recordPrincipalMutation(context, "api_access.service_principal_updated", principal);
    return this.detail(principal);
  }

  /**
   * Answers the key once. The operation is registered as `secret`, so the run keeps nothing of
   * this answer; the audit row below names the key by its prefix alone.
   */
  async createApiCredential(
    context: ChangeContext,
    command: CreateApiCredentialCommand
  ): Promise<{ credential: ApiCredentialRecord; secret: string }> {
    this.requireCredentialScopes(command.scopes);
    this.requireFutureExpiry(command.expiresAt);
    const { audit: auditRecorder } = context;
    const created = await this.options.stores.apiAccess.createApiCredential({
      clientInstanceId: this.options.clientInstanceId,
      servicePrincipalId: asServicePrincipalId(command.servicePrincipalId),
      name: command.name,
      scopes: command.scopes,
      expiresAt: command.expiresAt
    });
    await auditRecorder.record({
      type: "api_access.credential_created",
      status: "success",
      actor: auditActorFromIdentity(context.actor),
      correlationId: context.correlationId,
      subject: created.credential.id,
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
    context: ChangeContext,
    credentialId: string
  ): Promise<ApiCredentialRecord> {
    const { audit: auditRecorder } = context;
    const credential = await this.options.stores.apiAccess.revokeApiCredential({
      clientInstanceId: this.options.clientInstanceId,
      credentialId: asApiCredentialId(credentialId)
    });
    await auditRecorder.record({
      type: "api_access.credential_revoked",
      status: "success",
      actor: auditActorFromIdentity(context.actor),
      correlationId: context.correlationId,
      subject: credential.id,
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
      credentials: await this.options.stores.apiAccess.listApiCredentials({
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
    const invalid = scopes?.find((scope) => !CREDENTIAL_SCOPES.has(scope as ApiCredentialScope));
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

  private async recordPrincipalMutation(
    context: ChangeContext,
    type: string,
    principal: ServicePrincipalRecord
  ): Promise<void> {
    const { audit: auditRecorder } = context;
    await auditRecorder.record({
      type,
      status: "success",
      actor: auditActorFromIdentity(context.actor),
      correlationId: context.correlationId,
      subject: principal.id,
      metadata: {
        servicePrincipalId: principal.id,
        status: principal.status,
        permissions: principal.permissions
      }
    });
  }
}
