import { ASSET_SYNC_BODY_MAX_BYTES, apiOperations } from "@work-shape/catalyst-api-contract";
import {
  asCollaborationWorkspaceId,
  isAuthenticatedServicePrincipal,
  type OperationResource
} from "@work-shape/catalyst-core";
import { ASSET_PUT_BODY_LIMIT_BYTES } from "../assets/asset-files";
import {
  assetWriteEvent,
  publishEvents,
  revertWriteEvents,
  syncWriteEvents
} from "../guardrails/asset-guardrail-events";
import { readDefinitionName } from "../asset-kinds/shared";
import {
  authorizeAssetPlacement,
  setAssetAvailability,
  setAssetDefault
} from "../assets/asset-placement";
import { publishPolicyFloor } from "../approvals/publish-approval";
import { AssetWorkflow } from "../assets/asset-service";

import { ConfigAssetWorkflow } from "../config-assets/config-asset-service";
import { TryConversations } from "../conversations/try-conversations";
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
  const tries = new TryConversations(options);

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

  route.operation(apiOperations["assets.check_name"], {
    authorize: (input, { access }) => workflow.authorizeWrite(access, input),
    resource: assetResource,
    policyTargets: (input) => workflow.policyTargets(input),
    execute: (input, context) => workflow.checkName(context, input)
  });

  route.operation(apiOperations["assets.get"], {
    authorize: ({ files, ...input }, { access, actor }) =>
      workflow.reads.authorizeGet(access, { ...input, files: files === "true" }, actor),
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
    authorize: (input, { actor, access, origin }) =>
      workflow.authorizePublish({ actor, access, origin }, input),
    resource: assetResource,
    policyTargets: (input) => workflow.policyTargets(input),
    changeClass: "reversible",
    beforeEvents: (input, _origin, actor) => publishEvents(options, input, actor),
    // A publish a guardrail holds waits for the holders of the kind's `approve` right.
    approval: (input) => workflow.publishApproval(input),
    policyFloorOf: (origin, input) =>
      typeof input === "object" && input !== null && "kind" in input && input.kind === "agent"
        ? undefined
        : publishPolicyFloor(origin),
    execute: async (input, context) => {
      if (input.kind !== "agent") return workflow.drafts.publish(context, input);
      const result = await workflow.agentDrafts.publish(context, input);
      await tries.settled(context, input, "published");
      return result;
    }
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
    authorize: (input, { actor, access }) => {
      // Never-rule 4: a key held by a local agent cannot make a draft call live.
      if (isAuthenticatedServicePrincipal(actor) || actor.delegatedActor?.kind === "api_key") {
        return {
          allowed: false,
          reason: "user_only",
          message: "Run live once needs a person signed in to the app; API keys cannot use it"
        };
      }
      return workflow.authorizeRevisionWrite(access, input, "write");
    },
    resource: assetResource,
    policyTargets: (input) => workflow.policyTargets(input),
    changeClass: "reversible",
    module: ASSET_WRITE_MODULE,
    execute: (input, context) => workflow.drafts.runLiveOnce(context, input)
  });

  // Reading the caller's own switches still asks for the write right on the draft.
  route.operation(apiOperations["assets.list_live_once"], {
    authorize: (input, { access }) => workflow.authorizeWrite(access, input),
    resource: assetResource,
    policyTargets: (input) => workflow.policyTargets(input),
    execute: (input, context) => workflow.drafts.listLiveOnce(context, input)
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

  const draftResource = ({ name }: { name: string }) => assetResource({ kind: "agent", name });
  route.operation(apiOperations["agents.draft.get"], {
    authorize: (input, { access }) => workflow.agentDrafts.authorize(access, input),
    resource: draftResource,
    policyTargets: (input) => workflow.policyTargets({ ...input, kind: "agent" }),
    execute: async (input, context) => ({ draft: await workflow.agentDrafts.get(context, input) })
  });
  route.operation(apiOperations["agents.draft.discard"], {
    authorize: (input, { access }) => workflow.agentDrafts.authorize(access, input),
    resource: draftResource,
    policyTargets: (input) => workflow.policyTargets({ ...input, kind: "agent" }),
    changeClass: "reversible",
    module: ASSET_WRITE_MODULE,
    execute: async (input, context) => {
      const result = await workflow.agentDrafts.discard(context, input);
      await tries.settled(context, input, "discarded");
      return result;
    }
  });
  route.operation(apiOperations["agents.try.open"], {
    authorize: (input, { actor, access }) => tries.authorize(actor, access, input),
    resource: draftResource,
    policyTargets: (input) => workflow.policyTargets({ ...input, kind: "agent" }),
    changeClass: "reversible",
    module: ASSET_WRITE_MODULE,
    execute: async (input, context) => ({
      conversation: await tries.open(context, input),
      preview: true as const
    })
  });

  const overview = new ConfigAssetWorkflow({ options });

  route(apiOperations["config_assets.get_overview"], ({ identity, context }) =>
    overview.getOverview(identity, context)
  );

  route(apiOperations["instance.workspaces.list"], ({ access }) => {
    if (
      !["agent.write", "knowledge_base.write", "connection.write"].some(
        (action) => access.authorize(action).allowed
      )
    )
      access.require("agent.write");
    return overview.listAdministeredWorkspaces();
  });
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
