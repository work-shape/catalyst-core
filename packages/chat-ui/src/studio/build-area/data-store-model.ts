import type { ApiClient, LocaleCode } from "@work-shape/catalyst-api-client";
import type { BadgeTone } from "@work-shape/catalyst-ui";
import type { TranslationKey } from "../../shared/i18n";
import { formatMomentShort } from "../../shared/locale-format";

/** The state of one Data Store, as `data_stores.get` answers it. */
export type DataStoreState = Awaited<ReturnType<ApiClient["data_stores"]["get"]>>;

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

/**
 * Whether a store is on its way to a state of its own: its database is being set up, or a
 * migration of its published revision still waits. A failure and a ready store stay as they are.
 */
export function dataStoreStateSettling(state: DataStoreState): boolean {
  const view = dataStoreStateView(state);
  return view === "provisioning" || view === "migrations_pending";
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

/**
 * A date or a moment of a row as the reader's language writes it: "15.12.2026" in German. A
 * date is a day of the calendar, so it is read in UTC and never moves by the reader's zone.
 * Any other value, and a value that is no such date, has none.
 */
export function cellDateText(value: unknown, type: string, locale: LocaleCode): string | undefined {
  if (typeof value !== "string" || (type !== "date" && type !== "timestamp")) return undefined;
  if (Number.isNaN(Date.parse(value))) return undefined;
  return type === "date"
    ? new Date(value).toLocaleDateString(locale, { dateStyle: "medium", timeZone: "UTC" })
    : formatMomentShort(value, locale);
}

const COLUMN_TYPE_LABELS: Readonly<Record<string, TranslationKey>> = {
  text: "dataStores.typeText",
  integer: "dataStores.typeInteger",
  number: "dataStores.typeNumber",
  boolean: "dataStores.typeBoolean",
  date: "dataStores.typeDate",
  timestamp: "dataStores.typeTimestamp"
};

/**
 * A column's type in the reader's words, and the database's name for it only where that says
 * more: "Ganzzahl" over `bigint`, but "Text" alone where the database says `text` too. A type
 * the product has no word for is named by the database alone.
 */
export function columnTypeView(column: { type: string; nativeType: string }): {
  label?: { key: TranslationKey; list: boolean };
  native?: string;
} {
  const list = column.type.endsWith("[]");
  const key = COLUMN_TYPE_LABELS[list ? column.type.slice(0, -2) : column.type];
  if (key === undefined) return { native: column.nativeType };
  return {
    label: { key, list },
    ...(column.nativeType === column.type ? {} : { native: column.nativeType })
  };
}
