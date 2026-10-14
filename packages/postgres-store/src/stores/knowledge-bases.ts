import { and, eq } from "drizzle-orm";
import type {
  ClientInstanceId,
  KnowledgeBaseState,
  KnowledgeBaseStateStore
} from "@vivd-catalyst/core";
import type { PostgresConnection } from "../postgres-database";
import { knowledgeBaseStates } from "../schema";

type Row = typeof knowledgeBaseStates.$inferSelect;

function mapState(row: Row): KnowledgeBaseState {
  return {
    clientInstanceId: row.clientInstanceId,
    assetId: row.assetId,
    revision: row.revision,
    status: row.status,
    tables: row.tables,
    ...(row.problem === null ? {} : { problem: row.problem }),
    checkedAt: row.checkedAt.toISOString()
  };
}

/** The only code that reads or writes `knowledge_base_states`. */
export function createPostgresKnowledgeBaseStateStore(
  db: PostgresConnection
): KnowledgeBaseStateStore {
  const of = (clientInstanceId: ClientInstanceId, assetId: string) =>
    and(
      eq(knowledgeBaseStates.clientInstanceId, clientInstanceId),
      eq(knowledgeBaseStates.assetId, assetId)
    );
  return {
    async getKnowledgeBaseState({ clientInstanceId, assetId }) {
      const [row] = await db
        .select()
        .from(knowledgeBaseStates)
        .where(of(clientInstanceId, assetId))
        .limit(1);
      return row ? mapState(row) : undefined;
    },
    async putKnowledgeBaseState(state) {
      const changed = {
        revision: state.revision,
        status: state.status,
        tables: state.tables,
        problem: state.problem ?? null,
        checkedAt: new Date(state.checkedAt)
      };
      await db
        .insert(knowledgeBaseStates)
        .values({ clientInstanceId: state.clientInstanceId, assetId: state.assetId, ...changed })
        .onConflictDoUpdate({
          target: [knowledgeBaseStates.clientInstanceId, knowledgeBaseStates.assetId],
          set: changed
        });
    },
    async deleteKnowledgeBaseState({ clientInstanceId, assetId }) {
      await db.delete(knowledgeBaseStates).where(of(clientInstanceId, assetId));
    }
  };
}
