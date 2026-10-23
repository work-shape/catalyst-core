import {
  AppError,
  RESULT_SHAPER_NAME_PATTERN,
  connectionCallError,
  type JsonValue,
  type ResultShaper
} from "@work-shape/catalyst-core";

/** Snapshot the release's functions so every call uses the registry checked at startup. */
export function createResultShaperRegistry(
  shapers: Readonly<Record<string, ResultShaper>> = {}
): Readonly<Record<string, ResultShaper>> {
  for (const [name, shaper] of Object.entries(shapers)) {
    if (!RESULT_SHAPER_NAME_PATTERN.test(name) || typeof shaper !== "function") {
      throw new AppError("VALIDATION_FAILED", "Invalid result shaper registration");
    }
  }
  return Object.freeze({ ...shapers });
}

export function shapeResult(
  registry: Readonly<Record<string, ResultShaper>>,
  name: string,
  result: JsonValue
): JsonValue {
  try {
    const shaper = Object.hasOwn(registry, name) ? registry[name] : undefined;
    if (shaper === undefined) throw new Error("Unknown shaper");
    return shaper(result);
  } catch {
    // Never repeat the exception: it may contain response data or a credential.
    throw connectionCallError("output_invalid", "the result shaper failed");
  }
}
