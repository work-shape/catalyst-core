import {
  assert,
  readDeploymentFile,
  readRemoteDeployScript,
  extractDockerStage,
  extractServiceBlock,
  readPlatformDockerfile
} from "./compose-helpers.mjs";

const composeFiles = ["docker-compose.yml", "docker-compose.prod.yml"];
const clientDockerfile = await readPlatformDockerfile();
const nativePackages = [
  "fonts-dejavu",
  "fonts-liberation",
  "libreoffice-impress-nogui",
  "libreoffice-writer-nogui",
  "poppler-utils"
];
const nativeSmokeChecks = ["soffice --headless --version", "pdfinfo -v", "pdftoppm -v"];

const apiTarget = extractDockerStage(clientDockerfile, "api");
const workspaceCommandWorkerTarget = extractDockerStage(
  clientDockerfile,
  "workspace-command-worker"
);
const workspaceArtifactRuntimeTarget = extractDockerStage(
  clientDockerfile,
  "workspace-artifact-runtime"
);
const artifactPreviewRuntimeTarget = extractDockerStage(
  clientDockerfile,
  "artifact-preview-runtime"
);
const artifactPreviewWorkerTarget = extractDockerStage(clientDockerfile, "artifact-preview-worker");
const artifactPreviewWorkerDevTarget = extractDockerStage(
  clientDockerfile,
  "artifact-preview-worker-dev"
);
const artifactPreviewTargets = `${workspaceArtifactRuntimeTarget}\n${artifactPreviewRuntimeTarget}\n${artifactPreviewWorkerTarget}`;

assert(apiTarget, "vivd-client.Dockerfile: api target is required");
assert(
  workspaceCommandWorkerTarget,
  "vivd-client.Dockerfile: workspace-command-worker target is required"
);
assert(
  workspaceArtifactRuntimeTarget,
  "vivd-client.Dockerfile: workspace-artifact-runtime target is required"
);
assert(
  artifactPreviewRuntimeTarget,
  "vivd-client.Dockerfile: artifact-preview-runtime target is required"
);
assert(
  !artifactPreviewRuntimeTarget.includes("FROM api AS artifact-preview-runtime"),
  "vivd-client.Dockerfile: artifact-preview-runtime target must not inherit from the API target"
);
assert(
  artifactPreviewWorkerTarget.includes("FROM artifact-preview-runtime AS artifact-preview-worker"),
  "vivd-client.Dockerfile: artifact-preview-worker target must use the dedicated preview runtime stage"
);
assert(
  !artifactPreviewWorkerTarget.includes("FROM api AS artifact-preview-worker"),
  "vivd-client.Dockerfile: artifact-preview-worker target must not inherit from the API target"
);
assert(
  artifactPreviewWorkerTarget.includes("ARTIFACT_PREVIEW_WORKER_ENTRY"),
  "vivd-client.Dockerfile: artifact-preview-worker target must run a dedicated worker entrypoint"
);
assert(
  artifactPreviewWorkerDevTarget.includes(
    "FROM artifact-preview-runtime AS artifact-preview-worker-dev"
  ) && artifactPreviewWorkerDevTarget.includes("COPY --from=deps /app ./"),
  "vivd-client.Dockerfile: local preview worker must reuse the native runtime without a server build"
);
for (const packageName of nativePackages) {
  assert(
    artifactPreviewTargets.includes(packageName),
    `vivd-client.Dockerfile: preview runtime targets must install ${packageName}`
  );
  assert(
    !apiTarget.includes(packageName),
    `vivd-client.Dockerfile: api target must not install ${packageName}`
  );
  assert(
    !workspaceCommandWorkerTarget.includes(packageName),
    `vivd-client.Dockerfile: workspace-command-worker target must not install ${packageName}`
  );
}
for (const smokeCheck of nativeSmokeChecks) {
  assert(
    artifactPreviewTargets.includes(smokeCheck),
    `vivd-client.Dockerfile: preview runtime targets must smoke check ${smokeCheck}`
  );
  assert(
    !apiTarget.includes(smokeCheck),
    `vivd-client.Dockerfile: api target must not run ${smokeCheck}`
  );
  assert(
    !workspaceCommandWorkerTarget.includes(smokeCheck),
    `vivd-client.Dockerfile: workspace-command-worker target must not run ${smokeCheck}`
  );
}

for (const composeFile of composeFiles) {
  const contents = await readDeploymentFile(composeFile);
  const worker = extractServiceBlock(contents, "artifact-preview-worker");
  const api = extractServiceBlock(contents, "api");

  assert(worker, `${composeFile}: artifact-preview-worker service is required`);
  assert(api, `${composeFile}: api service is required`);
  assert(
    worker.includes(
      composeFile === "docker-compose.yml"
        ? "src/artifact-preview-worker.ts"
        : "artifact-preview-worker.js"
    ),
    `${composeFile}: artifact-preview-worker must run the worker entrypoint`
  );
  assert(
    worker.includes("stop_grace_period: 30s"),
    `${composeFile}: artifact-preview-worker must have explicit cleanup stop grace`
  );
  assert(
    contents.includes("ARTIFACT_PREVIEW_WORKER_ID") &&
      contents.includes("ARTIFACT_PREVIEW_CONCURRENCY") &&
      contents.includes("ARTIFACT_PREVIEW_TEMP_ROOT") &&
      contents.includes("ARTIFACT_PREVIEW_MAX_CONVERTED_PDF_BYTES") &&
      contents.includes("ARTIFACT_PREVIEW_MAX_OUTPUT_BYTES") &&
      contents.includes("ARTIFACT_PREVIEW_MAX_RASTER_DIMENSION"),
    `${composeFile}: artifact-preview-worker must receive bounded worker runtime env`
  );
  assert(
    worker.includes("mem_limit:"),
    `${composeFile}: artifact-preview-worker must have an explicit memory limit`
  );
  assert(
    !worker.includes("/var/run/docker.sock"),
    `${composeFile}: artifact-preview-worker must not have Docker socket access`
  );
  if (composeFile === "docker-compose.yml") {
    assert(
      worker.includes("target: artifact-preview-worker-dev"),
      `${composeFile}: local artifact-preview-worker must build the source-based native worker target`
    );
  } else {
    assert(
      worker.includes("-artifact-preview-worker:"),
      `${composeFile}: production artifact-preview-worker must use the dedicated worker image`
    );
    assert(
      !worker.includes("-api:"),
      `${composeFile}: production artifact-preview-worker must not run from the API image`
    );
  }
  assert(
    !api.includes("target: artifact-preview-worker"),
    `${composeFile}: API must not build the artifact-preview-worker image target`
  );
  assert(
    api.includes("SERVICE_ACCESS_TOKEN_SECRET"),
    `${composeFile}: chat API must receive SERVICE_ACCESS_TOKEN_SECRET`
  );
  for (const secretName of [
    "OPENAI_API_KEY",
    "AZURE_OPENAI_API_KEY",
    "AWS_SECRET_ACCESS_KEY",
    "BETTER_AUTH_SECRET",
    "CHAT_SESSION_TOKEN_SECRET",
    "CHAT_SERVER_CREDENTIAL",
    "SERVICE_ACCESS_TOKEN_SECRET",
    "DOCUMENT_WORKER_TOKEN"
  ]) {
    assert(
      !worker.includes(secretName),
      `${composeFile}: artifact-preview-worker must not receive ${secretName}`
    );
  }
}

const deployScript = await readRemoteDeployScript();
assert(
  /services=\([^)]*artifact-preview-worker[^)]*\)/u.test(deployScript) &&
    deployScript.includes('compose up -d "${services[@]}"'),
  "deploy.sh: production deploy must start artifact-preview-worker"
);

const bakeFile = await readDeploymentFile("deploy/docker-bake.hcl");
assert(
  bakeFile.includes('target     = "artifact-preview-worker"') &&
    bakeFile.includes("${IMAGE_REPOSITORY}-artifact-preview-worker:${RELEASE_TAG}"),
  "docker-bake.hcl: release builds must build and tag the artifact preview worker image"
);

console.log("artifact preview worker Compose wiring is valid");
