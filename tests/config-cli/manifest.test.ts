import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  STATE_FILENAME,
  parseManifest,
  readStateFile,
  resolveSkillResourceTarget,
  resolveInstance,
  writeStateFile
} from "@work-shape/catalyst-cli";
import { createTemporaryDirectory, saveCredentialsFor } from "../support/config-cli";

describe("config CLI state and manifest", () => {
  it("reads and atomically writes state files", async () => {
    const directory = await createTemporaryDirectory();
    const path = resolve(directory, STATE_FILENAME);

    expect(await readStateFile(path)).toEqual({ instances: {} });
    await writeStateFile(path, {
      instances: {
        local: { lastPulledVersion: 12 },
        staging: { lastPulledVersion: 3 }
      }
    });

    expect(await readStateFile(path)).toEqual({
      instances: {
        local: { lastPulledVersion: 12 },
        staging: { lastPulledVersion: 3 }
      }
    });
    expect(await readFile(path, "utf8")).toContain('"lastPulledVersion": 12');
  });

  it("resolves named, default, and direct URL instances", async () => {
    const manifest = parseManifest(`instances:
  local:
    url: http://127.0.0.1:4100/
defaultInstance: local
defaultAgentName: workflow_assistant
agents:
  - agents/*.agent.yaml
skills:
  - skills/*/SKILL.md
`);

    expect(await resolveInstance(manifest)).toEqual({
      key: "local",
      url: "http://127.0.0.1:4100"
    });
    expect(await resolveInstance(manifest, { instance: "local" })).toEqual({
      key: "local",
      url: "http://127.0.0.1:4100"
    });
    expect(await resolveInstance(manifest, { instance: "https://catalyst.example.test/" })).toEqual(
      { key: "https://catalyst.example.test/", url: "https://catalyst.example.test" }
    );
  });

  it("takes the one instance a key is saved for outside a working copy only, and never with CATALYST_API_KEY set", async () => {
    const configHome = await createTemporaryDirectory();
    const env = { CATALYST_CONFIG_HOME: configHome };
    await expect(resolveInstance(undefined, { env })).rejects.toThrow(
      "No instance selected; pass --instance or set defaultInstance in catalyst.yaml. No key is saved; 'catalyst login --instance <https-url>' saves one."
    );
    await saveCredentialsFor(configHome, ["https://catalyst.test"]);
    expect(await resolveInstance(undefined, { env })).toEqual({
      key: "https://catalyst.test",
      url: "https://catalyst.test"
    });
    // An automation key's instance is not the saved one's.
    await expect(
      resolveInstance(undefined, { env: { ...env, CATALYST_API_KEY: "cat_automation" } })
    ).rejects.toThrow("CATALYST_API_KEY is set: name the instance it belongs to.");
    // A working copy names its instances itself, even the saved one, and a key never chooses.
    const manifest = parseManifest(`instances:
  production:
    url: https://catalyst.test
    workspace: cws_tax
agents: []
skills: []
`);
    await expect(resolveInstance(manifest, { env })).rejects.toThrow(
      "No instance selected; pass --instance or set defaultInstance in catalyst.yaml. catalyst.yaml names production."
    );
    await saveCredentialsFor(configHome, ["https://catalyst.test", "https://other.test"]);
    await expect(resolveInstance(undefined, { env })).rejects.toThrow(
      "Keys are saved for https://catalyst.test, https://other.test."
    );
  });

  // Verifier repros (CONNECT-1a, second verification, verify/connect-1a-2 5317122c): the fallback
  // that fixed `catalyst context` outside a working copy also picked an instance inside a working
  // copy whose catalyst.yaml names its instances without a default.
  it("does not switch a root that names another instance to the one a key is saved for", async () => {
    const manifest = parseManifest(`instances:
  production:
    url: https://chat.customer.test
agents: []
skills: []
`);
    const configHome = await createTemporaryDirectory();
    await saveCredentialsFor(configHome, ["https://chat.other.test"]);
    const env = { CATALYST_CONFIG_HOME: configHome };
    await expect(resolveInstance(manifest, { env })).rejects.toThrow("No instance selected");
  });

  it("does not pick production in a root of staging and production without a default", async () => {
    const manifest = parseManifest(`instances:
  staging:
    url: https://staging.chat.customer.test
  production:
    url: https://chat.customer.test
agents: []
skills: []
`);
    const configHome = await createTemporaryDirectory();
    await saveCredentialsFor(configHome, ["https://chat.customer.test"]);
    const env = { CATALYST_CONFIG_HOME: configHome };
    await expect(resolveInstance(manifest, { env })).rejects.toThrow("No instance selected");
  });

  it("keeps resolved skill resources inside their package", () => {
    const skillDirectory = resolve("/tmp", "skills", "review");
    expect(resolveSkillResourceTarget(skillDirectory, "references/checks.md")).toBe(
      resolve(skillDirectory, "references/checks.md")
    );
    expect(() => resolveSkillResourceTarget(skillDirectory, "../outside.md")).toThrow(
      "must stay within its package"
    );
    expect(() => resolveSkillResourceTarget(skillDirectory, "C:/outside.md")).toThrow(
      "must stay within its package"
    );
    expect(() => resolveSkillResourceTarget(skillDirectory, "references/bad\u0001.md")).toThrow(
      "must stay within its package"
    );
  });
});
