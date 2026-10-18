import { describe, expect, it } from "vitest";
import { apiOperations } from "@work-shape/catalyst-api-contract";

const currentUser = {
  id: "usr_1",
  externalUserId: "kai",
  displayLabel: "Kai",
  roles: ["user"],
  permissionRefs: [],
  permissions: [],
  clientInstanceId: "demo",
  authSource: "dev"
};

describe("the account locale contract", () => {
  it("changes the signed-in person's language apart from their name, and answers it", () => {
    const update = apiOperations["me.update"].body;
    expect(update.parse({ locale: "de" })).toEqual({ locale: "de" });
    expect(update.parse({ locale: null })).toEqual({ locale: null });
    expect(update.parse({ displayLabel: "Kai" })).toEqual({ displayLabel: "Kai" });
    for (const refused of [{}, { locale: "fr" }, { displayLabel: "" }])
      expect(update.safeParse(refused).success).toBe(false);
    const me = { ...apiOperations["me.get"].response.schema.parse(currentUser), locale: "de" };
    expect(apiOperations["me.get"].response.schema.parse(me).locale).toBe("de");
    expect(apiOperations["me.update"].response.schema.parse(currentUser).locale).toBeUndefined();
  });
});
