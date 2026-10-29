import { describe, expect, it } from "vitest";
import { capabilitiesSchema } from "@work-shape/catalyst-api-contract";
import { agent, clientInstanceId, setupAccessInstance as setup } from "./support/access-instance";
import { applyAtCurrentRevisions } from "./support/asset-revisions";

// Studio's "Fähigkeiten" page (TOOLS-2; navigation-and-layout.md, section 4.3, check 35): what
// the agents of the instance can be given, one package per module, the general skills first and
// the instance's own tools last, each with the agents that use it among those the reader may
// read. A module that is off reaches an instance admin alone.

const CONNECTION_TOOL = "platform.connections.propose";
const APP_TOOL = "app.save";

async function instance() {
  const t = await setup({
    modules: { connections: { enabled: true }, apps: { enabled: false } },
    furtherToolNames: [CONNECTION_TOOL, APP_TOOL],
    shippedSkills: [
      { name: "pdf", title: "PDF", summary: "Reads and writes PDF files.", icon: "pdf" },
      { name: "app-guide", title: "Building apps", module: "apps" }
    ]
  });
  const team = await t.sharedWorkspace("Team");
  await applyAtCurrentRevisions(t.stores.configAssets, {
    clientInstanceId,
    mutations: [
      {
        type: "upsert",
        kind: "agent",
        name: "linker",
        config: agent("linker", { displayName: "Linker", toolNames: [CONNECTION_TOOL] })
      },
      {
        type: "upsert",
        kind: "agent",
        name: "writer",
        config: agent("writer", { displayName: "Writer", skillNames: ["pdf"] }),
        scope: { kind: "workspace", workspaceId: team }
      }
    ]
  });
  return { t, team };
}

const read = async (t: Awaited<ReturnType<typeof setup>>, userId: string) =>
  capabilitiesSchema.parse((await t.expectOk(userId, "platform.capabilities.get")).json()).packages;

describe("platform.capabilities.get", () => {
  it("shows an instance admin every package, a module that is off marked off, with the agents that use each", async () => {
    const { t } = await instance();
    const packages = await read(t, t.admin.id);

    expect(packages.map((item) => [item.kind, item.module ?? null, item.enabled])).toEqual([
      ["general", null, true],
      ["module", "connections", true],
      ["module", "apps", false],
      ["own", null, true]
    ]);
    const [general, connections, apps, own] = packages;
    expect(general?.skills).toEqual([
      { name: "pdf", title: "PDF", summary: "Reads and writes PDF files.", icon: "pdf" }
    ]);
    expect(general?.agents).toEqual([{ name: "writer", title: "Writer" }]);
    expect(connections?.tools.map((tool) => tool.name)).toEqual([CONNECTION_TOOL]);
    expect(connections?.agents).toEqual([{ name: "linker", title: "Linker" }]);
    // What the module would bring, and nobody uses it while it is off.
    expect(apps?.tools.map((tool) => tool.name)).toEqual([APP_TOOL]);
    expect(apps?.skills.map((skill) => skill.name)).toEqual(["app-guide"]);
    expect(apps?.agents).toEqual([]);
    expect(own?.tools.map((tool) => tool.name)).toEqual(["known.tool", "second.tool"]);
  });

  it("shows a builder without the admin role no module that is off, and only the agents it may read", async () => {
    const { t, team } = await instance();
    await t.grant(t.kai.id, "agent.read", { workspaceId: team });

    const packages = await read(t, t.kai.id);

    expect(packages.map((item) => item.module ?? item.kind)).toEqual([
      "general",
      "connections",
      "own"
    ]);
    expect(JSON.stringify(packages)).not.toContain("app-guide");
    expect(JSON.stringify(packages)).not.toContain(APP_TOOL);
    // The instance's agent stays unnamed to a reader of the workspace alone.
    expect(packages.find((item) => item.module === "connections")?.agents).toEqual([]);
    expect(packages.find((item) => item.kind === "general")?.agents).toEqual([
      { name: "writer", title: "Writer" }
    ]);
  });

  it("refuses a user who holds no right on any kind anywhere", async () => {
    const { t } = await instance();
    await t.expectRefused(
      t.lena.id,
      "platform.capabilities.get",
      {},
      {
        status: 403,
        code: "FORBIDDEN"
      }
    );
  });
});
