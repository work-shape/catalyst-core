import { describe, expect, it } from "vitest";
import { resolveThemeModePreference } from "../packages/chat-ui/src/theme";

// The token mapping moved to the shared UI library; tests/ui-theme.test.ts covers it.
describe("chat UI theme mode", () => {
  it("follows an explicit preference and the system otherwise", () => {
    expect(resolveThemeModePreference("dark", "light")).toBe("dark");
    expect(resolveThemeModePreference("light", "dark")).toBe("light");
    expect(resolveThemeModePreference("system", "dark")).toBe("dark");
    expect(resolveThemeModePreference(undefined, "light")).toBe("light");
  });
});
