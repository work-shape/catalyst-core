import { createHash } from "node:crypto";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  JOB_UNCLAIMED_MS,
  JOB_WORKER_CHECK_INTERVAL_MS,
  TOOL_ASSET_KIND,
  TOOL_CODE_CALL_KEEP_MS,
  TOOL_RESULT_KIND_PATTERN,
  createPlatformId,
  defineJobHandler,
  defineJobKind,
  defineSchedule,
  isJsonObject,
  isOperationTimeout,
  noWorkerTakesJobs,
  scheduledJobPayloadSchema,
  subjectDedupeKey,
  toolAssetConfigSchema,
  unknownToJsonValue,
  type ClientInstanceId,
  type CodeToolConfig,
  type ConfigAssetStore,
  type ConversationId,
  type JobSchedule,
  type JsonObject,
  type PlatformStores,
  type RegisteredJobHandler,
  type ToolCodeCallOutcome,
  type ToolHandlerResult
} from "@work-shape/catalyst-core";
import {
  WORKSPACE_COMMAND_NO_WORKER_MESSAGE,
  prepareVisualizationHtml,
  type SandboxCommandLimits,
  type WorkspaceCommandProcessExecutor
} from "@work-shape/catalyst-tool-execution";
import {
  WORKFLOW_CODE_ERRORS,
  createCodeSandbox,
  type WorkflowSourceTree,
  type WorkflowStepFiles
} from "@work-shape/catalyst-workflows";
import { z } from "zod";

// Where a code tool runs (TOOL-2b, platform-access.md, section 3a). A call is a row the
// operation writes and a job the command worker serves: the worker runs the tool's handler in
// the sandbox of Workflow code steps (no network, a read-only root, no capability, an empty
// environment, limits of time, memory and processes), writes how it ended on the row, and the
// operation, which polls the row, reads it and removes the row. Nothing of the tool runs in the
// process that called it.
//
// The handler's contract is the code step's: its input as JSON on its input stream and in the
// file `$WORKFLOW_INPUT_FILE`; its answer as JSON on its output stream or in the file
// `$WORKFLOW_OUTPUT_FILE`.

/** The job that runs one call's handler on the command worker. */
export const TOOL_CODE_CALL_JOB_KIND = "tool.run_code";
/** The job that removes what a killed worker left of calls: rows, directories, containers. */
export const TOOL_CODE_SWEEP_JOB_KIND = "tool.sweep_code";

const toolCodeCallJob = defineJobKind({
  kind: TOOL_CODE_CALL_JOB_KIND,
  payloadSchema: z.strictObject({ callId: z.string().min(1) }),
  // A container that could not be started is tried again; a handler that ended is not.
  maxAttempts: 3,
  backoff: { baseMs: 500, maxMs: 2_000 },
  leaseMs: 60_000,
  heartbeatMs: 15_000,
  concurrency: {}
});

const toolCodeSweepJob = defineJobKind({
  kind: TOOL_CODE_SWEEP_JOB_KIND,
  payloadSchema: scheduledJobPayloadSchema,
  maxAttempts: 1,
  backoff: { baseMs: 0, maxMs: 0 },
  leaseMs: 2 * 60 * 1_000,
  concurrency: { global: 1 },
  manualRetry: false
});

const toolCodeSweepSchedule: JobSchedule = defineSchedule({
  kind: toolCodeSweepJob,
  every: 10 * 60 * 1_000,
  dueAtStart: true
});

/** How many handlers of code tools one command worker runs at once. */
export const TOOL_CODE_CALL_SLOTS = 2;

/** How large a handler's answer may be, as JSON in UTF-8: what it hands the model and a display. */
export const TOOL_CODE_ANSWER_MAX_BYTES = 512 * 1024;
/** How much of a handler's error stream a failed call names, from its end. */
const STDERR_TAIL_BYTES = 400;
/** What the names of a call's directory and container start with. */
const COMMAND_ID_PREFIX = "tool-call-";
/** How often a running handler's job looks whether its call is still waited for. */
const CANCEL_CHECK_MS = 1_000;
/** How long a run that ended is kept beside the longest a handler may run, for the sweep. */
const LEFTOVER_AGE_MS = 2 * 120 * 1_000 + 60_000;

/** The published revision of a code tool, or nothing where the revision is gone or no code. */
async function codeToolRevision(
  configAssets: Pick<ConfigAssetStore, "getConfigAssetRevisionById">,
  clientInstanceId: ClientInstanceId,
  tool: string,
  revisionId: string
): Promise<CodeToolConfig | undefined> {
  const revision = await configAssets.getConfigAssetRevisionById({
    clientInstanceId,
    kind: TOOL_ASSET_KIND,
    name: tool,
    revisionId
  });
  const parsed = toolAssetConfigSchema.safeParse(revision?.config);
  return parsed.success && parsed.data.type === "code" ? parsed.data : undefined;
}

/** A code tool's files as the tree the sandbox copies, named by their content. */
function toolTree(tool: CodeToolConfig): WorkflowSourceTree {
  const files = tool.files.map((file) => ({
    path: file.path,
    bytes: new TextEncoder().encode(file.content)
  }));
  const index = files
    .map(({ path, bytes }) => ({
      path,
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex")
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    hash: createHash("sha256")
      .update(JSON.stringify({ tool: index }))
      .digest("hex"),
    files: files.map(({ path, bytes }) => ({ path, bytes: bytes.byteLength })),
    readFile: async (path) => files.find((file) => file.path === path)?.bytes
  };
}

/**
 * The files of code tools, read from the revision a call names. The sandbox reads them as it
 * reads a Workflow's tree: `workflow` is the tool's name here.
 */
export function createToolCodeFiles(options: {
  clientInstanceId: ClientInstanceId;
  configAssets: Pick<ConfigAssetStore, "getConfigAssetRevisionById">;
}): WorkflowStepFiles {
  return {
    async readTree({ workflow, revisionId }) {
      const tool = await codeToolRevision(
        options.configAssets,
        options.clientInstanceId,
        workflow,
        revisionId
      );
      return tool && toolTree(tool);
    }
  };
}

/** The last bytes of what a handler wrote to its error stream, for a failed call's message. */
function stderrTail(text: string): string {
  const bytes = Buffer.from(text.trim(), "utf8");
  if (bytes.byteLength === 0) return "";
  const tail =
    bytes.byteLength <= STDERR_TAIL_BYTES
      ? bytes.toString("utf8")
      : `…${bytes.subarray(bytes.byteLength - STDERR_TAIL_BYTES).toString("utf8")}`;
  return `\nIts error stream ends with:\n${tail}`;
}

export interface ToolCodeCallJobsOptions {
  clientInstanceId: ClientInstanceId;
  stores: PlatformStores;
  sandbox: WorkspaceCommandProcessExecutor;
  /** Where calls' directories are made, below the worker's temp root. */
  tempRoot: string;
  /** How many handlers this worker runs at once. */
  slots: number;
  /** What one handler's container gets: the limits of a code step. */
  limits: SandboxCommandLimits;
  /** For a test: in place of a second. */
  cancelCheckMs?: number;
}

/** What the command worker serves for code tools, and what it runs by itself. */
export function createToolCodeCallJobs(options: ToolCodeCallJobsOptions): {
  handlers: RegisteredJobHandler[];
  schedules: JobSchedule[];
} {
  const { clientInstanceId, stores } = options;
  const { run, sweep } = createCodeSandbox({
    sandbox: options.sandbox,
    // A directory of its own, so the sweep of code steps and this one never meet.
    tempRoot: join(options.tempRoot, "catalyst-tool-calls"),
    limits: options.limits,
    outputMaxBytes: TOOL_CODE_ANSWER_MAX_BYTES,
    stepFiles: createToolCodeFiles({ clientInstanceId, configAssets: stores.configAssets }),
    commandIdPrefix: COMMAND_ID_PREFIX
  });

  const finish = (id: string, outcome: ToolCodeCallOutcome) =>
    stores.toolCodeCalls.finishToolCodeCall({
      clientInstanceId,
      id,
      outcome,
      finishedAt: new Date().toISOString()
    });
  const failed = (code: string, message: string): ToolCodeCallOutcome => ({
    kind: "failed",
    error: { code, message }
  });

  return {
    handlers: [
      defineJobHandler({
        kind: toolCodeCallJob,
        slots: options.slots,
        async run(job, control) {
          const id = job.payload.callId;
          const call = await stores.toolCodeCalls.getToolCodeCall({ clientInstanceId, id });
          // The operation gave up on the call, or an earlier attempt ended it.
          if (!call || call.outcome) return;
          const tool = await codeToolRevision(
            stores.configAssets,
            clientInstanceId,
            call.tool,
            call.revisionId
          );
          if (!tool) {
            await finish(
              id,
              failed(WORKFLOW_CODE_ERRORS.fileMissing, "The tool's revision holds no handler")
            );
            return;
          }
          // The container ends with the attempt, and once nobody waits for the call.
          const stop = new AbortController();
          const stopped = () => stop.abort(control.signal.reason);
          control.signal.addEventListener("abort", stopped, { once: true });
          let over = false;
          const watch = async (): Promise<void> => {
            while (!over && !stop.signal.aborted) {
              await sleep(options.cancelCheckMs ?? CANCEL_CHECK_MS);
              if (over) return;
              const still = await stores.toolCodeCalls
                .getToolCodeCall({ clientInstanceId, id })
                .catch(() => call);
              if (!still || still.outcome) stop.abort(new Error("Nobody waits for the call"));
            }
          };
          watch().catch(() => undefined);
          let result;
          try {
            result = await run({
              id,
              staged: {
                language: tool.runtime,
                file: tool.entry,
                tree: {
                  workflow: call.tool,
                  revisionId: call.revisionId,
                  hash: toolTree(tool).hash
                },
                input: call.input,
                timeoutSeconds: call.timeoutSeconds
              },
              signal: stop.signal
            });
          } finally {
            over = true;
            control.signal.removeEventListener("abort", stopped);
          }
          if (control.signal.aborted) {
            throw control.signal.reason instanceof Error
              ? control.signal.reason
              : new Error("The attempt was stopped");
          }
          if (result.kind === "stopped") return;
          if (result.kind === "notStarted") {
            throw new Error(`The sandbox could not start the container: ${result.reason}`);
          }
          const { outcome, log } = result;
          await finish(
            id,
            outcome.kind === "output"
              ? { kind: "answered", value: outcome.value }
              : failed(
                  outcome.error.code,
                  outcome.error.code === WORKFLOW_CODE_ERRORS.failed
                    ? `${outcome.error.message.replace("script", "handler")}${stderrTail(log.stderr)}`
                    : outcome.error.message.replace("script", "handler")
                )
          );
        },
        async onExhausted(job, tx) {
          await tx.toolCodeCalls.finishToolCodeCall({
            clientInstanceId,
            id: job.payload.callId,
            outcome: failed(
              WORKFLOW_CODE_ERRORS.runnerUnavailable,
              `The sandbox could not run the handler in ${job.maxAttempts} attempts`
            ),
            finishedAt: new Date().toISOString()
          });
        }
      }),
      defineJobHandler({
        kind: toolCodeSweepJob,
        slots: 1,
        async run() {
          await sweep(LEFTOVER_AGE_MS);
          await stores.toolCodeCalls.pruneToolCodeCalls({
            clientInstanceId,
            before: new Date(Date.now() - TOOL_CODE_CALL_KEEP_MS).toISOString()
          });
        }
      })
    ],
    schedules: [toolCodeSweepSchedule]
  };
}

/** How one call ended, as the operation that waited for it reads it. */
export type ToolCodeCallResult =
  | { status: "ended"; outcome: ToolCodeCallOutcome }
  /** It did not end before the wait ran out: the handler's time or the agent's deadline. */
  | { status: "timed_out" }
  /** The agent's run was cancelled. */
  | { status: "cancelled" }
  /** No worker took the call: the platform runs no sandbox now. */
  | { status: "no_worker" };

export interface ToolCodeCallClient {
  run(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    tool: string;
    revisionId: string;
    input: JsonObject;
    timeoutSeconds: number;
    correlationId: string;
    /** The agent's tool deadline, where it has one. */
    deadline?: Date;
    signal?: AbortSignal;
  }): Promise<ToolCodeCallResult>;
}

/**
 * How long a call waits beside its handler's time: for a worker to take the job and start the
 * container.
 */
export const TOOL_CODE_START_GRACE_MS = 10_000;
const POLL_MS = 200;

/** Writes a call and its job, and waits for the call's outcome on its row. */
export function createToolCodeCallClient(options: {
  stores: Pick<PlatformStores, "toolCodeCalls" | "jobs" | "transaction">;
  pollMs?: number;
  /** For a test: in place of `JOB_UNCLAIMED_MS`. */
  unclaimedMs?: number;
}): ToolCodeCallClient {
  const { stores } = options;
  const pollMs = options.pollMs ?? POLL_MS;
  const unclaimedMs = options.unclaimedMs ?? JOB_UNCLAIMED_MS;
  return {
    async run(input) {
      const { clientInstanceId } = input;
      const id = createPlatformId("tcc");
      const dedupeKey = subjectDedupeKey(toolCodeCallJob.kind, id);
      await stores.transaction(async (tx) => {
        await tx.toolCodeCalls.createToolCodeCall({
          id,
          clientInstanceId,
          conversationId: input.conversationId,
          tool: input.tool,
          revisionId: input.revisionId,
          input: input.input,
          timeoutSeconds: input.timeoutSeconds,
          createdAt: new Date().toISOString()
        });
        await tx.jobs.enqueue(
          toolCodeCallJob,
          { callId: id },
          { clientInstanceId, subject: id, dedupeKey, correlationId: input.correlationId }
        );
      });
      // The row goes once the wait has ended, whatever ended it: a worker that still runs the
      // handler finds it gone and stops the container.
      const giveUp = async () => {
        await stores.toolCodeCalls.removeToolCodeCall({ clientInstanceId, id });
        await stores.jobs.withdraw(toolCodeCallJob, { clientInstanceId, dedupeKey });
      };
      const started = Date.now();
      const until = Math.min(
        started + input.timeoutSeconds * 1_000 + TOOL_CODE_START_GRACE_MS,
        input.deadline?.getTime() ?? Number.POSITIVE_INFINITY
      );
      let nextWorkerCheck = started + unclaimedMs;
      try {
        while (true) {
          if (input.signal?.aborted)
            return isOperationTimeout(input.signal)
              ? { status: "timed_out" }
              : { status: "cancelled" };
          if (Date.now() >= until) return { status: "timed_out" };
          await sleep(Math.max(1, Math.min(pollMs, until - Date.now())), undefined, {
            ...(input.signal ? { signal: input.signal } : {})
          }).catch(() => undefined);
          if (input.signal?.aborted) continue;
          const call = await stores.toolCodeCalls.getToolCodeCall({ clientInstanceId, id });
          if (call?.outcome) return { status: "ended", outcome: call.outcome };
          // The row went with its conversation.
          if (!call) return { status: "cancelled" };
          if (Date.now() >= nextWorkerCheck) {
            nextWorkerCheck = Date.now() + JOB_WORKER_CHECK_INTERVAL_MS;
            if (
              await noWorkerTakesJobs(stores.jobs, {
                clientInstanceId,
                kind: toolCodeCallJob,
                unclaimedMs
              }).catch(() => false)
            )
              return { status: "no_worker" };
          }
        }
      } finally {
        await giveUp().catch(() => undefined);
      }
    }
  };
}

/** How large what the model is handed of an answer may be, as JSON in UTF-8. */
export const TOOL_CODE_OUTPUT_MAX_BYTES = 64 * 1024;
/** How long a display's HTML may be: what `show_view` takes. */
export const TOOL_CODE_HTML_MAX_CHARS = 200_000;

const dataDisplaySchema = z.strictObject({
  type: z.literal("data"),
  kind: z
    .string()
    .max(120)
    .regex(
      TOOL_RESULT_KIND_PATTERN,
      "A display kind is lowercase words joined by '.', '_' or '-', such as review.document_check"
    ),
  title: z.string().trim().min(1).max(120),
  data: z.record(z.string(), z.unknown()),
  schemaVersion: z.number().int().min(1).max(1_000).optional()
});

const htmlDisplaySchema = z.strictObject({
  type: z.literal("html"),
  title: z.string().trim().min(1).max(160).optional(),
  html: z.string().min(1).max(TOOL_CODE_HTML_MAX_CHARS)
});

/** What a handler answers: `output` for the model, and at most one display beside the chat. */
const toolCodeAnswerSchema = z
  .strictObject({
    output: z.unknown(),
    display: z.discriminatedUnion("type", [dataDisplaySchema, htmlDisplaySchema]).optional()
  })
  .superRefine((answer, context) => {
    if (answer.output === undefined) {
      context.addIssue({ code: "custom", path: ["output"], message: "The answer has no output" });
      return;
    }
    const bytes = Buffer.byteLength(JSON.stringify(answer.output), "utf8");
    if (bytes > TOOL_CODE_OUTPUT_MAX_BYTES) {
      context.addIssue({
        code: "custom",
        path: ["output"],
        message: `The output has ${bytes} bytes as JSON; a tool hands the model at most ${TOOL_CODE_OUTPUT_MAX_BYTES}`
      });
    }
  });

/** What a call answers the agent: the handler's output, and its display beside the chat. */
export function toolCodeCallAnswer(input: {
  tool: string;
  timeoutSeconds: number;
  result: ToolCodeCallResult;
  /** Whether the conversation holds personal data: its HTML display then runs no script. */
  personal: boolean;
}): ToolHandlerResult {
  const { tool, result } = input;
  const failure = (code: string, message: string): ToolHandlerResult => ({
    status: "failed",
    error: { code: "handler_failed", message, details: { reason: code } }
  });
  const timedOut: ToolHandlerResult = {
    status: "timed_out",
    error: {
      code: "timed_out",
      message: `The tool '${tool}' did not answer within ${input.timeoutSeconds} seconds and was stopped.`
    }
  };
  if (result.status === "timed_out") return timedOut;
  if (result.status === "cancelled") {
    return {
      status: "cancelled",
      error: { code: "cancelled", message: `The call of the tool '${tool}' was cancelled.` }
    };
  }
  if (result.status === "no_worker") {
    return failure("no_worker", WORKSPACE_COMMAND_NO_WORKER_MESSAGE);
  }
  const { outcome } = result;
  if (outcome.kind === "failed") {
    if (outcome.error.code === WORKFLOW_CODE_ERRORS.timeout) return timedOut;
    return failure(
      outcome.error.code,
      `The handler of the tool '${tool}' failed: ${outcome.error.message}`
    );
  }
  const parsed = toolCodeAnswerSchema.safeParse(outcome.value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? ` at '${issue.path.join(".")}'` : "";
    return failure(
      "tool_answer_invalid",
      `The handler of the tool '${tool}' answered with no valid answer${where}: ${issue?.message ?? "invalid"}. A handler answers one JSON object { "output": ..., "display"?: { "type": "data" | "html", ... } }.`
    );
  }
  const { output, display } = parsed.data;
  if (display?.type === "data") {
    return {
      status: "success",
      output,
      structuredResult: {
        key: tool,
        kind: display.kind,
        schemaVersion: display.schemaVersion ?? 1,
        title: display.title,
        data: jsonObjectOf(display.data)
      }
    };
  }
  if (display?.type === "html") {
    const displayId = createPlatformId<"ToolDisplayId">("display");
    // As `show_view` stores it: the HTML alone; the interface composes the frame, its content
    // policy and its runtime each time it shows the view.
    return {
      status: "success",
      output,
      display: {
        kind: input.personal ? "private_hydrated_view" : "html.rendered",
        version: 2,
        mode: "inline",
        displayId,
        ...(display.title ? { title: display.title } : {}),
        data: {
          html: prepareVisualizationHtml(display.html),
          ...(display.title ? { title: display.title } : {})
        }
      }
    };
  }
  return { status: "success", output };
}

function jsonObjectOf(value: unknown): JsonObject {
  const json = unknownToJsonValue(value);
  return isJsonObject(json) ? json : {};
}
