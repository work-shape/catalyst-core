import { randomBytes } from "node:crypto";
import { parseClientInstanceConfig } from "@vivd-catalyst/config-schema";
import { createTestConfig } from "./fixtures";
import { createTestInstance, getTestExecution, type TestRoute } from "./test-instance";

/**
 * The routes the module `dataStores` adds to a server, built by its seam in an assembly with
 * the module on. For a test that builds its server from options alone and still asks about
 * every operation of the catalog: it hands this to `createTestInstanceWith` as what to
 * register. The assembly stays open with the suite, since the routes answer from it.
 */
export async function dataStoreRoutes(): Promise<(route: TestRoute) => void> {
  const key = "DATA_STORE_ROUTES_TEST_KEY";
  const assembly = await createTestInstance({
    execution: {
      config: parseClientInstanceConfig({
        ...createTestConfig(),
        modules: { dataStores: { enabled: true } },
        secretStore: { keys: [{ id: "k1", ref: key }] }
      }),
      env: { [key]: randomBytes(32).toString("base64") },
      tools: []
    }
  });
  const { routes } = getTestExecution(assembly).modulesStarted;
  return (route) => routes.forEach((register) => register(route));
}
