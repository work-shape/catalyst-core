import {
  DATA_STORE_LOAD_DEFAULT_LIMITS,
  DATA_STORE_QUERY_DEFAULT_TIMEOUT_MS
} from "@work-shape/catalyst-core";
import { z } from "zod";

/** A size as release config and `store.yaml` write it: a whole number of MB or GB. */
const SIZE_PATTERN = /^[1-9]\d{0,5}(?:MB|GB)$/u;

/**
 * What an operator sets for the Data Stores of an instance, which share the Postgres server of
 * the platform database. `sizeLimit` is the most one store may hold: a store's manifest may
 * name less and never more, and at the limit rows are no longer added. Every insert reads the
 * size of the database before it writes and after, and is rolled back where it passed the
 * limit: no row that is kept lies beyond it, and the files exceed it only by what the inserts
 * of one moment wrote, under 256 MiB for rows alone. `poolMaxConnections`
 * is the most connections the platform holds to one store at once; it stays below the
 * connection limit of the store's role, which is 10.
 */
export const dataStoresConfigSchema = z
  .object({
    sizeLimit: z
      .string()
      .regex(SIZE_PATTERN, "a whole number of MB or GB, such as 500MB or 5GB")
      .default("5GB"),
    /**
     * The most the test copy of one store may hold (ADR-0031, DT-2), never more than the store
     * itself: a copy is built from the draft's migrations and `seed/` files, and at the limit
     * its changing calls are refused as the store's are.
     */
    testCopySizeLimit: z
      .string()
      .regex(SIZE_PATTERN, "a whole number of MB or GB, such as 500MB or 5GB")
      .default("500MB"),
    /** Whole-cursor deadline for Workflow dataset queries. Ordinary reads keep their inline bounds. */
    queryTimeoutMs: z.number().int().positive().default(DATA_STORE_QUERY_DEFAULT_TIMEOUT_MS),
    poolMaxConnections: z.number().int().min(1).max(10).default(5),
    /** Ceilings for one atomic load. Raise them when the store can handle larger calls. */
    load: z
      .object({
        rows: z.number().int().positive().default(DATA_STORE_LOAD_DEFAULT_LIMITS.rows),
        bytes: z.number().int().positive().default(DATA_STORE_LOAD_DEFAULT_LIMITS.bytes),
        timeoutMs: z.number().int().positive().default(DATA_STORE_LOAD_DEFAULT_LIMITS.timeoutMs)
      })
      .strict()
      .prefault({})
  })
  .strict()
  .prefault({});
