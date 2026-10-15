import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { listAll } from "@work-shape/catalyst-api-client";
import { defineTool, toolSuccess } from "@work-shape/catalyst-tool-sdk";
import {
  assertLocalDevelopmentHost,
  builder,
  heldSkillChange,
  people,
  seedDemo,
  workflowCheckQuestions,
  workspaceAssets
} from "@work-shape/catalyst-demo/seed";
import {
  createdBy,
  expectCheckAnswers,
  expectSecondRunChangedNothing,
  useSeededInstance
} from "./support/demo-seed";

// `pnpm demo:seed` against the instance of the browser suite: its fixture config, the real
// sign-in, the real config CLI, Postgres. Every test here fails without the seed.

const fixtureConfig = resolve("tests/fixtures/e2e-app.yaml");

/** The fixture config enables this tool; the suite's own server brings it. */
const recordNote = defineTool({
  name: "e2e.record_note",
  effect: "changing",
  permission: { mode: "allow" },
  description: "Records a note. A fixture: it stores nothing.",
  inputSchema: z.object({ text: z.string().min(1) }),
  outputSchema: z.object({ recorded: z.string() }),
  execute: (input) => toolSuccess({ recorded: input.text })
});

/** What the preview of a held save says about the asset, as far as the tests read it. */
const shownAssetSchema = z.looseObject({ kind: z.string(), isNew: z.boolean() });

const seeded = useSeededInstance({
  configPath: fixtureConfig,
  baseUrl: "http://127.0.0.1:4210",
  origin: "http://127.0.0.1:5273",
  instanceAssets: resolve("tests/fixtures/e2e-assets"),
  superadmin: { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" },
  tools: [recordNote],
  // The fixture config names this key of the Secret Store, as the suite's runner sets it.
  env: { E2E_SECRET_STORE_KEY: randomBytes(32).toString("base64") },
  // The Apps of the seed are built for real here, so a source that does not build fails.
  appBuild: "sandbox"
});

describe("the demo seed on the fixture instance", () => {
  it("creates the company on an empty instance and says how much of each", () => {
    expect(createdBy(seeded().first)).toEqual({
      people: 8,
      "service principals": 1,
      "API keys": 1,
      "the instance's own agents and skills": 2,
      namespaces: 4,
      agents: 8,
      skills: 7,
      "grant rows": 25,
      "builder assets": 2,
      "approval requests": 2,
      "connection grant rows": 0,
      workspaces: 1,
      "workspace members": 4,
      "workspace assets": 2,
      apps: 2,
      workflows: 1
    });
  });

  it("leaves the company's workspace with one published App and one with a draft ahead", () => {
    const { workspace, apps } = seeded().before;
    expect(workspace?.members).toEqual([
      "elif.aydin@nordlicht-beratung.test: member",
      "jonas.brandt@nordlicht-beratung.test: member",
      "mara.lindqvist@nordlicht-beratung.test: owner",
      "sven.olsen@nordlicht-beratung.test: member",
      "tobias.keller@nordlicht-beratung.test: member"
    ]);
    const states = apps.map(({ id: _id, ...state }) => state);
    expect(states).toEqual([
      {
        name: "client-onboarding",
        revision: 1,
        draftRevision: 1,
        publishedRevision: 1,
        title: "Client onboarding"
      },
      {
        name: "fee-estimate",
        revision: 2,
        draftRevision: 2,
        publishedRevision: 1,
        title: "Fee estimate"
      }
    ]);
  });

  it("leaves people across the roles, one deactivated and one who never signed in", () => {
    const { users } = seeded().before;
    const byLabel = (label: string) => users.find((user) => user.displayLabel === label);
    expect(users).toHaveLength(people.length);
    expect(users.filter((user) => user.roles.includes("admin"))).toHaveLength(2);
    expect(users.filter((user) => user.roles.includes("superadmin"))).toHaveLength(0);
    expect(byLabel("Lena Hoffmann")?.status).toBe("disabled");
    // Rights beside the role's own, as the Users page shows them.
    expect(byLabel("Jonas Brandt")?.permissions).toEqual([
      "api_access.manage",
      "agent_models.manage"
    ]);
    expect(byLabel("Sven Olsen")?.permissions).toEqual(["config_assets.read", "usage.view"]);
    expect(byLabel("Mara Lindqvist")).toMatchObject({ identities: 1, signedIn: true });
    // This instance has no invitation module: the invited person has no way to sign in, and
    // the seed says so.
    expect(byLabel("Noah Fischer")).toMatchObject({ identities: 0, signedIn: false });
    expect(seeded().first.steps.find((step) => step.name === "people")?.note).toContain(
      "userInvitations"
    );
  });

  it("registers four Namespaces, one with a tool list and a model list", () => {
    expect(
      seeded().before.namespaces.map(
        ({ prefix, allowedToolNames, allowedModelBindingIds, assetCount }) => ({
          prefix,
          allowedToolNames,
          allowedModelBindingIds,
          assetCount
        })
      )
    ).toEqual([
      { prefix: "hr-", allowedToolNames: null, allowedModelBindingIds: null, assetCount: 4 },
      { prefix: "kai-", allowedToolNames: null, allowedModelBindingIds: null, assetCount: 2 },
      { prefix: "sales-", allowedToolNames: null, allowedModelBindingIds: null, assetCount: 4 },
      {
        prefix: "tax-",
        allowedToolNames: ["read_skill", "show_view", "demo.workflow_summary"],
        // Of the two models the seed names, this instance has one.
        allowedModelBindingIds: ["primary"],
        assetCount: 4
      }
    ]);
  });

  it("pushes the agents and skills, shows every agent, and gives one agent a second revision", async () => {
    const { client, defaultAgentName } = seeded().before;
    // The instance's own two agents are there as well, and one of them stays the default, and
    // so are the skills the platform ships.
    const own = [
      "application_assistant",
      "research_assistant",
      "platform-docs",
      "workflow-authoring"
    ];
    // The company's workspace owns two of its own, which the test below reads.
    const workspaceOwn = [workspaceAssets.agent.name, workspaceAssets.skill.name];
    const assets = seeded().before.assets.filter(
      (asset) => !own.includes(asset.name) && !workspaceOwn.includes(asset.name)
    );
    expect(defaultAgentName).toBe("application_assistant");
    // The company's eight and the one Kai Berger made.
    expect(assets.filter((asset) => asset.kind === "agent")).toHaveLength(9);
    expect(assets.filter((asset) => asset.kind === "skill")).toHaveLength(7);
    expect(assets.filter((asset) => asset.kind === "agent" && asset.shown !== "all")).toEqual([]);
    expect(assets.filter((asset) => asset.revision !== 1).map((asset) => asset.name)).toEqual([
      "tax-vat-checker"
    ]);
    const revisions = await listAll((paging) =>
      client.assets.revisions.list({
        params: { kind: "agent", name: "tax-vat-checker" },
        query: paging
      })
    );
    // Newest first: the config CLI's push over the draft a person saved.
    expect(
      revisions.map((revision) => [revision.revision, revision.actor?.principalKind ?? "user"])
    ).toEqual([
      [2, "service"],
      [1, "user"]
    ]);
    expect(revisions[1]?.actor?.displayLabel).toBe("Jonas Brandt");
  });

  it("leaves a skill and an agent the company's workspace owns, the agent offered there alone", async () => {
    const { client, assets, workspace } = seeded().before;
    const workspaceId = workspace?.id ?? "";
    expect(workspaceId).not.toBe("");
    for (const [kind, name] of [
      ["skill", workspaceAssets.skill.name],
      ["agent", workspaceAssets.agent.name]
    ] satisfies [string, string][]) {
      const stored = await client.assets.get({ params: { kind, name }, query: { workspaceId } });
      expect(stored.scope, name).toEqual({ kind: "workspace", workspaceId });
    }
    const agent = assets.find((asset) => asset.name === workspaceAssets.agent.name);
    expect(agent).toMatchObject({ kind: "agent", revision: 1 });
    expect(agent?.shown).not.toBe("all");
  });

  it("writes allow and deny rows in Namespaces and on single assets", () => {
    const { grants } = seeded().before;
    const count = (effect: string, scopeKind: string) =>
      grants.filter((row) => row.effect === effect && row.scopeKind === scopeKind).length;
    expect(grants).toHaveLength(25);
    expect(count("allow", "namespace")).toBe(21);
    expect(count("allow", "asset")).toBe(2);
    expect(count("deny", "namespace")).toBe(1);
    expect(count("deny", "asset")).toBe(1);
  });

  it("leaves an agent and a Workflow draft that Kai Berger made in his own Namespace", async () => {
    const { client, users, grants } = seeded().before;
    const kai = users.find((user) => user.displayLabel === "Kai Berger");
    expect(kai).toMatchObject({ roles: ["user"], permissions: [], status: "active" });
    // Nothing but his rows in `kai-`: no right on an App, which no grant gives yet.
    expect(
      grants
        .filter((row) => row.holderId === kai?.id)
        .map((row) => `${row.action} ${row.scopeKind} ${row.namespace ?? ""}`)
        .sort()
    ).toEqual(
      [
        "agent.delete",
        "agent.read",
        "agent.write",
        "skill.delete",
        "skill.read",
        "skill.write",
        "workflow.publish",
        "workflow.read",
        "workflow.write"
      ].map((action) => `${action} namespace kai-`)
    );
    for (const [kind, name] of [
      ["agent", builder.agent.name],
      ["workflow", builder.workflow]
    ] as const) {
      const revisions = await listAll((paging) =>
        client.assets.revisions.list({ params: { kind, name }, query: paging })
      );
      expect(revisions.map((revision) => revision.actor?.displayLabel)).toEqual(["Kai Berger"]);
    }
    // His Workflow stays a draft: publishing it would lend the principal it names.
    const draft = await client.assets.get({
      params: { kind: "workflow", name: builder.workflow }
    });
    expect(draft.revision).toBe(1);
    expect(draft.publishedRevision).toBeUndefined();
  });

  it("creates the config CLI's service principal with one key and leaves two calls waiting in the Inbox", async () => {
    const { principals, approvals, assets } = seeded().before;
    expect(principals).toEqual([
      {
        id: expect.any(String),
        displayLabel: "Local config CLI",
        credentials: [expect.any(String)]
      },
      // The seed's Workflow runs as this one. Nobody signs in as it, so it holds no key.
      { id: expect.any(String), displayLabel: "Workflow demo", credentials: [] }
    ]);
    const held = {
      id: expect.any(String),
      kind: "operation_call",
      requestedBy: "Elif Aydin",
      status: "pending"
    };
    expect(approvals).toEqual([held, held]);
    // Nothing was written yet: the skill exists once somebody approves.
    expect(assets.some((asset) => asset.name === "hr-parental-leave-faq")).toBe(false);

    // The Inbox reads one as a new skill and the other as one changed paragraph. Fails without
    // the second request, and without the asset block of the preview.
    const { client } = seeded().before;
    const shown = await Promise.all(
      approvals.map(async ({ id }) => {
        const { preview } = await client.approval_requests.get({ params: { requestId: id } });
        return z.object({ asset: shownAssetSchema }).parse(preview).asset;
      })
    );
    expect(shown.find((asset) => asset.isNew)).toMatchObject({
      kind: "skill",
      title: "Elternzeit: häufige Fragen",
      namespace: "hr-",
      content: { newSkill: { name: "hr-parental-leave-faq" } }
    });
    expect(shown.find((asset) => !asset.isNew)).toMatchObject({
      kind: "skill",
      title: "Urlaubsrichtlinie",
      namespace: "hr-",
      content: {
        changes: [
          {
            type: "replace",
            target: "root",
            before: heldSkillChange.before,
            after: heldSkillChange.after
          }
        ]
      }
    });
  });

  it("grants no right on a Connection the instance does not have, and says so", () => {
    // The fixture config has the module on and not the Connection of the demo's release config.
    expect(seeded().first.steps.find((step) => step.name === "connection grant rows")?.note).toBe(
      "This instance has no Connection 'sample-business': the demo's release config brings it, so no right on it was granted."
    );
    expect(seeded().before.grants.some((row) => row.action.startsWith("connection."))).toBe(false);
    // The App whose tile reads through that Connection could not be stored here, so it is
    // left out and named. Fails without S3-42: the seed knew no such App.
    expect(seeded().first.steps.find((step) => step.name === "apps")?.note).toBe(
      "This instance lacks a Connection an App calls, so the seed left out 'customer-list' (Connection 'sample-business')."
    );
  });

  it("changes nothing when it runs a second time", () => {
    expectSecondRunChangedNothing(seeded(), ["workflows"]);
  });

  it("gives the Check tab the answers the demo README promises", async () => {
    await expectCheckAnswers(seeded().before);
    await expectCheckAnswers(seeded().before, workflowCheckQuestions);
  });

  it("refuses a host that is not a local development host before it sends anything", async () => {
    let requests = 0;
    await expect(
      seedDemo({
        baseUrl: "https://catalyst.example.com",
        appConfigPath: fixtureConfig,
        assetsDir: seeded().assetsDir,
        instanceAssetsDir: seeded().instanceAssetsDir,
        env: {},
        envFile: seeded().envFile,
        fetchImpl: () => {
          requests += 1;
          return Promise.resolve(new Response());
        }
      })
    ).rejects.toThrow("Refusing to seed 'catalyst.example.com'");
    expect(requests).toBe(0);
    for (const allowed of [
      "http://localhost:4100",
      "http://127.0.0.1:4100",
      "http://[::1]:4100",
      "http://demo.localhost:4100",
      "https://catalyst.test"
    ]) {
      expect(() => assertLocalDevelopmentHost(allowed)).not.toThrow();
    }
    for (const refused of [
      "http://10.0.0.5:4100",
      "https://test.example.com",
      "http://localtest.me",
      "http://localhost.example.com",
      "http://127.0.0.1.nip.io",
      "http://localhost@example.com"
    ]) {
      expect(() => assertLocalDevelopmentHost(refused)).toThrow("Refusing to seed");
    }
  });

  /** The seed against an address and a network of the test's choice. */
  const seedAt = (
    baseUrl: string,
    network: { resolveHost?: (hostname: string) => Promise<string[]>; answer?: () => Response }
  ) => {
    const requested: string[] = [];
    const run = seedDemo({
      baseUrl,
      appConfigPath: fixtureConfig,
      assetsDir: seeded().assetsDir,
      instanceAssetsDir: seeded().instanceAssetsDir,
      env: {},
      envFile: seeded().envFile,
      ...(network.resolveHost ? { resolveHost: network.resolveHost } : {}),
      fetchImpl: (resource, init) => {
        requested.push(new Request(resource, init).url);
        return Promise.resolve(network.answer?.() ?? new Response(null, { status: 500 }));
      }
    });
    return { run, requested };
  };

  it("refuses an address with a user, a password or a query and repeats none of it", async () => {
    for (const address of [
      "http://someone:hunter2hunter2@127.0.0.1:4210",
      "http://127.0.0.1:4210/?token=hunter2hunter2",
      "http://127.0.0.1:4210/#hunter2hunter2"
    ]) {
      const { run, requested } = seedAt(address, {});
      const error: unknown = await run.catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      const message = error instanceof Error ? error.message : "";
      expect(message).toContain("must not carry a user, a password, a query or a fragment");
      expect(message).not.toContain("hunter2");
      expect(requested).toEqual([]);
    }
  });

  it("refuses a local name that resolves to another machine before it sends anything", async () => {
    const elsewhere = seedAt("http://catalyst.test:4210", {
      resolveHost: () => Promise.resolve(["127.0.0.1", "203.0.113.7"])
    });
    await expect(elsewhere.run).rejects.toThrow(
      "Refusing to seed 'catalyst.test': the name resolves to an address that is not this machine."
    );
    expect(elsewhere.requested).toEqual([]);

    const unknown = seedAt("http://demo.localhost:4210", {
      resolveHost: () => Promise.reject(new Error("ENOTFOUND"))
    });
    await expect(unknown.run).rejects.toThrow("the name does not resolve to an address");
    expect(unknown.requested).toEqual([]);

    // A name that is this machine gets its first request, the sign-in.
    const here = seedAt("http://catalyst.test:4210", {
      resolveHost: () => Promise.resolve(["127.0.0.1", "::1"])
    });
    await expect(here.run).rejects.toThrow("was refused with status 500");
    expect(here.requested).toEqual(["http://catalyst.test:4210/api/auth/sign-in/email"]);
  });

  it("follows no redirect, so a sign-in is never sent on to another host", async () => {
    const { run, requested } = seedAt("http://127.0.0.1:4210", {
      answer: () =>
        new Response(null, {
          status: 307,
          headers: { location: "https://catalyst.example.com/api/auth/sign-in/email" }
        })
    });
    await expect(run).rejects.toThrow(
      "http://127.0.0.1:4210 answered with a redirect (status 307). The seed follows none"
    );
    expect(requested).toEqual(["http://127.0.0.1:4210/api/auth/sign-in/email"]);
  });
});
