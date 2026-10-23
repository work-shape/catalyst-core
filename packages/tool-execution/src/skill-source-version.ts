import { createHash } from "node:crypto";
import type { SkillConfig } from "@work-shape/catalyst-core";

export function createSkillSourceVersion(skill: SkillConfig): string {
  const hash = createHash("sha256")
    .update(skill.name)
    .update("\0")
    .update(skill.title)
    .update("\0")
    .update(skill.description)
    .update("\0")
    .update(skill.content);
  // A skill without a summary keeps the version it had before skills could carry one.
  if (skill.summary !== undefined) {
    hash.update("\0summary\0").update(skill.summary);
  }
  // Starters are for the empty chat and no part of what the agent reads.
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
  for (const file of [...(skill.files ?? [])].sort((left, right) =>
    left.path.localeCompare(right.path)
  )) {
    hash.update("\0").update(file.path).update("\0").update(file.sha256);
  }
  const digest = hash.digest("hex");
  return `sha256:${digest}`;
}
