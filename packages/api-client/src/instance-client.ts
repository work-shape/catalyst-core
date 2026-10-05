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
          apiOperations.exchangeApiKey.responseSchema
        )
    },
    account: {
      get: (signal?: AbortSignal) =>
        transport.unwrapJson(
          generatedSdk.getCurrentUser({ client: transport.generatedClient, signal }),
          apiOperations.getCurrentUser.responseSchema
        ),
      update: (input: OperationRequestInput<typeof apiOperations.updateCurrentUser>) =>
        transport.unwrapJson(
          generatedSdk.updateCurrentUser({
            client: transport.generatedClient,
            body: apiOperations.updateCurrentUser.requestSchema.parse(input)
          }),
          apiOperations.updateCurrentUser.responseSchema
        ),
      changePassword: (
        input: OperationRequestInput<typeof apiOperations.changeCurrentUserPassword>
      ) =>
        transport.unwrapJson(
          generatedSdk.changeCurrentUserPassword({
            client: transport.generatedClient,
            body: apiOperations.changeCurrentUserPassword.requestSchema.parse(input)
          }),
          apiOperations.changeCurrentUserPassword.responseSchema
        ),
      delete: () =>
        transport.unwrapJson(
          generatedSdk.deleteCurrentUser({ client: transport.generatedClient }),
          apiOperations.deleteCurrentUser.responseSchema
        )
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
            body: apiOperations.requestPasswordReset.requestSchema.parse(input)
          }),
          apiOperations.requestPasswordReset.responseSchema
        ),
      complete: (input: OperationRequestInput<typeof apiOperations.completePasswordSetup>) =>
        transport.unwrapJson(
          generatedSdk.completePasswordSetup({
            client: transport.generatedClient,
            body: apiOperations.completePasswordSetup.requestSchema.parse(input)
          }),
          apiOperations.completePasswordSetup.responseSchema
        )
    },
    branding: {
      get: (locale?: LocaleCode) =>
        transport.unwrapJson(
          generatedSdk.getBranding({
            client: transport.generatedClient,
            query: { locale }
          }),
          apiOperations.getBranding.responseSchema
        )
    },
    configuration: {
      get: (locale?: LocaleCode) =>
        transport.unwrapJson(
          generatedSdk.getConfig({
            client: transport.generatedClient,
            query: { locale }
          }),
          apiOperations.getConfig.responseSchema
        )
    },
    governance: {
      listAuditEvents: () =>
        transport.unwrapJson(
          generatedSdk.listAuditEvents({ client: transport.generatedClient }),
          apiOperations.listAuditEvents.responseSchema
        ),
      listAuditActivities: () =>
        transport.unwrapJson(
          generatedSdk.listAuditActivities({ client: transport.generatedClient }),
          apiOperations.listAuditActivities.responseSchema
        ),
      getUsageSummary: () =>
        transport.unwrapJson(
          generatedSdk.getUsageSummary({ client: transport.generatedClient }),
          apiOperations.getUsageSummary.responseSchema
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
        apiOperations.getConfigAssetsOverview.responseSchema
      ),
    get: (kind: ConfigAssetKind, name: string) =>
      transport.unwrapJson(
        generatedSdk.getConfigAsset({
          client: transport.generatedClient,
          path: { kind, name }
        }),
        apiOperations.getConfigAsset.responseSchema
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
          body: apiOperations.putConfigAsset.requestSchema.parse(input)
        }),
        apiOperations.putConfigAsset.responseSchema
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
          body: apiOperations.deleteConfigAsset.requestSchema.parse(input)
        }),
        apiOperations.deleteConfigAsset.responseSchema
      ),
    setDefaultAgent: (input: OperationRequestInput<typeof apiOperations.setDefaultConfigAgent>) =>
      transport.unwrapJson(
        generatedSdk.setDefaultConfigAgent({
          client: transport.generatedClient,
          body: apiOperations.setDefaultConfigAgent.requestSchema.parse(input)
        }),
        apiOperations.setDefaultConfigAgent.responseSchema
      ),
    listRevisions: (kind: ConfigAssetKind, name: string) =>
      transport.unwrapJson(
        generatedSdk.listConfigAssetRevisions({
          client: transport.generatedClient,
          path: { kind, name }
        }),
        apiOperations.listConfigAssetRevisions.responseSchema
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
          body: apiOperations.revertConfigAsset.requestSchema.parse(input)
        }),
        apiOperations.revertConfigAsset.responseSchema
      ),
    export: () =>
      transport.unwrapJson(
        generatedSdk.exportConfigAssets({ client: transport.generatedClient }),
        apiOperations.exportConfigAssets.responseSchema
      ),
    replace: (input: OperationRequestInput<typeof apiOperations.replaceConfigAssets>) =>
      transport.unwrapJson(
        generatedSdk.replaceConfigAssets({
          client: transport.generatedClient,
          body: apiOperations.replaceConfigAssets.requestSchema.parse(input)
        }),
        apiOperations.replaceConfigAssets.responseSchema
      ),
    validate: (input: OperationRequestInput<typeof apiOperations.validateConfigAssets>) =>
      transport.unwrapJson(
        generatedSdk.validateConfigAssets({
          client: transport.generatedClient,
          body: apiOperations.validateConfigAssets.requestSchema.parse(input)
        }),
        apiOperations.validateConfigAssets.responseSchema
      )
  };
}

function createApiAccessClient(transport: ApiClientTransport) {
  return {
    listServicePrincipals: () =>
      transport.unwrapJson(
        generatedSdk.listServicePrincipals({ client: transport.generatedClient }),
        apiOperations.listServicePrincipals.responseSchema
      ),
    createServicePrincipal: (
      input: OperationRequestInput<typeof apiOperations.createServicePrincipal>
    ) =>
      transport.unwrapJson(
        generatedSdk.createServicePrincipal({
          client: transport.generatedClient,
          body: apiOperations.createServicePrincipal.requestSchema.parse(input)
        }),
        apiOperations.createServicePrincipal.responseSchema
      ),
    updateServicePrincipal: (
      servicePrincipalId: string,
      input: OperationRequestInput<typeof apiOperations.updateServicePrincipal>
    ) =>
      transport.unwrapJson(
        generatedSdk.updateServicePrincipal({
          client: transport.generatedClient,
          path: { servicePrincipalId },
          body: apiOperations.updateServicePrincipal.requestSchema.parse(input)
        }),
        apiOperations.updateServicePrincipal.responseSchema
      ),
    createCredential: (
      servicePrincipalId: string,
      input: OperationRequestInput<typeof apiOperations.createApiCredential>
    ) =>
      transport.unwrapJson(
        generatedSdk.createApiCredential({
          client: transport.generatedClient,
          path: { servicePrincipalId },
          body: apiOperations.createApiCredential.requestSchema.parse(input)
        }),
        apiOperations.createApiCredential.responseSchema
      ),
    revokeCredential: (credentialId: string) =>
      transport.unwrapJson(
        generatedSdk.revokeApiCredential({
          client: transport.generatedClient,
          path: { credentialId }
        }),
        apiOperations.revokeApiCredential.responseSchema
      )
  };
}

function createUsersClient(transport: ApiClientTransport) {
  return {
    list: () =>
      transport.unwrapJson(
        generatedSdk.listAdministeredUsers({ client: transport.generatedClient }),
        apiOperations.listAdministeredUsers.responseSchema
      ),
    create: (input: OperationRequestInput<typeof apiOperations.createAdministeredUser>) =>
      transport.unwrapJson(
        generatedSdk.createAdministeredUser({
          client: transport.generatedClient,
          body: apiOperations.createAdministeredUser.requestSchema.parse(input)
        }),
        apiOperations.createAdministeredUser.responseSchema
      ),
    update: (
      userId: string,
      input: OperationRequestInput<typeof apiOperations.updateAdministeredUser>
    ) =>
      transport.unwrapJson(
        generatedSdk.updateAdministeredUser({
          client: transport.generatedClient,
          path: { userId },
          body: apiOperations.updateAdministeredUser.requestSchema.parse(input)
        }),
        apiOperations.updateAdministeredUser.responseSchema
      ),
    delete: (userId: string) =>
      transport.unwrapJson(
        generatedSdk.deleteAdministeredUser({
          client: transport.generatedClient,
          path: { userId }
        }),
        apiOperations.deleteAdministeredUser.responseSchema
      ),
    upsertIdentity: (
      userId: string,
      input: OperationRequestInput<typeof apiOperations.upsertAdministeredUserIdentity>
    ) =>
      transport.unwrapJson(
        generatedSdk.upsertAdministeredUserIdentity({
          client: transport.generatedClient,
          path: { userId },
          body: apiOperations.upsertAdministeredUserIdentity.requestSchema.parse(input)
        }),
        apiOperations.upsertAdministeredUserIdentity.responseSchema
      ),
    resetPassword: (
      userId: string,
      input: OperationRequestInput<typeof apiOperations.resetAdministeredUserPassword>
    ) =>
      transport.unwrapJson(
        generatedSdk.resetAdministeredUserPassword({
          client: transport.generatedClient,
          path: { userId },
          body: apiOperations.resetAdministeredUserPassword.requestSchema.parse(input)
        }),
        apiOperations.resetAdministeredUserPassword.responseSchema
      ),
    sendInvitation: (userId: string) =>
      transport.unwrapJson(
        generatedSdk.sendAdministeredUserInvitation({
          client: transport.generatedClient,
          path: { userId }
        }),
        apiOperations.sendAdministeredUserInvitation.responseSchema
      ),
    deleteIdentity: (userId: string, authSource: string, externalUserId: string) =>
      transport.unwrapJson(
        generatedSdk.deleteAdministeredUserIdentity({
          client: transport.generatedClient,
          path: { userId, authSource, externalUserId }
        }),
        apiOperations.deleteAdministeredUserIdentity.responseSchema
      )
  };
}

function createApprovalRequestsClient(transport: ApiClientTransport) {
  return {
    get: (requestId: string) =>
      transport.unwrapJson(
        generatedSdk.getApprovalRequest({ client: transport.generatedClient, path: { requestId } }),
        apiOperations.getApprovalRequest.responseSchema
      ),
    list: (status?: ApprovalRequestStatus) =>
      transport.unwrapJson(
        generatedSdk.listApprovalRequests({ client: transport.generatedClient, query: { status } }),
        apiOperations.listApprovalRequests.responseSchema
      ),
    pendingCount: () =>
      transport.unwrapJson(
        generatedSdk.countPendingApprovalRequests({ client: transport.generatedClient }),
        apiOperations.countPendingApprovalRequests.responseSchema
      ),
    decide: (
      requestId: string,
      input: OperationRequestInput<typeof apiOperations.decideApprovalRequest>
    ) =>
      transport.unwrapJson(
        generatedSdk.decideApprovalRequest({
          client: transport.generatedClient,
          path: { requestId },
          body: apiOperations.decideApprovalRequest.requestSchema.parse(input)
        }),
        apiOperations.decideApprovalRequest.responseSchema
      ),
    revert: (requestId: string) =>
      transport.unwrapJson(
        generatedSdk.revertApprovalRequest({
          client: transport.generatedClient,
          path: { requestId }
        }),
        apiOperations.revertApprovalRequest.responseSchema
      ),
    withdraw: (requestId: string) =>
      transport.unwrapJson(
        generatedSdk.withdrawApprovalRequest({
          client: transport.generatedClient,
          path: { requestId }
        }),
        apiOperations.withdrawApprovalRequest.responseSchema
      )
  };
}
