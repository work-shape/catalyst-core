import { and, eq, gt, lte, notExists, sql } from "drizzle-orm";
import type { DraftHostOwner, PagesStore } from "@work-shape/catalyst-core";
import type { PostgresConnection } from "./postgres-database";
import { configAssets } from "./schema/configAssets";
import { draftHostAllowances, fileSets } from "./schema/pages";

// One person's allowance of an outside host for their own view of a draft (DRAFT-HOSTS-1).

type Input<Method extends keyof PagesStore> = Parameters<PagesStore[Method]>[0];

/** The rows of one owner. */
function ofOwner(owner: DraftHostOwner) {
  return owner.kind === "app"
    ? eq(draftHostAllowances.appId, owner.id)
    : eq(draftHostAllowances.pageId, owner.id);
}

/** How the file sets of the owner are owned. */
function fileSetsOf(owner: DraftHostOwner) {
  return and(
    eq(fileSets.ownerKind, owner.kind === "app" ? "asset" : "page"),
    eq(fileSets.ownerId, owner.id)
  );
}

export async function allowDraftHost(
  db: PostgresConnection,
  input: Input<"allowDraftHost">
): Promise<boolean> {
  const { owner, draftOf } = input;
  const values = {
    clientInstanceId: input.clientInstanceId,
    ...(owner.kind === "app" ? { appId: owner.id } : { pageId: owner.id }),
    userId: input.userId,
    host: input.host,
    fileSetNumber: input.fileSetNumber,
    allowedAt: new Date(input.allowedAt)
  };
  return db.transaction(async (tx) => {
    if (draftOf) {
      // A publish or a discard moves these pointers in the transaction that removes the
      // allowances: the share lock waits for it and then reads what it left, or holds it
      // until this row is stored, which it then removes.
      const [asset] = await tx
        .select({
          activeRevisionId: configAssets.activeRevisionId,
          publishedRevisionId: configAssets.publishedRevisionId
        })
        .from(configAssets)
        .where(
          and(
            eq(configAssets.clientInstanceId, input.clientInstanceId),
            eq(configAssets.id, owner.id)
          )
        )
        .for("share");
      if (
        asset?.activeRevisionId !== draftOf.activeRevisionId ||
        (asset.publishedRevisionId ?? undefined) !== draftOf.publishedRevisionId
      ) {
        return false;
      }
    }
    await tx
      .insert(draftHostAllowances)
      .values(values)
      .onConflictDoUpdate({
        target:
          owner.kind === "app"
            ? [draftHostAllowances.appId, draftHostAllowances.userId, draftHostAllowances.host]
            : [draftHostAllowances.pageId, draftHostAllowances.userId, draftHostAllowances.host],
        set: { fileSetNumber: values.fileSetNumber, allowedAt: values.allowedAt }
      });
    return true;
  });
}

export async function listDraftHostAllowances(
  db: PostgresConnection,
  input: Input<"listDraftHostAllowances">
): Promise<string[]> {
  const { owner } = input;
  // A file set of the owner after the one the host was allowed on, up to the one shown, whose
  // manifest does not list the host: the host left the draft, and its allowance with it.
  const left = db
    .select({ one: sql`1` })
    .from(fileSets)
    .where(
      and(
        eq(fileSets.clientInstanceId, input.clientInstanceId),
        fileSetsOf(owner),
        gt(fileSets.number, draftHostAllowances.fileSetNumber),
        lte(fileSets.number, input.shownNumber),
        sql`not (coalesce(${fileSets.manifest} -> 'externalHosts', '[]'::jsonb) ? ${draftHostAllowances.host})`
      )
    );
  const rows = await db
    .select({ host: draftHostAllowances.host })
    .from(draftHostAllowances)
    .where(
      and(
        eq(draftHostAllowances.clientInstanceId, input.clientInstanceId),
        ofOwner(owner),
        eq(draftHostAllowances.userId, input.userId),
        lte(draftHostAllowances.fileSetNumber, input.shownNumber),
        notExists(left)
      )
    )
    .orderBy(draftHostAllowances.host);
  return rows.map((row) => row.host);
}

export async function removeDraftHostAllowances(
  db: PostgresConnection,
  input: Input<"removeDraftHostAllowances">
): Promise<number> {
  const removed = await db
    .delete(draftHostAllowances)
    .where(
      and(eq(draftHostAllowances.clientInstanceId, input.clientInstanceId), ofOwner(input.owner))
    )
    .returning({ host: draftHostAllowances.host });
  return removed.length;
}
