import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nativePreviewPackages = [
  "libreoffice-impress-nogui",
  "libreoffice-writer-nogui",
  "poppler-utils"
];
const secretEnvNames = [
  "OPENAI_API_KEY",
  "BETTER_AUTH_SECRET",
  "CHAT_SESSION_TOKEN_SECRET",
  "CHAT_SERVER_CREDENTIAL"
];

describe("artifact preview runtime wiring", () => {
  it("keeps native Office/PDF renderers isolated to the artifact-preview-worker image target", () => {
    const dockerfile = readFile("docker/vivd-client.Dockerfile");
    const api = extractDockerStage(dockerfile, "api");
    const workspaceWorker = extractDockerStage(dockerfile, "workspace-command-worker");
    const artifactWorker = extractDockerStage(dockerfile, "artifact-preview-worker");

    expect(api).toContain("FROM node:24-bookworm-slim AS api");
    expect(workspaceWorker).toContain("COPY --from=docker-cli");
    expect(artifactWorker).toContain("FROM api AS artifact-preview-worker");
    expect(artifactWorker).toContain("ARTIFACT_PREVIEW_WORKER_ENTRY");
    expect(artifactWorker).toContain("soffice --headless --version");
    expect(artifactWorker).toContain("pdfinfo -v");
    expect(artifactWorker).toContain("pdftoppm -v");

    for (const packageName of nativePreviewPackages) {
      expect(artifactWorker).toContain(packageName);
      expect(api).not.toContain(packageName);
      expect(workspaceWorker).not.toContain(packageName);
    }
  });

  it.each(["clients/demo/docker-compose.yml", "clients/demo/docker-compose.prod.yml"])(
    "runs artifact-preview-worker from the dedicated image target in %s",
    (composePath) => {
      const compose = readFile(composePath);
      const worker = extractComposeService(compose, "artifact-preview-worker");
      const api = extractComposeService(compose, "api");

      expect(worker).toContain("target: artifact-preview-worker");
      expect(worker).toContain("stop_grace_period: 30s");
      expect(worker).toContain("artifact-preview-tmp");
      expect(compose).toContain("ARTIFACT_PREVIEW_WORKER_ID");
      expect(compose).toContain("ARTIFACT_PREVIEW_CONCURRENCY");
      expect(compose).toContain("ARTIFACT_PREVIEW_WORKER_ENTRY: clients/demo/dist/artifact-preview-worker.js");
      expect(api).not.toContain("target: artifact-preview-worker");

      for (const secretEnvName of secretEnvNames) {
        expect(worker).not.toContain(secretEnvName);
      }
    }
  );
});

function readFile(path: string): string {
  return readFileSync(resolve(root, path), "utf8");
}

function extractDockerStage(dockerfile: string, stageName: string): string {
  const lines = dockerfile.split(/\r?\n/u);
  const start = lines.findIndex((line) => new RegExp(`^FROM .* AS ${stageName}$`, "u").test(line));
  if (start < 0) {
    throw new Error(`Missing Docker stage: ${stageName}`);
  }
  const block = [lines[start]];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^FROM .* AS /u.test(line)) {
      break;
    }
    block.push(line);
  }
  return block.join("\n");
}

function extractComposeService(compose: string, serviceName: string): string {
  const lines = compose.split(/\r?\n/u);
  const start = lines.findIndex((line) => line === `  ${serviceName}:`);
  if (start < 0) {
    throw new Error(`Missing Compose service: ${serviceName}`);
  }
  const block = [lines[start]];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^  [A-Za-z0-9_.-]+:/u.test(line)) {
      break;
    }
    block.push(line);
  }
  return block.join("\n");
}
