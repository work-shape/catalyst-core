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
 * against this and not against the product's client, so a call that moves changes
 * `createSeedApi` and nothing else.
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
  /**
   * Creates the asset, or replaces it at the revision the caller read where one is given.
   * `pending_approval`: nothing was written, a holder of `operations.approve` decides.
   */
  saveAsset(
    kind: string,
    config: Record<string, unknown> & { name: string },
    expectedRevision?: number
  ): Promise<"done" | "pending_approval">;
  showAgentEverywhere(name: string): Promise<void>;
  listOwnApprovalRequests(): Promise<ApprovalRequestView[]>;
  /** The workspaces the caller is a member of. */
  listWorkspaces(): Promise<SeedWorkspace[]>;
  createWorkspace(input: { name: string; description: string }): Promise<SeedWorkspace>;
  /** The addresses of the members of a workspace, in lowercase. */
  listWorkspaceMemberEmails(workspaceId: string): Promise<string[]>;
  addWorkspaceMember(workspaceId: string, email: string): Promise<void>;
  /** The Apps of a workspace, each with its newest and its published revision. */
  listApps(workspaceId: string): Promise<SeedApp[]>;
  /**
   * Writes the source files of an App as its next revision, which is its draft. `revision` is
   * the newest revision the App has; left out, the write creates the App.
   */
  writeApp(
    workspaceId: string,
    name: string,
    files: SeedAppFile[],
    revision: number | undefined
  ): Promise<void>;
  publishApp(workspaceId: string, name: string, revision: number): Promise<void>;
}

/** What the seed reads of a Shared Workspace. */
interface SeedWorkspace {
  id: string;
  name: string;
}

/** What the seed reads of an App. */
interface SeedApp {
  name: string;
  revision: number;
  publishedRevision?: number;
}

/** One source file of an App, as text. */
export interface SeedAppFile {
  path: string;
  text: string;
}

const APP_KIND = "app";

/** `SeedApi` over the product's client, whose every call is one operation of the catalog. */
export function createSeedApi(client: ApiClient): SeedApi {
  return {
    listUsers: () => listAll((paging) => client.users.list({ query: paging })),
    createUser: async ({ password, ...user }) =>
      completedOutput(
        await client.users.create({
          body: { ...user, ...(password === undefined ? {} : { passwordSignIn: { password } }) }
        })
      ),
    async updateUser(userId, input) {
      completedOutput(await client.users.update({ params: { userId }, body: input }));
    },
    async sendInvitation(userId) {
      completedOutput(await client.users.invitation.send({ params: { userId } }));
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
    saveAsset: async (kind, config, expectedRevision) =>
      (
        await client.assets.put({
          params: { kind, name: config.name },
          body: { config, ...(expectedRevision === undefined ? {} : { expectedRevision }) }
        })
      ).status,
    async showAgentEverywhere(name) {
      completedOutput(
        await client.assets.set_availability({
          params: { kind: "agent", name },
          body: { mode: "all" }
        })
      );
    },
    listOwnApprovalRequests: () =>
      listAll((paging) => client.approval_requests.list_mine({ query: paging })),
    listWorkspaces: () => listAll((paging) => client.workspaces.list({ query: paging })),
    createWorkspace: (input) => client.workspaces.create({ body: input }),
    listWorkspaceMemberEmails: async (workspaceId) =>
      (
        await listAll((paging) =>
          client.workspaces.members.list({
            params: { collaborationWorkspaceId: workspaceId },
            query: paging
          })
        )
      ).flatMap((member) => (member.email ? [member.email.toLowerCase()] : [])),
    async addWorkspaceMember(workspaceId, email) {
      await client.workspaces.members.add({
        params: { collaborationWorkspaceId: workspaceId },
        body: { email }
      });
    },
    listApps: (workspaceId) =>
      listAll((paging) =>
        client.assets.list({ params: { kind: APP_KIND }, query: { ...paging, workspaceId } })
      ),
    async writeApp(workspaceId, name, files, revision) {
      completedOutput(
        await client.assets.put({
          params: { kind: APP_KIND, name },
          body: {
            files,
            workspaceId,
            ...(revision === undefined ? {} : { expectedRevision: revision })
          }
        })
      );
    },
    async publishApp(workspaceId, name, revision) {
      completedOutput(
        await client.assets.publish({
          params: { kind: APP_KIND, name },
          body: { revision, workspaceId }
        })
      );
    }
  };
}
