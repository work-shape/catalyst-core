import { testDataStoreMaintenancePaging } from "./support/data-store-maintenance-paging";

// The former 2,000-store cap is proved nightly with CATALYST_SCALE_TESTS=1.
testDataStoreMaintenancePaging(2_001);
