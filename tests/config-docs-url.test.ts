import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { clientBrandingSchema } from "@work-shape/catalyst-api-contract";
import { resolveInstanceModules } from "@work-shape/catalyst-client-assembly";
import {
  createClientBranding,
  createSafeConfigView,
  loadClientInstanceConfigFromFile
} from "@work-shape/catalyst-config-schema";

const baseConfig = [
  "version: 1",
  "clientInstance:",
  "  id: docs-client",
  "  displayName: Docs Client",
  "  environment: development",
  "retention:",
  "  conversationDays: 30",
  "  auditDays: 365",
  "  allowUserDelete: true",
  "infrastructure:",
  "  models:",
  "    local:",
  "      provider: deterministic",
  ""
].join("\n");

const withUi = (...lines: string[]) => [baseConfig, "ui:", ...lines, ""].join("\n");

async function writeFixtures(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vivd-catalyst-docs-url-"));
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(join(root, name), contents, "utf8");
  }
  return root;
}

/** The docs address as the interface gets it: from the config endpoint and from the branding. */
async function servedDocsUrl(root: string, file: string): Promise<string | undefined> {
  const config = await loadClientInstanceConfigFromFile(join(root, file));
  const view = createSafeConfigView(
    config,
    { version: 1, defaultAgentName: "none", agents: [], skills: [] },
    resolveInstanceModules(config, []).snapshot
  );
  // The interface reads the answer through the contract, which drops a key it does not name.
  const branding = clientBrandingSchema.parse(createClientBranding(config));
  expect("docsUrl" in view.ui).toBe(view.ui.docsUrl !== undefined);
  expect(branding.docsUrl).toBe(view.ui.docsUrl);
  return branding.docsUrl;
}

describe("ui.docsUrl", () => {
  it("has no default: an instance that names no docs address serves none", async () => {
    const root = await writeFixtures({
      "app.yaml": baseConfig,
      "titled.yaml": withUi("  title: Titled")
    });

    expect(await servedDocsUrl(root, "app.yaml")).toBeUndefined();
    expect(await servedDocsUrl(root, "titled.yaml")).toBeUndefined();
  });

  it("serves the address an instance sets", async () => {
    const root = await writeFixtures({
      "app.yaml": withUi("  docsUrl: https://docs.workshape.ai/catalyst"),
      "plain.yaml": withUi("  docsUrl: http://docs.customer.internal/handbook/")
    });

    expect(await servedDocsUrl(root, "app.yaml")).toBe("https://docs.workshape.ai/catalyst");
    expect(await servedDocsUrl(root, "plain.yaml")).toBe("http://docs.customer.internal/handbook/");
  });

  it("is cleared by null over an inherited address", async () => {
    const root = await writeFixtures({
      "app.base.yaml": withUi("  docsUrl: https://docs.workshape.ai/catalyst"),
      "app.yaml": ["extends: ./app.base.yaml", "ui:", "  docsUrl: null", ""].join("\n"),
      "inherits.yaml": ["extends: ./app.base.yaml", "ui:", "  title: Inherits", ""].join("\n")
    });

    expect(await servedDocsUrl(root, "app.yaml")).toBeUndefined();
    expect(await servedDocsUrl(root, "inherits.yaml")).toBe("https://docs.workshape.ai/catalyst");
  });

  it.each([
    ["a javascript address", "'javascript:alert(1)'"],
    ["a data address", "'data:text/html,<p>docs</p>'"],
    ["a mail address", "mailto:docs@example.com"],
    ["a file address", "file:///srv/docs/index.html"],
    ["another protocol", "ftp://docs.example.com/catalyst"],
    ["a path", "/docs"],
    ["a bare host", "docs.example.com"],
    ["an empty value", "''"]
  ])("refuses %s when the config loads", async (_name, value) => {
    const root = await writeFixtures({ "app.yaml": withUi(`  docsUrl: ${value}`) });

    await expect(loadClientInstanceConfigFromFile(join(root, "app.yaml"))).rejects.toMatchObject({
      code: "VALIDATION_FAILED"
    });
  });
});
