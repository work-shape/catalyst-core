import {
  AppError,
  WORKFLOW_ACTIONS,
  WORKFLOW_ASSET_KIND,
  type ActorAccess,
  type AuthenticatedIdentity,
  type ConfigAssetRecord,
  type OperationApproval,
  type OperationAuthorization,
  type OperationBeforeEvent,
  type OperationOrigin,
  type PolicyTarget
} from "@work-shape/catalyst-core";
import { transactionalAssetCall, type AssetCall } from "../assets/asset-access";
import { AssetWorkflow } from "../assets/asset-service";
import type { AssetAddress } from "../assets/asset-target";
import { publishEvents } from "../guardrails/asset-guardrail-events";
import type { AssetWorkflowOptions } from "../types";
import type { AppAudience } from "@work-shape/catalyst-core";
import { APP_ASSET_KIND } from "./app-kind";
import { assetTitle, workflowsPublishedWith } from "./app-closure";

// One Publish of an App makes the Workflow drafts it reaches live with it (DP-3): the call
// names each Workflow with the revision the person reviewed, and the App's own publish and
// theirs are checked up front, asked of the guardrails together, held as one approval and
// carried out in one transaction, children first and the App last. A refusal of any member
// publishes none. Spec: events-workflows-and-guardrails.md, LIVE-2; apps-and-pages.md.

/** A publish of an asset, and of an App the Workflows it makes live with it. */
export type PublishTogetherInput = AssetAddress & {
  revision: number;
  audience?: AppAudience;
  confirmProcessing?: string;
  workflows?: readonly { name: string; revision: number }[] | undefined;
};

interface Member {
  name: string;
  revision: number;
  asset: ConfigAssetRecord;
}

const addressOf = (member: Member) => ({
  kind: WORKFLOW_ASSET_KIND,
  name: member.name,
  revision: member.revision,
  ...(member.asset.scope.kind === "workspace"
    ? { workspaceId: member.asset.scope.workspaceId }
    : {})
});

export class AppPublishTogether {
  private readonly options: AssetWorkflowOptions;
  private readonly assets: AssetWorkflow;

  constructor(options: AssetWorkflowOptions, assets: AssetWorkflow) {
    this.options = options;
    this.assets = assets;
  }

  /** The publish right of the App and of each Workflow published with it, asked up front. */
  async authorize(
    caller: { actor: AuthenticatedIdentity; access: ActorAccess; origin: OperationOrigin },
    input: PublishTogetherInput
  ): Promise<OperationAuthorization> {
    const right = await this.assets.authorizePublish(caller, input);
    if (!right.allowed) return right;
    for (const member of await this.members(input)) {
      const own = await this.assets.authorizePublish(caller, addressOf(member));
      if (!own.allowed) return own;
    }
    return right;
  }

  /** The publish event of each Workflow published with the App, and then the App's own. */
  async events(
    input: PublishTogetherInput,
    actor?: AuthenticatedIdentity
  ): Promise<OperationBeforeEvent[]> {
    const members = await this.members(input).catch(() => []);
    const theirs = await Promise.all(
      members.map((member) => publishEvents(this.options, addressOf(member), actor))
    );
    return [...theirs.flat(), ...(await publishEvents(this.options, input, actor))];
  }

  /**
   * What the policy is asked about: the App and each Workflow published with it, so a setting
   * that holds a Workflow's publish holds the joint one too.
   */
  async policyTargets(input: PublishTogetherInput): Promise<PolicyTarget[]> {
    const own = this.assets.policyTargets(input);
    const members = await this.members(input).catch(() => []);
    return [
      ...own,
      ...members.map((member) => this.assets.policyTargets(addressOf(member))).flat()
    ];
  }

  /**
   * The App's held publish, with the Workflows published with it frozen in its subject: the
   * set is one item that is approved as a whole, and moves when any of them moves. Only someone
   * who may approve each member's publish decides it, or approves it by their own click.
   */
  async approval(input: PublishTogetherInput): Promise<OperationApproval | undefined> {
    const own = await this.assets.publishApproval(input);
    const members = await this.members(input).catch(() => []);
    if (!own?.subject || members.length === 0) return own;
    return {
      ...own,
      alsoActions: [WORKFLOW_ACTIONS.approve],
      subject: {
        ...own.subject,
        publishedWith: members.map(({ name, revision, asset }) => ({
          kind: WORKFLOW_ASSET_KIND,
          name,
          title: assetTitle(asset.config, asset.name),
          assetId: asset.id,
          revision,
          draftRevision: asset.revision,
          liveRevision: asset.publishedRevision ?? null
        }))
      }
    };
  }

  /**
   * Publishes the Workflows named with an App, children first, and then the App, in one
   * transaction. Each is published as its own publish would be, with its checks, its account
   * and its audit row, and the App's own check sees their new revisions.
   */
  async publish(call: AssetCall, input: PublishTogetherInput) {
    const members = await this.members(input);
    if (members.length === 0) return this.assets.drafts.publish(call, input);
    return this.options.stores.transaction(async (stores) => {
      const within: AssetWorkflowOptions = {
        ...this.options,
        stores,
        configAssets: { ...this.options.configAssets, store: stores.configAssets }
      };
      const scoped = new AssetWorkflow(within);
      const called = transactionalAssetCall(call, this.options.clientInstanceId, stores.audit);
      const publishedWith = [];
      for (const member of members) {
        const published = await scoped.drafts.publish(called, addressOf(member));
        publishedWith.push({
          kind: WORKFLOW_ASSET_KIND,
          name: member.name,
          publishedRevision: published.publishedRevision,
          ...(published.replacedRevision === undefined
            ? {}
            : { replacedRevision: published.replacedRevision })
        });
      }
      return { ...(await scoped.drafts.publish(called, input)), publishedWith };
    });
  }

  /** The Workflows the call names to publish with an App, checked and ordered children first. */
  private async members(input: PublishTogetherInput): Promise<Member[]> {
    if (!input.workflows?.length) return [];
    if (input.kind !== APP_ASSET_KIND) {
      throw new AppError(
        "VALIDATION_FAILED",
        "Only the publish of an App makes Workflows live with it",
        { reason: "workflows_without_app" },
        { exposeMessage: true }
      );
    }
    const { clientInstanceId, configAssets } = this.options;
    const app = await configAssets.store.getConfigAsset({
      clientInstanceId,
      kind: APP_ASSET_KIND,
      name: input.name
    });
    const revision = app
      ? await configAssets.store.getConfigAssetRevision({
          clientInstanceId,
          kind: APP_ASSET_KIND,
          name: input.name,
          revision: input.revision
        })
      : undefined;
    // Nothing of the App to make live: its own publish refuses that.
    if (!app || !revision?.config || revision.assetId !== app.id) return [];
    return workflowsPublishedWith(
      this.options,
      { scope: app.scope, config: revision.config },
      input.workflows
    );
  }
}
