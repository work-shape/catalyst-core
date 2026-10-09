import { type StructuredDataResourceRecord, type StructuredDataStore } from "@vivd-catalyst/core";
import {
  getStructuredDataResource as getPostgresStructuredDataResource,
  listStructuredDataResources as listPostgresStructuredDataResources,
  publishStructuredDataResource as publishPostgresStructuredDataResource
} from "../postgres-structured-data-operations";
import type { PostgresConnection } from "../postgres-database";
export function createPostgresStructuredDataStore(db: PostgresConnection): StructuredDataStore {
  return {
    async getStructuredDataResource(
      input: Parameters<StructuredDataStore["getStructuredDataResource"]>[0]
    ): Promise<StructuredDataResourceRecord | undefined> {
      return getPostgresStructuredDataResource(db, input);
    },
    async listStructuredDataResources(
      input: Parameters<StructuredDataStore["listStructuredDataResources"]>[0]
    ): Promise<StructuredDataResourceRecord[]> {
      return listPostgresStructuredDataResources(db, input);
    },
    async publishStructuredDataResource(
      input: Parameters<StructuredDataStore["publishStructuredDataResource"]>[0]
    ): Promise<StructuredDataResourceRecord> {
      return publishPostgresStructuredDataResource(db, input);
    }
  };
}
