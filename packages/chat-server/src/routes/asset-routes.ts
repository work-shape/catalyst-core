import { ASSET_SYNC_BODY_MAX_BYTES, apiOperations } from "@vivd-catalyst/api-contract";
import { asCollaborationWorkspaceId, type OperationResource } from "@vivd-catalyst/core";
import { ASSET_PUT_BODY_LIMIT_BYTES } from "../asset-files";
import {
  assetWriteEvent,
  publishEvents,
  revertWriteEvents,
  syncWriteEvents
} from "../asset-guardrail-events";
import { readDefinitionName } from "../asset-kinds/shared";
import { authorizeAssetPlacement, setAssetAvailability, setAssetDefault } from "../asset-placement";
import { AssetWorkflow } from "../asset-workflow";
import { ConfigAssetWorkflow } from "../config-asset-workflow";
import type { Route } from "../http/route";
import type { ChatServerOptions } from "../types";

/** The module whose switch turns changing assets through these operations on and off. */
const ASSET_WRITE_MODULE = "assetManagement";

/**
 * One asset of any registered kind, and the two reads of the instance's agents and skills as
 * a whole, which are plain reads. Each call on an asset is an Operation Run. The right is the kind's
 * own and is decided on the asset the call names, so every operation brings its check: the
 * registry asks it before the policy, and the workflow asks it again on the asset it loaded.
 * The policy is asked about the kind, the owner and the Namespace of every asset a call names.
 */
export function registerAssetRoutes(route: Route, options: ChatServerOptions): void {
  const workflow = new AssetWorkflow(options);

  route.operation(apiOperations["assets.list"], {
    // The list decides the right per asset. A caller without one receives an empty page.
    authorize: () => ({ allowed: true }),
    execute: (input, context) => workflow.reads.list(context, input, context.paging)
  });

  route.operation(apiOperations["assets.sync"], {
    // The right is decided per item, each as its own write or delete, before the policy.
    authorize: (input, { actor, access }) => workflow.authorizeSync(actor, access, input),
    policyTargets: (input) => workflow.syncPolicyTargets(input),
    changeClass: "reversible",
    // No module: a release is pushed through this operation also where changing assets in
    // the interface is off. The workflow asks the switch of everyone but the release holder.
    bodyLimitBytes: ASSET_SYNC_BODY_MAX_BYTES,
    beforeEvents: syncWriteEvents,
    execute: (input, context) => workflow.sync(context, input)
  });

  route.operation(apiOperations["assets.sync_check"], {
    // Decided as for the sync itself: a batch its caller may not make is not checked either.
    authorize: (input, { actor, access }) => workflow.authorizeSync(actor, access, input),
    policyTargets: (input) => workflow.syncPolicyTargets(input),
    bodyLimitBytes: ASSET_SYNC_BODY_MAX_BYTES,
    execute: (input, context) => workflow.checkSync(context, input)
  });

  route.operation(apiOperations["assets.set_default"], {
    authorize: (input, { access }) => authorizeAssetPlacement(options, access, input),
    resource: ({ kind, name }) => assetResource({ kind, name: name ?? undefined }),
    policyTargets: (input) => workflow.policyTargets({ ...input, name: input.name ?? undefined }),
    changeClass: "reversible",
    module: ASSET_WRITE_MODULE,
    execute: (input, context) => setAssetDefault(options, context, input)
  });

  route.operation(apiOperations["assets.validate"], {
    authorize: (input, { access }) => workflow.authorizeValidate(access, input),
    resource: (input) => assetResource({ ...input, name: readDefinitionName(input.config) }),
    policyTargets: (input) =>
      workflow.policyTargets({ ...input, name: readDefinitionName(input.config) }),
    execute: (input, context) => workflow.validate(context, input)
  });

  route.operation(apiOperations["assets.get"], {
    authorize: ({ files, ...input }, { access }) =>
      workflow.reads.authorizeGet(access, { ...input, files: files === "true" }),
    resource: assetResource,
    policyTargets: (input) => workflow.policyTargets(input),
    execute: ({ files, ...input }, context) =>
      workflow.reads.get(context, { ...input, files: files === "true" })
  });

  route.operation(apiOperations["assets.put"], {
    authorize: (input, { access }) => workflow.authorizeRevisionWrite(access, input, "write"),
    resource: assetResource,
    policyTargets: (input) => workflow.policyTargets(input),
    changeClass: "reversible",
    module: ASSET_WRITE_MODULE,
    bodyLimitBytes: ASSET_PUT_BODY_LIMIT_BYTES,
    beforeEvents: ({ kind, name, config, files }) => [
      assetWriteEvent({ kind, name, config, files })
    ],
    execute: (input, context) => workflow.put(context, input)
  });

  route.operation(apiOperations["assets.publish"], {
    authorize: (input, { access }) => workflow.authorizePublish(access, input),
    resource: assetResource,
    policyTargets: (input) => workflow.policyTargets(input),
    changeClass: "reversible",
    module: ASSET_WRITE_MODULE,
    beforeEvents: (input) => publishEvents(options, input),
    execute: (input, context) => workflow.drafts.publish(context, input)
  });

  route.operation(apiOperations["assets.discard_draft"], {
    authorize: (input, { access }) => workflow.authorizeRevisionWrite(access, input, "write"),
    resource: assetResource,
    policyTargets: (input) => workflow.policyTargets(input),
    changeClass: "reversible",
    module: ASSET_WRITE_MODULE,
    execute: (input, context) => workflow.drafts.discardDraft(context, input)
  });

  route.operation(apiOperations["assets.run_live_once"], {
    authorize: (input, { access }) => workflow.authorizeRevisionWrite(access, input, "write"),
    resource: assetResource,
    policyTargets: (input) => workflow.policyTargets(input),
    changeClass: "reversible",
    module: ASSET_WRITE_MODULE,
    execute: (input, context) => workflow.drafts.runLiveOnce(context, input)
  });

  route.operation(apiOperations["assets.delete"], {
    authorize: (input, { access }) => workflow.authorizeRevisionWrite(access, input, "delete"),
    resource: assetResource,
    policyTargets: (input) => workflow.policyTargets(input),
    changeClass: "reversible",
    module: ASSET_WRITE_MODULE,
    execute: (input, context) => workflow.delete(context, input)
  });

  route.operation(apiOperations["assets.set_availability"], {
    authorize: (input, { access }) => authorizeAssetPlacement(options, access, input),
    resource: assetResource,
    policyTargets: (input) => workflow.policyTargets(input),
    changeClass: "reversible",
    module: ASSET_WRITE_MODULE,
    execute: (input, context) => setAssetAvailability(options, context, input)
  });

  route.operation(apiOperations["assets.revisions.list"], {
    // The history holds every draft, so it asks what a read of the draft asks.
    authorize: (input, { access }) =>
      workflow.reads.authorizeGet(access, { ...input, revision: "draft" }),
    resource: assetResource,
    policyTargets: (input) => workflow.policyTargets(input),
    execute: (input, context) => workflow.reads.listRevisions(context, input, context.paging)
  });

  route.operation(apiOperations["assets.revert"], {
    authorize: (input, { access }) => workflow.authorizeRevisionWrite(access, input, "write"),
    resource: assetResource,
    policyTargets: (input) => workflow.policyTargets(input),
    changeClass: "reversible",
    module: ASSET_WRITE_MODULE,
    beforeEvents: (input) => revertWriteEvents(options, input),
    execute: (input, context) => workflow.revert(context, input)
  });

  const overview = new ConfigAssetWorkflow({ options });

  route(apiOperations["config_assets.get_overview"], ({ identity, context }) =>
    overview.getOverview(identity, context)
  );

  route(apiOperations["instance.workspaces.list"], () => overview.listAdministeredWorkspaces());
}

/** What the call touches, as its run and its events name it. */
function assetResource(input: {
  kind: string;
  name?: string;
  workspaceId?: string;
}): OperationResource | undefined {
  if (input.name === undefined) {
    return undefined;
  }
  return {
    kind: input.kind,
    id: input.name,
    name: input.name,
    ...(input.workspaceId === undefined
      ? {}
      : { workspaceId: asCollaborationWorkspaceId(input.workspaceId) })
  };
}
