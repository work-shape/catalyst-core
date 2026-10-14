import { apiOperations } from "@vivd-catalyst/api-contract";
import {
  AppError,
  WORKFLOW_ACTIONS,
  WORKFLOW_ASSET_KIND,
  isAuthenticatedServicePrincipal,
  type AccessResource,
  type ActorAccess,
  type AuthenticatedIdentity,
  type OperationAuthorization,
  type OperationOrigin,
  type OperationResource,
  type WorkflowRunView,
  type WorkflowStepRunView
} from "@vivd-catalyst/core";
import { decide } from "../asset-access";
import type { ModuleRoutes, RouteRegistration } from "../http/route";
import { listedWorkflowActions, workflowOf } from "../workflow-listing";
import type { WorkflowRunsPort } from "../workflow-runs-port";

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
export function createWorkflowRoutes(workflows: WorkflowRunsPort | undefined): RouteRegistration {
  return (route) => registerWorkflowRoutes(route, workflows);
}

function registerWorkflowRoutes(
  route: ModuleRoutes,
  workflows: WorkflowRunsPort | undefined
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
    return workflowOf(workflow, await workflows?.assetIdOf(workflow));
  }

  /** The run, for a caller its Workflow lets through. Any other is told there is none. */
  async function runOf(runId: string, decideOn: RunDecision): Promise<WorkflowRunView> {
    const run = await required().readRun(runId);
    if (!run || !decideOn(run, await resourceOf(run.workflow)).allowed) {
      throw new AppError("NOT_FOUND", "There is no such Workflow Run");
    }
    return run;
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

  route.operation(apiOperations["workflows.list"], {
    // The list is of what the caller may be shown: the right is asked of each Workflow below.
    authorize: () => ({ allowed: true }),
    module: WORKFLOWS_MODULE,
    // The published revision of an asset is shown to whoever reads it or uses it, as a read
    // of the asset shows it. A Workflow that cannot be started is listed all the same. Each
    // names what this caller may do with it, so a page offers a start only where one is let
    // through: the right on this Workflow and a credential whose scope reaches the call.
    execute: async (_input, { access, actor }) => ({
      items: (await required().listWorkflows()).flatMap(({ assetId, ...workflow }) => {
        const actions = listedWorkflowActions(access, actor, workflowOf(workflow.id, assetId));
        return actions.length > 0 ? [{ ...workflow, actions }] : [];
      })
    })
  });

  route.operation(apiOperations["workflows.start"], {
    authorize: async (input, { access }) =>
      decide(access, WORKFLOW_ACTIONS.use, await resourceOf(input.workflow)),
    resource: workflowResource,
    module: WORKFLOWS_MODULE,
    execute: async (input, context) =>
      toRunResource(
        await required().start({
          workflow: input.workflow,
          input: input.input,
          startedBy: context.actor,
          operationRunId: context.runId,
          correlationId: context.correlationId
        })
      )
  });

  // A test run of the draft (ADR-0031). It acts as the person who starts it, bounded by the
  // Workflow's principal, so it needs the right to write the Workflow and nothing that lends
  // the principal's grants: publishing still asks that. Only a person starts one.
  route.operation(apiOperations["workflows.test"], {
    authorize: async (input, { access, actor }) =>
      isAuthenticatedServicePrincipal(actor)
        ? {
            allowed: false,
            action: WORKFLOW_ACTIONS.write,
            reason: "no_grant",
            message: "Only a person starts a test run of a Workflow's draft"
          }
        : decide(access, WORKFLOW_ACTIONS.write, await resourceOf(input.workflow)),
    resource: workflowResource,
    module: WORKFLOWS_MODULE,
    execute: async (input, context) => {
      const { actor } = context;
      // The check above refused every other caller; the types do not carry it here.
      if (isAuthenticatedServicePrincipal(actor)) {
        throw new AppError("FORBIDDEN", "Only a person starts a test run of a Workflow's draft");
      }
      return toRunResource(
        await required().test({
          workflow: input.workflow,
          input: input.input,
          startedBy: actor,
          operationRunId: context.runId,
          correlationId: context.correlationId
        })
      );
    }
  });

  route.operation(apiOperations["workflows.list_runs"], {
    authorize: async (input, { access }) =>
      decide(access, WORKFLOW_ACTIONS.read, await resourceOf(input.workflow)),
    resource: workflowResource,
    module: WORKFLOWS_MODULE,
    execute: async (input, context) =>
      (
        await required().listRuns({
          workflow: input.workflow,
          ...(context.paging ? { page: context.paging } : {})
        })
      ).map(toRunResource)
  });

  route.operation(apiOperations["workflows.get_run"], {
    authorize: (input, { access, actor, origin }) =>
      authorizeOnRun(input.runId, mayReadRun(access, actor, origin)),
    resource: runResource,
    module: WORKFLOWS_MODULE,
    execute: async (input, { access, actor, origin }) =>
      toRunResource(await runOf(input.runId, mayReadRun(access, actor, origin)))
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
      const stepRuns = await required().listStepRuns({
        runId: run.id,
        filter: {
          ...(topLevel ? { topLevel } : {}),
          ...(containerStepRunId === undefined ? {} : { containerStepRunId }),
          ...(status === undefined ? {} : { status }),
          ...(iteration === undefined ? {} : { iteration })
        },
        ...(context.paging ? { page: context.paging } : {})
      });
      return stepRuns.map(toStepRunResource);
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
      return toRunResource(run);
    }
  });
}

function startedBy(run: WorkflowRunView, actor: AuthenticatedIdentity): boolean {
  const kind = isAuthenticatedServicePrincipal(actor) ? "service_principal" : "user";
  return run.startedBy.kind === kind && run.startedBy.id === actor.id;
}

/** A run as the API answers it: without the instance and the correlation id it carries. */
function toRunResource(run: WorkflowRunView) {
  const {
    clientInstanceId: _instance,
    correlationId: _correlation,
    liveSteps: _liveSteps,
    principal,
    ...resource
  } = run;
  return {
    ...resource,
    principal: { id: principal.id, name: principal.name, displayLabel: principal.displayLabel },
    startedBy: { kind: run.startedBy.kind, id: run.startedBy.id, label: run.startedBy.label }
  };
}

/** A step run as the API answers it: without the instance it belongs to. */
function toStepRunResource(stepRun: WorkflowStepRunView) {
  const { clientInstanceId: _instance, ...resource } = stepRun;
  return resource;
}

/** What a call on a Workflow touches, as its run and its events name it. */
function workflowResource(input: { workflow: string }): OperationResource {
  return { kind: WORKFLOW_ASSET_KIND, id: input.workflow, name: input.workflow };
}

/** What a call on a run touches. The Workflow of the run is what its right is decided on. */
function runResource(input: { runId: string }): OperationResource {
  return { kind: "workflow_run", id: input.runId };
}
