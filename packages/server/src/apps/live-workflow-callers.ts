import { compiledActionsOf } from "@work-shape/catalyst-app-build";
import { APP_ASSET_KIND } from "@work-shape/catalyst-api-contract";
import type { ActorAccess, ClientInstanceId, PlatformStores } from "@work-shape/catalyst-core";
import { z } from "zod";
import { accessResource } from "../assets/asset-access";

/** How many published Apps one read of the store asks for. */
const PAGE = 200;

const publishedAppSchema = z.object({
  title: z.string().optional(),
  manifest: z.unknown()
});

/**
 * One warning for each published App whose `workflow` actions start this Workflow: what an
 * unpublish or a delete of the Workflow answers beside its result (DP-0). Those Apps stay
 * live, and their action answers `workflow_unavailable` with the Workflow named until it is
 * published again. Read from the published revisions each time, so no second record can fall
 * behind them. An App the caller may not read is not named: those are counted in one warning.
 */
export async function workflowLiveCallerWarnings(input: {
  clientInstanceId: ClientInstanceId;
  name: string;
  stores: Pick<PlatformStores, "configAssets">;
  /** What the caller may do: an App it may not read is counted, never named. */
  access: Pick<ActorAccess, "authorize">;
}): Promise<{ code: string; message: string }[]> {
  const warnings: { code: string; message: string }[] = [];
  let unreadable = 0;
  let afterName: string | undefined;
  for (;;) {
    const apps = await input.stores.configAssets.listPublishedConfigAssets({
      clientInstanceId: input.clientInstanceId,
      kind: APP_ASSET_KIND,
      limit: PAGE,
      ...(afterName === undefined ? {} : { afterName })
    });
    for (const app of apps) {
      const published = publishedAppSchema.safeParse(app.publishedConfig).data;
      const starts = compiledActionsOf(published?.manifest).some(
        (action) => action.kind === "workflow" && action.workflow === input.name
      );
      if (!starts) continue;
      const resource = accessResource(
        APP_ASSET_KIND,
        app.name,
        app.scope,
        app.id,
        app.appAvailability
      );
      if (!input.access.authorize(`${APP_ASSET_KIND}.read`, resource).allowed) {
        unreadable += 1;
        continue;
      }
      warnings.push({
        code: "live_app_starts_workflow",
        message: `The published App '${published?.title ?? app.name}' (${app.name}) starts this Workflow. Its action answers workflow_unavailable until the Workflow is published again.`
      });
    }
    if (apps.length < PAGE) break;
    afterName = apps.at(-1)?.name;
  }
  if (unreadable > 0)
    warnings.push({
      code: "live_app_starts_workflow",
      message:
        unreadable === 1
          ? "A published App you may not open starts this Workflow. Its action answers workflow_unavailable until the Workflow is published again."
          : `${unreadable} published Apps you may not open start this Workflow. Their actions answer workflow_unavailable until the Workflow is published again.`
    });
  return warnings;
}
