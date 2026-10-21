import { appAudienceSchema } from "@work-shape/catalyst-api-contract";
import type { AppAudience } from "@work-shape/catalyst-core";
import {
  WORKFLOW_ACTIONS,
  asCollaborationWorkspaceId,
  callerCanConfirm,
  WORKFLOW_ASSET_KIND,
  WORKFLOW_MANIFEST_FILE,
  isJsonObject,
  type AssetKindRegistry,
  type ConfigAssetRevisionRecord,
  type ConfigAssetStore,
  type ClientInstanceId,
  type ApprovalPreviewViewer,
  type JsonObject,
  type LocaleCode,
  type OperationApproval,
  type OperationAuthorization,
  type OperationEffect,
  type OperationOrigin,
  type PagesStore,
  type PlatformStores,
  type PlatformAction,
  type PolicyValue
} from "@work-shape/catalyst-core";
import { z } from "zod";
import { APP_ACTIONS, APP_ASSET_KIND } from "../apps/app-kind";
import type { AssetTarget } from "../assets/asset-target";
import type { WorkflowAssetKind } from "../asset-kinds/shared";
import type { HeldCallApprovalKind } from "./held-call-kind";
import {
  unavailablePublishNarrative,
  type PublishNarrator
} from "../publish-narrative/publish-narrator";

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

/** One asset of a held publish and its two pointers when the request was filed. */
const publishedAssetSchema = z.object({
  kind: z.string().min(1),
  name: z.string().min(1),
  /** The name people read, when the request was filed. */
  title: z.string().min(1),
  assetId: z.string().min(1),
  /** The revision the publish makes live. */
  revision: z.number().int().positive(),
  /** The draft when the request was filed. */
  draftRevision: z.number().int().positive(),
  /** The live revision when the request was filed. Null before the first publish. */
  liveRevision: z.number().int().positive().nullable()
});

/** What a held publish is about, frozen when it is filed: the asset and its two pointers then. */
const publishSubjectSchema = publishedAssetSchema.extend({
  /**
   * The Workflows a publish of an App makes live with it (DP-3), children first. The request
   * holds the set as one item: it moves when any of them moves.
   */
  publishedWith: z.array(publishedAssetSchema).optional(),
  audience: appAudienceSchema.optional(),
  liveAudience: appAudienceSchema.optional(),
  liveAudienceUserId: z.string().optional(),
  audiencePersonName: z.string().optional(),
  publish_widens: z.boolean().optional()
});

type PublishSubject = z.infer<typeof publishSubjectSchema>;

/**
 * Who decides a held publish of this target: the holders of the kind's `approve` right. None
 * for a kind without a held publish, or an asset that is not there to publish.
 */
export function publishApproval(
  target: AssetTarget,
  revision: number,
  audience?: AppAudience,
  audiencePersonName?: string,
  publishWidens?: boolean
): OperationApproval | undefined {
  const approval = PUBLISH_APPROVALS[target.kind.kind];
  const { asset } = target;
  if (approval === undefined || asset?.status !== "active") return undefined;
  const subject: PublishSubject = {
    kind: target.kind.kind,
    ...(target.kind.kind === "app"
      ? {
          audience:
            audience ??
            (asset.publishedRevisionId ? (asset.appAvailability?.audience ?? "workspace") : "self")
        }
      : {}),
    ...(audiencePersonName ? { audiencePersonName } : {}),
    ...(publishWidens === undefined ? {} : { publish_widens: publishWidens }),
    name: target.name,
    title: titleOf(target.kind, asset) ?? target.name,
    assetId: asset.id,
    revision,
    draftRevision: asset.revision,
    liveRevision: asset.publishedRevision ?? null,
    ...(target.kind.kind === "app"
      ? {
          liveAudience: asset.appAvailability?.audience ?? "workspace",
          ...(asset.appAvailability?.userId
            ? { liveAudienceUserId: asset.appAvailability.userId }
            : {})
        }
      : {})
  };
  return {
    kind: approval.kind,
    action: approval.approve,
    subject
  };
}

/**
 * The refusal of a publish that is no person's click, for a kind whose publish an approver's
 * click makes live: a revision of it goes live only on the interface's Publish, the answer to
 * the CLI's question, or the person's Allow of an unattended CLI publish in their Inbox (see
 * `publishPolicyFloor`). An agent's App or Workflow publish pauses for that person's confirmation
 * (and an App's audience choice). Other agent publishes and MCP publishes are refused. Nothing for a person's own call.
 */
export function publishFromAPerson(
  target: AssetTarget,
  origin: OperationOrigin
): OperationAuthorization | undefined {
  const { publish, approve } = target.kind.actions;
  if (
    approve === undefined ||
    origin.kind === "user" ||
    origin.kind === "cli" ||
    (origin.kind === "agent" &&
      (target.kind.kind === "app" || target.kind.kind === WORKFLOW_ASSET_KIND))
  )
    return undefined;
  return {
    allowed: false,
    ...(publish === undefined ? {} : { action: publish }),
    reason: "user_only",
    message: `Publishing a ${target.kind.kind} needs a person's click: publish it in the interface, or answer the question of 'catalyst ${target.kind.kind} publish' in a terminal.`
  };
}

/**
 * The floor of a publish that is not its caller's own confirmation, such as `catalyst <kind>
 * publish --yes`: at least `confirm`, whatever a central setting says, so the person confirms
 * it in their Inbox (Confirmation in the Inbox). Nothing for a call that is its own.
 */
export function publishPolicyFloor(origin: OperationOrigin): PolicyValue | undefined {
  return callerCanConfirm(origin) ? undefined : "confirm";
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
  subject: z.infer<typeof publishedAssetSchema> &
    Pick<PublishSubject, "liveAudience" | "liveAudienceUserId">,
  store: Pick<ConfigAssetStore, "getConfigAsset">
): Promise<PublishMoved | undefined> {
  const asset = await store.getConfigAsset({
    clientInstanceId,
    kind: subject.kind,
    name: subject.name
  });
  if (!asset || asset.id !== subject.assetId || asset.status !== "active") return "gone";
  if (asset.revision !== subject.draftRevision) return "draft_moved";
  if (
    (asset.publishedRevision ?? null) !== subject.liveRevision ||
    (subject.liveAudience !== undefined &&
      ((asset.appAvailability?.audience ?? "workspace") !== subject.liveAudience ||
        asset.appAvailability?.userId !== subject.liveAudienceUserId))
  )
    return "live_moved";
  return undefined;
}

export interface PublishApprovalKindsOptions {
  workspaces?: Pick<PlatformStores["workspaces"], "getWorkspace">;
  clientInstanceId: ClientInstanceId;
  /** The registered kinds, which say what a revision reaches. Without them the review omits it. */
  kinds?: AssetKindRegistry<WorkflowAssetKind>;
  store: Pick<ConfigAssetStore, "getConfigAsset" | "getConfigAssetRevision">;
  files: Pick<PagesStore, "getAssetFileSet">;
  /** The effect of an operation a Workflow step calls, where it is registered. */
  effectOf(operation: string): Promise<OperationEffect | undefined>;
  /** The publish question's sentence and warnings (PUBQ-1). Without it the review omits them. */
  narrator?: PublishNarrator;
  /** The instance's language, for a reader whose own is not known. */
  defaultLocale?: LocaleCode;
}

/** The held-call kinds of a publish: one for each kind of asset whose publish can be held. */
export function publishApprovalKinds(options: PublishApprovalKindsOptions): HeldCallApprovalKind[] {
  const { clientInstanceId } = options;
  return Object.values(PUBLISH_APPROVALS).map(({ kind, approve }) => ({
    kind,
    requiredPermission: approve,
    furtherPermissions(subject) {
      // Each Workflow published with an App is decided by someone who may approve its own publish.
      const parsed = publishSubjectSchema.safeParse(subject);
      if (!parsed.success) return [];
      const further = (parsed.data.publishedWith ?? []).map(
        (member) => PUBLISH_APPROVALS[member.kind]?.approve ?? approve
      );
      return [...new Set(further)].filter((right) => right !== approve);
    },
    async moved(subject, store) {
      const parsed = publishSubjectSchema.safeParse(subject);
      if (!parsed.success) return "The request names no revision it publishes.";
      for (const asset of [...(parsed.data.publishedWith ?? []), parsed.data]) {
        const moved = await publishMoved(clientInstanceId, asset, store);
        if (moved) return MOVED_SENTENCES[moved](asset.name);
      }
      return undefined;
    },
    async review(subject, inList, viewer): Promise<JsonObject | undefined> {
      const parsed = publishSubjectSchema.safeParse(subject);
      if (!parsed.success) return undefined;
      // A row of a list reads nothing: it names what is published as it was filed.
      const together = parsed.data.publishedWith ?? [];
      if (inList) {
        const row = ({ kind, name, title, revision, liveRevision }: typeof parsed.data) => ({
          kind,
          name,
          title,
          revision,
          liveRevision
        });
        return {
          ...row(parsed.data),
          ...(together.length > 0 ? { publishedWith: together.map(row) } : {})
        };
      }
      // The first of the set that moved names why none of it can be approved.
      let moved: PublishMoved | undefined;
      for (const asset of [...together, parsed.data]) {
        moved ??= await publishMoved(clientInstanceId, asset, options.store);
      }
      return {
        ...(await publishReview(options, parsed.data, viewer)),
        ...(together.length > 0
          ? {
              publishedWith: await Promise.all(
                together.map((asset) => publishReview(options, asset, viewer))
              )
            }
          : {}),
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
  subject: PublishSubject,
  viewer: ApprovalPreviewViewer | undefined
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
  // The same sentence the Publish dialog and the CLI lead with, for the frozen revision, in
  // the approver's language and naming what the approver may be shown (PUBQ-1).
  const asset =
    next && viewer && options.narrator
      ? await store.getConfigAsset({ clientInstanceId, kind: subject.kind, name: subject.name })
      : undefined;
  const workspaceName =
    asset?.scope.kind === "workspace" && options.workspaces
      ? (
          await options.workspaces.getWorkspace(
            clientInstanceId,
            asCollaborationWorkspaceId(asset.scope.workspaceId)
          )
        )?.name
      : undefined;
  const narrative =
    next && viewer && options.narrator && asset?.id === subject.assetId
      ? await options.narrator
          .narrate({
            kind: subject.kind,
            name: subject.name,
            scope: asset.scope,
            revision: subject.revision,
            config: next.config,
            locale: viewer.locale ?? options.defaultLocale ?? "en",
            access: viewer.access,
            ...(subject.audience
              ? {
                  audienceLabel: audienceLabel(
                    subject.audience,
                    viewer.locale ?? options.defaultLocale ?? "en",
                    workspaceName,
                    subject.audiencePersonName
                  )
                }
              : {})
          })
          .catch(() => unavailablePublishNarrative(viewer.locale ?? options.defaultLocale ?? "en"))
      : undefined;
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
    title: subject.title,
    ...(subject.publish_widens === undefined ? {} : { publish_widens: subject.publish_widens }),
    ...(subject.audience
      ? {
          audience: {
            selected: subject.audience,
            label: audienceLabel(
              subject.audience,
              viewer?.locale ?? options.defaultLocale ?? "en",
              workspaceName,
              subject.audiencePersonName
            )
          }
        }
      : {}),
    revision: subject.revision,
    liveRevision: subject.liveRevision,
    files: await changedFiles(options, subject, next, live),
    ...(narrative ? { publishNarrative: { ...narrative } } : {}),
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

/** The name people read of a stored revision, as its kind reads it. */
function titleOf(
  kind: Pick<WorkflowAssetKind, "summarize">,
  record: { config: JsonObject | null }
): string | undefined {
  if (!record.config) return undefined;
  try {
    return kind.summarize(record.config).title;
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
  subject: Pick<PublishSubject, "assetId" | "kind">,
  next: ConfigAssetRevisionRecord | undefined,
  live: ConfigAssetRevisionRecord | undefined
): Promise<JsonObject[]> {
  const files = async (revision: ConfigAssetRevisionRecord | undefined) => {
    if (revision?.fileSetId) {
      const set = await options.files.getAssetFileSet({
        clientInstanceId: options.clientInstanceId,
        assetId: subject.assetId,
        fileSetId: revision.fileSetId
      });
      return new Map((set?.sourceFiles ?? []).map((file) => [file.path, file.sha256]));
    }
    const listed = configFilesSchema.safeParse(revision?.config).data?.files ?? [];
    const contents = new Map(listed.map((file) => [file.path, file.content]));
    // Workflows store their parsed manifest beside the step files, not in a file set.
    if (subject.kind === WORKFLOW_ASSET_KIND && revision?.config?.manifest !== undefined) {
      contents.set(WORKFLOW_MANIFEST_FILE, JSON.stringify(revision.config.manifest));
    }
    return contents;
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

function audienceLabel(
  audience: AppAudience,
  locale: LocaleCode,
  workspaceName?: string,
  personName?: string
): string {
  if (audience === "self" && personName)
    return locale === "de" ? `Nur für ${personName}` : `Only ${personName}`;
  if (audience === "workspace" && workspaceName)
    return locale === "de" ? `Alle in ${workspaceName}` : `Everyone in ${workspaceName}`;
  const labels = {
    self: { en: "Private", de: "Privat" },
    workspace: { en: "Everyone in the owning workspace", de: "Alle im besitzenden Arbeitsbereich" },
    instance: { en: "Everyone in the instance", de: "Alle in der Instanz" }
  };
  return labels[audience][locale];
}
