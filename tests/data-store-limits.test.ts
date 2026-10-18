import { expect, it } from "vitest";
import { parseClientInstanceConfig } from "@work-shape/catalyst-config-schema";
import { createTestConfig } from "./support/fixtures";

it("keeps bulk load ceilings under operator control", () => {
  const base = createTestConfig();
  const load = { rows: 1_000_000, bytes: 1_073_741_824, timeoutMs: 3_600_000 };
  expect(parseClientInstanceConfig({ ...base, dataStores: { load } }).dataStores.load).toEqual(
    load
  );
  expect(() => parseClientInstanceConfig({ ...base, dataStores: { load: { rows: 0 } } })).toThrow();
});
