import { matchesGlob } from "node:path";
import { describe, expect, it } from "vitest";
import { withinSource } from "@work-shape/catalyst-data-stores";
import { required } from "./support/assertions";

// An `exclude` of literal folders is decided by a set. Whatever the set answers, it answers what
// `matchesGlob` answers for the same pattern, tried with and without the path's leading slash.

const source = (exclude: string[]) => ({
  id: "source",
  connection: "connection",
  folders: ["root"],
  exclude
});

const excludedNow = (exclude: string[], path: string) =>
  !withinSource(source(exclude), { parents: ["root"], name: "file", path });

const excludedByGlob = (exclude: string[], path: string) =>
  exclude.some((pattern) => matchesGlob(path.slice(1), pattern) || matchesGlob(path, pattern));

const nfc = "Müller";
const nfd = "Müller";

describe("the exclude of a source", () => {
  it.each<[string, string, boolean, string]>([
    ["Old/**", "/Old/file.pdf", true, "directly below"],
    ["Old/**", "/Old/a/b/file.pdf", true, "nested"],
    ["/Old/**", "/Old/a/file.pdf", true, "the pattern's leading slash"],
    ["Parent/Old/**", "/Parent/Old/file.pdf", true, "a folder deeper down"],
    ["Old/**", "/Parent/Old/file.pdf", false, "the same name elsewhere"],
    ["Old/**", "/Old", false, "the folder itself"],
    ["/Old/**", "/Old", false, "the folder itself, with the slash"],
    ["Old/**", "/Old/", true, "the folder with a trailing slash"],
    ["Old/**", "/Older/file.pdf", false, "a folder that starts alike"],
    ["old/**", "/Old/file.pdf", false, "another case"],
    ["Ä/**", "/ä/file.pdf", false, "another case of an umlaut"],
    ["Old Projects/**", "/Old Projects/a b/file.pdf", true, "spaces"],
    [`${nfc}/**`, `/${nfc}/file.pdf`, true, "an umlaut"],
    [`${nfc}/**`, `/${nfd}/file.pdf`, false, "the same umlaut, decomposed"],
    ["Old/**", "/Old/.hidden", false, "a dot file below"],
    ["Old/**", "/Old/.hidden/file.pdf", false, "a dot folder below"],
    ["Old/**", "/Old/a/.hidden/file.pdf", false, "a dot folder further down"],
    [".git/**", "/.git/file", true, "a dot folder the pattern names"],
    ["Old/.git/**", "/Old/.git/file", true, "a dot folder the pattern names, deeper"],
    ["Old/**", "/Old//file.pdf", true, "an empty segment"],
    ["Old/**", "/Other/../Old/file.pdf", true, "a parent segment"],
    ["Old/**", "/Old/./file.pdf", true, "a current segment"],
    ["Old/**", "/./Old/file.pdf", false, "a current segment first, without the slash"],
    ["/Old/**", "/./Old/file.pdf", true, "a current segment first, with the slash"],
    ["Old/../New/**", "/New/file.pdf", true, "a parent segment in the pattern"],
    ["P (2019)/**", "/P (2019)/file.pdf", true, "parentheses"],
    ["a+b/**", "/a+b/file.pdf", true, "a plus"],
    ["a@b, c/**", "/a@b, c/file.pdf", true, "an at and a comma"],
    ["!a/**", "/!a/file.pdf", true, "a leading exclamation mark"],
    ["#a/**", "/#a/file.pdf", true, "a leading hash"],
    ["P [a]/**", "/P [a]/file.pdf", false, "brackets are a class"],
    ["P [a]/**", "/P a/file.pdf", true, "the class matches its letter"],
    ["a*/**", "/a*/file.pdf", true, "a star matches itself"],
    ["a*/**", "/ab/file.pdf", true, "a star matches more"],
    ["a?/**", "/ab/file.pdf", true, "a question mark"],
    ["{a,b}/**", "/b/file.pdf", true, "braces"],
    ["+(a)/**", "/aa/file.pdf", true, "an extglob"],
    ["a\\b/**", "/a/b/file.pdf", true, "a backslash is a separator"],
    ["**/Personal/**", "/a/Personal/file.pdf", true, "a glob before the folder"],
    ["/**", "/file.pdf", true, "everything"],
    ["Old/*", "/Old/a/file.pdf", false, "one level"],
    ["Old/**/", "/Old/a/file.pdf", false, "a trailing slash on the pattern"],
    ["Old", "/Old/file.pdf", false, "no glob at all"]
  ])("%s on %s is %s: %s", (pattern, path, expected) => {
    expect(excludedByGlob([pattern], path)).toBe(expected);
    expect(excludedNow([pattern], path)).toBe(expected);
    expect(excludedNow(["Unrelated/**", pattern, "Elsewhere/**"], path)).toBe(expected);
  });

  it("answers what matchesGlob answers, over generated patterns and paths", () => {
    const segments = [
      "A",
      "a",
      "Old Projects",
      nfc,
      nfd,
      "Ä",
      "ä",
      "日本",
      ".hidden",
      "..x",
      ".",
      "..",
      "",
      "P (2019)",
      "P [a]",
      "x*",
      "x?",
      "{a,b}",
      "{a}",
      "a,b",
      "+(a)",
      "@(a)",
      "!(a)",
      "!a",
      "#a",
      "a+b",
      "a|b",
      "a\\b",
      "]",
      ")"
    ];
    let state = 20_261_109;
    const pick = <Item>(items: readonly Item[]): Item => {
      state = (state * 48_271) % 2_147_483_647;
      return required(items[state % items.length]);
    };
    const walk = (length: number) => Array.from({ length }, () => pick(segments)).join("/");
    const seen = { excluded: 0, kept: 0 };
    for (let round = 0; round < 40_000; round += 1) {
      const folder = walk(1 + (round % 3));
      const pattern = `${pick(["", "", "/"])}${folder}${pick(["/**", "/**", "/**", "/*", "/**/", ""])}`;
      // Most paths start at the folder of the pattern, so that the answers are not all "kept".
      const below = walk(round % 4);
      const path = `/${pick([folder, folder, folder, walk(2)])}${below === "" ? "" : `/${below}`}`;
      const expected = excludedByGlob([pattern], path);
      seen[expected ? "excluded" : "kept"] += 1;
      expect({ pattern, path, excluded: excludedNow([pattern], path) }).toEqual({
        pattern,
        path,
        excluded: expected
      });
    }
    expect(seen.excluded).toBeGreaterThan(1_000);
    expect(seen.kept).toBeGreaterThan(1_000);
  });

  it("holds 500 literal folders without a pass over every pattern per item", () => {
    const exclude = Array.from({ length: 500 }, (_, index) => `Parent/Old ${index}/**`);
    const items = Array.from({ length: 76_000 }, (_, index) => ({
      parents: ["root"],
      name: "file.pdf",
      path: `/Parent/${index % 2 === 0 ? "Old" : "New"} ${index % 500}/Plans/file.pdf`
    }));
    const compiled = source(exclude);
    const started = performance.now();
    const kept = items.filter((item) => withinSource(compiled, item)).length;
    // Far above the fast path's tens of milliseconds, far below the minutes of matchesGlob.
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(kept).toBe(38_000);
  });
});
