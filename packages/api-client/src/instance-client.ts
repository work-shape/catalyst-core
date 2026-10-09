import {
  apiOperations,
  type ApprovalRequestStatus,
  type ConfigAssetKind,
  type LocaleCode
} from "@vivd-catalyst/api-contract";
import * as generatedSdk from "./generated/sdk.gen";
import type { ApiClientTransport, OperationRequestInput } from "./transport";

/** As many audit entries as the audit screens show. */
const AUDIT_PAGE_SIZE = 100;

export function createInstanceClients(transport: ApiClientTransport) {
  return {
    authentication: {
      exchangeApiKey: () =>
        transport.unwrapJson(
          generatedSdk.accessTokensExchange({ client: transport.generatedClient }),
          apiOperations["access_tokens.exchange"].response.schema
        )
    },
    account: {
      get: (signal?: AbortSignal) =>
        transport.unwrapJson(
          generatedSdk.meGet({ client: transport.generatedClient, signal }),
          apiOperations["me.get"].response.schema
        ),
      update: (input: OperationRequestInput<(typeof apiOperations)["me.update"]>) =>
        transport.unwrapJson(
          generatedSdk.meUpdate({
            client: transport.generatedClient,
            body: apiOperations["me.update"].body.parse(input)
          }),
          apiOperations["me.update"].response.schema
        ),
      changePassword: (
        input: OperationRequestInput<(typeof apiOperations)["me.password.change"]>
      ) =>
        transport.unwrapJson(
          generatedSdk.mePasswordChange({
            client: transport.generatedClient,
            body: apiOperations["me.password.change"].body.parse(input)
          }),
          apiOperations["me.password.change"].response.schema
        ),
      delete: () =>
        transport.unwrapJson(
          generatedSdk.meDelete({ client: transport.generatedClient }),
          apiOperations["me.delete"].response.schema
        ),
      modelPreference: {
        get: () =>
          transport.unwrapJson(
            generatedSdk.meModelPreferenceGet({ client: transport.generatedClient }),
            apiOperations["me.model_preference.get"].response.schema
          ),
        set: (input: OperationRequestInput<(typeof apiOperations)["me.model_preference.set"]>) =>
          transport.unwrapJson(
            generatedSdk.meModelPreferenceSet({
              client: transport.generatedClient,
              body: apiOperations["me.model_preference.set"].body.parse(input)
            }),
            apiOperations["me.model_preference.set"].response.schema
          )
      }
    },
    passwordSetup: {
      requestReset: (
        input: OperationRequestInput<(typeof apiOperations)["password_reset.request"]>,
        locale?: LocaleCode
      ) =>
        transport.unwrapJson(
          generatedSdk.passwordResetRequest({
            client: transport.generatedClient,
            query: { locale },
            body: apiOperations["password_reset.request"].body.parse(input)
          }),
          apiOperations["password_reset.request"].response.schema
        ),
      complete: (input: OperationRequestInput<(typeof apiOperations)["password_setup.complete"]>) =>
        transport.unwrapJson(
          generatedSdk.passwordSetupComplete({
            client: transport.generatedClient,
            body: apiOperations["password_setup.complete"].body.parse(input)
          }),
          apiOperations["password_setup.complete"].response.schema
        )
    },
    branding: {
      get: (locale?: LocaleCode) =>
        transport.unwrapJson(
          generatedSdk.brandingGet({
            client: transport.generatedClient,
            query: { locale }
          }),
          apiOperations["branding.get"].response.schema
        )
    },
    configuration: {
      get: (locale?: LocaleCode) =>
        transport.unwrapJson(
          generatedSdk.configGet({
            client: transport.generatedClient,
            query: { locale }
          }),
          apiOperations["config.get"].response.schema
        )
    },
    governance: {
      // The audit screens show the latest entries. One call is one request, because the server
      // records every call as a view of the audit log. The activity list is not paged at all.
      listAuditEvents: async () =>
        (
          await transport.unwrapJson(
            generatedSdk.auditEventsList({
              client: transport.generatedClient,
              query: { limit: AUDIT_PAGE_SIZE }
            }),
            apiOperations["audit_events.list"].response.schema
          )
        ).items,
      listAuditActivities: async () =>
        (
          await transport.unwrapJson(
            generatedSdk.auditActivitiesList({ client: transport.generatedClient }),
            apiOperations["audit_activities.list"].response.schema
          )
        ).items,
      getUsageSummary: () =>
        transport.unwrapJson(
          generatedSdk.usageGetSummary({ client: transport.generatedClient }),
          apiOperations["usage.get_summary"].response.schema
        )
    },
    approvalRequests: createApprovalRequestsClient(transport),
    configAssets: createConfigAssetsClient(transport),
    apiAccess: createApiAccessClient(transport),
    users: createUsersClient(transport)
  };
}

function createConfigAssetsClient(transport: ApiClientTransport) {
  return {
    getOverview: () =>
      transport.unwrapJson(
        generatedSdk.configAssetsGetOverview({ client: transport.generatedClient }),
        apiOperations["config_assets.get_overview"].response.schema
      ),
    get: (kind: ConfigAssetKind, name: string) =>
      transport.unwrapJson(
        generatedSdk.configAssetsGet({
          client: transport.generatedClient,
          path: { kind, name }
        }),
        apiOperations["config_assets.get"].response.schema
      ),
    put: (
      kind: ConfigAssetKind,
      name: string,
      input: OperationRequestInput<(typeof apiOperations)["config_assets.put"]>
    ) =>
      transport.unwrapJson(
        generatedSdk.configAssetsPut({
          client: transport.generatedClient,
          path: { kind, name },
          body: apiOperations["config_assets.put"].body.parse(input)
        }),
        apiOperations["config_assets.put"].response.schema
      ),
    delete: (
      kind: ConfigAssetKind,
      name: string,
      input: OperationRequestInput<(typeof apiOperations)["config_assets.delete"]> = {}
    ) =>
      transport.unwrapJson(
        generatedSdk.configAssetsDelete({
          client: transport.generatedClient,
          path: { kind, name },
          body: apiOperations["config_assets.delete"].body.parse(input)
        }),
        apiOperations["config_assets.delete"].response.schema
      ),
    setDefaultAgent: (
      input: OperationRequestInput<(typeof apiOperations)["config_agents.set_default"]>
    ) =>
      transport.unwrapJson(
        generatedSdk.configAgentsSetDefault({
          client: transport.generatedClient,
          body: apiOperations["config_agents.set_default"].body.parse(input)
        }),
        apiOperations["config_agents.set_default"].response.schema
      ),
    setAgentAvailability: (
      name: string,
      input: OperationRequestInput<(typeof apiOperations)["config_agents.set_availability"]>
    ) =>
      transport.unwrapJson(
        generatedSdk.configAgentsSetAvailability({
          client: transport.generatedClient,
          path: { name },
          body: apiOperations["config_agents.set_availability"].body.parse(input)
        }),
        apiOperations["config_agents.set_availability"].response.schema
      ),
    listAdministeredWorkspaces: () =>
      transport.unwrapList(
        (paging) =>
          generatedSdk.instanceWorkspacesList({
            client: transport.generatedClient,
            query: paging
          }),
        apiOperations["instance.workspaces.list"].response.schema
      ),
    listRevisions: (kind: ConfigAssetKind, name: string) =>
      transport.unwrapList(
        (paging) =>
          generatedSdk.configAssetsRevisionsList({
            client: transport.generatedClient,
            path: { kind, name },
            query: paging
          }),
        apiOperations["config_assets.revisions.list"].response.schema
      ),
    revert: (
      kind: ConfigAssetKind,
      name: string,
      input: OperationRequestInput<(typeof apiOperations)["config_assets.revert"]>
    ) =>
      transport.unwrapJson(
        generatedSdk.configAssetsRevert({
          client: transport.generatedClient,
          path: { kind, name },
          body: apiOperations["config_assets.revert"].body.parse(input)
        }),
        apiOperations["config_assets.revert"].response.schema
      ),
    export: () =>
      transport.unwrapJson(
        generatedSdk.configAssetsExport({ client: transport.generatedClient }),
        apiOperations["config_assets.export"].response.schema
      ),
    replace: (input: OperationRequestInput<(typeof apiOperations)["config_assets.replace"]>) =>
      transport.unwrapJson(
        generatedSdk.configAssetsReplace({
          client: transport.generatedClient,
          body: apiOperations["config_assets.replace"].body.parse(input)
        }),
        apiOperations["config_assets.replace"].response.schema
      ),
    validate: (input: OperationRequestInput<(typeof apiOperations)["config_assets.validate"]>) =>
      transport.unwrapJson(
        generatedSdk.configAssetsValidate({
          client: transport.generatedClient,
          body: apiOperations["config_assets.validate"].body.parse(input)
        }),
        apiOperations["config_assets.validate"].response.schema
      )
  };
}

function createApiAccessClient(transport: ApiClientTransport) {
  return {
    listServicePrincipals: () =>
      transport.unwrapList(
        (paging) =>
          generatedSdk.servicePrincipalsList({ client: transport.generatedClient, query: paging }),
        apiOperations["service_principals.list"].response.schema
      ),
    createServicePrincipal: (
      input: OperationRequestInput<(typeof apiOperations)["service_principals.create"]>
    ) =>
      transport.unwrapJson(
        generatedSdk.servicePrincipalsCreate({
          client: transport.generatedClient,
          body: apiOperations["service_principals.create"].body.parse(input)
        }),
        apiOperations["service_principals.create"].response.schema
      ),
    updateServicePrincipal: (
      servicePrincipalId: string,
      input: OperationRequestInput<(typeof apiOperations)["service_principals.update"]>
    ) =>
      transport.unwrapJson(
        generatedSdk.servicePrincipalsUpdate({
          client: transport.generatedClient,
          path: { servicePrincipalId },
          body: apiOperations["service_principals.update"].body.parse(input)
        }),
        apiOperations["service_principals.update"].response.schema
      ),
    createCredential: (
      servicePrincipalId: string,
      input: OperationRequestInput<(typeof apiOperations)["api_credentials.create"]>
    ) =>
      transport.unwrapJson(
        generatedSdk.apiCredentialsCreate({
          client: transport.generatedClient,
          path: { servicePrincipalId },
          body: apiOperations["api_credentials.create"].body.parse(input)
        }),
        apiOperations["api_credentials.create"].response.schema
      ),
    revokeCredential: (credentialId: string) =>
      transport.unwrapJson(
        generatedSdk.apiCredentialsRevoke({
          client: transport.generatedClient,
          path: { credentialId }
        }),
        apiOperations["api_credentials.revoke"].response.schema
      )
  };
}

function createUsersClient(transport: ApiClientTransport) {
  return {
    list: () =>
      transport.unwrapList(
        (paging) => generatedSdk.usersList({ client: transport.generatedClient, query: paging }),
        apiOperations["users.list"].response.schema
      ),
    create: (input: OperationRequestInput<(typeof apiOperations)["users.create"]>) =>
      transport.unwrapJson(
        generatedSdk.usersCreate({
          client: transport.generatedClient,
          body: apiOperations["users.create"].body.parse(input)
        }),
        apiOperations["users.create"].response.schema
      ),
    update: (
      userId: string,
      input: OperationRequestInput<(typeof apiOperations)["users.update"]>
    ) =>
      transport.unwrapJson(
        generatedSdk.usersUpdate({
          client: transport.generatedClient,
          path: { userId },
          body: apiOperations["users.update"].body.parse(input)
        }),
        apiOperations["users.update"].response.schema
      ),
    delete: (userId: string) =>
      transport.unwrapJson(
        generatedSdk.usersDelete({
          client: transport.generatedClient,
          path: { userId }
        }),
        apiOperations["users.delete"].response.schema
      ),
    upsertIdentity: (
      userId: string,
      input: OperationRequestInput<(typeof apiOperations)["users.identities.upsert"]>
    ) =>
      transport.unwrapJson(
        generatedSdk.usersIdentitiesUpsert({
          client: transport.generatedClient,
          path: { userId },
          body: apiOperations["users.identities.upsert"].body.parse(input)
        }),
        apiOperations["users.identities.upsert"].response.schema
      ),
    resetPassword: (
      userId: string,
      input: OperationRequestInput<(typeof apiOperations)["users.password.reset"]>
    ) =>
      transport.unwrapJson(
        generatedSdk.usersPasswordReset({
          client: transport.generatedClient,
          path: { userId },
          body: apiOperations["users.password.reset"].body.parse(input)
        }),
        apiOperations["users.password.reset"].response.schema
      ),
    sendInvitation: (userId: string) =>
      transport.unwrapJson(
        generatedSdk.usersInvitationSend({
          client: transport.generatedClient,
          path: { userId }
        }),
        apiOperations["users.invitation.send"].response.schema
      ),
    deleteIdentity: (userId: string, authSource: string, externalUserId: string) =>
      transport.unwrapJson(
        generatedSdk.usersIdentitiesDelete({
          client: transport.generatedClient,
          path: { userId, authSource, externalUserId }
        }),
        apiOperations["users.identities.delete"].response.schema
      )
  };
}

function createApprovalRequestsClient(transport: ApiClientTransport) {
  return {
    get: (requestId: string) =>
      transport.unwrapJson(
        generatedSdk.approvalRequestsGet({
          client: transport.generatedClient,
          path: { requestId }
        }),
        apiOperations["approval_requests.get"].response.schema
      ),
    list: (status?: ApprovalRequestStatus) =>
      transport.unwrapList(
        (paging) =>
          generatedSdk.approvalRequestsList({
            client: transport.generatedClient,
            query: { status, ...paging }
          }),
        apiOperations["approval_requests.list"].response.schema
      ),
    pendingCount: () =>
      transport.unwrapJson(
        generatedSdk.approvalRequestsCountPending({ client: transport.generatedClient }),
        apiOperations["approval_requests.count_pending"].response.schema
      ),
    decide: (
      requestId: string,
      input: OperationRequestInput<(typeof apiOperations)["approval_requests.decide"]>
    ) =>
      transport.unwrapJson(
        generatedSdk.approvalRequestsDecide({
          client: transport.generatedClient,
          path: { requestId },
          body: apiOperations["approval_requests.decide"].body.parse(input)
        }),
        apiOperations["approval_requests.decide"].response.schema
      ),
    revert: (requestId: string) =>
      transport.unwrapJson(
        generatedSdk.approvalRequestsRevert({
          client: transport.generatedClient,
          path: { requestId }
        }),
        apiOperations["approval_requests.revert"].response.schema
      ),
    withdraw: (requestId: string) =>
      transport.unwrapJson(
        generatedSdk.approvalRequestsWithdraw({
          client: transport.generatedClient,
          path: { requestId }
        }),
        apiOperations["approval_requests.withdraw"].response.schema
      )
  };
}
