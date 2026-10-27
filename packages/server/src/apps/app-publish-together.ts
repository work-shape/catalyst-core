import {
  AppError,
  DATA_STORE_ACTIONS,
  DATA_STORE_ASSET_KIND,
  WORKFLOW_ASSET_KIND,
  type ActorAccess,
  type AssetScope,
  type AuthenticatedIdentity,
  type ConfigAssetRecord,
  type JsonObject,
  type OperationApproval,
  type OperationAuthorization,
  type OperationBeforeEvent,
  type OperationOrigin,
  type PolicyTarget
} from "@work-shape/catalyst-core";
import { accessResource, transactionalAssetCall, type AssetCall } from "../assets/asset-access";
import { AssetWorkflow } from "../assets/asset-service";
import type { AssetAddress } from "../assets/asset-target";
import { publishEvents } from "../guardrails/asset-guardrail-events";
import type { AssetWorkflowOptions } from "../types";
import type { AppAudience } from "@work-shape/catalyst-core";
import { APP_ASSET_KIND } from "./app-kind";
import {
  assetTitle,
  dataStoresPublishedWith,
  requireStoreLevels,
  storesStillMigrating,
  workflowsPublishedWith,
  type StoreStillMigrating,
  type StorePublishedWith
} from "./app-closure";
import {
  awaitStoreLevels,
  realStoreWaitClock,
  type StoreAwaited,
  type StoreWaitClock
} from "./app-store-wait";
import { publishMemberRights } from "../approvals/publish-approval";

// One Publish of an App makes the Data Store and Workflow drafts it names live with it (DP-3,
// GOLIVE-1): the call names each with the revision the person reviewed, and the App's own
// publish and theirs are checked up front, asked of the guardrails together and held as one
// approval. A refusal of any up front publishes none. Then each store is published as its own
// publish does it, in its own transaction, and the publish waits until each store's migrations
// reached its level; a failed migration or a wait that runs out publishes neither the App nor
// its Workflows. Last, the Workflows, children first, and the App go live in one transaction.
// Spec: events-workflows-and-guardrails.md, LIVE-2; apps-and-pages.md, Going live.

/** A publish of an asset, and of an App the Data Stores and Workflows it makes live with it. */
export type PublishTogetherInput = AssetAddress & {
  revision: number;
  audience?: AppAudience;
  confirmProcessing?: string;
  workflows?: readonly { name: string; revision: number }[] | undefined;
  dataStores?: readonly { name: string; revision: number }[] | undefined;
};

interface Member {
  /** `data_store` or `workflow`. */
  kind: string;
  name: string;
  revision: number;
  asset: ConfigAssetRecord;
}

/** What one publish of an App names beside it: the stores first, then the Workflows. */
interface Members {
  stores: StorePublishedWith[];
  workflows: Member[];
}

const NONE: Members = { stores: [], workflows: [] };

const addressOf = (member: Pick<Member, "kind" | "name" | "revision" | "asset">) => ({
  kind: member.kind,
  name: member.name,
  revision: member.revision,
  ...(member.asset.scope.kind === "workspace"
    ? { workspaceId: member.asset.scope.workspaceId }
    : {})
});

/** The stores and then the Workflows, each as one member of the publish. */
const allOf = ({ stores, workflows }: Members): Member[] => [
  ...stores.map((store) => ({ ...store, kind: DATA_STORE_ASSET_KIND })),
  ...workflows
];

export class AppPublishTogether {
  private readonly options: AssetWorkflowOptions;
  private readonly assets: AssetWorkflow;
  private readonly clock: StoreWaitClock;

  constructor(
    options: AssetWorkflowOptions,
    assets: AssetWorkflow,
    clock: StoreWaitClock = realStoreWaitClock
  ) {
    this.options = options;
    this.assets = assets;
    this.clock = clock;
  }

  /**
   * The publish right of the App and of each Data Store and Workflow published with it, asked
   * up front: `data_store.publish` on each store, `workflow.publish` on each Workflow.
   */
  async authorize(
    caller: { actor: AuthenticatedIdentity; access: ActorAccess; origin: OperationOrigin },
    input: PublishTogetherInput
  ): Promise<OperationAuthorization> {
    const right = await this.assets.authorizePublish(caller, input);
    if (!right.allowed) return right;
    // A store's level is told only to one who may publish it.
    const members = await this.members(input, { levels: false });
    for (const member of allOf(members)) {
      const own = await this.assets.authorizePublish(caller, addressOf(member));
      if (!own.allowed) return own;
    }
    requireStoreLevels(members.stores);
    return right;
  }

  /** The publish event of each store and Workflow published with the App, then the App's own. */
  async events(
    input: PublishTogetherInput,
    actor?: AuthenticatedIdentity
  ): Promise<OperationBeforeEvent[]> {
    const members = allOf(await this.members(input));
    const theirs = await Promise.all(
      members.map((member) => publishEvents(this.options, addressOf(member), actor))
    );
    return [...theirs.flat(), ...(await publishEvents(this.options, input, actor))];
  }

  /**
   * What the policy is asked about: the App and each store and Workflow published with it, so
   * a setting that holds one of their publishes holds the joint one too.
   */
  async policyTargets(input: PublishTogetherInput): Promise<PolicyTarget[]> {
    const own = this.assets.policyTargets(input);
    const members = allOf(await this.members(input));
    return [
      ...own,
      ...members.map((member) => this.assets.policyTargets(addressOf(member))).flat()
    ];
  }

  /**
   * The App's held publish, with the stores and Workflows published with it frozen in its
   * subject: the set is one item that is approved as a whole, and moves when any of them
   * moves. Only someone who holds each member's right decides it, or approves it by their own
   * click: `workflow.approve` on a Workflow and, as a store's publish has no approval of its
   * own, `data_store.publish` on a store.
   */
  async approval(input: PublishTogetherInput): Promise<OperationApproval | undefined> {
    const own = await this.assets.publishApproval(input);
    const members = allOf(await this.members(input));
    if (!own?.subject || members.length === 0) return own;
    const subject = {
      ...own.subject,
      publishedWith: members.map(({ kind, name, revision, asset }) => ({
        kind,
        name,
        title: assetTitle(asset.config, asset.name),
        assetId: asset.id,
        workspaceId: asset.scope.kind === "workspace" ? asset.scope.workspaceId : null,
        revision,
        draftRevision: asset.revision,
        liveRevision: asset.publishedRevision ?? null
      }))
    };
    // The caller's own click is asked the same rights as who decides the request.
    const alsoRequires = publishMemberRights(subject).map(({ permission, resource }) => ({
      action: permission,
      resource
    }));
    return { ...own, alsoRequires, subject };
  }

  /**
   * Publishes the stores named with an App and waits for their migrations, then the Workflows,
   * children first, and the App in one transaction. Each is published as its own publish
   * would be, with its checks and its audit row, and the App's own check sees their new
   * revisions and the stores' new levels.
   */
  async publish(call: AssetCall, input: PublishTogetherInput) {
    const members = await this.members(input);
    const migrating = await this.storesToAwait(call, input, members.stores);
    // A store published stays published, and a wait takes up to a minute: the App's own checks
    // come first, so a refusal of its audience, its revision or the set publishes no store and
    // waits for none. Its Workflows' checks cannot: a Workflow's asks that its children are
    // live, which they are only further down.
    if (members.stores.length > 0 || migrating.length > 0) {
      await this.assets.drafts.checkPublish(call, input);
    }
    const storesPublished = await this.publishStores(call, members.stores, migrating);
    if (members.workflows.length === 0) {
      const published = await this.assets.drafts.publish(call, input);
      return storesPublished.length === 0
        ? published
        : { ...published, publishedWith: storesPublished };
    }
    return this.options.stores.transaction(async (stores) => {
      const within: AssetWorkflowOptions = {
        ...this.options,
        stores,
        configAssets: { ...this.options.configAssets, store: stores.configAssets }
      };
      const scoped = new AssetWorkflow(within);
      const called = transactionalAssetCall(call, this.options.clientInstanceId, stores.audit);
      const publishedWith = [...storesPublished];
      for (const member of members.workflows) {
        const published = await scoped.drafts.publish(called, addressOf(member));
        publishedWith.push(pointersOf(member, published));
      }
      return { ...(await scoped.drafts.publish(called, input)), publishedWith };
    });
  }

  /**
   * Publishes each store as its own Publish does, in its own transaction: the pointer, the
   * record and the migrate job. Then waits until each is ready at the level of the revision
   * published, and so is each live store the App binds whose migrations an earlier Publish
   * left below the level the App needs. A store published here stays published whatever
   * follows: its migrations only go forward, and publishing the App again carries on from
   * there.
   */
  private async publishStores(
    call: AssetCall,
    named: readonly StorePublishedWith[],
    migrating: readonly StoreStillMigrating[]
  ) {
    const { clientInstanceId } = this.options;
    const read = (id: string) =>
      this.options.stores.dataStores.getDataStore({ clientInstanceId, id });
    const published = [];
    const awaited: StoreAwaited[] = [];
    for (const store of named) {
      const member = { ...store, kind: DATA_STORE_ASSET_KIND };
      published.push(pointersOf(member, await this.assets.drafts.publish(call, addressOf(member))));
      awaited.push(awaitedOf(store));
    }
    awaited.push(...migrating.map(awaitedOf));
    if (awaited.length > 0) await awaitStoreLevels(read, awaited, this.clock);
    return published;
  }

  /**
   * The live stores the App binds that an earlier Publish left below the level it needs, which
   * this one waits for. Only those the caller may publish: the wait's refusal names the store's
   * title, its level and its failure, and a store's level is told only to one who may publish
   * it. Any other is refused by the App's own publish, as before.
   */
  private async storesToAwait(
    call: AssetCall,
    input: PublishTogetherInput,
    named: readonly StorePublishedWith[]
  ): Promise<StoreStillMigrating[]> {
    const app = input.kind === APP_ASSET_KIND ? await this.appRevision(input) : undefined;
    if (!app) return [];
    const skip = new Set(named.map(({ name }) => name));
    const migrating = await storesStillMigrating(this.options, app, skip);
    return migrating.filter(
      (store) =>
        call.access.authorize(
          DATA_STORE_ACTIONS.publish,
          accessResource(DATA_STORE_ASSET_KIND, store.name, store.asset.scope, store.asset.id)
        ).allowed
    );
  }

  /** The App's revision the call names, or nothing where its own publish refuses it. */
  private async appRevision(
    input: PublishTogetherInput
  ): Promise<{ scope: AssetScope; config: JsonObject } | undefined> {
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
    return app && revision?.config && revision.assetId === app.id
      ? { scope: app.scope, config: revision.config }
      : undefined;
  }

  /** The stores and Workflows the call names to publish with an App, checked and ordered. */
  private async members(
    input: PublishTogetherInput,
    check: { levels: boolean } = { levels: true }
  ): Promise<Members> {
    if (!input.workflows?.length && !input.dataStores?.length) return NONE;
    if (input.kind !== APP_ASSET_KIND) {
      throw new AppError(
        "VALIDATION_FAILED",
        "Only the publish of an App makes Workflows and Data Stores live with it",
        { reason: input.workflows?.length ? "workflows_without_app" : "data_stores_without_app" },
        { exposeMessage: true }
      );
    }
    // Nothing of the App to make live: its own publish refuses that.
    const of = await this.appRevision(input);
    if (!of) return NONE;
    const workflows = input.workflows?.length
      ? await workflowsPublishedWith(this.options, of, input.workflows)
      : [];
    const stores = input.dataStores?.length
      ? await dataStoresPublishedWith(this.options, of, input.dataStores)
      : [];
    if (check.levels) requireStoreLevels(stores);
    return {
      stores,
      workflows: workflows.map((workflow) => ({ ...workflow, kind: WORKFLOW_ASSET_KIND }))
    };
  }
}

/** What the wait reads of a store: the level of the revision that is or goes live. */
function awaitedOf(store: {
  name: string;
  title: string;
  asset: ConfigAssetRecord;
  level: number;
  migrations: ReadonlyMap<number, string>;
}): StoreAwaited {
  const { name, title, level, migrations } = store;
  return { name, title, storeId: store.asset.id, level, migrations };
}

/** One member of the answer: where its pointers are after its publish. */
function pointersOf(
  member: Pick<Member, "kind" | "name">,
  published: { publishedRevision: number; replacedRevision?: number | undefined }
) {
  return {
    kind: member.kind,
    name: member.name,
    publishedRevision: published.publishedRevision,
    ...(published.replacedRevision === undefined
      ? {}
      : { replacedRevision: published.replacedRevision })
  };
}
