import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { listAll } from "@vivd-catalyst/api-client";
import {
  createdBy,
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
  // The config names the secret. No model is called.
  env: { OPENAI_API_KEY: "not-a-key" }
});

describe("the demo seed on the demo's own config", () => {
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
      "approval requests": 1,
      connections: 0
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

  it("gives the Check tab the answers the demo README promises", async () => {
    await expectCheckAnswers(seeded().before);
  });
});
