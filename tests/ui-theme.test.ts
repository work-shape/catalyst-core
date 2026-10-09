import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { composeViewDocument, viewRuntimeAddress } from "@vivd-catalyst/chat-ui";
import { uiConfigSchema } from "@vivd-catalyst/config-schema";
import {
  contrastRatio,
  createThemeTokens,
  DEFAULT_THEME_INPUTS,
  parseHexColor,
  serializeDefaultThemeStylesheet,
  serializeThemeRule,
  THEME_TOKEN_NAMES,
  type RgbColor,
  type ThemeInputs,
  type ThemeMode,
  type ThemeTokenName,
  type ThemeTokens
} from "@vivd-catalyst/ui/theme";
import { stubViewHtmlParser } from "./view-html-parser";

stubViewHtmlParser();

const schemaDefaults = uiConfigSchema.parse({});
const schemaInputs: Record<ThemeMode, ThemeInputs> = {
  light: schemaDefaults.theme,
  dark: schemaDefaults.darkTheme
};
const modes: readonly ThemeMode[] = ["light", "dark"];
const stylesheetPath = new URL("../packages/ui/src/styles.css", import.meta.url);

describe("UI theme defaults", () => {
  it("keeps the generated default stylesheet equal to the mapping of the schema defaults", async () => {
    const stylesheet = serializeDefaultThemeStylesheet(
      createThemeTokens(schemaInputs.light, "light"),
      createThemeTokens(schemaInputs.dark, "dark")
    );

    // `vitest -u` rewrites the file; without it a difference fails.
    await expect(stylesheet).toMatchFileSnapshot("../packages/ui/src/theme/defaults.css");
  });

  it("keeps the library's default inputs equal to the schema defaults", () => {
    expect(DEFAULT_THEME_INPUTS).toEqual(schemaInputs);
    expect(schemaDefaults.accentColor).toBe(schemaInputs.light.accentColor);
  });

  it("keeps every default neutral warm and quiet, and the accent the only colour", () => {
    for (const mode of modes) {
      for (const [name, value] of Object.entries(schemaInputs[mode])) {
        const { r, g, b } = requireHex(value);
        const warm = r >= g && g >= b;
        const accent = name === "accentColor" || name === "accentStrongColor";
        // A neutral leans to red by a few levels only; an accent is plainly orange.
        const quiet = accent ? r - b >= 100 : r - b >= 3 && r - b <= 20;
        expect([mode, name, warm, quiet]).toEqual([mode, name, true, true]);
      }
    }
  });

  it("returns the same token names in both modes", () => {
    for (const mode of modes) {
      expect(Object.keys(createThemeTokens(schemaInputs[mode], mode))).toEqual([
        ...THEME_TOKEN_NAMES
      ]);
    }
  });

  it("maps every colour of the stylesheet's theme to a token of the mapping", async () => {
    const stylesheet = await readFile(stylesheetPath, "utf8");
    const colourTheme = /@theme inline \{([^}]*)\}/u.exec(stylesheet)?.[1] ?? "";
    const referenced = [...colourTheme.matchAll(/var\((--[a-z0-9-]+)\)/gu)].map(
      (match) => match[1]
    );
    const tokenNames = new Set<string>(THEME_TOKEN_NAMES);

    expect(referenced.length).toBeGreaterThan(0);
    expect(referenced.filter((name) => name === undefined || !tokenNames.has(name))).toEqual([]);
    // Every token is reachable from the stylesheet, as a colour or as a shadow utility.
    expect(THEME_TOKEN_NAMES.filter((name) => !stylesheet.includes(`var(${name})`))).toEqual([]);
  });

  it("gives a View outside a themed chat the light default for every token it declares", () => {
    const html = composeViewDocument({
      html: "<section>View</section>",
      kind: "html.rendered",
      runtime: viewRuntimeAddress("", "https://chat.example.test/"),
      allowedScriptSrc: []
    });
    const defaultTheme =
      /<style id="vivd-catalyst-default-theme">\s*:root \{([^}]*)\}/u.exec(html)?.[1] ?? "";
    const declared = [...defaultTheme.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/gu)].flatMap((match) =>
      match[1] === undefined || match[2] === undefined ? [] : [[match[1], match[2]] as const]
    );
    const light: Record<string, string> = createThemeTokens(schemaInputs.light, "light");
    const themed = declared.filter(([name]) => name in light);

    expect(themed.length).toBeGreaterThan(30);
    expect(Object.fromEntries(themed)).toEqual(
      Object.fromEntries(themed.map(([name]) => [name, light[name]]))
    );
  });

  it("passes an instance's seven inputs through as the seven base tokens", () => {
    // A customer theme with a light accent.
    const inputs: ThemeInputs = {
      accentColor: "#00a6e3",
      accentStrongColor: "#103258",
      backgroundColor: "#f7f9fb",
      surfaceColor: "#ffffff",
      textColor: "#17252a",
      mutedTextColor: "#5f6b76",
      borderColor: "#dce2e7"
    };
    const tokens = createThemeTokens(inputs, "light");

    expect({
      surfaceColor: tokens["--background"],
      backgroundColor: tokens["--sidebar"],
      textColor: tokens["--foreground"],
      mutedTextColor: tokens["--muted-foreground"],
      borderColor: tokens["--border"],
      accentColor: tokens["--primary"],
      accentStrongColor: tokens["--accent-foreground"]
    }).toEqual(inputs);
    expect(tokens["--muted"]).toBe(inputs.backgroundColor);
    expect(tokens["--card"]).toBe(inputs.surfaceColor);
    expect(tokens["--ring"]).toBe(inputs.accentColor);
  });

  it("puts the text with the higher contrast on a solid fill", () => {
    const onAccent = (accentColor: string) =>
      createThemeTokens({ ...schemaInputs.dark, accentColor }, "dark")["--primary-foreground"];

    expect(onAccent("#2dd4bf")).toBe("#111111");
    expect(onAccent("#0f766e")).toBe("#ffffff");
  });

  it("refuses a theme value that could leave its declaration", () => {
    const tokens = createThemeTokens(
      { ...schemaInputs.light, accentColor: "red;} body{display:none" },
      "light"
    );

    expect(() => serializeThemeRule(":root", tokens)).toThrow(/Unsupported CSS value/u);
  });
});

describe("UI theme contrast", () => {
  // The table "Measured contrast" of the base theme. A translucent fill is flattened onto the
  // surface beneath it first, and every pairing is measured on page, sidebar and raised surface.
  const table = Object.fromEntries(
    modes.map((mode) => [mode, measureContrast(createThemeTokens(schemaInputs[mode], mode))])
  );

  it.each(modes)("keeps every text pairing of the %s default theme at 4.5:1 or better", (mode) => {
    const failing = Object.entries(table[mode] ?? {}).filter(([, ratio]) => ratio < 4.5);

    expect(Object.keys(table[mode] ?? {}).length).toBeGreaterThan(60);
    expect(failing).toEqual([]);
  });

  it("measures the values the design names", () => {
    expect(table.light?.["text on page"]).toBeCloseTo(16.39, 1);
    expect(table.light?.["text on sidebar"]).toBeCloseTo(15.28, 1);
    expect(table.light?.["muted text on page"]).toBeCloseTo(6.19, 1);
    expect(table.light?.["warning as text on sidebar"]).toBeCloseTo(4.53, 1);
    expect(table.light?.["primary button label"]).toBeCloseTo(4.63, 1);
    expect(table.light?.["chosen segment on sidebar"]).toBeCloseTo(4.76, 1);
    expect(table.dark?.["text on page"]).toBeCloseTo(14.61, 1);
    expect(table.dark?.["text on raised"]).toBeCloseTo(12.61, 1);
    expect(table.dark?.["muted text on raised"]).toBeCloseTo(6.72, 1);
    expect(table.dark?.["danger button label"]).toBeCloseTo(6.83, 1);
    expect(table.dark?.["primary button label"]).toBeCloseTo(6.91, 1);
    expect(Math.min(...Object.values(table.light ?? {}))).toBeCloseTo(4.53, 1);
  });
});

interface Rgba extends RgbColor {
  a: number;
}

function measureContrast(tokens: ThemeTokens): Record<string, number> {
  const read = (name: ThemeTokenName) => parseColor(tokens[name]);
  const surfaces: Record<string, RgbColor> = {
    page: flatten(read("--background"), undefined),
    sidebar: flatten(read("--sidebar"), undefined),
    raised: flatten(read("--popover"), undefined)
  };
  const fills: Record<string, ThemeTokenName> = {
    hover: "--state-hover",
    pressed: "--state-pressed",
    selected: "--state-selected"
  };
  const tones = [
    ["success", "--success", "--success-soft", "--success-soft-foreground"],
    ["warning", "--warning", "--warning-soft", "--warning-soft-foreground"],
    ["info", "--info", "--info-soft", "--info-soft-foreground"],
    ["danger", "--destructive", "--destructive-soft", "--destructive-soft-foreground"]
  ] as const;
  const ratios: Record<string, number> = {};
  const measure = (label: string, text: Rgba, fill: Rgba, surface: RgbColor) => {
    const background = flatten(fill, surface);
    ratios[label] = contrastRatio(flatten(text, background), background);
  };
  const opaque = (color: RgbColor): Rgba => ({ ...color, a: 1 });

  for (const [surfaceName, surface] of Object.entries(surfaces)) {
    const plain = opaque(surface);
    measure(`text on ${surfaceName}`, read("--foreground"), plain, surface);
    measure(`muted text on ${surfaceName}`, read("--muted-foreground"), plain, surface);
    measure(`link on ${surfaceName}`, read("--accent-foreground"), plain, surface);
    for (const [fillName, token] of Object.entries(fills)) {
      measure(`text on ${fillName} on ${surfaceName}`, read("--foreground"), read(token), surface);
      measure(
        `muted text on ${fillName} on ${surfaceName}`,
        read("--muted-foreground"),
        read(token),
        surface
      );
    }
    measure(
      `link on hover on ${surfaceName}`,
      read("--accent-foreground"),
      read("--state-hover"),
      surface
    );
    measure(
      `primary button label on hover on ${surfaceName}`,
      read("--primary-foreground"),
      read("--primary-hover"),
      surface
    );
    // The chosen item of a segmented control: strong accent text on the accent tint, in a tray
    // with the secondary fill.
    measure(
      `chosen segment on ${surfaceName}`,
      read("--primary-soft-foreground"),
      read("--primary-soft"),
      flatten(read("--secondary"), surface)
    );
    // A danger button's hover is the fill at 90% over what lies beneath.
    measure(
      `danger button label on hover on ${surfaceName}`,
      read("--destructive-foreground"),
      { ...read("--destructive"), a: 0.9 },
      surface
    );
    for (const [tone, color, soft, softForeground] of tones) {
      measure(`${tone} badge on ${surfaceName}`, read(softForeground), read(soft), surface);
      measure(`${tone} as text on ${surfaceName}`, read(color), plain, surface);
    }
  }
  const page = surfaces.page ?? { r: 0, g: 0, b: 0 };
  measure("placeholder in a field", read("--muted-foreground"), opaque(page), page);
  measure("primary button label", read("--primary-foreground"), read("--primary"), page);
  measure("danger button label", read("--destructive-foreground"), read("--destructive"), page);
  measure("tooltip", read("--background"), read("--foreground"), page);
  return ratios;
}

/** Reads a hex colour or a `color-mix(in srgb, A p%, B)` over hex colours and `transparent`. */
function parseColor(value: string): Rgba {
  const mix = /^color-mix\(in srgb, (#[0-9a-f]+) (\d+)%, (#[0-9a-f]+|transparent)\)$/iu.exec(value);
  if (!mix) {
    return { ...requireHex(value), a: 1 };
  }
  const color = requireHex(mix[1] ?? "");
  const share = Number(mix[2]) / 100;
  if (mix[3] === "transparent") {
    return { ...color, a: share };
  }
  const base = requireHex(mix[3] ?? "");
  return {
    r: color.r * share + base.r * (1 - share),
    g: color.g * share + base.g * (1 - share),
    b: color.b * share + base.b * (1 - share),
    a: 1
  };
}

function flatten(color: Rgba, surface: RgbColor | undefined): RgbColor {
  if (color.a === 1) {
    return { r: color.r, g: color.g, b: color.b };
  }
  if (!surface) {
    throw new Error("A surface must be opaque.");
  }
  return {
    r: color.r * color.a + surface.r * (1 - color.a),
    g: color.g * color.a + surface.g * (1 - color.a),
    b: color.b * color.a + surface.b * (1 - color.a)
  };
}

function requireHex(value: string): RgbColor {
  const color = parseHexColor(value);
  if (!color) {
    throw new Error(`Not a hex colour: ${value}`);
  }
  return color;
}
