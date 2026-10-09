import {
  type ApiAccessStore,
  type ApiCredentialRecord,
  type CreateApiCredentialInput,
  type CreateServicePrincipalInput,
  type ServicePrincipalRecord,
  type UpdateServicePrincipalInput
} from "@vivd-catalyst/core";
import {
  createApiCredential as createPostgresApiCredential,
  createServicePrincipal as createPostgresServicePrincipal,
  listApiCredentials as listPostgresApiCredentials,
  listServicePrincipals as listPostgresServicePrincipals,
  resolveApiCredential as resolvePostgresApiCredential,
  revokeApiCredential as revokePostgresApiCredential,
  updateApiCredentialLastUsed as updatePostgresApiCredentialLastUsed,
  updateServicePrincipal as updatePostgresServicePrincipal
} from "../postgres-api-access-operations";
import type { PostgresConnection } from "../postgres-database";
export function createPostgresApiAccessStore(db: PostgresConnection): ApiAccessStore {
  return {
    async listServicePrincipals(
      input: Parameters<ApiAccessStore["listServicePrincipals"]>[0]
    ): Promise<ServicePrincipalRecord[]> {
      return listPostgresServicePrincipals(db, input);
    },
    async createServicePrincipal(
      input: CreateServicePrincipalInput
    ): Promise<ServicePrincipalRecord> {
      return createPostgresServicePrincipal(db, input);
    },
    async updateServicePrincipal(
      input: UpdateServicePrincipalInput
    ): Promise<ServicePrincipalRecord> {
      return updatePostgresServicePrincipal(db, input);
    },
    async listApiCredentials(
      input: Parameters<ApiAccessStore["listApiCredentials"]>[0]
    ): Promise<ApiCredentialRecord[]> {
      return listPostgresApiCredentials(db, input);
    },
    async createApiCredential(input: CreateApiCredentialInput) {
      return createPostgresApiCredential(db, input);
    },
    async revokeApiCredential(
      input: Parameters<ApiAccessStore["revokeApiCredential"]>[0]
    ): Promise<ApiCredentialRecord> {
      return revokePostgresApiCredential(db, input);
    },
    async resolveApiCredential(input: Parameters<ApiAccessStore["resolveApiCredential"]>[0]) {
      return resolvePostgresApiCredential(db, input);
    },
    async updateApiCredentialLastUsed(
      input: Parameters<ApiAccessStore["updateApiCredentialLastUsed"]>[0]
    ): Promise<ApiCredentialRecord> {
      return updatePostgresApiCredentialLastUsed(db, input);
    }
  };
}
