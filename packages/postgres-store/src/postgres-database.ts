import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { schema } from "./schema";

type PostgresDatabase = PostgresJsDatabase<typeof schema>;
export type PostgresTransaction = Parameters<Parameters<PostgresDatabase["transaction"]>[0]>[0];

/** Internal connection shared by pool-bound and transaction-bound factories. */
export type PostgresConnection = PostgresDatabase | PostgresTransaction;
