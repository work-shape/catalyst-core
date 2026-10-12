import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  createInstanceWorkflows,
  createJobWorker,
  resolveInstanceModules,
  type InstanceWorkflows,
  type InstanceWorkflowsParts
} from "@vivd-catalyst/client-assembly";
import type {
  JobControl,
  JobWorker,
  Logger,
  ModuleSnapshot,
  RegisteredJobHandler,
  ServicePrincipalRecord
} from "@vivd-catalyst/core";
import {
  createWorkflowFolderSource,
  type WorkflowDefinitionSource
} from "@vivd-catalyst/workflows";
import { clientInstanceId, setupAccessInstance } from "./access-instance";
import { fixtureOn, operationOf, type ConnectionOperationsFixture } from "./connection-operations";

// The instance behind the tests of the Workflow engine: the instance of the Connection
// tests with the module `workflows` on, the engine on its call path, and definitions read
// from the fixture folders. The assembly does not wire the engine yet, so this file does
// what it will do: the engine's port goes to the server and its handlers to a job worker.

const silent: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => silent
};

const here = dirname(fileURLToPath(import.meta.url));
export const WORKFLOW_FIXTURES = resolve(here, "../fixtures/workflows");

export const runSchema = z.object({
  id: z.string(),
  workflow: z.string(),
  status: z.string(),
  stepRunCount: z.number(),
  principal: z.object({ id: z.string(), displayLabel: z.string() }),
  startedBy: z.object({ kind: z.string(), id: z.string(), label: z.string() }),
  error: z
    .object({ code: z.string(), message: z.string(), stepRunId: z.string().optional() })
    .optional(),
  outputPreview: z.object({ text: z.string(), truncated: z.boolean() }).optional()
});
export const stepRunsSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      stepId: z.string(),
      key: z.string(),
      status: z.string(),
      attempt: z.number(),
      iteration: z.object({ index: z.number(), label: z.string().optional() }).optional(),
      loop: z
        .object({ total: z.number(), done: z.number(), failed: z.number(), running: z.number() })
        .optional(),
      operationRunId: z.string().optional(),
      error: z.object({ code: z.string(), message: z.string() }).optional(),
      outputPreview: z.object({ text: z.string(), truncated: z.boolean() }).optional()
    })
  )
});

/** The name the fixture Workflows name under `runAs`. */
export const WORKFLOW_RUNNER = "workflow-runner";

/** The definitions of the fixture folders. */
export const fixtureDefinitions = (): WorkflowDefinitionSource =>
  createWorkflowFolderSource(WORKFLOW_FIXTURES);

/**
 * A handler whose attempts hang in one of their transactions, as a worker does that dies
 * there: the transaction never opens, and the attempt ends when its worker stops. `at` is
 * the number of the transaction across all attempts, from 1; `reached` resolves there.
 */
export function hangingAt(
  handlers: readonly RegisteredJobHandler[],
  at: number
): { handlers: RegisteredJobHandler[]; reached: Promise<void> } {
  let count = 0;
  let signalReached: () => void = () => undefined;
  const reached = new Promise<void>((done) => {
    signalReached = done;
  });
  const hang = (control: JobControl): JobControl["transaction"] =>
    function transaction(fn) {
      count += 1;
      if (count !== at) return control.transaction(fn);
      signalReached();
      return new Promise((_resolve, reject) => {
        control.signal.addEventListener("abort", () => reject(new Error("The worker stopped")));
      });
    };
  return {
    reached,
    handlers: handlers.map((handler) => ({
      kind: handler.kind,
      slots: handler.slots,
      bind(job) {
        const bound = handler.bind(job);
        return {
          ...bound,
          run: (control) =>
            bound.run({
              leaseToken: control.leaseToken,
              signal: control.signal,
              attempt: control.attempt,
              logger: control.logger,
              transaction: hang(control)
            })
        };
      }
    }))
  };
}

export interface WorkflowFixture extends ConnectionOperationsFixture {
  /** What the instance has of Workflows. No job handler where the module is off. */
  workflows: InstanceWorkflows;
  /** The service principal the fixture Workflows run as. It holds no grant at first. */
  principal: ServicePrincipalRecord;
  /** A job worker that serves the engine's handlers, or the ones given in their place. */
  worker(handlers?: readonly RegisteredJobHandler[]): JobWorker;
  /** Runs what is due until the run has ended. Returns the run as the root reads it. */
  finish(runId: string, worker?: JobWorker): Promise<z.infer<typeof runSchema>>;
  /** Lets a holder do an action on everything of the instance. */
  allow(holder: { kind: "user" | "service_principal"; id: string }, action: string): Promise<void>;
  /** Stores the Connection `crm` with `echo` and `write` exposed to Workflows. */
  seedCrm(): Promise<string>;
}

export async function workflowFixture(
  options: { moduleOn?: boolean; limits?: InstanceWorkflowsParts["limits"] } = {}
): Promise<WorkflowFixture> {
  let workflows: InstanceWorkflows | undefined;
  let modules: ModuleSnapshot | undefined;
  const workers: JobWorker[] = [];
  const t = await fixtureOn((connectionOptions) =>
    setupAccessInstance({
      ...connectionOptions,
      modules: {
        ...connectionOptions.modules,
        ...(options.moduleOn === false ? {} : { workflows: { enabled: true } })
      },
      server(stores, config) {
        const server = connectionOptions.server?.(stores, config) ?? {};
        if (!server.operationCalls) throw new Error("The instance built no call path");
        modules = resolveInstanceModules(config, []).snapshot;
        workflows = createInstanceWorkflows({
          modules,
          clientInstanceId,
          stores,
          operationCalls: server.operationCalls,
          definitions: fixtureDefinitions(),
          ...(options.limits ? { limits: options.limits } : {})
        });
        return server;
      },
      // What the assembly does with the routes of a module: they follow the server's own.
      register(route) {
        for (const register of workflows?.routes ?? []) register(route);
      }
    })
  );
  const principal = await t.stores.apiAccess.createServicePrincipal({
    clientInstanceId,
    displayLabel: WORKFLOW_RUNNER
  });
  if (!modules || !workflows) throw new Error("The instance did not build its server");
  const served = modules;
  const built = workflows;
  const worker: WorkflowFixture["worker"] = (handlers) => {
    const created = createJobWorker({
      stores: t.stores,
      clientInstanceId,
      handlers: handlers ?? built.jobHandlers,
      modules: served,
      logger: silent
    });
    workers.push(created);
    return created;
  };
  const closeInstance = t.instance.close.bind(t.instance);
  t.instance.close = async () => {
    await Promise.all(workers.map((created) => created.stop()));
    await closeInstance();
  };
  let own: JobWorker | undefined;
  return {
    ...t,
    workflows: built,
    principal,
    worker,
    async finish(runId, given) {
      const jobs = given ?? (own ??= worker());
      for (let pass = 0; pass < 200; pass++) {
        await jobs.runDue();
        const response = await t.call(t.root.id, "workflows.get_run", { params: { runId } });
        const run = runSchema.parse(response.json());
        if (!["queued", "running", "waiting"].includes(run.status)) return run;
      }
      throw new Error(`Workflow Run ${runId} did not end`);
    },
    async allow(holder, action) {
      await t.stores.access.createGrant({
        clientInstanceId,
        holderKind: holder.kind,
        holderId: holder.id,
        action,
        effect: "allow",
        scopeKind: "instance",
        grantedBy: t.admin.id
      });
    },
    seedCrm: () =>
      t.seed("crm", {
        operations: [
          operationOf("echo", { exposure: ["workflow"] }),
          operationOf("write", { effect: "changing", exposure: ["workflow"] })
        ]
      })
  };
}
