// One set of hostile documents that every reader of untrusted input is run through. Each reader
// answers each document with a refusal that names the problem, within `HOSTILE_INPUT_BOUND_MS`:
// never a hang, a crash or a 500. The platform's readers are in `tests/hostile-input.test.ts`,
// the document pipeline's in `capabilities/tests/hostile-documents.test.ts`.

/** How long a reader may take to refuse one hostile document. */
const HOSTILE_INPUT_BOUND_MS = 2_000;

const text = (value: string) => new TextEncoder().encode(value);

/** A YAML file whose aliases expand ten times at each of nine levels: a billion values. */
function aliasBomb(): string {
  const lines = [`a0: &a0 [${Array.from({ length: 10 }, () => '"lol"').join(", ")}]`];
  for (let level = 1; level < 10; level += 1) {
    lines.push(
      `a${level}: &a${level} [${Array.from({ length: 10 }, () => `*a${level - 1}`).join(", ")}]`
    );
  }
  return `${lines.join("\n")}\n`;
}

export interface HostileDocument {
  name: string;
  bytes: Uint8Array;
}

/**
 * The documents as bytes, so a file that is no UTF-8 is one of them. A YAML reader gets each
 * as the whole file, or as the frontmatter of a Markdown file. The YAML escapes `\0` and
 * `\uD800` parse, and give a text Postgres cannot store.
 */
export const hostileDocuments: readonly HostileDocument[] = [
  { name: "alias bomb", bytes: text(aliasBomb()) },
  { name: "deeply nested", bytes: text(`id: ${"[".repeat(5_000)}${"]".repeat(5_000)}\n`) },
  { name: "does not parse", bytes: text("id: [unclosed\n  name: : :\n") },
  { name: "huge single line", bytes: text(`id: ${"x".repeat(4 * 1024 * 1024)}`) },
  { name: "invalid UTF-8", bytes: new Uint8Array([0x69, 0x64, 0x3a, 0x20, 0xff, 0xfe, 0x80]) },
  { name: "NUL byte", bytes: text("id: a\u0000b\n") },
  { name: "NUL escape", bytes: text('id: "a\\0b"\n') },
  { name: "lone surrogate escape", bytes: text('id: "a\\uD800b"\n') }
];

/**
 * Hostile values a JSON body carries: escapes JSON allows and Postgres cannot store, a nesting
 * deeper than any reader recurses, and a string larger than any field holds.
 */
export const hostileJsonStrings: readonly { name: string; value: string }[] = [
  { name: "NUL character", value: "before\u0000after" },
  { name: "lone high surrogate", value: "before\uD800after" },
  { name: "lone low surrogate", value: "before\uDC00after" }
];

/** Runs `read`, and fails when it took longer than the bound. */
export async function withinBound<T>(name: string, read: () => Promise<T> | T): Promise<T> {
  const started = performance.now();
  const result = await read();
  const elapsed = performance.now() - started;
  if (elapsed > HOSTILE_INPUT_BOUND_MS) {
    throw new Error(`'${name}' took ${Math.round(elapsed)} ms, over ${HOSTILE_INPUT_BOUND_MS} ms`);
  }
  return result;
}
