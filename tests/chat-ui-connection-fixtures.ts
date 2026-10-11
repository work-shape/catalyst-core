import type { ConnectionDetail, ConnectionTestResult } from "@vivd-catalyst/api-client";
import type { BuildAsset } from "@vivd-catalyst/chat-ui/build-area";

// The answers of `connections.get` and `connections.test` the Connection page is built
// against, one per state the page names. The unit test hands them to the page. The browser spec
// reads the instance, and answers with these only where the suite's Connector type cannot
// bring the state about.

/** A handle as the Secret Store hands one out. It is in the revision and never on the page. */
export const FIXTURE_SECRET_HANDLE = "secret_3f0c6a52-9d1b-4c7e-8a21-5b9e0d4c7f10";

/** The definition of the fixture Connection, as its revision holds it. */
function connectionConfig(name: string, overrides: Record<string, unknown> = {}) {
  return {
    name,
    displayName: "Sample business",
    description: "Revenue, customers and orders of the sample business.",
    connectorType: "mcp",
    ownerPrincipalId: "system",
    settings: { url: "https://sample-business.example.test/mcp", timeoutSeconds: 20 },
    authScheme: "bearer",
    credentialMode: "shared",
    secretHandle: FIXTURE_SECRET_HANDLE,
    operations: [],
    enabled: true,
    origin: "release",
    ...overrides
  };
}

export function connectionAsset(
  name = "sample-business",
  overrides: Record<string, unknown> = {}
): BuildAsset {
  return {
    id: `asset_${name}`,
    kind: "connection",
    name,
    scope: { kind: "instance" },
    revision: 1,
    config: connectionConfig(name, overrides),
    updatedAt: "2026-10-08T10:00:00.000Z"
  };
}

const TESTED_AT = "2026-10-10T09:30:00.000Z";

/** A Connection nobody has tested: the common state before the first test. */
export function connectionDetail(
  name = "sample-business",
  overrides: Partial<ConnectionDetail> = {}
): ConnectionDetail {
  return {
    name,
    health: "unknown",
    secret: { state: "set", version: 2 },
    sharedCredential: true,
    operations: [
      {
        name: "revenue_by_month",
        toolName: `connection.${name}.revenue_by_month`,
        effect: "reading",
        exposure: ["agent"],
        enabled: true,
        status: "ready",
        description: "Returns the revenue of each month of one year."
      },
      {
        name: "list_customers",
        toolName: `connection.${name}.list_customers`,
        effect: "reading",
        exposure: ["agent", "bridge", "workflow"],
        enabled: true,
        status: "awaiting_discovery"
      },
      {
        name: "update_customer",
        toolName: `connection.${name}.update_customer`,
        effect: "changing",
        exposure: [],
        enabled: true,
        status: "needs_review",
        description: "Changes the contact data of one customer.",
        discoveredFingerprint: "sha256:9f2c41d07a"
      },
      {
        name: "top_products",
        toolName: `connection.${name}.top_products`,
        effect: "reading",
        exposure: ["agent"],
        enabled: true,
        status: "unknown"
      },
      {
        name: "delete_order",
        toolName: `connection.${name}.delete_order`,
        effect: "changing",
        exposure: ["workflow"],
        enabled: false,
        status: "disabled"
      }
    ],
    usedBy: [
      {
        agentName: "workflow_assistant",
        title: "Workflow Assistant",
        toolNames: [`connection.${name}.revenue_by_month`, `connection.${name}.list_customers`]
      },
      {
        agentName: "tax-steuer_agent",
        title: "Steuer-Agent",
        toolNames: [`connection.${name}.revenue_by_month`]
      }
    ],
    ...overrides
  };
}

export function testResult(status: ConnectionTestResult["status"]): ConnectionTestResult {
  return { status, testedAt: TESTED_AT };
}

/** What the instance recorded, per state of the page that a read alone shows. */
export const recordedStates = {
  neverTested: {},
  ready: { health: "ok", lastTestedAt: TESTED_AT },
  unauthorized: {
    health: "failed",
    lastTestedAt: TESTED_AT,
    lastErrorCode: "upstream_unauthorized"
  },
  networkDenied: { health: "failed", lastTestedAt: TESTED_AT, lastErrorCode: "egress_denied" },
  unavailable: {
    health: "failed",
    lastTestedAt: TESTED_AT,
    lastErrorCode: "connection_unavailable"
  },
  failedUnnamed: { health: "failed", lastTestedAt: TESTED_AT, lastErrorCode: "upstream_error" },
  notConfigured: { health: "needs_configuration", secret: { state: "not_set" } },
  secretUnreadable: { health: "secret_unreadable", secret: { state: "unreadable" } }
} satisfies Record<string, Partial<ConnectionDetail>>;
