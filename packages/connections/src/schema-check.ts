import { Worker } from "node:worker_threads";
import {
  connectionCallError,
  connectionCallReasonOf,
  type ConnectionCallReason,
  type JsonObject
} from "@work-shape/catalyst-core";
import { z } from "zod";
import {
  JSON_SCHEMA_WORKER_ROLE,
  compileJsonSchema,
  measureOutsideJsonSchema,
  type JsonSchemaCheckAnswer,
  type JsonSchemaCheckRequest,
  type JsonSchemaIssue,
  type JsonSchemaWorkerData,
  type OutsideSchemaBoundRefusal
} from "./json-schema";

// Every check by a schema an outside system wrote goes through this file: the tool list of an
// MCP server at discovery, the input of a call and its result. Such a schema is compiled and
// used in a worker thread and never where requests are served. Compiling one, or checking a
// value by one, can take as long as its author likes: a regular expression that backtracks, a
// `uniqueItems` over a large answer, a schema that branches at every level. The one bound that
// holds for all of them is to stop the thread that runs it. So a check has a deadline, the
// thread of a check that passes it is stopped and replaced, and the caller is refused with
// `schema_check_timeout`. The server answers everything else meanwhile.
//
// A schema the release wrote, the static catalog of a Connector type, does not come here. It
// is compiled and checked where it is called, as before.

/**
 * How long one check may run in its thread, in milliseconds: compiling the schema where the
 * thread does not hold it, and checking the value. An ordinary check takes well under a
 * millisecond. After it the thread is stopped and the check answers `schema_check_timeout`.
 */
export const OUTSIDE_SCHEMA_CHECK_TIMEOUT_MS = 2_000;

/**
 * How many threads check schemas of outside systems in one process. They are started at the
 * first check and at most this many run, so a schema that stalls costs one of them for the
 * deadline and the other serves.
 */
export const OUTSIDE_SCHEMA_CHECK_THREADS = 2;

/**
 * How many checks wait for a thread in one process. A further check answers
 * `schema_check_unavailable` at once.
 */
export const OUTSIDE_SCHEMA_CHECK_MAX_WAITING = 64;

/**
 * How long a check waits for a thread, in milliseconds. After it the check answers
 * `schema_check_unavailable`.
 */
export const OUTSIDE_SCHEMA_CHECK_WAIT_MS = 5_000;

/**
 * How many compiled schemas one thread keeps, by the fingerprint of the schema. A schema is
 * compiled once per thread. Where the bound is reached, the one used longest ago is dropped and
 * compiled again at its next use.
 */
export const OUTSIDE_SCHEMA_CACHE_MAX_ENTRIES = 500;

/**
 * How long a schema whose check passed the deadline is refused without a new check, in
 * milliseconds. A caller that repeats the call costs no thread during it.
 */
export const OUTSIDE_SCHEMA_SLOW_COOL_OFF_MS = 30_000;

/** How many such schemas are remembered. The one remembered first is forgotten first. */
const OUTSIDE_SCHEMA_SLOW_MAX_ENTRIES = 500;

/** How long a thread may take to start, in milliseconds. It loads the validator once. */
const OUTSIDE_SCHEMA_THREAD_START_MS = 10_000;

/** The memory one thread may take for what it compiled and what it checks, in megabytes. */
const OUTSIDE_SCHEMA_THREAD_MAX_HEAP_MB = 256;

/**
 * Why a schema of an outside system is not registered as an operation's. The first six are
 * decided before anything compiles it, `schema_uncompilable` also by the validator.
 */
export type OutsideSchemaRefusal = OutsideSchemaBoundRefusal | "schema_check_timeout";

/** Why a check gave no answer, as a call is refused with it. */
type CheckFailure = Extract<
  ConnectionCallReason,
  "schema_check_timeout" | "schema_check_unavailable"
>;

export interface OutsideSchemaChecker {
  /**
   * Checks a value, as its JSON, by a schema of an outside system. Answers the issues, none for
   * a value that fits, or `uncompilable` for a schema that is over a bound or does not compile.
   * Without a value the schema is compiled and nothing more. Throws the error of a Connection
   * call with `schema_check_timeout` where the check passed the deadline, and with
   * `schema_check_unavailable` where no thread took it or its thread ended.
   */
  check(schema: JsonObject, value?: string): Promise<JsonSchemaIssue[] | "uncompilable">;
  /**
   * Why the schema is not registered, or nothing where it is within every bound and compiles
   * within the deadline. Throws `schema_check_unavailable` like `check`: that says nothing
   * about the schema.
   */
  refusalOf(schema: JsonObject): Promise<OutsideSchemaRefusal | undefined>;
  /** Stops every thread. Checks that wait or run answer `schema_check_unavailable`. */
  close(): Promise<void>;
}

export interface OutsideSchemaCheckerOptions {
  /** Instead of `OUTSIDE_SCHEMA_CHECK_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Instead of `OUTSIDE_SCHEMA_CHECK_THREADS`. */
  threads?: number;
  /** Instead of `OUTSIDE_SCHEMA_CHECK_MAX_WAITING`. */
  maxWaiting?: number;
  /** Instead of `OUTSIDE_SCHEMA_CHECK_WAIT_MS`. */
  waitMs?: number;
  /** Instead of `OUTSIDE_SCHEMA_CACHE_MAX_ENTRIES`. */
  cacheMaxEntries?: number;
  /** Instead of `OUTSIDE_SCHEMA_SLOW_COOL_OFF_MS`. */
  slowCoolOffMs?: number;
}

interface Job {
  id: number;
  key: string;
  schema: string;
  value: string | undefined;
  resolve(answer: JsonSchemaIssue[] | "uncompilable"): void;
  reject(error: unknown): void;
  waitTimer?: ReturnType<typeof setTimeout>;
}

interface Thread {
  worker: Worker;
  ready: boolean;
  /** The keys the thread was sent the schema of. It may have dropped one since. */
  sent: Set<string>;
  job?: Job;
  timer?: ReturnType<typeof setTimeout>;
}

function isAnswer(value: unknown): value is JsonSchemaCheckAnswer {
  return typeof value === "object" && value !== null && "kind" in value;
}

/** The file a thread runs: this package's JSON Schema module, as source or as built. */
function workerFile(): URL {
  const here = import.meta.url;
  return new URL(here.endsWith(".ts") ? "./json-schema.ts" : "./json-schema.js", here);
}

export function createOutsideSchemaChecker(
  options: OutsideSchemaCheckerOptions = {}
): OutsideSchemaChecker {
  const timeoutMs = options.timeoutMs ?? OUTSIDE_SCHEMA_CHECK_TIMEOUT_MS;
  const maxThreads = Math.max(1, options.threads ?? OUTSIDE_SCHEMA_CHECK_THREADS);
  const maxWaiting = options.maxWaiting ?? OUTSIDE_SCHEMA_CHECK_MAX_WAITING;
  const waitMs = options.waitMs ?? OUTSIDE_SCHEMA_CHECK_WAIT_MS;
  const cacheMaxEntries = options.cacheMaxEntries ?? OUTSIDE_SCHEMA_CACHE_MAX_ENTRIES;
  const slowCoolOffMs = options.slowCoolOffMs ?? OUTSIDE_SCHEMA_SLOW_COOL_OFF_MS;

  const threads = new Set<Thread>();
  const waiting: Job[] = [];
  /** Until when a schema whose check passed the deadline is refused, by its key. */
  const slowUntil = new Map<string, number>();
  let nextId = 1;
  let closed = false;

  const failure = (reason: CheckFailure) => connectionCallError(reason);

  const rememberSlow = (key: string): void => {
    slowUntil.delete(key);
    if (slowUntil.size >= OUTSIDE_SCHEMA_SLOW_MAX_ENTRIES) {
      const oldest = slowUntil.keys().next();
      if (!oldest.done) slowUntil.delete(oldest.value);
    }
    slowUntil.set(key, performance.now() + slowCoolOffMs);
  };

  const isSlow = (key: string): boolean => {
    const until = slowUntil.get(key);
    if (until === undefined) return false;
    if (performance.now() < until) return true;
    slowUntil.delete(key);
    return false;
  };

  /** Ends a thread and the check it runs. The thread is gone from the pool at once. */
  const retire = (thread: Thread, reason: CheckFailure): void => {
    if (!threads.delete(thread)) return;
    clearTimeout(thread.timer);
    const { job } = thread;
    thread.job = undefined;
    // A thread that does not give its loop a turn is stopped all the same.
    thread.worker.terminate().catch(() => undefined);
    if (job) {
      if (reason === "schema_check_timeout") rememberSlow(job.key);
      job.reject(failure(reason));
    }
    pump();
  };

  const send = (thread: Thread, job: Job, withSchema: boolean): void => {
    const request: JsonSchemaCheckRequest = {
      id: job.id,
      key: job.key,
      ...(withSchema ? { schema: job.schema } : {}),
      ...(job.value === undefined ? {} : { value: job.value })
    };
    if (withSchema) {
      // The thread drops the schema used longest ago, and this forgets more than it does.
      if (thread.sent.size >= cacheMaxEntries) thread.sent.clear();
      thread.sent.add(job.key);
    }
    thread.worker.postMessage(request);
  };

  /** The deadline of the check runs from when its thread can work on it. */
  const startDeadline = (thread: Thread): void => {
    clearTimeout(thread.timer);
    thread.timer = setTimeout(() => retire(thread, "schema_check_timeout"), timeoutMs);
  };

  const assign = (thread: Thread, job: Job): void => {
    clearTimeout(job.waitTimer);
    thread.job = job;
    if (thread.ready) startDeadline(thread);
    send(thread, job, !thread.sent.has(job.key));
  };

  const onAnswer = (thread: Thread, answer: JsonSchemaCheckAnswer): void => {
    if (answer.kind === "ready") {
      thread.ready = true;
      if (thread.job) startDeadline(thread);
      else clearTimeout(thread.timer);
      return;
    }
    const { job } = thread;
    if (!job || answer.id !== job.id) return;
    if (answer.kind === "missing") {
      send(thread, job, true);
      return;
    }
    clearTimeout(thread.timer);
    thread.job = undefined;
    job.resolve(answer.kind === "uncompilable" ? "uncompilable" : answer.issues);
    pump();
  };

  const start = (): Thread | undefined => {
    const data: JsonSchemaWorkerData = { role: JSON_SCHEMA_WORKER_ROLE, cacheMaxEntries };
    let worker: Worker;
    try {
      worker = new Worker(workerFile(), {
        workerData: data,
        resourceLimits: { maxOldGenerationSizeMb: OUTSIDE_SCHEMA_THREAD_MAX_HEAP_MB }
      });
    } catch {
      return undefined;
    }
    const thread: Thread = { worker, ready: false, sent: new Set() };
    thread.timer = setTimeout(
      () => retire(thread, "schema_check_unavailable"),
      OUTSIDE_SCHEMA_THREAD_START_MS
    );
    worker.on("message", (message: unknown) => {
      if (isAnswer(message)) onAnswer(thread, message);
    });
    // A thread that ends on its own: out of memory, or its file is not where it is looked for.
    worker.on("error", () => retire(thread, "schema_check_unavailable"));
    worker.on("exit", () => retire(thread, "schema_check_unavailable"));
    // A thread that waits for a check does not keep the process running. Said after the
    // listeners are set: listening for its answers would hold the process again.
    worker.unref();
    threads.add(thread);
    return thread;
  };

  /** Hands waiting checks to threads that are free, starting one where the bound allows. */
  function pump(): void {
    while (waiting.length > 0) {
      let free: Thread | undefined;
      for (const thread of threads) {
        if (!thread.job) {
          free = thread;
          break;
        }
      }
      if (!free && threads.size < maxThreads && !closed) free = start();
      if (!free) {
        // No thread could be started at all: nothing will take what waits.
        if (threads.size === 0) {
          for (const job of waiting.splice(0)) {
            clearTimeout(job.waitTimer);
            job.reject(failure("schema_check_unavailable"));
          }
        }
        return;
      }
      const job = waiting.shift();
      if (job) assign(free, job);
    }
  }

  const check: OutsideSchemaChecker["check"] = (schema, value) => {
    const measured = measureOutsideJsonSchema(schema);
    if (!measured.ok) return Promise.resolve("uncompilable");
    if (closed) return Promise.reject(failure("schema_check_unavailable"));
    if (isSlow(measured.key)) return Promise.reject(failure("schema_check_timeout"));
    if (waiting.length >= maxWaiting) return Promise.reject(failure("schema_check_unavailable"));
    return new Promise((resolve, reject) => {
      const job: Job = {
        id: nextId,
        key: measured.key,
        schema: measured.serialized,
        value,
        resolve,
        reject
      };
      nextId += 1;
      job.waitTimer = setTimeout(() => {
        const position = waiting.indexOf(job);
        if (position < 0) return;
        waiting.splice(position, 1);
        reject(failure("schema_check_unavailable"));
      }, waitMs);
      waiting.push(job);
      pump();
    });
  };

  return {
    check,
    async refusalOf(schema) {
      const measured = measureOutsideJsonSchema(schema);
      if (!measured.ok) return measured.refusal;
      try {
        return (await check(schema)) === "uncompilable" ? "schema_uncompilable" : undefined;
      } catch (error) {
        if (connectionCallReasonOf(error) === "schema_check_timeout") return "schema_check_timeout";
        throw error;
      }
    },
    async close() {
      closed = true;
      for (const job of waiting.splice(0)) {
        clearTimeout(job.waitTimer);
        job.reject(failure("schema_check_unavailable"));
      }
      const ending = [...threads].map((thread) => {
        const { worker } = thread;
        retire(thread, "schema_check_unavailable");
        return worker.terminate();
      });
      await Promise.all(ending);
    }
  };
}

let shared: OutsideSchemaChecker | undefined;

/**
 * The checker of this process, with the bounds of this file. Its threads start at the first
 * check, so a process that never calls a Connection of an outside system starts none.
 */
export function outsideSchemaChecker(): OutsideSchemaChecker {
  shared ??= createOutsideSchemaChecker();
  return shared;
}

/**
 * A schema the release wrote, as the operations layer reads one. It is checked where it is
 * called. Its issues name the place and the broken rule and never a value. A schema that does
 * not compile refuses every value: nothing passes a check that cannot be made.
 */
export function jsonSchemaAsZod(schema: JsonObject): z.ZodType {
  return z.unknown().superRefine((value, context) => {
    const compiled = compileJsonSchema(schema);
    if (!compiled.ok) {
      context.addIssue({
        code: "custom",
        message: "The schema of this operation cannot be checked"
      });
      return;
    }
    for (const issue of compiled.validate(value)) {
      context.addIssue({ code: "custom", path: issue.path, message: issue.message });
    }
  });
}

/**
 * The JSON of a value a check is handed, or nothing where it has none: a value that is no JSON
 * or refers to itself. Nothing at all is read as `null`, which is what a Connector type is
 * handed for it.
 */
export function jsonOfCheckedValue(value: unknown): string | undefined {
  if (value === undefined) return "null";
  try {
    const serialized: string | undefined = JSON.stringify(value);
    return serialized;
  } catch {
    return undefined;
  }
}

/**
 * A schema an outside system wrote, as the operations layer reads one. The value is checked
 * in a thread of `checker`, so the schema must be parsed with `safeParseAsync`. The issues are
 * those of `jsonSchemaAsZod`. A check that gave no answer is no issue of the input: the parse
 * rejects with the error of a Connection call, `schema_check_timeout` or
 * `schema_check_unavailable`, after `refused` was told.
 */
export function outsideJsonSchemaAsZod(
  schema: JsonObject,
  checker: OutsideSchemaChecker,
  refused?: (reason: ConnectionCallReason | undefined) => void
): z.ZodType {
  return z.unknown().superRefine(async (value, context) => {
    const serialized = jsonOfCheckedValue(value);
    if (serialized === undefined) {
      context.addIssue({ code: "custom", message: "is not a value JSON can hold" });
      return;
    }
    let answer: JsonSchemaIssue[] | "uncompilable";
    try {
      answer = await checker.check(schema, serialized);
    } catch (error) {
      refused?.(connectionCallReasonOf(error));
      throw error;
    }
    if (answer === "uncompilable") {
      context.addIssue({
        code: "custom",
        message: "The schema of this operation cannot be checked"
      });
      return;
    }
    for (const issue of answer) {
      context.addIssue({ code: "custom", path: issue.path, message: issue.message });
    }
  });
}
