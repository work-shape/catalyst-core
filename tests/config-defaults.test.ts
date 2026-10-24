import { it } from "vitest";
import * as configSchemas from "@work-shape/catalyst-config-schema";
import { safeConfigSchema } from "@work-shape/catalyst-api-contract";
import { dataStoreRecordsRuleSchema } from "@work-shape/catalyst-asset-schemas";
import { assertIndependentSchemaDefaults } from "./support/schema-defaults";

it("never shares objects or arrays between independently parsed config defaults", () => {
  assertIndependentSchemaDefaults({
    ...configSchemas,
    safeConfigSchema,
    dataStoreRecordsRuleSchema
  });
});
