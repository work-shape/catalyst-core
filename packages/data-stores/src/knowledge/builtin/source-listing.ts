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
import {
  sourceBoundaryKey,
  sourceExcludesFolder,
  withinSource,
  type SyncedSource
} from "../source-boundary";
import { sourceBoundary } from "../source-urls";
import { createSourceStore, sourceTransaction, type SourceProgress } from "./source-store";
import {
  sourceCall,
  sourceMaxFileBytes,
  sourceTarget,
  type SourceJobRuntime
} from "./source-runtime";
import { reconcileSource } from "./source-reconciliation";

/**
 * A listing position up to this size is written with every page. A larger one, such as a walk
 * that carries the folders still to list, is written at most every `POSITION_WRITE_MS` and when
 * the listing ends or a call fails: a resume lists the pages since again, and every write of a
 * page is idempotent.
 */
const POSITION_SMALL_CHARS = 16 * 1024;
const POSITION_WRITE_MS = 30_000;

/**
 * No outside call runs in the page transaction. The cursor commits with its effects, or after
 * them: a position is never ahead of what its pages wrote.
 */
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
  const boundary = sourceBoundary(source);
  const excludesFolder = sourceExcludesFolder(source);
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
  /** The position of the pages committed since it was last written, if any. */
  let unwritten: SourceProgress | undefined;
  let writtenAt: number | undefined;
  /** A rate limit or an outage resumes from the last page, not from the last written position. */
  const keepPosition = async (error: unknown): Promise<never> => {
    const position = unwritten;
    if (position)
      await sourceTransaction(runtime.data, payload, control, (store) =>
        store.position(payload, position)
      ).catch(() => undefined);
    throw error;
  };
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
        feedCursor: page.nextCursor,
        ...(next.limited ? { limited: true } : {})
      };
      await current();
      const queued = await sourceTransaction(runtime.data, payload, control, async (store) => {
        const ids: string[] = [];
        const upserts: DocumentSourceItem[] = [];
        let limited = false;
        // The page's position is written once, after its last statement, in this transaction.
        async function flush() {
          if (!upserts.length) return;
          const page = await store.page(
            payload,
            upserts,
            undefined,
            runtime.input.documentFormats,
            runtime.input.maxDocuments,
            sourceMaxFileBytes(runtime.input)
          );
          // A new item held back at the limit holds back no deletion behind it.
          limited ||= page.limited;
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
          limited ? { ...after, limited } : after,
          runtime.input.documentFormats,
          runtime.input.maxDocuments,
          sourceMaxFileBytes(runtime.input)
        );
        return { ids, limited };
      });
      next = queued.limited ? { ...after, limited: true } : after;
      await queue(queued.ids);
    } else {
      const page = await call(({ capability, context }) =>
        capability.list(
          {
            boundary,
            ...(next?.pageToken ? { pageToken: next.pageToken } : {}),
            ...(excludesFolder ? { excludesFolder } : {})
          },
          context
        )
      ).catch(keepPosition);
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
        ...(next.feedCursor === undefined ? {} : { feedCursor: next.feedCursor }),
        ...(next.limited ? { limited: true } : {})
      };
      const write =
        after.complete ||
        (after.pageToken?.length ?? 0) <= POSITION_SMALL_CHARS ||
        writtenAt === undefined ||
        Date.now() - writtenAt >= POSITION_WRITE_MS;
      await current();
      const result = await sourceTransaction(runtime.data, payload, control, (store) =>
        store.page(
          payload,
          items.filter((item) => withinSource(source, item)),
          write ? after : undefined,
          runtime.input.documentFormats,
          runtime.input.maxDocuments,
          sourceMaxFileBytes(runtime.input)
        )
      );
      // Past the limit the listing goes on: what it does not name is withdrawn at its end.
      next = result.limited ? { ...after, limited: true } : after;
      if (write) writtenAt = Date.now();
      unwritten = write ? undefined : next;
      await queue(result.queued);
    }
  }
  if (next.listing && !next.reconciled && !(await reconcileSource(runtime, payload, control, next)))
    return;
  await sourceTransaction(runtime.data, payload, control, (store) => store.finish(payload));
}
