import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nativeArtifactRuntimePackages = [
  "bash",
  "fontconfig",
  "fonts-dejavu",
  "fonts-liberation",
  "imagemagick",
  "jq",
  "libreoffice-calc-nogui",
  "libreoffice-impress-nogui",
  "libreoffice-writer-nogui",
  "poppler-utils",
  "python3-pip",
  "unzip",
  "zip"
];
const pythonArtifactRuntimePackages = [
  "Pillow==10.4.0",
  "XlsxWriter==3.2.0",
  "openpyxl==3.1.5",
  "pdfplumber==0.11.4",
  "pypdf==4.3.1",
  "python-docx==1.1.2",
  "python-pptx==0.6.23",
  "reportlab==4.2.2"
];
const pythonArtifactRuntimeModules = [
  "docx",
  "openpyxl",
  "pdfplumber",
  "pptx",
  "pypdf",
  "reportlab",
  "xlsxwriter",
  "PIL"
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
const demoOnlyServerBuildGuards = [
  "clients/demo/dist/artifact-preview-worker.js",
  "packages/client-assembly/dist/index.js",
  "clients/demo/node_modules/@vivd-catalyst/client-assembly",
  "cd clients/demo"
];

describe("artifact preview runtime wiring", () => {
  it("keeps dependency and UI build layers out of artifact-preview-worker rebuilds", () => {
    const dockerfile = readFile("docker/vivd-client.Dockerfile");
    const deps = extractDockerStage(dockerfile, "deps");
    const serverBuild = extractDockerStage(dockerfile, "server-build");
    const uiBuild = extractDockerStage(dockerfile, "ui-build");
    const api = extractDockerStage(dockerfile, "api");
    const runner = extractDockerStage(dockerfile, "workspace-command-runner");
    const worker = extractDockerStage(dockerfile, "artifact-preview-worker");
    const ui = extractDockerStage(dockerfile, "ui");
    const uiDev = extractDockerStage(dockerfile, "ui-dev");

    expect(deps).toContain("COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./");
    expect(deps).toContain("pnpm fetch --frozen-lockfile");
    expect(deps.indexOf("pnpm fetch --frozen-lockfile")).toBeLessThan(deps.indexOf("COPY . ./"));
    expect(deps).toContain("install --offline --frozen-lockfile");

    expect(serverBuild).toContain('pnpm --filter "${APP_PACKAGE}^..." build');
    expect(serverBuild).toContain('pnpm --filter "${APP_PACKAGE}" build:server');
    expect(serverBuild).toContain("ARG ARTIFACT_PREVIEW_WORKER_ENTRY");
    expect(serverBuild.indexOf('pnpm --filter "${APP_PACKAGE}^..." build')).toBeLessThan(
      serverBuild.indexOf('pnpm --filter "${APP_PACKAGE}" build:server')
    );
    expect(serverBuild).toContain('if [ -n "${ARTIFACT_PREVIEW_WORKER_ENTRY}" ]');
    expect(serverBuild).toContain('test -f "${ARTIFACT_PREVIEW_WORKER_ENTRY}"');
    expect(serverBuild).toContain(
      'pnpm --filter "${APP_PACKAGE}" exec node --input-type=module'
    );
    for (const demoOnlyGuard of demoOnlyServerBuildGuards) {
      expect(serverBuild).not.toContain(demoOnlyGuard);
    }
    expect(serverBuild).toContain("await import('@vivd-catalyst/client-assembly')");
    expect(serverBuild).toContain("runClientInstanceArtifactPreviewWorker");
    expect(serverBuild).not.toContain("build:ui");
    expect(uiBuild).toContain('pnpm --filter "${UI_PACKAGE}^..." build');
    expect(uiBuild).toContain('pnpm --filter "${UI_PACKAGE}" build:ui');
    expect(uiBuild.indexOf('pnpm --filter "${UI_PACKAGE}^..." build')).toBeLessThan(
      uiBuild.indexOf('pnpm --filter "${UI_PACKAGE}" build:ui')
    );

    expect(api).toContain("COPY --from=server-build /app ./");
    expect(runner).not.toContain("COPY --from=server-build");
    expect(runner).not.toContain("COPY --from=ui-build");
    expect(worker).toContain("COPY --from=server-build /app ./");
    expect(worker).toContain('test -n "${ARTIFACT_PREVIEW_WORKER_ENTRY}"');
    expect(worker).toContain('test -f "${ARTIFACT_PREVIEW_WORKER_ENTRY}"');
    expect(worker).not.toContain("COPY --from=ui-build");
    expect(ui).toContain("COPY --from=ui-build");
    expect(uiDev).toContain("ARG VITE_CHAT_API_URL");
    expect(uiDev).toContain("ARG VITE_CHAT_API_PORT");
    expect(uiDev).toContain("ENV VITE_CHAT_API_URL=${VITE_CHAT_API_URL}");
    expect(uiDev).toContain("ENV VITE_CHAT_API_PORT=${VITE_CHAT_API_PORT}");
  });

  it("builds a standalone workspace runner image with artifact authoring runtimes", () => {
    const dockerfile = readFile("docker/vivd-client.Dockerfile");
    const api = extractDockerStage(dockerfile, "api");
    const workspaceWorker = extractDockerStage(dockerfile, "workspace-command-worker");
    const artifactRuntime = extractDockerStage(dockerfile, "workspace-artifact-runtime");
    const workspaceRunner = extractDockerStage(dockerfile, "workspace-command-runner");
    const previewRuntime = extractDockerStage(dockerfile, "artifact-preview-runtime");
    const artifactWorker = extractDockerStage(dockerfile, "artifact-preview-worker");

    expect(api).toContain("FROM node:24-bookworm-slim AS api");
    expect(workspaceWorker).toContain("FROM api AS workspace-command-worker");
    expect(workspaceWorker).toContain("COPY --from=docker-cli");
    expect(workspaceRunner).toContain("FROM workspace-artifact-runtime AS workspace-command-runner");
    expect(workspaceRunner).toContain("WORKDIR /workspace");
    expect(workspaceRunner).toContain('CMD ["/bin/bash"]');
    expect(previewRuntime).toContain("FROM workspace-artifact-runtime AS artifact-preview-runtime");
    expect(artifactWorker).toContain("FROM artifact-preview-runtime AS artifact-preview-worker");
    expect(artifactWorker).toContain("ARTIFACT_PREVIEW_WORKER_ENTRY");
    expect(artifactRuntime).toContain("FROM base AS workspace-artifact-runtime");
    expect(artifactRuntime).toContain("PIP_DISABLE_PIP_VERSION_CHECK=1");
    expect(artifactRuntime).toContain("PYTHONDONTWRITEBYTECODE=1");
    expect(artifactRuntime).toContain("python3 -m pip install --no-cache-dir --break-system-packages");
    expect(artifactRuntime).toContain("/bin/bash --version");
    expect(artifactRuntime).toContain("python3 -c");
    expect(artifactRuntime).toContain("node --version");
    expect(artifactRuntime).toContain("soffice --headless --version");
    expect(artifactRuntime).toContain("pdfinfo -v");
    expect(artifactRuntime).toContain("pdftoppm -v");
    expect(artifactRuntime).toContain("convert -version");
    expect(artifactRuntime).not.toContain("COPY --from=server-build");
    expect(previewRuntime).not.toContain("COPY --from=server-build");

    for (const packageName of nativeArtifactRuntimePackages) {
      expect(artifactRuntime).toContain(packageName);
      expect(api).not.toContain(packageName);
      expect(workspaceWorker).not.toContain(packageName);
      expect(artifactWorker).not.toContain(packageName);
    }
    for (const packageName of pythonArtifactRuntimePackages) {
      expect(artifactRuntime).toContain(packageName);
    }
    for (const moduleName of pythonArtifactRuntimeModules) {
      expect(artifactRuntime).toContain(moduleName);
    }
  });

  it("keeps native artifact runtimes out of the API and control worker image targets", () => {
    const dockerfile = readFile("docker/vivd-client.Dockerfile");
    const api = extractDockerStage(dockerfile, "api");
    const workspaceWorker = extractDockerStage(dockerfile, "workspace-command-worker");
    const artifactRuntime = extractDockerStage(dockerfile, "artifact-preview-runtime");
    const artifactWorker = extractDockerStage(dockerfile, "artifact-preview-worker");

    expect(api).toContain("FROM node:24-bookworm-slim AS api");
    expect(workspaceWorker).toContain("COPY --from=docker-cli");
    expect(artifactRuntime).toContain("FROM workspace-artifact-runtime AS artifact-preview-runtime");
    expect(artifactWorker).toContain("FROM artifact-preview-runtime AS artifact-preview-worker");
    expect(artifactWorker).toContain("ARTIFACT_PREVIEW_WORKER_ENTRY");
    expect(artifactRuntime).not.toContain("COPY --from=server-build");

    for (const packageName of nativeArtifactRuntimePackages) {
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

  it("builds and smokes the workspace runner image when requested", () => {
    if (process.env.CATALYST_WORKSPACE_RUNNER_IMAGE_SMOKE !== "1") {
      return;
    }

    const imageTag = `catalyst-workspace-command-runner-smoke:${process.pid}`;
    const smokeRoot = join(root, ".tmp");
    mkdirSync(smokeRoot, { recursive: true });
    const workspace = mkdtempSync(join(smokeRoot, `workspace-runner-smoke-${process.pid}-`));
    writeFileSync(join(workspace, "smoke.py"), workspaceRunnerSmokeScript, "utf8");

    try {
      expectSpawn(
        spawnSync(
          "docker",
          [
            "build",
            "-f",
            "docker/vivd-client.Dockerfile",
            "--target",
            "workspace-command-runner",
            "-t",
            imageTag,
            "."
          ],
          { cwd: root, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 }
        )
      );
      expectSpawn(
        spawnSync(
          "docker",
          [
            "run",
            "--rm",
            "--network",
            "none",
            "--mount",
            `type=bind,source=${workspace},target=/workspace`,
            "--workdir",
            "/workspace",
            imageTag,
            "/bin/bash",
            "-lc",
            [
              "set -euo pipefail",
              "python3 smoke.py",
              "mkdir -p rendered",
              "soffice --headless --convert-to pdf --outdir rendered artifacts/smoke.docx artifacts/smoke.xlsx artifacts/smoke.pptx >/tmp/soffice.log 2>&1 || { cat /tmp/soffice.log >&2; exit 1; }",
              "pdfinfo artifacts/smoke.pdf >/tmp/pdfinfo-smoke.txt",
              "pdfinfo rendered/smoke.pdf >/tmp/pdfinfo-docx.txt",
              "pdftoppm -png -singlefile rendered/smoke.pdf rendered/smoke-docx",
              "test -s artifacts/smoke.docx",
              "test -s artifacts/smoke.xlsx",
              "test -s artifacts/smoke.pptx",
              "test -s artifacts/smoke.pdf",
              "test -s rendered/smoke-docx.png"
            ].join("\n")
          ],
          { cwd: root, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 }
        )
      );
    } finally {
      spawnSync("docker", ["image", "rm", "-f", imageTag], {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 20 * 1024 * 1024
      });
      rmSync(workspace, { recursive: true, force: true });
      try {
        rmdirSync(smokeRoot);
      } catch {
        // Other local test scratch data can share .tmp; only remove it when empty.
      }
    }
  }, 300000);
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

function expectSpawn(result: ReturnType<typeof spawnSync>): void {
  expect(result.error).toBeUndefined();
  if (result.status !== 0) {
    throw new Error(
      [
        `Command failed with status ${result.status}`,
        result.stdout ? `stdout:\n${result.stdout}` : undefined,
        result.stderr ? `stderr:\n${result.stderr}` : undefined
      ]
        .filter(Boolean)
        .join("\n\n")
    );
  }
}

const workspaceRunnerSmokeScript = String.raw`
from docx import Document
from openpyxl import Workbook
from PIL import Image, ImageDraw
from pptx import Presentation
from pypdf import PdfReader
from reportlab.pdfgen import canvas
import pdfplumber
import xlsxwriter

from pathlib import Path

root = Path("artifacts")
root.mkdir(exist_ok=True)

doc = Document()
doc.add_heading("Workspace Runner Smoke", 0)
doc.add_paragraph("DOCX generated with python-docx.")
doc.save(root / "smoke.docx")

workbook = Workbook()
sheet = workbook.active
sheet.title = "Smoke"
sheet["A1"] = "XLSX generated with openpyxl"
sheet["B2"] = 42
workbook.save(root / "smoke.xlsx")

xlsxwriter_workbook = xlsxwriter.Workbook(root / "smoke-xlsxwriter.xlsx")
xlsxwriter_sheet = xlsxwriter_workbook.add_worksheet("Smoke")
xlsxwriter_sheet.write("A1", "XLSX generated with xlsxwriter")
xlsxwriter_workbook.close()

image = Image.new("RGB", (320, 180), "white")
draw = ImageDraw.Draw(image)
draw.rectangle((20, 20, 300, 160), outline="black", width=3)
draw.text((36, 76), "Pillow image", fill="black")
image.save(root / "smoke.png")

presentation = Presentation()
slide = presentation.slides.add_slide(presentation.slide_layouts[5])
slide.shapes.title.text = "Workspace Runner Smoke"
slide.shapes.add_picture(str(root / "smoke.png"), 1_000_000, 1_600_000, width=3_000_000)
presentation.save(root / "smoke.pptx")

pdf_path = root / "smoke.pdf"
pdf = canvas.Canvas(str(pdf_path))
pdf.drawString(72, 720, "PDF generated with reportlab.")
pdf.save()

reader = PdfReader(str(pdf_path))
assert len(reader.pages) == 1
with pdfplumber.open(str(pdf_path)) as opened:
    text = opened.pages[0].extract_text() or ""
    assert "reportlab" in text
`;
