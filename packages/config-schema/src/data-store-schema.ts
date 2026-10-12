import { z } from "zod";

/** A size as release config and `store.yaml` write it: a whole number of MB or GB. */
const SIZE_PATTERN = /^[1-9]\d{0,5}(?:MB|GB)$/u;

/**
 * What an operator sets for the Data Stores of an instance, which share the Postgres server of
 * the platform database. `sizeLimit` is the most one store may hold: a store's manifest may
 * name less and never more, and at the limit rows are no longer added. `poolMaxConnections`
 * is the most connections the platform holds to one store at once; it stays below the
 * connection limit of the store's role, which is 10.
 */
export const dataStoresConfigSchema = z
  .object({
    sizeLimit: z
      .string()
      .regex(SIZE_PATTERN, "a whole number of MB or GB, such as 500MB or 5GB")
      .default("5GB"),
    poolMaxConnections: z.number().int().min(1).max(10).default(5)
  })
  .strict()
  .prefault({});
