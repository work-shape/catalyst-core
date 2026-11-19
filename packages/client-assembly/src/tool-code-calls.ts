import { createHash } from "node:crypto";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  JOB_UNCLAIMED_MS,
  JOB_WORKER_CHECK_INTERVAL_MS,
  TOOL_ASSET_KIND,
  TOOL_CODE_CALL_KEEP_MS,
  TOOL_CODE_LIBRARY,
  TOOL_CODE_REQUEST_ANSWER_MAX_BYTES,
  TOOL_CODE_REQUEST_MAX_BYTES,
  TOOL_CODE_REQUESTS_MAX,
  TOOL_RESULT_KIND_PATTERN,
  connectionOperationName,
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
  type ISODateString,
  type JobSchedule,
  type JsonObject,
  type PlatformStores,
  type RegisteredJobHandler,
  type ToolCodeCallOutcome,
  type ToolCodeCallRequest,
  type ToolCodeCallRequestAnswer,
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
  type CodeSandboxChannel,
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
//
// Beside it the handler has a request channel (TOOL-2c): it calls a Connection operation its
// tool declares by writing a request to the descriptor the sandbox opened, through the module
// of `TOOL_CODE_LIBRARY`. The worker refuses an operation the tool does not declare, writes a
// declared one on the call's row and hands the handler the answer the operation wrote there.
// The operation, which waits for the call as the tool's caller, carries the request out as the
// Connection's operation (`tool-assets.ts`). No credential reaches the worker or the sandbox.

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
/** How much of a handler's error stream a failed call hands the model, from its end. */
const STDERR_TAIL_BYTES = 400;
/** What the names of a call's directory and container start with. */
const COMMAND_ID_PREFIX = "tool-call-";
/** How often a running handler's job looks whether its call is still waited for. */
const CANCEL_CHECK_MS = 1_000;
/** How often a handler's open request looks for its answer on the call's row. */
const REQUEST_POLL_MS = 50;
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

/** The last bytes of what a handler wrote to its error stream, for the model alone. */
function stderrTail(text: string): string | undefined {
  const bytes = Buffer.from(text.trim(), "utf8");
  if (bytes.byteLength === 0) return undefined;
  return bytes.byteLength <= STDERR_TAIL_BYTES
    ? bytes.toString("utf8")
    : `…${bytes.subarray(bytes.byteLength - STDERR_TAIL_BYTES).toString("utf8")}`;
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
  /** For a test: how often an open request looks for its answer. */
  requestPollMs?: number;
}

/** What a request is answered where it is refused before the operation was asked. */
function refusedRequest(code: string, message: string): string {
  const answer: ToolCodeCallRequestAnswer = { ok: false, error: { code, message } };
  return JSON.stringify(answer);
}

const requestSchema = z.strictObject({
  connection: z.string().min(1).max(200),
  operation: z.string().min(1).max(200),
  input: z.unknown().optional()
});

/**
 * The request channel of one call. A request names a Connection operation the tool declares;
 * any other is refused here with `connection_not_declared`. A declared one is written on the
 * call's row, where the operation that waits for the call answers it. At most
 * `TOOL_CODE_REQUESTS_MAX` requests, each at most `TOOL_CODE_REQUEST_MAX_BYTES`.
 */
function requestChannel(options: {
  clientInstanceId: ClientInstanceId;
  stores: PlatformStores;
  id: string;
  declared: readonly string[];
  signal: AbortSignal;
  pollMs: number;
  /** When this attempt started the handler's container: only its requests are written. */
  startedAt(): ISODateString | undefined;
}): CodeSandboxChannel {
  const { clientInstanceId, stores, id, signal } = options;
  const closed = () => refusedRequest("channel_closed", "Nobody waits for this call any more.");
  let made = 0;
  return {
    library: TOOL_CODE_LIBRARY,
    maxLineBytes: TOOL_CODE_REQUEST_MAX_BYTES,
    // A few past the bound are answered `too_many_requests`; then the channel closes.
    maxLines: TOOL_CODE_REQUESTS_MAX + 5,
    refuse: () =>
      refusedRequest(
        "request_too_large",
        `A request is at most ${TOOL_CODE_REQUEST_MAX_BYTES} bytes as one line of JSON.`
      ),
    async answer(line) {
      made += 1;
      const seq = made;
      if (seq > TOOL_CODE_REQUESTS_MAX) {
        return refusedRequest(
          "too_many_requests",
          `A handler makes at most ${TOOL_CODE_REQUESTS_MAX} Connection calls in one call of its tool.`
        );
      }
      let parsed: z.infer<typeof requestSchema> | undefined;
      try {
        parsed = requestSchema.parse(JSON.parse(line));
      } catch {
        parsed = undefined;
      }
      if (!parsed) {
        return refusedRequest(
          "request_invalid",
          'A request is one line of JSON: { "connection": ..., "operation": ..., "input": ... }.'
        );
      }
      const name = connectionOperationName(parsed.connection, parsed.operation);
      if (!options.declared.includes(name)) {
        return refusedRequest(
          "connection_not_declared",
          `The tool does not declare '${name}' in its connections, so its handler may not call it.`
        );
      }
      const request: ToolCodeCallRequest = {
        seq,
        connection: parsed.connection,
        operation: parsed.operation,
        input: unknownToJsonValue(parsed.input ?? {})
      };
      const startedAt = options.startedAt();
      if (startedAt === undefined) return closed();
      try {
        if (
          !(await stores.toolCodeCalls.requestToolCodeCall({
            clientInstanceId,
            id,
            request,
            startedAt
          }))
        )
          return closed();
        while (!signal.aborted) {
          await sleep(options.pollMs, undefined, { signal }).catch(() => undefined);
          const call = await stores.toolCodeCalls.getToolCodeCall({ clientInstanceId, id });
          if (!call || call.outcome) return closed();
          if (call.answer?.seq === seq) {
            const { seq: _answered, ...answer } = call.answer;
            return JSON.stringify(answer);
          }
        }
      } catch {
        // A store that did not answer: the handler is told, and its call goes on.
        return refusedRequest("channel_failed", "The platform could not carry the request.");
      }
      return closed();
    }
  };
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
  const failed = (code: string, message: string, tail?: string): ToolCodeCallOutcome => ({
    kind: "failed",
    error: { code, message },
    ...(tail ? { stderrTail: tail } : {})
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
          // An earlier attempt's handler called a Connection and stopped before it ended. What
          // it called may have changed something outside, so the handler is not run again.
          const interrupted = () =>
            finish(
              id,
              failed(
                "interrupted",
                "The handler stopped after it called a Connection. It is not run again, so nothing it called is called twice."
              )
            );
          if (call.request) {
            await interrupted();
            return;
          }
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
          /** When this attempt started the container, and whether a request kept it from it. */
          let startedAt: ISODateString | undefined;
          let requested = false;
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
              channel: requestChannel({
                clientInstanceId,
                stores,
                id,
                declared: tool.connections ?? [],
                signal: stop.signal,
                pollMs: options.requestPollMs ?? REQUEST_POLL_MS,
                startedAt: () => startedAt
              }),
              signal: stop.signal,
              // The operation's wait for the handler counts from here, not from the queue.
              beforeStart: async () => {
                const at = new Date().toISOString();
                const waited = await stores.toolCodeCalls.startToolCodeCall({
                  clientInstanceId,
                  id,
                  startedAt: at
                });
                if (waited) {
                  startedAt = at;
                  return;
                }
                // An attempt that overlaps this one made a request since this one began.
                const now = await stores.toolCodeCalls.getToolCodeCall({ clientInstanceId, id });
                requested = now?.outcome === undefined && now?.request !== undefined;
                stop.abort(new Error("Nobody waits for the call"));
              }
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
          if (requested) {
            await interrupted();
            return;
          }
          if (result.kind === "stopped") return;
          if (result.kind === "notStarted") {
            throw new Error(`The sandbox could not start the container: ${result.reason}`);
          }
          const { outcome, log } = result;
          if (outcome.kind === "output") {
            await finish(id, { kind: "answered", value: outcome.value });
            return;
          }
          // The message stays a plain sentence; what the handler wrote goes beside it, for the
          // model alone.
          const tail =
            outcome.error.code === WORKFLOW_CODE_ERRORS.failed ? stderrTail(log.stderr) : undefined;
          await finish(
            id,
            failed(outcome.error.code, outcome.error.message.replace("script", "handler"), tail)
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
  /** Its handler started and did not end before the wait ran out: its time or the deadline. */
  | { status: "timed_out" }
  /**
   * No container was started for it before the wait ran out: every sandbox for code tools
   * stayed busy for the time a call may queue, or the agent's deadline came first.
   */
  | { status: "queued" }
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
    /**
     * Carries out a request of the handler: a call of a Connection operation its tool
     * declares, as the tool's caller. Without it every request is refused.
     */
    onRequest?(request: ToolCodeCallRequest): Promise<ToolCodeCallRequestAnswer>;
  }): Promise<ToolCodeCallResult>;
}

/** How long a call may wait for a worker to start its handler's container. */
const TOOL_CODE_QUEUE_MAX_MS = 30_000;

/** The answer to a request, or the refusal of one larger than an answer may be. */
async function answerOf(
  request: ToolCodeCallRequest,
  onRequest: ((request: ToolCodeCallRequest) => Promise<ToolCodeCallRequestAnswer>) | undefined
): Promise<ToolCodeCallRequestAnswer> {
  if (!onRequest) {
    return {
      ok: false,
      error: { code: "connection_unavailable", message: "This process calls no Connections." }
    };
  }
  const answer = await onRequest(request).catch((): ToolCodeCallRequestAnswer => ({
    ok: false,
    error: { code: "failed", message: "The Connection call failed." }
  }));
  const bytes = Buffer.byteLength(JSON.stringify(answer), "utf8");
  return bytes <= TOOL_CODE_REQUEST_ANSWER_MAX_BYTES
    ? answer
    : {
        ok: false,
        error: {
          code: "answer_too_large",
          message: `The answer has ${bytes} bytes as JSON; a handler is handed at most ${TOOL_CODE_REQUEST_ANSWER_MAX_BYTES}.`
        }
      };
}

/**
 * How long a call waits past its handler's time from the moment its container started: for
 * the sandbox to stop the handler and the worker to write how it ended.
 */
export const TOOL_CODE_END_GRACE_MS = 5_000;
/** The longest a call can wait in all: queued to the last moment, then its handler's time. */
export function toolCodeCallMaxWaitMs(timeoutSeconds: number): number {
  return TOOL_CODE_QUEUE_MAX_MS + timeoutSeconds * 1_000 + TOOL_CODE_END_GRACE_MS;
}
const POLL_MS = 200;

/** Writes a call and its job, and waits for the call's outcome on its row. */
export function createToolCodeCallClient(options: {
  stores: Pick<PlatformStores, "toolCodeCalls" | "jobs" | "transaction">;
  pollMs?: number;
  /** For a test: in place of `JOB_UNCLAIMED_MS`. */
  unclaimedMs?: number;
  /** For a test: in place of `TOOL_CODE_QUEUE_MAX_MS`. */
  queueMaxMs?: number;
}): ToolCodeCallClient {
  const { stores } = options;
  const pollMs = options.pollMs ?? POLL_MS;
  const unclaimedMs = options.unclaimedMs ?? JOB_UNCLAIMED_MS;
  const queueMaxMs = options.queueMaxMs ?? TOOL_CODE_QUEUE_MAX_MS;
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
      const queued = Date.now();
      const deadline = input.deadline?.getTime() ?? Number.POSITIVE_INFINITY;
      // While the call is queued, it waits at most `queueMaxMs`; once a worker started its
      // container, the handler's time from then and a moment to write how it ended. Never
      // longer than the agent's deadline, nor than the longest a call can wait in all.
      const last = Math.min(
        deadline,
        queued + queueMaxMs + input.timeoutSeconds * 1_000 + TOOL_CODE_END_GRACE_MS
      );
      let startedAt: number | undefined;
      let seenStart: string | undefined;
      const until = () =>
        Math.min(
          startedAt === undefined
            ? queued + queueMaxMs
            : startedAt + input.timeoutSeconds * 1_000 + TOOL_CODE_END_GRACE_MS,
          last
        );
      // A call that never started says why: no worker at all, or every sandbox busy.
      const ranOut = async (): Promise<ToolCodeCallResult> => {
        if (startedAt !== undefined) return { status: "timed_out" };
        const noWorker = await noWorkerTakesJobs(stores.jobs, {
          clientInstanceId,
          kind: toolCodeCallJob,
          unclaimedMs: Math.min(unclaimedMs, Date.now() - queued)
        }).catch(() => false);
        return noWorker ? { status: "no_worker" } : { status: "queued" };
      };
      let nextWorkerCheck = queued + unclaimedMs;
      /** The request answered last: each is carried out once. */
      let answered = 0;
      try {
        while (true) {
          if (input.signal?.aborted)
            return isOperationTimeout(input.signal) ? await ranOut() : { status: "cancelled" };
          if (Date.now() >= until()) return await ranOut();
          await sleep(Math.max(1, Math.min(pollMs, until() - Date.now())), undefined, {
            ...(input.signal ? { signal: input.signal } : {})
          }).catch(() => undefined);
          if (input.signal?.aborted) continue;
          const call = await stores.toolCodeCalls.getToolCodeCall({ clientInstanceId, id });
          if (call?.outcome) return { status: "ended", outcome: call.outcome };
          // The row went with its conversation.
          if (!call) return { status: "cancelled" };
          // A worker's clock can run ahead of this one: a start is never later than when it is
          // first seen here. An attempt that started the container again moves it.
          if (call.startedAt && call.startedAt !== seenStart) {
            seenStart = call.startedAt;
            startedAt = Math.min(Date.parse(call.startedAt), Date.now());
          }
          const { request } = call;
          if (request && request.seq > answered && call.answer?.seq !== request.seq) {
            answered = request.seq;
            const answer = await answerOf(request, input.onRequest);
            await stores.toolCodeCalls.answerToolCodeCall({
              clientInstanceId,
              id,
              answer: { ...answer, seq: request.seq }
            });
            continue;
          }
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
  if (result.status === "queued") {
    return failure(
      "queued",
      `The tool '${tool}' did not start: every sandbox for code tools stayed busy. Nothing of it ran; it can be called again.`
    );
  }
  const { outcome } = result;
  if (outcome.kind === "failed") {
    if (outcome.error.code === WORKFLOW_CODE_ERRORS.timeout) return timedOut;
    // The end of the handler's error stream reaches the model in this answer alone: the run
    // of the call keeps the reason code and no text of the tool.
    const tail = outcome.stderrTail ? `\nIts error stream ends with:\n${outcome.stderrTail}` : "";
    return failure(
      outcome.error.code,
      `The handler of the tool '${tool}' failed: ${outcome.error.message}${tail}`
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
