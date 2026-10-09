/** WCAG contrast arithmetic over sRGB hex colours. Imports nothing, so it runs in Node and the browser. */
export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

/** The two text colours the library puts on a solid fill. */
export const TEXT_ON_SOLID_LIGHT = "#ffffff";
export const TEXT_ON_SOLID_DARK = "#111111";

export function parseHexColor(value: string): RgbColor | undefined {
  const hex = value.trim().replace(/^#/u, "");
  if (!/^[0-9a-f]{3}([0-9a-f]{3})?$/iu.test(hex)) {
    return undefined;
  }
  const digits =
    hex.length === 3 ? [...hex].map((character) => `${character}${character}`).join("") : hex;
  return {
    r: Number.parseInt(digits.slice(0, 2), 16),
    g: Number.parseInt(digits.slice(2, 4), 16),
    b: Number.parseInt(digits.slice(4, 6), 16)
  };
}

function relativeLuminance({ r, g, b }: RgbColor): number {
  return 0.2126 * linearChannel(r) + 0.7152 * linearChannel(g) + 0.0722 * linearChannel(b);
}

export function contrastRatio(first: RgbColor, second: RgbColor): number {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  const lighter = Math.max(firstLuminance, secondLuminance);
  const darker = Math.min(firstLuminance, secondLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * The text colour for a solid fill: white or near-black, whichever contrasts more. A fill that
 * is not a hex colour cannot be measured and gets white.
 */
export function textOnSolid(fill: string): string {
  const fillColor = parseHexColor(fill);
  const light = parseHexColor(TEXT_ON_SOLID_LIGHT);
  const dark = parseHexColor(TEXT_ON_SOLID_DARK);
  if (!fillColor || !light || !dark) {
    return TEXT_ON_SOLID_LIGHT;
  }
  return contrastRatio(fillColor, dark) >= contrastRatio(fillColor, light)
    ? TEXT_ON_SOLID_DARK
    : TEXT_ON_SOLID_LIGHT;
}

function linearChannel(channel: number): number {
  const value = channel / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}
