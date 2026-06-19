import { createHash } from "node:crypto";
import { AppError, type SkillConfig } from "@vivd-catalyst/core";

export interface SkillMetadata {
  name: string;
  title: string;
  description: string;
}

export interface SkillCatalogEntry extends SkillMetadata {
  content: string;
  sourceVersion: string;
}

export interface SkillCatalogOptions {
  skills?: readonly SkillConfig[];
}

export class SkillCatalog {
  private readonly skillsByName = new Map<string, SkillCatalogEntry>();

  constructor(options: SkillCatalogOptions = {}) {
    for (const skill of options.skills ?? []) {
      if (this.skillsByName.has(skill.name)) {
        throw new AppError("CONFLICT", `Duplicate skill definition '${skill.name}'`);
      }
      this.skillsByName.set(skill.name, {
        ...skill,
        sourceVersion: createSkillSourceVersion(skill)
      });
    }
  }

  get(skillName: string): SkillCatalogEntry | undefined {
    return this.skillsByName.get(skillName);
  }

  listMetadata(skillNames: readonly string[] | undefined): SkillMetadata[] {
    const names = skillNames ?? [...this.skillsByName.keys()];
    return names
      .map((skillName) => this.skillsByName.get(skillName))
      .filter((skill): skill is SkillCatalogEntry => Boolean(skill))
      .map(({ name, title, description }) => ({
        name,
        title,
        description
      }));
  }
}

function createSkillSourceVersion(skill: SkillConfig): string {
  const hash = createHash("sha256")
    .update(skill.name)
    .update("\0")
    .update(skill.title)
    .update("\0")
    .update(skill.description)
    .update("\0")
    .update(skill.content)
    .digest("hex");
  return `sha256:${hash}`;
}
