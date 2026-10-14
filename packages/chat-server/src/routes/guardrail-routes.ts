import { apiOperations, GUARDRAIL_HITS_LIMIT } from "@vivd-catalyst/api-contract";
import {
  AppError,
  GUARDRAIL_ACTIONS,
  GUARDRAIL_ASSET_KIND,
  type ActorAccess,
  type OperationAuthorization,
  type OperationResource
} from "@vivd-catalyst/core";
import { accessResource, decide } from "../asset-access";
import { AssetWorkflow } from "../asset-workflow";
import { GuardrailRunner } from "../guardrail-runner";
import { dryRunGuardrail, guardrailUnderTrial, testGuardrail } from "../guardrail-trial";
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

  route.operation(apiOperations["guardrails.list_hits"], {
    authorize: (input, { access }) => authorizeOn(access, input.name),
    resource: guardrailResource,
    async execute(input) {
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
      // No hit names a person: hits are counted by rule and period, never listed by person.
      return {
        items: hits.slice(0, GUARDRAIL_HITS_LIMIT).map((hit) => ({
          id: hit.id,
          event: hit.event,
          outcome: hit.outcome,
          message: hit.message,
          subjectKind: hit.subjectKind,
          ...(hit.subjectId === undefined ? {} : { subjectId: hit.subjectId }),
          ...(hit.subjectName === undefined ? {} : { subjectName: hit.subjectName }),
          ...(hit.convertedFrom === undefined ? {} : { convertedFrom: hit.convertedFrom }),
          createdAt: hit.createdAt
        })),
        counts,
        hasMore: hits.length > GUARDRAIL_HITS_LIMIT
      };
    }
  });
}

/** What the call touches, as its run and its events name it. */
function guardrailResource(input: { name: string }): OperationResource {
  return { kind: GUARDRAIL_ASSET_KIND, id: input.name, name: input.name };
}
