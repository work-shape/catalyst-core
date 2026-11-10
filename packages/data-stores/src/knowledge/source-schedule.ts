import { z } from "zod";
import {
  CONNECTION_ASSET_KIND,
  type ClientInstanceId,
  type PlatformStores
} from "@work-shape/catalyst-core";
import { KNOWLEDGE_SOURCE_SYNC_OFF } from "./definition";
import type { SyncedSource } from "./source-boundary";

// When a synced source syncs by itself (spec: Freshness, SRC-SYNC): its own `schedule`, with the
// instance's defaults where it names none. The source tick starts passes from it, and
// `knowledge.<id>.sources` answers it, so both read one rule.

/** The `changes` poll of a source whose connector type `knowledge.sourcePollMinutes` does not name. */
const SOURCE_POLL_MINUTES_DEFAULT = 15;
/** The full pass of a source that sets none: nightly at 02:00. */
const SOURCE_FULL_PASS_DEFAULT = "0 2 * * *";

/** A source's schedule as it applies: minutes or `off`, a cron expression or `off`. */
export interface SourceSchedule {
  changes: number | typeof KNOWLEDGE_SOURCE_SYNC_OFF;
  full: string;
}

export function sourceScheduleOf(source: SyncedSource, defaultPollMinutes: number): SourceSchedule {
  return {
    changes: source.schedule?.changes ?? defaultPollMinutes,
    full: source.schedule?.full ?? SOURCE_FULL_PASS_DEFAULT
  };
}

/**
 * How often each Connection's source is polled by default: `knowledge.sourcePollMinutes` of its
 * connector type. Reads nothing unless the setting names a type.
 */
export async function sourcePollMinutesOf(
  runtime: { stores: PlatformStores; clientInstanceId: ClientInstanceId },
  setting: Readonly<Record<string, number>> = {},
  connections: readonly string[]
): Promise<(connection: string) => number> {
  const byConnection = new Map<string, number>();
  if (connections.length && Object.keys(setting).length) {
    const rows = await runtime.stores.configAssets.listConfigAssetsByKey({
      clientInstanceId: runtime.clientInstanceId,
      keys: connections.map((name) => ({ kind: CONNECTION_ASSET_KIND, name }))
    });
    for (const row of rows) {
      const parsed = z.object({ connectorType: z.string() }).safeParse(row.config);
      const minutes = parsed.success ? setting[parsed.data.connectorType] : undefined;
      if (minutes !== undefined) byConnection.set(row.name, minutes);
    }
  }
  return (connection) => byConnection.get(connection) ?? SOURCE_POLL_MINUTES_DEFAULT;
}
