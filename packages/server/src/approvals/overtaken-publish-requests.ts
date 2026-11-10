import {
  isAppError,
  type ApprovalRequest,
  type ApprovalRequestOutcome,
  type ApprovalRequestStore,
  type ClientInstanceId,
  type ConfigAssetStore,
  type JsonObject,
  type Logger
} from "@work-shape/catalyst-core";
import {
  OPERATION_CALL_APPROVAL_KIND,
  refuseWaitingOperation
} from "@work-shape/catalyst-tool-execution";
import { z } from "zod";
import { minimizedOperationCallPayload } from "./operation-call-approval-handler";
import { payloadSchema } from "./operation-call-payload";
import { PUBLISH_APPROVAL_KINDS } from "./publish-approval";

// A request to publish a revision can do nothing once a revision of its asset went live after
// it was filed: approving it would be refused, and it would never publish what it names. It is
// settled as `superseded` the moment that revision goes live, by whichever path made it live,
// and leaves To decide with a plain reason. Both the approval of a held publish (`app_publish`,
// `workflow_publish`, `form_page_publish`, `agent_publish`) and its person's confirmation in
// the Inbox (`operation_call` about a publish) are settled. Who may decide anything is not
// touched: nobody decides these requests any more.

/** The code an overtaken request's refusal carries, which the Inbox words in its own language. */
const PUBLISH_OVERTAKEN_CODE = "PUBLISH_OVERTAKEN";

/** What went live: the asset, its live revision now, and for an agent the draft it published. */
interface WentLive {
  assetId: string;
  name: string;
  /** The revision users are served now. */
  liveRevision: number;
  /** An agent's draft revision that this publish made live, where it published one. */
  draftRevision?: number;
}

export interface OvertakenPublishRequestsOptions {
  clientInstanceId: ClientInstanceId;
  approvals: Pick<ApprovalRequestStore, "listApprovalRequests" | "transitionPendingApprovalRequest">;
  now?: () => Date;
}

/** The pointers of one asset a publish request froze when it was filed. */
const frozenAssetSchema = z.object({
  assetId: z.string(),
  revision: z.number().int(),
  draftRevision: z.number().int().nullable().optional(),
  liveRevision: z.number().int().nullable()
});
const frozenSubjectSchema = frozenAssetSchema.extend({
  kind: z.string(),
  publishedWith: z.array(frozenAssetSchema).optional()
});

/** How many requests one pass reads at once. A person holds at most 25. */
const PAGE_SIZE = 100;

/**
 * Settles every pending request to publish a revision of the asset that went live, where the
 * live revision it was filed against is no longer the live one. Answers how many it settled.
 * A request somebody decides at this moment is left to that decision, which refuses it.
 */
async function settleOvertakenPublishRequests(
  options: OvertakenPublishRequestsOptions,
  live: WentLive
): Promise<number> {
  const { clientInstanceId, approvals } = options;
  const kinds = [OPERATION_CALL_APPROVAL_KIND, ...PUBLISH_APPROVAL_KINDS];
  let settled = 0;
  // The asset is what the request publishes, or one published with an App (DP-3).
  const subjects: JsonObject[] = [
    { assetId: live.assetId },
    { publishedWith: [{ assetId: live.assetId }] }
  ];
  for (const subjectContains of subjects) {
    const seen = new Set<string>();
    for (;;) {
      const page = await approvals.listApprovalRequests({
        clientInstanceId,
        kinds,
        status: "pending",
        subjectContains,
        page: { limit: PAGE_SIZE }
      });
      const fresh = page.filter((request) => !seen.has(request.id));
      for (const request of fresh) {
        seen.add(request.id);
        const reason = overtaken(request, live);
        if (!reason) continue;
        try {
          await approvals.transitionPendingApprovalRequest({
            clientInstanceId,
            requestId: request.id,
            resolve: async (pending, stores) => {
              const runId = payloadSchema.pick({ runId: true }).safeParse(pending.payload);
              const run = runId.success
                ? await stores.operationRuns.get({ clientInstanceId, id: runId.data.runId })
                : undefined;
              if (run) {
                await refuseWaitingOperation(
                  run.id,
                  {
                    kind: "policy",
                    operation: "assets.publish",
                    reason: "approval_stale"
                  },
                  { clientInstanceId, runs: stores.operationRuns, now: options.now }
                );
              }
              return overtakenOutcome(pending, reason);
            }
          });
          settled += 1;
        } catch (error) {
          // Somebody decides it at this moment; that decision finds it moved and refuses it.
          if (!(isAppError(error) && (error.code === "CONFLICT" || error.code === "NOT_FOUND")))
            throw error;
        }
      }
      if (page.length < PAGE_SIZE || fresh.length === 0) break;
    }
  }
  return settled;
}

interface OvertakenReason {
  liveRevision: number;
  /** What the request names is what went live: nothing is left for it to do. */
  alreadyLive: boolean;
}

/**
 * Why a pending request can do nothing since this went live: the live revision it was filed
 * against is not the live one any more. Nothing for a request that is no publish of the asset,
 * or that was filed against the live revision as it is now.
 */
function overtaken(
  request: Pick<ApprovalRequest, "kind" | "payload">,
  live: WentLive
): OvertakenReason | undefined {
  const payload = payloadSchema
    .pick({ subject: true, subjectKind: true, mode: true })
    .safeParse(request.payload);
  if (!payload.success) return undefined;
  const publishKind =
    request.kind === OPERATION_CALL_APPROVAL_KIND ? payload.data.subjectKind : request.kind;
  if (publishKind === undefined || !PUBLISH_APPROVAL_KINDS.includes(publishKind)) return undefined;
  const subject = frozenSubjectSchema.safeParse(payload.data.subject);
  if (!subject.success) return undefined;
  const frozen = [subject.data, ...(subject.data.publishedWith ?? [])].find(
    (asset) => asset.assetId === live.assetId
  );
  if (!frozen || frozen.liveRevision === live.liveRevision) return undefined;
  // An agent's request names a draft revision; another kind's the revision itself.
  const alreadyLive =
    subject.data.kind === "agent" && frozen === subject.data
      ? live.draftRevision !== undefined && frozen.draftRevision === live.draftRevision
      : frozen.revision === live.liveRevision;
  return { liveRevision: live.liveRevision, alreadyLive };
}

/** The sentence an overtaken request keeps, for a reader who does not word the code. */
function overtakenMessage(name: string, reason: OvertakenReason): string {
  return reason.alreadyLive
    ? `Version ${reason.liveRevision} of '${name}' is already live, and it is what this request asked for. Nothing was published; this request can do nothing.`
    : `A newer version of '${name}' went live (version ${reason.liveRevision}) after this request was filed. Nothing was published; this request can do nothing.`;
}

function overtakenOutcome(
  request: Pick<ApprovalRequest, "payload">,
  reason: OvertakenReason
): ApprovalRequestOutcome {
  const runId = payloadSchema.pick({ runId: true }).safeParse(request.payload);
  const name = z.object({ name: z.string() }).safeParse(
    payloadSchema.pick({ subject: true }).safeParse(request.payload).data?.subject
  );
  return {
    status: "superseded",
    applyResult: {
      ...(runId.success ? { runId: runId.data.runId } : {}),
      execution: "refused",
      error: {
        code: PUBLISH_OVERTAKEN_CODE,
        message: overtakenMessage(name.data?.name ?? "the asset", reason),
        liveRevision: reason.liveRevision,
        alreadyLive: reason.alreadyLive
      }
    },
    payload: minimizedOperationCallPayload(request.payload)
  };
}

/** What a publish answered: the revision it made live and those published with it. */
interface PublishAnswer {
  draftRevision?: number;
  publishedRevision?: number;
  replacedRevision?: number;
  publishedWith?: readonly { kind: string; name: string }[];
}

/**
 * After a publish made a revision live, settles the requests it overtook: of the asset, and of
 * each asset published with it. The live pointers are read as they stand now. A failure here
 * leaves the requests waiting as before, where a decision still refuses them: the publish
 * itself is done and is not failed for it.
 */
export async function settleOvertakenAfterPublish(
  options: OvertakenPublishRequestsOptions & {
    configAssets: Pick<ConfigAssetStore, "getConfigAsset">;
    logger?: Pick<Logger, "warn">;
  },
  published: { kind: string; name: string },
  answer: PublishAnswer
): Promise<void> {
  const assets = [published, ...(answer.publishedWith ?? [])];
  for (const { kind, name } of assets) {
    try {
      const asset = await options.configAssets.getConfigAsset({
        clientInstanceId: options.clientInstanceId,
        kind,
        name
      });
      if (!asset || asset.status !== "active") continue;
      // An agent's live revision is the asset's own; another kind's is its published one.
      const liveRevision = kind === "agent" ? asset.revision : asset.publishedRevision;
      if (liveRevision === undefined) continue;
      // An agent's draft publish names the draft it made live; its first version names none.
      const agentDraft =
        kind === "agent" && answer.replacedRevision !== undefined && published.name === name
          ? answer.draftRevision
          : undefined;
      await settleOvertakenPublishRequests(options, {
        assetId: asset.id,
        name,
        liveRevision,
        ...(agentDraft === undefined ? {} : { draftRevision: agentDraft })
      });
    } catch (error) {
      options.logger?.warn(
        { err: error, kind, name },
        "Requests a publish overtook were not settled; their decision still refuses them"
      );
    }
  }
}
