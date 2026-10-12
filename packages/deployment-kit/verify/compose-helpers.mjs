import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** The secret names a model adapter reads when its config entry names none. */
const DEFAULT_MODEL_SECRET_NAMES = [
  "OPENAI_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "GOOGLE_VERTEX_CREDENTIALS"
];

export async function readPlatformDockerfile() {
  const platformRoot = process.env.PLATFORM_DIR
    ? pathToFileURL(`${resolve(process.env.PLATFORM_DIR)}/`)
    : new URL("../../../", import.meta.url);
  return readFile(new URL("docker/vivd-client.Dockerfile", platformRoot), "utf8");
}

// A path in the deployment repo under check: DEPLOYMENT_ROOT, or the directory the check runs in.
function deploymentPath(path) {
  return resolve(process.env.DEPLOYMENT_ROOT ?? process.cwd(), path);
}

export function readDeploymentFile(path) {
  return readFile(deploymentPath(path), "utf8");
}

// The script the kit runs on the host during a deploy.
export function readRemoteDeployScript() {
  return readFile(new URL("../lib/deploy-remote.sh", import.meta.url), "utf8");
}

export function extractDockerStage(dockerfile, stageName) {
  const lines = dockerfile.split(/\r?\n/u);
  const start = lines.findIndex((line) => new RegExp(`^FROM .* AS ${stageName}$`, "u").test(line));
  if (start < 0) return "";
  const block = [lines[start]];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^FROM .* AS /u.test(line)) break;
    block.push(line);
  }
  return block.join("\n");
}

export function extractServiceBlock(contents, serviceName) {
  const lines = contents.split(/\r?\n/u);
  const start = lines.findIndex((line) => line === `  ${serviceName}:`);
  if (start < 0) return "";
  const block = [lines[start]];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^  [A-Za-z0-9_.-]+:/u.test(line)) break;
    block.push(line);
  }
  return block.join("\n");
}

// The services of a Compose file as Docker resolves them: YAML anchors, merge keys, `extends`
// and every profile. Variables stay as written, so the call needs no env file and a value
// still shows the variable it reads. What a service must not have is judged on this, never on
// the text of its block, which shows nothing of what an anchor brings in.
export function resolveComposeServices(composeFile) {
  const file = deploymentPath(composeFile);
  const rendered = spawnSync(
    "docker",
    ["compose", "-f", file, "--profile", "*", "config", "--no-interpolate", "--format", "json"],
    { cwd: dirname(file), encoding: "utf8" }
  );
  if (rendered.error) {
    throw new Error(`${composeFile}: docker compose is required to resolve the file`, {
      cause: rendered.error
    });
  }
  assert(rendered.status === 0, `${composeFile}: docker compose config failed\n${rendered.stderr}`);
  return JSON.parse(rendered.stdout).services ?? {};
}

// Whether a resolved service names `name` anywhere: a variable it receives, a value that reads
// one, a mount, a Compose secret.
export function serviceNames(service, name) {
  return JSON.stringify(service ?? {}).includes(name);
}

// The names of the secrets that hold a model key: the adapters' defaults and every
// `credentialSecret` and `organizationSecret` that a file under config/ names. A deployment
// without config files gets the defaults.
export async function modelSecretNames() {
  const entries = await readdir(deploymentPath("config"), {
    recursive: true,
    withFileTypes: true
  }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const names = new Set(DEFAULT_MODEL_SECRET_NAMES);
  for (const entry of entries) {
    if (!entry.isFile() || !/\.ya?ml$/u.test(entry.name)) continue;
    const contents = await readFile(join(entry.parentPath, entry.name), "utf8");
    for (const match of contents.matchAll(
      /^\s*(?:credentialSecret|organizationSecret):\s*["']?([A-Za-z0-9_]+)/gmu
    )) {
      names.add(match[1]);
    }
  }
  return [...names].sort();
}

export function workflowTagsImageSuffix(workflow, suffix) {
  const explicitTag = `\${{ env.IMAGE_REPOSITORY }}-${suffix}:`;
  const matrixTag = "${{ env.IMAGE_REPOSITORY }}-${{ matrix.image.suffix }}:";
  return (
    workflow.includes(explicitTag) ||
    (workflow.includes(`suffix: ${suffix}`) && workflow.includes(matrixTag))
  );
}

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}
