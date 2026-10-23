import { resolve } from "node:path";
import postgres from "postgres";
import { fileTestDatabaseUrl } from "./support/test-database";
import { describe, expect, it } from "vitest";
import { listAll } from "@work-shape/catalyst-api-client";
import { assetKindLabelKey } from "@work-shape/catalyst-chat-ui/access";
import { connectionCheckQuestions } from "@work-shape/catalyst-demo/seed";
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

// The recovery test below mails Noah again on the shared instance. Mail capture has no delete,
// so the once-only test leaves out exactly those mails, whichever of the two runs first.
const recoveryMailIds = new Set<string>();

describe("the demo seed on the demo's own config", () => {
  it("has a name for every asset kind the instance registers", async () => {
    const { kinds } = await seeded().after.client.platform.context.get();
    // Every module of the demo is on, so this is every kind the platform brings. A new kind
    // fails here until the interface has a word for it.
    expect(kinds.map((kind) => kind.kind)).toEqual(
      expect.arrayContaining(["agent", "skill", "connection", "app", "workflow"])
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
      people: 9,
      "service principals": 1,
      "API keys": 1,
      "the instance's own agents and skills": 2,
      agents: 8,
      skills: 7,
      "grant rows": 34,
      "builder assets": 2,
      "approval requests": 2,
      "connection grant rows": 9,
      workspaces: 2,
      "workspace members": 4,
      "workspace bundles": 3,
      "workspace assets": 3,
      apps: 3,
      workflows: 1
    });
    // This config brings the Connection `sample-business`, so the App whose action calls it is
    // stored and published here too. Fails without S3-42: the seed knew no such App.
    expect(seeded().before.apps.find((app) => app.name === "customer-list")).toMatchObject({
      revision: 1,
      publishedRevision: 1,
      title: "Customers"
    });
    expectSecondRunChangedNothing(seeded(), ["workflows"]);
    // The demo's own agent stays the default, not the first agent of the company.
    expect(seeded().before.defaultAgentName).toBe("workflow_assistant");
  });

  // Fails on an instance whose engine reads no definition: the list is empty and the start
  // is refused as a Workflow that does not exist.
  it("brings a Workflow a person can start, published and run as its own principal", async () => {
    const { client } = seeded().after;
    const { items } = await client.workflows.list();
    expect(items).toMatchObject([
      { id: "accounting-clients", name: "Accounting clients", runnable: true, reasons: [] }
    ]);
    const asset = await client.assets.get({
      params: { kind: "workflow", name: "accounting-clients" }
    });
    expect(asset).toMatchObject({ revision: 1, publishedRevision: 1 });
    // The page starts it without an input.
    const started = await client.workflows.start({
      params: { workflow: "accounting-clients" },
      body: {}
    });
    if (started.status !== "done") throw new Error("The start was held for an approval");
    expect(started.output).toMatchObject({
      workflow: "accounting-clients",
      status: "queued",
      definitionRevisionId: items[0]?.definitionRevisionId,
      principal: { name: "workflow-demo" }
    });
    // Its principal can use both accounting transports.
    const connection = await client.assets.get({
      params: { kind: "connection", name: "sample-accounting" }
    });
    const rest = await client.assets.get({
      params: { kind: "connection", name: "sample-accounting-rest" }
    });
    const { grants, principals } = seeded().before;
    const runner = principals.find((principal) => principal.displayLabel === "Workflow demo");
    expect(
      grants
        .filter((row) => row.holderId === runner?.id)
        .map(({ action, scopeKind, scopeId }) => ({ action, scopeKind, scopeId }))
        .sort((left, right) => (left.scopeId ?? "").localeCompare(right.scopeId ?? ""))
    ).toEqual(
      [connection, rest]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(({ id }) => ({
          action: "connection.use",
          scopeKind: "asset",
          scopeId: id
        }))
    );
  });

  it("lists both models the seed names for the HR workspace", () => {
    expect(seeded().before.hrWorkspace?.allowedModelBindingIds).toEqual(["primary", "gpt56Luna"]);
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
    expect(
      mails.filter((mail) => !recoveryMailIds.has(mail.id)).map((mail) => mail.to.email)
    ).toEqual(["noah.fischer@nordlicht-beratung.test"]);
  });

  it("gives sales and tax their rights on the Connection of the release config", async () => {
    const { client, users, grants } = seeded().before;
    const connection = await client.assets.get({
      params: { kind: "connection", name: "sample-business" }
    });
    const rowsOf = (label: string) => {
      const holder = users.find((user) => user.displayLabel === label);
      return grants
        .filter(
          (row) =>
            row.holderId === holder?.id &&
            row.action.startsWith("connection.") &&
            row.scopeId === connection.id
        )
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
    expect(grants.filter((entry) => entry.scopeId === connection.id)).toHaveLength(3);
    for (const [label, held] of [
      ["Sven Olsen", true],
      ["Mara Lindqvist", true],
      ["Elif Aydin", true]
    ] as const) {
      const holder = users.find((user) => user.displayLabel === label);
      if (!holder) throw new Error(`No seeded user '${label}'`);
      const effective = await client.permissions.effective({
        query: { holderKind: "user", holderId: holder.id }
      });
      expect(JSON.stringify(effective).includes("connection.use"), label).toBe(held);
    }
  });

  it("grants REST use only to active demo users and the Workflow principal", async () => {
    const { client, users, grants } = seeded().before;
    const connection = await client.assets.get({
      params: { kind: "connection", name: "sample-accounting-rest" }
    });
    const rows = grants.filter((grant) => grant.scopeId === connection.id);
    expect(rows).toHaveLength(7);
    expect(rows.every((row) => row.action === "connection.use" && row.effect === "allow")).toBe(
      true
    );
    expect(rows.filter((row) => row.holderKind === "service_principal")).toHaveLength(1);
    const labels = rows
      .filter((row) => row.holderKind === "user")
      .map((row) => users.find((user) => user.id === row.holderId)?.displayLabel);
    expect(labels.sort()).toEqual(
      [
        "Mara Lindqvist",
        "Jonas Brandt",
        "Tobias Keller",
        "Elif Aydin",
        "Sven Olsen",
        "Kai Berger"
      ].sort()
    );
  });

  it("gives the Check tab the answers the demo README promises", async () => {
    await expectCheckAnswers(seeded().before);
  });

  it("answers the Check tab for the Connection, with using it as an action of its own", async () => {
    await expectCheckAnswers(seeded().before, connectionCheckQuestions);
  });

  it("mails the invitation an interrupted seed did not send, once", async () => {
    const { after, seedAgain } = seeded();
    const noah = after.users.find((user) => user.email === "noah.fischer@nordlicht-beratung.test");
    expect(noah).toBeDefined();
    const prior = await listAll((paging) => after.client.captured_mail.list({ query: paging }));
    const priorIds = new Set(prior.map((mail) => mail.id));
    const sql = postgres(await fileTestDatabaseUrl(), { max: 1 });
    try {
      const removed = await sql`delete from audit_events
        where type = 'user.invitation_sent' and subject = ${noah?.id ?? ""} returning id`;
      expect(removed).toHaveLength(1);
      // Capture mail is in memory and has no delete operation. Reading only mail sent after
      // this point gives the interrupted run an empty mailbox without a product test seam.
      const recovered = await seedAgain();
      expect(createdBy(recovered).people).toBe(0);
      expect(recovered.steps.find((step) => step.name === "people")?.note).toBe(
        "Mailed the invitation an earlier run created the person for and did not send."
      );
      const mails = await listAll((paging) => after.client.captured_mail.list({ query: paging }));
      const sent = mails.filter((mail) => !priorIds.has(mail.id));
      for (const mail of sent) recoveryMailIds.add(mail.id);
      expect(sent.map((mail) => mail.to.email)).toEqual(["noah.fischer@nordlicht-beratung.test"]);
      const audited = await sql`select id from audit_events
        where type = 'user.invitation_sent' and subject = ${noah?.id ?? ""}`;
      expect(audited).toHaveLength(1);
    } finally {
      await sql.end();
    }
  });
});
