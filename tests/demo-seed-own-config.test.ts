import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { listAll } from "@vivd-catalyst/api-client";
import { assetKindLabelKey } from "@vivd-catalyst/chat-ui/access";
import { connectionCheckQuestions } from "@vivd-catalyst/demo/seed";
import {
  createdBy,
  demoConfigEnv,
  expectCheckAnswers,
  expectSecondRunChangedNothing,
  useSeededInstance
} from "./support/demo-seed";

// The seed against the demo's own config, the one `pnpm dev` runs: its tools, its models, its
// modules. `demo-seed.test.ts` holds the seed itself; this file holds that the demo's config
// accepts everything the seed brings. Every test here fails without the seed.

const seeded = useSeededInstance({
  configPath: resolve("clients/demo/config/app.yaml"),
  baseUrl: "http://127.0.0.1:4100",
  origin: "http://127.0.0.1:5173",
  instanceAssets: resolve("clients/demo"),
  superadmin: { email: "superadmin@example.test", password: "demo-superadmin-password" },
  // The config names the secrets. No model is called and the sample server is not running.
  env: demoConfigEnv()
});

describe("the demo seed on the demo's own config", () => {
  it("has a name for every asset kind the instance registers", async () => {
    const { kinds } = await seeded().after.client.platform.context.get();
    // Every module of the demo is on, so this is every kind the platform brings. A new kind
    // fails here until the interface has a word for it.
    expect(kinds.map((kind) => kind.kind)).toEqual(
      expect.arrayContaining(["agent", "skill", "connection", "app"])
    );
    for (const kind of kinds) {
      // A label key is a key of both languages: `tests/i18n.test.ts` holds them level.
      expect(
        assetKindLabelKey(kind.kind),
        `asset kind '${kind.kind}' has no label key`
      ).toBeDefined();
    }
  });

  it("creates the same company and changes nothing on a second run", () => {
    expect(createdBy(seeded().first)).toEqual({
      people: 7,
      "service principals": 1,
      "API keys": 1,
      "the instance's own agents and skills": 2,
      namespaces: 3,
      agents: 8,
      skills: 7,
      "grant rows": 16,
      "approval requests": 2,
      "connection grant rows": 3,
      workspaces: 1,
      "workspace members": 4,
      apps: 3
    });
    // This config brings the Connection `sample-business`, so the App whose action calls it is
    // stored and published here too. Fails without S3-42: the seed knew no such App.
    expect(seeded().before.apps.find((app) => app.name === "customer-list")).toMatchObject({
      revision: 1,
      publishedRevision: 1,
      title: "Customers"
    });
    expectSecondRunChangedNothing(seeded());
    // The demo's own agent stays the default, not the first agent of the company.
    expect(seeded().before.defaultAgentName).toBe("workflow_assistant");
  });

  it("lists both models the seed names for the tax Namespace", () => {
    expect(
      seeded().before.namespaces.find((namespace) => namespace.prefix === "tax-")
        ?.allowedModelBindingIds
    ).toEqual(["primary", "gpt56Luna"]);
  });

  it("mails the invited person once, who can sign in after setting a password and has not yet", async () => {
    const { users, client } = seeded().after;
    expect(users.find((user) => user.displayLabel === "Noah Fischer")).toMatchObject({
      identities: 1,
      signedIn: false
    });
    expect(seeded().first.steps.find((step) => step.name === "people")?.note).toBeUndefined();
    // Read after the second run: it sent no further mail.
    const mails = await listAll((paging) => client.captured_mail.list({ query: paging }));
    expect(mails.map((mail) => mail.to.email)).toEqual(["noah.fischer@nordlicht-beratung.test"]);
  });

  it("gives sales and tax their rights on the Connection of the release config", async () => {
    const { client, users, grants } = seeded().before;
    const connection = await client.assets.get({
      params: { kind: "connection", name: "sample-business" }
    });
    const rowsOf = (label: string) => {
      const holder = users.find((user) => user.displayLabel === label);
      return grants
        .filter((row) => row.holderId === holder?.id && row.action.startsWith("connection."))
        .map(({ action, effect, scopeKind, scopeId }) => ({ action, effect, scopeKind, scopeId }))
        .sort((left, right) => left.action.localeCompare(right.action));
    };
    const row = (action: string) => ({
      action,
      effect: "allow",
      scopeKind: "asset",
      scopeId: connection.id
    });
    expect(rowsOf("Sven Olsen")).toEqual([row("connection.read"), row("connection.use")]);
    expect(rowsOf("Tobias Keller")).toEqual([row("connection.use")]);
    // Nobody else holds a row: the admins hold the rights by their role, a user holds none.
    expect(grants.filter((entry) => entry.action.startsWith("connection."))).toHaveLength(3);
    for (const [label, held] of [
      ["Sven Olsen", true],
      ["Mara Lindqvist", true],
      ["Elif Aydin", false]
    ] as const) {
      const holder = users.find((user) => user.displayLabel === label);
      if (!holder) throw new Error(`No seeded user '${label}'`);
      const effective = await client.permissions.effective({
        query: { holderKind: "user", holderId: holder.id }
      });
      expect(JSON.stringify(effective).includes("connection.use"), label).toBe(held);
    }
  });

  it("gives the Check tab the answers the demo README promises", async () => {
    await expectCheckAnswers(seeded().before);
  });

  it("answers the Check tab for the Connection, with using it as an action of its own", async () => {
    await expectCheckAnswers(seeded().before, connectionCheckQuestions);
  });
});
