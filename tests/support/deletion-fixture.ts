import { IdentityResolvingAuthAdapter, type AuthAdapter } from "@vivd-catalyst/auth";
import {
  createPlatformId,
  type AgentRun,
  type AuthenticatedUser,
  type Conversation,
  type UserRole
} from "@vivd-catalyst/core";
import { createConversationCleanupFixture } from "./conversation-cleanup-fixture";
import type { PostgresSuite } from "./postgres-suite";
import {
  createTestInstance,
  getTestJobs,
  type TestInstance,
  type TestServerOptions
} from "./test-instance";

const DELETION_KINDS = ["account.delete", "workspace.delete"];

/**
 * The cleanup fixture with a server that resolves every request against the stored user, as an
 * instance does: a user who is closed in the database is refused whatever the request carries.
 */
export async function arrangeDeletion(
  db: PostgresSuite,
  label: string,
  /** Server options that differ from the fixture's, such as a feature that is off. */
  overrides: Partial<TestServerOptions> = {}
) {
  const fixture = await createConversationCleanupFixture(db, label);
  const known = new Map<string, AuthenticatedUser>();
  const headerAdapter: AuthAdapter = {
    id: "test-header",
    credentialMode: "ambient",
    async authenticate(request) {
      const header = request.headers["x-dev-user-id"];
      const user = known.get((Array.isArray(header) ? header[0] : header) ?? "");
      if (!user) throw new Error("The request names no known test user");
      return { ...user, scopes: ["*"] };
    }
  };
  const api = await createTestInstance({
    server: {
      ...fixture.options,
      ...overrides,
      authAdapter: new IdentityResolvingAuthAdapter(headerAdapter, db.store.users)
    }
  });
  const jobs = () =>
    db.sql<Array<{ kind: string; status: string; attempts: number }>>`
      select kind, status, attempts from platform_jobs
      where client_instance_id = ${fixture.clientInstanceId} and kind = any(${DELETION_KINDS})
      order by created_at, id`.then((rows) => rows.map((row) => ({ ...row })));
  return {
    ...fixture,
    api,
    jobs,
    async createUser(name: string, roles: UserRole[] = ["user"]) {
      const user = await fixture.createUser(name, roles);
      known.set(user.id, user);
      return user;
    },
    /** One attempt of every queued deletion job, without waiting for its backoff. */
    async runDeletionJobs() {
      await db.sql`
        update platform_jobs set run_after = now()
        where client_instance_id = ${fixture.clientInstanceId}
          and kind = any(${DELETION_KINDS}) and status = 'queued'`;
      await getTestJobs(api).runDue();
    },
    async userRow(user: AuthenticatedUser) {
      const rows = await db.sql<Array<{ marked: boolean }>>`
        select deletion_requested_at is not null as marked from product_users
        where id = ${user.id}`;
      return rows.map((row) => ({ ...row }));
    },
    signedIn: (user: AuthenticatedUser): ReturnType<TestInstance["call"]> =>
      api.call("me.get", {}, user.id),
    /** Resolves once `count` requests of the server wait for a row lock. */
    async untilWaitingForLock(count: number) {
      const deadline = Date.now() + 15_000;
      for (;;) {
        const [row] = await db.sql<Array<{ waiting: number }>>`
          select count(*)::int as waiting from pg_locks blocked
          join pg_stat_activity waiter on waiter.pid = blocked.pid
          where not blocked.granted and waiter.application_name = ${db.first}`;
        if ((row?.waiting ?? 0) >= count) return;
        if (Date.now() > deadline) throw new Error(`${count} requests never waited for a lock`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    /** A queued run in the Conversation, started by the user. */
    async startRun(conversation: Conversation, owner: AuthenticatedUser): Promise<AgentRun> {
      const message = await db.store.conversations.appendMessage({
        ...fixture.scope,
        conversationId: conversation.id,
        role: "user",
        text: "run this"
      });
      return db.store.agentRuns.createAgentRun({
        id: createPlatformId<"AgentRunId">("run"),
        ...fixture.scope,
        conversationId: conversation.id,
        ownerUserId: owner.id,
        inputMessageId: message.id,
        agentName: "test_agent",
        status: "queued",
        correlationId: "corr_deletion_run"
      });
    },
    /** Claims the queued run as a worker does. The token is the worker's hold on it. */
    async claimRun(leaseToken: string) {
      const claimed = await db.store.agentRuns.claimNextAgentRun({
        ...fixture.scope,
        workerId: "deletion-test-worker",
        leaseToken,
        now: new Date().toISOString(),
        leaseExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString()
      });
      if (!claimed) throw new Error("No queued run to claim");
      return claimed;
    },
    /** The message a worker stores for its run. */
    workerMessage: (run: AgentRun, leaseToken: string) =>
      db.store.agentRuns.appendClaimedAgentRunMessage({
        ...fixture.scope,
        runId: run.id,
        leaseToken,
        message: {
          ...fixture.scope,
          role: "assistant",
          conversationId: run.conversationId,
          text: "written back"
        }
      }),
    async runStatus(run: AgentRun) {
      const [row] = await db.sql<Array<{ status: string }>>`
        select status from agent_runs where id = ${run.id}`;
      return row?.status;
    },
    /** What the worker does when it reads the cancellation request: the run ends. */
    async endCancelledRun(run: AgentRun) {
      await db.sql`
        update agent_runs
        set status = 'cancelled', cancelled_at = now(), lease_owner = null, lease_token = null,
          lease_expires_at = null
        where id = ${run.id} and status = 'cancelling'`;
    }
  };
}
