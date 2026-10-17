import type { KnowledgeListingMode } from "../source-port";
import { z } from "zod";
import {
  DocumentSourceError,
  documentSourceChangeSchema,
  documentSourceItemSchema,
  type DocumentSourceItem,
  type JobControl,
  type KnowledgeSyncJobPayload
} from "@work-shape/catalyst-core";
import { sourceBoundaryKey, withinSource, type SyncedSource } from "../source-boundary";
import { createSourceStore, sourceTransaction, type SourceProgress } from "./source-store";
import { sourceCall, sourceTarget, type SourceJobRuntime } from "./source-runtime";
import { reconcileSource } from "./source-reconciliation";

/** No outside call runs in the page transaction. The cursor commits with its effects. */
export async function readSourcePages(
  runtime: SourceJobRuntime,
  payload: KnowledgeSyncJobPayload,
  control: JobControl,
  source: SyncedSource,
  mode: KnowledgeListingMode,
  progress: SourceProgress | undefined,
  queue: (ids: string[]) => Promise<void>
) {
  const store = createSourceStore(runtime.data, payload.knowledgeBaseId, control.signal);
  const boundary = { folderIds: source.folders };
  const call = <T>(fn: Parameters<typeof sourceCall<T>>[4]) =>
    sourceCall(runtime, source.connection, payload.knowledgeBaseId, control.signal, fn);
  const current = async () => {
    const found = await sourceTarget(runtime, payload);
    if (!found || sourceBoundaryKey(found.source) !== sourceBoundaryKey(source))
      throw new DocumentSourceError("unauthorized", "The published source changed");
  };
  let next = progress;
  if (!next) {
    const [row] = await store.change((sql) =>
      sql.run(
        "select cursor,definition_key from catalyst_kb.source_cursors where source_id=$1::text",
        [payload.sourceId]
      )
    );
    const stored = z
      .object({ cursor: z.string(), definition_key: z.string().nullable() })
      .optional()
      .parse(row);
    const cursor = stored?.definition_key === sourceBoundaryKey(source) ? stored.cursor : undefined;
    if (mode === "changes" && cursor) {
      next = { complete: false, listing: false, feedCursor: cursor };
    } else {
      const feed = await call(({ capability, context }) =>
        capability.changes({ boundary }, context)
      );
      next = {
        complete: false,
        listing: true,
        ...(feed.kind === "changes" ? { feedCursor: feed.nextCursor } : {})
      };
    }
  }
  while (!next.complete) {
    if (!next.listing && mode === "changes") {
      const page = await call(({ capability, context }) =>
        capability.changes(
          { boundary, ...(next?.feedCursor ? { cursor: next.feedCursor } : {}) },
          context
        )
      );
      if (page.kind === "not_offered") {
        next = { complete: false, listing: true };
        continue;
      }
      const changes = z.array(documentSourceChangeSchema).max(1000).parse(page.changes);
      if (changes.length && page.nextCursor === next.feedCursor)
        throw new DocumentSourceError("unavailable", "The source repeated its change cursor");
      const after: SourceProgress = {
        complete: changes.length === 0 && page.nextCursor === next.feedCursor,
        listing: false,
        reconciled: true,
        feedCursor: page.nextCursor
      };
      await current();
      const queued = await sourceTransaction(runtime.data, payload, control, async (store) => {
        const ids: string[] = [];
        const upserts: DocumentSourceItem[] = [];
        async function flush() {
          if (!upserts.length) return;
          const page = await store.page(
            payload,
            upserts,
            { ...after, complete: false },
            runtime.input.documentFormats,
            runtime.input.maxDocuments
          );
          if (page.limited)
            throw new DocumentSourceError(
              "over_limit",
              "The source reached knowledge.maxDocuments"
            );
          ids.push(...page.queued);
          upserts.length = 0;
        }
        // Keep feed order without repeating admission/count work for each upsert.
        for (const change of changes) {
          if (change.kind === "upsert" && withinSource(source, change.item))
            upserts.push(change.item);
          else {
            await flush();
            const rows = await store.change((sql) =>
              sql.run(
                "select id from catalyst_kb.source_items where source_id=$1::text and item_id=$2::text",
                [payload.sourceId, change.item.id]
              )
            );
            await store.withdraw(
              payload,
              z
                .array(z.object({ id: z.string() }))
                .parse(rows)
                .map((row) => row.id)
            );
          }
        }
        await flush();
        await store.page(
          payload,
          [],
          after,
          runtime.input.documentFormats,
          runtime.input.maxDocuments
        );
        return ids;
      });
      await queue(queued);
      next = after;
    } else {
      const page = await call(({ capability, context }) =>
        capability.list(
          { boundary, ...(next?.pageToken ? { pageToken: next.pageToken } : {}) },
          context
        )
      );
      const items: DocumentSourceItem[] = z
        .array(documentSourceItemSchema)
        .max(1000)
        .parse(page.items);
      if (page.nextPageToken !== undefined && page.nextPageToken === next.pageToken)
        throw new DocumentSourceError("unavailable", "The source repeated its listing cursor");
      const after: SourceProgress = {
        complete: page.nextPageToken === undefined,
        listing: true,
        ...(page.nextPageToken === undefined ? {} : { pageToken: page.nextPageToken }),
        ...(next.feedCursor === undefined ? {} : { feedCursor: next.feedCursor })
      };
      await current();
      const result = await sourceTransaction(runtime.data, payload, control, (store) =>
        store.page(
          payload,
          items.filter((item) => withinSource(source, item)),
          after,
          runtime.input.documentFormats,
          runtime.input.maxDocuments
        )
      );
      await queue(result.queued);
      if (result.limited) {
        await sourceTransaction(runtime.data, payload, control, (store) =>
          store.finish(payload, "knowledge_source_limit_reached")
        );
        return;
      }
      next = after;
    }
  }
  if (next.listing && !next.reconciled && !(await reconcileSource(runtime, payload, control, next)))
    return;
  await sourceTransaction(runtime.data, payload, control, (store) => store.finish(payload));
}
