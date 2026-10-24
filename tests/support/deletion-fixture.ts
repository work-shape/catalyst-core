import { IdentityResolvingAuthAdapter, type AuthAdapter } from "@work-shape/catalyst-auth";
import {
  agentRunJobOptions,
  createPlatformId,
  executeAgentRunJob,
  type AgentRun,
  type AgentRunJobLease,
  type AuthenticatedUser,
  type Conversation,
  type JobId,
  type UserRole
} from "@work-shape/catalyst-core";
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
  const leases = new Map<string, AgentRunJobLease>();
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
    /** A cleanup batch, seeded in one statement instead of one store round-trip per row. */
    async seedDeletedConversations(owner: AuthenticatedUser, count: number, objects = false) {
      const workspace = await fixture.personalWorkspaceOf(owner);
      const ids = Array.from({ length: count }, () => createPlatformId<"ConversationId">("conv"));
      await db.sql`
        with seeded as (
          insert into conversations (id, client_instance_id, collaboration_workspace_id,
            created_by_user_id, created_by_external_user_id, visibility, title, status,
            created_at, updated_at, retained_until, deleted_at)
          select id, ${fixture.clientInstanceId}, ${workspace.id}, ${owner.id},
            ${owner.externalUserId}, 'workspace', id, 'deleted', now(), now(), now(), now()
          from unnest(${ids}::text[]) as id returning id
        ), workspaces as (
          insert into execution_workspaces (id, client_instance_id, conversation_id,
            owner_user_id, status, created_at, updated_at)
          select 'ew_' || id, ${fixture.clientInstanceId}, id, ${owner.id}, 'active', now(), now()
          from seeded where not ${objects}
        ), files as (
          insert into managed_files (id, client_instance_id, owner_user_id, filename, mime_type,
            byte_size, checksum, object_key, status, created_at)
          select 'file_' || id, ${fixture.clientInstanceId}, ${owner.id}, 'retention.txt',
            'text/plain', 1, 'sha256:seed', 'files/' || id || '/seed', 'available', now()
          from seeded where ${objects} returning id
        ), artifacts as (
          insert into managed_artifacts (id, client_instance_id, conversation_id, source_file_id,
            kind, object_key, filename, mime_type, byte_size, checksum, metadata, status, created_at)
          select 'art_' || seeded.id, ${fixture.clientInstanceId}, seeded.id, files.id,
            'test.preview', 'artifacts/' || seeded.id || '/seed', 'preview.txt', 'text/plain',
            1, 'sha256:seed', '{}'::jsonb, 'available', now()
          from seeded join files on files.id = 'file_' || seeded.id
          returning id
        )
        insert into conversation_attachments (id, client_instance_id, conversation_id, file_id,
          filename, mime_type, byte_size, checksum, status, format, artifact_refs, warnings,
          created_at, updated_at)
        select 'att_' || seeded.id, ${fixture.clientInstanceId}, seeded.id, files.id,
          'retention.txt', 'text/plain', 1, 'sha256:seed', 'ready', 'txt',
          jsonb_build_object('preview', artifacts.id), '[]'::jsonb, now(), now()
        from seeded join files on files.id = 'file_' || seeded.id
          join artifacts on artifacts.id = 'art_' || seeded.id`;
      if (objects) {
        for (const id of ids) {
          await fixture.byteStore.put(`files/${id}/seed`, new Uint8Array([1]));
          await fixture.byteStore.put(`artifacts/${id}/seed`, new Uint8Array([1]));
        }
      }
    },
    /** One attempt of every queued deletion job, without waiting for its backoff. */
    async runDeletionJobs() {
      // Fast-forward into the past, away from a wall-clock correction between connections.
      await db.sql`
        update platform_jobs set run_after = 'epoch'::timestamptz
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
    /**
     * Claims the queued run as its job does. The job is put into the state a worker's claim
     * leaves it in, without a worker: the token is that attempt's hold on the run.
     */
    async claimRun(leaseToken: string) {
      const [queued] = await db.sql<Array<{ id: AgentRun["id"]; correlation_id: string }>>`
        select id, correlation_id from agent_runs
        where client_instance_id = ${fixture.scope.clientInstanceId} and status = 'queued'
        order by started_at, id limit 1`;
      if (!queued) throw new Error("No queued run to claim");
      await db.store.jobs.enqueue(
        executeAgentRunJob,
        { runId: queued.id },
        agentRunJobOptions({
          ...fixture.scope,
          id: queued.id,
          correlationId: queued.correlation_id
        })
      );
      const [job] = await db.sql<Array<{ id: JobId }>>`
        update platform_jobs
        set status = 'running', attempts = 1, started_at = now(), lease_owner = 'deletion-test',
          lease_token = ${leaseToken}, lease_expires_at = now() + interval '10 minutes'
        where client_instance_id = ${fixture.scope.clientInstanceId} and subject = ${queued.id}
        returning id`;
      if (!job) throw new Error("The run has no job to claim");
      const lease = { jobId: job.id, leaseToken };
      const claimed = await db.store.agentRuns.claimAgentRunForJob({
        ...fixture.scope,
        runId: queued.id,
        lease,
        leaseMs: executeAgentRunJob.leaseMs
      });
      if (claimed.status !== "claimed") throw new Error("The queued run was not claimed");
      leases.set(leaseToken, lease);
      return claimed.row;
    },
    /** The message a worker stores for its run. */
    workerMessage(run: AgentRun, leaseToken: string) {
      const lease = leases.get(leaseToken);
      if (!lease) throw new Error("No run was claimed under this token");
      return db.store.agentRuns.appendClaimedAgentRunMessage({
        ...fixture.scope,
        runId: run.id,
        lease,
        message: {
          ...fixture.scope,
          role: "assistant",
          conversationId: run.conversationId,
          text: "written back"
        }
      });
    },
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
