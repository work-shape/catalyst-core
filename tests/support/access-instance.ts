import { expect } from "vitest";
import { z } from "zod";
import type { AuthAdapter } from "@work-shape/catalyst-auth";
import type { WorkflowAssetKind } from "@work-shape/catalyst-server";
import { parseClientInstanceConfig } from "@work-shape/catalyst-config-schema";
import {
  LEGACY_LIST_GRANTOR,
  PERSONAL_API_KEY_ACTIONS,
  StoreBackedAuditRecorder,
  asApiCredentialId,
  asClientInstanceId,
  type CollaborationWorkspaceId,
  type AssetKindRegistry,
  type DataToolSource,
  asServicePrincipalId,
  authScopeForPermission,
  createAssetKindRegistry,
  isPermission,
  legacyGrantRows,
  type UserRecord,
  type UserRole
} from "@work-shape/catalyst-core";
import { atCurrentRevision } from "./asset-revisions";
import { createStoredConfigAssetSource } from "./static-config-asset-source";
import type { TestCallInput, TestOperationName } from "./operations";
import {
  createTestAssetKinds,
  createTestInstanceWith,
  type TestInstance,
  type TestRoute,
  type TestServerOptions,
  type TestStore
} from "./test-instance";
import { applyAtCurrentRevisions } from "./asset-revisions";
import { withTestSql } from "./test-sql";

// The instance behind the grant tests: four stored users, interactive agent
// editing switched on, two tools and two model bindings.

export const clientInstanceId = asClientInstanceId("demo-local");
export const otherClientInstanceId = asClientInstanceId("another-instance");

/** The modules that are on beside the ones the config turns on by itself. */
type ModuleSwitches = Record<string, { enabled: boolean } & Record<string, unknown>>;

/** The editing limits of the instance. Each test instance may set its own. */
type EditingLimits = Record<string, boolean | string[]>;

/** The two bindings agents may name, without a choice of reasoning effort. */
const PLAIN_MODEL_BINDINGS: readonly Record<string, unknown>[] = [
  { id: "plain", providerId: "local" },
  { id: "other", providerId: "local" }
];

/** The one model route an instance has unless a test names its own. */
const LOCAL_MODELS: Record<string, Record<string, unknown>> = {
  local: { provider: "deterministic", model: "local" }
};

const configWith = (
  editingLimits: EditingLimits,
  modules: ModuleSwitches = {},
  modelBindings = PLAIN_MODEL_BINDINGS,
  models = LOCAL_MODELS
) =>
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
    infrastructure: { models },
    modelBindings,
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
 * `personal` signs the user in through their personal API key, as the CLI is: the call's
 * origin is then `cli`. Left out, the user's own session.
 */
const KEY_HEADER = "x-test-key";
/** The keys of the service the header names; `storeTestServicePrincipal` writes their rows. */
const TEST_SERVICE_KEYS = ["config_assets.read", "config_assets.release"];
const signedInUserSchema = z.object({
  id: z.string(),
  display_label: z.string(),
  roles: z.array(z.string()),
  permission_refs: z.array(z.string())
});

/**
 * Signs in whoever the header names with what their stored record holds, a disabled user
 * included: the real sign-in turns a disabled user away, and these tests prove the evaluator
 * does so too.
 */
export function recordAuthAdapter(): AuthAdapter {
  return {
    id: "test-record",
    credentialMode: "ambient",
    async authenticate(request) {
      const named = request.headers[SCOPES_HEADER];
      const scopes = typeof named === "string" ? named.split(" ").filter(Boolean) : ["*"];
      const service = request.headers[SERVICE_HEADER];
      if (typeof service === "string") {
        // A service key belongs to a stored principal, whose keys are its rows (AP-4).
        await storeTestServicePrincipal(service);
        return {
          kind: "service",
          id: asServicePrincipalId(service),
          credentialId: asApiCredentialId("cred_test"),
          displayLabel: "Service",
          permissionRefs: [],
          // The keys the scopes reach, as `deriveEffectiveServiceGrants` gives a real token.
          permissions: TEST_SERVICE_KEYS.filter((key) => {
            const scope = isPermission(key) ? authScopeForPermission(key) : undefined;
            return scopes.includes("*") || (scope !== undefined && scopes.includes(scope));
          }),
          clientInstanceId,
          authSource: "test",
          scopes
        };
      }
      const userId = request.headers[USER_HEADER];
      // The record without its rights: the evaluator reads the person's rows itself (AP-4), so
      // signing in sends one statement, as production's sign-in of a known person does.
      const rows = await withTestSql(
        (sql) => sql`
          select id, display_label, roles, permission_refs from product_users
          where client_instance_id = ${clientInstanceId} and id = ${String(userId)}`
      );
      const user = rows.length === 1 ? signedInUserSchema.parse(rows[0]) : undefined;
      if (!user) throw new Error(`No test user '${String(userId)}'`);
      const personal = request.headers[KEY_HEADER] === "personal";
      if (personal) await storeTestPersonalKey(user.id);
      return {
        id: user.id,
        externalUserId: user.id,
        displayLabel: user.display_label,
        roles: user.roles,
        permissions: [],
        permissionRefs: user.permission_refs,
        clientInstanceId,
        authSource: "test",
        scopes,
        ...(personal
          ? {
              delegatedActor: {
                kind: "api_key" as const,
                id: testPersonalKeyId(user.id),
                displayLabel: "Test key",
                authSource: "test"
              }
            }
          : {})
      };
    }
  };
}

/** The id of the personal key a user signs in with under `x-test-key: personal`. */
function testPersonalKeyId(userId: string) {
  return asApiCredentialId(`key_test_${userId}`);
}

/**
 * Stores the user's personal key, naming every action a key may carry, so that a call made
 * for it and approved later finds it usable. The call itself carries no key scopes: the tests
 * decide its rights with the scopes header.
 */
async function storeTestPersonalKey(userId: string): Promise<void> {
  const id = testPersonalKeyId(userId);
  await withTestSql(
    (sql) => sql`
      insert into api_credentials
        (id, client_instance_id, owner_user_id, name, key_prefix, secret_hash, scopes, created_at, expires_at)
      values (${id}, ${clientInstanceId}, ${userId}, 'Test key', ${id}, 'unused',
        ${sql.json([...PERSONAL_API_KEY_ACTIONS])}, now(), now() + interval '30 days')
      on conflict do nothing`
  );
}

/**
 * Stores the service principal the header names, with the id the tests sign it in under, and
 * the instance-wide rows its keys are (AP-4). A grant row is written only for a principal the
 * instance has, and only a stored principal holds anything.
 */
export async function storeTestServicePrincipal(id: string): Promise<void> {
  await withTestSql(async (sql) => {
    await sql`
      insert into service_principals
        (id, client_instance_id, display_label, status, permission_refs, created_at, updated_at)
      values (${id}, ${clientInstanceId}, 'Service', 'active', '[]'::jsonb, now(), now())
      on conflict do nothing`;
    for (const row of legacyGrantRows(TEST_SERVICE_KEYS)) {
      await sql`
        insert into permission_grants
          (id, client_instance_id, holder_kind, holder_id, action, scope_kind, effect, granted_by, created_at)
        values
          (${`grant_${crypto.randomUUID()}`}, ${clientInstanceId}, 'service_principal', ${id},
           ${row.action}, 'instance', ${row.effect}, ${LEGACY_LIST_GRANTOR}, now())
        on conflict do nothing`;
    }
  });
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
  /** Written by the administrator, or for the administrator by the superadmin. Returns the id. */
  grant(
    holderId: string,
    action: string,
    scope: { assetId: string } | { workspaceId: string },
    effect?: "allow" | "deny"
  ): Promise<string>;
  /** A new agent starts hidden unless `availableIn` says where. */
  putAgent(
    userId: string,
    name: string,
    overrides?: Record<string, unknown>,
    availableIn?: "all" | { workspaceId: string }
  ): Promise<AccessResponse>;
  assetId(kind: string, name: string): Promise<string>;
  /** A Shared Workspace the administrator created. Returns its id. */
  sharedWorkspace(name: string): Promise<CollaborationWorkspaceId>;
}

export interface AccessInstanceOptions {
  scopes?: import("@work-shape/catalyst-core").DataScopes;
  /** What the operation layer asks beside the rights: policy and events. */
  operations?: TestServerOptions["operations"];
  /** Tools an agent may name beside the two of the config, such as `read_skill`. */
  furtherToolNames?: string[];
  /** All registered tools, including tools the instance does not enable. */
  registeredToolNames?: string[];
  /** Live data tools the instance exposes to agents. */
  dataTools?: DataToolSource;
  /** Fields of `administration.agentConfiguration` that differ from the open default. */
  editingLimits?: EditingLimits;
  /** Kinds registered beside agent and skill. */
  furtherKinds?: WorkflowAssetKind[];
  /** The model bindings that support fast mode. */
  fastModeModelBindingIds?: string[];
  /** Switches of `modules`, such as `{ connections: { enabled: true } }`. */
  modules?: ModuleSwitches;
  /** The bindings `plain` and `other` with fields of their own, such as efforts to choose. */
  modelBindings?: readonly Record<string, unknown>[];
  /** The model routes of `infrastructure.models`, by name. Left out, the one route `local`. */
  models?: Record<string, Record<string, unknown>>;
  /**
   * The runtime reads the stored agents and skills, as an assembled instance does, so what a
   * workspace offers follows the writes. Left out, the runtime sees none.
   */
  storedAssetSource?: true;
  /**
   * Further server options, built from the stores and the config of the instance. They
   * replace the ones this file sets, such as the call path with a further operation source.
   */
  server?: (
    stores: TestStore,
    config: ReturnType<typeof configWith>,
    kinds?: AssetKindRegistry<WorkflowAssetKind>
  ) => Partial<TestServerOptions>;
  /** Registers further operations beside the product's, as the assembly does for a module. */
  register?: (route: TestRoute) => void;
}

export async function setupAccessInstance(
  options: AccessInstanceOptions = {}
): Promise<AccessInstance> {
  const { operations, furtherToolNames = [], editingLimits = {}, furtherKinds = [] } = options;
  const config = {
    ...configWith(editingLimits, options.modules, options.modelBindings, options.models),
    ...(options.scopes ? { scopes: options.scopes } : {})
  };
  const validationRefs = {
    modelProviderIds: Object.keys(options.models ?? LOCAL_MODELS),
    modelBindingIds: ["plain", "other"],
    modelBindings: [
      { id: "plain", model: "local" },
      { id: "other", model: "local" }
    ],
    fastModeModelBindingIds: options.fastModeModelBindingIds ?? [],
    reasoningEfforts: ["none", "low", "medium", "high", "xhigh"],
    enabledToolNames: ["known.tool", "second.tool", ...furtherToolNames],
    registeredToolNames: options.registeredToolNames ?? [
      "known.tool",
      "second.tool",
      ...furtherToolNames
    ]
  };
  const kinds =
    furtherKinds.length === 0
      ? undefined
      : createAssetKindRegistry([
          ...createTestAssetKinds({ config, validationRefs }).kinds,
          ...furtherKinds
        ]);
  const instance = await createTestInstanceWith(
    (stores) => ({
      config,
      ...(operations ? { operations } : {}),
      // A call the policy holds is filed and decided as on an assembled instance.
      approvalRequests: { store: stores.approvals, handlers: new Map() },
      authAdapter: recordAuthAdapter(),
      auditRecorder: new StoreBackedAuditRecorder({ clientInstanceId, store: stores.audit }),
      configAssets: {
        store: stores.configAssets,
        validationRefs,
        ...(options.dataTools ? { dataTools: options.dataTools } : {}),
        ...(options.storedAssetSource
          ? {
              source: createStoredConfigAssetSource({
                store: stores.configAssets,
                clientInstanceId
              })
            }
          : {}),
        ...(kinds ? { kinds } : {})
      },
      ...options.server?.(stores, config, kinds)
    }),
    options.register
  );
  const { stores } = instance;
  const createUser = (displayLabel: string, roles: UserRole[], permissions: string[] = []) =>
    stores.users.createUser({ clientInstanceId, displayLabel, roles, permissions });
  const root = await createUser("Root", ["user", "admin", "superadmin"]);
  const admin = await createUser("Admin", ["user", "admin"]);
  const kai = await createUser("Kai", ["user"]);
  const lena = await createUser("Lena", ["user"]);
  // An existing default agent, so that no write below is the one that sets the default.
  await applyAtCurrentRevisions(stores.configAssets, {
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
  const grant = async (
    holderId: string,
    action: string,
    scope: { assetId: string } | { workspaceId: string },
    effect: "allow" | "deny" = "allow"
  ) => {
    // Nobody writes a row of their own, so the superadmin writes the administrator's.
    const writer = holderId === admin.id ? root.id : admin.id;
    const response = await expectOk(writer, "permissions.grant", {
      payload: {
        holderKind: "user",
        holderId,
        action,
        effect,
        ...("workspaceId" in scope
          ? { scopeKind: "workspace", scopeId: scope.workspaceId }
          : { scopeKind: "asset", scopeId: scope.assetId })
      }
    });
    return grantSchema.parse(response.json()).id;
  };
  const putAgent = (
    userId: string,
    name: string,
    overrides: Record<string, unknown> = {},
    availableIn?: "all" | { workspaceId: string }
  ) =>
    call(userId, "assets.put", {
      params: { kind: "agent", name },
      payload: { config: agent(name, overrides), ...(availableIn ? { availableIn } : {}) }
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
