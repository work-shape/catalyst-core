import { describe, expect, it } from "vitest";
import { withTestSql } from "./support/test-sql";
import { createTestConfig } from "./support/fixtures";
import { createTestInstance } from "./support/test-instance";

// What Enter does during a person's own run is kept with the account (FU-2, check 89): Steer
// for a new person, Queue once they chose it, the same on every device.
describe("the current user's follow-up mode", () => {
  it("is Steer for a new person, keeps Queue once chosen, and audits the field alone", async () => {
    const app = await createTestInstance({ config: createTestConfig(), env: {}, tools: [] });
    const me = async () =>
      (await app.call("me.get")).json<{ id: string; followUpMode?: string; locale?: string }>();
    expect((await me()).followUpMode).toBe("steer");

    const chosen = await app.call("me.update", { payload: { followUpMode: "queue" } });
    expect(chosen.statusCode, chosen.body).toBe(200);
    expect(chosen.json()).toMatchObject({ followUpMode: "queue" });
    expect((await me()).followUpMode).toBe("queue");

    // A change of the language alone keeps the mode.
    await app.call("me.update", { payload: { locale: "de" } });
    expect(await me()).toMatchObject({ followUpMode: "queue", locale: "de" });

    expect(
      (await app.call("me.update", { payload: { followUpMode: "interrupt" } })).statusCode
    ).toBe(422);
    const { id } = await me();
    const audits = await withTestSql(
      (sql) =>
        sql`select metadata from audit_events where type = 'user.profile_updated' and subject = ${id} order by created_at`
    );
    expect(audits.map((audit) => audit.metadata)).toEqual([
      { fields: ["followUpMode"] },
      { fields: ["locale"] }
    ]);
    await app.close();
  });
});
