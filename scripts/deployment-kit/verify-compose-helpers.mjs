import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export async function readPlatformDockerfile() {
  const platformRoot = process.env.PLATFORM_DIR
    ? pathToFileURL(`${resolve(process.env.PLATFORM_DIR)}/`)
    : new URL("../../", import.meta.url);
  return readFile(new URL("docker/vivd-client.Dockerfile", platformRoot), "utf8");
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

export function workflowTagsImageSuffix(workflow, suffix) {
  const explicitTag = `\${{ env.IMAGE_REPOSITORY }}-${suffix}:`;
  const matrixTag = "${{ env.IMAGE_REPOSITORY }}-${{ matrix.image.suffix }}:";
  return workflow.includes(explicitTag) || (
    workflow.includes(`suffix: ${suffix}`) && workflow.includes(matrixTag)
  );
}

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}
