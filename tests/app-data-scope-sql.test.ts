import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { clientInstanceId } from "./support/access-instance";
import { resultSchema } from "./support/app-actions";
import { expectStatus } from "./support/app-instance";
import { init, manifest } from "./support/data-store-world";
import { findingsApp, setupFindingsApp, type FindingsWorld } from "./support/findings-app";

const scopedManifest = manifest("tables: { findings: { scope: { mandant: client_id } } }\n");
// An author's own filter widens nothing: the platform filters the table itself.
const statements = {
  or_true: `select client_id, amount from findings where client_id = any($viewer.scope('mandant')) or true order by id\n`,
  union: `select client_id from findings where client_id = any($viewer.scope('mandant'))\nunion all select client_id from findings\n`,
  unbound: `select client_id from findings order by id\n`
};

describe("App sql actions on a scoped table (SCOPE-1, check 42)", () => {
  let t: FindingsWorld;
  beforeAll(async () => {
    t = await setupFindingsApp();
    await t.publishStore("findings", [scopedManifest, init], t.workspaceId);
    await t.stores.access.setScopeAssignment({
      clientInstanceId,
      dimension: "mandant",
      holderKind: "user",
      holderId: t.admin.id,
      effect: "allow",
      values: ["client-b"]
    });
  });
  afterAll(() => t.closeAll());

  const clients = (body: unknown) =>
    z
      .object({ rows: z.array(z.object({ client_id: z.string() })) })
      .parse(resultSchema.parse(body).result)
      .rows.map((row) => row.client_id);

  it("reads only the viewer's rows from a draft, whatever its SQL adds", async () => {
    expectStatus(
      await t.putApp(t.admin.id, "findings", findingsApp({ marker: "draft", statements })),
      200
    );
    const frame = await t.openApp(t.admin.id, "draft", "findings");
    for (const name of Object.keys(statements)) {
      const read = await t.callAction(t.admin.id, frame, name, {});
      expectStatus(read, 200);
      expect(clients(read.json()), name).toEqual(
        name === "union" ? ["client-b", "client-b"] : ["client-b"]
      );
    }
  });

  it("publishes a read without a binding and filters it for the viewer", async () => {
    const written = await t.putApp(
      t.admin.id,
      "findings",
      findingsApp({ marker: "published", statements })
    );
    expectStatus(written, 200);
    const { revision } = z.object({ revision: z.number() }).parse(written.json());
    expectStatus(await t.publish(t.admin.id, "findings", revision), 200);
    const frame = await t.openApp(t.admin.id, "published", "findings");
    const read = await t.callAction(t.admin.id, frame, "union", {});
    expectStatus(read, 200);
    expect(clients(read.json())).toEqual(["client-b", "client-b"]);
  });
});
