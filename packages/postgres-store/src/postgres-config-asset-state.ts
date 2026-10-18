import { eq } from "drizzle-orm";
import type { ConfigAssetState, ConfigAssetStore } from "@work-shape/catalyst-core";
import type { PostgresConnection } from "./postgres-database";
import { mapConfigAssetState } from "./rows";
import { configAssetState } from "./schema";

export async function getConfigAssetState(
  db: PostgresConnection,
  input: Parameters<ConfigAssetStore["getConfigAssetState"]>[0]
): Promise<ConfigAssetState> {
  const [row] = await db
    .select()
    .from(configAssetState)
    .where(eq(configAssetState.clientInstanceId, input.clientInstanceId))
    .limit(1);
  return mapConfigAssetState(row);
}
