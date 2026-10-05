import { createHash } from "node:crypto";
import type { SkillConfig } from "@vivd-catalyst/core";

export function createSkillSourceVersion(skill: SkillConfig): string {
  const hash = createHash("sha256")
    .update(skill.name)
    .update("\0")
    .update(skill.title)
    .update("\0")
    .update(skill.description)
    .update("\0")
    .update(skill.content);
  for (const resource of [...(skill.resources ?? [])].sort((left, right) =>
    left.path.localeCompare(right.path)
  )) {
    hash
      .update("\0")
      .update(resource.path)
      .update("\0")
      .update(resource.mediaType)
      .update("\0")
      .update(resource.content);
  }
  const digest = hash.digest("hex");
  return `sha256:${digest}`;
}
