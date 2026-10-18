import { RELEASED_KIT_VERSIONS } from "@work-shape/catalyst-app-build";
import { ASSET_GET_FILES_MAX_BYTES } from "@work-shape/catalyst-api-contract";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { SKILL_MAX_BYTES, seedShippedSkills } from "@work-shape/catalyst-server";
import {
  shippedSkillsOf,
  platformModules,
  createConfigAssetSource,
  platformDocsSkill,
  type ClientInstanceCapability
} from "@work-shape/catalyst-client-assembly";
import {
  asClientInstanceId,
  createModuleRegistry,
  type ShippedSkill
} from "@work-shape/catalyst-core";
import { createTestConfig } from "./support/fixtures";
import { createTestInstance, type TestInstance } from "./support/test-instance";

// The skills that ship with the platform are stored skills of origin `release`, written by the
// seed of the API process and by nothing else. Each test fails without the change: before it
// no start stored a skill, and the platform's docs were no asset a list could show.

const ADMIN = "admin";
const GUIDE = "platform-docs";
/** The guide earlier releases shipped, which the orientation in the system prompt replaced. */
const RETIRED_GUIDE = "platform-guide";
const AUTHORING = "workflow-authoring";
const clientInstanceId = asClientInstanceId("demo-local");

/** A general skill a capability ships, as the artifact helpers ship theirs. */
const generalSkill = (name: string, icon: string, tools: readonly string[]): ShippedSkill => ({
  name,
  title: name.toUpperCase(),
  description: `Use for ${name}.`,
  summary: `Knows how to make a ${name} file.`,
  content: `# ${name}`,
  icon,
  tools
});

/**
 * A capability that ships two skills: one whose tool every instance has, and one whose tool
 * only an instance with Execution Workspaces has, which this suite's instance has not.
 */
const artifactSkills: ClientInstanceCapability = {
  name: "artifact-skills",
  skills: [
    generalSkill("pdf", "pdf", ["read_skill"]),
    generalSkill("spreadsheets", "spreadsheet", ["read_skill", "workspace.exec"])
  ],
  create: () => ({})
};

const listSchema = z.object({
  items: z.array(
    z.object({
      name: z.string(),
      revision: z.number(),
      attributes: z.record(z.string(), z.union([z.string(), z.boolean()])).optional()
    })
  )
});
const assetSchema = z.object({
  revision: z.number(),
  config: z.looseObject({ name: z.string(), title: z.string(), content: z.string() })
});
const refusalSchema = z.object({
  error: z.object({ message: z.string(), details: z.unknown().optional() })
});

describe("the skills that ship with the platform", () => {
  const open: TestInstance[] = [];
  afterEach(async () => {
    for (const instance of open.splice(0).reverse()) await instance.close();
  });

  async function start(workflows: boolean, capabilities: ClientInstanceCapability[] = []) {
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
    config.modules = { assetManagement: { enabled: true }, workflows: { enabled: workflows } };
    config.administration.agentConfiguration.allowSkillEditing = true;
    const app = await createTestInstance({ config, env: {}, tools: [], capabilities });
    open.push(app);
    return app;
  }

  const listed = async (app: TestInstance) =>
    listSchema.parse((await app.call("assets.list", { params: { kind: "skill" } })).json()).items;
  const shippedNames = async (app: TestInstance) =>
    (await listed(app))
      .filter((skill) => skill.attributes?.origin === "release")
      .map((skill) => skill.name)
      .sort();
  const read = async (app: TestInstance, name: string) => {
    const response = await app.call("assets.get", { params: { kind: "skill", name } });
    expect(response.statusCode, response.body).toBe(200);
    return assetSchema.parse(response.json());
  };

  it("lists them as the platform's, with their icon, and stores what each module that is on ships", async () => {
    const app = await start(true);
    const skills = await listed(app);
    expect(skills.find((skill) => skill.name === GUIDE)?.attributes).toMatchObject({
      origin: "release",
      icon: "guide"
    });
    expect(skills.find((skill) => skill.name === AUTHORING)?.attributes).toMatchObject({
      origin: "release",
      icon: "workflow"
    });
    expect((await read(app, GUIDE)).config.content).toContain("# Workshape Catalyst documentation");
  });

  it("refuses every change and delete of one, and a new skill under its name", async () => {
    const app = await start(false);
    const guide = await read(app, GUIDE);
    const refusals = [
      await app.call("assets.put", {
        params: { kind: "skill", name: GUIDE },
        payload: {
          config: { ...guide.config, content: "Changed." },
          expectedRevision: guide.revision
        }
      }),
      await app.call("assets.put", {
        params: { kind: "skill", name: GUIDE },
        payload: {
          config: { name: GUIDE, title: "Mine", description: "Mine.", content: "Mine." },
          expectedRevision: null
        }
      }),
      await app.call("assets.delete", {
        params: { kind: "skill", name: GUIDE },
        payload: { expectedRevision: guide.revision }
      }),
      await app.call("assets.revert", {
        params: { kind: "skill", name: GUIDE },
        payload: { revision: guide.revision, expectedRevision: guide.revision }
      })
    ];
    for (const refused of refusals) {
      expect(refused.statusCode, refused.body).toBe(403);
      const { error } = refusalSchema.parse(refused.json());
      expect(error.message).toContain(`The skill '${GUIDE}' ships with the platform`);
    }
    expect((await read(app, GUIDE)).revision).toBe(guide.revision);

    // Nobody but the seed names the origin or the icon of a shipped skill.
    const posing = await app.call("assets.put", {
      params: { kind: "skill", name: "my-guide" },
      payload: {
        config: { ...guide.config, name: "my-guide", origin: "release" },
        expectedRevision: null
      }
    });
    expect(posing.statusCode, posing.body).toBe(422);
    expect(posing.body).toContain("Only a skill that ships with the platform names an origin");
  });

  it("keeps the name of a skill a module ships for the platform while that module is off", async () => {
    // Before, Workflows off let an instance take `workflow-authoring`, and the start that
    // turned Workflows on stopped on it.
    const app = await start(false);
    expect(await shippedNames(app)).toEqual([GUIDE]);
    const taken = await app.call("assets.put", {
      params: { kind: "skill", name: AUTHORING },
      payload: {
        config: { name: AUTHORING, title: "Ours", description: "Ours.", content: "Ours." },
        expectedRevision: null
      }
    });
    expect(taken.statusCode, taken.body).toBe(422);
    expect(taken.body).toContain(`The platform ships a skill named '${AUTHORING}'`);
  });

  it("copies one into an ordinary skill of the instance that can be changed", async () => {
    const app = await start(false);
    const { config } = await read(app, GUIDE);
    // What "Copy to edit" sends: the definition without what only the platform writes.
    const { origin: _origin, icon: _icon, ...copied } = config;
    const created = await app.call("assets.put", {
      params: { kind: "skill", name: "our-guide" },
      payload: {
        config: { ...copied, name: "our-guide", title: "Our guide" },
        expectedRevision: null
      }
    });
    expect(created.statusCode, created.body).toBe(200);
    const copy = await read(app, "our-guide");
    expect(copy.config.content).toBe(config.content);
    expect((await listed(app)).find((skill) => skill.name === "our-guide")?.attributes).toEqual({
      origin: "instance"
    });

    const changed = await app.call("assets.put", {
      params: { kind: "skill", name: "our-guide" },
      payload: {
        config: { ...copy.config, content: "Our own words." },
        expectedRevision: copy.revision
      }
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect((await read(app, GUIDE)).config.content).toBe(config.content);
  });

  it("is replaced by a release: a changed skill gets a revision, a dropped one is deleted, the same writes nothing", async () => {
    const first = await start(true);
    expect(await shippedNames(first)).toEqual([GUIDE, AUTHORING].sort());
    const guide = await read(first, GUIDE);

    // A start of the same release writes nothing.
    const again = await start(true);
    expect((await read(again, GUIDE)).revision).toBe(guide.revision);

    // A release that no longer ships a skill: here, a module that is off ships none.
    const without = await start(false);
    expect(await shippedNames(without)).toEqual([GUIDE]);

    // A release whose skill says something else.
    const result = await seedShippedSkills({
      clientInstanceId,
      stores: without.stores,
      skills: [
        {
          name: GUIDE,
          title: "Platform documentation",
          description: "The next release's guide.",
          content: "# The next release's guide",
          icon: "guide"
        }
      ]
    });
    expect(result).toEqual({
      retained: [],
      created: [],
      updated: [GUIDE],
      removed: [],
      unlisted: []
    });
    const replaced = await read(without, GUIDE);
    expect(replaced.revision).toBeGreaterThan(guide.revision);
    expect(replaced.config.content).toBe("# The next release's guide");
  });

  it("retires the guide an earlier release shipped and keeps the references of the docs", async () => {
    const earlier = await start(true);
    // What an earlier release stored: its guide beside the skill for Workflows.
    await seedShippedSkills({
      clientInstanceId,
      stores: earlier.stores,
      skills: [
        {
          name: RETIRED_GUIDE,
          title: "How this platform works",
          description: "The earlier release's guide.",
          content: "# How this platform works",
          icon: "guide"
        },
        {
          name: AUTHORING,
          title: "Workflow authoring",
          description: "Writing Workflows.",
          content: "# Workflows",
          icon: "workflow"
        }
      ]
    });
    expect(await shippedNames(earlier)).toEqual([RETIRED_GUIDE, AUTHORING].sort());

    // This release's start deletes the guide and stores the docs with their references.
    const now = await start(true);
    expect(await shippedNames(now)).toEqual([GUIDE, AUTHORING].sort());
    const gone = await now.call("assets.get", { params: { kind: "skill", name: RETIRED_GUIDE } });
    expect(gone.statusCode, gone.body).toBe(404);
    const docs = z
      .object({ config: z.object({ resources: z.array(z.object({ path: z.string() })) }) })
      .parse((await now.call("assets.get", { params: { kind: "skill", name: GUIDE } })).json());
    expect(docs.config.resources.map(({ path }) => path)).toContain("references/configure/cli.md");
  });

  it("leaves its references out of the snapshot every turn reads, and reads them with the skill", async () => {
    const app = await start(false);
    const source = createConfigAssetSource({ store: app.stores.configAssets, clientInstanceId });
    // Read for every turn and tool call: the docs' 400 KB of references stay in the database.
    const snapshot = await source.getSnapshot();
    const docs = snapshot.skills.find((skill) => skill.name === GUIDE);
    expect(docs?.content).toBe(platformDocsSkill.content);
    expect(docs).not.toHaveProperty("resources");
    expect(JSON.stringify(snapshot).length).toBeLessThan(50_000);
    // What read_skill reads: the one skill, whole.
    const whole = await source.getSkill(GUIDE);
    expect(whole?.resources).toEqual(platformDocsSkill.resources);
    expect(await source.getSkill("no-such-skill")).toBeUndefined();
  });

  it("is stored once by starts that run at the same time", async () => {
    const app = await start(true);
    const next = {
      name: GUIDE,
      title: "Platform documentation",
      description: "The next release's guide.",
      content: "# The next release's guide",
      icon: "guide"
    };
    const seeds = await Promise.allSettled(
      Array.from({ length: 3 }, () =>
        seedShippedSkills({ clientInstanceId, stores: app.stores, skills: [next] })
      )
    );
    expect(seeds.map((seed) => seed.status)).toEqual(["fulfilled", "fulfilled", "fulfilled"]);
    const revisions = await app.stores.configAssets.listConfigAssetRevisions({
      clientInstanceId,
      kind: "skill",
      name: GUIDE
    });
    expect(revisions).toHaveLength(2);
  });

  it("retains an instance skill without changing its revision when a release takes its name", async () => {
    const app = await start(false);
    const created = await app.call("assets.put", {
      params: { kind: "skill", name: "spreadsheets" },
      payload: {
        config: { name: "spreadsheets", title: "Ours", description: "Ours.", content: "Ours." },
        expectedRevision: null
      }
    });
    expect(created.statusCode, created.body).toBe(200);
    const before = await read(app, "spreadsheets");
    const result = await seedShippedSkills({
      clientInstanceId,
      stores: app.stores,
      skills: [
        {
          name: "spreadsheets",
          title: "Spreadsheets",
          description: "Shipped.",
          content: "Shipped.",
          icon: "spreadsheet"
        }
      ]
    });
    expect(result.retained).toEqual(["spreadsheets"]);
    expect(await read(app, "spreadsheets")).toEqual(before);
  });
  it.each(["active", "deleted before upgrade", "deleted after upgrade"])(
    "starts and retains a workspace-owned skill that is %s without writing it",
    async (state) => {
      const earlier = await start(false);
      const workspace = await earlier.call("workspaces.create", { payload: { name: "Team" } });
      expect(workspace.statusCode, workspace.body).toBe(200);
      const { id: workspaceId } = z.object({ id: z.string() }).parse(workspace.json());
      const created = await earlier.call("assets.put", {
        params: { kind: "skill", name: "pdf" },
        payload: {
          config: { name: "pdf", title: "PDF", description: "Ours.", content: "Ours." },
          expectedRevision: null,
          workspaceId
        }
      });
      expect(created.statusCode, created.body).toBe(200);
      const { revision } = z.object({ revision: z.number() }).parse(created.json());
      const key = { clientInstanceId, kind: "skill", name: "pdf" };
      const original = await earlier.stores.configAssets.getConfigAsset(key);
      expect(original).toMatchObject({ scope: { kind: "workspace", workspaceId } });

      if (state === "deleted after upgrade") {
        await start(false, [artifactSkills]);
        expect(await earlier.stores.configAssets.getConfigAsset(key)).toEqual(original);
      }
      if (state !== "active") {
        const deleted = await earlier.call("assets.delete", {
          params: { kind: "skill", name: "pdf" },
          payload: { expectedRevision: revision, workspaceId }
        });
        expect(deleted.statusCode, deleted.body).toBe(200);
      }
      const before = await earlier.stores.configAssets.getConfigAsset(key);
      const revisions = await earlier.stores.configAssets.listConfigAssetRevisions(key);
      expect(before).toMatchObject({
        status: state === "active" ? "active" : "deleted",
        scope: { kind: "workspace", workspaceId }
      });

      for (let restart = 0; restart < 2; restart++) {
        const upgraded = await start(false, [artifactSkills]);
        // A real assembly start finishes, and its admin API remains usable.
        expect(await shippedNames(upgraded)).toEqual([GUIDE]);
        const response = await upgraded.call("assets.get", {
          params: { kind: "skill", name: "pdf" },
          query: { workspaceId }
        });
        expect(response.statusCode, response.body).toBe(state === "active" ? 200 : 404);
        expect(await upgraded.stores.configAssets.getConfigAsset(key)).toEqual(before);
        expect(await upgraded.stores.configAssets.listConfigAssetRevisions(key)).toEqual(revisions);
        const result = await seedShippedSkills({
          clientInstanceId,
          stores: upgraded.stores,
          skills: [platformDocsSkill, generalSkill("pdf", "pdf", ["read_skill"])]
        });
        expect(result).toEqual({
          retained: ["pdf"],
          created: [],
          updated: [],
          removed: [],
          unlisted: []
        });
      }
    }
  );

  it("stores the skills a capability ships, with their icon and summary, where the instance has their tools", async () => {
    const app = await start(false, [artifactSkills]);
    // `spreadsheets` names `workspace.exec`, which an instance without Execution Workspaces
    // has not: it is not shipped there.
    expect(await shippedNames(app)).toEqual([GUIDE, "pdf"].sort());
    expect((await listed(app)).find((skill) => skill.name === "pdf")?.attributes).toEqual({
      origin: "release",
      icon: "pdf",
      summary: "Knows how to make a pdf file."
    });
    const pdf = await read(app, "pdf");
    expect(pdf.config).not.toHaveProperty("tools");

    // Its name is the platform's, also that of the skill whose tools are off.
    for (const name of ["pdf", "spreadsheets"]) {
      const taken = await app.call("assets.put", {
        params: { kind: "skill", name },
        payload: {
          config: { name, title: "Ours", description: "Ours.", content: "Ours." },
          expectedRevision: null
        }
      });
      expect(taken.statusCode, taken.body).toBe(name === "pdf" ? 403 : 422);
    }

    // A release without the capability deletes its skills.
    const without = await start(false);
    expect(await shippedNames(without)).toEqual([GUIDE]);
  });

  it("starts an upgraded instance and keeps a colliding skill available through the admin API", async () => {
    const earlier = await start(false);
    const created = await earlier.call("assets.put", {
      params: { kind: "skill", name: "pdf" },
      payload: {
        config: { name: "pdf", title: "PDF", description: "Ours.", content: "Ours." },
        expectedRevision: null
      }
    });
    expect(created.statusCode, created.body).toBe(200);

    const upgraded = await start(false, [artifactSkills]);
    expect((await read(upgraded, "pdf")).config.content).toBe("Ours.");
    // Repeated startup does not overwrite content or create another revision.
    const again = await start(false, [artifactSkills]);
    expect(await read(again, "pdf")).toEqual(await read(earlier, "pdf"));
    // The instance's skill is left as it was: the start deletes nothing.
    const kept = await read(earlier, "pdf");
    expect(kept.config.content).toBe("Ours.");
    expect(kept.config).not.toHaveProperty("origin");
  });
});

// The authoring skill is the first source an agent consults, including on diagnosis.
it("teaches the App sandbox before sending an agent to the detailed guide", () => {
  for (const rule of [
    "allow-scripts allow-forms allow-downloads",
    "without allow-same-origin",
    "form-action 'none'",
    "localStorage",
    "storage.get/set",
    "draft preview shares",
    "250 ms",
    "before its batch is saved",
    "sessionStorage shim (it throws SecurityError)",
    "localStorage instanceof Storage is false",
    "Data Stores",
    "Network"
  ])
    expect(platformDocsSkill.content).toContain(rule);
  const guide = platformDocsSkill.resources?.find(
    (resource) => resource.path === "references/apps/build.md"
  );
  for (const rule of [
    "draft preview",
    "shares the same per-person state",
    "250 ms",
    "A write is lost if the page closes before its batch is saved",
    "immediate reload",
    "sessionStorage",
    "throws `SecurityError`",
    "localStorage instanceof Storage",
    "is false"
  ])
    expect(guide?.content).toContain(rule);
  expect(guide?.content).toContain("SecurityError");
  expect(guide?.content).toContain("event.preventDefault()");
  if (typeof guide?.content !== "string") throw new Error("The App guide must be text");
  // Every new-App manifest and font URL must name the kit the instance builds by default.
  const versions = [
    ...guide.content.matchAll(/^kit:\s*(\S+)/gmu),
    ...guide.content.matchAll(/\/app-runtime\/kit\/([^/]+)\/fonts/gu)
  ];
  expect(versions.length).toBeGreaterThan(0);
  for (const match of versions) expect(match[1]).toBe(RELEASED_KIT_VERSIONS.at(-1));
});

// Platform Access check 72: one authorized assets.get must carry the entire skill.
describe("one read carries a whole skill (ADISC-2 check 72)", () => {
  it("keeps SKILL_MAX_BYTES within ASSET_GET_FILES_MAX_BYTES", () => {
    expect(SKILL_MAX_BYTES).toBeLessThanOrEqual(ASSET_GET_FILES_MAX_BYTES);
  });

  it("keeps every shipped skill, platform-docs included, within one read", () => {
    const modules = createModuleRegistry(platformModules).snapshot({
      workflows: { enabled: true }
    });
    const skills = shippedSkillsOf({ modules, capabilities: [], hasTool: () => true });
    expect(skills.map((skill) => skill.name)).toEqual(
      expect.arrayContaining(["platform-docs", "workflow-authoring"])
    );
    for (const skill of skills) {
      const bytes =
        Buffer.byteLength(skill.content) +
        (skill.resources ?? []).reduce(
          (sum, resource) => sum + Buffer.byteLength(resource.content),
          0
        );
      expect(bytes, skill.name).toBeLessThanOrEqual(ASSET_GET_FILES_MAX_BYTES);
      expect(bytes, skill.name).toBeLessThanOrEqual(SKILL_MAX_BYTES);
    }
  });
});
