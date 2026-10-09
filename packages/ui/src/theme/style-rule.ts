import type { ThemeTokens } from "./tokens";

/**
 * Writes tokens as one CSS rule for a `<style>` element. This is the only place theme values
 * reach a stylesheet as text. Theme inputs are free strings from instance config, so every
 * value is checked first: anything that could close the declaration or the rule is refused.
 */
export function serializeThemeRule(selector: string, tokens: ThemeTokens): string {
  const declarations = Object.entries(tokens)
    .map(([name, value]) => `${name}:${checkedThemeValue(name, value)};`)
    .join("");
  return `${selector}{${declarations}}`;
}

/** The generated default stylesheet: light on the document root, dark under its theme attribute. */
export function serializeDefaultThemeStylesheet(light: ThemeTokens, dark: ThemeTokens): string {
  return [
    "/* Generated from the config schema defaults by tests/ui-theme.test.ts. Do not edit by hand. */",
    formatRule(":root", light),
    formatRule(':root[data-vivd-theme="dark"]', dark),
    ""
  ].join("\n");
}

function formatRule(selector: string, tokens: ThemeTokens): string {
  const declarations = Object.entries(tokens).map(
    ([name, value]) => `  ${name}: ${checkedThemeValue(name, value)};`
  );
  return [`${selector} {`, ...declarations, "}"].join("\n");
}

function checkedThemeValue(name: string, value: string): string {
  const trimmed = value.trim();
  if (!/^[#a-zA-Z0-9\s.,()%+/-]+$/u.test(trimmed)) {
    throw new Error(`Unsupported CSS value for theme token ${name}: ${trimmed}`);
  }
  return trimmed;
}
