import type { JsonValue } from "./json";

/** Receives only the parsed answer, synchronously, before output checks. Keeps nothing. */
export type ResultShaper = (result: JsonValue) => JsonValue;

export const RESULT_SHAPER_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/u;
