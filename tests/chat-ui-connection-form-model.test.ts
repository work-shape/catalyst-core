import { describe, expect, it } from "vitest";
import {
  DISCOVERY_WAIT_MS,
  connectionConfigToForm,
  newConnectionConfig,
  emptyConnectionForm,
  waitsForDiscovery,
  withApprovedOperations,
  withConnectionForm,
  withOperationExposure,
  withReviewedOperation,
  withoutOperation,
  type ConnectionFormState
} from "@work-shape/catalyst-chat-ui/build-area";

// What the form of a Connection made on the instance writes. The page holds the state; these
// make the definitions it saves. None of them carries a key.

const FINGERPRINT = "f".repeat(64);

describe("the form of a Connection", () => {
  it("makes a new MCP Connection that accepts nothing, with the header only where it is read", () => {
    const form: ConnectionFormState = {
      ...emptyConnectionForm(),
      url: " https://mcp.example.com/mcp ",
      authScheme: "bearer",
      headerName: "X-Key"
    };
    expect(newConnectionConfig({ name: "crm", title: "CRM" }, form)).toEqual({
      name: "crm",
      displayName: "CRM",
      connectorType: "mcp",
      operations: [],
      enabled: true,
      settings: { url: "https://mcp.example.com/mcp" },
      authScheme: "bearer"
    });
    expect(withConnectionForm({ name: "crm" }, { ...form, authScheme: "header" })).toMatchObject({
      settings: { url: "https://mcp.example.com/mcp", headerName: "X-Key" }
    });
  });

  it("starts a copy from the copied Connection's address and operations, and nothing of its key", () => {
    const copied = {
      name: "release-crm",
      description: "The CRM.",
      settings: { url: "https://mcp.example.com/mcp", headerName: "X-Key" },
      authScheme: "header",
      secretHandle: "secret_x",
      origin: "release",
      operations: [{ name: "lookup", effect: "reading", exposure: ["agent"], enabled: true }]
    };
    const form = connectionConfigToForm(copied);
    expect(form).toEqual({
      connectorType: "mcp",
      url: "https://mcp.example.com/mcp",
      authScheme: "header",
      headerName: "X-Key",
      headers: [],
      testPath: ""
    });
    const config = newConnectionConfig({ name: "crm", title: "CRM", copyOf: copied }, form);
    expect(config).toMatchObject({ description: "The CRM.", operations: copied.operations });
    expect(config).not.toHaveProperty("secretHandle");
    expect(config).not.toHaveProperty("origin");
  });

  it("makes a REST API with its base address, fixed headers and test path, and reads it back", () => {
    const form: ConnectionFormState = {
      ...emptyConnectionForm("http_api"),
      url: " https://gateway.example.test/datevconnect ",
      authScheme: "header",
      headerName: "X-Api-Key",
      headers: [
        { name: " x-client-instance-id ", value: " 7c1e " },
        { name: "", value: "an empty row is no header" }
      ],
      testPath: " /health "
    };
    const config = newConnectionConfig({ name: "exampledata", title: "Exampledata" }, form);
    expect(config).toEqual({
      name: "exampledata",
      displayName: "Exampledata",
      connectorType: "http_api",
      operations: [],
      enabled: true,
      settings: {
        baseUrl: "https://gateway.example.test/datevconnect",
        headers: { "x-client-instance-id": "7c1e" },
        testPath: "/health",
        headerName: "X-Api-Key"
      },
      authScheme: "header"
    });
    expect(connectionConfigToForm(config)).toEqual({
      connectorType: "http_api",
      url: "https://gateway.example.test/datevconnect",
      authScheme: "header",
      headerName: "X-Api-Key",
      headers: [{ name: "x-client-instance-id", value: "7c1e" }],
      testPath: "/health"
    });
    // Without a key nothing is sent, and the settings name no header and no test path.
    expect(
      newConnectionConfig(
        { name: "open", title: "Open" },
        { ...emptyConnectionForm("http_api"), url: "https://open.example.test", authScheme: "none" }
      )
    ).toMatchObject({ settings: { baseUrl: "https://open.example.test" }, authScheme: "none" });
  });

  it("approves tools at once, pinned to what was read, takes one off, and accepts a new description", () => {
    const base = {
      name: "crm",
      operations: [{ name: "list", effect: "reading", exposure: [], enabled: true, policy: "deny" }]
    };
    const accepted = withApprovedOperations(
      base,
      [
        { name: "lookup", effect: "changing", schemaFingerprint: FINGERPRINT },
        {
          name: "clients",
          effect: "reading",
          declaration: { method: "GET", path: "/clients", description: "Lists the clients." }
        }
      ],
      ["agent", "workflow"]
    );
    expect(accepted.operations).toEqual([
      { name: "list", effect: "reading", exposure: [], enabled: true, policy: "deny" },
      {
        name: "lookup",
        effect: "changing",
        exposure: ["agent", "workflow"],
        enabled: true,
        schemaFingerprint: FINGERPRINT
      },
      {
        method: "GET",
        path: "/clients",
        description: "Lists the clients.",
        name: "clients",
        effect: "reading",
        exposure: ["agent", "workflow"],
        enabled: true
      }
    ]);
    // Approved again, an operation stands once, as approved now.
    expect(
      withApprovedOperations(accepted, [{ name: "lookup", effect: "reading" }], []).operations
    ).toHaveLength(3);
    expect(withReviewedOperation(accepted, "list", FINGERPRINT).operations).toMatchObject([
      { name: "list", schemaFingerprint: FINGERPRINT, policy: "deny" },
      { name: "lookup" },
      { name: "clients" }
    ]);
    expect(withoutOperation(withoutOperation(accepted, "lookup"), "clients").operations).toEqual(
      base.operations
    );
  });

  it("opens one operation to outside clients and closes it again, and leaves its other exposures", () => {
    const base = {
      name: "crm",
      operations: [
        { name: "list", effect: "reading", exposure: ["agent", "workflow"], enabled: true },
        { name: "lookup", effect: "reading", exposure: ["agent"], enabled: true }
      ]
    };
    const opened = withOperationExposure(base, "list", "outside", true);
    expect(opened.operations).toEqual([
      {
        name: "list",
        effect: "reading",
        exposure: ["agent", "workflow", "outside"],
        enabled: true
      },
      base.operations[1]
    ]);
    // Ticked twice it is listed once.
    expect(withOperationExposure(opened, "list", "outside", true)).toEqual(opened);
    expect(withOperationExposure(opened, "list", "outside", false).operations).toEqual(
      base.operations
    );
    // An approved tool is never open to outside clients by itself.
    const accepted = withApprovedOperations(
      base,
      [{ name: "fresh", effect: "reading", schemaFingerprint: FINGERPRINT }],
      ["agent", "bridge", "workflow"]
    );
    expect(accepted.operations).toContainEqual(
      expect.objectContaining({ name: "fresh", exposure: ["agent", "bridge", "workflow"] })
    );
  });

  it("waits for a discovery until a new catalog is in, and not longer than its bound", () => {
    const wait = { since: 1_000, discoveredAt: "2026-10-14T08:00:00.000Z" };
    expect(waitsForDiscovery(wait, { discoveredAt: wait.discoveredAt }, 2_000)).toBe(true);
    // A catalog that was dropped is no new one.
    expect(waitsForDiscovery(wait, {}, 2_000)).toBe(true);
    expect(waitsForDiscovery(wait, { discoveredAt: "2026-10-14T08:01:00.000Z" }, 2_000)).toBe(
      false
    );
    expect(waitsForDiscovery(wait, {}, 1_000 + DISCOVERY_WAIT_MS)).toBe(false);
  });
});
