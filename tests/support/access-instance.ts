import { expect } from "vitest";
import { z } from "zod";
import type { AuthAdapter } from "@vivd-catalyst/auth";
import type { WorkflowAssetKind } from "@vivd-catalyst/chat-server";
import { parseClientInstanceConfig } from "@vivd-catalyst/config-schema";
import {
  StoreBackedAuditRecorder,
  asApiCredentialId,
  asClientInstanceId,
  type CollaborationWorkspaceId,
  asServicePrincipalId,
  createAssetKindRegistry,
  type UserRecord,
  type UserRole
} from "@vivd-catalyst/core";
import { atCurrentRevision } from "./asset-revisions";
import type { TestCallInput, TestOperationName } from "./operations";
import {
  createTestAssetKinds,
  createTestInstanceWith,
  type TestInstance,
  type TestServerOptions,
  type TestStore
} from "./test-instance";

// The instance behind the grant and Namespace tests: four stored users, interactive agent
// editing switched on, two tools and two model bindings.

export const clientInstanceId = asClientInstanceId("demo-local");
export const otherClientInstanceId = asClientInstanceId("another-instance");

/** The modules that are on beside the ones the config turns on by itself. */
type ModuleSwitches = Record<string, { enabled: boolean }>;

/** The editing limits of the instance. Each test instance may set its own. */
type EditingLimits = Record<string, boolean | string[]>;

const configWith = (editingLimits: EditingLimits, modules: ModuleSwitches = {}) =>
  parseClientInstanceConfig({
    modules,
    version: 1,
    clientInstance: {
      id: clientInstanceId,
      displayName: "Access test",
      environment: "development"
    },
    auth: {},
    administration: {
      agentConfiguration: {
        enabled: true,
        editableAgentFields: [
          "displayName",
          "instructions",
          "modelBindingId",
          "toolNames",
          "skillNames",
          "initialPrompts"
        ],
        allowAgentCreation: true,
        allowAgentDeletion: true,
        allowDefaultAgentChange: true,
        allowSkillEditing: true,
        ...editingLimits
      }
    },
    infrastructure: { models: { local: { provider: "deterministic", model: "local" } } },
    modelBindings: [
      { id: "plain", providerId: "local" },
      { id: "other", providerId: "local" }
    ],
    tools: [
      { name: "known.tool", enabled: true },
      { name: "second.tool", enabled: true }
    ]
  });

const USER_HEADER = "x-test-user";
export const SERVICE_HEADER = "x-test-service";
/** The scopes of the credential, separated by spaces. Left out, the credential carries all. */
export const SCOPES_HEADER = "x-test-scopes";

/**
 * Signs in whoever the header names with what their stored record holds, a disabled user
 * included: the real sign-in turns a disabled user away, and these tests prove the evaluator
 * does so too.
 */
function recordAuthAdapter(stores: TestStore): AuthAdapter {
  return {
    id: "test-record",
    credentialMode: "ambient",
    async authenticate(request) {
      const named = request.headers[SCOPES_HEADER];
      const scopes = typeof named === "string" ? named.split(" ").filter(Boolean) : ["*"];
      const service = request.headers[SERVICE_HEADER];
      if (typeof service === "string") {
        return {
          kind: "service",
          id: asServicePrincipalId(service),
          credentialId: asApiCredentialId("cred_test"),
          displayLabel: "Service",
          permissionRefs: [],
          permissions: ["config_assets.read", "config_assets.release"],
          clientInstanceId,
          authSource: "test",
          scopes
        };
      }
      const userId = request.headers[USER_HEADER];
      const users = await stores.users.listUsers({ clientInstanceId });
      const user = users.find((candidate) => candidate.id === userId);
      if (!user) throw new Error(`No test user '${String(userId)}'`);
      return {
        id: user.id,
        externalUserId: user.id,
        displayLabel: user.displayLabel,
        roles: user.roles,
        permissions: user.permissions,
        permissionRefs: user.permissionRefs,
        clientInstanceId,
        authSource: "test",
        scopes
      };
    }
  };
}

export const errorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional()
  })
});
export const grantSchema = z.object({ id: z.string() }).loose();

export function agent(name: string, overrides: Record<string, unknown> = {}) {
  return {
    name,
    displayName: name,
    instructions: "Help.",
    modelProviderId: "local",
    toolNames: [],
    skillNames: [],
    initialPrompts: [],
    ...overrides
  };
}

export function skill(name: string, content = "Guidance.") {
  return { name, title: name, description: "A skill", content };
}

type AccessResponse = Awaited<ReturnType<TestInstance["call"]>>;
type AccessError = z.infer<typeof errorSchema>["error"];
interface Refusal {
  status: number;
  code: string;
  details?: Record<string, unknown>;
}

export interface AccessInstance {
  instance: TestInstance<TestStore>;
  stores: TestStore;
  /** A superadmin, an administrator, and two users who hold nothing. */
  root: UserRecord;
  admin: UserRecord;
  kai: UserRecord;
  lena: UserRecord;
  call(
    userId: string,
    operation: TestOperationName,
    input?: TestCallInput
  ): Promise<AccessResponse>;
  expectOk(
    userId: string,
    operation: TestOperationName,
    input?: TestCallInput
  ): Promise<AccessResponse>;
  expectRefused(
    userId: string,
    operation: TestOperationName,
    input: TestCallInput,
    expected: Refusal
  ): Promise<AccessError>;
  forbidden(action: string, reason: string): Refusal;
  /** Written by the administrator. */
  createNamespace(prefix: string, lists?: Record<string, unknown>): Promise<AccessResponse>;
  /** Written by the administrator. Returns the grant id. */
  grant(
    holderId: string,
    action: string,
    scope: { namespace: string } | { assetId: string } | { workspaceId: string },
    effect?: "allow" | "deny"
  ): Promise<string>;
  putAgent(
    userId: string,
    name: string,
    overrides?: Record<string, unknown>
  ): Promise<AccessResponse>;
  assetId(kind: string, name: string): Promise<string>;
  /** A Shared Workspace the administrator created. Returns its id. */
  sharedWorkspace(name: string): Promise<CollaborationWorkspaceId>;
}

export interface AccessInstanceOptions {
  /** What the operation layer asks beside the rights: policy and events. */
  operations?: TestServerOptions["operations"];
  /** Tools an agent may name beside the two of the config, such as `read_skill`. */
  furtherToolNames?: string[];
  /** Fields of `administration.agentConfiguration` that differ from the open default. */
  editingLimits?: EditingLimits;
  /** Kinds registered beside agent and skill. */
  furtherKinds?: WorkflowAssetKind[];
  /** The model bindings that support fast mode. */
  fastModeModelBindingIds?: string[];
  /** Switches of `modules`, such as `{ connections: { enabled: true } }`. */
  modules?: ModuleSwitches;
  /**
   * Further server options, built from the stores and the config of the instance. They
   * replace the ones this file sets, such as the call path with a further operation source.
   */
  server?: (stores: TestStore, config: ReturnType<typeof configWith>) => Partial<TestServerOptions>;
}

export async function setupAccessInstance(
  options: AccessInstanceOptions = {}
): Promise<AccessInstance> {
  const { operations, furtherToolNames = [], editingLimits = {}, furtherKinds = [] } = options;
  const config = configWith(editingLimits, options.modules);
  const validationRefs = {
    modelProviderIds: ["local"],
    modelBindingIds: ["plain", "other"],
    modelBindings: [
      { id: "plain", model: "local" },
      { id: "other", model: "local" }
    ],
    fastModeModelBindingIds: options.fastModeModelBindingIds ?? [],
    reasoningEfforts: ["none", "low", "medium", "high", "xhigh"],
    enabledToolNames: ["known.tool", "second.tool", ...furtherToolNames]
  };
  const instance = await createTestInstanceWith((stores) => ({
    config,
    ...(operations ? { operations } : {}),
    // A call the policy holds is filed and decided as on an assembled instance.
    approvalRequests: { store: stores.approvals, handlers: new Map() },
    authAdapter: recordAuthAdapter(stores),
    auditRecorder: new StoreBackedAuditRecorder({ clientInstanceId, store: stores.audit }),
    configAssets: {
      store: stores.configAssets,
      validationRefs,
      ...(furtherKinds.length === 0
        ? {}
        : {
            kinds: createAssetKindRegistry([
              ...createTestAssetKinds({ config, validationRefs }).kinds,
              ...furtherKinds
            ])
          })
    },
    ...options.server?.(stores, config)
  }));
  const { stores } = instance;
  const createUser = (displayLabel: string, roles: UserRole[], permissions: string[] = []) =>
    stores.users.createUser({ clientInstanceId, displayLabel, roles, permissions });
  const root = await createUser("Root", ["user", "admin", "superadmin"]);
  const admin = await createUser("Admin", ["user", "admin"]);
  const kai = await createUser("Kai", ["user"]);
  const lena = await createUser("Lena", ["user"]);
  // An existing default agent, so that no write below is the one that sets the default.
  await stores.configAssets.applyConfigAssetMutations({
    clientInstanceId,
    mutations: [
      { type: "upsert", kind: "agent", name: "assistant", config: agent("assistant") },
      { type: "setDefaultAgent", agentName: "assistant" }
    ]
  });

  const call = async (userId: string, operation: TestOperationName, input: TestCallInput = {}) =>
    instance.call(operation, {
      ...(await atCurrentRevision(stores, clientInstanceId, operation, input)),
      headers: { ...input.headers, [USER_HEADER]: userId }
    });
  const expectOk = async (
    userId: string,
    operation: TestOperationName,
    input: TestCallInput = {}
  ) => {
    const response = await call(userId, operation, input);
    expect(response.json(), `${operation} as ${userId}`).not.toHaveProperty("error");
    expect(response.statusCode).toBe(200);
    return response;
  };
  const expectRefused = async (
    userId: string,
    operation: TestOperationName,
    input: TestCallInput,
    expected: { status: number; code: string; details?: Record<string, unknown> }
  ) => {
    const response = await call(userId, operation, input);
    const body = errorSchema.parse(response.json());
    expect({ status: response.statusCode, code: body.error.code }, body.error.message).toEqual({
      status: expected.status,
      code: expected.code
    });
    if (expected.details) expect(body.error.details).toEqual(expected.details);
    return body.error;
  };
  const forbidden = (action: string, reason: string) => ({
    status: 403,
    code: "FORBIDDEN",
    details: { action, reason }
  });
  const createNamespace = (prefix: string, lists: Record<string, unknown> = {}) =>
    expectOk(admin.id, "namespaces.create", {
      payload: { prefix, displayName: prefix, ...lists }
    });
  const grant = async (
    holderId: string,
    action: string,
    scope: { namespace: string } | { assetId: string } | { workspaceId: string },
    effect: "allow" | "deny" = "allow"
  ) => {
    const response = await expectOk(admin.id, "permissions.grant", {
      payload: {
        holderKind: "user",
        holderId,
        action,
        effect,
        ...("namespace" in scope
          ? { scopeKind: "namespace", namespace: scope.namespace }
          : "workspaceId" in scope
            ? { scopeKind: "workspace", scopeId: scope.workspaceId }
            : { scopeKind: "asset", scopeId: scope.assetId })
      }
    });
    return grantSchema.parse(response.json()).id;
  };
  const putAgent = (userId: string, name: string, overrides: Record<string, unknown> = {}) =>
    call(userId, "assets.put", {
      params: { kind: "agent", name },
      payload: { config: agent(name, overrides) }
    });
  const assetId = async (kind: string, name: string) => {
    const asset = await stores.configAssets.getConfigAsset({ clientInstanceId, kind, name });
    if (!asset) throw new Error(`No ${kind} '${name}'`);
    return asset.id;
  };
  return {
    instance,
    stores,
    root,
    admin,
    kai,
    lena,
    call,
    expectOk,
    expectRefused,
    forbidden,
    createNamespace,
    grant,
    putAgent,
    assetId,
    sharedWorkspace: async (name) =>
      (
        await stores.workspaces.createWorkspace({
          clientInstanceId,
          kind: "shared",
          name,
          creatorUserId: admin.id
        })
      ).id
  };
}
