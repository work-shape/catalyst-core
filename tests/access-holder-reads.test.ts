import { describe, expect, it } from "vitest";
import { setupAccessInstance as setup } from "./support/access-instance";

describe("reading effective rights", () => {
  it("lets a person read their own effective rights without users.manage", async () => {
    const t = await setup();
    await t.createNamespace("kai-");
    await t.grant(t.kai.id, "agent.read", { namespace: "kai-" });
    const response = await t.expectOk(t.kai.id, "permissions.effective", {
      query: { holderKind: "user", holderId: t.kai.id }
    });
    expect(response.json()).toMatchObject({
      holderActive: true,
      items: expect.arrayContaining([expect.objectContaining({ action: "agent.read" })])
    });
  });
});
