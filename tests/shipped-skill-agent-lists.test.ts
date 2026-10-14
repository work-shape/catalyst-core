import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { agentConfigSchema } from "@vivd-catalyst/config-schema";
import {
  createConfigAssetSource,
  type ClientInstanceCapability
} from "@vivd-catalyst/client-assembly";
import {
  asAgentRunId,
  asClientInstanceId,
  asConversationId,
  asToolCallId
} from "@vivd-catalyst/core";
import { createReadSkillTool } from "@vivd-catalyst/tool-execution";
import { defineTool, toolSuccess } from "@vivd-catalyst/tool-sdk";
import { SERVICE_HEADER, setupAccessInstance } from "./support/access-instance";
import { createTestConfig } from "./support/fixtures";
import { createTestInstance, type TestInstance } from "./support/test-instance";
import { accessOf } from "./support/access";
import { applyAtCurrentRevisions } from "./support/asset-revisions";
import {
  clientInstanceId,
  fixture,
  json,
  operations,
  requester,
  reviewer,
  skill
} from "./support/skill-change-fixture";

// The four general skills ship as skills of origin `release` that an agent lists in its own
// `skillNames`, which no shipped skill was before: a proposal to change one is refused when
// the agent makes it, and the two config pushes around the release that ships them hold.

describe("a shipped skill an agent lists", () => {
  it("a change proposed to the instance copy before the switch is superseded, not applied, after it", async () => {
    const f = await fixture();
    const request = await f.propose();
    // Push A deletes the copy, and the new release stores its own under the name.
    await applyAtCurrentRevisions(f.store.configAssets, {
      clientInstanceId,
      mutations: [
        {
          type: "upsert",
          kind: "skill",
          name: skill.name,
          config: json({ ...skill, content: "Shipped text.", origin: "release", icon: "pdf" })
        }
      ]
    });
    const decided = await f.approve(request.id);
    expect(decided.status).not.toBe("approved");
    expect((await f.revisions()).at(-1)?.config).toMatchObject({ origin: "release" });
  });

  it("refuses a proposed change to it when the agent proposes, not after a person approves", async () => {
    const f = await fixture();
    // The release seed turns the agent's listed skill into one of the platform's, as it does
    // with `pdf` once the deployment lists the shipped one (push B).
    await applyAtCurrentRevisions(f.store.configAssets, {
      clientInstanceId,
      mutations: [
        {
          type: "upsert",
          kind: "skill",
          name: skill.name,
          config: json({ ...skill, origin: "release", icon: "pdf" })
        }
      ]
    });
    const result = await f.tool.execute(
      { skillName: skill.name, summary: "Update.", operations },
      f.toolContext
    );
    // Today the call files a pending request, and the approval that follows throws "Config
    // asset bundle is invalid": a person approves what can never apply.
    expect(result).toMatchObject({ status: "failed", error: { code: "not_allowed" } });
    expect((await f.workflow.pendingCount(reviewer, accessOf(reviewer))).count).toBe(0);
  });
});

// ---- The two-step push plan of the deployment PRs, on one database across four starts ----

const FOUR = ["spreadsheets", "documents", "presentations", "pdf"];
const WORKSPACE_TOOLS = ["workspace.exec", "workspace.promote_artifact"];
const ADMIN = "admin";
const AGENT = "assistant";
const simulationInstanceId = "demo-local";

/** Stand-ins for the two workspace tools, which an instance without a sandbox cannot build. */
const fakeWorkspaceTool = (name: string) =>
  defineTool({
    name,
    effect: "reading",
    description: `Stand-in for ${name}.`,
    permission: { mode: "allow" },
    inputSchema: z.object({}).strict(),
    execute: async () => toolSuccess({ ok: true })
  });

const agentListing = (skillNames: string[], workspace = true) =>
  agentConfigSchema.parse({
    name: AGENT,
    displayName: "Assistant",
    instructions: "Help users",
    toolNames: ["read_skill", ...(workspace ? WORKSPACE_TOOLS : [])],
    skillNames
  });

/**
 * The four general skills as the artifact helpers of the capabilities repo ship them: the
 * names, icons and tools, and a line of text each.
 */
const generalSkills: ClientInstanceCapability = {
  name: "artifact-skills",
  skills: [
    ["spreadsheets", "spreadsheet"],
    ["documents", "document"],
    ["presentations", "presentation"],
    ["pdf", "pdf"]
  ].map(([name = "", icon = ""]) => ({
    name,
    title: name,
    description: `Use for ${name}.`,
    summary: `Knows how to work with ${name}.`,
    content: `# ${name}\nThe release's text.`,
    icon,
    tools: WORKSPACE_TOOLS
  })),
  create: () => ({})
};

const instanceCopy = (name: string) => ({
  name,
  title: `${name} (instance copy)`,
  description: `Vendored ${name}.`,
  content: `# ${name}\nThe vendored copy.`
});

const itemsSchema = z.object({
  items: z.array(
    z.object({
      name: z.string(),
      revision: z.number(),
      attributes: z.record(z.string(), z.union([z.string(), z.boolean()])).optional()
    })
  )
});
const assetSchema = z.object({ revision: z.number(), config: z.looseObject({}) });

describe("the two config pushes around the release that ships the four", () => {
  const open: TestInstance[] = [];
  afterEach(async () => {
    for (const instance of open.splice(0).reverse()) await instance.close();
  });

  /** One start of a release on the test's database. `next` is the release with the four. */
  async function start(next: boolean, workspace = true) {
    const config = createTestConfig({
      tools: [
        { name: "read_skill" },
        ...WORKSPACE_TOOLS.map((name) => ({ name, enabled: workspace }))
      ],
      developmentAuth: {
        enabled: true,
        defaultUserId: ADMIN,
        users: [
          {
            id: ADMIN,
            externalUserId: ADMIN,
            displayLabel: "Admin",
            roles: ["user", "admin", "superadmin"]
          }
        ]
      }
    });
    config.modules = { assetManagement: { enabled: true }, workflows: { enabled: false } };
    config.administration.agentConfiguration.allowSkillEditing = true;
    config.administration.agentConfiguration.allowAgentCreation = true;
    config.administration.agentConfiguration.editableAgentFields = [
      "displayName",
      "instructions",
      "toolNames",
      "skillNames",
      "initialPrompts"
    ];
    const capabilities: ClientInstanceCapability[] = next ? [generalSkills] : [];
    const app = await createTestInstance({
      config,
      env: {},
      tools: WORKSPACE_TOOLS.map(fakeWorkspaceTool),
      capabilities
    });
    open.push(app);
    return app;
  }

  const skills = async (app: TestInstance) =>
    itemsSchema.parse((await app.call("assets.list", { params: { kind: "skill" } })).json()).items;
  const get = async (app: TestInstance, kind: string, name: string) =>
    assetSchema.parse((await app.call("assets.get", { params: { kind, name } })).json());
  const put = (
    app: TestInstance,
    kind: string,
    name: string,
    config: unknown,
    expectedRevision: number | null
  ) => app.call("assets.put", { params: { kind, name }, payload: { config, expectedRevision } });
  const del = (app: TestInstance, kind: string, name: string, expectedRevision: number) =>
    app.call("assets.delete", { params: { kind, name }, payload: { expectedRevision } });

  async function readSkill(app: TestInstance, name: string) {
    const source = createConfigAssetSource({
      store: app.stores.configAssets,
      clientInstanceId: asClientInstanceId(simulationInstanceId)
    });
    const tool = createReadSkillTool({ assetSource: source });
    return tool.execute(
      { name },
      {
        correlationId: "read-skill",
        user: { ...requester, clientInstanceId: asClientInstanceId(simulationInstanceId) },
        clientInstanceId: asClientInstanceId(simulationInstanceId),
        toolRequest: {
          agentName: AGENT,
          agentRunId: asAgentRunId("run"),
          conversationId: asConversationId("conversation-that-used-pdf"),
          toolCallId: asToolCallId("call"),
          toolName: "read_skill",
          input: { name }
        }
      }
    );
  }

  it("walks old release with copies → refused new start → push A --prune → new release → push B", async () => {
    // Stage 0: the release running today, with the vendored copies and the agent listing them.
    const old = await start(false);
    for (const name of FOUR) {
      const r = await put(old, "skill", name, instanceCopy(name), null);
      expect(r.statusCode, r.body).toBe(200);
    }
    const created = await put(old, "agent", AGENT, agentListing(FOUR), null);
    expect(created.statusCode, created.body).toBe(200);
    expect(await readSkill(old, "pdf")).toMatchObject({ status: "success" });

    // The new release, started before push A, stops and deletes nothing.
    await expect(start(true)).rejects.toThrow("instance holds a skill of its own named");
    for (const name of FOUR) {
      expect((await get(old, "skill", name)).config).not.toHaveProperty("origin");
    }

    // A push cannot delete a skill an agent still lists (the reason for the agent change).
    const early = await del(old, "skill", "pdf", 1);
    expect(early.statusCode, early.body).toBeGreaterThanOrEqual(400);

    // Push A, at commit 1 with --prune: the agent without the four, then the four deleted.
    const agentA = await put(old, "agent", AGENT, agentListing([]), 1);
    expect(agentA.statusCode, agentA.body).toBe(200);
    for (const name of FOUR) {
      const r = await del(old, "skill", name, 1);
      expect(r.statusCode, r.body).toBe(200);
    }
    // Between push A and the deploy, the agents run without the four.
    expect(await readSkill(old, "pdf")).toMatchObject({ status: "failed" });

    // The deploy: the new release starts and stores the four with their icons.
    const next = await start(true);
    const shipped = (await skills(next)).filter((s) => s.attributes?.origin === "release");
    expect(Object.fromEntries(shipped.map((s) => [s.name, s.attributes?.icon]))).toMatchObject({
      spreadsheets: "spreadsheet",
      documents: "document",
      presentations: "presentation",
      pdf: "pdf"
    });
    // The deleted rows of the instance copies continue as the release's.
    expect((await get(next, "skill", "pdf")).config).toMatchObject({
      origin: "release",
      icon: "pdf"
    });

    // Push B, at the branch head: the agent lists the four again.
    const agentB = await put(
      next,
      "agent",
      AGENT,
      agentListing(FOUR),
      (await get(next, "agent", AGENT)).revision
    );
    expect(agentB.statusCode, agentB.body).toBe(200);
    // A conversation that used the instance's `pdf` reads the release's now.
    const read = await readSkill(next, "pdf");
    expect(read).toMatchObject({ status: "success", output: { name: "pdf" } });
    expect(JSON.stringify(read)).not.toContain("vendored copy");

    // A restart of the same release writes nothing more and keeps the agent's list.
    const again = await start(true);
    expect((await get(again, "agent", AGENT)).config).toMatchObject({ skillNames: FOUR });
  });

  it("on an instance without the workspace tools: the four are not shipped, and an agent that lists one cannot be saved", async () => {
    const next = await start(true, false);
    expect((await skills(next)).map((s) => s.name)).not.toContain("pdf");
    const saved = await put(next, "agent", AGENT, agentListing(["pdf"], false), null);
    expect(saved.statusCode, saved.body).toBe(422);
    // Nor can the instance write its own `pdf` there.
    const own = await put(next, "skill", "pdf", instanceCopy("pdf"), null);
    expect(own.statusCode, own.body).toBe(422);
  });

  it("turning the workspace tools off later unlists the four from the agent and starts", async () => {
    const on = await start(true);
    // The agent lists the four without the workspace tools themselves (an agent that lists a
    // disabled tool stops any start, skills aside).
    const saved = await put(on, "agent", AGENT, agentListing(FOUR, false), null);
    expect(saved.statusCode, saved.body).toBe(200);
    const off = await start(true, false);
    expect((await skills(off)).map((s) => s.name)).not.toContain("pdf");
    expect((await get(off, "agent", AGENT)).config).toMatchObject({ skillNames: [] });
  });
});

// ---- The old icon rule on the config push path (a release's assets.sync) and on assets.put ----

describe("no write but the seed names an origin or an icon", () => {
  it("refuses a pushed skill with an icon, with origin release, or with both", async () => {
    const t = await setupAccessInstance();
    try {
      const base = { name: "my-pdf", title: "PDF", description: "Ours.", content: "Ours." };
      for (const extra of [
        { icon: "pdf" },
        { origin: "release" },
        { origin: "release", icon: "pdf" }
      ]) {
        const pushed = await t.instance.call("assets.sync", {
          payload: {
            items: [
              { type: "put", kind: "skill", config: { ...base, ...extra }, expectedRevision: null }
            ]
          },
          headers: { [SERVICE_HEADER]: "svc_release" }
        });
        expect(pushed.statusCode, pushed.body).toBe(422);
        const put = await t.call(t.root.id, "assets.put", {
          params: { kind: "skill", name: base.name },
          payload: { config: { ...base, ...extra }, expectedRevision: null }
        });
        expect(put.statusCode, put.body).toBe(422);
      }
      expect(
        await t.stores.configAssets.getConfigAsset({
          clientInstanceId: asClientInstanceId("demo-local"),
          kind: "skill",
          name: "my-pdf"
        })
      ).toBeUndefined();
    } finally {
      await t.instance.close();
    }
  });
});
