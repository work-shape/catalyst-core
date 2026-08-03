import { describe, expect, it } from "vitest";
import { createThemeStyle } from "../packages/chat-ui/src/theme";

describe("chat UI theme", () => {
  it("chooses the higher-contrast foreground for branded accent colors", () => {
    expect(primaryForeground("#2dd4bf")).toBe("#071312");
    expect(primaryForeground("#0f766e")).toBe("#ffffff");
  });
});

function primaryForeground(accentColor: string): unknown {
  const theme = {
    accentColor,
    accentStrongColor: accentColor,
    backgroundColor: "#0f1514",
    surfaceColor: "#171f1d",
    textColor: "#eef6f3",
    mutedTextColor: "#9eaaa5",
    borderColor: "#2b3734"
  };
  const style = createThemeStyle({ theme, darkTheme: theme } as never, "dark");
  return (style as Record<string, unknown>)["--primary-foreground"];
}
