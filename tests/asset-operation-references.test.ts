import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AssetScope } from "@vivd-catalyst/core";
import { agent, clientInstanceId, errorSchema, skill } from "./support/access-instance";
import { setupNamespaceHolder, type NamespaceHolderInstance } from "./support/asset-operations";

// What a caller learns of assets it may not read from the answer to its own definition: a
// reference to one reads as a reference to nothing, and so does a name another owner holds.

const validationSchema = z.object({
  valid: z.boolean(),
  issues: z.array(z.object({ message: z.string() }).loose())
});
const issuesSchema = z.object({ issues: z.array(z.object({ message: z.string() }).loose()) });

/** An agent of `kai-` that reads these skills. */
const reader = (name: string, skillNames: string[], overrides: Record<string, unknown> = {}) =>
  agent(name, { toolNames: ["read_skill"], skillNames, ...overrides });

async function setup() {
  const t = await setupNamespaceHolder({ furtherToolNames: ["read_skill"] });
  const workspace = await t.stores.workspaces.createWorkspace({
    clientInstanceId,
    kind: "shared",
    name: "Team",
    creatorUserId: t.admin.id
  });
  const scope: AssetScope = { kind: "workspace", workspaceId: workspace.id };
  await t.stores.configAssets.applyConfigAssetMutations({
    clientInstanceId,
    mutations: [
      { type: "upsert", kind: "skill", name: "team-notes", config: skill("team-notes"), scope }
    ]
  });
  // One skill in Kai's Namespace, two in another, one of the instance outside every Namespace.
  for (const name of ["kai-guide", "lena-guide", "lena-rules", "handbook"]) {
    await t.put(t.admin.id, "skill", name);
  }
  return { t, workspaceId: workspace.id };
}

async function validate(t: NamespaceHolderInstance, userId: string, config: unknown) {
  const response = await t.expectOk(userId, "assets.validate", {
    params: { kind: "agent" },
    payload: { config }
  });
  const { valid, issues } = validationSchema.parse(response.json());
  return { valid, issues: issues.map((issue) => issue.message) };
}

const missing = (agentName: string, skillName: string) =>
  `Agent '${agentName}' references missing skill '${skillName}'`;

describe("a reference to an asset the caller may not read", () => {
  it("is answered by assets.validate as a reference to nothing", async () => {
    const { t } = await setup();
    const check = (userId: string, ...skillNames: string[]) =>
      validate(t, userId, reader("kai-intake", skillNames));
    const valid = { valid: true, issues: [] };

    expect(await check(t.kai.id, "kai-guide")).toEqual(valid);
    // A skill that exists nowhere, and three that exist where Kai may not read: another
    // Namespace, the instance outside every Namespace, and a workspace.
    for (const hidden of ["nowhere", "lena-guide", "handbook", "team-notes"]) {
      expect(await check(t.kai.id, hidden), hidden).toEqual({
        valid: false,
        issues: [missing("kai-intake", hidden)]
      });
    }
    // The administrator reads all of them, and is answered as before.
    for (const readable of ["kai-guide", "lena-guide", "handbook", "team-notes"]) {
      expect(await check(t.admin.id, readable), readable).toEqual(valid);
    }
    expect(await check(t.admin.id, "nowhere")).toEqual({
      valid: false,
      issues: [missing("kai-intake", "nowhere")]
    });

    // A grant on the one skill makes it a reference Kai may read.
    await t.grant(t.kai.id, "skill.read", { assetId: await t.assetId("skill", "lena-guide") });
    expect(await check(t.kai.id, "lena-guide")).toEqual(valid);
    expect(await check(t.kai.id, "lena-rules")).toEqual({
      valid: false,
      issues: [missing("kai-intake", "lena-rules")]
    });
    // An agent may refer to what lies beside it in its Namespace, whoever writes it: Lena
    // may write agents in `kai-` and read no skill at all.
    for (const action of ["agent.read", "agent.write"]) {
      await t.grant(t.lena.id, action, { namespace: "kai-" });
    }
    expect(await check(t.lena.id, "kai-guide")).toEqual(valid);
    expect(await check(t.lena.id, "lena-guide")).toEqual({
      valid: false,
      issues: [missing("kai-intake", "lena-guide")]
    });
  });

  it("refuses a put and a batch as a reference to nothing, and keeps a reference already stored", async () => {
    const { t } = await setup();
    const put = async (userId: string, config: ReturnType<typeof agent>) => {
      const response = await t.call(userId, "assets.put", {
        params: { kind: "agent", name: config.name },
        payload: { config }
      });
      if (response.statusCode === 200) return { status: 200 };
      const { error } = errorSchema.parse(response.json());
      return {
        status: response.statusCode,
        message: error.message,
        issues: issuesSchema.parse(error.details).issues.map((issue) => issue.message)
      };
    };
    const refusedFor = (agentName: string, skillName: string) => ({
      status: 422,
      message: "Config asset bundle is invalid",
      issues: [missing(agentName, skillName)]
    });

    expect(await put(t.kai.id, reader("kai-intake", ["nowhere"]))).toEqual(
      refusedFor("kai-intake", "nowhere")
    );
    expect(await put(t.kai.id, reader("kai-intake", ["lena-guide"]))).toEqual(
      refusedFor("kai-intake", "lena-guide")
    );
    expect(await t.stored("agent", "kai-intake")).toBeUndefined();
    expect(await put(t.kai.id, reader("kai-intake", ["kai-guide"]))).toEqual({ status: 200 });

    // The batch answers the same for both.
    const sync = async (skillName: string) => {
      const response = await t.call(t.kai.id, "assets.sync", {
        payload: {
          namespace: "kai-",
          items: [{ type: "put", kind: "agent", config: reader("kai-batch", [skillName]) }]
        }
      });
      const { error } = errorSchema.parse(response.json());
      return {
        status: response.statusCode,
        code: error.code,
        issues: issuesSchema.parse(error.details).issues.map((issue) => issue.message)
      };
    };
    for (const hidden of ["nowhere", "lena-guide"]) {
      expect(await sync(hidden), hidden).toEqual({
        status: 422,
        code: "VALIDATION_FAILED",
        issues: [missing("kai-batch", hidden)]
      });
    }
    expect(await t.stored("agent", "kai-batch")).toBeUndefined();

    // The administrator wires Kai's agent to a skill Kai may not read. Kai still edits the
    // agent: the reference was stored before and tells him nothing he could not read already.
    expect(await put(t.admin.id, reader("kai-wired", ["lena-guide"]))).toEqual({ status: 200 });
    const edited = reader("kai-wired", ["lena-guide"], { instructions: "Help well." });
    expect(await validate(t, t.kai.id, edited)).toEqual({ valid: true, issues: [] });
    expect(await put(t.kai.id, edited)).toEqual({ status: 200 });
    expect(await t.stored("agent", "kai-wired")).toMatchObject({
      revision: 2,
      config: { instructions: "Help well.", skillNames: ["lena-guide"] }
    });
    // A further one he may not read is refused, and only that one is named.
    expect(await put(t.kai.id, reader("kai-wired", ["lena-guide", "lena-rules"]))).toEqual(
      refusedFor("kai-wired", "lena-rules")
    );
  });
});

describe("an asset outside every Namespace", () => {
  it("has no neighbours: a skill beside it is a reference only for a caller who may read it", async () => {
    const { t } = await setup();
    await t.put(t.admin.id, "agent", "plain");
    // Lena reads and writes the one agent, and is denied the one skill.
    for (const action of ["agent.read", "agent.write"]) {
      await t.grant(t.lena.id, action, { assetId: await t.assetId("agent", "plain") });
    }
    await t.grant(
      t.lena.id,
      "skill.read",
      { assetId: await t.assetId("skill", "handbook") },
      "deny"
    );
    const outcome = async (userId: string, skillName: string) => {
      const config = reader("plain", [skillName]);
      const put = await t.call(userId, "assets.put", {
        params: { kind: "agent", name: "plain" },
        payload: { config, expectedRevision: 1 }
      });
      return { validation: await validate(t, userId, config), put: put.statusCode };
    };

    // The skill that exists and the one that does not are answered alike, and neither is attached.
    for (const skillName of ["handbook", "nowhere"]) {
      expect(await outcome(t.lena.id, skillName), skillName).toEqual({
        validation: { valid: false, issues: [missing("plain", skillName)] },
        put: 422
      });
    }
    expect(await t.stored("agent", "plain")).toMatchObject({ revision: 1 });
    expect(await outcome(t.admin.id, "handbook")).toEqual({
      validation: { valid: true, issues: [] },
      put: 200
    });
  });
});

describe("an issue of an asset the caller may not read", () => {
  it("is told without the asset's name, to a draft, a put, a delete and a batch", async () => {
    const { t } = await setup();
    await t.grant(t.kai.id, "skill.delete", { namespace: "kai-" });
    // The instance default and an agent of another Namespace read Kai's skill. Kai reads neither.
    for (const name of ["assistant", "lena-helper"]) {
      const wired = await t.call(t.admin.id, "assets.put", {
        params: { kind: "agent", name },
        payload: { config: reader(name, ["kai-guide"]) }
      });
      expect(wired.statusCode, wired.body).toBe(200);
    }
    const unread = "The change would break an asset the caller may not read";
    const untitled = { ...skill("kai-guide"), title: "" };
    const address = { params: { kind: "skill", name: "kai-guide" } };
    const withoutNames = (body: string) => {
      expect(body).not.toContain("assistant");
      expect(body).not.toContain("lena-helper");
      expect(body).toContain(unread);
    };

    const draft = await t.expectOk(t.kai.id, "assets.validate", {
      params: { kind: "skill" },
      payload: { config: untitled }
    });
    const { valid, issues } = validationSchema.parse(draft.json());
    expect(valid).toBe(false);
    // The draft's own issue is told as it is, and the rest as one sentence.
    expect(issues.length).toBe(2);
    expect(issues.at(-1)?.message).toBe(unread);
    withoutNames(draft.body);

    const calls = [
      await t.call(t.kai.id, "assets.put", { ...address, payload: { config: untitled } }),
      await t.call(t.kai.id, "assets.delete", { ...address, payload: { expectedRevision: 1 } }),
      await t.call(t.kai.id, "assets.sync", {
        payload: {
          namespace: "kai-",
          items: [{ type: "delete", kind: "skill", name: "kai-guide", expectedRevision: 1 }]
        }
      })
    ];
    for (const refused of calls) {
      expect(refused.statusCode, refused.body).toBe(422);
      withoutNames(refused.body);
    }
    expect(await t.stored("skill", "kai-guide")).toMatchObject({ status: "active", revision: 1 });

    // The administrator reads both agents and is told which ones.
    const named = await t.call(t.admin.id, "assets.delete", {
      ...address,
      payload: { expectedRevision: 1 }
    });
    expect(named.statusCode).toBe(422);
    expect(named.body).toContain("Agent 'assistant' references missing skill 'kai-guide'");
    expect(named.body).toContain("Agent 'lena-helper' references missing skill 'kai-guide'");
    expect(named.body).not.toContain(unread);
  });
});

describe("a name another owner holds", () => {
  it("is refused for a workspace as a free name is, whoever holds it", async () => {
    const { t, workspaceId } = await setup();
    // Lena may write the skills of the workspace and reads nothing of the instance.
    await t.stores.access.createGrant({
      clientInstanceId,
      holderKind: "user",
      holderId: t.lena.id,
      action: "skill.write",
      effect: "allow",
      scopeKind: "workspace",
      scopeId: workspaceId,
      grantedBy: t.admin.id
    });
    const refusal = async (
      name: string,
      payload: Record<string, unknown>,
      operation: "assets.put" | "assets.revert"
    ) => {
      const response = await t.call(t.lena.id, operation, {
        params: { kind: "skill", name },
        payload: { ...payload, workspaceId }
      });
      return { status: response.statusCode, ...errorSchema.parse(response.json()).error };
    };
    const cannotOwn = {
      status: 422,
      code: "VALIDATION_FAILED",
      message: "A skill cannot be owned by a workspace",
      details: { reason: "invalid_scope" }
    };

    // `kai-guide` is a skill of the instance, `free-name` is nobody's.
    for (const name of ["kai-guide", "free-name"]) {
      expect(await refusal(name, { config: skill(name) }, "assets.put"), name).toEqual(cannotOwn);
      expect(
        await refusal(name, { revision: 1, expectedRevision: 1 }, "assets.revert"),
        name
      ).toEqual(cannotOwn);
    }
    expect(await t.stored("skill", "kai-guide")).toMatchObject({
      revision: 1,
      scope: { kind: "instance" }
    });
  });
});
