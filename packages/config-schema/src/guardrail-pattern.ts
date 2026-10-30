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

/** A compiled pattern: whether it matches somewhere in the text, and how often. */
export interface GuardrailPattern {
  test(text: string): boolean;
  /**
   * How often it matches in the text, not overlapping, counting at most `max`. Each match
   * continues the scan where the one before ended, so the count reads the text once, as `test`.
   */
  count(text: string, max: number): number;
  /** The most characters of one field it reads, by the size of its program. */
  maxChars: number;
}

/**
 * Compiles a guardrail's pattern with RE2, which has no backreferences and no lookaround and
 * matches in linear time. With `checksum: luhn` a match counts only where its digits pass the
 * Luhn check and do not run on beyond it. Throws the reason it does not compile.
 */
export function compileGuardrailPattern(pattern: string, checksum?: "luhn"): GuardrailPattern {
  const compiled = RE2JS.compile(pattern);
  const count = (text: string, max: number): number => {
    const matcher = compiled.matcher(text);
    let found = 0;
    let from = 0;
    while (found < max && from <= text.length && matcher.find(from)) {
      const start = matcher.start();
      const end = matcher.end();
      if (checksum !== "luhn" || isCardNumber(text, start, end)) found += 1;
      // An empty match moves on by one, so the scan always ends.
      from = end > start ? end : end + 1;
    }
    return found;
  };
  return {
    test: (text) => (checksum ? count(text, 1) > 0 : compiled.matcher(text).find()),
    count,
    maxChars: Math.min(
      GUARDRAIL_CHECKED_FIELD_MAX_CHARS,
      Math.floor(GUARDRAIL_PATTERN_STEPS / compiled.programSize())
    )
  };
}

/** Payment card numbers have 13 to 19 digits. */
const CARD_DIGITS_MIN = 13;
const CARD_DIGITS_MAX = 19;

/**
 * Whether a match is a payment card number: 13 to 19 digits that pass the Luhn check, standing
 * alone. Digits that go on before or after it, joined by a space or a hyphen, or letters glued to
 * it, make it part of something longer, such as an IBAN or an account number.
 */
function isCardNumber(text: string, start: number, end: number): boolean {
  const digits = text.slice(start, end).replace(/[^0-9]/gu, "");
  if (digits.length < CARD_DIGITS_MIN || digits.length > CARD_DIGITS_MAX) return false;
  if (goesOn(text, start - 1, -1) || goesOn(text, end, 1)) return false;
  return passesLuhn(digits);
}

function goesOn(text: string, at: number, step: 1 | -1): boolean {
  const next = text[at];
  if (next === undefined) return false;
  if (/[0-9A-Za-z]/u.test(next)) return true;
  return (next === " " || next === "-") && /[0-9]/u.test(text[at + step] ?? "");
}

/** The Luhn checksum of payment card numbers. */
export function passesLuhn(digits: string): boolean {
  let sum = 0;
  for (let index = 0; index < digits.length; index += 1) {
    let digit = Number(digits[digits.length - 1 - index]);
    if (index % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
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
    ? `The pattern is too complex to check ${GUARDRAIL_PATTERN_MIN_READ_CHARS} characters in time; it reads ${compiled.maxChars}. Split it into several guardrails, or repeat less than in {1000}`
    : undefined;
}

/** Every string of a definition, keys and values, in document order, as a guardrail reads it. */
export function guardrailStringsOf(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(guardrailStringsOf);
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, entry]) => [key, ...guardrailStringsOf(entry)]);
  }
  return [];
}

/** The texts of one field joined, or `null` where they are more than a check reads. */
export function guardrailFieldOf(texts: readonly string[]): string | null {
  const text = texts.join("\n");
  return text.length > GUARDRAIL_CHECKED_FIELD_MAX_CHARS ? null : text;
}
