import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { seedShippedAgents } from "@work-shape/catalyst-server";
import {
  AGENT_EDITABLE_FIELDS,
  asClientInstanceId,
  type ShippedAgent
} from "@work-shape/catalyst-core";
import { createTestConfig } from "./support/fixtures";
import { createTestInstance, type TestInstance } from "./support/test-instance";

// Workshaper ships with the platform (SA-1): the seed of the API process stores it where its
// module is on, offered in no workspace, and brings it up to each release while keeping what
// the instance changed. Each test fails without the change: before it no start stored an agent.

const ADMIN = "admin";
const NAME = "workshaper";
const clientInstanceId = asClientInstanceId("demo-local");

const agentSchema = z.object({
  revision: z.number(),
  config: z.looseObject({
    name: z.string(),
    instructions: z.string(),
    toolNames: z.array(z.string()),
    skillNames: z.array(z.string()),
    welcomeMessage: z.unknown().optional(),
    additionalInstructions: z.string().optional(),
    shipped: z.record(z.string(), z.unknown()).optional(),
    shippedNewer: z.array(z.string()).optional()
  })
});
const listSchema = z.object({
  items: z.array(
    z.object({
      name: z.string(),
      attributes: z.record(z.string(), z.union([z.string(), z.boolean()])).optional()
    })
  )
});
const configSchema = z.object({
  agents: z.array(z.object({ name: z.string() })),
  defaultAgentName: z.string().optional()
});
const draftSchema = z.object({ draft: z.object({ revision: z.number() }).nullable() });

describe("the agent that ships with the platform", () => {
  const open: TestInstance[] = [];
  afterEach(async () => {
    for (const instance of open.splice(0).reverse()) await instance.close();
  });

  async function start(workshaper: boolean) {
    const config = createTestConfig({
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
    config.modules = {
      assetManagement: { enabled: true },
      workshaper: { enabled: workshaper }
    };
    config.administration.agentConfiguration.editableAgentFields = [...AGENT_EDITABLE_FIELDS];
    const app = await createTestInstance({ config, env: {}, tools: [], capabilities: [] });
    open.push(app);
    return app;
  }

  const read = async (app: TestInstance) => {
    const response = await app.call("assets.get", { params: { kind: "agent", name: NAME } });
    expect(response.statusCode, response.body).toBe(200);
    return agentSchema.parse(response.json());
  };
  const chatConfig = async (app: TestInstance) =>
    configSchema.parse((await app.call("config.get", {})).json());

  /** Saves a change as the agent page does, and publishes it. */
  async function change(app: TestInstance, config: Record<string, unknown>) {
    const current = await read(app);
    const saved = await app.call("assets.put", {
      params: { kind: "agent", name: NAME },
      payload: { config, expectedRevision: current.revision }
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const { draft } = draftSchema.parse(
      (await app.call("agents.draft.get", { params: { name: NAME } })).json()
    );
    const published = await app.call("assets.publish", {
      params: { kind: "agent", name: NAME },
      payload: { revision: draft?.revision }
    });
    expect(published.statusCode, published.body).toBe(200);
  }

  it("stores Workshaper with the instance's tools, offered in no workspace", async () => {
    const app = await start(true);
    const { config } = await read(app);
    expect(config.toolNames).toContain("platform.context");
    // No subagent start and no tool of one asset ships with it.
    expect(config.toolNames).not.toContain("run_agent");
    expect(config.toolNames.filter((name) => name.startsWith("connection."))).toEqual([]);
    expect(config.shipped).toMatchObject({ toolNames: config.toolNames });
    // Asked what a local agent with a personal key reaches, it reads the docs, not its own tools:
    // it once told a person such a key read their Data Stores.
    expect(config.instructions).toContain(
      "answer from the docs page getting-started/local-agent, never from your own tools"
    );
    expect(config.instructions).toContain("A key reads no Data Store rows");
    // A person could not tell at the end of a build what was done and what was theirs to do.
    expect(config.instructions).toContain("up to four short parts");
    expect(config.instructions).toContain("never describe a click path in words");
    expect(config.instructions).toContain("each pending Data Store in dataStores");
    const listed = listSchema.parse(
      (await app.call("assets.list", { params: { kind: "agent" } })).json()
    ).items;
    // A working copy pulls it like any agent of the instance: it is the instance's to change.
    expect(listed.find((agent) => agent.name === NAME)?.attributes?.origin).toBeUndefined();
    // Only an admin's "Available in" offers it; until then no chat lists it.
    expect((await chatConfig(app)).agents.map((agent) => agent.name)).not.toContain(NAME);
  });

  it("is the default where it is offered and the instance names none, and never replaces one it names", async () => {
    const app = await start(true);
    // The test instance names its own agent the default.
    expect((await chatConfig(app)).defaultAgentName).toBe("test_agent");
    const offered = await app.call("assets.set_availability", {
      params: { kind: "agent", name: NAME },
      payload: { mode: "selected", personalWorkspaces: true, collaborationWorkspaceIds: [] }
    });
    expect(offered.statusCode, offered.body).toBe(200);
    const config = await chatConfig(app);
    expect(config.agents.map((agent) => agent.name)).toContain(NAME);
    expect(config.defaultAgentName).toBe("test_agent");
    const state = await app.stores.configAssets.getConfigAssetState({ clientInstanceId });
    await app.stores.configAssets.applyConfigAssetMutations({
      clientInstanceId,
      baseRevisions: {},
      baseDefaultAgentName: state.defaultAgentName ?? null,
      mutations: [{ type: "setDefaultAgent", agentName: undefined }]
    });
    expect((await chatConfig(app)).defaultAgentName).toBe(NAME);
  });

  it("keeps what the instance changed through a release, and takes the rest from it", async () => {
    const app = await start(true);
    const before = await read(app);
    const [dropped, ...kept] = before.config.toolNames;
    await change(app, {
      ...before.config,
      instructions: "Our own instructions.",
      toolNames: kept,
      // What the release shipped is the seed's alone: a save that sends another is not heard.
      shipped: { instructions: "Forged." }
    });
    const changed = await read(app);
    expect(changed.config.shipped).toEqual(before.config.shipped);

    const next: ShippedAgent = {
      name: NAME,
      displayName: { en: "Workshaper", de: "Workshaper" },
      welcomeMessage: { en: "Hello from the next release" },
      instructions: "The next release's instructions.",
      toolNames: [...before.config.toolNames, "next_release_tool"],
      skillNames: [],
      initialPrompts: []
    };
    const seeded = await seedShippedAgents({
      clientInstanceId,
      stores: app.stores,
      agents: [next]
    });
    expect(seeded).toEqual({ retained: [], created: [], updated: [NAME] });
    const after = await read(app);
    expect(after.config.instructions).toBe("Our own instructions.");
    expect(after.config.welcomeMessage).toEqual({ en: "Hello from the next release" });
    expect(after.config.toolNames).not.toContain(dropped);
    expect(after.config.toolNames).toContain("next_release_tool");
    expect(after.config.shipped).toMatchObject({ instructions: next.instructions });
    // Nothing more to do on the next start.
    expect(
      await seedShippedAgents({ clientInstanceId, stores: app.stores, agents: [next] })
    ).toEqual({ retained: [], created: [], updated: [] });
  });

  it("names a field the instance changed and the release changed too, until a person decides", async () => {
    const app = await start(true);
    const before = await read(app);
    await change(app, {
      ...before.config,
      instructions: "Our own instructions.",
      additionalInstructions: "Answer in short sentences."
    });
    const next: ShippedAgent = {
      name: NAME,
      displayName: { en: "Workshaper", de: "Workshaper" },
      instructions: "The next release's instructions.",
      toolNames: before.config.toolNames,
      skillNames: [],
      initialPrompts: []
    };
    await seedShippedAgents({ clientInstanceId, stores: app.stores, agents: [next] });
    const after = await read(app);
    expect(after.config.instructions).toBe("Our own instructions.");
    // A release never ships or touches what the instance added.
    expect(after.config.additionalInstructions).toBe("Answer in short sentences.");
    expect(after.config.shippedNewer).toEqual(["instructions"]);

    // A save that leaves the list out, such as a config push, keeps it. A save cannot name a
    // field the seed did not, and keeping one's own takes it out.
    const { shippedNewer: _listed, ...withoutList } = after.config;
    await change(app, { ...withoutList, description: "Ours." });
    expect((await read(app)).config.shippedNewer).toEqual(["instructions"]);
    await change(app, { ...after.config, shippedNewer: ["instructions", "displayName"] });
    expect((await read(app)).config.shippedNewer).toEqual(["instructions"]);
    await change(app, { ...after.config, shippedNewer: [] });
    expect((await read(app)).config.shippedNewer).toEqual([]);
    // The next release forgets the decided list.
    await seedShippedAgents({ clientInstanceId, stores: app.stores, agents: [next] });
    expect((await read(app)).config.shippedNewer).toBeUndefined();
  });

  it("moves a pending draft onto the release, keeping what the draft changed", async () => {
    const app = await start(true);
    const shipped = await read(app);
    const release = (instructions: string): ShippedAgent => ({
      name: NAME,
      displayName: { en: "Workshaper", de: "Workshaper" },
      instructions,
      toolNames: shipped.config.toolNames,
      skillNames: [],
      initialPrompts: []
    });
    // Instructions that name no tool this test instance lacks, so a save of them validates.
    await seedShippedAgents({
      clientInstanceId,
      stores: app.stores,
      agents: [release("This release's instructions.")]
    });
    const before = await read(app);
    const saved = await app.call("assets.put", {
      params: { kind: "agent", name: NAME },
      payload: {
        config: { ...before.config, additionalInstructions: "Our addition." },
        expectedRevision: before.revision,
        expectedDraftRevision: null
      }
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const next = release("The next release's instructions.");
    await seedShippedAgents({ clientInstanceId, stores: app.stores, agents: [next] });
    const live = await read(app);
    const draft = z
      .object({
        draft: z.object({
          revision: z.number(),
          stale: z.boolean(),
          config: z.looseObject({ instructions: z.string(), additionalInstructions: z.string() })
        })
      })
      .parse((await app.call("agents.draft.get", { params: { name: NAME } })).json()).draft;
    // Before, the draft stayed on the old live revision and its publish wrote the old
    // release's instructions back as the instance's own.
    expect(draft.stale).toBe(false);
    expect(draft.config.instructions).toBe(next.instructions);
    expect(draft.config.additionalInstructions).toBe("Our addition.");
    const published = await app.call("assets.publish", {
      params: { kind: "agent", name: NAME },
      payload: { revision: draft.revision }
    });
    expect(published.statusCode, published.body).toBe(200);
    const after = await read(app);
    expect(after.revision).toBeGreaterThan(live.revision);
    expect(after.config.instructions).toBe(next.instructions);
    expect(after.config.additionalInstructions).toBe("Our addition.");
  });

  it("refuses deleting it", async () => {
    const app = await start(true);
    const { revision } = await read(app);
    const refused = await app.call("assets.delete", {
      params: { kind: "agent", name: NAME },
      payload: { expectedRevision: revision }
    });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.body).toContain("ships with the platform and cannot be deleted");
    expect((await read(app)).revision).toBe(revision);
  });

  it("ships nothing with the module off and keeps the name the platform's", async () => {
    const app = await start(false);
    expect(
      (await app.call("assets.get", { params: { kind: "agent", name: NAME } })).statusCode
    ).toBe(404);
    const taken = await app.call("assets.put", {
      params: { kind: "agent", name: NAME },
      payload: {
        config: { name: NAME, displayName: "Ours", instructions: "Ours." },
        expectedRevision: null
      }
    });
    expect(taken.statusCode, taken.body).toBe(403);
    expect(taken.body).toContain(`The platform ships an agent named '${NAME}'`);
  });
});
