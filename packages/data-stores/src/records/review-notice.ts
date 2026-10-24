import { z } from "zod";
import {
  DATA_STORE_ACTIONS,
  DATA_STORE_ASSET_KIND,
  type AccessResource,
  type ApprovalRequestHandler
} from "@work-shape/catalyst-core";
import type { DataStoreRuntime } from "../runtime";
import type { PublishedStore } from "../verbs";
import { countFlaggedFields } from "./flagged";

// The one Inbox notice of a store whose records wait for a person in "Prüfen": one per store at
// a time, not one per field, seen by whoever may decide them (`data_store.records` on the
// store). Its count is read when it is shown, so it says what waits now. Marking it handled is
// the whole answer; a later proposal that flags a field files the next one. It holds the
// store's id and name, never a field, a key or a value.

/** The approval kind of the notice. */
const DATA_STORE_REVIEW_NOTICE_KIND = "data_store_review";

const payloadSchema = z.object({
  subject: z.object({
    dataStoreId: z.string().min(1),
    store: z.string().min(1),
    workspaceId: z.string().min(1).optional()
  })
});

type ReviewNoticePayload = z.infer<typeof payloadSchema>;

/** Who files the notice: the platform, never a person. */
const SYSTEM_REQUESTER = { id: "system", displayLabel: "System" };

function resourceOf(subject: ReviewNoticePayload["subject"]): AccessResource {
  return {
    kind: DATA_STORE_ASSET_KIND,
    name: subject.store,
    assetId: subject.dataStoreId,
    ...(subject.workspaceId ? { workspaceId: subject.workspaceId } : {})
  };
}

function subjectOf(store: PublishedStore): ReviewNoticePayload["subject"] {
  return {
    dataStoreId: store.record.id,
    store: store.record.name,
    ...(store.resource.workspaceId ? { workspaceId: store.resource.workspaceId } : {})
  };
}

/** How many fields of the store wait now, or nothing where that cannot be read. */
async function waiting(runtime: DataStoreRuntime, store: PublishedStore): Promise<number> {
  return countFlaggedFields(
    runtime,
    runtime.server.asPlatform(store.record.location.database),
    store.definition.records ?? []
  );
}

/** The published stores as the operations read them: one by its name, or all of them. */
export interface PublishedStores {
  one(name: string): Promise<PublishedStore | undefined>;
  all(): Promise<readonly PublishedStore[]>;
}

export function createReviewNoticeHandler(
  runtime: DataStoreRuntime,
  published: PublishedStores
): ApprovalRequestHandler<ReviewNoticePayload> {
  const current = async (payload: ReviewNoticePayload) => {
    const store = await published.one(payload.subject.store);
    return store?.record.id === payload.subject.dataStoreId && store.record.status === "ready"
      ? store
      : undefined;
  };
  return {
    kind: DATA_STORE_REVIEW_NOTICE_KIND,
    requiredPermission: DATA_STORE_ACTIONS.records,
    resourceOf: (payload) => resourceOf(payload.subject),
    async reviewableSubjects(access) {
      return (await published.all())
        .filter(
          (store) =>
            (store.definition.records?.length ?? 0) > 0 &&
            access.authorize(DATA_STORE_ACTIONS.records, resourceOf(subjectOf(store))).allowed
        )
        .map(subjectOf);
    },
    validate: (payload) => payloadSchema.parse(payload),
    async preview(payload) {
      const store = await current(payload);
      const flagged = store
        ? await waiting(runtime, store).catch((error: unknown) => {
            runtime.logger.warn(
              { storeId: payload.subject.dataStoreId, err: error },
              "The fields waiting in a store's review could not be counted"
            );
            return undefined;
          })
        : undefined;
      return {
        store: payload.subject.store,
        ...(store ? { title: store.definition.title } : {}),
        ...(payload.subject.workspaceId ? { workspaceId: payload.subject.workspaceId } : {}),
        ...(flagged === undefined ? {} : { flagged })
      };
    },
    // Nothing to apply: whoever handles it has read it. The decisions are made in "Prüfen".
    isStale: async () => false,
    apply: async () => ({ acknowledged: true })
  };
}

/**
 * Files the notice of a store whose records wait for a person, unless one is pending for the
 * store already. Two proposals that file at the same moment may file two; either ends the same
 * way. A failure is logged and never fails the proposal, whose rows are already kept.
 */
export async function fileReviewNotice(
  runtime: DataStoreRuntime,
  store: PublishedStore
): Promise<void> {
  try {
    if ((await waiting(runtime, store)) === 0) return;
    const pending = await runtime.stores.approvals.listApprovalRequests({
      clientInstanceId: runtime.clientInstanceId,
      kinds: [DATA_STORE_REVIEW_NOTICE_KIND],
      status: "pending",
      subjectContains: { dataStoreId: store.record.id },
      page: { limit: 1 }
    });
    if (pending.length > 0) return;
    await runtime.stores.approvals.createApprovalRequest({
      clientInstanceId: runtime.clientInstanceId,
      kind: DATA_STORE_REVIEW_NOTICE_KIND,
      summary: `Fields of the Data Store '${store.record.name}' wait for review`,
      payload: { subject: subjectOf(store) },
      requestedBy: SYSTEM_REQUESTER
    });
  } catch (error) {
    runtime.logger.error(
      { storeId: store.record.id, err: error },
      "The review notice of a store could not be filed"
    );
  }
}
