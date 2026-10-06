import {
  assert,
  readDeploymentFile,
  readRemoteDeployScript,
  extractServiceBlock,
  readPlatformDockerfile
} from "./compose-helpers.mjs";

const composeFiles = ["docker-compose.yml", "docker-compose.prod.yml"];
const clientDockerfile = await readPlatformDockerfile();

assert(
  clientDockerfile.includes("FROM api AS workspace-command-worker"),
  "vivd-client.Dockerfile: workspace-command-worker target is required"
);
assert(
  clientDockerfile.includes("FROM api-dev AS workspace-command-worker-dev"),
  "vivd-client.Dockerfile: source-based workspace-command-worker dev target is required"
);
assert(
  clientDockerfile.includes("FROM docker:29-cli AS docker-cli") &&
    clientDockerfile.includes(
      "COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker"
    ) &&
    clientDockerfile.includes("docker --version"),
  "vivd-client.Dockerfile: workspace-command-worker target must install and smoke check a modern Docker CLI"
);

for (const composeFile of composeFiles) {
  const contents = await readDeploymentFile(composeFile);
  const worker = extractServiceBlock(contents, "workspace-command-worker");
  const api = extractServiceBlock(contents, "api");

  assert(worker, `${composeFile}: workspace-command-worker service is required`);
  assert(api, `${composeFile}: api service is required`);
  assert(
    worker.includes(
      composeFile === "docker-compose.yml"
        ? "src/workspace-command-worker.ts"
        : "workspace-command-worker.js"
    ),
    `${composeFile}: workspace-command-worker must run the worker entrypoint`
  );
  assert(
    worker.includes("stop_grace_period: 30s"),
    `${composeFile}: workspace-command-worker must have explicit cleanup stop grace`
  );
  if (composeFile === "docker-compose.yml") {
    assert(
      worker.includes("api:") && worker.includes("condition: service_healthy"),
      `${composeFile}: local workspace-command-worker must wait for API health so migrations are applied before it polls`
    );
  }
  assert(
    worker.includes("/var/run/docker.sock:/var/run/docker.sock"),
    `${composeFile}: control worker must have Docker socket access`
  );
  if (composeFile === "docker-compose.yml") {
    assert(
      worker.includes("target: workspace-command-worker-dev"),
      `${composeFile}: local worker must build the source-based Docker-CLI worker target`
    );
  } else {
    assert(
      worker.includes("profiles:") && worker.includes("execution-workspaces"),
      `${composeFile}: production worker must be behind the explicit execution-workspaces profile`
    );
    assert(
      worker.includes("-workspace-command-worker:") &&
        worker.includes("@${WORKSPACE_COMMAND_WORKER_IMAGE_DIGEST:?"),
      `${composeFile}: production worker must use the Docker-CLI-enabled worker image by digest`
    );
    assert(
      contents.includes(
        "-catalyst-runner-base:${IMAGE_TAG:?IMAGE_TAG is required}@${RUNNER_IMAGE_DIGEST:?"
      ),
      `${composeFile}: production worker must receive the runner image of the release by digest`
    );
    assert(
      !worker.includes("-api:"),
      `${composeFile}: production worker must not run from the API image`
    );
  }
  assert(
    contents.includes("EXECUTION_WORKSPACE_RUNNER_IMAGE"),
    `${composeFile}: workspace-command-worker must receive the release runner image`
  );
  assert(
    contents.includes("-catalyst-runner-base:"),
    `${composeFile}: workspace-command-worker runner image must use the catalyst-runner-base release tag shape`
  );
  assert(
    !api.includes("/var/run/docker.sock"),
    `${composeFile}: chat API must not have Docker socket access`
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
    "SERVICE_ACCESS_TOKEN_SECRET"
  ]) {
    assert(
      !worker.includes(secretName),
      `${composeFile}: workspace-command-worker must not receive ${secretName}`
    );
  }
  assert(
    !/^\s{2}(catalyst-runner-base|runner|sandbox):/mu.test(contents),
    `${composeFile}: runner/sandbox containers must not be long-running Compose services`
  );
  assert(
    !/image:\s.*catalyst-runner-base/mu.test(contents),
    `${composeFile}: runner image must be used by the worker, not as a Compose service image`
  );
}

const deployScript = await readRemoteDeployScript();
assert(
  deployScript.includes('if [[ "$EXECUTION_WORKSPACES" == "1" ]]') &&
    deployScript.includes(
      'docker pull "$IMAGE_REPOSITORY-catalyst-runner-base:$IMAGE_TAG@$RUNNER_IMAGE_DIGEST"'
    ),
  "deploy.sh: opted-in deploys must pull the runner image of the release by digest"
);
assert(
  deployScript.includes("services+=(workspace-command-worker)") &&
    deployScript.includes("require_release_image workspace-command-worker"),
  "deploy.sh: opted-in deploys must start and verify workspace-command-worker"
);

const bakeFile = await readDeploymentFile("deploy/docker-bake.hcl");
assert(
  bakeFile.includes('target   = "workspace-command-worker"') &&
    bakeFile.includes("${IMAGE_REPOSITORY}-workspace-command-worker:${RELEASE_TAG}"),
  "docker-bake.hcl: release builds must build and tag the workspace command worker image"
);
assert(
  bakeFile.includes("capabilities/docker/catalyst-runner-base.Dockerfile") &&
    bakeFile.includes("${IMAGE_REPOSITORY}-catalyst-runner-base:${RELEASE_TAG}"),
  "docker-bake.hcl: release builds must build and tag the catalyst runner base image"
);
for (const workflowFile of ["build-images.yml", "deploy.yml"]) {
  const workflow = await readDeploymentFile(`.github/workflows/${workflowFile}`);
  assert(
    workflow.includes("deploy/docker-bake.hcl") &&
      workflow.includes("- client") &&
      workflow.includes("- runner"),
    `${workflowFile}: release workflow must build the client and runner bake groups`
  );
}

console.log("workspace command worker Compose wiring is valid");
