import { JSON_SCHEMA, YAMLException, load } from "js-yaml";

// The one reader of YAML that an author or an agent wrote: every file of an asset and every
// frontmatter goes through `readYamlData`, so its limits are set here and nowhere else. Files
// are measured in bytes by their own readers before they get here.

/**
 * How many values a YAML file holds once every alias is followed. It stops a file of a few
 * hundred bytes whose aliases expand to a billion values ("billion laughs"), which hung the
 * server on its first walk. The largest honest manifest holds a few thousand.
 */
export const YAML_DATA_MAX_VALUES = 100_000;

export type YamlDataIssueCode =
  "yaml_invalid" | "yaml_too_deep" | "yaml_too_large" | "text_invalid";

export interface YamlDataIssue {
  code: YamlDataIssueCode;
  /** One sentence that names the file. */
  message: string;
  /** The line of the file, from 1, where the reader stopped. */
  line?: number;
}

export type YamlDataResult = { ok: true; value: unknown } | { ok: false; issue: YamlDataIssue };

/**
 * Whether Postgres can store a text, in a `text` column or in `jsonb`: it holds neither a NUL
 * character nor half of a surrogate pair. With the `u` flag a whole pair is one code point, so
 * only half of one matches `\p{Surrogate}`.
 */
export function isStorableText(text: string): boolean {
  return !text.includes("\u0000") && !/\p{Surrogate}/u.test(text);
}

/**
 * Whether every text and key of a JSON-like value can be stored. It walks at most `maxValues`
 * values, a value reached twice counted twice, and answers `too_large` beyond that. It walks
 * without recursion, so no nesting ends it.
 */
export function checkStorableTexts(
  value: unknown,
  maxValues: number
): "storable" | "unstorable" | "too_large" {
  const pending: unknown[] = [value];
  for (let seen = 1; pending.length > 0; seen += 1) {
    if (seen > maxValues) return "too_large";
    const next = pending.pop();
    if (typeof next === "string") {
      if (!isStorableText(next)) return "unstorable";
    } else if (Array.isArray(next)) {
      pending.push(...next);
    } else if (typeof next === "object" && next !== null) {
      for (const [key, entry] of Object.entries(next)) {
        if (!isStorableText(key)) return "unstorable";
        pending.push(entry);
      }
    }
  }
  return "storable";
}

/**
 * Reads YAML that an author or an agent wrote as data: the schema knows JSON types alone and
 * builds nothing else. A file that does not parse, nests too deep, expands too far through its
 * aliases or holds text that cannot be stored is answered as an issue, never thrown.
 */
export function readYamlData(text: string, file: string): YamlDataResult {
  const fail = (code: YamlDataIssueCode, message: string, line?: number): YamlDataResult => ({
    ok: false,
    issue: { code, message, ...(line === undefined ? {} : { line }) }
  });
  let value: unknown;
  try {
    value = load(text, { schema: JSON_SCHEMA, filename: file });
  } catch (error) {
    if (error instanceof YAMLException) {
      // The reader stops at its own depth limit, 100 levels, before its recursion nears the
      // end of the stack.
      return error.reason.startsWith("nesting exceeded")
        ? fail("yaml_too_deep", `'${file}' ${error.reason}.`, error.mark.line + 1)
        : fail(
            "yaml_invalid",
            `'${file}' is not valid YAML: ${error.reason}.`,
            error.mark.line + 1
          );
    }
    throw error;
  }
  const texts = checkStorableTexts(value, YAML_DATA_MAX_VALUES);
  if (texts === "too_large") {
    return fail(
      "yaml_too_large",
      `'${file}' holds more than ${YAML_DATA_MAX_VALUES} values once its aliases are followed (YAML_DATA_MAX_VALUES).`
    );
  }
  if (texts === "unstorable") {
    return fail(
      "text_invalid",
      `'${file}' holds a NUL character or half of a surrogate pair, which cannot be stored.`
    );
  }
  return { ok: true, value };
}

/** A YAML file `loadYamlData` refused. `issue` says why. */
export class YamlDataError extends Error {
  readonly issue: YamlDataIssue;

  constructor(issue: YamlDataIssue) {
    super(issue.message);
    this.name = "YamlDataError";
    this.issue = issue;
  }
}

/** `readYamlData` for a caller that reports a refused file as an error: it throws `YamlDataError`. */
export function loadYamlData(text: string, file: string): unknown {
  const read = readYamlData(text, file);
  if (!read.ok) throw new YamlDataError(read.issue);
  return read.value;
}
