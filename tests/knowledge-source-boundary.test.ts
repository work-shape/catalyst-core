import { describe, expect, it } from "vitest";
import { sourceExcludesFolder, withinSource } from "@work-shape/catalyst-data-stores";
import { required } from "./support/assertions";

// The pattern rule of a source's `include` and `exclude` (spec: Synced sources, "The shape"):
// segments split at `/`; `**` any number of segments, at the end at least one; `*` any
// characters in a segment, `?` one; every other character itself, compared in Unicode NFC. A
// literal `<folder>/**` is
// decided by a set, every other pattern by an expression; both answer what the rule says.

const source = (exclude: string[], include?: string[]) => ({
  id: "source",
  connection: "connection",
  folders: ["root"],
  exclude,
  ...(include ? { include } : {})
});

const excludedNow = (exclude: string[], path: string) =>
  !withinSource(source(exclude), { parents: ["root"], name: "file", path });

/** The rule as the spec writes it, one segment and one character at a time. */
function excludedByRule(pattern: string, path: string): boolean {
  const segmentsOf = (text: string) => {
    const segments: string[] = [];
    for (const segment of text.normalize("NFC").split("/"))
      if (segment === "..") segments.pop();
      else if (segment !== "" && segment !== ".") segments.push(segment);
    return segments;
  };
  const wanted = segmentsOf(pattern).filter(
    (segment, index, all) => !(segment === "**" && all[index - 1] === "**")
  );
  const given = segmentsOf(path);
  if (!given.length) return false;
  const segmentMatches = (pattern: string[], name: string[], i = 0, j = 0): boolean => {
    if (i === pattern.length) return j === name.length;
    if (pattern[i] === "*")
      return (
        segmentMatches(pattern, name, i + 1, j) ||
        (j < name.length && segmentMatches(pattern, name, i, j + 1))
      );
    return (
      j < name.length &&
      (pattern[i] === "?" || pattern[i] === name[j]) &&
      segmentMatches(pattern, name, i + 1, j + 1)
    );
  };
  const matches = (i: number, j: number): boolean => {
    if (i === wanted.length) return j === given.length;
    if (wanted[i] === "**") {
      if (i === wanted.length - 1) return j < given.length;
      for (let k = j; k <= given.length; k++) if (matches(i + 1, k)) return true;
      return false;
    }
    return (
      j < given.length &&
      segmentMatches([...required(wanted[i])], [...required(given[j])]) &&
      matches(i + 1, j + 1)
    );
  };
  return matches(0, 0);
}

const nfc = "M\u00fcller";
const nfd = "Mu\u0308ller";

describe("the exclude of a source", () => {
  it.each<[string, string, boolean, string]>([
    ["Old/**", "/Old/file.pdf", true, "directly below"],
    ["Old/**", "/Old/a/b/file.pdf", true, "nested"],
    ["/Old/**", "/Old/a/file.pdf", true, "the pattern's leading slash"],
    ["Parent/Old/**", "/Parent/Old/file.pdf", true, "a folder deeper down"],
    ["Old/**", "/Parent/Old/file.pdf", false, "the same name elsewhere"],
    ["Old/**", "/Old", false, "the folder itself"],
    ["/Old/**", "/Old", false, "the folder itself, with the slash"],
    ["Old/**", "/Old/", false, "the folder with a trailing slash"],
    ["Old/**", "/Older/file.pdf", false, "a folder that starts alike"],
    ["old/**", "/Old/file.pdf", false, "another case"],
    ["Ä/**", "/ä/file.pdf", false, "another case of an umlaut"],
    ["Old Projects/**", "/Old Projects/a b/file.pdf", true, "spaces"],
    [`${nfc}/**`, `/${nfc}/file.pdf`, true, "an umlaut"],
    [`${nfc}/**`, `/${nfd}/file.pdf`, true, "the same umlaut, decomposed in the path"],
    [`${nfd}/**`, `/${nfc}/file.pdf`, true, "the same umlaut, decomposed in the pattern"],
    [`${nfd}*/**`, `/${nfc} 2019/file.pdf`, true, "a decomposed umlaut beside a star"],
    ["a?/**", "/au\u0308/file.pdf", true, "a question mark is one decomposed umlaut"],
    ["Old/**", "/Old/.hidden", true, "a dot file below"],
    ["Old/**", "/Old/.hidden/file.pdf", true, "a dot folder below"],
    ["Old/**", "/Old/a/.hidden/file.pdf", true, "a dot folder further down"],
    ["**/Personal/**", "/a/.b/Personal/.c/file", true, "dot folders around a glob"],
    [".git/**", "/.git/file", true, "a dot folder the pattern names"],
    ["Old/.git/**", "/Old/.git/file", true, "a dot folder the pattern names, deeper"],
    ["Old/**", "/Old//file.pdf", true, "an empty segment"],
    ["Old/**", "/Other/../Old/file.pdf", true, "a parent segment"],
    ["Old/**", "/Old/./file.pdf", true, "a current segment"],
    ["Old/**", "/./Old/file.pdf", true, "a current segment first"],
    ["Old/../New/**", "/New/file.pdf", true, "a parent segment in the pattern"],
    ["Projekt [alt]/**", "/Projekt [alt]/Plan.pdf", true, "brackets are themselves"],
    ["Projekt [alt]/**", "/Projekt a/Plan.pdf", false, "brackets are no class"],
    ["P [a]*/**", "/P [a] 2019/file.pdf", true, "brackets beside a star"],
    ["P (2019)/**", "/P (2019)/file.pdf", true, "parentheses"],
    ["a+b/**", "/a+b/file.pdf", true, "a plus"],
    ["a@b, c/**", "/a@b, c/file.pdf", true, "an at and a comma"],
    ["!a/**", "/!a/file.pdf", true, "a leading exclamation mark"],
    ["#a/**", "/#a/file.pdf", true, "a leading hash"],
    ["{a,b}/**", "/{a,b}/file.pdf", true, "braces are themselves"],
    ["{a,b}/**", "/b/file.pdf", false, "braces are no alternation"],
    ["+(a)/**", "/+(a)/file.pdf", true, "an extglob is itself"],
    ["a\\b/**", "/a\\b/file.pdf", true, "a backslash is itself"],
    ["a\\b/**", "/a/b/file.pdf", false, "a backslash is no separator"],
    ["a.b$^|/**", "/a.b$^|/file.pdf", true, "expression syntax is itself"],
    ["a*/**", "/a*/file.pdf", true, "a star matches itself"],
    ["a*/**", "/ab/file.pdf", true, "a star matches more"],
    ["a*/**", "/a/b/file.pdf", true, "a star matches nothing"],
    ["a**b/**", "/axyb/file.pdf", true, "a double star inside a name is a star"],
    ["a**b/**", "/ax/yb/file.pdf", false, "a double star inside a name stays in it"],
    ["a?/**", "/ab/file.pdf", true, "a question mark"],
    ["a?/**", "/a/file.pdf", false, "a question mark is one character"],
    ["a?/**", "/aä/file.pdf", true, "a question mark is one umlaut"],
    ["**/Personal/**", "/a/Personal/file.pdf", true, "a glob before the folder"],
    ["**/Personal/**", "/Personal/file.pdf", true, "a glob of no segment"],
    ["a/**/b/**", "/a/b/file.pdf", true, "a middle glob of no segment"],
    ["a/**/b/**", "/a/x/y/b/file.pdf", true, "a middle glob of two segments"],
    ["**/*.tmp", "/a/.x.tmp", true, "a star before a dot"],
    ["/**", "/file.pdf", true, "everything"],
    ["Old/*", "/Old/a/file.pdf", false, "one level"],
    ["Old/*", "/Old/file.pdf", true, "one level, a file"],
    ["Old/**/", "/Old/a/file.pdf", true, "a trailing slash on the pattern"],
    ["Old", "/Old/file.pdf", false, "no glob at all"],
    ["Old", "/Old", true, "no glob, a file of that name"]
  ])("%s on %s is %s: %s", (pattern, path, expected) => {
    expect(excludedByRule(pattern, path)).toBe(expected);
    expect(excludedNow([pattern], path)).toBe(expected);
    expect(excludedNow(["Unrelated/**", pattern, "Else*/**"], path)).toBe(expected);
  });

  it("answers what the rule answers, over generated patterns and paths", () => {
    const segments = [
      "A",
      "a",
      "Old Projects",
      nfc,
      nfd,
      "ä",
      "日本",
      ".hidden",
      ".",
      "..",
      "",
      "P (2019)",
      "P [a]",
      "[a]",
      "x*",
      "*x",
      "*",
      "x?",
      "?",
      "**",
      "{a,b}",
      "+(a)",
      "!a",
      "a\\b",
      "a.b",
      "]",
      ")"
    ];
    let state = 20_261_110;
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
      const expected = excludedByRule(pattern, path);
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
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(kept).toBe(38_000);
  });

  it("reads include on the file name by the same rule", () => {
    const kept = (include: string[], name: string) =>
      withinSource(source(["Unrelated/**"], include), {
        parents: ["root"],
        name,
        path: `/${name}`
      });
    expect(kept(["*.pdf"], "Plan.pdf")).toBe(true);
    expect(kept(["*.pdf"], "Plan.PDF")).toBe(false);
    expect(kept(["Plan [1].pdf"], "Plan [1].pdf")).toBe(true);
    expect(kept(["Plan [1].pdf"], "Plan 1.pdf")).toBe(false);
    expect(kept(["*.{pdf,docx}"], "Plan.pdf")).toBe(false);
    expect(kept(["**"], "Plan.pdf")).toBe(true);
    expect(kept(["/**", "*.docx"], "Plan.pdf")).toBe(true);
    expect(kept(["Old/**"], "Plan.pdf")).toBe(false);
    expect(kept([`${nfc}*.pdf`], `${nfd} Plan.pdf`)).toBe(true);
    expect(kept([`${nfd}*.pdf`], `${nfc} Plan.pdf`)).toBe(true);
  });
});

describe("the folders a listing need not walk", () => {
  it("names a folder an exclude leaves out with everything below it, and no other", () => {
    const skips = required(
      sourceExcludesFolder(
        source(["Projekte/Projekt [alt]/**", "**/Personal/**", "Archiv*/**", "**/*.tmp", "Old/*"])
      )
    );
    expect(skips("/Projekte/Projekt [alt]")).toBe(true);
    expect(skips("/Projekte/Projekt [alt]/.git")).toBe(true);
    expect(skips("/Projekte/Projekt a")).toBe(false);
    expect(skips("/Projekte")).toBe(false);
    expect(skips("/a/Personal")).toBe(true);
    expect(skips("/Personal/b")).toBe(true);
    expect(skips("/Archiv 2019")).toBe(true);
    expect(skips("/Archiv")).toBe(true);
    // A pattern that leaves out files, or one level, leaves some of the folder in.
    expect(skips("/x.tmp")).toBe(false);
    expect(skips("/Old")).toBe(false);
    expect(skips("/Old/a")).toBe(false);
    expect(skips("/")).toBe(false);
    expect(sourceExcludesFolder({ id: "s", connection: "c", folders: ["root"] })).toBeUndefined();
    expect(required(sourceExcludesFolder(source(["/**"])))("/a")).toBe(true);
    // A folder name in another Unicode form is the same folder.
    expect(required(sourceExcludesFolder(source([`${nfc}/**`])))(`/${nfd}`)).toBe(true);
    expect(required(sourceExcludesFolder(source([`**/${nfd}/**`])))(`/a/${nfc}`)).toBe(true);
  });

  it("names only folders whose every path below is excluded, over generated patterns", () => {
    const names = ["A", "a", ".git", "P [a]", "x*", "*", "?", "**", "{a,b}", "Personal"];
    let state = 7_919;
    const pick = <Item>(items: readonly Item[]): Item => {
      state = (state * 48_271) % 2_147_483_647;
      return required(items[state % items.length]);
    };
    const plain = ["A", "a", ".git", "P [a]", "xy", "Personal", "b"];
    let named = 0;
    for (let round = 0; round < 5_000; round += 1) {
      const pattern = Array.from({ length: 1 + (round % 3) }, () => pick(names)).join("/");
      const exclude = [`${pattern}${pick(["/**", "/**", ""])}`];
      const skips = required(sourceExcludesFolder(source(exclude)));
      const folder = `/${Array.from({ length: 1 + (round % 3) }, () => pick(plain)).join("/")}`;
      if (!skips(folder)) continue;
      named += 1;
      for (const below of ["f.pdf", ".hidden", "a/.b/c.pdf", "P [a]/x"])
        expect({ exclude, path: `${folder}/${below}`, excluded: true }).toEqual({
          exclude,
          path: `${folder}/${below}`,
          excluded: excludedNow(exclude, `${folder}/${below}`)
        });
    }
    expect(named).toBeGreaterThan(200);
  });
});
