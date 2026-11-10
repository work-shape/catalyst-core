import { z } from "zod";
import {
  CONNECTION_ASSET_KIND,
  type ClientInstanceId,
  type DocumentSourceSchedule,
  type PlatformStores
} from "@work-shape/catalyst-core";
import { KNOWLEDGE_SOURCE_SYNC_OFF } from "./definition";
import type { SyncedSource } from "./source-boundary";

// When a synced source syncs by itself (spec: Freshness, SRC-SYNC): its own `schedule`, with the
// defaults of its connector type where it names none. The source tick starts passes from it,
// `knowledge.<id>.sources` answers it, and the publish holds a source to its type's floor, so all
// three read one rule.

/** The `changes` poll of a source whose connector type names none. */
const SOURCE_POLL_MINUTES_DEFAULT = 15;
/** The full pass of a source whose connector type names none: nightly at 02:00. */
const SOURCE_FULL_PASS_DEFAULT = "0 2 * * *";

/**
 * What applies to a source of each connector type where it sets nothing: the type's own
 * `DocumentSourceSchedule`, its `changes` replaced by `knowledge.sourcePollMinutes` where that
 * names the type. The assembly builds it once; a type it does not name takes the platform's.
 */
export type SourceDefaultsByType = Readonly<Record<string, DocumentSourceSchedule>>;

/** The defaults one source takes, the platform's filled in. */
export interface SourceDefaults {
  changes: number;
  full: string;
  minChanges?: number;
}

/** A source's schedule as it applies: minutes or `off`, a cron expression or `off`. */
export interface SourceSchedule {
  changes: number | typeof KNOWLEDGE_SOURCE_SYNC_OFF;
  full: string;
}

/**
 * A source's schedule as it applies. A `changes` below its type's floor, published before the
 * type had one, polls at the floor: the publish refuses a new one.
 */
export function sourceScheduleOf(source: SyncedSource, defaults: SourceDefaults): SourceSchedule {
  const changes = source.schedule?.changes ?? defaults.changes;
  return {
    changes:
      changes === KNOWLEDGE_SOURCE_SYNC_OFF ? changes : Math.max(changes, defaults.minChanges ?? 0),
    full: source.schedule?.full ?? defaults.full
  };
}

/** The defaults of a connector type, the platform's where it names none. */
export function sourceDefaultsOfType(
  byType: SourceDefaultsByType,
  connectorType: string | undefined
): SourceDefaults {
  const own = connectorType === undefined ? undefined : byType[connectorType];
  return {
    changes: own?.changes ?? SOURCE_POLL_MINUTES_DEFAULT,
    full: own?.full ?? SOURCE_FULL_PASS_DEFAULT,
    ...(own?.minChanges === undefined ? {} : { minChanges: own.minChanges })
  };
}

/** The connector type a Connection's config names, where it names one. */
export function connectorTypeOf(config: unknown): string | undefined {
  const parsed = z.object({ connectorType: z.string() }).safeParse(config);
  return parsed.success ? parsed.data.connectorType : undefined;
}

/**
 * The defaults of each Connection's source: those of its connector type. Reads nothing unless a
 * type has defaults of its own.
 */
export async function sourceDefaultsOf(
  runtime: { stores: PlatformStores; clientInstanceId: ClientInstanceId },
  byType: SourceDefaultsByType = {},
  connections: readonly string[]
): Promise<(connection: string) => SourceDefaults> {
  const typeOf = new Map<string, string | undefined>();
  if (connections.length && Object.keys(byType).length) {
    const rows = await runtime.stores.configAssets.listConfigAssetsByKey({
      clientInstanceId: runtime.clientInstanceId,
      keys: connections.map((name) => ({ kind: CONNECTION_ASSET_KIND, name }))
    });
    for (const row of rows) typeOf.set(row.name, connectorTypeOf(row.config));
  }
  return (connection) => sourceDefaultsOfType(byType, typeOf.get(connection));
}
