import { expect } from "vitest";
import { z } from "zod";
import { parseClientInstanceConfig } from "@vivd-catalyst/config-schema";
import { discoverConnection, readConnectionCatalog } from "@vivd-catalyst/connections";
import { asClientInstanceId, type ConnectorOperationDescriptor } from "@vivd-catalyst/core";
import { required } from "./assertions";
import { createDiscoveringTestConnector, listedOperation } from "./discovering-test-connector";
import { createTestConfig, setTestAgent } from "./fixtures";
import { createTestConnector, generateSecretStoreKey, generateTestSecret } from "./test-connector";
import {
  createTestInstance,
  getTestExecution,
  getTestJobs,
  type TestInstance
} from "./test-instance";
import { withTestSql } from "./test-sql";

// What the tests of a Connection discovery share: one assembled instance with a discovering
// connector type, and the reads of what a discovery left behind.

export const clientInstanceId = asClientInstanceId("demo-local");
const KEY_VARIABLE = "CATALYST_SECRET_STORE_KEY";
const TOKEN_VARIABLE = "OUTSIDE_API_TOKEN";
/** A literal public address, so the egress check of these tests asks no resolver. */
const OUTSIDE_HOST = "93.184.216.34";
export const LOOKUP = "connection.outside.lookup";
export const LIST = "connection.outside.list";

type Entry = Record<string, unknown>;
export const operation = (name: string, further: Entry = {}): Entry => ({
  name,
  effect: "reading",
  exposure: ["agent"],
  ...further
});
export const outside = (overrides: Entry = {}): Entry => ({
  connectorType: "discovering",
  displayName: "Outside",
  settings: { url: `https://${OUTSIDE_HOST}/mcp` },
  authScheme: "bearer",
  secret: TOKEN_VARIABLE,
  operations: [operation("lookup"), operation("list")],
  ...overrides
});

interface Start {
  connections?: Record<string, Entry>;
  egress?: Entry[];
}

export function world(listed: readonly ConnectorOperationDescriptor[] = [lookup, list]) {
  const key = generateSecretStoreKey();
  const token = generateTestSecret();
  const connector = createDiscoveringTestConnector(listed);
  const staticConnector = createTestConnector();
  const env = { [KEY_VARIABLE]: key, [TOKEN_VARIABLE]: token };
  const input = (start: Start = {}) => {
    const config = parseClientInstanceConfig({
      ...createTestConfig({
        developmentAuth: {
          enabled: true,
          user: {
            id: "user-1",
            externalUserId: "user-1",
            displayLabel: "User",
            roles: ["user", "admin", "superadmin"]
          }
        }
      }),
      modules: { assetManagement: { enabled: true }, connections: { enabled: true } },
      administration: { agentConfiguration: { enabled: true, allowSkillEditing: true } },
      connections: start.connections ?? { outside: outside() },
      secretStore: { keys: [{ id: "k1", ref: KEY_VARIABLE }] },
      egress: { allow: start.egress ?? [{ protocol: "https", host: OUTSIDE_HOST, port: 443 }] }
    });
    setTestAgent(config, {
      name: "test_agent",
      displayName: "Test Agent",
      instructions: "Use configured tools only.",
      modelProviderId: "local",
      toolNames: [LOOKUP, LIST],
      initialPrompts: []
    });
    return { config, env, tools: [], connectorTypes: [connector.type, staticConnector.type] };
  };
  return {
    token,
    connector,
    input,
    /** One start of the API process. Its jobs run when a test says so. */
    start: (start: Start = {}) => createTestInstance(input(start)),
    /** The Connection tools an agent that lists `names` is given now. */
    async agentTools(start: Start = {}, names: readonly string[] = [LOOKUP, LIST]) {
      const execution = await createTestInstance({ execution: input(start) });
      try {
        const source = required(getTestExecution(execution).connections).toolSource;
        return (await source.describe(names, {})).map((tool) => tool.name).sort();
      } finally {
        await execution.close();
      }
    }
  };
}

export const lookup = listedOperation("lookup");
export const list = listedOperation("list");

const detailSchema = z.object({
  health: z.string(),
  lastErrorCode: z.string().optional(),
  discoveredAt: z.string().optional(),
  operations: z.array(
    z.object({
      name: z.string(),
      status: z.string(),
      description: z.string().optional(),
      discoveredFingerprint: z.string().optional()
    })
  )
});

export async function detail(instance: TestInstance, name = "outside") {
  const response = await instance.call("connections.get", { params: { name } });
  expect(response.statusCode).toBe(200);
  return detailSchema.parse(response.json());
}

export async function statuses(instance: TestInstance, name = "outside") {
  return Object.fromEntries(
    (await detail(instance, name)).operations.map((entry) => [entry.name, entry.status])
  );
}

export const runJobs = (instance: TestInstance) => getTestJobs(instance).runDue();

export const discoveryJobs = () =>
  withTestSql(
    (sql) => sql<{ subject: string; status: string; attempts: number; payload: unknown }[]>`
      select subject, status, attempts, payload from platform_jobs
      where kind = 'connection.discover' order by created_at, id`
  );

export async function storedState(instance: TestInstance, name = "outside") {
  const asset = required(
    await instance.stores.configAssets.getConfigAsset({
      clientInstanceId,
      kind: "connection",
      name
    })
  );
  const state = await instance.stores.connections.getConnectionState({
    clientInstanceId,
    connectionAssetId: asset.id
  });
  return { state, catalog: readConnectionCatalog(state?.catalog) };
}

export const auditEvents = async (instance: TestInstance) =>
  (await instance.stores.audit.listAuditEvents({ clientInstanceId, limit: 200 })).filter((event) =>
    event.type.startsWith("connection.")
  );

/** Discovers through the parts of an assembled process, as the job does. */
export async function discoverDirectly(
  w: ReturnType<typeof world>,
  signal = new AbortController().signal,
  further: Pick<Parameters<typeof discoverConnection>[0], "timeoutMs" | "transaction"> = {}
) {
  const execution = await createTestInstance({ execution: w.input() });
  try {
    const connections = required(getTestExecution(execution).connections);
    return await discoverConnection({
      clientInstanceId,
      connectionName: "outside",
      stores: execution.stores,
      connectorTypes: connections.connectorTypes,
      egress: connections.egress,
      credentials: connections.credentials,
      signal,
      ...further
    });
  } finally {
    await execution.close();
  }
}
