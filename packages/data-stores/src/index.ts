import { defineModule } from "@vivd-catalyst/core";

/**
 * Data Stores: the asset kind `data_store`, a database of the platform per store, and the
 * operations on its rows. The module is registered and contributes nothing yet, so an instance
 * that turns it on runs as it does with it off.
 */
export const dataStoresModule = defineModule({ name: "dataStores" });
