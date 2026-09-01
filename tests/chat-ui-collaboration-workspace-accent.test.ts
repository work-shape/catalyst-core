import { describe, expect, it } from "vitest";
import { workspaceAccentColorSchema } from "@vivd-catalyst/api-contract";
import { WORKSPACE_ACCENT_COLORS } from "@vivd-catalyst/core";
import {
  collaborationWorkspaceAccentAttributes,
  collaborationWorkspaceAccentColors,
  collaborationWorkspaceAccentTokens,
  contrastRatio,
  defaultCollaborationWorkspaceAccentColor,
  randomCollaborationWorkspaceAccentColor,
  resolveCollaborationWorkspaceAccentColor
} from "../packages/chat-ui/src/collaboration-workspace/collaboration-workspace-accent";

/**
 * The eight accents that shipped before the palette was widened. Pinned as
 * literals rather than derived from the palette: the point is to catch an edit
 * to a stored workspace's rendered color, which a derived copy could not see.
 */
const originalAccents = {
  ruby: { light: "#be123c", dark: "#fb7185" },
  amber: { light: "#b45309", dark: "#fbbf24" },
  emerald: { light: "#047857", dark: "#34d399" },
  sapphire: { light: "#1d4ed8", dark: "#60a5fa" },
  violet: { light: "#6d28d9", dark: "#a78bfa" },
  rose: { light: "#be185d", dark: "#f472b6" },
  teal: { light: "#0f766e", dark: "#2dd4bf" },
  slate: { light: "#475569", dark: "#94a3b8" }
} as const;

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

  it("renders every already-stored workspace exactly as before the palette grew", () => {
    for (const accentColor of Object.keys(originalAccents) as Array<keyof typeof originalAccents>) {
      const expected = originalAccents[accentColor];
      expect(collaborationWorkspaceAccentColors).toContain(accentColor);
      expect(collaborationWorkspaceAccentTokens(accentColor, "light").surface).toBe(expected.light);
      expect(collaborationWorkspaceAccentTokens(accentColor, "dark").surface).toBe(expected.dark);
    }
  });

  it("offers a wider palette of visually distinct swatches", () => {
    expect(collaborationWorkspaceAccentColors.length).toBeGreaterThanOrEqual(16);

    expect(new Set(collaborationWorkspaceAccentColors).size).toBe(
      collaborationWorkspaceAccentColors.length
    );

    // Two keys resolving to the same hex would render as duplicate swatches.
    const surfaces = collaborationWorkspaceAccentColors.flatMap((accentColor) => [
      collaborationWorkspaceAccentTokens(accentColor, "light").surface,
      collaborationWorkspaceAccentTokens(accentColor, "dark").surface
    ]);
    expect(new Set(surfaces).size).toBe(surfaces.length);
  });

  it("keeps the three copies of the accent enum in step", () => {
    // The picker, the request schema and the server-side check are separate
    // literal lists. Adding a color to only some of them fails at runtime -- the
    // swatch saves, then the api-client rejects every later read of that
    // workspace -- so the parity is asserted here instead.
    const uiColors = [...collaborationWorkspaceAccentColors].sort();

    expect([...WORKSPACE_ACCENT_COLORS].sort()).toEqual(uiColors);
    expect([...workspaceAccentColorSchema.options].sort()).toEqual(uiColors);
  });

  it("keeps the name-derived fallback inside the original palette", () => {
    // Workspaces with no stored accent (every personal one) take their color
    // from this hash, so widening the pool would re-tint all of them at once.
    const derived = new Set(
      Array.from({ length: 200 }, (_, index) =>
        defaultCollaborationWorkspaceAccentColor(`workspace ${index}`)
      )
    );

    for (const accentColor of derived) {
      expect(Object.keys(originalAccents)).toContain(accentColor);
    }
  });

  it("draws the create-dialog starting accent from the whole palette", () => {
    const drawn = new Set(
      collaborationWorkspaceAccentColors.map((_, index) =>
        randomCollaborationWorkspaceAccentColor(
          () => index / collaborationWorkspaceAccentColors.length
        )
      )
    );

    expect([...drawn].sort()).toEqual([...collaborationWorkspaceAccentColors].sort());
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
