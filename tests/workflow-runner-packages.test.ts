import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { readRunnerPackageManifest } from "@work-shape/catalyst-client-assembly";
import {
  assertWorkflowPackages,
  createWorkflowAuthoringSkill,
  parseWorkflowManifest
} from "@work-shape/catalyst-workflows";

const installed = [
  { name: "pypdf", version: "4.3.1" },
  { name: "python-docx", version: "1.1.2" }
];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function manifestFile(content?: string) {
  const root = await mkdtemp(join(tmpdir(), "ew-pkg-"));
  roots.push(root);
  const path = join(root, "runner-packages.json");
  if (content !== undefined) await writeFile(path, content);
  return path;
}
const definition = (packages: unknown) => ({
  id: "parse",
  name: "Parse",
  runAs: "runner",
  packages,
  inputs: { type: "object" },
  outputs: { type: "object" },
  steps: [
    { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
    { id: "result", name: "Result", type: "output", input: {} }
  ]
});

describe("Workflow runner packages", () => {
  it("reads installed distribution names and exact versions for publish and authoring", async () => {
    const manifest = readRunnerPackageManifest(await manifestFile(JSON.stringify(installed)));
    expect(manifest).toEqual({ packages: installed });
    expect(() =>
      assertWorkflowPackages({ packages: ["pypdf", "Python_Docx"] }, manifest.packages)
    ).not.toThrow();
    const skill = createWorkflowAuthoringSkill(manifest.packages).content;
    expect(skill).toContain("`pypdf` (4.3.1)");
    expect(skill).toContain("`python-docx` (1.1.2)");
    expect(skill).toContain("packages: [pypdf]");
  });
  it("names an unavailable package in the publish refusal", () => {
    expect(() =>
      assertWorkflowPackages({ packages: ["pypdf", "not-in-this-image"] }, installed)
    ).toThrow("Workflow package 'not-in-this-image' is not available in the runner image");
  });
  it("keeps startup alive with an empty allow-list when the manifest is missing", async () => {
    const manifest = readRunnerPackageManifest(await manifestFile());
    expect(manifest).toEqual({ packages: [], unavailable: "missing" });
    expect(() => assertWorkflowPackages({ packages: ["pypdf"] }, manifest.packages)).toThrow(
      "'pypdf'"
    );
    expect(() => assertWorkflowPackages({}, manifest.packages)).not.toThrow();
    expect(createWorkflowAuthoringSkill(manifest.packages).content).toContain(
      "allow-list is empty"
    );
  });
  it.each([
    "{broken",
    "{}",
    '[{"name":"pypdf","version":4}]',
    '[{"name":"pypdf>=4","version":"4"}]',
    '[{"name":"python-docx","version":"1"},{"name":"Python_Docx","version":"2"}]'
  ])("fails closed for a malformed manifest: %s", async (content) => {
    expect(readRunnerPackageManifest(await manifestFile(content))).toEqual({
      packages: [],
      unavailable: "invalid"
    });
  });
  it("accepts declarations without a package-count cap and refuses version specs and malformed names", () => {
    const packages = Array.from({ length: 5_000 }, (_, index) => `parser-${index}`);
    expect(parseWorkflowManifest(definition(packages)).ok).toBe(true);
    expect(() =>
      assertWorkflowPackages(
        { packages },
        packages.map((name) => ({ name, version: "1.0" }))
      )
    ).not.toThrow();
    for (const value of ["pypdf", [""], ["pypdf==4"], ["../pypdf"], ["pypdf\n"], [1], null]) {
      expect(parseWorkflowManifest(definition(value)).ok, JSON.stringify(value)).toBe(false);
    }
  });
});
