import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  agent,
  clientInstanceId,
  errorSchema,
  setupAccessInstance,
  type AccessInstance
} from "./support/access-instance";

// `assets.get` of an agent with a revision named, as `catalyst agent show --revision` sends it.
// An agent's writes go live: its live revision is the one it publishes, so `published` names it,
// a number names one of its history, and `draft` names its pending draft to whoever may read it.

const AGENT = "helper";
const readSchema = z.looseObject({
  revision: z.number(),
  contentRevision: z.number().optional(),
  config: z.looseObject({ instructions: z.string() })
});

const instances: AccessInstance[] = [];
afterEach(async () => {
  await Promise.all(instances.splice(0).map((t) => t.instance.close()));
});

async function setup() {
  const t = await setupAccessInstance();
  instances.push(t);
  await t.expectOk(t.admin.id, "assets.put", {
    params: { kind: "agent", name: AGENT },
    payload: {
      config: { ...agent(AGENT), instructions: "First live." },
      expectedRevision: null
    }
  });
  const live = async () => {
    const asset = await t.stores.configAssets.getConfigAsset({
      clientInstanceId,
      kind: "agent",
      name: AGENT
    });
    if (!asset?.config) throw new Error(`No agent '${AGENT}'`);
    return { ...asset, config: asset.config };
  };
  const show = (userId: string, revision?: string) =>
    t.call(userId, "assets.get", {
      params: { kind: "agent", name: AGENT },
      query: revision === undefined ? {} : { revision }
    });
  const read = async (userId: string, revision?: string) => {
    const response = await show(userId, revision);
    expect(response.statusCode, response.body).toBe(200);
    return readSchema.parse(response.json());
  };
  return { t, live, show, read };
}

describe("showing one revision of an agent", () => {
  it("answers its live revision for published, its history by number and its draft for draft", async () => {
    const { t, live, show, read } = await setup();
    // A second live revision, published from a draft, and a new draft beside it.
    const first = await live();
    const put = async (instructions: string, expectedDraftRevision: number | null) => {
      const now = await live();
      const response = await t.call(t.admin.id, "assets.put", {
        params: { kind: "agent", name: AGENT },
        payload: {
          config: { ...now.config, instructions },
          expectedRevision: now.revision,
          expectedDraftRevision
        }
      });
      expect(response.statusCode, response.body).toBe(200);
      return z.object({ draftRevision: z.number() }).parse(response.json()).draftRevision;
    };
    const drafted = await put("Second live.", null);
    await t.expectOk(t.admin.id, "assets.publish", {
      params: { kind: "agent", name: AGENT },
      payload: { revision: drafted }
    });
    const second = await live();
    expect(second.revision).toBeGreaterThan(first.revision);
    await put("Drafted.", null);

    const named = await read(t.admin.id);
    expect(named.config.instructions).toBe("Second live.");
    expect(named.contentRevision).toBeUndefined();

    const published = await read(t.admin.id, "published");
    expect(published).toMatchObject({ contentRevision: second.revision });
    expect(published.config.instructions).toBe("Second live.");

    const earlier = await read(t.admin.id, String(first.revision));
    expect(earlier).toMatchObject({ revision: second.revision, contentRevision: first.revision });
    expect(earlier.config.instructions).toBe("First live.");
    expect((await read(t.admin.id, String(second.revision))).config.instructions).toBe(
      "Second live."
    );

    const draft = await read(t.admin.id, "draft");
    expect(draft.config.instructions).toBe("Drafted.");
    expect(draft.contentRevision).toBeUndefined();

    const unknown = await show(t.admin.id, "9");
    expect(unknown.statusCode).toBe(404);
    expect(errorSchema.parse(unknown.json()).error.details).toMatchObject({
      reason: "revision_unknown"
    });
  });

  it("answers the live revision for draft to a reader who may not read the draft", async () => {
    const { t, live, read } = await setup();
    const now = await live();
    await t.stores.agentProposals.save({
      clientInstanceId,
      agentId: now.id,
      baseRevision: now.revision,
      expectedDraftRevision: null,
      config: { ...now.config, instructions: "Drafted." },
      author: { release: false },
      savedAt: new Date().toISOString()
    });
    await t.grant(t.kai.id, "agent.read", { assetId: now.id });

    const shown = await read(t.kai.id, "draft");
    expect(shown.config.instructions).toBe("First live.");
    expect(JSON.stringify(shown)).not.toContain("Drafted.");
  });

  it("answers the live revision to an agent with no draft", async () => {
    const { t, read } = await setup();
    expect((await read(t.admin.id, "draft")).config.instructions).toBe("First live.");
    expect((await read(t.admin.id, "published")).config.instructions).toBe("First live.");
  });
});
