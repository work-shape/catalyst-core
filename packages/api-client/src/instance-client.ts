import {
  apiOperations,
  type ApprovalRequestStatus,
  type ConfigAssetKind,
  type LocaleCode
} from "@vivd-catalyst/api-contract";
import * as generatedSdk from "./generated/sdk.gen";
import type { ApiClientTransport, OperationRequestInput } from "./transport";

export function createInstanceClients(transport: ApiClientTransport) {
  return {
    authentication: {
      exchangeApiKey: () =>
        transport.unwrapJson(
          generatedSdk.exchangeApiKey({ client: transport.generatedClient }),
          apiOperations.exchangeApiKey.response.schema
        )
    },
    account: {
      get: (signal?: AbortSignal) =>
        transport.unwrapJson(
          generatedSdk.getCurrentUser({ client: transport.generatedClient, signal }),
          apiOperations.getCurrentUser.response.schema
        ),
      update: (input: OperationRequestInput<typeof apiOperations.updateCurrentUser>) =>
        transport.unwrapJson(
          generatedSdk.updateCurrentUser({
            client: transport.generatedClient,
            body: apiOperations.updateCurrentUser.body.parse(input)
          }),
          apiOperations.updateCurrentUser.response.schema
        ),
      changePassword: (
        input: OperationRequestInput<typeof apiOperations.changeCurrentUserPassword>
      ) =>
        transport.unwrapJson(
          generatedSdk.changeCurrentUserPassword({
            client: transport.generatedClient,
            body: apiOperations.changeCurrentUserPassword.body.parse(input)
          }),
          apiOperations.changeCurrentUserPassword.response.schema
        ),
      delete: () =>
        transport.unwrapJson(
          generatedSdk.deleteCurrentUser({ client: transport.generatedClient }),
          apiOperations.deleteCurrentUser.response.schema
        ),
      modelPreference: {
        get: () =>
          transport.unwrapJson(
            generatedSdk.getCurrentUserModelPreference({ client: transport.generatedClient }),
            apiOperations.getCurrentUserModelPreference.response.schema
          ),
        set: (input: OperationRequestInput<typeof apiOperations.setCurrentUserModelPreference>) =>
          transport.unwrapJson(
            generatedSdk.setCurrentUserModelPreference({
              client: transport.generatedClient,
              body: apiOperations.setCurrentUserModelPreference.body.parse(input)
            }),
            apiOperations.setCurrentUserModelPreference.response.schema
          )
      }
    },
    passwordSetup: {
      requestReset: (
        input: OperationRequestInput<typeof apiOperations.requestPasswordReset>,
        locale?: LocaleCode
      ) =>
        transport.unwrapJson(
          generatedSdk.requestPasswordReset({
            client: transport.generatedClient,
            query: { locale },
            body: apiOperations.requestPasswordReset.body.parse(input)
          }),
          apiOperations.requestPasswordReset.response.schema
        ),
      complete: (input: OperationRequestInput<typeof apiOperations.completePasswordSetup>) =>
        transport.unwrapJson(
          generatedSdk.completePasswordSetup({
            client: transport.generatedClient,
            body: apiOperations.completePasswordSetup.body.parse(input)
          }),
          apiOperations.completePasswordSetup.response.schema
        )
    },
    branding: {
      get: (locale?: LocaleCode) =>
        transport.unwrapJson(
          generatedSdk.getBranding({
            client: transport.generatedClient,
            query: { locale }
          }),
          apiOperations.getBranding.response.schema
        )
    },
    configuration: {
      get: (locale?: LocaleCode) =>
        transport.unwrapJson(
          generatedSdk.getConfig({
            client: transport.generatedClient,
            query: { locale }
          }),
          apiOperations.getConfig.response.schema
        )
    },
    governance: {
      listAuditEvents: () =>
        transport.unwrapJson(
          generatedSdk.listAuditEvents({ client: transport.generatedClient }),
          apiOperations.listAuditEvents.response.schema
        ),
      listAuditActivities: () =>
        transport.unwrapJson(
          generatedSdk.listAuditActivities({ client: transport.generatedClient }),
          apiOperations.listAuditActivities.response.schema
        ),
      getUsageSummary: () =>
        transport.unwrapJson(
          generatedSdk.getUsageSummary({ client: transport.generatedClient }),
          apiOperations.getUsageSummary.response.schema
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
        generatedSdk.getConfigAssetsOverview({ client: transport.generatedClient }),
        apiOperations.getConfigAssetsOverview.response.schema
      ),
    get: (kind: ConfigAssetKind, name: string) =>
      transport.unwrapJson(
        generatedSdk.getConfigAsset({
          client: transport.generatedClient,
          path: { kind, name }
        }),
        apiOperations.getConfigAsset.response.schema
      ),
    put: (
      kind: ConfigAssetKind,
      name: string,
      input: OperationRequestInput<typeof apiOperations.putConfigAsset>
    ) =>
      transport.unwrapJson(
        generatedSdk.putConfigAsset({
          client: transport.generatedClient,
          path: { kind, name },
          body: apiOperations.putConfigAsset.body.parse(input)
        }),
        apiOperations.putConfigAsset.response.schema
      ),
    delete: (
      kind: ConfigAssetKind,
      name: string,
      input: OperationRequestInput<typeof apiOperations.deleteConfigAsset> = {}
    ) =>
      transport.unwrapJson(
        generatedSdk.deleteConfigAsset({
          client: transport.generatedClient,
          path: { kind, name },
          body: apiOperations.deleteConfigAsset.body.parse(input)
        }),
        apiOperations.deleteConfigAsset.response.schema
      ),
    setDefaultAgent: (input: OperationRequestInput<typeof apiOperations.setDefaultConfigAgent>) =>
      transport.unwrapJson(
        generatedSdk.setDefaultConfigAgent({
          client: transport.generatedClient,
          body: apiOperations.setDefaultConfigAgent.body.parse(input)
        }),
        apiOperations.setDefaultConfigAgent.response.schema
      ),
    setAgentAvailability: (
      name: string,
      input: OperationRequestInput<typeof apiOperations.setConfigAgentAvailability>
    ) =>
      transport.unwrapJson(
        generatedSdk.setConfigAgentAvailability({
          client: transport.generatedClient,
          path: { name },
          body: apiOperations.setConfigAgentAvailability.body.parse(input)
        }),
        apiOperations.setConfigAgentAvailability.response.schema
      ),
    listAdministeredWorkspaces: () =>
      transport.unwrapJson(
        generatedSdk.listAdministeredCollaborationWorkspaces({
          client: transport.generatedClient
        }),
        apiOperations.listAdministeredCollaborationWorkspaces.response.schema
      ),
    listRevisions: (kind: ConfigAssetKind, name: string) =>
      transport.unwrapJson(
        generatedSdk.listConfigAssetRevisions({
          client: transport.generatedClient,
          path: { kind, name }
        }),
        apiOperations.listConfigAssetRevisions.response.schema
      ),
    revert: (
      kind: ConfigAssetKind,
      name: string,
      input: OperationRequestInput<typeof apiOperations.revertConfigAsset>
    ) =>
      transport.unwrapJson(
        generatedSdk.revertConfigAsset({
          client: transport.generatedClient,
          path: { kind, name },
          body: apiOperations.revertConfigAsset.body.parse(input)
        }),
        apiOperations.revertConfigAsset.response.schema
      ),
    export: () =>
      transport.unwrapJson(
        generatedSdk.exportConfigAssets({ client: transport.generatedClient }),
        apiOperations.exportConfigAssets.response.schema
      ),
    replace: (input: OperationRequestInput<typeof apiOperations.replaceConfigAssets>) =>
      transport.unwrapJson(
        generatedSdk.replaceConfigAssets({
          client: transport.generatedClient,
          body: apiOperations.replaceConfigAssets.body.parse(input)
        }),
        apiOperations.replaceConfigAssets.response.schema
      ),
    validate: (input: OperationRequestInput<typeof apiOperations.validateConfigAssets>) =>
      transport.unwrapJson(
        generatedSdk.validateConfigAssets({
          client: transport.generatedClient,
          body: apiOperations.validateConfigAssets.body.parse(input)
        }),
        apiOperations.validateConfigAssets.response.schema
      )
  };
}

function createApiAccessClient(transport: ApiClientTransport) {
  return {
    listServicePrincipals: () =>
      transport.unwrapJson(
        generatedSdk.listServicePrincipals({ client: transport.generatedClient }),
        apiOperations.listServicePrincipals.response.schema
      ),
    createServicePrincipal: (
      input: OperationRequestInput<typeof apiOperations.createServicePrincipal>
    ) =>
      transport.unwrapJson(
        generatedSdk.createServicePrincipal({
          client: transport.generatedClient,
          body: apiOperations.createServicePrincipal.body.parse(input)
        }),
        apiOperations.createServicePrincipal.response.schema
      ),
    updateServicePrincipal: (
      servicePrincipalId: string,
      input: OperationRequestInput<typeof apiOperations.updateServicePrincipal>
    ) =>
      transport.unwrapJson(
        generatedSdk.updateServicePrincipal({
          client: transport.generatedClient,
          path: { servicePrincipalId },
          body: apiOperations.updateServicePrincipal.body.parse(input)
        }),
        apiOperations.updateServicePrincipal.response.schema
      ),
    createCredential: (
      servicePrincipalId: string,
      input: OperationRequestInput<typeof apiOperations.createApiCredential>
    ) =>
      transport.unwrapJson(
        generatedSdk.createApiCredential({
          client: transport.generatedClient,
          path: { servicePrincipalId },
          body: apiOperations.createApiCredential.body.parse(input)
        }),
        apiOperations.createApiCredential.response.schema
      ),
    revokeCredential: (credentialId: string) =>
      transport.unwrapJson(
        generatedSdk.revokeApiCredential({
          client: transport.generatedClient,
          path: { credentialId }
        }),
        apiOperations.revokeApiCredential.response.schema
      )
  };
}

function createUsersClient(transport: ApiClientTransport) {
  return {
    list: () =>
      transport.unwrapJson(
        generatedSdk.listAdministeredUsers({ client: transport.generatedClient }),
        apiOperations.listAdministeredUsers.response.schema
      ),
    create: (input: OperationRequestInput<typeof apiOperations.createAdministeredUser>) =>
      transport.unwrapJson(
        generatedSdk.createAdministeredUser({
          client: transport.generatedClient,
          body: apiOperations.createAdministeredUser.body.parse(input)
        }),
        apiOperations.createAdministeredUser.response.schema
      ),
    update: (
      userId: string,
      input: OperationRequestInput<typeof apiOperations.updateAdministeredUser>
    ) =>
      transport.unwrapJson(
        generatedSdk.updateAdministeredUser({
          client: transport.generatedClient,
          path: { userId },
          body: apiOperations.updateAdministeredUser.body.parse(input)
        }),
        apiOperations.updateAdministeredUser.response.schema
      ),
    delete: (userId: string) =>
      transport.unwrapJson(
        generatedSdk.deleteAdministeredUser({
          client: transport.generatedClient,
          path: { userId }
        }),
        apiOperations.deleteAdministeredUser.response.schema
      ),
    upsertIdentity: (
      userId: string,
      input: OperationRequestInput<typeof apiOperations.upsertAdministeredUserIdentity>
    ) =>
      transport.unwrapJson(
        generatedSdk.upsertAdministeredUserIdentity({
          client: transport.generatedClient,
          path: { userId },
          body: apiOperations.upsertAdministeredUserIdentity.body.parse(input)
        }),
        apiOperations.upsertAdministeredUserIdentity.response.schema
      ),
    resetPassword: (
      userId: string,
      input: OperationRequestInput<typeof apiOperations.resetAdministeredUserPassword>
    ) =>
      transport.unwrapJson(
        generatedSdk.resetAdministeredUserPassword({
          client: transport.generatedClient,
          path: { userId },
          body: apiOperations.resetAdministeredUserPassword.body.parse(input)
        }),
        apiOperations.resetAdministeredUserPassword.response.schema
      ),
    sendInvitation: (userId: string) =>
      transport.unwrapJson(
        generatedSdk.sendAdministeredUserInvitation({
          client: transport.generatedClient,
          path: { userId }
        }),
        apiOperations.sendAdministeredUserInvitation.response.schema
      ),
    deleteIdentity: (userId: string, authSource: string, externalUserId: string) =>
      transport.unwrapJson(
        generatedSdk.deleteAdministeredUserIdentity({
          client: transport.generatedClient,
          path: { userId, authSource, externalUserId }
        }),
        apiOperations.deleteAdministeredUserIdentity.response.schema
      )
  };
}

function createApprovalRequestsClient(transport: ApiClientTransport) {
  return {
    get: (requestId: string) =>
      transport.unwrapJson(
        generatedSdk.getApprovalRequest({ client: transport.generatedClient, path: { requestId } }),
        apiOperations.getApprovalRequest.response.schema
      ),
    list: (status?: ApprovalRequestStatus) =>
      transport.unwrapJson(
        generatedSdk.listApprovalRequests({ client: transport.generatedClient, query: { status } }),
        apiOperations.listApprovalRequests.response.schema
      ),
    pendingCount: () =>
      transport.unwrapJson(
        generatedSdk.countPendingApprovalRequests({ client: transport.generatedClient }),
        apiOperations.countPendingApprovalRequests.response.schema
      ),
    decide: (
      requestId: string,
      input: OperationRequestInput<typeof apiOperations.decideApprovalRequest>
    ) =>
      transport.unwrapJson(
        generatedSdk.decideApprovalRequest({
          client: transport.generatedClient,
          path: { requestId },
          body: apiOperations.decideApprovalRequest.body.parse(input)
        }),
        apiOperations.decideApprovalRequest.response.schema
      ),
    revert: (requestId: string) =>
      transport.unwrapJson(
        generatedSdk.revertApprovalRequest({
          client: transport.generatedClient,
          path: { requestId }
        }),
        apiOperations.revertApprovalRequest.response.schema
      ),
    withdraw: (requestId: string) =>
      transport.unwrapJson(
        generatedSdk.withdrawApprovalRequest({
          client: transport.generatedClient,
          path: { requestId }
        }),
        apiOperations.withdrawApprovalRequest.response.schema
      )
  };
}
