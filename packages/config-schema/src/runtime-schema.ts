import { WORKFLOW_PAGING_DEFAULTS } from "@work-shape/catalyst-core";
import { z } from "zod";
import { workflowDurationSchema } from "@work-shape/catalyst-core";

export const conversationTitleConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    modelProviderId: z.string().min(1).optional(),
    modelBindingId: z.string().min(1).optional(),
    model: z.string().min(1).optional()
  })
  .default({
    enabled: true
  });

export const agentRuntimeConfigSchema = z
  .object({
    maxSteps: z.number().int().positive().default(64),
    repeatedToolCallLimit: z.number().int().positive().default(3),
    /** How long a run waits for its agent's data tools to be read. See the agent runtime. */
    dataToolDescribeTimeoutMs: z.number().int().positive().default(10_000)
  })
  .default({
    maxSteps: 64,
    repeatedToolCallLimit: 3,
    dataToolDescribeTimeoutMs: 10_000
  });

export const modelContextConfigSchema = z
  .object({
    toolOutput: z
      .object({
        maxTokens: z.number().int().positive().default(60000),
        maxBytes: z.number().int().positive().optional()
      })
      .default({
        maxTokens: 60000
      })
  })
  .default({
    toolOutput: {
      maxTokens: 60000
    }
  });

const REMOVED_WEB_SEARCH_KEYS = ["mode", "managedProvider"] as const;

/**
 * The instance switch for web search. The two keys that chose between a provider's own search
 * and a managed one are refused by name: a model's adapter declares whether it can search.
 * One issue names every removed key that is present, because startup reports the first issue.
 */
const webSearchConfigSchema = z.preprocess(
  (raw, context) => {
    if (typeof raw === "object" && raw !== null) {
      const present = REMOVED_WEB_SEARCH_KEYS.filter((key) => key in raw).map(
        (key) => `'webAccess.search.${key}'`
      );
      if (present.length > 0) {
        const several = present.length > 1;
        context.addIssue({
          code: "custom",
          message: `${present.join(" and ")} ${several ? "were" : "was"} removed: whether a model can search the web is declared by its provider, and 'webAccess.search.enabled' is the only switch. Delete the ${several ? "keys" : "key"}`
        });
      }
    }
    return raw;
  },
  z.object({ enabled: z.boolean().default(false) }).default({ enabled: false })
);

export const webAccessConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    search: webSearchConfigSchema,
    fetch: z
      .object({
        enabled: z.boolean().default(false),
        timeoutMs: z.number().int().positive().max(30000).default(10000),
        maxResponseBytes: z
          .number()
          .int()
          .positive()
          .max(5 * 1024 * 1024)
          .default(1024 * 1024),
        maxTextCharacters: z.number().int().positive().max(200000).default(20000),
        maxRedirects: z.number().int().nonnegative().max(10).default(5)
      })
      .default({
        enabled: false,
        timeoutMs: 10000,
        maxResponseBytes: 1024 * 1024,
        maxTextCharacters: 20000,
        maxRedirects: 5
      })
  })
  .default({
    enabled: false,
    search: {
      enabled: false
    },
    fetch: {
      enabled: false,
      timeoutMs: 10000,
      maxResponseBytes: 1024 * 1024,
      maxTextCharacters: 20000,
      maxRedirects: 5
    }
  });

/**
 * The sandbox of a Workflow's code step. A code step runs one script on the input its
 * Workflow hands it, so its container gets far less than the container of an agent's command
 * (`infrastructure.sandbox`): a script that needs more is a release's decision to raise here.
 * The command worker runs the containers, so these are limits of its host.
 */
export const workflowsConfigSchema = z
  .strictObject({
    /** Caps Workflow step jobs in each serving process; invalid values stop startup. */
    stepSlots: z.number().int().min(1).max(64).default(4),
    datasets: z
      .strictObject({
        pageBytes: z.number().int().positive().default(WORKFLOW_PAGING_DEFAULTS.pageBytes),
        pages: z.number().int().positive().default(WORKFLOW_PAGING_DEFAULTS.pages),
        rows: z.number().int().positive().default(5_000_000),
        bytes: z
          .number()
          .int()
          .positive()
          .default(2 * 1024 ** 3),
        rowBytes: z
          .number()
          .int()
          .positive()
          .default(256 * 1024),
        runBytes: z
          .number()
          .int()
          .positive()
          .default(10 * 1024 ** 3),
        instanceBytes: z
          .number()
          .int()
          .positive()
          .default(50 * 1024 ** 3)
      })
      .prefault({}),
    /**
     * The ceilings of a Workflow's `limits`: the most its `workflow.yaml` may set for each run.
     * A publish above one is refused, naming it. The defaults a Workflow runs under when it
     * sets nothing are the release's (12h, 20,000 step runs, 10,000 items per loop); the
     * ceiling of `limits.concurrency` is `stepSlots`.
     */
    limits: z
      .strictObject({
        duration: workflowDurationSchema.default("7d"),
        stepRuns: z.number().int().positive().default(1_000_000),
        loopItems: z.number().int().positive().default(1_000_000),
        datasetBytes: z
          .number()
          .int()
          .positive()
          .default(2 * 1024 * 1024 * 1024),
        pagedStepMinutes: z
          .number()
          .int()
          .positive()
          .default(WORKFLOW_PAGING_DEFAULTS.pagedStepMinutes)
      })
      .prefault({}),
    codeSteps: z
      .strictObject({
        /** How many code steps one command worker runs at once. */
        slots: z.number().int().positive().max(64).optional(),
        /** The memory of one code step's container, with no swap beyond it. */
        memoryBytes: z
          .number()
          .int()
          .min(64 * 1024 * 1024)
          .default(512 * 1024 * 1024),
        /** Half a core: four steps at once take two cores of the host at most. */
        cpuCount: z.number().positive().default(0.5),
        /** Room for an interpreter and its threads, and an end to a script that forks. */
        pidsLimit: z.number().int().positive().default(64),
        /** After this long a script is stopped and its step fails. */
        timeoutSeconds: z.number().int().positive().max(900).default(60),
        /**
         * The size of the script's working directory, which is memory and no disk: the
         * script, its input and its result of at most 256 KiB each, and room to work in. It
         * counts against `memoryBytes`, so it is part of that number and no number beside it.
         * A script that fills it reads "no space left".
         */
        scratchBytes: z
          .number()
          .int()
          .min(4 * 1024 * 1024)
          .default(64 * 1024 * 1024),
        /**
         * How much of the command worker's disk, not memory, one code step may take: the files
         * of its input datasets under `/work/in` and what its script writes to `/work/out`,
         * together. Input past it is not written; a script that writes past it is stopped.
         * Either way the step fails with `code_disk_limit`.
         */
        diskBytes: z
          .number()
          .int()
          .positive()
          .default(2 * 1024 ** 3)
      })
      .prefault({})
      .refine((codeSteps) => codeSteps.scratchBytes * 2 <= codeSteps.memoryBytes, {
        path: ["scratchBytes"],
        message:
          "scratchBytes is memory of the code step and at most half of memoryBytes: the script itself needs the rest"
      })
  })
  .prefault({})
  .transform((config) => ({
    ...config,
    codeSteps: { ...config.codeSteps, slots: config.codeSteps.slots ?? config.stepSlots }
  }));

export const executionWorkspacesConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    sourceFiles: z
      .object({
        maxFileBytes: z
          .number()
          .int()
          .positive()
          .default(25 * 1024 * 1024)
      })
      .default({
        maxFileBytes: 25 * 1024 * 1024
      }),
    command: z
      .object({
        defaultTimeoutSeconds: z.number().int().positive().default(60),
        maxTimeoutSeconds: z.number().int().positive().default(300),
        idleTimeoutSeconds: z.number().int().positive().default(30),
        maxStdoutBytes: z
          .number()
          .int()
          .positive()
          .default(64 * 1024),
        maxStderrBytes: z
          .number()
          .int()
          .positive()
          .default(64 * 1024),
        maxWorkspaceBytes: z
          .number()
          .int()
          .positive()
          .default(100 * 1024 * 1024)
      })
      .default({
        defaultTimeoutSeconds: 60,
        maxTimeoutSeconds: 300,
        idleTimeoutSeconds: 30,
        maxStdoutBytes: 64 * 1024,
        maxStderrBytes: 64 * 1024,
        maxWorkspaceBytes: 100 * 1024 * 1024
      }),
    worker: z
      .object({
        concurrency: z.number().int().positive().default(1),
        pollIntervalMs: z.number().int().positive().default(1000),
        leaseDurationMs: z
          .number()
          .int()
          .positive()
          .default(10 * 60 * 1000),
        heartbeatIntervalMs: z.number().int().positive().default(5000),
        cancellationPollIntervalMs: z.number().int().positive().default(1000),
        staleRecoveryIntervalMs: z.number().int().positive().default(30000),
        staleRecoveryLimit: z.number().int().positive().default(50)
      })
      .default({
        concurrency: 1,
        pollIntervalMs: 1000,
        leaseDurationMs: 10 * 60 * 1000,
        heartbeatIntervalMs: 5000,
        cancellationPollIntervalMs: 1000,
        staleRecoveryIntervalMs: 30000,
        staleRecoveryLimit: 50
      }),
    cleanup: z
      .object({
        deletedWorkspaceCleanupIntervalMs: z
          .number()
          .int()
          .positive()
          .default(60 * 60 * 1000),
        deletedWorkspaceCleanupBatchSize: z.number().int().positive().default(100),
        tempStateCleanupIntervalMs: z
          .number()
          .int()
          .positive()
          .default(10 * 60 * 1000),
        hydratedWorkspaceIdleTtlMs: z
          .number()
          .int()
          .nonnegative()
          .default(60 * 60 * 1000)
      })
      .default({
        deletedWorkspaceCleanupIntervalMs: 60 * 60 * 1000,
        deletedWorkspaceCleanupBatchSize: 100,
        tempStateCleanupIntervalMs: 10 * 60 * 1000,
        hydratedWorkspaceIdleTtlMs: 60 * 60 * 1000
      })
  })
  .superRefine((config, context) => {
    if (config.command.defaultTimeoutSeconds > config.command.maxTimeoutSeconds) {
      context.addIssue({
        code: "custom",
        path: ["command", "defaultTimeoutSeconds"],
        message: "Default workspace command timeout must not exceed the maximum timeout"
      });
    }
    if (config.worker.heartbeatIntervalMs >= config.worker.leaseDurationMs) {
      context.addIssue({
        code: "custom",
        path: ["worker", "heartbeatIntervalMs"],
        message: "Workspace command heartbeat interval must be shorter than the lease duration"
      });
    }
  })
  .default({
    enabled: false,
    sourceFiles: {
      maxFileBytes: 25 * 1024 * 1024
    },
    command: {
      defaultTimeoutSeconds: 60,
      maxTimeoutSeconds: 300,
      idleTimeoutSeconds: 30,
      maxStdoutBytes: 64 * 1024,
      maxStderrBytes: 64 * 1024,
      maxWorkspaceBytes: 100 * 1024 * 1024
    },
    worker: {
      concurrency: 1,
      pollIntervalMs: 1000,
      leaseDurationMs: 10 * 60 * 1000,
      heartbeatIntervalMs: 5000,
      cancellationPollIntervalMs: 1000,
      staleRecoveryIntervalMs: 30000,
      staleRecoveryLimit: 50
    },
    cleanup: {
      deletedWorkspaceCleanupIntervalMs: 60 * 60 * 1000,
      deletedWorkspaceCleanupBatchSize: 100,
      tempStateCleanupIntervalMs: 10 * 60 * 1000,
      hydratedWorkspaceIdleTtlMs: 60 * 60 * 1000
    }
  });
