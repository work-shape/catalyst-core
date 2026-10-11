import {
  ApiError,
  completedOutput,
  listAll,
  type AdministeredUser,
  type ApiClient,
  type ApprovalRequestView,
  type Asset,
  type ConfigAssetsOverview,
  type CreateNamespaceRequest,
  type CreatePermissionGrantRequest,
  type EffectivePermissions,
  type InstanceModule,
  type NamespaceWithUsage,
  type PermissionGrantRow,
  type ServicePrincipalDetail,
  type UpdateNamespaceRequest
} from "@vivd-catalyst/api-client";

/** What the seed sets on a person. A password only where the person signs in with one. */
interface SeedUserInput {
  displayLabel: string;
  email: string;
  roles: string[];
  permissions: string[];
  permissionRefs: string[];
  status: "active" | "disabled";
  password?: string;
}

/**
 * Everything the seed asks of an instance, as one signed-in caller. The seed is written
 * against this and not against the product's client, so a call that moves, such as the user
 * administration becoming registered operations, changes `createSeedApi` and nothing else.
 */
export interface SeedApi {
  listUsers(): Promise<AdministeredUser[]>;
  createUser(input: SeedUserInput): Promise<AdministeredUser>;
  updateUser(userId: string, input: Omit<SeedUserInput, "email" | "password">): Promise<void>;
  sendInvitation(userId: string): Promise<void>;
  /**
   * Whether an invitation was ever mailed to the person. A user does not carry this; the
   * audit events do, so this reads them from the newest back until it finds the mail.
   */
  invitationWasSent(userId: string): Promise<boolean>;
  listModules(): Promise<InstanceModule[]>;
  listNamespaces(): Promise<NamespaceWithUsage[]>;
  createNamespace(input: CreateNamespaceRequest): Promise<void>;
  updateNamespace(prefix: string, input: UpdateNamespaceRequest): Promise<void>;
  listGrants(): Promise<PermissionGrantRow[]>;
  grant(input: CreatePermissionGrantRequest): Promise<void>;
  effectivePermissions(userId: string): Promise<EffectivePermissions>;
  listServicePrincipals(): Promise<ServicePrincipalDetail[]>;
  createServicePrincipal(input: {
    displayLabel: string;
    description: string;
    permissions: ServicePrincipalDetail["principal"]["permissions"];
  }): Promise<ServicePrincipalDetail>;
  /** Returns the key, which the instance shows this once. */
  createApiKey(
    servicePrincipalId: string,
    input: {
      name: string;
      scopes: NonNullable<ServicePrincipalDetail["credentials"][number]["scopes"]>;
    }
  ): Promise<string>;
  /** The agents and skills of the instance, and what a definition may name on it. */
  assetsOverview(): Promise<ConfigAssetsOverview>;
  /** Nothing when the caller cannot read the asset or it does not exist. */
  getAsset(kind: string, name: string): Promise<Asset | undefined>;
  /** `pending_approval`: nothing was written, another person decides. */
  createAsset(
    kind: string,
    config: Record<string, unknown> & { name: string }
  ): Promise<"done" | "pending_approval">;
  showAgentEverywhere(name: string): Promise<void>;
  listOwnApprovalRequests(): Promise<ApprovalRequestView[]>;
}

/** `SeedApi` over the product's client, whose every call is one operation of the catalog. */
export function createSeedApi(client: ApiClient): SeedApi {
  return {
    listUsers: () => listAll((paging) => client.users.list({ query: paging })),
    createUser: ({ password, ...user }) =>
      client.users.create({
        body: { ...user, ...(password === undefined ? {} : { passwordSignIn: { password } }) }
      }),
    async updateUser(userId, input) {
      await client.users.update({ params: { userId }, body: input });
    },
    async sendInvitation(userId) {
      await client.users.invitation.send({ params: { userId } });
    },
    async invitationWasSent(userId) {
      let cursor: string | undefined;
      do {
        const page = await client.audit_events.list({
          query: { limit: 200, ...(cursor ? { cursor } : {}) }
        });
        const sent = page.items.some(
          (event) =>
            event.type === "user.invitation_sent" &&
            event.subject === userId &&
            event.status === "success"
        );
        if (sent) return true;
        cursor = page.nextCursor;
      } while (cursor);
      return false;
    },
    listModules: async () => (await client.instance.modules.list()).items,
    listNamespaces: () => listAll((paging) => client.namespaces.list({ query: paging })),
    async createNamespace(input) {
      completedOutput(await client.namespaces.create({ body: input }));
    },
    async updateNamespace(prefix, input) {
      completedOutput(await client.namespaces.update({ params: { prefix }, body: input }));
    },
    listGrants: () => listAll((paging) => client.permissions.list({ query: paging })),
    async grant(input) {
      completedOutput(await client.permissions.grant({ body: input }));
    },
    effectivePermissions: (userId) =>
      client.permissions.effective({ query: { holderKind: "user", holderId: userId } }),
    listServicePrincipals: () =>
      listAll((paging) => client.service_principals.list({ query: paging })),
    createServicePrincipal: async (input) =>
      completedOutput(await client.service_principals.create({ body: input })),
    createApiKey: async (servicePrincipalId, input) =>
      (await client.api_credentials.create({ params: { servicePrincipalId }, body: input })).secret,
    assetsOverview: () => client.config_assets.get_overview(),
    async getAsset(kind, name) {
      try {
        return await client.assets.get({ params: { kind, name } });
      } catch (error) {
        if (error instanceof ApiError && (error.status === 404 || error.status === 403)) {
          return undefined;
        }
        throw error;
      }
    },
    createAsset: async (kind, config) =>
      (await client.assets.put({ params: { kind, name: config.name }, body: { config } })).status,
    async showAgentEverywhere(name) {
      await client.config_agents.set_availability({ params: { name }, body: { mode: "all" } });
    },
    listOwnApprovalRequests: () =>
      listAll((paging) => client.approval_requests.list_mine({ query: paging }))
  };
}
