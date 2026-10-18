import type { RunOperationDeps } from "@work-shape/catalyst-tool-execution";
import {
  unusedWorkflowRunsStore,
  unusedWorkflowRunDatasetsStore,
  unusedJobsStore,
  unusedActorAccess,
  unusedAuthorizer,
  unusedPlatformStores,
  unusedApiAccessStore,
  unusedConfigAssetStore,
  unusedAuditEventStore,
  unusedOperationRegistry,
  unusedRunOperationDeps
} from "./workflow-memory-ports";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  createPlatformId,
  isWorkflowRunEnded,
  workflowStepJobKind,
  type ActorAccess,
  type ApiAccessStore,
  type AuditEventStore,
  type AuthenticatedUser,
  type Authorizer,
  type ConfigAssetStore,
  type Job,
  type JobControl,
  type JobsStore,
  type JsonValue,
  type Logger,
  type NewWorkflowRun,
  type OperationRegistry,
  type PlatformStores,
  type ServicePrincipalRecord,
  type WorkflowRun,
  type WorkflowManifest,
  type WorkflowRunDataset,
  type WorkflowRunDatasetsStore,
  type WorkflowRunsStore,
  type WorkflowStepRun
} from "@work-shape/catalyst-core";
import { createWorkflowEngine, parseWorkflowManifest } from "@work-shape/catalyst-workflows";
import { MemoryObjectStorage } from "./memory-object-storage";

// A strict port fake for the engine's scale acceptance: unsupported calls throw. Database
// transactions, persistence and recovery are covered by workflow-continue-as-new.test.ts.
// Every supplied method is checked against its product-owned store port. No runtime module
// is replaced, so the real engine, dataset reader and job handlers process every row.
function port<T extends object>(base: T, methods: Partial<T>): T {
  return new Proxy(base, {
    get(target, key, receiver) {
      if (key === "then") return undefined;
      if (Reflect.has(methods, key)) return Reflect.get(methods, key, receiver);
      return Reflect.get(target, key, receiver);
    }
  });
}
const clone = <T>(value: T): T => structuredClone(value);
const stamp = "2026-10-18T00:00:00.000Z";
const clientInstanceId = createPlatformId<"ClientInstanceId">("instance");
const user: AuthenticatedUser = {
  id: "scale-owner",
  externalUserId: "scale-owner",
  displayLabel: "Scale owner",
  roles: [],
  permissionRefs: [],
  clientInstanceId,
  authSource: "test"
};
const principal: ServicePrincipalRecord = {
  id: createPlatformId<"ServicePrincipalId">("sp"),
  clientInstanceId,
  name: "scale-runner",
  displayLabel: "Scale runner",
  status: "active",
  permissionRefs: [],
  permissions: [],
  createdAt: stamp,
  updatedAt: stamp
};
const logger: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => logger };
type LoopState = {
  items:
    readonly JsonValue[] | { $dataset: string; rowCount: number; bytes: number; offset?: number };
  total: number;
  first?: string;
  last?: string;
  started: number;
  done: number;
  failed: number;
};

export async function memoryWorkflowEngine(
  rowCount: number,
  options: {
    manifest?(manifest: WorkflowManifest): unknown;
  } = {}
) {
  const manifests = new Map<string, NewWorkflowRun["definition"]>();
  const inputs = new Map<string, NewWorkflowRun["input"]>();
  const checkpoints = new Map<string, NewWorkflowRun["checkpoint"]>();
  const runs = new Map<string, WorkflowRun>();
  const steps = new Map<string, WorkflowStepRun>();
  const outputs = new Map<string, { value: JsonValue }>();
  const byPlace = new Map<string, string>();
  const loops = new Map<string, LoopState>();
  const queue: Job[] = [];
  const seen = new Set<string>();
  let revision = "published-1";
  const objects = new MemoryObjectStorage();
  const sourceId = createPlatformId<"WorkflowRunId">("wfr");
  const bytes = Buffer.from(
    Array.from({ length: rowCount }, (_, id) => JSON.stringify({ id: String(id) }) + "\n").join("")
  );
  const key = `workflow-runs/${sourceId}/rows/0.jsonl.gz`;
  await objects.put(key, gzipSync(bytes));
  const dataset: WorkflowRunDataset = {
    id: "scale-rows",
    clientInstanceId,
    runId: sourceId,
    stepRunId: createPlatformId<"WorkflowStepRunId">("wfs"),
    field: "rows",
    rowSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    rowCount,
    bytes: bytes.length,
    state: "complete",
    parts: [
      {
        key,
        rows: rowCount,
        bytes: bytes.length,
        hash: createHash("sha256").update(bytes).digest("hex")
      }
    ]
  };
  const parsed = parseWorkflowManifest({
    id: "scale",
    name: "Scale",
    runAs: principal.name,
    labels: { customer: { value: "Acme" } },
    onFailure: "notify",
    limits: { stepRuns: 20_000 },
    inputs: {
      type: "object",
      properties: {
        rows: { type: "dataset", row: dataset.rowSchema },
        offset: { type: "integer" }
      },
      required: ["rows"]
    },
    outputs: { type: "object" },
    steps: [
      { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
      {
        id: "each",
        name: "Each",
        type: "loop",
        items: { step: "start", path: "input.rows" },
        continueAsNew: { position: "offset" },
        steps: [
          {
            id: "notice",
            name: "Notice",
            type: "notify",
            to: { users: [user.id] },
            channels: ["inbox"],
            title: { value: "Processed" },
            text: { ref: { step: "each", path: "id" } }
          }
        ]
      },
      { id: "result", name: "Result", type: "output", input: {} }
    ]
  });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  const configured = parseWorkflowManifest(options.manifest?.(parsed.manifest) ?? parsed.manifest);
  if (!configured.ok) throw new Error(JSON.stringify(configured.issues));
  const manifest = configured.manifest;
  const source: WorkflowRun = {
    id: sourceId,
    clientInstanceId,
    workflow: "scale",
    definitionRevisionId: "source",
    mode: "live",
    trigger: "manual",
    status: "done",
    principal,
    startedBy: { kind: "user", id: user.id, label: user.displayLabel },
    rootRunId: sourceId,
    depth: 0,
    stepRunCount: 0,
    deadlineAt: stamp,
    limits: { durationMs: 43_200_000, stepRuns: 20_000, loopItems: 10_000 },
    waitedMs: 0,
    correlationId: "scale",
    createdAt: stamp
  };
  const place = (runId: string, stepId: string, container = "", iteration = 0) =>
    `${runId}:${container}:${iteration}:${stepId}`;
  function mustRun(id: string) {
    const run = runs.get(id);
    if (!run) throw new Error("Unknown run");
    return run;
  }
  function mustStep(id: string) {
    const step = steps.get(id);
    if (!step) throw new Error("Unknown step");
    return step;
  }
  const workflowRuns = port<WorkflowRunsStore>(unusedWorkflowRunsStore, {
    async createRun(given) {
      const { definition, input, checkpoint, ...record } = given;
      const run: WorkflowRun = {
        ...record,
        rootRunId: given.rootRunId ?? given.id,
        depth: given.depth ?? 0,
        status: "queued",
        stepRunCount: 0,
        waitedMs: 0
      };
      runs.set(run.id, run);
      manifests.set(run.id, definition);
      inputs.set(run.id, input);
      checkpoints.set(run.id, checkpoint);
      return clone(run);
    },
    async readRun(ref) {
      return clone(ref.id === sourceId ? source : runs.get(ref.id));
    },
    async lockRun(ref) {
      return clone(runs.get(ref.id));
    },
    async readRunInput(ref) {
      return clone(inputs.get(ref.id));
    },
    async readRunDefinition(ref) {
      return clone(manifests.get(ref.id));
    },
    async readCheckpoint(ref) {
      return clone(checkpoints.get(ref.id));
    },
    async listRuns() {
      return [...runs.values()].map(clone);
    },
    async markRunRunning(ref) {
      const run = mustRun(ref.id);
      if (run.status === "queued")
        Object.assign(run, { status: "running", startedAt: ref.startedAt });
    },
    async markRunWaiting() {
      return false;
    },
    async markContinuation(ref) {
      const run = mustRun(ref.id);
      run.continuation = { rootRunId: run.id, number: 1 };
    },
    async handoffContinuation(ref) {
      const run = mustRun(ref.id);
      if (run.continuation) run.continuation.successorRunId = ref.successorId;
    },
    async endRun(ref) {
      const run = mustRun(ref.id);
      if (isWorkflowRunEnded(run.status)) return false;
      Object.assign(run, ref);
      return true;
    },
    async createStepRun(given) {
      const step: WorkflowStepRun = { ...given, status: "queued", attempt: 0 };
      steps.set(step.id, step);
      byPlace.set(
        place(step.runId, step.stepId, step.containerStepRunId, step.iteration?.index),
        step.id
      );
      mustRun(step.runId).stepRunCount++;
      const loop = step.containerStepRunId ? loops.get(step.containerStepRunId) : undefined;
      if (loop?.first === step.stepId) loop.started++;
      return clone(step);
    },
    async getStepRun(ref) {
      return clone(steps.get(ref.id));
    },
    async markStepRunRunning(ref) {
      Object.assign(mustStep(ref.id), {
        status: "running",
        attempt: ref.attempt,
        startedAt: ref.startedAt
      });
    },
    async endStepRun(ref) {
      const step = mustStep(ref.id);
      if (["done", "failed", "cancelled"].includes(step.status)) return false;
      Object.assign(step, ref);
      if (ref.output !== undefined) outputs.set(step.id, { value: ref.output });
      const loop = step.containerStepRunId ? loops.get(step.containerStepRunId) : undefined;
      if (loop && ref.status === "failed") loop.failed++;
      else if (loop?.last === step.stepId && ref.status === "done") loop.done++;
      return true;
    },
    async findStepOutput(ref) {
      const id = byPlace.get(place(ref.runId, ref.stepId, ref.containerStepRunId, ref.iteration));
      return id ? clone(outputs.get(id)) : undefined;
    },
    async markLoopWaiting(ref) {
      mustStep(ref.id).status = "waiting";
      loops.set(ref.id, {
        items: ref.items,
        total: ref.total ?? (Array.isArray(ref.items) ? ref.items.length : 0),
        first: ref.firstStepId,
        last: ref.lastStepId,
        started: 0,
        done: 0,
        failed: 0
      });
    },
    async readLoopProgress(ref) {
      const loop = loops.get(ref.id);
      return {
        started: loop?.started ?? 0,
        running: (loop?.started ?? 0) - (loop?.done ?? 0) - (loop?.failed ?? 0)
      };
    },
    async countLoopItems(ref) {
      return loops.get(ref.id)?.total;
    },
    async readLoopDataset(ref) {
      const items = loops.get(ref.id)?.items;
      return items && "$dataset" in items ? items : undefined;
    },
    async readLoopItem(ref) {
      const items = loops.get(ref.id)?.items;
      const value = items && !("$dataset" in items) ? items[ref.index] : undefined;
      return value === undefined ? undefined : { value };
    },
    async readLoopCounts(ref) {
      const loop = loops.get(ref.id);
      return loop
        ? {
            total: loop.total,
            done: loop.done,
            failed: loop.failed,
            running: loop.started - loop.done - loop.failed
          }
        : undefined;
    },
    async listOpenStepRuns(ref) {
      return [...steps.values()]
        .filter(
          (step) => step.runId === ref.id && !["done", "failed", "cancelled"].includes(step.status)
        )
        .map(clone);
    },
    async listChildRuns() {
      return [];
    },
    async listLinkedStepRuns() {
      return [];
    },
    async readRunOutput() {
      return undefined;
    }
  });
  const workflowRunDatasets = port<WorkflowRunDatasetsStore>(unusedWorkflowRunDatasetsStore, {
    async get(ref) {
      return ref.id === dataset.id ? clone(dataset) : undefined;
    },
    async getMany() {
      return [clone(dataset)];
    },
    async canRead() {
      return true;
    },
    async allowRun() {},
    async finishRun() {},
    async completeStep() {
      return [];
    },
    async listForSteps() {
      return [];
    }
  });
  const jobs = port<JobsStore>(unusedJobsStore, {
    async runAgainAfter() {},
    async enqueue(kind, payload, options) {
      const job = {
        id: createPlatformId<"JobId">("job"),
        clientInstanceId,
        kind: kind.kind,
        payload: kind.payloadSchema.parse(payload),
        status: "queued" as const,
        runAfter: (options.runAfter ?? new Date(stamp)).toISOString(),
        attempts: 1,
        maxAttempts: kind.maxAttempts,
        correlationId: "scale",
        createdAt: stamp,
        dedupeKey: options.dedupeKey
      };
      if (kind.kind === workflowStepJobKind.kind) queue.push(job);
      return job;
    },
    async withdraw() {}
  });
  const access = port<ActorAccess>(unusedActorAccess, { require() {} });
  const authorizer = port<Authorizer>(unusedAuthorizer, {
    async forActor() {
      return access;
    }
  });
  let stores: PlatformStores;
  stores = port<PlatformStores>(unusedPlatformStores, {
    workflowRuns,
    workflowRunDatasets,
    jobs,
    apiAccess: port<ApiAccessStore>(unusedApiAccessStore, {
      async findServicePrincipalByName() {
        return principal;
      }
    }),
    configAssets: port<ConfigAssetStore>(unusedConfigAssetStore, {
      async getConfigAsset() {
        return undefined;
      }
    }),
    audit: port<AuditEventStore>(unusedAuditEventStore, {
      async appendAuditEvent(input) {
        return { ...input, id: createPlatformId<"AuditEventId">("audit"), createdAt: stamp };
      }
    }),
    async transaction(fn) {
      return fn(stores);
    },
    async readSnapshot(fn) {
      return fn(stores);
    }
  });
  const deps = port<RunOperationDeps>(unusedRunOperationDeps, { authorizer });
  const registry = port<OperationRegistry>(unusedOperationRegistry, {
    addSource() {},
    async resolve() {
      return undefined;
    },
    async resolveMany() {
      return new Map();
    }
  });
  const engine = createWorkflowEngine({
    clientInstanceId,
    stores,
    stepSlots: 1,
    now: () => new Date(stamp),
    datasetObjects: objects,
    datasetLimits: {
      rows: 100_000,
      bytes: 2_000_000,
      rowBytes: 1000,
      runBytes: 2_000_000,
      instanceBytes: 4_000_000
    },
    definitions: {
      async read() {
        return { revisionId: revision, manifest };
      },
      async list() {
        return [{ id: manifest.id, name: manifest.name }];
      }
    },
    operationCalls: { registry, deps },
    notices: () => ({
      async send(input) {
        const key = `${input.title}:${input.text}`;
        if (seen.has(key)) throw new Error("A dataset row ran twice");
        seen.add(key);
        if (seen.size === 19_990) revision = "published-2";
        return { addressees: 1, inactive: 0, mailsQueued: 0, mailsSent: 0, mailsUnsent: 0 };
      }
    })
  });
  const control: JobControl = {
    leaseToken: "scale",
    signal: new AbortController().signal,
    attempt: 1,
    logger,
    transaction: (fn) => stores.transaction(fn)
  };
  return {
    engine,
    objects,
    seen,
    runs,
    inputs,
    async execute() {
      const input = {
        workflow: manifest.id,
        key: "2026-10-18",
        input: { rows: { $dataset: dataset.id, rowCount, bytes: dataset.bytes } },
        startedBy: user,
        correlationId: "scale"
      };
      await engine.start(input);
      const handler = engine.jobHandlers.find(
        (item) => item.kind.kind === workflowStepJobKind.kind
      );
      if (!handler) throw new Error("Missing engine step handler");
      for (let index = 0; index < queue.length; index++) {
        const job = queue[index];
        if (job) await handler.bind(job).run(control);
      }
      return [...runs.values()];
    }
  };
}
