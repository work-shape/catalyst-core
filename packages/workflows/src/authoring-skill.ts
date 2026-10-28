import type { WorkflowRunnerPackage } from "./runner-packages";
import type { ShippedSkill } from "@work-shape/catalyst-core";
import { dataScopeSection } from "./authoring-skill/sections/data-scope";
import { datasetsSection } from "./authoring-skill/sections/datasets";
import { examplesSection } from "./authoring-skill/sections/examples";
import { howYouWorkSection } from "./authoring-skill/sections/how-you-work";
import { introSection } from "./authoring-skill/sections/intro";
import { manifestSection } from "./authoring-skill/sections/manifest";
import { mappingsSection } from "./authoring-skill/sections/mappings";
import { notRunYetSection } from "./authoring-skill/sections/not-run-yet";
import { readableAndFastSection } from "./authoring-skill/sections/readable-and-fast";
import { runnerPackagesSection } from "./authoring-skill/sections/runner-packages";
import { stepFilesSection } from "./authoring-skill/sections/step-files";
import { stepTypesSection } from "./authoring-skill/sections/step-types";

// The skill an agent reads before it changes the definition of a Workflow. It ships with the
// engine, and the release seed stores it as a read-only skill. Each section is a file of
// `authoring-skill/sections/`; what it says of the step types is made from the list of the
// types this engine runs and from `steps/<type>.reference.ts`, whose type names every field of
// the step, so a release that runs another step, or gives one another field, does not build
// until the skill says what it is.

export const WORKFLOW_AUTHORING_SKILL_NAME = "workflow-authoring";

export { WORKFLOW_AUTHORING_EXAMPLES } from "./authoring-skill/sections/examples";
export { workflowStepTypesNotRun } from "./authoring-skill/sections/not-run-yet";

function content(packages: readonly WorkflowRunnerPackage[]): string {
  const sections = [
    introSection,
    howYouWorkSection,
    dataScopeSection,
    manifestSection,
    stepTypesSection,
    readableAndFastSection,
    stepFilesSection,
    runnerPackagesSection(packages),
    mappingsSection,
    datasetsSection,
    notRunYetSection,
    examplesSection
  ];
  return `${sections.join("\n\n")}\n`;
}

/** The skill as the platform ships it, offered to a conversation about a Workflow. */
export function createWorkflowAuthoringSkill(
  packages: readonly WorkflowRunnerPackage[]
): ShippedSkill {
  return {
    name: WORKFLOW_AUTHORING_SKILL_NAME,
    title: "Writing a Workflow",
    description:
      "How to read, change, check and save the definition of a Workflow: what a manifest holds, the step types this engine runs, the scripts of its code steps, references between steps and what is not run yet. Read it before you change a Workflow.",
    content: content(packages),
    icon: "workflow"
  };
}

/** Without an image manifest, authoring fails closed just as publishing does. */
export const workflowAuthoringSkill = createWorkflowAuthoringSkill([]);
