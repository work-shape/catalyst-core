import { createNotices, registerMailSendOperation } from "@work-shape/catalyst-server";
import {
  CaptureMailTransport,
  TemplateMailSender,
  type MailSenderIdentity,
  type MailTransport
} from "@work-shape/catalyst-mail";
import { StoreBackedAuditRecorder } from "@work-shape/catalyst-core";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  createInstanceWorkflows,
  createJobWorker,
  createWorkflowAssetKind,
  resolveInstanceModules,
  workflowLimitCeilingsOf,
  type InstanceWorkflows,
  type InstanceWorkflowsParts
} from "@work-shape/catalyst-client-assembly";
import type {
  JobControl,
  JobSchedule,
  JobWorker,
  Logger,
  ModuleSnapshot,
  PlatformEventEmitter,
  PlatformStores,
  OperationRegistry,
  RegisteredJobHandler,
  ServicePrincipalRecord,
  WorkflowManifest
} from "@work-shape/catalyst-core";
import {
  createWorkflowFolderSource,
  parseWorkflowManifest,
  workflowDefinitionRefusal,
  workflowManifestFingerprint,
  type WorkflowDefinitionRevision,
  type WorkflowLimitCeilings,
  type WorkflowDefinitionSource
} from "@work-shape/catalyst-workflows";
import { clientInstanceId, setupAccessInstance } from "./access-instance";
import { fixtureOn, operationOf, type ConnectionOperationsFixture } from "./connection-operations";
import { personalKeyServer } from "./personal-api-keys";

// The instance behind the tests of the Workflow engine: the instance of the Connection
// tests with the module `workflows` on, the engine on its call path, and definitions read
// from the fixture folders or from what a test publishes. The engine is built here as the
// seam of the module builds it, with the definitions of the test in place of none: its port
// goes to the server and its handlers to a job worker.

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
  definitionRevisionId: z.string(),
  stepRunCount: z.number(),
  principal: z.object({ id: z.string(), name: z.string(), displayLabel: z.string() }),
  startedBy: z.object({ kind: z.string(), id: z.string(), label: z.string() }),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      action: z.string().optional(),
      connection: z.string().optional(),
      connectionTitle: z.string().optional(),
      stepRunId: z.string().optional()
    })
    .optional(),
  outputPreview: z.object({ text: z.string(), truncated: z.boolean() }).optional(),
  cancelledBy: z.string().optional(),
  cancelledAt: z.string().optional(),
  finishedAt: z.string().optional(),
  dataPrunedAt: z.string().optional()
});
const countsSchema = z.object({
  total: z.number(),
  done: z.number(),
  failed: z.number(),
  running: z.number()
});
export const stepRunsSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      stepId: z.string(),
      key: z.string(),
      status: z.string(),
      attempt: z.number(),
      containerStepRunId: z.string().optional(),
      branch: z.string().optional(),
      iteration: z.object({ index: z.number(), label: z.string().optional() }).optional(),
      loop: countsSchema.optional(),
      concurrency: z.object({ asked: z.number(), ranWith: z.number() }).optional(),
      bodyCounts: z.record(z.string(), countsSchema).optional(),
      effect: z.string().optional(),
      source: z.string().optional(),
      target: z.string().optional(),
      publishedWouldAsk: z.string().optional(),
      operationRunId: z.string().optional(),
      error: z
        .object({
          code: z.string(),
          message: z.string(),
          action: z.string().optional(),
          connection: z.string().optional(),
          connectionTitle: z.string().optional()
        })
        .optional(),
      inputPreview: z.object({ text: z.string(), truncated: z.boolean() }).optional(),
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
 * Definitions a test publishes and changes while it runs: what the asset kind of Workflows
 * will be to the engine. `publish` checks a definition as a save and a publish do and refuses
 * what they refuse; `hold` puts one in place unchecked, as a later release may have stored it.
 */
export function publishedDefinitions() {
  const held = new Map<string, WorkflowDefinitionRevision>();
  const source: WorkflowDefinitionSource = {
    read: (id) => Promise.resolve(held.get(id)),
    list: (page) =>
      Promise.resolve(
        [...held.values()]
          .map(({ manifest: { id, name } }) => ({ id, name }))
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
          .filter(({ id }) => typeof page?.after?.[0] !== "string" || id > page.after[0])
          .slice(0, page?.limit ?? 200)
      )
  };
  return {
    source,
    /** Answers the id of the revision that is now the published one. */
    publish(value: unknown): string {
      const result = parseWorkflowManifest(value);
      if (!result.ok) throw workflowDefinitionRefusal("unpublished", result.issues);
      const revisionId = workflowManifestFingerprint(result.manifest);
      held.set(result.manifest.id, { revisionId, manifest: result.manifest });
      return revisionId;
    },
    hold(manifest: WorkflowManifest, revisionId: string): void {
      held.set(manifest.id, { revisionId, manifest });
    }
  };
}

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
  /**
   * The service principal the fixture Workflows run as. It holds no grant at first; a test
   * gives it what its Workflow calls through `allow`.
   */
  principal: ServicePrincipalRecord;
  /** A job worker that serves the engine's handlers, or the ones given in their place. */
  worker(handlers?: readonly RegisteredJobHandler[], schedules?: readonly JobSchedule[]): JobWorker;
  /**
   * Runs what is due until the run has ended. Returns the run as the root reads it. One pass
   * executes one step of a run, so a long loop is given more passes than the 200 a run gets.
   */
  finish(runId: string, worker?: JobWorker, passes?: number): Promise<z.infer<typeof runSchema>>;
  /**
   * Lets a holder do an action on everything of the instance. The grant is written to the
   * store as it is, and the engine asks the real rights check: the administration of grants
   * writes a row for one asset or a Namespace and none for the whole instance. What it writes
   * for a Workflow and for a principal is in `workflow-rights-grants.test.ts`.
   */
  allow(holder: { kind: "user" | "service_principal"; id: string }, action: string): Promise<void>;
  /** Stores the Connection `crm` with `echo` and `write` exposed to Workflows. */
  seedCrm(): Promise<string>;
  /** What the capture transport holds, where outbound mail is on and no transport was given. */
  capturedMail(): ReturnType<CaptureMailTransport["list"]>;
}

/** The system sender of the fixture's outbound mail. */
const MAIL_IDENTITY: MailSenderIdentity = {
  fromAddress: "catalyst@mail.example.test",
  fromName: "Example Catalyst",
  productName: "Example Catalyst",
  frame: { accentColor: "#123456", footer: { en: "Example GmbH\nMusterstrasse 1" } }
};

export async function workflowFixture(
  options: {
    runnerPackages?: Parameters<typeof createWorkflowAssetKind>[0]["runnerPackages"];
    moduleOn?: boolean;
    connectorCatalog?: import("@work-shape/catalyst-core").ConnectorOperationDescriptor[];
    datasetObjects?: InstanceWorkflowsParts["datasetObjects"];
    datasetLimits?: InstanceWorkflowsParts["datasetLimits"];
    stepSlots?: number;
    limits?: InstanceWorkflowsParts["limits"];
    /** The ceilings of release config, over the release's own for what is left out. */
    ceilings?: Partial<WorkflowLimitCeilings>;
    /**
     * In place of the fixture folders. `assets` is what an instance has: the kind `workflow`
     * is registered and the engine reads the published revisions of its assets.
     */
    definitions?: WorkflowDefinitionSource | "assets";
    /** The clock of the engine and the time zone of its schedules, for a test of due times. */
    now?: InstanceWorkflowsParts["now"];
    timeZone?: string;
    /** `localization.defaultLocale`: the language of the notices the engine writes itself. */
    locale?: InstanceWorkflowsParts["locale"];
    /** The files of the Workflows' revisions, and what runs the scripts of code steps. */
    stepFiles?: InstanceWorkflowsParts["stepFiles"];
    codeRunner?: InstanceWorkflowsParts["codeRunner"];
    /** For the job that removes run data: the days a run keeps its values, and batch sizes. */
    stepDataDays?: number;
    pruneBatch?: InstanceWorkflowsParts["pruneBatch"];
    /** The events of the call path, such as one whose guardrails run. */
    events?: (stores: PlatformStores) => PlatformEventEmitter;
    /** Personal API keys on: a request with an access token acts as the key's owner. */
    personalKeys?: true;
    /** Module needed to project platform asset tools through the real agent runner. */
    publishTool?: true;
    /**
     * Outbound mail on: `mail.send` with the system sender, its mails rendered in the frame and
     * handed to the transport given, a capture where none is.
     */
    mail?: {
      recipientDomains: readonly string[];
      transport?: MailTransport;
      /** `outbound.limits`; the contract's defaults where unset. */
      limits?: { perWorkflowPerHour: number; perInstancePerDay: number };
    };
  } = {}
): Promise<WorkflowFixture> {
  let workflows: InstanceWorkflows | undefined;
  let modules: ModuleSnapshot | undefined;
  const workers: JobWorker[] = [];
  const fromAssets = options.definitions === "assets";
  const given = options.definitions === "assets" ? undefined : options.definitions;
  // The kind asks the principals of the instance and their rights, whose stores exist once it
  // is set up.
  let instanceStores: PlatformStores | undefined;
  let operationRegistry: OperationRegistry | undefined;
  const storesOf = () => {
    if (!instanceStores) throw new Error("The instance is not set up");
    return instanceStores;
  };
  const ceilings = { ...workflowLimitCeilingsOf(), ...options.ceilings };
  const kind = createWorkflowAssetKind({
    clientInstanceId,
    registry: () => operationRegistry,
    runnerPackages: options.runnerPackages ?? [],
    limits: { ceilings, stepSlots: options.stepSlots ?? 4 },
    configAssets: {
      getConfigAsset: (input) => storesOf().configAssets.getConfigAsset(input),
      listPublishedConfigAssets: (input) => storesOf().configAssets.listPublishedConfigAssets(input)
    },
    apiAccess: {
      findServicePrincipalByName: (input) => storesOf().apiAccess.findServicePrincipalByName(input),
      findServicePrincipalByOwner: (input) =>
        storesOf().apiAccess.findServicePrincipalByOwner(input)
    },
    access: {
      loadPersistedAccess: (input) => storesOf().access.loadPersistedAccess(input),
      listGrantScopeAssets: (input) => storesOf().access.listGrantScopeAssets(input)
    },
    ...(options.now ? { now: options.now } : {}),
    ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
    ...(options.mail
      ? { mailSend: { registered: true, recipientDomains: options.mail.recipientDomains } }
      : {})
  });
  const capture = new CaptureMailTransport();
  const mailTransport = options.mail?.transport ?? capture;
  const t = await fixtureOn(
    (connectionOptions) =>
      setupAccessInstance({
        ...connectionOptions,
        furtherKinds: [...(connectionOptions.furtherKinds ?? []), ...(fromAssets ? [kind] : [])],
        modules: {
          ...connectionOptions.modules,
          ...(options.publishTool
            ? { assetManagement: { enabled: true }, apps: { enabled: true } }
            : {}),
          ...(options.moduleOn === false ? {} : { workflows: { enabled: true } }),
          ...(options.personalKeys ? { personalApiKeys: { enabled: true } } : {})
        },
        server(stores, config, kinds) {
          const server = {
            ...connectionOptions.server?.(stores, config, kinds),
            ...(options.personalKeys ? personalKeyServer(stores) : {}),
            ...(options.mail ? { mailSenders: ["system"] } : {})
          };
          if (!server.operationCalls) throw new Error("The instance built no call path");
          if (options.mail)
            registerMailSendOperation(server.operationCalls.registry, {
              clientInstanceId,
              stores,
              sender: new TemplateMailSender(mailTransport, MAIL_IDENTITY),
              system: { fromAddress: MAIL_IDENTITY.fromAddress, fromName: MAIL_IDENTITY.fromName },
              recipientDomains: options.mail.recipientDomains,
              ...(options.mail.limits ? { limits: options.mail.limits } : {}),
              ...(options.now ? { now: options.now } : {}),
              defaultLocale: "en"
            });
          operationRegistry = server.operationCalls.registry;
          modules = resolveInstanceModules(config, []).snapshot;
          instanceStores = stores;
          workflows = createInstanceWorkflows({
            modules,
            ...(options.datasetObjects ? { datasetObjects: options.datasetObjects } : {}),
            ...(options.datasetLimits ? { datasetLimits: options.datasetLimits } : {}),
            clientInstanceId,
            stores,
            notices: (tx) =>
              createNotices({
                clientInstanceId,
                stores: tx,
                auditRecorder: new StoreBackedAuditRecorder({ clientInstanceId, store: tx.audit })
              }),
            operationCalls: server.operationCalls,
            ...(options.stepSlots === undefined ? {} : { stepSlots: options.stepSlots }),
            ceilings,
            ...(fromAssets ? {} : { definitions: given ?? fixtureDefinitions() }),
            ...(options.limits ? { limits: options.limits } : {}),
            ...(options.now ? { now: options.now } : {}),
            ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
            ...(options.locale ? { locale: options.locale } : {}),
            ...(options.stepFiles ? { stepFiles: options.stepFiles } : {}),
            ...(options.codeRunner ? { codeRunner: options.codeRunner } : {}),
            ...(options.stepDataDays === undefined ? {} : { stepDataDays: options.stepDataDays }),
            ...(options.pruneBatch ? { pruneBatch: options.pruneBatch } : {})
          });
          return server;
        },
        // What the assembly does with the routes of a module: they follow the server's own.
        register(route) {
          for (const register of workflows?.routes ?? []) register(route);
        }
      }),
    {
      ...(options.events ? { events: options.events } : {}),
      ...(options.connectorCatalog ? { catalog: options.connectorCatalog } : {})
    }
  );
  const principal = await t.stores.apiAccess.createServicePrincipal({
    clientInstanceId,
    displayLabel: WORKFLOW_RUNNER
  });
  if (!modules || !workflows) throw new Error("The instance did not build its server");
  const served = modules;
  const built = workflows;
  const worker: WorkflowFixture["worker"] = (handlers, schedules) => {
    const created = createJobWorker({
      stores: t.stores,
      clientInstanceId,
      handlers: handlers ?? built.jobHandlers,
      ...(schedules ? { schedules } : {}),
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
    capturedMail: () => capture.list(),
    worker,
    async finish(runId, given, passes = 200) {
      const jobs = given ?? (own ??= worker());
      for (let pass = 0; pass < passes; pass++) {
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
