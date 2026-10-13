import { RE2JS } from "re2js";

/**
 * The longest pattern a guardrail may have. Ten personal-data patterns joined by `|` fit; a
 * longer one is refused at start with this name.
 */
export const GUARDRAIL_PATTERN_MAX_CHARS = 2_000;

/**
 * The most text a check reads of one field. A longer field is not read in part: a guardrail
 * that blocks or holds answers as on a match, one that warns as not evaluated.
 */
export const GUARDRAIL_CHECKED_FIELD_MAX_CHARS = 2 * 1024 * 1024;

/**
 * The work one pattern may do on one field: the size of its compiled program times the
 * characters it reads. RE2 is linear in the text, but each character costs up to the program's
 * size, and the match runs on the server's one thread: at about 12 ns per step, as measured on
 * the slowest case, a check holds it for half a second at most. A larger program reads less.
 */
const GUARDRAIL_PATTERN_STEPS = 40_000_000;

/**
 * The least text a pattern must be able to read: a skill or a page of an App. A pattern whose
 * program is so large that it would read less is refused at start.
 */
const GUARDRAIL_PATTERN_MIN_READ_CHARS = 64 * 1024;

/** A compiled pattern: whether it matches somewhere in the text. */
export interface GuardrailPattern {
  test(text: string): boolean;
  /** The most characters of one field it reads, by the size of its program. */
  maxChars: number;
}

/**
 * Compiles a guardrail's pattern with RE2, which has no backreferences and no lookaround and
 * matches in linear time. Throws the reason it does not compile.
 */
export function compileGuardrailPattern(pattern: string): GuardrailPattern {
  const compiled = RE2JS.compile(pattern);
  return {
    test: (text) => compiled.matcher(text).find(),
    maxChars: Math.min(
      GUARDRAIL_CHECKED_FIELD_MAX_CHARS,
      Math.floor(GUARDRAIL_PATTERN_STEPS / compiled.programSize())
    )
  };
}

/** Why a pattern does not compile or reads too little, or undefined where it does neither. */
export function guardrailPatternError(pattern: string): string | undefined {
  let compiled: GuardrailPattern;
  try {
    compiled = compileGuardrailPattern(pattern);
  } catch (error) {
    return `The pattern is no RE2 expression, which has no backreferences and no lookaround: ${error instanceof Error ? error.message : String(error)}`;
  }
  return compiled.maxChars < GUARDRAIL_PATTERN_MIN_READ_CHARS
    ? `The pattern is too complex to check ${GUARDRAIL_PATTERN_MIN_READ_CHARS} characters in time; it reads ${compiled.maxChars}. Split it into several guardrails or use fewer and smaller repetitions such as {1,1000}`
    : undefined;
}
