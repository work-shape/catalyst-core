import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { schema } from "./schema";

export type PostgresDatabase = PostgresJsDatabase<typeof schema>;
export type PostgresTransaction = Parameters<Parameters<PostgresDatabase["transaction"]>[0]>[0];
