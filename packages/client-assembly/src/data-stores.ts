import { dataStoresModule } from "@vivd-catalyst/data-stores";
import type { ModuleSeam } from "./module-assembly";

export { dataStoresModule };

/** What an instance with the module `dataStores` on has for its Data Stores. Nothing yet. */
export const assembleDataStores: ModuleSeam = ({ modules }) =>
  modules.isEnabled(dataStoresModule.name) ? {} : undefined;
