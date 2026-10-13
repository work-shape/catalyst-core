import { RE2JS } from "re2js";

/**
 * The longest pattern a guardrail may have. Ten personal-data patterns joined by `|` fit; a
 * longer one is refused at start with this name.
 */
export const GUARDRAIL_PATTERN_MAX_CHARS = 2_000;

/**
 * The most text a pattern reads of one field. RE2 matches in time linear in the text, so this
 * bounds the time of a check. A longer field is not read in part: a guardrail that blocks or
 * holds answers as on a match, one that warns as not evaluated.
 */
export const GUARDRAIL_CHECKED_FIELD_MAX_CHARS = 2 * 1024 * 1024;

/** A compiled pattern: whether it matches somewhere in the text. */
export interface GuardrailPattern {
  test(text: string): boolean;
}

/**
 * Compiles a guardrail's pattern with RE2, which has no backreferences and no lookaround and
 * matches in linear time, so no pattern can hold the server. Throws the reason it does not
 * compile.
 */
export function compileGuardrailPattern(pattern: string): GuardrailPattern {
  const compiled = RE2JS.compile(pattern);
  return { test: (text) => compiled.matcher(text).find() };
}

/** Why a pattern does not compile, or undefined where it does. */
export function guardrailPatternError(pattern: string): string | undefined {
  try {
    compileGuardrailPattern(pattern);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
