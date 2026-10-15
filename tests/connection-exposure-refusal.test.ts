import { describe, expect, it } from "vitest";
import { connectionConfigSchema } from "@work-shape/catalyst-config-schema";
import { CONNECTION_EXPOSURES, connectionExposureRefusal } from "@work-shape/catalyst-core";
import { connection } from "./support/connections";

// Which exposures a Connection's definition may name. `outside` is one more value a shared
// Connection takes. A personal connection takes `agent` only, so its owner's data never
// leaves for an App, a Workflow or a tool outside the instance (CONNECT-1b).

function issuePathsOf(config: unknown): string[] {
  const parsed = connectionConfigSchema.safeParse(config);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.join("."));
}

describe("the exposures of a Connection", () => {
  it("takes `outside` on a shared Connection, and no operation has it by itself", () => {
    const outside = { operations: [{ name: "echo", effect: "reading", exposure: ["outside"] }] };
    expect(issuePathsOf(connection("crm", outside))).toEqual([]);
    const parsed = connectionConfigSchema.parse(
      connection("crm", { operations: [{ name: "echo", effect: "reading" }] })
    );
    expect(parsed.operations).toMatchObject([{ name: "echo", exposure: [] }]);
  });

  it("refuses `outside` on a personal connection with a sentence that says why", () => {
    // Until personal connections are built (CS-9), the mode itself is refused.
    expect(
      issuePathsOf(
        connection("crm", {
          credentialMode: "user",
          operations: [{ name: "echo", effect: "reading", exposure: ["outside"] }]
        })
      )
    ).toContain("credentialMode");

    expect(connectionExposureRefusal("user", "outside")).toBe(
      "A personal connection cannot be exposed to outside clients (CLI, MCP): it accepts only the exposure 'agent'"
    );
    expect(connectionExposureRefusal("user", "workflow")).toBe(
      "A personal connection accepts only the exposure 'agent', not 'workflow'"
    );
    expect(connectionExposureRefusal("user", "agent")).toBeUndefined();
    for (const exposure of CONNECTION_EXPOSURES) {
      expect(connectionExposureRefusal("shared", exposure), exposure).toBeUndefined();
    }
  });
});
