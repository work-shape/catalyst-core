import { createAuditingEventEmitter } from "@work-shape/catalyst-server";
import {
  createAuthorizer,
  createOperationRegistry,
  createPlatformId,
  type AuditEvent,
  type AuditEventInput,
  type AuditRecorder,
  type Authorizer,
  type CentralPolicySetting,
  type ClientInstanceId,
  type Logger,
  type ModuleSnapshot,
  type OperationRunStore,
  type PolicyValue,
  type ToolOperationRunner
} from "@work-shape/catalyst-core";
import {
  createToolOperationRunner,
  registerToolOperations,
  type OperationApprovalRequests,
  type RunOperationDeps,
  type ToolRegistry
} from "@work-shape/catalyst-tool-execution";
import { createMemoryOperationRunStore } from "./memory-operation-runs";

export interface TestToolRunnerOptions {
  registry: ToolRegistry;
  getAgentToolNames(agentName: string): readonly string[] | Promise<readonly string[]>;
  auditRecorder?: AuditRecorder;
  logger?: Logger;
  authorizer?: Authorizer;
  /** Where the runs are kept. Without one they are kept in memory, in `runs`. */
  runs?: OperationRunStore;
  centralSettings?: readonly CentralPolicySetting[];
  approvals?: OperationApprovalRequests;
  /** The instance default of changing calls. Without it `confirm`, as an instance has it. */
  changingDefault?: PolicyValue;
  /** Which modules are on. Without it every tool is of a module that is on. */
  modules?: ModuleSnapshot;
}

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger
};

/** Records nothing and answers the event a store would have written. */
export function recordedAuditEvent(
  clientInstanceId: ClientInstanceId,
  input: Omit<AuditEventInput, "clientInstanceId">
): AuditEvent {
  return {
    ...input,
    id: createPlatformId<"AuditEventId">("audit"),
    clientInstanceId,
    createdAt: new Date().toISOString()
  };
}

/**
 * The way an agent's tool call is executed, assembled as an instance assembles it: every tool
 * of the registry registered as an operation and reached through `runOperation`. A test hands
 * the result to the agent runtime as `runTool`, or calls it as the runtime would.
 */
export function createTestToolRunner(
  options: TestToolRunnerOptions
): ToolOperationRunner & { runs: OperationRunStore } {
  const runs = options.runs ?? createMemoryOperationRunStore();
  const runners = new Map<ClientInstanceId, ToolOperationRunner>();
  // The instance is the one of the call: a test names it once, in the context it calls with.
  const runnerOf = (clientInstanceId: ClientInstanceId): ToolOperationRunner => {
    const known = runners.get(clientInstanceId);
    if (known) return known;
    const audit: AuditRecorder = options.auditRecorder ?? {
      record: (input) => Promise.resolve(recordedAuditEvent(clientInstanceId, input))
    };
    const registry = createOperationRegistry();
    registerToolOperations(registry, options.registry.list(), {
      clientInstanceId,
      logger: options.logger
    });
    const deps: RunOperationDeps = {
      clientInstanceId,
      registry,
      runs,
      authorizer: options.authorizer ?? createAuthorizer(),
      events: createAuditingEventEmitter(audit),
      audit,
      policy: {
        instanceDefaults: { reading: "allow", changing: options.changingDefault ?? "confirm" },
        centralSettings: () => options.centralSettings ?? []
      },
      approvals: options.approvals,
      modules: options.modules,
      agentToolNames: options.getAgentToolNames,
      // A test reads the logger of its tools. The call path itself stays silent.
      logger: silentLogger
    };
    const runner = createToolOperationRunner(deps, options.registry);
    runners.set(clientInstanceId, runner);
    return runner;
  };
  const run: ToolOperationRunner = (request, context, callOptions) =>
    runnerOf(context.clientInstanceId)(request, context, callOptions);
  return Object.assign(run, { runs });
}
