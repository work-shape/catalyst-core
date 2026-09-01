import { describe, expect, it } from "vitest";
import {
  collaborationWorkspaceAccentAttributes,
  collaborationWorkspaceAccentColors,
  collaborationWorkspaceAccentTokens,
  contrastRatio,
  defaultCollaborationWorkspaceAccentColor,
  randomCollaborationWorkspaceAccentColor,
  resolveCollaborationWorkspaceAccentColor
} from "../packages/chat-ui/src/collaboration-workspace/collaboration-workspace-accent";

describe("collaboration workspace accent palette", () => {
  it("keeps avatar text readable in both themes", () => {
    for (const accentColor of collaborationWorkspaceAccentColors) {
      for (const themeMode of ["light", "dark"] as const) {
        const tokens = collaborationWorkspaceAccentTokens(accentColor, themeMode);
        expect(
          contrastRatio(tokens.onSurface, tokens.surface),
          `${accentColor} (${themeMode})`
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("emits both theme variants plus the palette key as a data attribute", () => {
    const attributes = collaborationWorkspaceAccentAttributes("emerald");

    expect(attributes["data-collaboration-workspace-accent"]).toBe("emerald");
    expect(attributes.style).toMatchObject({
      "--collaboration-workspace-accent-surface-light": "#047857",
      "--collaboration-workspace-accent-surface-dark": "#34d399"
    });
  });

  it("derives a stable fallback from the name for a stored workspace without an accent", () => {
    const first = defaultCollaborationWorkspaceAccentColor("Product team");
    const second = defaultCollaborationWorkspaceAccentColor("Product team");

    expect(first).toBe(second);
    expect(collaborationWorkspaceAccentColors).toContain(first);
    expect(defaultCollaborationWorkspaceAccentColor("")).toBeDefined();
  });

  it("picks a create-dialog starting accent from the injected random", () => {
    expect(randomCollaborationWorkspaceAccentColor(() => 0)).toBe(
      collaborationWorkspaceAccentColors[0]
    );
    expect(randomCollaborationWorkspaceAccentColor(() => 0.999)).toBe(
      collaborationWorkspaceAccentColors.at(-1)
    );
    expect(collaborationWorkspaceAccentColors).toContain(randomCollaborationWorkspaceAccentColor());
  });

  it("prefers the persisted palette key and falls back for unknown values", () => {
    expect(
      resolveCollaborationWorkspaceAccentColor({ accentColor: "violet", name: "Anything" })
    ).toBe("violet");
    expect(resolveCollaborationWorkspaceAccentColor({ accentColor: null, name: "Anything" })).toBe(
      defaultCollaborationWorkspaceAccentColor("Anything")
    );
    expect(
      resolveCollaborationWorkspaceAccentColor({ accentColor: "chartreuse", name: "Anything" })
    ).toBe(defaultCollaborationWorkspaceAccentColor("Anything"));
  });
});
