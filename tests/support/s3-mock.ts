import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

/** The image the deployments' Compose files run as their local object store. */
const S3_MOCK_IMAGE = "adobe/s3mock:5.1.0";
const S3_MOCK_PORT = 9090;
const START_TIMEOUT_MS = 90_000;

export interface S3Mock {
  /** Where the mock answers, such as `http://127.0.0.1:49152`. */
  endpoint: string;
  stop(): void;
}

function docker(...args: string[]) {
  return spawnSync("docker", args, { encoding: "utf8" });
}

/**
 * An S3-compatible store for a test file. `OBJECT_STORAGE_TEST_S3_ENDPOINT` names one that
 * already runs; without it the test starts the mock in a container of its own, on a free port,
 * and removes it at the end. A test never skips when neither is possible.
 */
export async function startS3Mock(): Promise<S3Mock> {
  const given = process.env.OBJECT_STORAGE_TEST_S3_ENDPOINT;
  if (given) {
    return { endpoint: given.replace(/\/$/u, ""), stop() {} };
  }
  const name = `catalyst-s3mock-${process.pid}-${randomBytes(4).toString("hex")}`;
  const started = docker(
    "run",
    "--detach",
    "--name",
    name,
    // An empty host port lets Docker choose a free one.
    "--publish",
    `127.0.0.1::${S3_MOCK_PORT}`,
    S3_MOCK_IMAGE
  );
  const stop = () => {
    docker("rm", "--force", "--volumes", name);
  };
  if (started.status !== 0) {
    stop();
    throw new Error(
      `Object storage tests need an S3-compatible store. Docker could not start ${S3_MOCK_IMAGE}; start Docker, or set OBJECT_STORAGE_TEST_S3_ENDPOINT to a disposable store.`
    );
  }
  const published = docker("port", name, `${S3_MOCK_PORT}/tcp`).stdout.trim().split("\n")[0] ?? "";
  const port = published.slice(published.lastIndexOf(":") + 1);
  if (!/^\d+$/u.test(port)) {
    stop();
    throw new Error(`Docker did not publish a port for ${name}.`);
  }
  const endpoint = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + START_TIMEOUT_MS;
  for (;;) {
    try {
      // Any answer means the store listens; it lists its buckets here.
      await fetch(endpoint, { signal: AbortSignal.timeout(2000) });
      return { endpoint, stop };
    } catch {
      if (Date.now() > deadline) {
        stop();
        throw new Error(`${S3_MOCK_IMAGE} in ${name} did not answer in time.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}
