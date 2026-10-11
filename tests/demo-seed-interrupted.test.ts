import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { completedOutput, listAll } from "@vivd-catalyst/api-client";
import {
  createdBy,
  demoConfigEnv,
  expectSecondRunChangedNothing,
  useSeededInstance
} from "./support/demo-seed";

// A run of the seed that stopped after it created the invited person and before it mailed
// them: the person is there, and no invitation was ever sent. The test fails without the
// seed looking for the mail in the audit events.

const NOAH = "noah.fischer@nordlicht-beratung.test";

const seeded = useSeededInstance({
  // The demo's own config: it has the invitation module and captures mail.
  configPath: resolve("clients/demo/config/app.yaml"),
  baseUrl: "http://127.0.0.1:4100",
  origin: "http://127.0.0.1:5173",
  instanceAssets: resolve("clients/demo"),
  superadmin: { email: "superadmin@example.test", password: "demo-superadmin-password" },
  env: demoConfigEnv(),
  prepare: async (client) => {
    completedOutput(
      await client.users.create({
        body: {
          displayLabel: "Noah Fischer",
          email: NOAH,
          roles: ["user"],
          permissions: [],
          permissionRefs: ["demo-tools"],
          status: "active"
        }
      })
    );
  }
});

describe("the demo seed after an interrupted run", () => {
  it("mails the invitation the earlier run did not send, once", async () => {
    expect(createdBy(seeded().first).people).toBe(6);
    expect(seeded().first.steps.find((step) => step.name === "people")?.note).toBe(
      "Mailed the invitation an earlier run created the person for and did not send."
    );
    expect(seeded().second.steps.find((step) => step.name === "people")?.note).toBeUndefined();
    expectSecondRunChangedNothing(seeded());
    const mails = await listAll((paging) =>
      seeded().after.client.captured_mail.list({ query: paging })
    );
    expect(mails.map((mail) => mail.to.email)).toEqual([NOAH]);
  });
});
