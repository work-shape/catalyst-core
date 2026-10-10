// An Agent Run worker in a process of its own, for the test that kills one. It executes every
// run by storing one piece of the reply and then never ending. Started with the database and
// the client instance in its environment.
import { createAgentRunJobs } from "@vivd-catalyst/agent-runtime";
import { createPostgresJobWorker, createPostgresStores } from "@vivd-catalyst/postgres-store";
import { AppError, asClientInstanceId, asUserId, type Logger } from "@vivd-catalyst/core";

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

const clientInstanceId = asClientInstanceId(fromEnvironment("AGENT_RUN_TEST_CLIENT_INSTANCE_ID"));
const stores = await createPostgresStores({
  databaseUrl: fromEnvironment("AGENT_RUN_TEST_DATABASE_URL")
});
const jobs = createAgentRunJobs({
  clientInstanceId,
  stores,
  slots: 1,
  async loadCurrentUser(run) {
    const user = await stores.users.getUser({
      clientInstanceId,
      userId: asUserId(run.ownerUserId)
    });
    if (!user) throw new AppError("NOT_FOUND", "Run owner is not available");
    return {
      id: user.id,
      externalUserId: user.id,
      displayLabel: user.displayLabel,
      roles: user.roles,
      permissionRefs: user.permissionRefs,
      clientInstanceId,
      authSource: "test"
    };
  },
  async execute(input) {
    const runId = input.preparedRun?.id;
    if (!runId) throw new AppError("INTERNAL", "The run was not prepared");
    return {
      events: (async function* () {
        yield {
          type: "message_delta" as const,
          runId,
          sequence: 1,
          createdAt: new Date().toISOString(),
          delta: "Half of a re"
        };
        await new Promise<never>(() => undefined);
      })(),
      async cancel() {}
    };
  }
});
createPostgresJobWorker({ stores, clientInstanceId, logger: silent, ...jobs }).start();
// Keeps the process alive while the run above waits on nothing.
process.stdin.resume();
