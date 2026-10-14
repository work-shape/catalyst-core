import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { seedShippedSkills } from "@vivd-catalyst/chat-server";
import { asClientInstanceId } from "@vivd-catalyst/core";
import { createTestConfig } from "./support/fixtures";
import { createTestInstance, type TestInstance } from "./support/test-instance";

// A release that stops shipping a skill deletes it at start. An agent that lists the skill
// first gets a revision without it, written by the same start, so no reference is left that
// would refuse every later write of the instance. Fails without the change: the start deleted
// `platform-guide` and left it on the agent, and then an unrelated skill write answered 422
// "references missing skill 'platform-guide'". Taken from the verifier's probe of PG-1.

const ADMIN = "admin";
const clientInstanceId = asClientInstanceId("demo-local");

const agentSchema = z.object({
  revision: z.number(),
  config: z.looseObject({
    name: z.string(),
    toolNames: z.array(z.string()),
    skillNames: z.array(z.string()).optional()
  })
});

const earlierGuide = {
  name: "platform-guide",
  title: "How this platform works",
  description: "The earlier release's guide.",
  content: "# How this platform works",
  icon: "guide"
};

describe("retiring a shipped skill", () => {
  const open: TestInstance[] = [];
  afterEach(async () => {
    for (const instance of open.splice(0).reverse()) await instance.close();
  });

  async function start() {
    const config = createTestConfig({
      toolNames: ["read_skill"],
      tools: [{ name: "read_skill" }],
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
    config.modules = { assetManagement: { enabled: true }, workflows: { enabled: true } };
    config.administration.agentConfiguration.allowSkillEditing = true;
    config.administration.agentConfiguration.editableAgentFields = [
      "displayName",
      "description",
      "instructions",
      "toolNames",
      "skillNames",
      "initialPrompts"
    ];
    config.administration.agentConfiguration.allowAgentCreation = true;
    const app = await createTestInstance({ config, env: {}, tools: [] });
    open.push(app);
    return app;
  }

  const readAgent = async (app: TestInstance, name: string) =>
    agentSchema.parse((await app.call("assets.get", { params: { kind: "agent", name } })).json());

  async function putAgent(app: TestInstance, name: string, skillNames: string[]) {
    const base = await readAgent(app, "test_agent");
    const put = await app.call("assets.put", {
      params: { kind: "agent", name },
      payload: { config: { ...base.config, name, skillNames }, expectedRevision: null }
    });
    expect(put.statusCode, put.body).toBe(200);
    return readAgent(app, name);
  }

  it("takes it off every agent that lists it, keeps a copy of the instance's own, and leaves the instance writable", async () => {
    const earlier = await start();
    // What an earlier release stored.
    await seedShippedSkills({ clientInstanceId, stores: earlier.stores, skills: [earlierGuide] });
    // "Copy to edit" made an ordinary skill of the instance from it.
    const copied = await earlier.call("assets.put", {
      params: { kind: "skill", name: "our-guide" },
      payload: {
        config: {
          name: "our-guide",
          title: "Our guide",
          description: earlierGuide.description,
          content: earlierGuide.content
        },
        expectedRevision: null
      }
    });
    expect(copied.statusCode, copied.body).toBe(200);
    // An admin gave the shipped guide to one agent, and both to another.
    const guided = await putAgent(earlier, "guide_user", ["platform-guide"]);
    const both = await putAgent(earlier, "both_user", ["our-guide", "platform-guide"]);
    const own = await putAgent(earlier, "own_user", ["our-guide"]);

    // The upgrade: this release's start retires platform-guide.
    const now = await start();
    const gone = await now.call("assets.get", {
      params: { kind: "skill", name: "platform-guide" }
    });
    expect(gone.statusCode).toBe(404);
    const kept = await now.call("assets.get", { params: { kind: "skill", name: "our-guide" } });
    expect(kept.statusCode, kept.body).toBe(200);

    const guidedNow = await readAgent(now, "guide_user");
    expect(guidedNow.config.skillNames).toEqual([]);
    expect(guidedNow.revision).toBe(guided.revision + 1);
    const bothNow = await readAgent(now, "both_user");
    expect(bothNow.config.skillNames).toEqual(["our-guide"]);
    expect(bothNow.revision).toBe(both.revision + 1);
    // An agent that listed only the copy is not written.
    expect((await readAgent(now, "own_user")).revision).toBe(own.revision);

    // One audit event for each agent and skill, by name; nothing of the agent's content.
    const events = (await now.stores.audit.listAuditEvents({ clientInstanceId, limit: 200 }))
      .filter((event) => event.type === "config_asset.shipped_skill_unlisted")
      .map(({ metadata }) => [metadata?.name, metadata?.skillName, metadata?.revision])
      .sort();
    expect(events).toEqual([
      ["both_user", "platform-guide", both.revision + 1],
      ["guide_user", "platform-guide", guided.revision + 1]
    ]);

    // An unrelated write of the instance is accepted.
    const unrelated = await now.call("assets.put", {
      params: { kind: "skill", name: "our-notes" },
      payload: {
        config: { name: "our-notes", title: "Our notes", description: "Notes.", content: "Notes." },
        expectedRevision: null
      }
    });
    expect(unrelated.statusCode, unrelated.body).toBe(200);

    // A later start of the same release writes nothing more.
    await start();
    expect((await readAgent(now, "guide_user")).revision).toBe(guidedNow.revision);
  });
});
