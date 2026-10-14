import type { LiveOnceSwitchStore } from "@vivd-catalyst/core";
import * as operations from "../postgres-live-once-switch-operations";
import type { PostgresConnection } from "../postgres-database";

export function createPostgresLiveOnceSwitchesStore(db: PostgresConnection): LiveOnceSwitchStore {
  return {
    switchOn: (input) => operations.switchLiveOnceOn(db, input),
    take: (input) => operations.takeLiveOnceSwitch(db, input),
    clearStale: (input) => operations.clearStaleLiveOnceSwitches(db, input),
    list: (input) => operations.listLiveOnceSwitches(db, input)
  };
}
