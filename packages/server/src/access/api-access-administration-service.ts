import { API_CREDENTIAL_SCOPES, SERVICE_PRINCIPAL_PERMISSIONS } from "@work-shape/catalyst-core";
import type {
  ApiCredentialScope,
  ServicePrincipalPermission
} from "@work-shape/catalyst-api-contract";
import {
  AppError,
  isAuthenticatedServicePrincipal,
  isPermission,
  asApiCredentialId,
  asServicePrincipalId,
  asUserId,
  auditActorFromIdentity,
  type ApiCredentialRecord,
  type AuthenticatedUser,
  type HeldRight,
  type OperationAuthorization,
  type OperationAuthorizeContext,
  type OperationExecutionContext,
  type RuntimeCallContext,
  type ServicePrincipalRecord
} from "@work-shape/catalyst-core";
import { recordGovernanceAccess } from "./governance-actions";
import {
  authorizeGivingToPrincipal,
  principalRights,
  type PrincipalRightsOptions
} from "./principal-rights";
import { requireAuthorized, withRightsHeld } from "./rights-held";
import type { ChatServerOptions } from "../types";

const SERVICE_PERMISSIONS = new Set<ServicePrincipalPermission>(SERVICE_PRINCIPAL_PERMISSIONS);
const CREDENTIAL_SCOPES = new Set<ApiCredentialScope>(API_CREDENTIAL_SCOPES);

/** The right that creates service principals, gives and takes their rights, and enables them. */
export const SERVICE_PRINCIPALS_ACTION = "service_principals.manage";
/** The right over API keys: a principal's, and the oversight of every person's own. */
const API_ACCESS_ACTION = "api_access.manage";

/** What a changing API access operation takes from its Operation Run. */
type ChangeContext = Pick<
  OperationExecutionContext,
  "actor" | "access" | "audit" | "correlationId"
>;

/** What an API access operation's own check reads of the call. */
type Caller = Pick<OperationAuthorizeContext, "actor" | "access">;

/**
 * The one rule on who administers service principals, for every place that asks it: creating
 * and changing one, and writing its grant rows (`access-workflow.ts`). A person who holds
 * `service_principals.manage`. A service principal never passes, a Workflow Run's among them.
 * What the principal is given beside that asks the rule of no escalation
 * (`authorizeGivingToPrincipal`).
 */
export function authorizePrincipalAdministration(
  caller: Caller,
  operationId: string
): OperationAuthorization {
  return authorizePersonHolding(SERVICE_PRINCIPALS_ACTION, caller, operationId);
}

function authorizePersonHolding(
  action: string,
  { actor, access }: Caller,
  operationId: string
): OperationAuthorization {
  const right = access.authorize(action);
  if (!right.allowed) {
    return { allowed: false, action, reason: right.reason };
  }
  return isAuthenticatedServicePrincipal(actor)
    ? { allowed: false, action: operationId, reason: "user_only" }
    : { allowed: true };
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
 * changes are registered operations: each is checked by its `authorize…` method here before
 * its change runs.
 */
export class ApiAccessAdministrationWorkflow {
  constructor(private readonly options: ChatServerOptions) {}

  /** Creating a principal: the right over principals, and every legacy key it is given. */
  async authorizeCreatePrincipal(
    operationId: string,
    caller: Caller,
    command: Pick<CreateServicePrincipalCommand, "displayLabel" | "permissions">
  ): Promise<OperationAuthorization> {
    const administration = authorizePrincipalAdministration(caller, operationId);
    if (!administration.allowed) return administration;
    return authorizeGivingToPrincipal(
      this.rightsOptions(),
      caller,
      command,
      keyRights(command.permissions ?? [])
    );
  }

  /**
   * Changing a principal: the right over principals, and the rule on what the change gives. A
   * key added is given. Enabling a disabled principal lends everything it holds once enabled.
   * Taking a key away and disabling ask nothing more. A principal the instance does not have
   * passes: the write answers that itself.
   */
  async authorizeUpdatePrincipal(
    operationId: string,
    caller: Caller,
    command: Pick<UpdateServicePrincipalCommand, "servicePrincipalId" | "status" | "permissions">
  ): Promise<OperationAuthorization> {
    const administration = authorizePrincipalAdministration(caller, operationId);
    if (!administration.allowed) return administration;
    const principal = await this.findPrincipal(command.servicePrincipalId);
    if (!principal) return { allowed: true };
    const keys = command.permissions ?? principal.permissions;
    if (principal.status !== "active" && command.status === "active") {
      const held = await principalRights(this.rightsOptions(), principal.id);
      // The rights it holds once enabled: its keys as the change leaves them, and the rest.
      const others = held.filter(
        (right) => right.resource !== undefined || !isPermission(right.action)
      );
      return authorizeGivingToPrincipal(this.rightsOptions(), caller, principal, [
        ...keyRights(keys),
        ...others
      ]);
    }
    const added = keys.filter((key) => !principal.permissions.includes(key));
    return authorizeGivingToPrincipal(this.rightsOptions(), caller, principal, keyRights(added));
  }

  /**
   * Issuing a principal a key: `api_access.manage`, and every right the principal holds, since
   * the key is a bearer copy of them. A principal the instance does not have passes: the write
   * answers that itself.
   */
  async authorizeCreateCredential(
    operationId: string,
    caller: Caller,
    command: Pick<CreateApiCredentialCommand, "servicePrincipalId">
  ): Promise<OperationAuthorization> {
    const keyAdministration = authorizePersonHolding(API_ACCESS_ACTION, caller, operationId);
    if (!keyAdministration.allowed) return keyAdministration;
    const principal = await this.findPrincipal(command.servicePrincipalId);
    if (!principal) return { allowed: true };
    return authorizeGivingToPrincipal(
      this.rightsOptions(),
      caller,
      principal,
      await principalRights(this.rightsOptions(), principal.id)
    );
  }

  /** Revoking a key takes away and asks only `api_access.manage`. */
  authorizeRevokeCredential(operationId: string, caller: Caller): OperationAuthorization {
    return authorizePersonHolding(API_ACCESS_ACTION, caller, operationId);
  }

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
    operationId: string,
    context: ChangeContext,
    command: CreateServicePrincipalCommand
  ): Promise<ServicePrincipalDetail> {
    this.requireServicePermissions(command.permissions);
    const principal = await this.whileRightsHeld(context, async (held, caller) => {
      requireAuthorized(await held.authorizeCreatePrincipal(operationId, caller, command));
      return held.options.stores.apiAccess.createServicePrincipal({
        clientInstanceId: this.options.clientInstanceId,
        name: command.name,
        displayLabel: command.displayLabel,
        description: command.description,
        status: command.status,
        permissionRefs: [],
        permissions: command.permissions ?? [],
        createdByUserId: asUserId(caller.actor.id)
      });
    });
    await this.recordPrincipalMutation(context, "api_access.service_principal_created", principal);
    return this.detail(principal);
  }

  async updateServicePrincipal(
    operationId: string,
    context: ChangeContext,
    command: UpdateServicePrincipalCommand
  ): Promise<ServicePrincipalDetail> {
    this.requireServicePermissions(command.permissions);
    const principal = await this.whileRightsHeld(context, async (held, caller) => {
      requireAuthorized(await held.authorizeUpdatePrincipal(operationId, caller, command));
      return held.options.stores.apiAccess.updateServicePrincipal({
        clientInstanceId: this.options.clientInstanceId,
        servicePrincipalId: asServicePrincipalId(command.servicePrincipalId),
        displayLabel: command.displayLabel,
        description: command.description,
        status: command.status,
        permissions: command.permissions,
        grantedBy: asUserId(caller.actor.id)
      });
    });
    await this.recordPrincipalMutation(context, "api_access.service_principal_updated", principal);
    return this.detail(principal);
  }

  /**
   * Answers the key once. The operation is registered as `secret`, so the run keeps nothing of
   * this answer; the audit row below names the key by its prefix alone.
   */
  async createApiCredential(
    operationId: string,
    context: ChangeContext,
    command: CreateApiCredentialCommand
  ): Promise<{ credential: ApiCredentialRecord; secret: string }> {
    this.requireCredentialScopes(command.scopes);
    this.requireFutureExpiry(command.expiresAt);
    const { audit: auditRecorder } = context;
    const created = await this.whileRightsHeld(context, async (held, caller) => {
      requireAuthorized(await held.authorizeCreateCredential(operationId, caller, command));
      return held.options.stores.apiAccess.createApiCredential({
        clientInstanceId: this.options.clientInstanceId,
        servicePrincipalId: asServicePrincipalId(command.servicePrincipalId),
        name: command.name,
        scopes: command.scopes,
        expiresAt: command.expiresAt
      });
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

  /**
   * `withRightsHeld` for a change of a service principal or its keys: the workflow on the
   * transaction's stores, and the caller with their rights now.
   */
  private whileRightsHeld<Result>(
    context: ChangeContext,
    change: (held: ApiAccessAdministrationWorkflow, caller: Caller) => Promise<Result>
  ): Promise<Result> {
    return withRightsHeld(
      this.options,
      { actor: context.actor, access: context.access },
      ({ options, actor, access }) =>
        change(new ApiAccessAdministrationWorkflow(options), { actor, access })
    );
  }

  private rightsOptions(): PrincipalRightsOptions {
    return { clientInstanceId: this.options.clientInstanceId, access: this.options.stores.access };
  }

  private async findPrincipal(
    servicePrincipalId: string
  ): Promise<ServicePrincipalRecord | undefined> {
    const principals = await this.options.stores.apiAccess.listServicePrincipals({
      clientInstanceId: this.options.clientInstanceId
    });
    return principals.find((candidate) => candidate.id === servicePrincipalId);
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

/** Legacy keys as rights on the whole instance, as a principal holds them. */
function keyRights(keys: readonly string[]): HeldRight[] {
  return keys.map((action) => ({ action }));
}
