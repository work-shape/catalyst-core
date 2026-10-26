import {
  WORKFLOW_ASSET_KIND,
  asUserId,
  callerCanConfirm,
  isPrincipalGrantableAction,
  type AuthenticatedUser,
  type DelegatedActor,
  type OperationDraftContext,
  type OperationRun,
  type WorkflowManifest,
  type OperationRegistry,
  type PlatformStores,
  type WorkflowRun,
  type WorkflowStepRun
} from "@work-shape/catalyst-core";
import { resolveWorkflowNeededRights } from "./needed-rights";
import { workflowRunActor } from "./run-identity";
import { WorkflowStepFailure } from "./step-failure";

// Who a step of a test run calls as (ADR-0031). A test run of a draft acts as the person who
// started it, bounded by the Workflow's service principal: a call is allowed only where both
// hold its right. The call carries the draft context, so `runOperation()` decides its target:
// a reading step reads live, a changing step is simulated unless "Run live once" covers it.

/** The `authSource` of the tester as a step of a test run calls: no request carries it. */
const WORKFLOW_TEST_RUN_AUTH_SOURCE = "workflow_test_run";

/** The codes a step of a test run fails with where the run cannot act any more. */
export const WORKFLOW_TEST_RUN_ERRORS = {
  /** The principal the draft names was disabled or removed: a test run never acts as it. */
  runAsDisabled: "run_as_disabled",
  /** The person who started the test run is no active user any more. */
  testerInactive: "tester_inactive",
  /** The Workflow whose draft is tested was deleted. */
  draftGone: "draft_gone",
  /** The person testing does not hold a right a step needs, whether the principal does or not. */
  testerMissingRight: "tester_missing_right",
  /** The personal API key that started the test run was revoked or expired since. */
  testerKeyUnusable: "tester_key_unusable"
} as const;

type TestRunStores = Pick<
  PlatformStores,
  "apiAccess" | "users" | "configAssets" | "operationRuns" | "workflowRuns" | "personalApiKeys"
>;

/** The actor and the draft context of the call one step of a test run makes. */
export async function testRunCall(
  stores: TestRunStores,
  run: WorkflowRun,
  stepRun: Pick<WorkflowStepRun, "stepId">,
  definition: WorkflowManifest,
  registry: Pick<OperationRegistry, "resolveMany">
): Promise<{ actor: AuthenticatedUser; draft: OperationDraftContext }> {
  const { clientInstanceId } = run;
  const ownAccount = definition.runAs === undefined;
  const principal = ownAccount
    ? {
        kind: "service" as const,
        ...run.principal,
        workflowRunId: run.id,
        permissionRefs: [],
        permissions: [],
        clientInstanceId,
        authSource: "workflow_test_run",
        scopes: [],
        correlationId: run.correlationId
      }
    : await workflowRunActor(stores.apiAccess, run);
  if (!principal) {
    throw new WorkflowStepFailure(
      WORKFLOW_TEST_RUN_ERRORS.runAsDisabled,
      `The service principal '${run.principal.name}', which the Workflow runs as, is disabled or no longer exists, so the test run stops (run_as_disabled)`,
      { systemic: true }
    );
  }
  const tester =
    run.startedBy.kind === "user"
      ? await stores.users.getUser({ clientInstanceId, userId: asUserId(run.startedBy.id) })
      : undefined;
  if (tester?.status !== "active") {
    throw new WorkflowStepFailure(
      WORKFLOW_TEST_RUN_ERRORS.testerInactive,
      "The person who started the test run is no active user any more",
      { systemic: true }
    );
  }
  const asset = await stores.configAssets.getConfigAsset({
    clientInstanceId,
    kind: WORKFLOW_ASSET_KIND,
    name: run.workflow
  });
  if (asset?.status !== "active") {
    throw new WorkflowStepFailure(
      WORKFLOW_TEST_RUN_ERRORS.draftGone,
      `The Workflow '${run.workflow}' was deleted while its draft was tested`,
      { systemic: true }
    );
  }
  // The tester's start was their own confirmation where they called it themselves. A start an
  // agent made for them was not, until the person confirms it in their conversation (OP-3).
  const root =
    run.rootRunId === run.id
      ? run
      : await stores.workflowRuns.readRun({ clientInstanceId, id: run.rootRunId });
  const start =
    root?.operationRunId === undefined
      ? undefined
      : await stores.operationRuns.get({ clientInstanceId, id: root.operationRunId });
  const startConfirmed =
    start !== undefined && start.actor.id === tester.id && callerCanConfirm(start.origin);
  const key = await startingKey(stores, run, root, start, tester.id);
  const rights = ownAccount
    ? await resolveWorkflowNeededRights(
        {
          clientInstanceId,
          configAssets: stores.configAssets,
          registry: () => registry
        },
        definition
      )
    : undefined;
  return {
    actor: {
      id: tester.id,
      externalUserId: tester.identities[0]?.externalUserId ?? tester.id,
      displayLabel: tester.displayLabel,
      ...(tester.email === undefined ? {} : { email: tester.email }),
      roles: tester.roles,
      permissionRefs: tester.permissionRefs,
      permissions: tester.permissions,
      clientInstanceId,
      authSource: WORKFLOW_TEST_RUN_AUTH_SOURCE,
      correlationId: run.correlationId,
      // A test run a personal key started answers that key: its Connection calls are asked
      // as the key's own calls are, with exposure `outside` and the key's `connection.use`.
      ...(key ? { delegatedActor: key.actor, outsideKeyScopes: key.scopes } : {})
    },
    draft: {
      workflowRunId: run.id,
      // A test target reached from agent Try inherits its prohibition on Run live once.
      ...(start?.origin.kind === "agent" && start.origin.draft?.kind === "agent_preview"
        ? { kind: "agent_preview" as const }
        : {}),
      asset: { kind: WORKFLOW_ASSET_KIND, id: asset.id, name: asset.name },
      revisionId: run.definitionRevisionId,
      part: stepRun.stepId,
      boundBy: principal,
      ...(rights === undefined
        ? {}
        : {
            boundRights: rights.flatMap((right) =>
              isPrincipalGrantableAction(right.action) && right.asset.assetId !== undefined
                ? [{ action: right.action, assetId: right.asset.assetId }]
                : []
            )
          }),
      startConfirmed
    }
  };
}

/**
 * The personal API key that started the test run, with its scopes as they are now: the key of
 * the call that started its root, as that call's run or the run itself recorded it. A key that
 * was revoked or expired since stops the run, as it would refuse a call of its own. Nothing
 * where a person's own session started it.
 */
async function startingKey(
  stores: TestRunStores,
  run: WorkflowRun,
  root: WorkflowRun | undefined,
  start: OperationRun | undefined,
  testerId: string
): Promise<
  { actor: Extract<DelegatedActor, { kind: "api_key" }>; scopes: readonly string[] } | undefined
> {
  const actor = [start?.actor, root?.startedBy, run.startedBy]
    .map((candidate) => candidate?.delegatedActor)
    .find((candidate) => candidate?.kind === "api_key");
  if (actor?.kind !== "api_key") return undefined;
  const resolved = await stores.personalApiKeys.resolvePersonalApiKey({
    clientInstanceId: run.clientInstanceId,
    keyId: actor.id
  });
  const key = resolved?.key;
  if (
    !key ||
    key.ownerUserId !== testerId ||
    Boolean(key.revokedAt) ||
    Date.parse(key.expiresAt) <= Date.now()
  ) {
    throw new WorkflowStepFailure(
      WORKFLOW_TEST_RUN_ERRORS.testerKeyUnusable,
      "The API key that started the test run is revoked or expired, so the test run stops",
      { systemic: true }
    );
  }
  return { actor, scopes: key.scopes };
}
