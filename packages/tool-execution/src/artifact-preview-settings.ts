import { DEFAULT_ARTIFACT_PREVIEW_SETTINGS_HASH } from "@vivd-catalyst/core";

const PREVIEW_IMAGES_SETTINGS_PREFIX = "preview-images-v1:";
const MAX_SELECTOR_VALUES = 40;

export interface ArtifactPreviewRenderSettings {
  pages?: number[];
  slides?: number[];
  sheets?: string[];
  ranges?: string[];
  maxImages?: number;
}

export function createArtifactPreviewSettingsHash(
  settings: ArtifactPreviewRenderSettings
): string {
  const normalized = normalizeArtifactPreviewRenderSettings(settings);
  if (
    !normalized.pages &&
    !normalized.slides &&
    !normalized.sheets &&
    !normalized.ranges &&
    !normalized.maxImages
  ) {
    return DEFAULT_ARTIFACT_PREVIEW_SETTINGS_HASH;
  }
  return `${PREVIEW_IMAGES_SETTINGS_PREFIX}${Buffer.from(
    JSON.stringify(normalized),
    "utf8"
  ).toString("base64url")}`;
}

export function readArtifactPreviewSettingsHash(settingsHash: string): ArtifactPreviewRenderSettings {
  if (!settingsHash.startsWith(PREVIEW_IMAGES_SETTINGS_PREFIX)) {
    return {};
  }
  try {
    const raw = Buffer.from(
      settingsHash.slice(PREVIEW_IMAGES_SETTINGS_PREFIX.length),
      "base64url"
    ).toString("utf8");
    const parsed = JSON.parse(raw) as unknown;
    return normalizeArtifactPreviewRenderSettings(isRecord(parsed) ? parsed : {});
  } catch {
    return {};
  }
}

function normalizeArtifactPreviewRenderSettings(
  input: ArtifactPreviewRenderSettings | Record<string, unknown>
): ArtifactPreviewRenderSettings {
  const pages = normalizePositiveIntegers(input.pages);
  const slides = normalizePositiveIntegers(input.slides);
  const sheets = normalizeStrings(input.sheets);
  const ranges = normalizeStrings(input.ranges);
  const maxImages = normalizePositiveInteger(input.maxImages);
  return {
    ...(pages.length > 0 ? { pages } : {}),
    ...(slides.length > 0 ? { slides } : {}),
    ...(sheets.length > 0 ? { sheets } : {}),
    ...(ranges.length > 0 ? { ranges } : {}),
    ...(maxImages ? { maxImages } : {})
  };
}

function normalizePositiveIntegers(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<number>();
  const result: number[] = [];
  for (const item of value) {
    const normalized = normalizePositiveInteger(item);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= MAX_SELECTOR_VALUES) {
      break;
    }
  }
  return result;
}

function normalizePositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function normalizeStrings(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }
    const normalized = item.trim();
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalized.slice(0, 160));
    if (result.length >= MAX_SELECTOR_VALUES) {
      break;
    }
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
