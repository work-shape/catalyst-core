import {
  assert,
  readDeploymentFile,
  readRemoteDeployScript,
  extractServiceBlock
} from "./compose-helpers.mjs";

for (const composeFile of ["docker-compose.yml", "docker-compose.prod.yml"]) {
  const contents = await readDeploymentFile(composeFile);
  const worker = extractServiceBlock(contents, "agent-run-worker");
  const api = extractServiceBlock(contents, "api");

  assert(worker, `${composeFile}: agent-run-worker service is required`);
  assert(api, `${composeFile}: api service is required`);
  assert(
    worker.includes(
      composeFile === "docker-compose.yml" ? "src/agent-run-worker.ts" : "agent-run-worker.js"
    ),
    `${composeFile}: agent-run-worker must run its worker entrypoint`
  );
  assert(
    worker.includes(
      composeFile === "docker-compose.yml" ? "stop_grace_period: 30s" : "stop_grace_period: 16m"
    ),
    `${composeFile}: agent-run-worker stop grace period must exceed its drain timeout`
  );
  assert(
    worker.includes(
      composeFile === "docker-compose.yml"
        ? "AGENT_RUN_WORKER_DRAIN_TIMEOUT_MS: ${AGENT_RUN_WORKER_DRAIN_TIMEOUT_MS:-20000}"
        : "AGENT_RUN_WORKER_DRAIN_TIMEOUT_MS: ${AGENT_RUN_WORKER_DRAIN_TIMEOUT_MS:-900000}"
    ),
    `${composeFile}: agent-run-worker must drain active runs below its stop grace period`
  );
  assert(
    worker.includes("AGENT_RUN_WORKER_ID"),
    `${composeFile}: agent-run-worker must have a stable id`
  );
  assert(
    !contents.includes("RUN_MIGRATIONS") && !contents.includes("createPlatformStore"),
    `${composeFile}: only the migrate service migrates; no startup switch or inline command`
  );
  assert(
    extractServiceBlock(contents, "migrate").includes("dist/migrate.js"),
    `${composeFile}: the migrate service must run the client's explicit migration entry`
  );
  assert(
    worker.includes("AGENT_RUN_WORKER_CONCURRENCY: ${AGENT_RUN_WORKER_CONCURRENCY:-2}"),
    `${composeFile}: agent-run-worker must use explicit concurrency 2 by default`
  );
  assert(
    !worker.includes("      doc-worker:\n"),
    `${composeFile}: agent-run-worker startup must not depend on document-worker health`
  );
  assert(!worker.includes("ports:"), `${composeFile}: agent-run-worker must not expose HTTP`);
  assert(
    !worker.includes("healthcheck:"),
    `${composeFile}: agent-run-worker must not add an HTTP health server`
  );
  assert(
    !worker.includes("/var/run/docker.sock"),
    `${composeFile}: agent-run-worker must not receive the Docker socket`
  );
  for (const secretName of [
    "BETTER_AUTH_SECRET",
    "CHAT_SESSION_TOKEN_SECRET",
    "CHAT_SERVER_CREDENTIAL",
    "SERVICE_ACCESS_TOKEN_SECRET"
  ]) {
    assert(
      !worker.includes(secretName),
      `${composeFile}: agent-run-worker must not receive ${secretName}`
    );
  }
  if (composeFile === "docker-compose.yml") {
    assert(
      worker.includes("      api:\n        condition: service_healthy"),
      `${composeFile}: local agent-run-worker must wait for API migrations`
    );
    assert(
      worker.includes("target: api-dev"),
      `${composeFile}: local agent-run-worker must reuse the API development image`
    );
  } else {
    assert(
      worker.includes("-api:"),
      `${composeFile}: production agent-run-worker must reuse the API image`
    );
    assert(
      !worker.includes("-agent-run-worker:"),
      `${composeFile}: production must not introduce a separate agent worker image`
    );
  }
}

const clientSource = await readDeploymentFile("src/client.ts");
assert(
  clientSource.includes('agentRunWorker: "separate"'),
  "src/client.ts: the operated API must leave agent runs to the agent-run-worker service"
);

const deployScript = await readRemoteDeployScript();
assert(
  !/services=\([^)]*agent-run-worker[^)]*\)/u.test(deployScript) &&
    deployScript.includes("--no-recreate") &&
    /\nroll_agent_run_worker\n/u.test(deployScript),
  "deploy.sh: production deploy must roll agent-run-worker with overlap instead of recreating it"
);

console.log("agent run worker Compose wiring is valid");
