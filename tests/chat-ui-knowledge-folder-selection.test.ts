import { describe, expect, it } from "vitest";
import {
  excludedFolders,
  folderState,
  selectionSummary,
  toggleFolder,
  withExcludedFolders,
  withFolderPath,
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
    expect(toggleFolder(partly, projects, false)).toEqual({ chosen: new Map(), excluded: [] });
    const two = toggleFolder(partly, contracts, true);
    expect(toggleFolder(two, projects, false).excluded).toEqual(["Archiv"]);
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
