import { describe, expect, it } from "vitest";
import { createHttpApiConnectorType } from "@work-shape/catalyst-connections";

describe("the HTTP API person-context header", () => {
  const schema = createHttpApiConnectorType().settingsSchema;
  const baseUrl = "https://api.example.test";
  it("is optional and accepts a configured non-credential header", () => {
    expect(schema.safeParse({ baseUrl }).success).toBe(true);
    expect(schema.safeParse({ baseUrl, personContextHeader: "X-Audience-Context" }).success).toBe(
      true
    );
  });
  it.each(["Authorization", "Cookie", "X-Api-Key", "X-Token", "Host", "Accept", "bad\r\nheader"])(
    "refuses credential and transport header %s",
    (personContextHeader) => {
      expect(schema.safeParse({ baseUrl, personContextHeader }).success).toBe(false);
    }
  );
  it("refuses collisions with fixed and credential headers without regard to case", () => {
    expect(
      schema.safeParse({
        baseUrl,
        personContextHeader: "X-Context",
        headers: { "x-context": "fixed" }
      }).success
    ).toBe(false);
    expect(
      schema.safeParse({ baseUrl, personContextHeader: "X-Context", headerName: "x-context" })
        .success
    ).toBe(false);
  });
});
