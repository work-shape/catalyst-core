import { describe, expect, it } from "vitest";
import {
  canToggle,
  excludedFolders,
  excludeToStore,
  folderState,
  selectionSummary,
  toggleFolder,
  withExcludedFolders,
  withFolderNames,
  withFolderPath,
  withFolderUnread,
  type FolderSelection
} from "@work-shape/catalyst-chat-ui/build-area";

// The selection of the folder chooser (KB-FOLDERS-1): which folders a source reads, which it
// leaves out below them, and how a folder's box stands. A folder left out is an `exclude`
// pattern that names exactly it.

const projects = { id: "10", path: ["Projekte"] };
const archive = { id: "11", path: ["Projekte", "Archiv"] };
const old = { id: "12", path: ["Projekte", "Archiv", "2019"] };
const houseA = { id: "13", path: ["Projekte", "Haus A"] };
const contracts = { id: "20", path: ["Verträge"] };

const none: FolderSelection = { chosen: new Map(), excluded: [] };
const chosen = (selection: FolderSelection) => [...selection.chosen.keys()];

describe("the folders a source's exclude leaves out", () => {
  it("reads the patterns that name exactly one folder", () => {
    expect(
      excludedFolders("Archiv/**\n**/*.tmp\n/2019/Alt/**\nEntw*/**\n**/Alt/**\nArchiv/**\n/**")
    ).toEqual(["Archiv", "2019/Alt"]);
  });

  it("writes them back among the other patterns, which stay as typed", () => {
    expect(withExcludedFolders("**/*.tmp\nArchiv/**\nAlt/**", ["Archiv", "Haus A/Entwurf"])).toBe(
      "**/*.tmp\nArchiv/**\nHaus A/Entwurf/**"
    );
    expect(withExcludedFolders("Archiv/**", [])).toBe("");
  });
});

describe("a folder's box in the chooser", () => {
  it("is ticked for a chosen folder and for each folder below it", () => {
    const selection = toggleFolder(none, projects, true);
    expect(chosen(selection)).toEqual(["10"]);
    expect(folderState(selection, projects)).toEqual({ state: "in", without: [] });
    expect(folderState(selection, houseA)).toEqual({
      state: "in",
      under: "Projekte",
      without: []
    });
    expect(folderState(selection, contracts)).toEqual({ state: "none", below: 0 });
  });

  it("leaves a folder below a chosen one out by a pattern, and the parent reads as partly chosen", () => {
    const selection = toggleFolder(toggleFolder(none, projects, true), archive, false);
    // The boundary stays the parent: a folder added below it later is read.
    expect(chosen(selection)).toEqual(["10"]);
    expect(selection.excluded).toEqual(["Archiv"]);
    expect(folderState(selection, projects)).toEqual({ state: "in", without: ["Archiv"] });
    expect(folderState(selection, archive)).toEqual({ state: "out", under: "Projekte" });
    expect(folderState(selection, old)).toEqual({ state: "outAbove", with: "Archiv" });
    expect(folderState(selection, houseA).state).toBe("in");
    expect(selectionSummary(selection)).toEqual({ folders: ["Projekte"], excluded: ["Archiv"] });
    // A folder left out with the one above it cannot be ticked by itself.
    expect(toggleFolder(selection, old, true)).toBe(selection);
  });

  it("reads a folder again once it is ticked, and a parent whole once it is", () => {
    const partly = toggleFolder(toggleFolder(none, projects, true), archive, false);
    expect(toggleFolder(partly, archive, true).excluded).toEqual([]);
    const deeper = toggleFolder(partly, { id: "14", path: ["Projekte", "Haus A", "Alt"] }, false);
    expect(deeper.excluded).toEqual(["Archiv", "Haus A/Alt"]);
    expect(folderState(deeper, houseA)).toEqual({
      state: "in",
      under: "Projekte",
      without: ["Alt"]
    });
    expect(toggleFolder(deeper, houseA, true).excluded).toEqual(["Archiv"]);
    expect(toggleFolder(deeper, projects, true).excluded).toEqual([]);
    // A folder left out takes the patterns below it with it.
    expect(toggleFolder(deeper, houseA, false).excluded).toEqual(["Archiv", "Haus A"]);
  });

  it("says of a folder that is not chosen how many below it are", () => {
    const selection = toggleFolder(none, houseA, true);
    expect(folderState(selection, projects)).toEqual({ state: "none", below: 1 });
    // Ticking the parent reads the folder with it, so the boundary names the parent alone.
    expect(chosen(toggleFolder(selection, projects, true))).toEqual(["10"]);
  });

  it("drops the folders left out with the last chosen folder", () => {
    const partly = toggleFolder(toggleFolder(none, projects, true), archive, false);
    const emptied = toggleFolder(partly, projects, false);
    expect(chosen(emptied)).toEqual([]);
    expect(emptied.excluded).toEqual([]);
  });

  it("drops what it left out below a parent when that parent goes, and only that", () => {
    const two = toggleFolder(
      toggleFolder(toggleFolder(none, projects, true), archive, false),
      contracts,
      true
    );
    const left = toggleFolder(two, projects, false);
    expect(chosen(left)).toEqual(["20"]);
    expect(left.excluded).toEqual([]);
    // A parent that stays and holds a folder of that path keeps the rule, as the chooser said.
    const both = withFolderNames(two, "20", ["Archiv"], true);
    const kept = toggleFolder(both, projects, false);
    expect(kept.excluded).toEqual(["Archiv"]);
    expect(toggleFolder(kept, contracts, false).excluded).toEqual([]);
  });

  it("places a folder chosen before once its path is read", () => {
    const before: FolderSelection = { chosen: new Map([["10", undefined]]), excluded: ["Archiv"] };
    expect(folderState(before, archive)).toEqual({ state: "none", below: 0 });
    const placed = withFolderPath(before, "10", ["Projekte"]);
    expect(folderState(placed, archive)).toEqual({ state: "out", under: "Projekte" });
    expect(selectionSummary(before).folders).toEqual(["10"]);
  });

  it("keeps a folder whose name no pattern can write", () => {
    const selection = toggleFolder(none, projects, true);
    const starred = { id: "15", path: ["Projekte", "Was?"] };
    expect(toggleFolder(selection, starred, false).excluded).toEqual([]);
  });
});

describe("rules the chooser did not write", () => {
  const saved = (rules: string[]): FolderSelection => ({
    chosen: new Map([["10", ["Projekte"]]]),
    excluded: rules
  });

  it("keeps them when a parent goes or is ticked whole", () => {
    expect(toggleFolder(saved(["Handarbeit"]), projects, false).excluded).toEqual(["Handarbeit"]);
    const known = withFolderNames(saved(["Handarbeit"]), "10", ["Handarbeit"], true);
    expect(folderState(known, projects)).toEqual({ state: "in", without: ["Handarbeit"] });
    // The parent cannot be made whole by removing them, so the click takes it out instead.
    const out = toggleFolder(known, projects, true);
    expect(chosen(out)).toEqual([]);
    expect(out.excluded).toEqual(["Handarbeit"]);
  });

  it("clears only its own below a parent ticked whole", () => {
    const known = withFolderNames(saved(["Handarbeit"]), "10", ["Handarbeit", "Archiv"], true);
    const mixed = toggleFolder(known, archive, false);
    expect(mixed.excluded).toEqual(["Handarbeit", "Archiv"]);
    expect(toggleFolder(mixed, projects, true).excluded).toEqual(["Handarbeit"]);
  });

  it("removes one when its own folder is ticked, as the person asked for that folder", () => {
    expect(toggleFolder(saved(["Archiv"]), archive, true).excluded).toEqual([]);
  });

  it("leaves them in the stored text, whatever else changes", () => {
    const text = "Handarbeit/**\n/Alt/2019/**\nHandarbeit/**\n**/*.tmp";
    expect(withExcludedFolders(text, ["Handarbeit", "Alt/2019", "Neu"])).toBe(`${text}\nNeu/**`);
  });
});

describe("ticking a folder above a chosen one", () => {
  const inner = () =>
    toggleFolder(
      toggleFolder(none, houseA, true),
      { id: "14", path: ["Projekte", "Haus A", "Alt"] },
      false
    );

  it("writes what was left out again from the new folder", () => {
    const selection = inner();
    expect(selection.excluded).toEqual(["Alt"]);
    const parent = toggleFolder(selection, projects, true);
    expect(chosen(parent)).toEqual(["10"]);
    expect(parent.excluded).toEqual(["Haus A/Alt"]);
    expect(folderState(parent, houseA)).toEqual({
      state: "in",
      under: "Projekte",
      without: ["Alt"]
    });
  });

  it("drops a rule that does not fall under the folder it replaces", () => {
    const selection = withFolderNames(
      { chosen: new Map([["13", houseA.path]]), excluded: ["Fremd"] },
      "13",
      ["Plaene"],
      true
    );
    expect(toggleFolder(selection, projects, true).excluded).toEqual(["Fremd"]);
  });

  it("keeps a rule of another chosen folder as it is", () => {
    const other = toggleFolder(inner(), contracts, true);
    const parent = toggleFolder(withFolderNames(other, "20", ["Alt"], true), projects, true);
    expect(parent.excluded).toEqual(["Alt", "Haus A/Alt"]);
  });

  it("does not take a folder whose rule a pattern could not write", () => {
    const starred = { id: "16", path: ["Projekte", "Was?"] };
    const selection = withFolderNames(
      { chosen: new Map([["16", starred.path]]), excluded: ["Alt"] },
      "16",
      ["Alt"],
      true
    );
    expect(canToggle(selection, projects)).toBe(false);
    expect(toggleFolder(selection, projects, true)).toBe(selection);
  });
});

describe("the partial state of a chosen folder", () => {
  it("shows only on the chosen folder a rule falls under", () => {
    const two = toggleFolder(
      toggleFolder(toggleFolder(none, projects, true), archive, false),
      contracts,
      true
    );
    expect(folderState(two, projects)).toEqual({ state: "in", without: ["Archiv"] });
    expect(folderState(two, contracts)).toEqual({ state: "in", without: [] });
  });

  it("places a saved rule by what the folder holds, and says nothing while that is unknown", () => {
    const saved: FolderSelection = {
      chosen: new Map([
        ["10", projects.path],
        ["20", contracts.path]
      ]),
      excluded: ["Archiv"]
    };
    expect(folderState(saved, projects)).toEqual({ state: "in", without: [] });
    const read = withFolderNames(
      withFolderNames(saved, "10", ["Archiv", "Haus A"], true),
      "20",
      ["Muster"],
      true
    );
    expect(folderState(read, projects)).toEqual({ state: "in", without: ["Archiv"] });
    expect(folderState(read, contracts)).toEqual({ state: "in", without: [] });
  });
});

describe("folder names in another case", () => {
  const lower = { id: "11", path: ["projekte", "ARCHIV"] };

  it("places a folder below a chosen one whatever the case of its path", () => {
    const selection = toggleFolder(none, projects, true);
    expect(folderState(selection, lower).state).toBe("in");
  });

  it("reads a rule in another case as the same folder, and adds no second one", () => {
    const selection: FolderSelection = {
      chosen: new Map([["10", ["Projekte"]]]),
      excluded: ["archiv"]
    };
    expect(folderState(selection, archive)).toEqual({ state: "out", under: "Projekte" });
    expect(folderState(selection, old)).toEqual({ state: "outAbove", with: "archiv" });
    expect(toggleFolder(selection, archive, true).excluded).toEqual([]);
    expect(excludedFolders("Archiv/**\narchiv/**")).toEqual(["Archiv"]);
    // Reading it again takes every spelling of the rule.
    expect(withExcludedFolders("Archiv/**\narchiv/**\n**/*.tmp", [])).toBe("**/*.tmp");
    expect(withExcludedFolders("archiv/**", ["Archiv"])).toBe("archiv/**");
  });

  it("writes a new rule in the case the source lists the folder", () => {
    const selection = toggleFolder(
      toggleFolder(none, { ...projects, path: ["projekte"] }, true),
      archive,
      false
    );
    expect(selection.excluded).toEqual(["Archiv"]);
  });
});

describe("a saved rule when a folder above its chosen one is ticked", () => {
  const year = { id: "31", path: ["Kunden", "2024"] };
  const customers = { id: "30", path: ["Kunden"] };

  it("moves it, so a folder of that name higher up is not left out", () => {
    const saved = withFolderNames(
      { chosen: new Map([["31", year.path]]), excluded: ["Archiv"] },
      "31",
      ["Archiv"],
      true
    );
    expect(toggleFolder(saved, customers, true).excluded).toEqual(["2024/Archiv"]);
  });

  it("waits for the path of a chosen folder, unless its read failed", () => {
    const placing: FolderSelection = { chosen: new Map([["31", undefined]]), excluded: ["Archiv"] };
    expect(canToggle(placing, customers)).toBe(false);
    expect(toggleFolder(placing, customers, true)).toBe(placing);
    expect(canToggle(withFolderUnread(placing, "31"), customers)).toBe(true);
  });
});

describe("a longer rule and the chosen folders", () => {
  it("shows the partial state only on the folder it was written below", () => {
    const a = { id: "40", path: ["A"] };
    const c = { id: "50", path: ["C"] };
    const start = toggleFolder(toggleFolder(none, a, true), c, true);
    const read = withFolderNames(
      withFolderNames(start, "40", ["2019"], true),
      "50",
      ["2019"],
      true
    );
    const left = toggleFolder(read, { id: "41", path: ["A", "2019", "Old"] }, false);
    expect(folderState(left, a)).toEqual({ state: "in", without: ["2019/Old"] });
    expect(folderState(left, c)).toEqual({ state: "in", without: [] });
  });
});

describe("the exclude a selection stores", () => {
  it("writes the spelling a chosen folder lists beside a rule in another case", () => {
    const selection = withFolderNames(
      { chosen: new Map([["10", ["Projekte"]]]), excluded: ["archiv"] },
      "10",
      ["Archiv"],
      true
    );
    const stored = excludeToStore("archiv/**\n**/*.tmp", selection);
    expect(stored).toBe("archiv/**\n**/*.tmp\nArchiv/**");
    // Stored again it stays the same, and it reads as one folder.
    expect(excludeToStore(stored, selection)).toBe(stored);
    expect(excludedFolders(stored)).toEqual(["archiv"]);
  });
});
