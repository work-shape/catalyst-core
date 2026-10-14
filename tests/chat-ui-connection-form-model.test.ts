import { describe, expect, it } from "vitest";
import {
  DISCOVERY_WAIT_MS,
  connectionConfigToForm,
  newConnectionConfig,
  waitsForDiscovery,
  withAcceptedOperation,
  withConnectionForm,
  withOperationExposure,
  withReviewedOperation,
  withoutOperation,
  type ConnectionFormState
} from "@vivd-catalyst/chat-ui/build-area";

// What the form of a Connection made on the instance writes. The page holds the state; these
// make the definitions it saves. None of them carries a key.

const FINGERPRINT = "f".repeat(64);

describe("the form of a Connection", () => {
  it("makes a new MCP Connection that accepts nothing, with the header only where it is read", () => {
    const form: ConnectionFormState = {
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
      url: "https://mcp.example.com/mcp",
      authScheme: "header",
      headerName: "X-Key"
    });
    const config = newConnectionConfig({ name: "crm", title: "CRM", copyOf: copied }, form);
    expect(config).toMatchObject({ description: "The CRM.", operations: copied.operations });
    expect(config).not.toHaveProperty("secretHandle");
    expect(config).not.toHaveProperty("origin");
  });

  it("accepts a tool pinned to what was read, takes it off, and accepts a new description", () => {
    const base = {
      name: "crm",
      operations: [{ name: "list", effect: "reading", exposure: [], enabled: true, policy: "deny" }]
    };
    const accepted = withAcceptedOperation(base, {
      name: "lookup",
      effect: "changing",
      fingerprint: FINGERPRINT,
      forAgents: true
    });
    expect(accepted.operations).toEqual([
      { name: "list", effect: "reading", exposure: [], enabled: true, policy: "deny" },
      {
        name: "lookup",
        effect: "changing",
        exposure: ["agent"],
        enabled: true,
        schemaFingerprint: FINGERPRINT
      }
    ]);
    expect(withReviewedOperation(accepted, "list", FINGERPRINT).operations).toMatchObject([
      { name: "list", schemaFingerprint: FINGERPRINT, policy: "deny" },
      { name: "lookup" }
    ]);
    expect(withoutOperation(accepted, "lookup").operations).toEqual(base.operations);
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
    // An accepted tool is never open to outside clients by itself.
    const accepted = withAcceptedOperation(base, {
      name: "fresh",
      effect: "reading",
      fingerprint: FINGERPRINT,
      forAgents: true
    });
    expect(accepted.operations).toContainEqual(
      expect.objectContaining({ name: "fresh", exposure: ["agent"] })
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
