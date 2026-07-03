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
const dockerIgnoreFiles = [".dockerignore", "docker/vivd-client.Dockerfile.dockerignore"];
const expectedIgnoredContextPatterns = [
  ".worktrees",
  "**/.cache",
  ".pnpm-store",
  "**/.pnpm-store",
  "node_modules",
  "**/node_modules",
  "dist",
  "**/dist",
  "coverage",
  "**/coverage",
  "tmp",
  "**/tmp",
  "previews",
  "**/previews",
  "screenshots",
  "**/screenshots",
  "playwright-report",
  "**/playwright-report",
  "test-results",
  "**/test-results",
  "**/.artifact-previews",
  "**/artifact-preview-tmp",
  "**/execution-workspaces",
  "**/.terraform",
  "**/terraform.tfstate",
  "**/terraform.tfstate.*",
  "**/*.tfvars"
];
const requiredContextFiles = [
  "clients/demo/config/app.yaml",
  "clients/demo/public/favicon.svg",
  "packages/chat-ui/assets/favicon.svg",
  "packages/postgres-store/migrations/0011_preview_manifest_identity.sql",
  "packages/postgres-store/migrations/meta/_journal.json"
];
const requiredServerBuildOutputs = [
  "clients/demo/dist/artifact-preview-worker.js",
  "packages/client-assembly/dist/index.js",
  "clients/demo/node_modules/@vivd-catalyst/client-assembly/dist/index.js"
];

describe("artifact preview runtime wiring", () => {
  it("keeps dependency and UI build layers out of artifact-preview-worker rebuilds", () => {
    const dockerfile = readFile("docker/vivd-client.Dockerfile");
    const deps = extractDockerStage(dockerfile, "deps");
    const serverBuild = extractDockerStage(dockerfile, "server-build");
    const uiBuild = extractDockerStage(dockerfile, "ui-build");
    const api = extractDockerStage(dockerfile, "api");
    const worker = extractDockerStage(dockerfile, "artifact-preview-worker");
    const ui = extractDockerStage(dockerfile, "ui");

    expect(deps).toContain("COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./");
    expect(deps).toContain("pnpm fetch --frozen-lockfile");
    expect(deps.indexOf("pnpm fetch --frozen-lockfile")).toBeLessThan(deps.indexOf("COPY . ./"));
    expect(deps).toContain("install --offline --frozen-lockfile");

    expect(serverBuild).toContain('pnpm --filter "${APP_PACKAGE}^..." build');
    expect(serverBuild).toContain('pnpm --filter "${APP_PACKAGE}" build:server');
    expect(serverBuild.indexOf('pnpm --filter "${APP_PACKAGE}^..." build')).toBeLessThan(
      serverBuild.indexOf('pnpm --filter "${APP_PACKAGE}" build:server')
    );
    for (const outputPath of requiredServerBuildOutputs) {
      expect(serverBuild).toContain(`test -f ${outputPath}`);
    }
    expect(serverBuild).toContain("await import('@vivd-catalyst/client-assembly')");
    expect(serverBuild).toContain("runClientInstanceArtifactPreviewWorker");
    expect(serverBuild).not.toContain("build:ui");
    expect(uiBuild).toContain('pnpm --filter "${UI_PACKAGE}" build:ui');

    expect(api).toContain("COPY --from=server-build /app ./");
    expect(worker).toContain("COPY --from=server-build /app ./");
    expect(worker).not.toContain("COPY --from=ui-build");
    expect(ui).toContain("COPY --from=ui-build");
  });

  it("keeps native Office/PDF renderers isolated to the artifact-preview-worker image target", () => {
    const dockerfile = readFile("docker/vivd-client.Dockerfile");
    const api = extractDockerStage(dockerfile, "api");
    const workspaceWorker = extractDockerStage(dockerfile, "workspace-command-worker");
    const artifactRuntime = extractDockerStage(dockerfile, "artifact-preview-runtime");
    const artifactWorker = extractDockerStage(dockerfile, "artifact-preview-worker");

    expect(api).toContain("FROM node:24-bookworm-slim AS api");
    expect(workspaceWorker).toContain("COPY --from=docker-cli");
    expect(artifactRuntime).toContain("FROM node:24-bookworm-slim AS artifact-preview-runtime");
    expect(artifactWorker).toContain("FROM artifact-preview-runtime AS artifact-preview-worker");
    expect(artifactWorker).toContain("ARTIFACT_PREVIEW_WORKER_ENTRY");
    expect(artifactRuntime).toContain("soffice --headless --version");
    expect(artifactRuntime).toContain("pdfinfo -v");
    expect(artifactRuntime).toContain("pdftoppm -v");
    expect(artifactRuntime).not.toContain("COPY --from=server-build");

    for (const packageName of nativePreviewPackages) {
      expect(artifactRuntime).toContain(packageName);
      expect(api).not.toContain(packageName);
      expect(workspaceWorker).not.toContain(packageName);
      expect(artifactWorker).not.toContain(packageName);
    }
  });

  it.each(dockerIgnoreFiles)("keeps local build junk out of Docker contexts in %s", (ignorePath) => {
    const ignorePatterns = readDockerIgnorePatterns(ignorePath);

    for (const pattern of expectedIgnoredContextPatterns) {
      expect(ignorePatterns).toContain(pattern);
    }

    for (const requiredPath of requiredContextFiles) {
      expect(ignorePatterns).not.toContain(requiredPath);
      expect(ignorePatterns).not.toContain(`**/${requiredPath}`);
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

function readDockerIgnorePatterns(path: string): string[] {
  return readFile(path)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
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
