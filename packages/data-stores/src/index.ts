import { defineModule } from "@vivd-catalyst/core";

/**
 * Data Stores: the asset kind `data_store`, a database of the platform per store, and the
 * operations on its rows. The module is registered and contributes nothing yet, so an instance
 * that turns it on runs as it does with it off.
 */
export const dataStoresModule = defineModule({ name: "dataStores" });

/**
 * Knowledge Bases: the asset kind `knowledge_base`, ingestion, and the search and query
 * operations of each. A module of its own, because a Knowledge Base on an existing database
 * needs no Data Store. It is registered and contributes nothing yet.
 */
export const knowledgeModule = defineModule({ name: "knowledge" });
