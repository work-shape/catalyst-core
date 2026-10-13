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
import type { Route } from "../http/route";
import type { ChatServerOptions } from "../types";

/**
 * What a Guardrail's page reads beyond the asset: its hits. The right is the Guardrail's own
 * read right, decided on the Guardrail the call names. `name` is the one field the route reads.
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
  async function authorizeOn(access: ActorAccess, name: string): Promise<OperationAuthorization> {
    const asset = await stored(name);
    const resource = asset
      ? accessResource(GUARDRAIL_ASSET_KIND, name, asset.scope, asset.id)
      : { kind: GUARDRAIL_ASSET_KIND, name };
    return decide(access, GUARDRAIL_ACTIONS.read, resource);
  }

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
