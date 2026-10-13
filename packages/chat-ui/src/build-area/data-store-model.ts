import type { LocaleCode } from "@vivd-catalyst/api-client";
import type { BadgeTone } from "@vivd-catalyst/ui";
import type { TranslationKey } from "../i18n";
import type { DataStoreState } from "./data-store-source";

/** What the list and the page say of a store's state: one word and one sentence each. */
export type DataStoreStateView =
  "ready" | "provisioning" | "provisioning_failed" | "migrations_pending" | "migration_failed";

export const DATA_STORE_STATE_VIEWS: Record<
  DataStoreStateView,
  { tone: BadgeTone; label: TranslationKey; text: TranslationKey }
> = {
  ready: { tone: "success", label: "dataStores.stateReady", text: "dataStores.stateReadyText" },
  provisioning: {
    tone: "info",
    label: "dataStores.stateProvisioning",
    text: "dataStores.stateProvisioningText"
  },
  provisioning_failed: {
    tone: "danger",
    label: "dataStores.stateProvisioningFailed",
    text: "dataStores.stateProvisioningFailedText"
  },
  migrations_pending: {
    tone: "warning",
    label: "dataStores.stateMigrationsPending",
    text: "dataStores.stateMigrationsPendingText"
  },
  migration_failed: {
    tone: "danger",
    label: "dataStores.stateMigrationFailed",
    text: "dataStores.stateMigrationFailedText"
  }
};

/**
 * The one state a store is named by. A store whose rows are reached is ready, unless the last
 * attempt to bring it to its published revision failed or still waits.
 */
export function dataStoreStateView(state: DataStoreState): DataStoreStateView {
  const { outcome } = state.lastMigration;
  if (state.status !== "ready") {
    return outcome === "failed" ? "provisioning_failed" : "provisioning";
  }
  return outcome === "failed"
    ? "migration_failed"
    : outcome === "pending"
      ? "migrations_pending"
      : "ready";
}

type DataStoreConditionCode = DataStoreState["conditions"][number]["code"];

/** What the server leaves open around a store, in a few words. The server's sentence says the rest. */
export const DATA_STORE_CONDITION_LABELS: Record<DataStoreConditionCode, TranslationKey> = {
  server_databases_open: "dataStores.conditionServerDatabasesOpen",
  sessions_open: "dataStores.conditionSessionsOpen",
  temp_files_unbounded: "dataStores.conditionTempFilesUnbounded"
};

const BYTE_UNITS = ["byte", "kilobyte", "megabyte", "gigabyte"] as const;

/** A size in the largest unit that keeps it at one or above, with one decimal at most. */
export function formatDataStoreSize(bytes: number, locale: LocaleCode): string {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: BYTE_UNITS[unit],
    unitDisplay: "short",
    maximumFractionDigits: value < 10 && unit > 0 ? 1 : 0
  }).format(value);
}

/** A migration as its file is numbered: `0003`. */
export function migrationNumber(number: number): string {
  return String(number).padStart(4, "0");
}

/** How long a value of a row may be before its cell cuts it, in characters. */
export const DATA_STORE_CELL_WIDTH = 40;

/** A value of a row as text: a text as it is, everything else as the JSON it is. `null` has none. */
export function cellText(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** A value read whole as the text its dialog shows: a text as it is, everything else as JSON over lines. */
export function wholeValueText(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}
