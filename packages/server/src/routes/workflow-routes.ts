import { apiOperations } from "@work-shape/catalyst-api-contract";
import {
  AppError,
  appWorkflowRefusalError,
  createPersonLabelLookup,
  requireUnmarkedConversation,
  WORKFLOW_ACTIONS,
  WORKFLOW_ASSET_KIND,
  isAuthenticatedServicePrincipal,
  isOutsideCall,
  type AccessResource,
  type ActorAccess,
  type AuthenticatedIdentity,
  type OperationAuthorization,
  type OperationOrigin,
  type OperationResource,
  type ClientInstanceId,
  type PlatformStores,
  type WorkflowRunError,
  type WorkflowRunStartedFrom,
  type WorkflowRunView,
  type WorkflowStepRunView
} from "@work-shape/catalyst-core";
import { paginate, pageScope, readablePage, storePage } from "../http/paging";
import { decide } from "../assets/asset-access";
import type { ModuleRoutes, RouteRegistration } from "../http/route";
import { listedWorkflowActions, workflowOf } from "../workflows/workflow-listing";
import type { WorkflowRunsPort } from "../workflows/workflow-runs-port";
import { connectionTitles, type AssetTitleSource } from "../publish-narrative/asset-titles";

type WorkflowSubjects = {
  clientInstanceId: ClientInstanceId;
  stores: {
    conversations: Pick<PlatformStores["conversations"], "getConversation" | "createdAsset">;
    /** Whose name a run shows as who started it, as it is now. Without it, the stored one. */
    users?: Pick<PlatformStores["users"], "getUser">;
  } & AssetTitleSource["stores"];
};

/** The module these operations belong to. */
const WORKFLOWS_MODULE = "workflows";

/** What a caller may do with a run, decided on the Workflow of the run or on no Workflow. */
type RunDecision = (
  run: WorkflowRunView | undefined,
  resource: AccessResource
) => OperationAuthorization;

/**
 * The runs of a Workflow: the start by hand, the test run of its draft, the reads and the cancel. Each is an operation
 * of the registry and brings its check, because the right is decided on the Workflow the
 * call or its run names. The right of the caller opens the call and nothing more: a run acts
 * with the grants of the service principal its Workflow names.
 *
 * The assembly registers them through the seam of the module, with the engine of the process.
 * Without an engine, which is an instance with the module off, the module gate refuses each
 * call before it reaches one of them.
 */
export function createWorkflowRoutes(
  workflows: WorkflowRunsPort | undefined,
  subjects: WorkflowSubjects
): RouteRegistration {
  return (route) => registerWorkflowRoutes(route, workflows, subjects);
}

function registerWorkflowRoutes(
  route: ModuleRoutes,
  workflows: WorkflowRunsPort | undefined,
  subjects: WorkflowSubjects
): void {
  function required(): WorkflowRunsPort {
    if (!workflows) throw new AppError("NOT_FOUND", "This instance has no Workflows");
    return workflows;
  }

  /**
   * Decided on the Workflow of the run, or on no Workflow where no run has the id. A run whose
   * Workflow refuses the caller is decided as one that does not exist, so a right or a deny on
   * one Workflow tells nobody which run ids there are: the caller is refused the same way, or
   * let through to the same `NOT_FOUND` (`runOf`).
   */
  async function authorizeOnRun(
    runId: string,
    decideOn: RunDecision
  ): Promise<OperationAuthorization> {
    const run = await workflows?.readRun(runId);
    const onRun = run ? decideOn(run, await resourceOf(run.workflow)) : undefined;
    return onRun?.allowed ? onRun : decideOn(undefined, { kind: WORKFLOW_ASSET_KIND });
  }

  /** The Workflow of this name as rights are decided on it, with its asset where it has one. */
  async function resourceOf(workflow: string): Promise<AccessResource> {
    return workflowOf(workflow, await workflows?.assetOf(workflow));
  }

  /**
   * The runs with the name of the person who started each as it is now: a deleted account's
   * is empty, which the interface shows as "Deleted account".
   */
  async function namedNow(runs: WorkflowRunView[]): Promise<WorkflowRunView[]> {
    const users = subjects.stores.users;
    if (!users) return runs;
    const labelOf = createPersonLabelLookup(users, subjects.clientInstanceId);
    return Promise.all(
      runs.map(async (run) =>
        run.startedBy.kind === "user"
          ? {
              ...run,
              startedBy: {
                ...run.startedBy,
                label: await labelOf(run.startedBy.id, run.startedBy.label)
              }
            }
          : run
      )
    );
  }

  /** The run, for a caller its Workflow lets through. Any other is told there is none. */
  async function runOf(runId: string, decideOn: RunDecision): Promise<WorkflowRunView> {
    const run = await required().readRun(runId);
    if (!run || !decideOn(run, await resourceOf(run.workflow)).allowed) {
      throw new AppError("NOT_FOUND", "There is no such Workflow Run");
    }
    return run;
  }

  /**
   * The runs or step runs with the display name of the Connection a refusal names, where the
   * reader may be shown it, so a failure never names a Connection by its machine name alone.
   */
  async function withConnectionTitles<View extends { error?: WorkflowRunError }>(
    access: ActorAccess,
    views: View[]
  ): Promise<View[]> {
    const titleOf = connectionTitles(subjects, access);
    return Promise.all(
      views.map(async (view) => {
        const connection = view.error?.connection;
        if (!view.error || connection === undefined) return view;
        const connectionTitle = await titleOf(connection);
        return connectionTitle === connection
          ? view
          : { ...view, error: { ...view.error, connectionTitle } };
      })
    );
  }

  const mayRead =
    (access: ActorAccess): RunDecision =>
    (_run, resource) =>
      decide(access, WORKFLOW_ACTIONS.read, resource);
  /**
   * Whoever may read its Workflow may read a run. An App frame also reads the run its viewer
   * started through one of its actions: the right to start is not the right to read, and the
   * App shows the starter what the Workflow answers whoever starts it. The frame admits only
   * runs of the Workflows its manifest starts.
   */
  const mayReadRun =
    (access: ActorAccess, actor: AuthenticatedIdentity, origin: OperationOrigin): RunDecision =>
    (run, resource) =>
      origin.kind === "app" && run && startedBy(run, actor)
        ? { allowed: true }
        : decide(access, WORKFLOW_ACTIONS.read, resource);
  /** Whoever started the run may end it, and whoever may write its Workflow. */
  const mayCancel =
    (access: ActorAccess, actor: AuthenticatedIdentity): RunDecision =>
    (run, resource) =>
      run && startedBy(run, actor)
        ? { allowed: true }
        : decide(access, WORKFLOW_ACTIONS.write, resource);

  /**
   * Whether the run's data may answer this caller, where its other rights let it read the run:
   * its result, its steps' outputs and logs, and the labels, run key and loop item label that
   * a step read. An outside client (an API credential, or a call made for one) reads them for
   * a run it started itself and for other runs only with `workflow.read_run_data`. A person
   * in the interface reads them as before.
   */
  function runDataReadable(
    run: WorkflowRunView,
    caller: { actor: AuthenticatedIdentity; origin: OperationOrigin },
    readRunData: boolean
  ): boolean {
    return (
      !isOutsideCall(caller.actor, caller.origin) ||
      readRunData ||
      startedByThisCredential(run, caller.actor)
    );
  }

  /**
   * A run a start or a test answers: one already holding its key may be somebody else's. An
   * outside client that may not read the Workflow is answered that run only where this very
   * credential started it. Any other is told what a Workflow that is not there tells it
   * (`missing`), so a run key names no run of a Workflow the credential cannot see.
   */
  async function startedRun(
    run: WorkflowRunView,
    context: { access: ActorAccess; actor: AuthenticatedIdentity; origin: OperationOrigin },
    missing: () => AppError
  ) {
    if (
      isOutsideCall(context.actor, context.origin) &&
      !startedByThisCredential(run, context.actor) &&
      !context.access.authorize(WORKFLOW_ACTIONS.read, await resourceOf(run.workflow)).allowed
    ) {
      throw missing();
    }
    const readable =
      runDataReadable(run, context, false) ||
      context.access.authorize(WORKFLOW_ACTIONS.readRunData, await resourceOf(run.workflow))
        .allowed;
    return forCaller(toRunResource(run, readable), readable);
  }

  route.operation(apiOperations["workflows.list"], {
    // The list is of what the caller may be shown: the right is asked of each Workflow below.
    authorize: () => ({ allowed: true }),
    module: WORKFLOWS_MODULE,
    // The published revision of an asset is shown to whoever reads it or uses it, as a read
    // of the asset shows it. A Workflow that cannot be started is listed all the same. Each
    // names what this caller may do with it, so a page offers a start only where one is let
    // through: the right on this Workflow and a credential whose scope reaches the call.
    execute: async (input, { access, actor }) => {
      const scope = pageScope("workflows.list", {}, input);
      const rows = await readablePage(
        storePage(input, ["id"], scope),
        (page) => required().listWorkflows(page),
        (workflow) =>
          listedWorkflowActions(access, actor, workflowOf(workflow.id, workflow.asset)).length > 0,
        (workflow) => [workflow.id]
      );
      const page = paginate(rows, input, ["id"], false, scope);
      return {
        ...page,
        items: page.items.flatMap(({ asset, ...workflow }) => {
          const actions = listedWorkflowActions(access, actor, workflowOf(workflow.id, asset));
          // The workspace that owns it, so a page names the owner (WS-OWN-1b).
          const owner =
            asset?.scope.kind === "workspace" ? { workspaceId: asset.scope.workspaceId } : {};
          return actions.length > 0 ? [{ ...workflow, ...owner, actions }] : [];
        })
      };
    }
  });

  route.operation(apiOperations["workflows.start"], {
    authorize: async (input, { access }) =>
      decide(access, WORKFLOW_ACTIONS.use, await resourceOf(input.workflow)),
    resource: workflowResource,
    module: WORKFLOWS_MODULE,
    execute: async (input, context) =>
      startedRun(
        await required().start({
          workflow: input.workflow,
          input: input.input,
          ...(input.key === undefined ? {} : { key: input.key }),
          startedBy: context.actor,
          operationRunId: context.runId,
          correlationId: context.correlationId
        }),
        context,
        () => appWorkflowRefusalError("workflow_unavailable", input.workflow)
      )
  });

  /**
   * An agent tests the conversation's subject Workflow, or a Workflow draft the conversation
   * created (BUILD-ALL-1). Refuses before a policy can prompt, and re-reads at dispatch after
   * any wait.
   */
  async function requireTestSubject(workflow: string, origin: OperationOrigin): Promise<void> {
    await requireUnmarkedConversation(subjects.stores, subjects.clientInstanceId, origin);
    if (origin.kind !== "agent") return;
    const conversation = await subjects.stores.conversations.getConversation(
      subjects.clientInstanceId,
      origin.conversationId
    );
    const isSubject =
      conversation?.subject?.kind === WORKFLOW_ASSET_KIND && conversation.subject.name === workflow;
    const testable =
      conversation?.status === "active" &&
      (isSubject ||
        (await subjects.stores.conversations.createdAsset({
          clientInstanceId: subjects.clientInstanceId,
          conversationId: conversation.id,
          kind: WORKFLOW_ASSET_KIND,
          name: workflow
        })));
    if (!testable) {
      throw new AppError(
        "FORBIDDEN",
        "An agent may test only the conversation's subject Workflow or a Workflow draft the conversation created",
        { reason: "workflow_not_subject" },
        { exposeMessage: true }
      );
    }
  }

  /**
   * Which revision a test run starts and the right that admits it. A person's own test runs
   * the draft and asks `workflow.write`. A click of a `workflow` action in an App's draft
   * (DP-1) runs the draft for a tester who may write the Workflow, and otherwise its published
   * revision, still in mode test, admitted by `workflow.use`: a draft never starts a live run.
   */
  function testRevisionOf(
    access: ActorAccess,
    resource: AccessResource,
    origin: OperationOrigin
  ): { revision: WorkflowRunStartedFrom["workflowRevision"]; decision: OperationAuthorization } {
    const write = decide(access, WORKFLOW_ACTIONS.write, resource);
    if (write.allowed || origin.kind !== "app") return { revision: "draft", decision: write };
    return { revision: "published", decision: decide(access, WORKFLOW_ACTIONS.use, resource) };
  }

  // A test run of the draft (ADR-0031). It acts as the person who starts it, bounded by the
  // Workflow's principal, so it needs the right to write the Workflow and nothing that lends
  // the principal's grants: publishing still asks that. Only a person starts one.
  route.operation(apiOperations["workflows.test"], {
    defaultPolicy: "allow",
    authorize: async (input, { access, actor, origin }) => {
      const decision: OperationAuthorization = isAuthenticatedServicePrincipal(actor)
        ? {
            allowed: false,
            action: WORKFLOW_ACTIONS.write,
            reason: "no_grant",
            message: "Only a person starts a test run of a Workflow's draft"
          }
        : testRevisionOf(access, await resourceOf(input.workflow), origin).decision;
      if (decision.allowed) await requireTestSubject(input.workflow, origin);
      return decision;
    },
    resource: workflowResource,
    module: WORKFLOWS_MODULE,
    execute: async (input, context) => {
      const { actor, origin } = context;
      // The check above refused every other caller; the types do not carry it here.
      if (isAuthenticatedServicePrincipal(actor)) {
        throw new AppError("FORBIDDEN", "Only a person starts a test run of a Workflow's draft");
      }
      await requireTestSubject(input.workflow, origin);
      const { revision } = testRevisionOf(context.access, await resourceOf(input.workflow), origin);
      return startedRun(
        await required().test({
          workflow: input.workflow,
          input: input.input,
          ...(input.key === undefined ? {} : { key: input.key }),
          startedBy: actor,
          operationRunId: context.runId,
          correlationId: context.correlationId,
          revision,
          ...(origin.kind === "app" && origin.appName !== undefined
            ? {
                startedFrom: {
                  kind: "app" as const,
                  app: origin.appName,
                  appRevisionId: origin.appRevisionId,
                  action: origin.actionName,
                  workflowRevision: revision
                }
              }
            : {})
        }),
        context,
        () =>
          revision === "draft"
            ? noWorkflowDraftError(input.workflow)
            : appWorkflowRefusalError("workflow_unavailable", input.workflow)
      );
    }
  });

  route.operation(apiOperations["workflows.list_runs"], {
    authorize: async (input, { access }) =>
      decide(access, WORKFLOW_ACTIONS.read, await resourceOf(input.workflow)),
    resource: workflowResource,
    module: WORKFLOWS_MODULE,
    execute: async (input, context) => {
      if (input.key !== undefined && input.keyPrefix !== undefined) {
        throw new AppError(
          "VALIDATION_FAILED",
          "'key' answers one run key and 'keyPrefix' the keys under a prefix: give one of them"
        );
      }
      const key =
        input.key !== undefined
          ? { exact: input.key }
          : input.keyPrefix !== undefined
            ? { prefix: input.keyPrefix }
            : undefined;
      const includeData = context.access.authorize(
        WORKFLOW_ACTIONS.readRunData,
        await resourceOf(input.workflow)
      ).allowed;
      // A prefix would spell out other people's run keys one character at a time.
      if (
        input.keyPrefix !== undefined &&
        !includeData &&
        isOutsideCall(context.actor, context.origin)
      ) {
        throw new AppError(
          "FORBIDDEN",
          "Listing runs by a key prefix with an API key needs the right to read the Workflow's run data",
          { reason: "no_grant", action: WORKFLOW_ACTIONS.readRunData },
          { exposeMessage: true }
        );
      }
      const listed = await required().listRuns({
        workflow: input.workflow,
        ...(key ? { key } : {}),
        ...(context.paging ? { page: context.paging } : {})
      });
      // A run key can be a value a person would not show, such as a client's address: asked by
      // its key, an outside client without the right finds only a run it started itself. One
      // key names one run, so this leaves no page short.
      const runs =
        key && !includeData && isOutsideCall(context.actor, context.origin)
          ? listed.filter((run) => startedByThisCredential(run, context.actor))
          : listed;
      return withConnectionTitles(
        context.access,
        (await namedNow(runs)).map((run) => {
          const readable = runDataReadable(run, context, includeData);
          return forCaller(
            toRunResource(run, (!run.hasAgentSteps || includeData) && readable),
            readable
          );
        })
      );
    }
  });

  route.operation(apiOperations["workflows.download_dataset"], {
    authorize: (input, { access, actor, origin }) =>
      authorizeOnRun(input.runId, (run, resource) =>
        run &&
        (isOutsideCall(actor, origin) ? startedByThisCredential(run, actor) : startedBy(run, actor))
          ? { allowed: true }
          : decide(access, WORKFLOW_ACTIONS.readRunData, resource)
      ),
    resource: runResource,
    module: WORKFLOWS_MODULE,
    recordsEveryCall: true,
    execute: async (input, context) => {
      const download = required().downloadDataset;
      if (!download) throw new AppError("NOT_FOUND", "Dataset downloads are not available");
      return download({
        ...input,
        actor: context.actor,
        access: context.access,
        correlationId: context.correlationId,
        ...(context.runtime.signal ? { signal: context.runtime.signal } : {})
      });
    }
  });

  // An agent step's transcript is the run's data: only a holder of `workflow.read_run_data`
  // reads it, one step at a time and bounded (CR-2, check 99).
  route.operation(apiOperations["workflows.get_step_transcript"], {
    authorize: (input, { access }) =>
      authorizeOnRun(input.runId, (_run, resource) =>
        decide(access, WORKFLOW_ACTIONS.readRunData, resource)
      ),
    resource: runResource,
    module: WORKFLOWS_MODULE,
    execute: async (input) => {
      const transcript = await required().readStepTranscript(input);
      if (!transcript) throw new AppError("NOT_FOUND", "There is no such agent step run");
      return transcript;
    }
  });

  route.operation(apiOperations["workflows.get_run"], {
    authorize: (input, { access, actor, origin }) =>
      authorizeOnRun(input.runId, mayReadRun(access, actor, origin)),
    resource: runResource,
    module: WORKFLOWS_MODULE,
    execute: async (input, { access, actor, origin }) => {
      const [run] = await namedNow([await runOf(input.runId, mayReadRun(access, actor, origin))]);
      if (!run) throw new AppError("NOT_FOUND", "There is no such Workflow Run");
      const readRunData = access.authorize(
        WORKFLOW_ACTIONS.readRunData,
        await resourceOf(run.workflow)
      ).allowed;
      const readable = runDataReadable(run, { actor, origin }, readRunData);
      const resource = forCaller(
        toRunResource(
          run,
          (!run.hasAgentSteps || (origin.kind === "app" && startedBy(run, actor)) || readRunData) &&
            readable
        ),
        readable
      );
      const [titled = resource] = await withConnectionTitles(access, [resource]);
      return titled;
    }
  });

  route.operation(apiOperations["workflows.list_step_runs"], {
    authorize: (input, { access }) => authorizeOnRun(input.runId, mayRead(access)),
    resource: runResource,
    module: WORKFLOWS_MODULE,
    execute: async (input, context) => {
      const run = await runOf(input.runId, mayRead(context.access));
      const { containerStepRunId, status, iteration } = input;
      const topLevel = input.topLevel === "true";
      if (topLevel && containerStepRunId !== undefined) {
        // A step run of a block stands in that block and so not at the top.
        throw new AppError(
          "VALIDATION_FAILED",
          "'topLevel' answers the step runs outside every block: it is not given with 'containerStepRunId'"
        );
      }
      if (iteration !== undefined && containerStepRunId === undefined) {
        // Every loop counts its items from zero, so a number alone names an item of each.
        throw new AppError(
          "VALIDATION_FAILED",
          "'iteration' names an item of one loop: give the 'containerStepRunId' of that loop's step run with it"
        );
      }
      const mayReadData = context.access.authorize(
        WORKFLOW_ACTIONS.readRunData,
        await resourceOf(run.workflow)
      ).allowed;
      const stepRuns = await required().listStepRuns({
        runId: run.id,
        includeAgentData: mayReadData,
        filter: {
          ...(topLevel ? { topLevel } : {}),
          ...(containerStepRunId === undefined ? {} : { containerStepRunId }),
          ...(status === undefined ? {} : { status }),
          ...(iteration === undefined ? {} : { iteration })
        },
        ...(context.paging ? { page: context.paging } : {})
      });
      const outputsReadable = runDataReadable(run, context, mayReadData);
      return withConnectionTitles(
        context.access,
        stepRuns.map((step) => {
          const { outputPreview, log, ...summary } = toStepRunResource(step, mayReadData);
          if (!outputsReadable) return withoutIterationLabel(summary);
          if (run.hasAgentSteps && !mayReadData) return summary;
          // The mail a simulated or test send would send, subject and body, is the run's data.
          const mailPreview = step.sendsMail === true && step.target !== "live";
          return {
            ...summary,
            ...(outputPreview && (mayReadData || !mailPreview) ? { outputPreview } : {}),
            ...(log ? { log } : {})
          };
        })
      );
    }
  });

  route.operation(apiOperations["workflows.cancel_run"], {
    authorize: (input, { access, actor }) => authorizeOnRun(input.runId, mayCancel(access, actor)),
    resource: runResource,
    module: WORKFLOWS_MODULE,
    execute: async (input, context) => {
      await runOf(input.runId, mayCancel(context.access, context.actor));
      const run = await required().cancel({
        runId: input.runId,
        cancelledBy: context.actor,
        correlationId: context.correlationId
      });
      if (!run) throw new AppError("NOT_FOUND", "There is no such Workflow Run");
      const readRunData = context.access.authorize(
        WORKFLOW_ACTIONS.readRunData,
        await resourceOf(run.workflow)
      ).allowed;
      const readable = runDataReadable(run, context, readRunData);
      return forCaller(
        toRunResource(
          run,
          (!run.hasAgentSteps ||
            (context.origin.kind === "app" && startedBy(run, context.actor)) ||
            readRunData) &&
            readable
        ),
        readable
      );
    }
  });
}

/** What a test run of a Workflow without a draft is answered. */
export function noWorkflowDraftError(workflow: string): AppError {
  return new AppError("NOT_FOUND", `There is no Workflow '${workflow}'`);
}

function startedBy(run: WorkflowRunView, actor: AuthenticatedIdentity): boolean {
  const kind = isAuthenticatedServicePrincipal(actor) ? "service_principal" : "user";
  return run.startedBy.kind === kind && run.startedBy.id === actor.id;
}

/**
 * Whether the very credential of the call started the run: the service principal, or the
 * person's same API key. A run the person started in the interface, or with another key, was
 * not started by this key, and its steps were never asked what this key may carry.
 */
function startedByThisCredential(run: WorkflowRunView, actor: AuthenticatedIdentity): boolean {
  if (!startedBy(run, actor)) return false;
  if (isAuthenticatedServicePrincipal(actor)) return true;
  const key = actor.delegatedActor;
  const recorded = run.startedBy.delegatedActor;
  return key?.kind === "api_key" && recorded?.kind === "api_key" && recorded.id === key.id;
}

/** A run as the API answers it: without the instance and the correlation id it carries. */
function toRunResource(run: WorkflowRunView, includeData = true) {
  const {
    clientInstanceId: _instance,
    correlationId: _correlation,
    principal,
    outputPreview,
    hasAgentSteps: _hasAgentSteps,
    datasets,
    ...resource
  } = run;
  return {
    ...resource,
    ...(includeData && outputPreview ? { outputPreview } : {}),
    ...(includeData && datasets ? { datasets } : {}),
    principal: { id: principal.id, name: principal.name, displayLabel: principal.displayLabel },
    startedBy: { kind: run.startedBy.kind, id: run.startedBy.id, label: run.startedBy.label }
  };
}

/**
 * A run with its labels, its run key and the label of the loop item that started it only
 * where the run's data is for the caller: each is a value a step or the trigger read.
 */
function forCaller<Resource extends { itemLabel?: string; labels?: unknown; runKey?: string }>(
  resource: Resource,
  readable: boolean
): Omit<Resource, "itemLabel" | "labels" | "runKey"> {
  if (readable) return resource;
  const { itemLabel: _label, labels: _labels, runKey: _key, ...rest } = resource;
  return rest;
}

/** A step run without the label of its loop item, a field of the items a step read. */
function withoutIterationLabel<Step extends { iteration?: { index: number; label?: string } }>(
  step: Step
): Step {
  return step.iteration ? { ...step, iteration: { index: step.iteration.index } } : step;
}

/**
 * A step run as the API answers it: without the instance it belongs to, and with its input
 * only for a caller who may read the run's data (`workflow.read_run_data`).
 */
function toStepRunResource(stepRun: WorkflowStepRunView, runData: boolean) {
  const { clientInstanceId: _instance, inputPreview, sendsMail: _sendsMail, ...resource } = stepRun;
  return runData && inputPreview ? { ...resource, inputPreview } : resource;
}

/** What a call on a Workflow touches, as its run and its events name it. */
function workflowResource(input: { workflow: string }): OperationResource {
  return { kind: WORKFLOW_ASSET_KIND, id: input.workflow, name: input.workflow };
}

/** What a call on a run touches. The Workflow of the run is what its right is decided on. */
function runResource(input: { runId: string }): OperationResource {
  return { kind: "workflow_run", id: input.runId };
}
