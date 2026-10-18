import { describe, expect, it } from "vitest";
import { createTestConfig } from "./support/fixtures";
import { createTestInstance } from "./support/test-instance";

// The account's optional language is persisted independently of its display name.
describe("the current user's language", () => {
  it("keeps the language a person chose, answers it on me, and goes back to the default on null", async () => {
    const app = await createTestInstance({ config: createTestConfig(), env: {}, tools: [] });
    const me = async () =>
      (await app.call("me.get")).json<{ locale?: string; displayLabel: string }>();
    expect((await me()).locale).toBeUndefined();

    const chosen = await app.call("me.update", { payload: { locale: "de" } });
    expect(chosen.statusCode).toBe(200);
    const label = (await me()).displayLabel;
    expect(chosen.json()).toMatchObject({ locale: "de", displayLabel: label });
    expect(await me()).toMatchObject({ locale: "de", displayLabel: label });

    // A change of the name alone keeps the language.
    await app.call("me.update", { payload: { displayLabel: "Renamed" } });
    expect(await me()).toMatchObject({ locale: "de", displayLabel: "Renamed" });

    const cleared = await app.call("me.update", { payload: { locale: null } });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json<{ locale?: string }>().locale).toBeUndefined();
    expect((await me()).locale).toBeUndefined();

    const empty = await app.call("me.update", { payload: {} });
    expect(empty.statusCode).toBe(422);
    expect((await app.call("me.update", { payload: { locale: "fr" } })).statusCode).toBe(422);
    await app.close();
  });

  it("refuses a language the instance does not offer and keeps the one before", async () => {
    const app = await createTestInstance({
      config: {
        ...createTestConfig(),
        localization: { defaultLocale: "en", supportedLocales: ["en"] }
      },
      env: {},
      tools: []
    });
    const refused = await app.call("me.update", { payload: { locale: "de" } });
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({ error: { details: { reason: "locale_not_offered" } } });
    expect((await app.call("me.get")).json<{ locale?: string }>().locale).toBeUndefined();
    await app.close();
  });
});
