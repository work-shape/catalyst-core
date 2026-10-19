import {
  apiOperations,
  GUARDRAIL_HITS_LIMIT,
  type ShippedGuardrailView
} from "@work-shape/catalyst-api-contract";
import {
  AppError,
  isAppError,
  GUARDRAIL_ACTIONS,
  GUARDRAIL_ASSET_KIND,
  SHIPPED_GUARDRAILS,
  auditActorFromIdentity,
  shippedGuardrail,
  type ActorAccess,
  type OperationAuthorization,
  type OperationExecutionContext,
  type OperationResource,
  type ShippedGuardrail,
  type ShippedGuardrailSwitch
} from "@work-shape/catalyst-core";
import { accessResource, decide } from "../assets/asset-access";
import { assetTitle } from "../assets/asset-reference-labels";
import { AssetWorkflow } from "../assets/asset-service";
import { GuardrailRunner } from "../guardrails/guardrail-runner";
import { dryRunGuardrail, guardrailUnderTrial, testGuardrail } from "../guardrails/guardrail-trial";
import type { Route } from "../http/route";
import type { ChatServerOptions } from "../types";

/** The module whose switch turns changing assets through the asset operations on and off. */
const ASSET_WRITE_MODULE = "assetManagement";

/**
 * What a Guardrail's page does beyond the asset operations: read its hits, test a revision,
 * count what it would have answered recently, and stop it enforcing. Each right is the
 * Guardrail's own, decided on the Guardrail the call names: `read` for the hits, `write` for a
 * test and a dry run, `publish` at its scope to stop it.
 */
export function registerGuardrailRoutes(route: Route, options: ChatServerOptions): void {
  const { clientInstanceId } = options;

  /** The Guardrail of this name, where one is stored and not deleted. */
  async function stored(name: string) {
    const asset = await options.stores.configAssets.getConfigAsset({
      clientInstanceId,
      kind: GUARDRAIL_ASSET_KIND,
      name
    });
    return asset?.status === "active" ? asset : undefined;
  }

  /** Decided on the stored Guardrail, or on the name alone where none carries it. */
  async function authorizeOn(
    access: ActorAccess,
    name: string,
    action: string = GUARDRAIL_ACTIONS.read
  ): Promise<OperationAuthorization> {
    const asset = await stored(name);
    const resource = asset
      ? accessResource(GUARDRAIL_ASSET_KIND, name, asset.scope, asset.id)
      : { kind: GUARDRAIL_ASSET_KIND, name };
    return decide(access, action, resource);
  }

  async function storedOrMissing(name: string) {
    const asset = await stored(name);
    if (!asset) throw new AppError("NOT_FOUND", `There is no Guardrail '${name}'`);
    return asset;
  }

  const workflow = new AssetWorkflow(options);
  // Trials keep no hit: the runner here is never asked an event.
  const runner = new GuardrailRunner({
    clientInstanceId,
    config: options.config,
    modelGateway: options.modelGateway,
    hits: { recordHits: () => Promise.resolve() }
  });
  const trialOptions = { ...options, workflow, runner };

  route.operation(apiOperations["guardrails.test"], {
    authorize: (input, { access }) => authorizeOn(access, input.name, GUARDRAIL_ACTIONS.write),
    resource: guardrailResource,
    async execute(input, context) {
      const asset = await storedOrMissing(input.name);
      const trial = await guardrailUnderTrial(options, asset, input.revision);
      return testGuardrail(trialOptions, context, trial, input);
    }
  });

  route.operation(apiOperations["guardrails.dry_run"], {
    authorize: (input, { access }) => authorizeOn(access, input.name, GUARDRAIL_ACTIONS.write),
    resource: guardrailResource,
    async execute(input, context) {
      const asset = await storedOrMissing(input.name);
      const trial = await guardrailUnderTrial(options, asset, input.revision);
      return dryRunGuardrail(
        trialOptions,
        context,
        trial,
        asset.publishedRevisionId !== undefined,
        options.operations?.now?.() ?? new Date()
      );
    }
  });

  route.operation(apiOperations["guardrails.unpublish"], {
    authorize: (input, { access }) => authorizeOn(access, input.name, GUARDRAIL_ACTIONS.publish),
    resource: guardrailResource,
    changeClass: "reversible",
    module: ASSET_WRITE_MODULE,
    async execute(input, context) {
      const asset = await storedOrMissing(input.name);
      return workflow.drafts.unpublish(context, {
        kind: GUARDRAIL_ASSET_KIND,
        name: input.name,
        ...(asset.scope.kind === "workspace" ? { workspaceId: asset.scope.workspaceId } : {})
      });
    }
  });

  // A shipped guardrail belongs to the instance: its right is asked at instance scope.
  route.operation(apiOperations["guardrails.list_shipped"], {
    authorize: (_input, { access }) => decide(access, GUARDRAIL_ACTIONS.read, INSTANCE_GUARDRAILS),
    async execute(_input, context) {
      const switches = await options.stores.guardrails.listShippedGuardrailSwitches({
        clientInstanceId
      });
      return {
        items: SHIPPED_GUARDRAILS.map((guardrail) =>
          shippedView(
            guardrail,
            switches.find((entry) => entry.name === guardrail.name),
            context.access.authorize(GUARDRAIL_ACTIONS.publish, shippedResource(guardrail.name))
              .allowed
          )
        )
      };
    }
  });

  route.operation(apiOperations["guardrails.switch_shipped"], {
    authorize: (input, { access }) =>
      decide(access, GUARDRAIL_ACTIONS.publish, shippedResource(input.name)),
    resource: (input) => shippedResource(input.name),
    changeClass: "reversible",
    async execute(input, context) {
      const guardrail = shippedGuardrail(input.name);
      if (!guardrail) {
        throw new AppError("NOT_FOUND", `The release ships no Guardrail '${input.name}'`);
      }
      const switched = await options.stores.guardrails.switchShippedGuardrail({
        clientInstanceId,
        name: guardrail.name,
        enabled: input.enabled,
        switchedBy: { id: context.actor.id, label: context.actor.displayLabel },
        switchedAt: (options.operations?.now?.() ?? new Date()).toISOString()
      });
      await context.audit.record({
        type: "guardrail.shipped_switched",
        status: "success",
        actor: auditActorFromIdentity(context.actor),
        correlationId: context.correlationId,
        metadata: { kind: GUARDRAIL_ASSET_KIND, name: guardrail.name, enabled: input.enabled }
      });
      return shippedView(guardrail, switched, true);
    }
  });

  /** A hit names only the revision this reader may open, in the reader's language. */
  async function readHitTitle(
    kind: string,
    name: string,
    subjectId: string | undefined,
    context: OperationExecutionContext
  ): Promise<string | undefined> {
    if (!options.configAssets.kinds.get(kind) || options.modules.offModuleOf("kind", kind))
      return undefined;
    try {
      const record = await options.configAssets.store.getConfigAsset({
        clientInstanceId,
        kind,
        name
      });
      if (
        !record ||
        record.status !== "active" ||
        (subjectId !== undefined && record.id !== subjectId)
      )
        return undefined;
      const read = await workflow.reads.get(context, {
        kind,
        name,
        ...(record.scope.kind === "workspace" ? { workspaceId: record.scope.workspaceId } : {})
      });
      return assetTitle(
        options.configAssets.kinds.kinds,
        kind,
        name,
        read.config,
        context.runtime.locale ?? options.config.localization.defaultLocale
      );
    } catch (error) {
      if (isAppError(error) && (error.code === "FORBIDDEN" || error.code === "NOT_FOUND"))
        return undefined;
      throw error;
    }
  }

  route.operation(apiOperations["guardrails.list_hits"], {
    authorize: (input, { access }) => authorizeOn(access, input.name),
    resource: guardrailResource,
    async execute(input, context) {
      if (!(await stored(input.name))) {
        throw new AppError("NOT_FOUND", `There is no Guardrail '${input.name}'`);
      }
      // One more than is answered tells whether older ones exist.
      const [hits, counts] = await Promise.all([
        options.stores.guardrails.listHits({
          clientInstanceId,
          guardrailName: input.name,
          limit: GUARDRAIL_HITS_LIMIT + 1
        }),
        options.stores.guardrails.countHits({ clientInstanceId, guardrailName: input.name })
      ]);
      const titles = new Map<string, Promise<string | undefined>>();
      const titleOf = (
        kind: string,
        name: string,
        subjectId?: string
      ): Promise<string | undefined> => {
        const key = `${kind}:${name}:${subjectId ?? ""}`;
        let title = titles.get(key);
        if (!title) {
          title = readHitTitle(kind, name, subjectId, context);
          titles.set(key, title);
        }
        return title;
      };
      // No hit names a person: hits are counted by rule and period, never listed by person.
      return {
        items: await Promise.all(
          hits.slice(0, GUARDRAIL_HITS_LIMIT).map(async (hit) => {
            const title =
              hit.subjectName === undefined
                ? undefined
                : await titleOf(hit.subjectKind, hit.subjectName, hit.subjectId);
            return {
              id: hit.id,
              event: hit.event,
              outcome: hit.outcome,
              message: hit.message,
              subjectKind: hit.subjectKind,
              ...(hit.subjectId === undefined ? {} : { subjectId: hit.subjectId }),
              ...(hit.subjectName === undefined ? {} : { subjectName: hit.subjectName }),
              ...(title === undefined ? {} : { subjectTitle: title }),
              ...(hit.convertedFrom === undefined ? {} : { convertedFrom: hit.convertedFrom }),
              createdAt: hit.createdAt
            };
          })
        ),
        counts,
        hasMore: hits.length > GUARDRAIL_HITS_LIMIT
      };
    }
  });
}

/** The guardrails of the instance, as a right on all of them is asked. */
const INSTANCE_GUARDRAILS = { kind: GUARDRAIL_ASSET_KIND };

/** A shipped guardrail as a right is asked on it: the instance's, with no workspace. */
function shippedResource(name: string): OperationResource {
  return { kind: GUARDRAIL_ASSET_KIND, id: name, name };
}

function shippedView(
  guardrail: ShippedGuardrail,
  switched: ShippedGuardrailSwitch | undefined,
  canSwitch: boolean
): ShippedGuardrailView {
  return {
    name: guardrail.name,
    displayName: guardrail.displayName,
    reason: guardrail.reason,
    on: [...guardrail.on],
    outcome: guardrail.outcome,
    enabled: switched?.enabled ?? true,
    ...(switched ? { switchedBy: switched.switchedBy, switchedAt: switched.switchedAt } : {}),
    canSwitch
  };
}

/** What the call touches, as its run and its events name it. */
function guardrailResource(input: { name: string }): OperationResource {
  return { kind: GUARDRAIL_ASSET_KIND, id: input.name, name: input.name };
}
