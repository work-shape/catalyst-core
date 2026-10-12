// A job worker with nothing to do, in a process of its own, as a worker of an instance is
// between two jobs. Nothing but the worker holds the process open. Started with the database
// and the client instance in its environment.
import {
  asClientInstanceId,
  defineJobHandler,
  defineJobKind,
  type Logger
} from "@vivd-catalyst/core";
import { createPostgresJobWorker, createPostgresStores } from "@vivd-catalyst/postgres-store";
import { z } from "zod";

const silent: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => silent
};

function fromEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const stores = await createPostgresStores({
  databaseUrl: fromEnvironment("IDLE_WORKER_TEST_DATABASE_URL")
});
// A kind nobody enqueues: the worker asks the database for its work on every pass.
const neverEnqueued = defineJobHandler({
  kind: defineJobKind({
    kind: "test.never_enqueued",
    payloadSchema: z.object({}),
    maxAttempts: 1,
    backoff: { baseMs: 0, maxMs: 0 },
    leaseMs: 60_000,
    concurrency: {}
  }),
  slots: 1,
  async run() {}
});
createPostgresJobWorker({
  stores,
  clientInstanceId: asClientInstanceId(fromEnvironment("IDLE_WORKER_TEST_CLIENT_INSTANCE_ID")),
  logger: silent,
  handlers: [neverEnqueued]
}).start();
// What a worker entry point waits on: a stop, which never comes here.
await new Promise<never>(() => undefined);
