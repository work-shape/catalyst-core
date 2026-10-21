import { compiledActionsOf } from "@work-shape/catalyst-app-build";
import { APP_ASSET_KIND } from "@work-shape/catalyst-api-contract";
import type { ClientInstanceId, PlatformStores } from "@work-shape/catalyst-core";
import { z } from "zod";

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
 * behind them.
 */
export async function workflowLiveCallerWarnings(input: {
  clientInstanceId: ClientInstanceId;
  name: string;
  stores: Pick<PlatformStores, "configAssets">;
}): Promise<{ code: string; message: string }[]> {
  const warnings: { code: string; message: string }[] = [];
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
      warnings.push({
        code: "live_app_starts_workflow",
        message: `The published App '${published?.title ?? app.name}' (${app.name}) starts this Workflow. Its action answers workflow_unavailable until the Workflow is published again.`
      });
    }
    if (apps.length < PAGE) return warnings;
    afterName = apps.at(-1)?.name;
  }
}
