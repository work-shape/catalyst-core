import {
  WORKFLOW_ACTIONS,
  WORKFLOW_ASSET_KIND,
  isJsonObject,
  type AssetKindRegistry,
  type ConfigAssetRevisionRecord,
  type ConfigAssetStore,
  type ClientInstanceId,
  type JsonObject,
  type OperationApproval,
  type OperationEffect,
  type PagesStore,
  type PlatformAction
} from "@vivd-catalyst/core";
import { z } from "zod";
import { APP_ACTIONS, APP_ASSET_KIND } from "./apps/app-kind";
import type { AssetTarget } from "./asset-target";
import type { WorkflowAssetKind } from "./asset-kinds/shared";
import type { HeldCallApprovalKind } from "./held-call-kind";

// A publish that a guardrail holds waits as a request of its own kind, `app_publish` or
// `workflow_publish`, which the holders of the kind's `approve` right decide and nobody else.
// The request freezes what it publishes: approving makes exactly that revision live, and the
// request cannot be approved once the draft or the live revision moved. Spec:
// events-workflows-and-guardrails.md, Publishing needs a person's click.

/** The approval kind of a held publish and the right that decides it, by the asset kind. */
const PUBLISH_APPROVALS: Readonly<Record<string, { kind: string; approve: PlatformAction }>> = {
  [APP_ASSET_KIND]: { kind: "app_publish", approve: APP_ACTIONS.approve },
  [WORKFLOW_ASSET_KIND]: { kind: "workflow_publish", approve: WORKFLOW_ACTIONS.approve }
};

/** The approval kinds of a held publish. */
export const PUBLISH_APPROVAL_KINDS: readonly string[] = Object.values(PUBLISH_APPROVALS).map(
  ({ kind }) => kind
);

/** What a held publish is about, frozen when it is filed: the asset and its two pointers then. */
const publishSubjectSchema = z.object({
  kind: z.string().min(1),
  name: z.string().min(1),
  assetId: z.string().min(1),
  /** The revision the publish makes live. */
  revision: z.number().int().positive(),
  /** The draft when the request was filed. */
  draftRevision: z.number().int().positive(),
  /** The live revision when the request was filed. Null before the first publish. */
  liveRevision: z.number().int().positive().nullable()
});

type PublishSubject = z.infer<typeof publishSubjectSchema>;

/**
 * Who decides a held publish of this target: the holders of the kind's `approve` right. None
 * for a kind without a held publish, or an asset that is not there to publish.
 */
export function publishApproval(
  target: AssetTarget,
  revision: number
): OperationApproval | undefined {
  const approval = PUBLISH_APPROVALS[target.kind.kind];
  const { asset } = target;
  if (approval === undefined || asset?.status !== "active") return undefined;
  const subject: PublishSubject = {
    kind: target.kind.kind,
    name: target.name,
    assetId: asset.id,
    revision,
    draftRevision: asset.revision,
    liveRevision: asset.publishedRevision ?? null
  };
  return {
    kind: approval.kind,
    action: approval.approve,
    resource: target.resource,
    subject
  };
}

/**
 * Why a held publish can no longer be approved: the asset is gone, or its draft or its live
 * revision moved. The item words the code; the request keeps the sentence.
 */
type PublishMoved = "gone" | "draft_moved" | "live_moved";

const MOVED_SENTENCES: Readonly<Record<PublishMoved, (name: string) => string>> = {
  gone: (name) => `'${name}' is gone. Nothing was published.`,
  draft_moved: (name) =>
    `The draft of '${name}' changed since the request was filed. Nothing was published; publish again to ask for the new draft.`,
  live_moved: (name) =>
    `Another revision of '${name}' was published since the request was filed. Nothing was published.`
};

async function publishMoved(
  clientInstanceId: ClientInstanceId,
  subject: PublishSubject,
  store: Pick<ConfigAssetStore, "getConfigAsset">
): Promise<PublishMoved | undefined> {
  const asset = await store.getConfigAsset({
    clientInstanceId,
    kind: subject.kind,
    name: subject.name
  });
  if (!asset || asset.id !== subject.assetId || asset.status !== "active") return "gone";
  if (asset.revision !== subject.draftRevision) return "draft_moved";
  if ((asset.publishedRevision ?? null) !== subject.liveRevision) return "live_moved";
  return undefined;
}

export interface PublishApprovalKindsOptions {
  clientInstanceId: ClientInstanceId;
  /** The registered kinds, which say what a revision reaches. Without them the review omits it. */
  kinds?: AssetKindRegistry<WorkflowAssetKind>;
  store: Pick<ConfigAssetStore, "getConfigAsset" | "getConfigAssetRevision">;
  files: Pick<PagesStore, "getAssetFileSet">;
  /** The effect of an operation a Workflow step calls, where it is registered. */
  effectOf(operation: string): Promise<OperationEffect | undefined>;
}

/** The held-call kinds of a publish: one for each kind of asset whose publish can be held. */
export function publishApprovalKinds(options: PublishApprovalKindsOptions): HeldCallApprovalKind[] {
  const { clientInstanceId } = options;
  return Object.values(PUBLISH_APPROVALS).map(({ kind, approve }) => ({
    kind,
    requiredPermission: approve,
    async moved(subject, store) {
      const parsed = publishSubjectSchema.safeParse(subject);
      if (!parsed.success) return "The request names no revision it publishes.";
      const moved = await publishMoved(clientInstanceId, parsed.data, store);
      return moved && MOVED_SENTENCES[moved](parsed.data.name);
    },
    async review(subject) {
      const parsed = publishSubjectSchema.safeParse(subject);
      if (!parsed.success) return undefined;
      const moved = await publishMoved(clientInstanceId, parsed.data, options.store);
      return {
        ...(await publishReview(options, parsed.data)),
        ...(moved ? { stale: moved } : {})
      };
    },
    subjectKey(subject) {
      const parsed = publishSubjectSchema.safeParse(subject);
      return parsed.success ? { assetId: parsed.data.assetId } : subject;
    }
  }));
}

/**
 * What the person who decides a held publish reads: the revision and the live one it replaces,
 * the files that differ, and what the revision reaches as its kind reads it. Computed from the
 * two stored revisions until the server's own review replaces it (DT-1b).
 */
async function publishReview(
  options: PublishApprovalKindsOptions,
  subject: PublishSubject
): Promise<JsonObject> {
  const { clientInstanceId, store } = options;
  const kind = options.kinds?.get(subject.kind);
  const read = (revision: number) =>
    store.getConfigAssetRevision({
      clientInstanceId,
      kind: subject.kind,
      name: subject.name,
      revision
    });
  const next = await read(subject.revision);
  const live = subject.liveRevision === null ? undefined : await read(subject.liveRevision);
  const reach = kind?.publishReach?.(configOf(next), live ? configOf(live) : undefined);
  const calls = reach
    ? await Promise.all(
        reach.calls.map(async (call) => ({
          ...call,
          effect:
            call.effect ?? (call.operation ? await options.effectOf(call.operation) : undefined)
        }))
      )
    : [];
  return {
    kind: subject.kind,
    name: subject.name,
    title: titleOf(kind, next) ?? subject.name,
    revision: subject.revision,
    liveRevision: subject.liveRevision,
    files: await changedFiles(options, subject.assetId, next, live),
    ...(reach
      ? {
          // Only what changes something: a reading call reaches nothing new.
          changing: calls
            .filter((call) => call.effect === "changing")
            .map(({ label, change }) => ({ label, change })),
          hostsAdded: [...reach.hostsAdded],
          connections: [...reach.connections],
          dataStores: reach.dataStores.map((store) => ({
            name: store.name,
            ...(store.minSchema === undefined ? {} : { minSchema: store.minSchema })
          })),
          ...(reach.runAs ? { runAs: reach.runAs } : {})
        }
      : {})
  };
}

function configOf(revision: ConfigAssetRevisionRecord | undefined): JsonObject {
  return revision?.config && isJsonObject(revision.config) ? revision.config : {};
}

function titleOf(
  kind: WorkflowAssetKind | undefined,
  revision: ConfigAssetRevisionRecord | undefined
): string | undefined {
  if (!kind || !revision?.config) return undefined;
  try {
    return kind.summarize(revision.config).title;
  } catch {
    return undefined;
  }
}

/**
 * The files of the revision that differ from the live one, each added, removed or changed. A
 * kind that keeps its files in a file set is compared file by file; another kind by the files
 * its config holds.
 */
async function changedFiles(
  options: PublishApprovalKindsOptions,
  assetId: string,
  next: ConfigAssetRevisionRecord | undefined,
  live: ConfigAssetRevisionRecord | undefined
): Promise<JsonObject[]> {
  const files = async (revision: ConfigAssetRevisionRecord | undefined) => {
    if (revision?.fileSetId) {
      const set = await options.files.getAssetFileSet({
        clientInstanceId: options.clientInstanceId,
        assetId,
        fileSetId: revision.fileSetId
      });
      return new Map((set?.sourceFiles ?? []).map((file) => [file.path, file.sha256]));
    }
    const listed = configFilesSchema.safeParse(revision?.config).data?.files ?? [];
    return new Map(listed.map((file) => [file.path, file.content]));
  };
  const [after, before] = await Promise.all([files(next), files(live)]);
  const paths = [...new Set([...after.keys(), ...before.keys()])].sort();
  return paths.flatMap((path) => {
    const now = after.get(path);
    const then = before.get(path);
    if (now === then) return [];
    return [
      { path, change: then === undefined ? "added" : now === undefined ? "removed" : "changed" }
    ];
  });
}

const configFilesSchema = z.object({
  files: z.array(z.object({ path: z.string(), content: z.string() }))
});
