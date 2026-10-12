import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** The secret names a model adapter reads when its config entry names none. */
const DEFAULT_MODEL_SECRET_NAMES = [
  "OPENAI_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "GOOGLE_VERTEX_CREDENTIALS"
];
/** The config keys of a model entry that name a secret. */
const MODEL_SECRET_KEYS = ["credentialSecret", "organizationSecret"];
/** Where the env file of an instance lives on its host, see lib/deployment-env.sh. */
const HOST_SECRET_DIR = "/etc/vivd-catalyst";
const DOCKER_SOCKET_PATHS = ["/var/run/docker.sock", "/run/docker.sock"];
/** Service keys that hand a container content the resolved Compose file does not show. */
const UNSEEN_SOURCES = ["env_file", "secrets", "configs", "volumes_from"];

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

// Runs `docker compose config` and returns what it resolves: YAML anchors, merge keys, `extends`
// and every profile. Variables stay as written, so the call needs no env file and a value
// still shows the variable it reads.
function composeConfig(label, fileArguments, options) {
  const rendered = spawnSync(
    "docker",
    [
      "compose",
      ...fileArguments,
      "--profile",
      "*",
      "config",
      "--no-interpolate",
      "--format",
      "json"
    ],
    { encoding: "utf8", ...options }
  );
  if (rendered.error) {
    throw new Error(`${label}: docker compose is required to resolve the file`, {
      cause: rendered.error
    });
  }
  assert(rendered.status === 0, `${label}: docker compose config failed\n${rendered.stderr}`);
  return JSON.parse(rendered.stdout);
}

// The Compose files the stack of `composeFile` starts from. On the host these are the files
// the deploy script passes with -f. Locally `docker compose` adds the override file when
// there is one.
async function stackFiles(composeFile) {
  const deployed = Array.from(
    (await readRemoteDeployScript()).matchAll(/-f "\$REMOTE_APP_DIR\/([^"]+)"/gu),
    (match) => match[1]
  );
  assert(deployed.length > 0, "deploy-remote.sh: the deploy names no Compose file");
  if (deployed.includes(composeFile)) return deployed;
  const override = composeFile.replace(/\.yml$/u, ".override.yml");
  return existsSync(deploymentPath(override)) ? [composeFile, override] : [composeFile];
}

// The stack of a Compose file as Docker resolves it. What a service must not have is judged
// on this, never on the text of its block, which shows nothing of what an anchor or an
// override file brings in.
export async function resolveCompose(composeFile) {
  const files = (await stackFiles(composeFile)).map(deploymentPath);
  return composeConfig(
    composeFile,
    files.flatMap((file) => ["-f", file]),
    { cwd: dirname(files[0]) }
  );
}

// Whether a resolved service names `name` in what it spells out: a variable it receives, a
// value that reads one, a path. It shows nothing of what the keys in UNSEEN_SOURCES carry.
export function serviceNames(service, name) {
  return JSON.stringify(service ?? {}).includes(name);
}

// A mount source with the defaults of its variables filled in: `${ROOT:-/var/lib/x}/objects`
// is `/var/lib/x/objects`.
function withVariableDefaults(source) {
  return source.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*:?-([^${}]*)\}/gu, "$1");
}

// The host paths a service mounts. A named volume that binds a host directory counts as that
// directory.
function mountedHostPaths(compose, service) {
  return (service.volumes ?? [])
    .map((volume) => compose.volumes?.[volume.source]?.driver_opts?.device ?? volume.source ?? "")
    .map(withVariableDefaults)
    .filter((source) => source.startsWith("/") || source.includes("$"))
    .map((source) => (source.includes("$") ? source : posix.normalize(`${source}/`)));
}

// Whether a mount of `source` shows `path`: it is the path, lies in it or holds it.
function mountShows(source, path) {
  return source.startsWith(`${path}/`) || `${path}/`.startsWith(source);
}

function mountsDockerSocket(source) {
  return (
    source.endsWith("/docker.sock/") || DOCKER_SOCKET_PATHS.some((path) => mountShows(source, path))
  );
}

/** Whether a service of a resolved stack can reach the Docker socket of the host. */
export function reachesDockerSocket(compose, serviceName) {
  const service = compose.services[serviceName];
  return (
    service.volumes_from !== undefined ||
    mountedHostPaths(compose, service).some(mountsDockerSocket)
  );
}

// A worker receives what its `environment` spells out and nothing else: none of `secretNames`,
// no source the resolved file cannot show, no mount of the host's secret directory, no
// process namespace of another service, and the Docker socket only where `dockerSocket` says
// the worker is the one that starts containers.
export function assertWorkerIsolation(composeFile, compose, workerName, options) {
  const worker = compose.services[workerName];
  const refuse = (what) => assert(false, `${composeFile}: ${workerName} must not ${what}`);

  for (const secretName of options.secretNames) {
    if (serviceNames(worker, secretName)) refuse(`receive ${secretName}`);
  }
  for (const key of UNSEEN_SOURCES) {
    if (worker[key] !== undefined) {
      refuse(
        `use ${key}: the check cannot see what it carries. Name each variable under environment`
      );
    }
  }
  if (worker.pid !== undefined) {
    refuse(
      `set pid (${worker.pid}): a shared process namespace shows the environment of its processes`
    );
  }
  for (const source of mountedHostPaths(compose, worker)) {
    if (source.includes("$")) {
      refuse(`mount ${source}: the check cannot see where a variable without a default points`);
    }
    if (mountShows(source, HOST_SECRET_DIR)) {
      refuse(`mount ${source}: ${HOST_SECRET_DIR} holds the secrets of the instance`);
    }
    if (!options.dockerSocket && mountsDockerSocket(source)) {
      refuse(`mount ${source}: it reaches the Docker socket`);
    }
  }
}

// A YAML document as a parser reads it, with anchors, merge keys, flow mappings and quoted
// keys resolved. The parser is Compose's: it is the one the kit already needs, and the checks
// run before a deployment has installed anything.
function parseYaml(label, contents) {
  const wrapped = `services: {}\nx-parsed:\n${contents.replace(/^/gmu, "  ")}`;
  return composeConfig(label, ["-p", "parsed", "-f", "-"], { input: wrapped, cwd: tmpdir() })[
    "x-parsed"
  ];
}

// The values of the keys in MODEL_SECRET_KEYS at any depth of a parsed document.
function namedModelSecrets(label, node) {
  if (typeof node !== "object" || node === null) return [];
  return Object.entries(node).flatMap(([key, value]) => {
    if (!MODEL_SECRET_KEYS.includes(key)) return namedModelSecrets(label, value);
    assert(typeof value === "string", `${label}: ${key} must name a secret`);
    return [value];
  });
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
    const file = join(entry.parentPath, entry.name);
    const label = `config/${relative(deploymentPath("config"), file)}`;
    for (const name of namedModelSecrets(label, parseYaml(label, await readFile(file, "utf8")))) {
      names.add(name);
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
