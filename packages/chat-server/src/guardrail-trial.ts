import {
  GUARDRAIL_DRY_RUN_DAYS,
  GUARDRAIL_DRY_RUN_JUDGE_MAX,
  GUARDRAIL_DRY_RUN_PATTERN_MAX,
  type DryRunGuardrailResponse,
  type TestGuardrailRequest,
  type TestGuardrailResponse
} from "@vivd-catalyst/api-contract";
import { guardrailConfigSchema } from "@vivd-catalyst/config-schema";
import {
  AppError,
  GUARDRAIL_ASSET_KIND,
  GUARDRAIL_CHECKABLE_FIELDS,
  getSubjectUserId,
  isAuthenticatedServicePrincipal,
  liveRevisionId,
  type ConfigAssetRecord,
  type GuardrailEvent,
  type GuardrailFields,
  type GuardrailFilter,
  type GuardrailOutcome
} from "@vivd-catalyst/core";
import type { AssetCall } from "./asset-access";
import { storedRevisionFields } from "./asset-guardrail-events";
import type { AssetWorkflow } from "./asset-workflow";
import type { GuardrailCallContext, GuardrailOfAsset, GuardrailRunner } from "./guardrail-runner";
import type { AssetWorkflowOptions } from "./types";

// A guardrail tried before it enforces: `guardrails.test` on sample content or on an asset, and
// `guardrails.dry_run` over the recent events of its event. Both answer what it would have
// answered, keep no hit and no content, and name no person. A judge's usage is the guardrail's
// scope's, as when it enforces.

type TrialOptions = Pick<
  AssetWorkflowOptions,
  "clientInstanceId" | "configAssets" | "stores" | "pages"
>;

/** The revision of a guardrail a trial reads: its draft unless the call names one. */
export async function guardrailUnderTrial(
  options: TrialOptions,
  asset: ConfigAssetRecord,
  revision: number | undefined
): Promise<GuardrailOfAsset> {
  const number = revision ?? asset.revision;
  const stored =
    number === asset.revision && asset.config !== null
      ? asset.config
      : (
          await options.configAssets.store.getConfigAssetRevision({
            clientInstanceId: options.clientInstanceId,
            kind: GUARDRAIL_ASSET_KIND,
            name: asset.name,
            revision: number
          })
        )?.config;
  const parsed = guardrailConfigSchema.safeParse(stored);
  if (!stored || !parsed.success) {
    throw new AppError("NOT_FOUND", `Guardrail '${asset.name}' has no revision ${number} to try`, {
      reason: "revision_unknown",
      revision: number
    });
  }
  return { guardrail: parsed.data, scope: asset.scope, revision: number };
}

/** Who a trial's model calls are counted for: the person, and the guardrail's scope. */
function trialContext(call: AssetCall): GuardrailCallContext {
  return {
    correlationId: call.correlationId,
    ...(isAuthenticatedServicePrincipal(call.actor) ? {} : { userId: getSubjectUserId(call.actor) })
  };
}

/**
 * What a revision of a guardrail answers on sample content, given by the fields its event
 * declares, or on the revision of an asset the caller reads, as its write is read.
 */
export async function testGuardrail(
  options: TrialOptions & { workflow: AssetWorkflow; runner: GuardrailRunner },
  call: AssetCall,
  trial: GuardrailOfAsset,
  input: TestGuardrailRequest
): Promise<TestGuardrailResponse> {
  const { guardrail } = trial;
  const event = guardrail.on;
  if ((input.sample === undefined) === (input.asset === undefined)) {
    throw new AppError(
      "VALIDATION_FAILED",
      "A test checks either sample content or one asset: give 'sample' or 'asset'",
      { reason: "sample_or_asset" }
    );
  }
  let fields: GuardrailFields;
  let appliesToAsset: boolean | undefined;
  if (input.sample !== undefined) {
    const declared: readonly string[] = GUARDRAIL_CHECKABLE_FIELDS[event];
    const unknown = Object.keys(input.sample).filter((field) => !declared.includes(field));
    if (unknown.length > 0) {
      throw new AppError(
        "VALIDATION_FAILED",
        `'${event}' has no field ${unknown.map((field) => `'${field}'`).join(", ")} to check. It has ${declared.map((field) => `'${field}'`).join(", ")}`,
        { reason: "unknown_field" }
      );
    }
    fields = input.sample;
  } else {
    const named = input.asset;
    if (!named) throw new Error("unreachable: a test names sample or asset");
    if (!ASSET_EVENTS.includes(event)) {
      throw new AppError(
        "VALIDATION_FAILED",
        `A guardrail on '${event}' reads no asset: test it on sample content`,
        { reason: "event_reads_no_asset" }
      );
    }
    const target = await assetReadBy(options, call, named);
    const read = await storedRevisionFields(options, {
      kind: named.kind,
      name: named.name,
      revision: target.revision,
      assetId: target.asset.id
    });
    if (!read) {
      throw new AppError(
        "NOT_FOUND",
        `${named.kind} '${named.name}' has no revision ${target.revision} to check`
      );
    }
    fields = read;
    appliesToAsset = options.runner.appliesTo(trial, {
      kind: named.kind,
      ...(target.asset.scope.kind === "workspace"
        ? { workspace: target.asset.scope.workspaceId }
        : {})
    });
  }
  const answer = await options.runner.evaluate(trial, fields, trialContext(call));
  return {
    revision: trial.revision,
    event,
    outcome: answer.outcome,
    reason: answer.reason,
    ...(appliesToAsset === undefined ? {} : { appliesToAsset })
  };
}

/** The events whose subject is an asset revision a test or a dry run can read. */
const ASSET_EVENTS: readonly GuardrailEvent[] = [
  "asset.before_write",
  "app.before_publish",
  "workflow.before_publish",
  "data_store.before_publish"
];

/** The kind a publish event is about. */
const PUBLISH_KINDS: Partial<Record<GuardrailEvent, string>> = {
  "app.before_publish": "app",
  "workflow.before_publish": "workflow",
  "data_store.before_publish": "data_store"
};

/**
 * The asset a test names and the revision of it the caller may read: the live one unless a
 * number is named, which takes the right to read its drafts, as its history does.
 */
async function assetReadBy(
  options: TrialOptions & { workflow: AssetWorkflow },
  call: AssetCall,
  named: { kind: string; name: string; revision?: number }
): Promise<{ asset: ConfigAssetRecord; revision: number }> {
  const asset = await options.configAssets.store.getConfigAsset({
    clientInstanceId: options.clientInstanceId,
    kind: named.kind,
    name: named.name
  });
  const kind = options.configAssets.kinds.kinds.find((candidate) => candidate.kind === named.kind);
  const missing = new AppError("NOT_FOUND", `There is no ${named.kind} '${named.name}'`);
  if (!asset || asset.status !== "active" || !kind) throw missing;
  const address = {
    kind: named.kind,
    name: named.name,
    ...(asset.scope.kind === "workspace" ? { workspaceId: asset.scope.workspaceId } : {})
  };
  const read = await options.workflow.authorizeRead(call.access, address);
  // A caller who does not read it is told what a caller is told of no asset.
  if (!read.allowed) throw missing;
  const live =
    liveRevisionId(asset, kind) === asset.publishedRevisionId
      ? asset.publishedRevision
      : asset.revision;
  if (named.revision === undefined || named.revision === live) {
    if (live === undefined) throw missing;
    return { asset, revision: live };
  }
  const write = await options.workflow.authorizeWrite(call.access, address);
  if (!write.allowed) {
    call.access.require(kind.actions.write, {
      kind: named.kind,
      name: named.name,
      assetId: asset.id
    });
  }
  return { asset, revision: named.revision };
}

/**
 * What a revision of a guardrail would have answered over the last 14 days of its event, in
 * its scope and as its filter takes them: counts of actions and of people by outcome, no
 * names, no hit. A write or a publish of an asset is checked again on the revision it wrote
 * or published; a call of an operation and a request for an approval are counted and not
 * checked, since their content is not kept. A judge checks at most 200 of the newest.
 */
export async function dryRunGuardrail(
  options: TrialOptions & { runner: GuardrailRunner },
  call: AssetCall,
  trial: GuardrailOfAsset,
  published: boolean,
  now: Date
): Promise<DryRunGuardrailResponse> {
  const { guardrail, scope } = trial;
  const event = guardrail.on;
  const since = new Date(now.getTime() - GUARDRAIL_DRY_RUN_DAYS * 24 * 60 * 60 * 1000);
  const workspaceId = scope.kind === "workspace" ? scope.workspaceId : guardrail.filter?.workspace;
  const counts = {
    block: new Counted(),
    require_approval: new Counted(),
    warn: new Counted()
  } satisfies Record<Exclude<GuardrailOutcome, "allow">, Counted>;
  const result = (input: {
    matched: number;
    evaluated: number;
    notEvaluable: number;
    limitedTo?: number;
  }): DryRunGuardrailResponse => ({
    revision: trial.revision,
    event,
    outcome: guardrail.outcome,
    days: GUARDRAIL_DRY_RUN_DAYS,
    since: since.toISOString(),
    ...input,
    wouldBlock: counts.block.view(),
    wouldRequireApproval: counts.require_approval.view(),
    wouldWarn: counts.warn.view(),
    published
  });
  const filter: GuardrailFilter = guardrail.filter ?? {};
  if (event === "operation.before_call" || event === "approval_request.before_create") {
    const notEvaluable = await options.stores.guardrails.countRecentActions({
      clientInstanceId: options.clientInstanceId,
      action: event === "operation.before_call" ? "operation_call" : "approval_request",
      since,
      ...(filter.operation === undefined ? {} : { operation: filter.operation }),
      ...(filter.origin === undefined ? {} : { origin: filter.origin }),
      ...(filter.kind === undefined ? {} : { kind: filter.kind }),
      ...(workspaceId === undefined ? {} : { workspaceId })
    });
    return result({ matched: notEvaluable, evaluated: 0, notEvaluable });
  }
  const limit =
    guardrail.check.kind === "model_judge"
      ? GUARDRAIL_DRY_RUN_JUDGE_MAX
      : GUARDRAIL_DRY_RUN_PATTERN_MAX;
  const publishKind = PUBLISH_KINDS[event];
  const recent = await options.stores.guardrails.listRecentSubjects({
    clientInstanceId: options.clientInstanceId,
    action: publishKind === undefined ? "write" : "publish",
    since,
    ...(publishKind !== undefined
      ? { kinds: [publishKind] }
      : filter.kind !== undefined
        ? { kinds: [filter.kind] }
        : {}),
    // A guardrail never answers on the change of guardrails.
    excludeKinds: [GUARDRAIL_ASSET_KIND],
    ...(workspaceId === undefined ? {} : { workspaceId }),
    limit
  });
  // Where the call came from and which agent made it is not kept with a revision: a filter
  // that asks either cannot be decided on the past.
  const undecidable = filter.origin !== undefined || filter.agent !== undefined;
  if (undecidable) {
    return result({ matched: recent.total, evaluated: 0, notEvaluable: recent.total });
  }
  let evaluated = 0;
  let notEvaluable = 0;
  for (const subject of recent.subjects) {
    const fields = await storedRevisionFields(options, subject);
    if (!fields) {
      notEvaluable += 1;
      continue;
    }
    evaluated += 1;
    const answer = await options.runner.evaluate(trial, fields, trialContext(call));
    if (answer.outcome !== "allow") counts[answer.outcome].add(subject.actorKey);
  }
  return result({
    matched: recent.total,
    evaluated,
    notEvaluable,
    ...(recent.total > limit ? { limitedTo: limit } : {})
  });
}

/** Actions and the distinct people who took them, kept as keys and answered as counts. */
class Counted {
  private actions = 0;
  private readonly people = new Set<string>();

  add(actorKey: string | undefined): void {
    this.actions += 1;
    if (actorKey !== undefined) this.people.add(actorKey);
  }

  view(): { actions: number; people: number } {
    return { actions: this.actions, people: this.people.size };
  }
}
