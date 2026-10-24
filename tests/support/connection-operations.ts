import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import { z } from "zod";
import { createConnectionAssetKind, createOperationCalls } from "@work-shape/catalyst-server";
import { createLogger, resolveInstanceModules } from "@work-shape/catalyst-client-assembly";
import {
  CONNECTION_MAX_PARALLEL_CALLS,
  createConnectionCredentialResolver,
  createConnectionManagement,
  createConnectionOperationSource,
  createEgressChecker,
  createSecretStore,
  egressTargetOfUrl,
  loadSecretKeyring,
  type ConnectionOperationSourceDeps
} from "@work-shape/catalyst-connections";
import {
  SHARED_CREDENTIAL_SUBJECT,
  SecretNotResolvedError,
  StoreBackedAuditRecorder,
  asAgentRunId,
  asConversationId,
  asToolCallId,
  createAuthorizer,
  createConnectorTypeRegistry,
  egressOriginOf,
  NO_BEFORE_ACTION_CHECK,
  type AuthenticatedIdentity,
  type Authorizer,
  type CentralPolicySetting,
  type ConnectionCredentialResolver,
  type ConnectionHealth,
  type ConnectorContext,
  type ConnectorLimits,
  type ConnectorOperationDescriptor,
  type ConnectorTypeDefinition,
  type EgressChecker,
  type PlatformEventEmitter,
  type JsonValue,
  type OperationEffect,
  type OperationOrigin,
  type OperationRun,
  type UserRecord
} from "@work-shape/catalyst-core";
import { runOperation, type OperationOutcome } from "@work-shape/catalyst-tool-execution";
import {
  clientInstanceId,
  setupAccessInstance,
  type AccessInstance,
  type AccessInstanceOptions
} from "./access-instance";
import { connection } from "./connections";
import { generateSecretStoreKey, generateTestSecret } from "./test-connector";
import { applyAtCurrentRevisions } from "./asset-revisions";

// The instance behind the tests of a Connection's operations: real rows, the real call path,
// the real Secret Store and egress checker, and Connector types that reach nothing and record
// what they were handed. Every step a call takes is written to one `sequence`.

const HOST = "outside.example.com";
export const URL_OF_HOST = `https://${HOST}/api`;
/** A second system on the egress list: a Connection moved there no longer reaches the first. */
const SECOND_HOST = "second.example.com";
export const URL_OF_SECOND_HOST = `https://${SECOND_HOST}/api`;
const KEY_REF = "TEST_SECRET_STORE_KEY";

export const echo: ConnectorOperationDescriptor = {
  name: "echo",
  description: "Returns its input.",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string", maxLength: 40 } },
    required: ["text"],
    additionalProperties: false
  },
  outputSchema: { type: "object" },
  proposedEffect: "reading"
};
export const write: ConnectorOperationDescriptor = {
  name: "write",
  description: "Changes something outside.",
  inputSchema: { type: "object" },
  proposedEffect: "changing"
};
/** What an outside system lists, for the type that reads its catalog from one. */
export const lookup: ConnectorOperationDescriptor = {
  name: "lookup",
  description: "Looks a customer up.",
  inputSchema: {
    type: "object",
    properties: { customerNumber: { type: "string", pattern: "^C[0-9]{6}$" } },
    required: ["customerNumber"],
    additionalProperties: false
  },
  proposedEffect: "reading"
};

const settingsSchema = z.object({ url: z.string().url() }).strict();
export const DEFAULT_LIMITS: ConnectorLimits = {
  callTimeoutMs: 2_000,
  resultMaxBytes: 1_024,
  maxParallelCalls: CONNECTION_MAX_PARALLEL_CALLS
};

type Behaviour = (
  operation: string,
  input: JsonValue,
  context: ConnectorContext
) => Promise<JsonValue>;

export const operationOf = (
  name: string,
  overrides: Record<string, JsonValue> = {}
): JsonValue => ({
  name,
  effect: "reading",
  // Open to agents and to outside clients, the default origin of `invoke`.
  exposure: ["agent", "outside"],
  enabled: true,
  ...overrides
});

export const identityOf = (user: UserRecord): AuthenticatedIdentity => ({
  id: user.id,
  externalUserId: user.id,
  displayLabel: user.displayLabel,
  roles: user.roles,
  permissions: user.permissions,
  permissionRefs: user.permissionRefs,
  clientInstanceId,
  authSource: "test",
  scopes: ["*"]
});

export const agentOrigin = (toolName: string, agentName = "assistant"): OperationOrigin => ({
  kind: "agent",
  agentRunId: asAgentRunId("agentrun_test"),
  conversationId: asConversationId("conv_test"),
  agentName,
  toolCallId: asToolCallId("call_test"),
  toolName
});
/** The origin of a call of a Page of a conversation. A call of an App names its App. */
export const appOrigin: OperationOrigin = {
  kind: "app",
  appRevisionId: "apprev_test",
  actionName: "load",
  pageSessionId: "page_test",
  conversationId: asConversationId("conv_test")
};

const failedSchema = z.object({
  status: z.literal("failed"),
  error: z.object({ code: z.string(), message: z.string() })
});

/** What a test changes about its instance while it runs. */
interface FixtureState {
  hostAllowed: boolean;
  /** Whether the listed host has an address. Read by the checker's resolver. */
  hostResolves: boolean;
  limits: ConnectorLimits;
  centralSettings: CentralPolicySetting[];
  agentTools: Map<string, string[]>;
  /** Runs once, between the read that resolves a call and the read inside the call. */
  beforeSecondRead: (() => Promise<void>) | undefined;
}

interface ExecutedCall {
  operation: string;
  input: JsonValue;
  secret: string | undefined;
  /** The key of the call and the header for it, where the type was handed them. */
  idempotencyKey?: { header: string; value: string };
}

interface InvokeOptions {
  draft?: import("@work-shape/catalyst-core").OperationDraftContext;
  origin?: OperationOrigin;
  workspaceId?: import("@work-shape/catalyst-core").CollaborationWorkspaceId;
  effect?: OperationEffect;
  idempotencyKey?: string;
}

export interface ConnectionOperationsFixture extends AccessInstance {
  /** The credential of every Connection `seed` stores, and the key that encrypts it. */
  secret: string;
  storeKey: string;
  state: FixtureState;
  /** What happened since the last `invoke` began, in order. */
  sequence: string[];
  /** The calls a Connector type received since the last `invoke` began. */
  executed: ExecutedCall[];
  /** Every credential a Connector type was handed. Never cleared. */
  handed: (string | undefined)[];
  sourceDeps: ConnectionOperationSourceDeps;
  /** The call path of the instance, with the Connections' operations in its registry. */
  operationCalls: ReturnType<typeof createOperationCalls>;
  /** Stores a Connection of the static type with its secret. Returns the asset id. */
  seed(name: string, overrides?: Record<string, JsonValue | undefined>): Promise<string>;
  /** Calls an operation through `runOperation`, as the person and from the origin named, the CLI by default. */
  invoke(
    user: UserRecord,
    operation: string,
    input: unknown,
    further?: InvokeOptions
  ): Promise<OperationOutcome>;
  /** The reason the run of a failed call keeps, with the code and the sentence of its error. */
  failure(
    work: Promise<OperationOutcome>
  ): Promise<{ code: string; reason: string | undefined; message: string }>;
  /** The runs of Connection operations. The grants a test writes leave runs of their own. */
  runs(): Promise<OperationRun[]>;
  health(assetId: string): Promise<ConnectionHealth | undefined>;
  setBehaviour(next: Behaviour): void;
}

export function fixture(options: { secret?: string } = {}): Promise<ConnectionOperationsFixture> {
  return fixtureOn(setupAccessInstance, options);
}

/**
 * The same fixture on an instance a test sets up itself, such as one with Apps. `setup` is
 * handed the modules, the kinds and the server options the Connections need.
 */
export async function fixtureOn<Instance extends AccessInstance>(
  setup: (options: AccessInstanceOptions) => Promise<Instance>,
  options: {
    secret?: string;
    catalog?: ConnectorOperationDescriptor[];
    /** The events of the call path, such as one whose guardrails run. Audited ones when absent. */
    events?: (stores: AccessInstance["stores"]) => PlatformEventEmitter;
    /** The person context header the static type sends. None when absent. */
    personContextHeader?: string;
  } = {}
): Promise<ConnectionOperationsFixture & Instance> {
  /** What happened, in order, across the call path, the stores and the Connector type. */
  const sequence: string[] = [];
  const secret = options.secret ?? generateTestSecret();
  const storeKey = generateSecretStoreKey();
  const state: FixtureState = {
    hostAllowed: true,
    hostResolves: true,
    limits: DEFAULT_LIMITS,
    centralSettings: [],
    agentTools: new Map(),
    beforeSecondRead: undefined
  };
  let behave: Behaviour = (_operation, input) => Promise.resolve(input);
  const executed: ExecutedCall[] = [];
  /** Every credential a Connector type was handed. Never cleared. */
  const handed: (string | undefined)[] = [];

  const base = {
    description: "Records its calls. For tests.",
    settingsSchema,
    authSchemes: ["none", "bearer"],
    secretFields: ["token"],
    target: (settings: Record<string, JsonValue>) =>
      egressTargetOfUrl(settingsSchema.parse(settings).url),
    test: () => Promise.resolve({ status: "ready" as const }),
    carriesIdempotencyKey: true as const,
    execute(operation: string, input: JsonValue, context: ConnectorContext) {
      sequence.push("execute");
      handed.push(context.credentialFor(context.target)?.secret);
      executed.push({
        operation,
        input,
        secret: context.credentialFor(context.target)?.secret,
        ...(context.idempotencyKey ? { idempotencyKey: context.idempotencyKey } : {})
      });
      return behave(operation, input, context);
    },
    get limits() {
      return state.limits;
    }
  };
  const { personContextHeader } = options;
  const staticType: ConnectorTypeDefinition = {
    ...base,
    type: "test",
    catalog: options.catalog ?? [echo, write],
    ...(personContextHeader === undefined
      ? {}
      : { personContextHeaderName: () => personContextHeader })
  };
  Object.defineProperty(staticType, "limits", { get: () => state.limits });
  const discoveringType: ConnectorTypeDefinition = {
    ...base,
    type: "discovering",
    discover: () => Promise.resolve([lookup]),
    // A form of its own: the New connection dialog offers it beside an MCP server.
    form: {
      title: { en: "Discovering", de: "Entdeckend" },
      description: "Reads its tools. For tests.",
      authScheme: "bearer",
      settings: { mode: "fixed" },
      fields: [
        { label: "Address", setting: "url" },
        { label: { en: "Token", de: "Token" }, help: "Sent as a bearer.", secret: true }
      ]
    }
  };
  Object.defineProperty(discoveringType, "limits", { get: () => state.limits });
  const connectorTypes = createConnectorTypeRegistry([staticType, discoveringType]);

  const keyring = await loadSecretKeyring({
    keys: [{ id: "k1", ref: KEY_REF }],
    secrets: {
      resolve: (name) =>
        name === KEY_REF
          ? Promise.resolve(storeKey)
          : Promise.reject(new SecretNotResolvedError(name, "is not set"))
    }
  });
  const address = () =>
    state.hostResolves
      ? Promise.resolve([{ address: "93.184.216.34", family: 4 as const }])
      : Promise.reject(new Error("ENOTFOUND"));
  const open = createEgressChecker({
    allow: [HOST, SECOND_HOST].map((host) => ({
      protocol: "https" as const,
      host,
      port: 443,
      network: "public" as const,
      cidrs: []
    })),
    resolve: address
  });
  const closed = createEgressChecker({ allow: [], resolve: address });
  const egress: EgressChecker = {
    check(target) {
      sequence.push("check egress");
      return (state.hostAllowed ? open : closed).check(target);
    },
    admits: (target) => (state.hostAllowed ? open : closed).admits(target)
  };

  let deps: ConnectionOperationSourceDeps | undefined;
  let calls: ReturnType<typeof createOperationCalls> | undefined;
  const t = await setup({
    modules: { connections: { enabled: true } },
    furtherKinds: [createConnectionAssetKind({ connectorTypes, egress })],
    server(stores, config, kinds) {
      const resolver = createConnectionCredentialResolver({
        clientInstanceId,
        keyring,
        store: stores.connections
      });
      const credentials: ConnectionCredentialResolver = {
        resolve(input) {
          sequence.push("resolve credential");
          return resolver.resolve(input);
        },
        resolveSignIn(input) {
          sequence.push("resolve credential");
          return resolver.resolveSignIn(input);
        }
      };
      const evaluator = createAuthorizer(stores.access);
      const authorizer: Authorizer = {
        async forActor(actor, scope) {
          const access = await evaluator.forActor(actor, scope);
          return {
            ...access,
            authorize(action, resource) {
              if (action.startsWith("connection.")) sequence.push(`authorize ${action}`);
              return access.authorize(action, resource);
            }
          };
        }
      };
      const logger = createLogger();
      const auditRecorder = new StoreBackedAuditRecorder({ clientInstanceId, store: stores.audit });
      const operations = {
        centralPolicySettings() {
          sequence.push("resolve policy");
          return state.centralSettings;
        },
        ...(options.events ? { events: options.events(stores) } : {})
      };
      const approvalRequests = { store: stores.approvals, handlers: new Map() };
      calls = createOperationCalls({
        clientInstanceId,
        stores,
        auditRecorder,
        authorizer,
        config,
        logger,
        modules: resolveInstanceModules(config, []).snapshot,
        operations,
        approvalRequests,
        checks: NO_BEFORE_ACTION_CHECK,
        // The kinds, as the assembly hands them: the publish review reads a Workflow's account.
        ...(kinds ? { configAssets: { kinds } } : {}),
        agentToolNames: (agentName) => state.agentTools.get(agentName) ?? []
      });
      deps = { clientInstanceId, stores, connectorTypes, egress, credentials, logger };
      calls.registry.addSource(createConnectionOperationSource(deps));
      return {
        auditRecorder,
        authorizer,
        logger,
        operations,
        approvalRequests,
        operationCalls: calls,
        connections: createConnectionManagement({ ...deps, keyring })
      };
    }
  });
  // The server, and with it the call path, is built on the first request.
  await t.instance.call("health.get");
  if (!deps || !calls) throw new Error("The instance did not build its call path");
  const operationCalls = calls;
  const sourceDeps = deps;
  const { stores } = t;

  const getAsset = stores.configAssets.getConfigAsset.bind(stores.configAssets);
  let connectionReads = 0;
  vi.spyOn(stores.configAssets, "getConfigAsset").mockImplementation(async (input) => {
    if (input.kind === "connection") {
      connectionReads += 1;
      if (connectionReads === 2 && state.beforeSecondRead) {
        const change = state.beforeSecondRead;
        state.beforeSecondRead = undefined;
        await change();
      }
      sequence.push("read connection");
    }
    return getAsset(input);
  });
  const createRun = stores.operationRuns.create.bind(stores.operationRuns);
  vi.spyOn(stores.operationRuns, "create").mockImplementation((run) => {
    sequence.push("create run");
    return createRun(run);
  });
  const finishRun = stores.operationRuns.finish.bind(stores.operationRuns);
  vi.spyOn(stores.operationRuns, "finish").mockImplementation((input) => {
    sequence.push(`record ${input.end.status}`);
    return finishRun(input);
  });

  /** Stores a Connection of the static type with its secret. Returns the asset id. */
  const handles = new Map<string, string>();
  const seed = async (name: string, overrides: Record<string, JsonValue | undefined> = {}) => {
    const handle = handles.get(name) ?? `secret_${randomUUID()}`;
    handles.set(name, handle);
    await applyAtCurrentRevisions(stores.configAssets, {
      clientInstanceId,
      mutations: [
        {
          type: "upsert",
          kind: "connection",
          name,
          config: connection(name, {
            connectorType: "test",
            settings: { url: URL_OF_HOST },
            secretHandle: handle,
            operations: [operationOf("echo")],
            ...overrides
          })
        }
      ]
    });
    const assetId = await t.assetId("connection", name);
    await createSecretStore({ clientInstanceId, keyring, store: stores.connections }).put({
      binding: { connectionAssetId: assetId, subject: SHARED_CREDENTIAL_SUBJECT },
      value: secret,
      source: "runtime",
      handle,
      origin: egressOriginOf(egressTargetOfUrl(URL_OF_HOST))
    });
    return assetId;
  };

  const invoke = (
    user: UserRecord,
    operation: string,
    input: unknown,
    further: InvokeOptions = {}
  ) => {
    sequence.length = 0;
    connectionReads = 0;
    executed.length = 0;
    return runOperation(
      {
        operation,
        effect: further.effect ?? "reading",
        input,
        actor: identityOf(user),
        // A direct call needs an origin some exposure admits: a person's key over the CLI.
        origin: further.origin ?? { kind: "cli" },
        workspaceId: further.workspaceId,
        ...(further.draft ? { draft: further.draft } : {}),
        correlationId: "corr_test",
        ...(further.idempotencyKey ? { idempotencyKey: further.idempotencyKey } : {})
      },
      operationCalls.deps
    );
  };
  /** The reason a failed call carries beside its sentence. */
  const failure = async (work: Promise<OperationOutcome>) => {
    const outcome = await work;
    const { error } = failedSchema.parse(outcome.result);
    return { code: error.code, reason: outcome.run.error?.reason, message: error.message };
  };
  /** The runs of Connection operations. The grants a test writes leave runs of their own. */
  const runs = async () =>
    (await stores.operationRuns.list({ clientInstanceId })).filter((run) =>
      run.operation.startsWith("connection.")
    );
  const health = async (assetId: string) =>
    (await stores.connections.getConnectionState({ clientInstanceId, connectionAssetId: assetId }))
      ?.health;

  return {
    ...t,
    secret,
    storeKey,
    state,
    sequence,
    executed,
    handed,
    sourceDeps,
    operationCalls,
    seed,
    invoke,
    failure,
    runs,
    health,
    setBehaviour(next: Behaviour) {
      behave = next;
    }
  };
}
