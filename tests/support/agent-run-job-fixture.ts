import {
  createAgentRunJobs,
  type AgentRunExecution,
  type AgentRunExecutionControl,
  type AgentRunJobsOptions,
  type ExecuteAgentRun
} from "@vivd-catalyst/agent-runtime";
import {
  asAgentRunId,
  asMessageId,
  createAgentRunUpkeepJobs,
  createAssistantFinalMetadata,
  executeAgentRunJob,
  type AgentRun,
  type AgentRunAuthorization,
  type AgentRuntimeEvent,
  type AuthenticatedUser,
  type ChatMessage,
  type ClientInstanceId,
  type Conversation,
  type JobId,
  type JobWorker,
  type PlatformStores,
  type RuntimeCallContext,
  type StartAgentRunInput
} from "@vivd-catalyst/core";
import { deferred, required } from "./assertions";
import type { useJobExecutorHarness } from "./job-executor-harness";
import type { PostgresSuite } from "./postgres-suite";

export interface AgentRunJobRecord {
  id: JobId;
  subject: string | null;
  status: string;
  attempts: number;
  error_code: string | null;
  lease_token: string | null;
}

/**
 * One client instance with a person and a conversation, the run store that accepts messages
 * and Agent Run workers on the job executor. The execution of a run is driven by hand.
 */
export function useAgentRunJobFixture(
  db: PostgresSuite,
  harness: ReturnType<typeof useJobExecutorHarness>
) {
  async function createFixture(
    label: string,
    input: {
      /** What the run was started with. Null stores none; a function may name the owner. */
      authorization?:
        null | ((clientInstanceId: ClientInstanceId, ownerUserId: string) => AgentRunAuthorization);
    } = {}
  ): Promise<AgentRunJobFixture> {
    const clientInstanceId = db.clientInstance(label);
    const record = await db.store.users.createUser({ clientInstanceId, displayLabel: "Run owner" });
    const externalUserId = `external_${record.id}`;
    const user: AuthenticatedUser = {
      id: record.id,
      externalUserId,
      displayLabel: record.displayLabel,
      roles: ["user"],
      permissionRefs: [],
      clientInstanceId,
      authSource: "test"
    };
    const workspace = await db.store.workspaces.ensurePersonalWorkspace({
      clientInstanceId,
      userId: record.id
    });
    const conversation = await db.store.conversations.createConversation({
      visibility: "workspace",
      clientInstanceId,
      collaborationWorkspaceId: workspace.id,
      createdByUserId: record.id,
      createdByExternalUserId: externalUserId,
      title: "Agent run jobs",
      retainedUntil: "2099-01-01T00:00:00.000Z"
    });
    const authorization: AgentRunAuthorization | undefined =
      "authorization" in input
        ? input.authorization?.(clientInstanceId, record.id)
        : {
            principal: {
              kind: "user",
              id: record.id,
              externalUserId,
              displayLabel: record.displayLabel,
              clientInstanceId,
              authSource: "test"
            },
            subjectUserId: record.id,
            scopes: ["run:start"]
          };
    const executor = new ControlledExecutor();
    const ofRun = (run: Pick<AgentRun, "id">) => ({ clientInstanceId, runId: run.id });
    const runInput = (run: Partial<AgentRun> = {}) => {
      const id = globalThis.crypto.randomUUID();
      const inputMessageId = asMessageId(`msg_${id}`);
      return {
        inputMessageId,
        run: {
          id: asAgentRunId(`run_${id}`),
          clientInstanceId,
          conversationId: conversation.id,
          ownerUserId: record.id,
          inputMessageId,
          agentName: "test_agent",
          authorization,
          status: "queued" as const,
          correlationId: `corr_${id}`,
          ...(run.modelBindingId ? { modelBindingId: run.modelBindingId } : {}),
          ...(run.locale ? { locale: run.locale } : {})
        }
      };
    };
    return {
      clientInstanceId,
      user,
      conversation,
      executor,
      async accept(text = "Do the work", run = {}, stores = db.store) {
        const prepared = runInput(run);
        const accepted = await stores.agentRuns.prepareConversationRunStart({
          clientInstanceId,
          conversationId: conversation.id,
          ownerUserId: record.id,
          userMessage: { id: prepared.inputMessageId, text },
          run: prepared.run
        });
        return accepted.run;
      },
      async acceptAsPreviousRelease(text = "Do the work") {
        const prepared = runInput();
        await db.store.conversations.appendMessage({
          id: prepared.inputMessageId,
          clientInstanceId,
          conversationId: conversation.id,
          role: "user",
          text
        });
        return db.store.agentRuns.createAgentRun(prepared.run);
      },
      worker(options = {}) {
        const jobs = createAgentRunJobs({
          clientInstanceId,
          stores: options.stores ?? db.store,
          loadCurrentUser: async () => user,
          execute: options.execute ?? executor.execute,
          slots: options.slots ?? 4,
          onObservation: options.onObservation,
          cancellations: options.cancellations
        });
        return harness.worker(
          options.stores ?? db.store,
          clientInstanceId,
          jobs.handlers,
          options.schedules ? jobs.schedules : []
        );
      },
      upkeepWorker() {
        const jobs = createAgentRunUpkeepJobs({ clientInstanceId, stores: db.store });
        return harness.worker(db.store, clientInstanceId, jobs.handlers, jobs.schedules);
      },
      async acceptedAgo(run, ms) {
        await db.sql`
          update agent_runs set started_at = now() - make_interval(secs => ${ms / 1000})
          where id = ${run.id}`;
      },
      run: async (run) => required(await db.store.agentRuns.getAgentRun(ofRun(run))),
      async events(run) {
        const observations = await db.store.agentRuns.listRunObservations(ofRun(run));
        return observations.map((observation) => observation.payload);
      },
      async eventTypes(run) {
        const observations = await db.store.agentRuns.listRunObservations(ofRun(run));
        return observations.map((observation) => observation.type);
      },
      messages: () =>
        db.store.conversations.listMessages({ clientInstanceId, conversationId: conversation.id }),
      jobs: () => db.sql<AgentRunJobRecord[]>`
        select id, subject, status, attempts, error_code, lease_token
        from platform_jobs
        where client_instance_id = ${clientInstanceId} and kind = ${executeAgentRunJob.kind}
        order by created_at, id`,
      async expireJobLeases() {
        await db.sql`
          update platform_jobs set lease_expires_at = now() - interval '1 second'
          where client_instance_id = ${clientInstanceId} and status = 'running'`;
      },
      async makeAdoptionDue() {
        await db.sql`
          update platform_jobs set run_after = now()
          where client_instance_id = ${clientInstanceId}
            and kind = 'agent_run.adopt' and status = 'queued'`;
      }
    };
  }

  return { createFixture };
}

export interface AgentRunJobFixture {
  clientInstanceId: ClientInstanceId;
  user: AuthenticatedUser;
  conversation: Conversation;
  executor: ControlledExecutor;
  /** Accepts a message as the API does: the message, its run and the job of the run. */
  accept(
    text?: string,
    run?: Pick<Partial<AgentRun>, "modelBindingId" | "locale">,
    stores?: PlatformStores
  ): Promise<AgentRun>;
  /** Accepts a message as the API of the previous release did: a queued run and no job. */
  acceptAsPreviousRelease(text?: string): Promise<AgentRun>;
  worker(
    options?: Partial<
      Pick<AgentRunJobsOptions, "stores" | "execute" | "slots" | "onObservation" | "cancellations">
    > & { schedules?: boolean }
  ): JobWorker;
  run(run: Pick<AgentRun, "id">): Promise<AgentRun>;
  events(run: Pick<AgentRun, "id">): Promise<AgentRuntimeEvent[]>;
  eventTypes(run: Pick<AgentRun, "id">): Promise<string[]>;
  messages(): Promise<ChatMessage[]>;
  /** The `agent_run.execute` jobs of the instance, oldest first. */
  /**
   * The job worker of a process that executes no runs, the API for one: it serves the upkeep
   * of the runs and buries the jobs of lost workers.
   */
  upkeepWorker(): JobWorker;
  /** As if the run had been accepted this long ago. */
  acceptedAgo(run: Pick<AgentRun, "id">, ms: number): Promise<void>;
  jobs(): Promise<AgentRunJobRecord[]>;
  /** As if the heartbeats had stopped for the lease time: the leases of the running jobs are over. */
  expireJobLeases(): Promise<void>;
  makeAdoptionDue(): Promise<void>;
}

/** One execution a worker started. The test decides what it emits and when it ends. */
class ControlledExecution {
  private readonly queue: AgentRuntimeEvent[] = [];
  private wake: (() => void) | undefined;
  private ended = false;
  private sequence = 0;
  /** Resolves with the reason when the worker asks the execution to cancel. */
  readonly cancelRequested = deferred<string | undefined>();

  constructor(
    readonly input: StartAgentRunInput,
    readonly context: RuntimeCallContext,
    readonly control: AgentRunExecutionControl
  ) {}

  get runId(): AgentRun["id"] {
    return required(this.input.preparedRun).id;
  }

  delta(text: string): void {
    this.push({ type: "message_delta", ...this.next(), delta: text });
  }

  /** Stores the assistant message of the run as the runtime does, under the lease of the job. */
  assistantMessage(text: string): Promise<ChatMessage> {
    return this.control.conversationHistory.appendAssistantMessage({
      clientInstanceId: this.context.clientInstanceId,
      conversationId: this.input.conversationId,
      text
    });
  }

  /**
   * The answer that ends the run, as the runtime writes it: the message, then the event that
   * names it. The worker holds both back until the event that ends the run.
   */
  async finalMessage(text: string): Promise<ChatMessage> {
    const message = await this.control.conversationHistory.appendAssistantMessage({
      clientInstanceId: this.context.clientInstanceId,
      conversationId: this.input.conversationId,
      text,
      metadata: createAssistantFinalMetadata({
        runId: this.runId,
        reasoning: [],
        sources: [],
        citations: []
      })
    });
    this.push({
      type: "message_completed",
      ...this.next(),
      message: { id: message.id, role: "assistant", text, metadata: message.metadata }
    });
    return message;
  }

  complete(): void {
    this.push({ type: "run_completed", ...this.next() });
    this.end();
  }

  emit(event: (base: ReturnType<ControlledExecution["next"]>) => AgentRuntimeEvent): void {
    this.push(event(this.next()));
  }

  /** Ends the events without a terminal one. */
  end(): void {
    this.ended = true;
    this.wake?.();
  }

  readonly handle: AgentRunExecution = {
    events: this.events(),
    cancel: async (reason) => {
      this.cancelRequested.resolve(reason);
      this.push({ type: "run_cancelled", ...this.next(), ...(reason ? { reason } : {}) });
      this.end();
    }
  };

  private next() {
    this.sequence += 1;
    return { runId: this.runId, sequence: this.sequence, createdAt: new Date().toISOString() };
  }

  private push(event: AgentRuntimeEvent): void {
    this.queue.push(event);
    this.wake?.();
  }

  private async *events(): AsyncIterable<AgentRuntimeEvent> {
    for (;;) {
      const event = this.queue.shift();
      if (event) {
        yield event;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = undefined;
    }
  }
}

/** Starts no model and no tool: every execution waits for the test. */
class ControlledExecutor {
  readonly calls: ControlledExecution[] = [];
  private readonly waiting: Array<(execution: ControlledExecution) => void> = [];
  private taken = 0;

  readonly execute: ExecuteAgentRun = async (input, context, control) => {
    const execution = new ControlledExecution(input, context, control);
    this.calls.push(execution);
    this.waiting.shift()?.(execution);
    return execution.handle;
  };

  /** The next execution a worker starts, in the order they started. */
  async next(): Promise<ControlledExecution> {
    const index = this.taken;
    this.taken += 1;
    const started = this.calls[index];
    if (started) return started;
    return new Promise<ControlledExecution>((resolve) => {
      this.waiting.push(resolve);
    });
  }
}
